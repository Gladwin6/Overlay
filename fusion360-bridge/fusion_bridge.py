"""
Fusion 360 Camera Bridge — Hanomi Overlay
==========================================
Fusion 360 add-in script that reads the active viewport camera and streams
JSON frames over a TCP socket on port 3460.

Usage:
  1. In Fusion 360 -> Scripts and Add-Ins -> Add-Ins tab
  2. Click the green "+" to add a folder, point it at this directory
  3. Run "fusion_bridge" — it will keep streaming until you stop it

JSON frame format (one JSON object per line):
  { "r": [9 floats], "s": float, "tx": 0, "ty": 0, "tz": 0,
    "vw": int, "vh": int, "dpi": int, "scx": 0, "scy": 0, "ts": int }

r = 3x3 view rotation matrix (row-major), built from camera eye/target/up.
s = camera extent (zoom).  Fusion 360 is Z-up.
"""

import adsk.core
import adsk.fusion
import json
import socket
import threading
import time
import math
import traceback

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TCP_PORT = 3460
FRAME_INTERVAL = 1.0 / 60  # ~60 fps target

# ---------------------------------------------------------------------------
# Globals (Fusion add-in lifecycle)
# ---------------------------------------------------------------------------
_app: adsk.core.Application = None
_ui: adsk.core.UserInterface = None
_running = False
_server_thread: threading.Thread = None
_stop_event = threading.Event()

# ---------------------------------------------------------------------------
# Camera -> JSON frame
# ---------------------------------------------------------------------------

def _vec_sub(a, b):
    return (a.x - b.x, a.y - b.y, a.z - b.z)

def _vec_normalize(v):
    length = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
    if length < 1e-12:
        return (0.0, 0.0, 1.0)
    return (v[0] / length, v[1] / length, v[2] / length)

def _vec_cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )

def build_frame() -> dict | None:
    """Read the active Fusion 360 viewport camera and return a frame dict."""
    try:
        app = adsk.core.Application.get()
        if not app:
            return None

        vp = app.activeViewport
        if not vp:
            return None

        cam = vp.camera

        eye_pt = cam.eye
        target_pt = cam.target
        up_vec = cam.upVector

        # Build view rotation matrix (world -> view)
        forward = _vec_normalize(_vec_sub(target_pt, eye_pt))  # -Z in view space
        right = _vec_normalize(_vec_cross(forward, (up_vec.x, up_vec.y, up_vec.z)))
        up = _vec_cross(right, forward)

        # Row-major 3x3: rows are right, up, -forward (OpenGL convention)
        r = [
            right[0],   right[1],   right[2],
            up[0],      up[1],      up[2],
            -forward[0], -forward[1], -forward[2],
        ]

        # Scale — use camera extent (height of view volume in model units)
        extent = cam.viewExtents  # in cm (Fusion internal unit)

        # Viewport pixel dimensions
        vw = vp.width
        vh = vp.height

        # DPI — Fusion doesn't expose this directly; default to 96
        dpi = 96

        ts = int(time.time() * 1000)

        return {
            "r": [round(v, 8) for v in r],
            "s": round(extent, 6),
            "tx": 0.0,
            "ty": 0.0,
            "tz": 0.0,
            "vw": vw,
            "vh": vh,
            "dpi": dpi,
            "scx": 0.0,
            "scy": 0.0,
            "ts": ts,
        }
    except Exception:
        traceback.print_exc()
        return None

# ---------------------------------------------------------------------------
# TCP streaming server
# ---------------------------------------------------------------------------

def _serve_client(conn: socket.socket, addr):
    """Stream frames to a single connected client."""
    global _stop_event
    print(f"[FusionBridge] Client connected: {addr}")
    try:
        while not _stop_event.is_set():
            frame = build_frame()
            if frame:
                line = json.dumps(frame, separators=(",", ":")) + "\n"
                conn.sendall(line.encode("utf-8"))
            time.sleep(FRAME_INTERVAL)
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        print(f"[FusionBridge] Client disconnected: {addr}")
        try:
            conn.close()
        except Exception:
            pass

def _server_loop():
    """Accept TCP connections on TCP_PORT and stream frames to each."""
    global _stop_event
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.settimeout(1.0)
    srv.bind(("127.0.0.1", TCP_PORT))
    srv.listen(2)
    print(f"[FusionBridge] Listening on 127.0.0.1:{TCP_PORT}")

    while not _stop_event.is_set():
        try:
            conn, addr = srv.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            t = threading.Thread(target=_serve_client, args=(conn, addr), daemon=True)
            t.start()
        except socket.timeout:
            continue
        except OSError:
            break

    srv.close()
    print("[FusionBridge] Server stopped")

# ---------------------------------------------------------------------------
# Fusion 360 add-in entry points
# ---------------------------------------------------------------------------

def run(context):
    global _app, _ui, _running, _server_thread, _stop_event
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface

        if _running:
            _ui.messageBox("Fusion Bridge is already running.")
            return

        _stop_event.clear()
        _server_thread = threading.Thread(target=_server_loop, daemon=True)
        _server_thread.start()
        _running = True

        _ui.messageBox(
            f"Hanomi Fusion Bridge started.\n"
            f"Streaming camera on TCP port {TCP_PORT}.\n"
            f"Stop via Scripts and Add-Ins.",
            "Fusion Bridge",
        )
    except Exception:
        if _ui:
            _ui.messageBox("Failed to start Fusion Bridge:\n" + traceback.format_exc())

def stop(context):
    global _running, _stop_event, _server_thread
    try:
        _stop_event.set()
        _running = False
        if _server_thread:
            _server_thread.join(timeout=3)
            _server_thread = None
        print("[FusionBridge] Add-in stopped")
    except Exception:
        pass
