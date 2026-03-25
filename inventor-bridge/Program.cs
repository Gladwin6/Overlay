/**
 * InventorBridge — Autodesk Inventor COM Camera Bridge
 *
 * Connects to Inventor via COM, reads the active view's Camera transform,
 * and streams camera data over a named pipe to the Electron overlay.
 *
 * Frame JSON: { r[9], s, tx, ty, tz, vw, vh, dpi, scx, scy, ts }
 *   Same format as SwBridge for compatibility with the overlay renderer.
 *
 * Inventor Camera API:
 *   - Application.ActiveView.Camera → Camera object
 *   - Camera.Eye → Point (camera position)
 *   - Camera.Target → Point (look-at point)
 *   - Camera.UpVector → UnitVector (camera up)
 *   - Camera.ViewOrientationType → enum
 *   - Camera.GetExtents → width, height of view in model units
 */

using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;

// ── COM helpers (shared pattern with SwBridge) ─────────────────────────────────
static class Com
{
    [DllImport("ole32.dll")]
    static extern int CLSIDFromProgID(
        [MarshalAs(UnmanagedType.LPWStr)] string lpszProgID, out Guid pclsid);

    [DllImport("oleaut32.dll")]
    static extern int GetActiveObject(
        ref Guid rclsid, IntPtr pvReserved,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppunk);

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

    static readonly BindingFlags GET = BindingFlags.GetProperty | BindingFlags.Public | BindingFlags.Instance;
    static readonly BindingFlags INV = BindingFlags.InvokeMethod | BindingFlags.Public | BindingFlags.Instance;

    public static object? Get(object obj, string prop)
        => obj.GetType().InvokeMember(prop, GET, null, obj, null);

    public static object? Call(object obj, string method, params object[] args)
        => obj.GetType().InvokeMember(method, INV, null, obj, args);

    public static int LogicalDpi()
    {
        IntPtr hdc = GetDC(IntPtr.Zero);
        int dpi = hdc != IntPtr.Zero ? GetDeviceCaps(hdc, 88 /* LOGPIXELSX */) : 96;
        if (hdc != IntPtr.Zero) ReleaseDC(IntPtr.Zero, hdc);
        return dpi > 0 ? dpi : 96;
    }
}

// ── Entry point (STA required for COM) ────────────────────────────────────────
class Program
{
    [STAThread]
    static void Main()
    {
        int dpi = Com.LogicalDpi();
        Console.WriteLine($"STATUS:InventorBridge starting (DPI={dpi})");

        using var pipe = new NamedPipeServerStream(
            "hanomi_inventor_camera",
            PipeDirection.Out,
            maxNumberOfServerInstances: 1,
            transmissionMode: PipeTransmissionMode.Byte,
            options: PipeOptions.None
        );

        Console.WriteLine("STATUS:Waiting for Electron to connect on pipe...");
        pipe.WaitForConnection();
        Console.WriteLine("STATUS:Electron connected");

        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        // ── Connect to Inventor ────────────────────────────────────────────
        object? invApp = null;
        while (invApp == null)
        {
            invApp = Com.TryGetActiveObject("Inventor.Application");
            if (invApp == null)
            {
                Console.WriteLine("STATUS:Waiting for Inventor to start...");
                Thread.Sleep(2000);
            }
            if (!pipe.IsConnected) return;
        }
        Console.WriteLine("STATUS:Connected to Inventor");

        // ── Streaming loop ─────────────────────────────────────────────────
        int frameCount = 0;
        while (pipe.IsConnected)
        {
            try
            {
                var doc = Com.Get(invApp, "ActiveDocument");
                if (doc == null) { Thread.Sleep(100); continue; }

                // Get active view
                var views = Com.Get(doc, "Views");
                if (views == null) { Thread.Sleep(100); continue; }
                var view = Com.Call(views, "Item", 1); // first view
                if (view == null) { Thread.Sleep(100); continue; }

                // Get camera
                var camera = Com.Get(view, "Camera");
                if (camera == null) { Thread.Sleep(100); continue; }

                // Camera vectors
                var eye = Com.Get(camera, "Eye");
                var target = Com.Get(camera, "Target");
                var upVec = Com.Get(camera, "UpVector");

                if (eye == null || target == null || upVec == null) { Thread.Sleep(100); continue; }

                // Extract coordinates
                double eyeX = Convert.ToDouble(Com.Get(eye, "X"));
                double eyeY = Convert.ToDouble(Com.Get(eye, "Y"));
                double eyeZ = Convert.ToDouble(Com.Get(eye, "Z"));

                double tgtX = Convert.ToDouble(Com.Get(target, "X"));
                double tgtY = Convert.ToDouble(Com.Get(target, "Y"));
                double tgtZ = Convert.ToDouble(Com.Get(target, "Z"));

                double upX = Convert.ToDouble(Com.Get(upVec, "X"));
                double upY = Convert.ToDouble(Com.Get(upVec, "Y"));
                double upZ = Convert.ToDouble(Com.Get(upVec, "Z"));

                // Build camera basis vectors (view matrix rows)
                // Forward = normalize(target - eye)
                double fwdX = tgtX - eyeX, fwdY = tgtY - eyeY, fwdZ = tgtZ - eyeZ;
                double fwdLen = Math.Sqrt(fwdX * fwdX + fwdY * fwdY + fwdZ * fwdZ);
                if (fwdLen < 0.0001) { Thread.Sleep(100); continue; }
                fwdX /= fwdLen; fwdY /= fwdLen; fwdZ /= fwdLen;

                // Right = normalize(forward × up)
                double rightX = fwdY * upZ - fwdZ * upY;
                double rightY = fwdZ * upX - fwdX * upZ;
                double rightZ = fwdX * upY - fwdY * upX;
                double rightLen = Math.Sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
                if (rightLen < 0.0001) { Thread.Sleep(100); continue; }
                rightX /= rightLen; rightY /= rightLen; rightZ /= rightLen;

                // Re-orthogonalize up = right × forward
                double upRX = rightY * fwdZ - rightZ * fwdY;
                double upRY = rightZ * fwdX - rightX * fwdZ;
                double upRZ = rightX * fwdY - rightY * fwdX;

                // View matrix rows: right, up, -forward (back)
                var r = new[]
                {
                    rightX, rightY, rightZ,
                    upRX, upRY, upRZ,
                    -fwdX, -fwdY, -fwdZ,
                };

                // Zoom: get view extents
                double viewW = 1.0, viewH = 1.0;
                try
                {
                    // Camera.GetExtents(out width, out height) in cm
                    var extW = new object[] { 0.0, 0.0 };
                    // Try reading ViewOrientationType or Extent
                    viewW = Convert.ToDouble(Com.Get(camera, "Width") ?? 1.0);
                    viewH = Convert.ToDouble(Com.Get(camera, "Height") ?? 1.0);
                }
                catch
                {
                    viewW = fwdLen * 2; // fallback estimate
                    viewH = fwdLen * 2;
                }

                // Scale: approximate pixels per cm based on view extent and viewport size
                int vw = 0, vh = 0;
                try
                {
                    vw = Convert.ToInt32(Com.Get(view, "Width") ?? 0);
                    vh = Convert.ToInt32(Com.Get(view, "Height") ?? 0);
                }
                catch { }

                // Scale2 equivalent: cm per pixel → convert to metres per pixel
                double scale = viewW > 0 && vw > 0 ? (viewW / 100.0) / vw * dpi * 39.3701 : 1.0;

                // Translation (eye position in view space for scx/scy)
                double tx = rightX * eyeX + rightY * eyeY + rightZ * eyeZ;
                double ty = upRX * eyeX + upRY * eyeY + upRZ * eyeZ;
                double tz = -fwdX * eyeX - fwdY * eyeY - fwdZ * eyeZ;

                // scx/scy: project origin to screen
                double scx = 0, scy = 0;

                var payload = new
                {
                    r,
                    s = scale,
                    tx, ty, tz,
                    mv = new double[16], // placeholder
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
                Console.WriteLine("STATUS:Inventor disconnected — reconnecting...");
                invApp = null;
                while (invApp == null && pipe.IsConnected)
                {
                    invApp = Com.TryGetActiveObject("Inventor.Application");
                    if (invApp == null) Thread.Sleep(2000);
                }
                if (invApp != null) Console.WriteLine("STATUS:Reconnected to Inventor");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"STATUS:Error — {ex.GetType().Name}: {ex.Message}");
                Thread.Sleep(50);
            }

            Thread.Sleep(16); // ~60fps
        }

        Console.WriteLine("STATUS:Pipe closed — exiting");
    }
}
