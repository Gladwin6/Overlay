/**
 * SolidEdgeBridge — Solid Edge COM Camera Bridge
 *
 * Connects to Solid Edge via COM (ProgID: "SolidEdge.Application"),
 * reads the active window's view orientation matrix, and streams camera data
 * over a named pipe to the Electron overlay.
 *
 * Solid Edge Camera API (via COM reflection):
 *   - Application.ActiveWindow → current window
 *   - Window.View → active View object
 *   - View.ModelToScreenMatrix → 4x4 transformation matrix (16 doubles)
 *   - View.GetModelRange → model extents
 *   - View.Camera → Camera object with Eye, Target, UpVector, Zoom
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
    /// Search the Running Object Table for Solid Edge session objects.
    /// </summary>
    public static object? FindSolidEdgeSession()
    {
        string[] progIds = {
            "SolidEdge.Application",
        };

        foreach (var pid in progIds)
        {
            var obj = TryGetActiveObject(pid);
            if (obj != null) return obj;
        }

        // Fallback: scan ROT for Solid Edge entries
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
                    if (name != null && (name.Contains("SolidEdge") || name.Contains("Solid Edge")))
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
        Console.WriteLine($"STATUS:SolidEdgeBridge starting (DPI={dpi})");

        using var pipe = new NamedPipeServerStream(
            "hanomi_solidedge_camera",
            PipeDirection.Out,
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.None
        );

        Console.WriteLine("STATUS:Waiting for Electron to connect on pipe...");
        pipe.WaitForConnection();
        Console.WriteLine("STATUS:Electron connected");

        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        // ── Connect to Solid Edge ─────────────────────────────────────────
        object? solidEdge = null;
        while (solidEdge == null)
        {
            solidEdge = Com.FindSolidEdgeSession();
            if (solidEdge == null)
            {
                Console.WriteLine("STATUS:Waiting for Solid Edge to start...");
                Thread.Sleep(2000);
            }
            if (!pipe.IsConnected) return;
        }
        Console.WriteLine("STATUS:Connected to Solid Edge");

        // ── Streaming loop ────────────────────────────────────────────────
        int frameCount = 0;
        while (pipe.IsConnected)
        {
            try
            {
                // Navigate: Application → ActiveWindow → View
                var window = Com.Get(solidEdge, "ActiveWindow");
                if (window == null) { Thread.Sleep(100); continue; }

                var view = Com.Get(window, "View");
                if (view == null) { Thread.Sleep(100); continue; }

                // Read orientation via Camera object
                double[] r = new double[9];
                double tx = 0, ty = 0, tz = 0;

                try
                {
                    var camera = Com.Get(view, "Camera");
                    if (camera != null)
                    {
                        // Camera has Eye, Target, UpVector properties
                        var eye = Com.Get(camera, "Eye");
                        var target = Com.Get(camera, "Target");
                        var upVec = Com.Get(camera, "UpVector");

                        if (eye != null && target != null && upVec != null)
                        {
                            double ex = Convert.ToDouble(Com.Get(eye, "X"));
                            double ey = Convert.ToDouble(Com.Get(eye, "Y"));
                            double ez = Convert.ToDouble(Com.Get(eye, "Z"));
                            double targx = Convert.ToDouble(Com.Get(target, "X"));
                            double targy = Convert.ToDouble(Com.Get(target, "Y"));
                            double targz = Convert.ToDouble(Com.Get(target, "Z"));
                            double ux = Convert.ToDouble(Com.Get(upVec, "X"));
                            double uy = Convert.ToDouble(Com.Get(upVec, "Y"));
                            double uz = Convert.ToDouble(Com.Get(upVec, "Z"));

                            // Build rotation from look-at
                            double zx = ex - targx, zy = ey - targy, zz = ez - targz;
                            double zLen = Math.Sqrt(zx * zx + zy * zy + zz * zz);
                            if (zLen > 1e-10) { zx /= zLen; zy /= zLen; zz /= zLen; }

                            // X = up cross Z
                            double xx = uy * zz - uz * zy;
                            double xy = uz * zx - ux * zz;
                            double xz = ux * zy - uy * zx;
                            double xLen = Math.Sqrt(xx * xx + xy * xy + xz * xz);
                            if (xLen > 1e-10) { xx /= xLen; xy /= xLen; xz /= xLen; }

                            // Y = Z cross X
                            double yx = zy * xz - zz * xy;
                            double yy = zz * xx - zx * xz;
                            double yz = zx * xy - zy * xx;

                            r = new[] { xx, xy, xz, yx, yy, yz, zx, zy, zz };
                            tx = ex; ty = ey; tz = ez;
                        }
                    }
                }
                catch { }

                // Try ModelToScreenMatrix as fallback
                if (r[0] == 0 && r[4] == 0 && r[8] == 0)
                {
                    try
                    {
                        var m2s = Com.Get(view, "ModelToScreenMatrix");
                        if (m2s is double[] m && m.Length >= 16)
                        {
                            r = new[] { m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10] };
                            tx = m[3]; ty = m[7]; tz = m[11];
                        }
                    }
                    catch { }
                }

                // Read scale
                double scale = 1.0;
                try { scale = Convert.ToDouble(Com.Get(view, "Zoom")); }
                catch
                {
                    try { scale = Convert.ToDouble(Com.Get(view, "Scale")); }
                    catch { }
                }

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
                Console.WriteLine("STATUS:Solid Edge disconnected — reconnecting...");
                solidEdge = null;
                while (solidEdge == null && pipe.IsConnected)
                {
                    solidEdge = Com.FindSolidEdgeSession();
                    if (solidEdge == null) Thread.Sleep(2000);
                }
                if (solidEdge != null) Console.WriteLine("STATUS:Reconnected to Solid Edge");
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
