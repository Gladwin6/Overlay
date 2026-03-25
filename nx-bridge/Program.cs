/**
 * NxBridge — Siemens NX COM/NXOpen Camera Bridge
 *
 * Connects to NX via COM (ProgID: "UGS.Session" or late-bound via ROT),
 * reads the work view's orientation matrix, and streams camera data
 * over a named pipe to the Electron overlay.
 *
 * NX Camera API (via COM reflection):
 *   - Session.Parts.Display → active part
 *   - Part.Views.WorkView → current work view
 *   - View.Matrix → 9-element orientation matrix (3x3 row-major)
 *   - View.Origin → Point3d (view center in model coords)
 *   - View.Scale → double (zoom factor)
 *
 * Frame JSON: { r[9], s, tx, ty, tz, vw, vh, dpi, scx, scy, ts }
 */

using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text.Json;

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
    static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]
    static extern int GetDeviceCaps(IntPtr hdc, int nIndex);

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
    /// Search the Running Object Table for NX session objects.
    /// NX may register as different ProgIDs depending on version.
    /// </summary>
    public static object? FindNxSession()
    {
        // Try common NX ProgIDs
        string[] progIds = {
            "NXOpen.Session",
            "UGS.Session",
            "Unigraphics.Session",
        };

        foreach (var pid in progIds)
        {
            var obj = TryGetActiveObject(pid);
            if (obj != null) return obj;
        }

        // Fallback: scan ROT for anything NX-related
        try
        {
            if (GetRunningObjectTable(0, out var rot) != 0) return null;
            rot.EnumRunning(out var enumMon);
            enumMon.Reset();
            if (CreateBindCtx(0, out var ctx) != 0) return null;

            var arr = new IMoniker[1];
            while (enumMon.Next(1, arr, IntPtr.Zero) == 0)
            {
                try
                {
                    arr[0].GetDisplayName(ctx, null, out var name);
                    if (name != null && (name.Contains("NX") || name.Contains("ugraf") || name.Contains("UGS")))
                    {
                        if (rot.GetObject(arr[0], out var obj) == 0 && obj != null)
                            return obj;
                    }
                }
                catch { }
            }
        }
        catch { }

        return null;
    }

    static readonly BindingFlags GET = BindingFlags.GetProperty | BindingFlags.Public | BindingFlags.Instance;
    static readonly BindingFlags INV = BindingFlags.InvokeMethod | BindingFlags.Public | BindingFlags.Instance;

    public static object? Get(object obj, string prop)
        => obj.GetType().InvokeMember(prop, GET, null, obj, null);

    public static object? Call(object obj, string method, params object[] args)
        => obj.GetType().InvokeMember(method, INV, null, obj, args);

    public static int LogicalDpi()
    {
        IntPtr hdc = GetDC(IntPtr.Zero);
        int dpi = hdc != IntPtr.Zero ? GetDeviceCaps(hdc, 88) : 96;
        if (hdc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdc);
        return dpi > 0 ? dpi : 96;
    }
}

class Program
{
    [STAThread]
    static void Main()
    {
        int dpi = Com.LogicalDpi();
        Console.WriteLine($"STATUS:NxBridge starting (DPI={dpi})");

        using var pipe = new NamedPipeServerStream(
            "hanomi_nx_camera",
            PipeDirection.Out,
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.None
        );

        Console.WriteLine("STATUS:Waiting for Electron to connect on pipe...");
        pipe.WaitForConnection();
        Console.WriteLine("STATUS:Electron connected");

        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        // ── Connect to NX ─────────────────────────────────────────────────
        object? nxSession = null;
        while (nxSession == null)
        {
            nxSession = Com.FindNxSession();
            if (nxSession == null)
            {
                Console.WriteLine("STATUS:Waiting for NX to start...");
                Thread.Sleep(2000);
            }
            if (!pipe.IsConnected) return;
        }
        Console.WriteLine("STATUS:Connected to NX");

        // ── Streaming loop ─────────────────────────────────────────────────
        int frameCount = 0;
        while (pipe.IsConnected)
        {
            try
            {
                // Navigate: Session → Parts → Display → Views → WorkView
                var parts = Com.Get(nxSession, "Parts");
                if (parts == null) { Thread.Sleep(100); continue; }

                var display = Com.Get(parts, "Display");
                if (display == null) { Thread.Sleep(100); continue; }

                var views = Com.Get(display, "Views");
                if (views == null) { Thread.Sleep(100); continue; }

                var workView = Com.Get(views, "WorkView");
                if (workView == null) { Thread.Sleep(100); continue; }

                // Read orientation matrix (3x3, row-major)
                // NX View.Matrix returns a Matrix3x3 object with Xx,Xy,Xz, Yx,Yy,Yz, Zx,Zy,Zz
                var matrix = Com.Get(workView, "Matrix");
                double[] r;

                if (matrix != null)
                {
                    try
                    {
                        // Try reading as Matrix3x3 properties
                        r = new[]
                        {
                            Convert.ToDouble(Com.Get(matrix, "Xx")),
                            Convert.ToDouble(Com.Get(matrix, "Xy")),
                            Convert.ToDouble(Com.Get(matrix, "Xz")),
                            Convert.ToDouble(Com.Get(matrix, "Yx")),
                            Convert.ToDouble(Com.Get(matrix, "Yy")),
                            Convert.ToDouble(Com.Get(matrix, "Yz")),
                            Convert.ToDouble(Com.Get(matrix, "Zx")),
                            Convert.ToDouble(Com.Get(matrix, "Zy")),
                            Convert.ToDouble(Com.Get(matrix, "Zz")),
                        };
                    }
                    catch
                    {
                        // Try as array
                        try
                        {
                            var arr = matrix as double[];
                            if (arr != null && arr.Length >= 9)
                                r = arr;
                            else
                            {
                                Thread.Sleep(100);
                                continue;
                            }
                        }
                        catch { Thread.Sleep(100); continue; }
                    }
                }
                else
                {
                    Thread.Sleep(100);
                    continue;
                }

                // Read scale (zoom)
                double scale = 1.0;
                try { scale = Convert.ToDouble(Com.Get(workView, "Scale")); }
                catch { }

                // Read origin (view center)
                double tx = 0, ty = 0, tz = 0;
                try
                {
                    var origin = Com.Get(workView, "Origin");
                    if (origin != null)
                    {
                        tx = Convert.ToDouble(Com.Get(origin, "X"));
                        ty = Convert.ToDouble(Com.Get(origin, "Y"));
                        tz = Convert.ToDouble(Com.Get(origin, "Z"));
                    }
                }
                catch { }

                // Viewport size (NX doesn't easily expose this via COM — use screen defaults)
                int vw = 1920, vh = 1080;

                double scx = 0, scy = 0;

                var payload = new
                {
                    r,
                    s = scale,
                    tx, ty, tz,
                    mv = new double[16],
                    vw, vh,
                    dpi,
                    scx, scy,
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
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
                Console.WriteLine("STATUS:NX disconnected — reconnecting...");
                nxSession = null;
                while (nxSession == null && pipe.IsConnected)
                {
                    nxSession = Com.FindNxSession();
                    if (nxSession == null) Thread.Sleep(2000);
                }
                if (nxSession != null) Console.WriteLine("STATUS:Reconnected to NX");
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
}
