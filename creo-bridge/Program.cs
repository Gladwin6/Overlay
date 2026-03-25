/**
 * CreoBridge — PTC Creo COM Camera Bridge
 *
 * Connects to Creo via COM (ProgID: "CreoParametric.Application" or scan ROT),
 * reads the active window's view orientation matrix, and streams camera data
 * over a named pipe to the Electron overlay.
 *
 * Creo/Pro-E Camera API (via COM reflection / VB API):
 *   - Application.ActiveWindow → current model window
 *   - Window.ViewMatrix → 4x4 transformation matrix
 *   - Window.Scale → zoom factor
 *   - Window.Width / Height → viewport dimensions
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
    /// Search the Running Object Table for Creo/Pro-E session objects.
    /// </summary>
    public static object? FindCreoSession()
    {
        string[] progIds = {
            "CreoParametric.Application",
            "proeWildfire.Application",
            "proe.Application",
        };

        foreach (var pid in progIds)
        {
            var obj = TryGetActiveObject(pid);
            if (obj != null) return obj;
        }

        // Fallback: scan ROT for Creo-related entries
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
                    if (name != null && (name.Contains("Creo") || name.Contains("ProE") || name.Contains("xtop")))
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
        Console.WriteLine($"STATUS:CreoBridge starting (DPI={dpi})");

        using var pipe = new NamedPipeServerStream(
            "hanomi_creo_camera",
            PipeDirection.Out,
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.None
        );

        Console.WriteLine("STATUS:Waiting for Electron to connect on pipe...");
        pipe.WaitForConnection();
        Console.WriteLine("STATUS:Electron connected");

        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        // ── Connect to Creo ───────────────────────────────────────────────
        object? creo = null;
        while (creo == null)
        {
            creo = Com.FindCreoSession();
            if (creo == null)
            {
                Console.WriteLine("STATUS:Waiting for Creo to start...");
                Thread.Sleep(2000);
            }
            if (!pipe.IsConnected) return;
        }
        Console.WriteLine("STATUS:Connected to Creo");

        // ── Streaming loop ────────────────────────────────────────────────
        int frameCount = 0;
        while (pipe.IsConnected)
        {
            try
            {
                // Navigate: Application → ActiveWindow
                var window = Com.Get(creo, "ActiveWindow");
                if (window == null) { Thread.Sleep(100); continue; }

                // Try to get view orientation from window
                // Creo VB API: Window.ViewMatrix returns a Transform with a 4x4 matrix
                double[] r = new double[9];
                double tx = 0, ty = 0, tz = 0;

                try
                {
                    var viewMatrix = Com.Get(window, "ViewMatrix");
                    if (viewMatrix != null)
                    {
                        // Try reading as a Transform with Matrix property
                        var matrix = Com.Get(viewMatrix, "Matrix");
                        if (matrix is double[] m && m.Length >= 16)
                        {
                            // Extract 3x3 rotation from 4x4 (row-major)
                            r = new[] { m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10] };
                            tx = m[3]; ty = m[7]; tz = m[11];
                        }
                        else
                        {
                            // Try reading individual elements
                            try
                            {
                                var xAxis = Com.Get(viewMatrix, "XAxis");
                                var yAxis = Com.Get(viewMatrix, "YAxis");
                                var zAxis = Com.Get(viewMatrix, "ZAxis");
                                var origin = Com.Get(viewMatrix, "Origin");

                                if (xAxis != null && yAxis != null && zAxis != null)
                                {
                                    r[0] = Convert.ToDouble(Com.Get(xAxis, "X"));
                                    r[1] = Convert.ToDouble(Com.Get(xAxis, "Y"));
                                    r[2] = Convert.ToDouble(Com.Get(xAxis, "Z"));
                                    r[3] = Convert.ToDouble(Com.Get(yAxis, "X"));
                                    r[4] = Convert.ToDouble(Com.Get(yAxis, "Y"));
                                    r[5] = Convert.ToDouble(Com.Get(yAxis, "Z"));
                                    r[6] = Convert.ToDouble(Com.Get(zAxis, "X"));
                                    r[7] = Convert.ToDouble(Com.Get(zAxis, "Y"));
                                    r[8] = Convert.ToDouble(Com.Get(zAxis, "Z"));
                                }

                                if (origin != null)
                                {
                                    tx = Convert.ToDouble(Com.Get(origin, "X"));
                                    ty = Convert.ToDouble(Com.Get(origin, "Y"));
                                    tz = Convert.ToDouble(Com.Get(origin, "Z"));
                                }
                            }
                            catch { }
                        }
                    }
                }
                catch { }

                // Read scale (zoom)
                double scale = 1.0;
                try { scale = Convert.ToDouble(Com.Get(window, "Scale")); }
                catch { }

                // Viewport size
                int vw = 1920, vh = 1080;
                try
                {
                    vw = Convert.ToInt32(Com.Get(window, "Width"));
                    vh = Convert.ToInt32(Com.Get(window, "Height"));
                }
                catch { }

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
                Console.WriteLine("STATUS:Creo disconnected — reconnecting...");
                creo = null;
                while (creo == null && pipe.IsConnected)
                {
                    creo = Com.FindCreoSession();
                    if (creo == null) Thread.Sleep(2000);
                }
                if (creo != null) Console.WriteLine("STATUS:Reconnected to Creo");
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
