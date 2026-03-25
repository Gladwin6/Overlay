/**
 * CatiaBridge — CATIA V5/V6 COM Camera Bridge
 *
 * Connects to CATIA via COM (ProgID: "CATIA.Application" or scan ROT for CATIA/CNEXT),
 * reads the active viewer's viewpoint orientation matrix, and streams camera data
 * over a named pipe to the Electron overlay.
 *
 * CATIA Camera API (via COM reflection):
 *   - Application.ActiveDocument → active document
 *   - ActiveDocument.ActiveViewer → active 3D viewer
 *   - ActiveViewer.Viewpoint3D → current viewpoint
 *   - Viewpoint3D.Origin → CATSafeArrayVariant (x,y,z)
 *   - Viewpoint3D.SightDirection → CATSafeArrayVariant (dx,dy,dz)
 *   - Viewpoint3D.UpDirection → CATSafeArrayVariant (ux,uy,uz)
 *   - Viewpoint3D.FocusDistance → double (zoom/scale factor)
 *   - ActiveViewer.Width / Height → viewport dimensions
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
    /// Search the Running Object Table for CATIA session objects.
    /// CATIA V5 registers as "CATIA.Application", V6/3DExperience as CNEXT.
    /// </summary>
    public static object? FindCatiaSession()
    {
        string[] progIds = {
            "CATIA.Application",
            "CNEXT.Application",
        };

        foreach (var pid in progIds)
        {
            var obj = TryGetActiveObject(pid);
            if (obj != null) return obj;
        }

        // Fallback: scan ROT for CATIA-related entries
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
                    if (name != null && (name.Contains("CATIA") || name.Contains("CNEXT") || name.Contains("3DEXPERIENCE")))
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
        Console.WriteLine($"STATUS:CatiaBridge starting (DPI={dpi})");

        using var pipe = new NamedPipeServerStream(
            "hanomi_catia_camera",
            PipeDirection.Out,
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.None
        );

        Console.WriteLine("STATUS:Waiting for Electron to connect on pipe...");
        pipe.WaitForConnection();
        Console.WriteLine("STATUS:Electron connected");

        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        // ── Connect to CATIA ──────────────────────────────────────────────
        object? catia = null;
        while (catia == null)
        {
            catia = Com.FindCatiaSession();
            if (catia == null)
            {
                Console.WriteLine("STATUS:Waiting for CATIA to start...");
                Thread.Sleep(2000);
            }
            if (!pipe.IsConnected) return;
        }
        Console.WriteLine("STATUS:Connected to CATIA");

        // ── Streaming loop ────────────────────────────────────────────────
        int frameCount = 0;
        while (pipe.IsConnected)
        {
            try
            {
                // Navigate: Application → ActiveDocument → ActiveViewer → Viewpoint3D
                var doc = Com.Get(catia, "ActiveDocument");
                if (doc == null) { Thread.Sleep(100); continue; }

                var viewer = Com.Get(doc, "ActiveViewer");
                if (viewer == null) { Thread.Sleep(100); continue; }

                var viewpoint = Com.Get(viewer, "Viewpoint3D");
                if (viewpoint == null) { Thread.Sleep(100); continue; }

                // Read origin (eye position)
                double tx = 0, ty = 0, tz = 0;
                try
                {
                    var origin = Com.Get(viewpoint, "Origin") as double[];
                    if (origin != null && origin.Length >= 3)
                    {
                        tx = origin[0]; ty = origin[1]; tz = origin[2];
                    }
                }
                catch { }

                // Read sight direction and up direction to build rotation matrix
                double[] r = new double[9];
                try
                {
                    var sight = Com.Get(viewpoint, "SightDirection") as double[];
                    var up = Com.Get(viewpoint, "UpDirection") as double[];

                    if (sight != null && sight.Length >= 3 && up != null && up.Length >= 3)
                    {
                        // Build orthonormal basis: Z = -sight, Y = up, X = Y x Z
                        double zx = -sight[0], zy = -sight[1], zz = -sight[2];
                        double yx = up[0], yy = up[1], yz = up[2];
                        // X = Y cross Z
                        double xx = yy * zz - yz * zy;
                        double xy = yz * zx - yx * zz;
                        double xz = yx * zy - yy * zx;
                        // Normalize X
                        double xLen = Math.Sqrt(xx * xx + xy * xy + xz * xz);
                        if (xLen > 1e-10) { xx /= xLen; xy /= xLen; xz /= xLen; }

                        r = new[] { xx, xy, xz, yx, yy, yz, zx, zy, zz };
                    }
                }
                catch { }

                // Read focus distance as scale
                double scale = 1.0;
                try { scale = Convert.ToDouble(Com.Get(viewpoint, "FocusDistance")); }
                catch { }

                // Viewport size
                int vw = 1920, vh = 1080;
                try
                {
                    vw = Convert.ToInt32(Com.Get(viewer, "Width"));
                    vh = Convert.ToInt32(Com.Get(viewer, "Height"));
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
                Console.WriteLine("STATUS:CATIA disconnected — reconnecting...");
                catia = null;
                while (catia == null && pipe.IsConnected)
                {
                    catia = Com.FindCatiaSession();
                    if (catia == null) Thread.Sleep(2000);
                }
                if (catia != null) Console.WriteLine("STATUS:Reconnected to CATIA");
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
