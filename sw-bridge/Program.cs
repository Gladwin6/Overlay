/**
 * SwBridge — SolidWorks COM Camera Bridge
 *
 * Uses reflection-based late binding instead of C# dynamic to avoid
 * TYPE_E_ELEMENTNOTFOUND errors in .NET 5+ when SolidWorks doesn't
 * expose full ITypeInfo.
 *
 * Frame JSON: { r[9], s, tx, ty, tz, vw, vh, dpi, scx, scy, ts }
 *   dpi      — logical display DPI (e.g. 96, 120, 144)
 *   scx/scy  — model bounding-box center offset from viewport center, in logical px
 *              (right = +scx, down = +scy)
 */

using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json;

// ── COM helpers ───────────────────────────────────────────────────────────────
static class Com
{
    [DllImport("ole32.dll")]
    static extern int CLSIDFromProgID(
        [MarshalAs(UnmanagedType.LPWStr)] string lpszProgID, out Guid pclsid);

    [DllImport("oleaut32.dll")]
    static extern int GetActiveObject(
        ref Guid rclsid, IntPtr pvReserved,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppunk);

    [DllImport("ole32.dll")]
    static extern int GetRunningObjectTable(uint reserved, out IRunningObjectTable pprot);

    [DllImport("ole32.dll")]
    static extern int CreateBindCtx(uint reserved, out IBindCtx ppbc);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr hWnd); // minimized?

    public static object? TryGetActiveObject(string progId)
    {
        try
        {
            if (CLSIDFromProgID(progId, out Guid clsid) != 0) return null;
            return GetActiveObject(ref clsid, IntPtr.Zero, out object obj) != 0 ? null : obj;
        }
        catch { return null; }
    }

    /// <summary>
    /// Enumerate all SolidWorks Application instances from the COM Running Object Table.
    /// Returns them in ROT order (most recently registered first for typical SW behaviour).
    /// </summary>
    public static List<object> GetAllSolidWorksInstances()
    {
        var list = new List<object>();
        try
        {
            if (GetRunningObjectTable(0, out var rot) != 0) return list;
            rot.EnumRunning(out var enumMon);
            enumMon.Reset();

            var arr = new IMoniker[1];
            while (enumMon.Next(1, arr, IntPtr.Zero) == 0)
            {
                try
                {
                    if (rot.GetObject(arr[0], out var obj) != 0 || obj == null) continue;

                    // Verify it's a SolidWorks app by reading RevisionNumber
                    try
                    {
                        var rev = obj.GetType().InvokeMember("RevisionNumber",
                            BindingFlags.GetProperty | BindingFlags.Public | BindingFlags.Instance,
                            null, obj, null);
                        if (rev != null) list.Add(obj);
                        else Marshal.ReleaseComObject(obj);
                    }
                    catch { Marshal.ReleaseComObject(obj); }
                }
                catch { }
            }
        }
        catch { }
        return list;
    }

    /// <summary>
    /// Pick the best SolidWorks instance:
    ///   1. The one whose main frame window is the current foreground window.
    ///   2. The one whose main frame window is not minimised and has an active doc.
    ///   3. First instance with an active doc.
    ///   4. First instance found.
    /// </summary>
    public static object? PickBestSolidWorks(List<object> instances)
    {
        if (instances.Count == 0) return null;
        if (instances.Count == 1) return instances[0];

        IntPtr fg = GetForegroundWindow();

        object? withDoc = null;

        foreach (var sw in instances)
        {
            try
            {
                // Get SW main frame HWND via IFrame.GetHWnd()
                var frame = Get(sw, "Frame");
                IntPtr hwnd = IntPtr.Zero;
                if (frame != null)
                {
                    var h = Call(frame, "GetHWnd");
                    if (h != null) hwnd = new IntPtr(Convert.ToInt64(h));
                }

                // Priority 1: foreground window
                if (hwnd != IntPtr.Zero && hwnd == fg) return sw;

                // Priority 2: non-minimised with active doc
                var doc = Get(sw, "ActiveDoc");
                if (doc != null && (hwnd == IntPtr.Zero || !IsIconic(hwnd)))
                    withDoc ??= sw;
            }
            catch { }
        }

        return withDoc ?? instances[0];
    }

    // Reflection-based property getter — avoids dynamic/ITypeInfo issues
    static readonly BindingFlags GET = BindingFlags.GetProperty | BindingFlags.Public | BindingFlags.Instance;
    static readonly BindingFlags INV = BindingFlags.InvokeMethod | BindingFlags.Public | BindingFlags.Instance;

    public static object? Get(object obj, string prop)
        => obj.GetType().InvokeMember(prop, GET, null, obj, null);

    public static object? Call(object obj, string method, params object[] args)
        => obj.GetType().InvokeMember(method, INV, null, obj, args);

    /// <summary>Returns a short display name for a SW instance (active document title or revision).</summary>
    public static string InstanceLabel(object sw)
    {
        try
        {
            var doc = Get(sw, "ActiveDoc");
            if (doc != null)
            {
                var title = Get(doc, "GetTitle") ?? Get(doc, "GetPathName");
                if (title is string s && s.Length > 0)
                    return System.IO.Path.GetFileName(s);
            }
            var rev = Get(sw, "RevisionNumber");
            return rev?.ToString() ?? "unknown";
        }
        catch { return "unknown"; }
    }
}

// ── Win32 DPI helper ──────────────────────────────────────────────────────────
static class Display
{
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]  static extern int GetDeviceCaps(IntPtr hdc, int nIndex);
    const int LOGPIXELSX = 88;

    public static int LogicalDpi()
    {
        IntPtr hdc = GetDC(IntPtr.Zero);
        int dpi = hdc != IntPtr.Zero ? GetDeviceCaps(hdc, LOGPIXELSX) : 96;
        if (hdc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdc);
        return dpi > 0 ? dpi : 96;
    }
}

// ── Entry point (STA required for COM) ───────────────────────────────────────
class Program
{
    [STAThread]
    static void Main()
    {
        int dpi = Display.LogicalDpi();
        Console.WriteLine($"STATUS:SwBridge starting (DPI={dpi})");

        using var pipe = new NamedPipeServerStream(
            "hanomi_sw_camera",
            PipeDirection.Out,
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.None
        );

        Console.WriteLine("STATUS:Waiting for Electron to connect on pipe...");
        pipe.WaitForConnection();
        Console.WriteLine("STATUS:Electron connected");

        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        // ── Connect to SolidWorks ─────────────────────────────────────────────
        object? swApp = null;
        while (swApp == null)
        {
            swApp = ConnectToSolidWorks();
            if (swApp == null)
            {
                Console.WriteLine("STATUS:Waiting for SolidWorks to start...");
                Thread.Sleep(2000);
            }
            if (!pipe.IsConnected) return;
        }

        // ── Streaming loop ────────────────────────────────────────────────────
        int frameCount = 0;
        while (pipe.IsConnected)
        {
            try
            {
                var doc = Com.Get(swApp, "ActiveDoc");
                if (doc == null) { Thread.Sleep(100); continue; }

                var view = Com.Get(doc, "ActiveView");
                if (view == null) { Thread.Sleep(100); continue; }

                // Orientation3 for translation + bbox (stable values)
                var orient = Com.Get(view, "Orientation3");
                if (orient == null) { Thread.Sleep(100); continue; }
                var td = (double[])Com.Get(orient, "ArrayData")!;

                // Transform for LIVE rotation (tracks interactive orbit).
                // Orientation3 rotation doesn't update during orbit.
                // We only take [0..8] (rotation) from Transform; translation/scale from Orientation3.
                double[] rot = new double[9];
                Array.Copy(td, rot, 9); // default: use Orientation3 rotation
                try
                {
                    var xform = Com.Get(view, "Transform");
                    if (xform != null)
                    {
                        var xtd = Com.Get(xform, "ArrayData") as double[];
                        if (xtd != null && xtd.Length >= 9)
                        {
                            // Transform rotation may include scale — normalize each row
                            for (int row = 0; row < 3; row++)
                            {
                                double a = xtd[row*3], b = xtd[row*3+1], c = xtd[row*3+2];
                                double len = Math.Sqrt(a*a + b*b + c*c);
                                if (len > 0.0001)
                                {
                                    rot[row*3]   = a / len;
                                    rot[row*3+1] = b / len;
                                    rot[row*3+2] = c / len;
                                }
                            }
                        }
                    }
                }
                catch { /* fall back to Orientation3 rotation */ }

                // Scale2 (zoom)
                double scale = Convert.ToDouble(Com.Get(view, "Scale2"));

                // Viewport size
                int vw = 0, vh = 0;
                try
                {
                    var vs = (int[])Com.Call(view, "GetSize")!;
                    vw = vs[0]; vh = vs[1];
                }
                catch { }

                // Translation from Orientation3
                double tx = td.Length > 9  ? td[9]  : 0.0;
                double ty = td.Length > 10 ? td[10] : 0.0;
                double tz = td.Length > 11 ? td[11] : 0.0;

                // Position: zero for now (pan tracking needs different approach)
                double scx = 0, scy = 0;

                // ── Full 4×4 view matrix (row-major) ─────────────────────────────────
                var mv = new[]
                {
                    td[0], td[1], td[2], tx,
                    td[3], td[4], td[5], ty,
                    td[6], td[7], td[8], tz,
                    0.0,   0.0,   0.0,   1.0,
                };

                var payload = new
                {
                    r   = new[] { rot[0],rot[1],rot[2], rot[3],rot[4],rot[5], rot[6],rot[7],rot[8] },
                    s   = scale,
                    tx, ty, tz,
                    mv,
                    vw, vh,
                    dpi,
                    scx, scy,
                    ts  = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };

                writer.WriteLine(JsonSerializer.Serialize(payload));

                frameCount++;
                if (frameCount % 60 == 0)
                    Console.WriteLine($"STATUS:Streaming — frame {frameCount}, scale={scale:F3}");
            }
            catch (TargetInvocationException tie) when
                (tie.InnerException is COMException cx &&
                 ((uint)cx.HResult == 0x800706BA || (uint)cx.HResult == 0x80010108))
            {
                Console.WriteLine("STATUS:SolidWorks disconnected — reconnecting...");
                swApp = null;
                while (swApp == null && pipe.IsConnected)
                {
                    swApp = ConnectToSolidWorks();
                    if (swApp == null) Thread.Sleep(2000);
                }
                if (swApp != null) Console.WriteLine("STATUS:Reconnected to SolidWorks");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"STATUS:Error — {ex.GetType().Name}: {ex.Message}");
                Thread.Sleep(50);
            }

            Thread.Sleep(16);
        }

        Console.WriteLine("STATUS:Pipe closed — exiting");
    }

    /// <summary>
    /// Find the best SolidWorks instance to connect to.
    /// Handles single and multi-instance scenarios.
    /// </summary>
    static object? ConnectToSolidWorks()
    {
        var instances = Com.GetAllSolidWorksInstances();
        if (instances.Count == 0) return null;

        if (instances.Count > 1)
        {
            Console.WriteLine($"STATUS:Found {instances.Count} SolidWorks instances — picking active one");
            foreach (var inst in instances)
                Console.WriteLine($"STATUS:  · {Com.InstanceLabel(inst)}");
        }

        var sw = Com.PickBestSolidWorks(instances);
        if (sw != null)
            Console.WriteLine($"STATUS:Connected to SolidWorks — {Com.InstanceLabel(sw)}");

        return sw;
    }
}
