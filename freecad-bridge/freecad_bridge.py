"""
FreeCAD Camera Bridge — streams camera orientation over TCP to the Electron overlay.

Connects to FreeCAD's Python API, reads the active 3D view's camera orientation,
and streams JSON frames over a TCP socket (port 3461) at ~60fps.

Camera data from FreeCAD:
  - FreeCADGui.ActiveDocument.ActiveView.getCameraOrientation() -> Rotation quaternion
  - FreeCADGui.ActiveDocument.ActiveView.getCameraNode() -> Coin3D camera node
  - Camera node fields: orientation, position, focalDistance, height (ortho zoom)

Frame JSON: { r[9], s, tx, ty, tz, vw, vh, dpi, scx, scy, ts }

Usage:
  Run from within FreeCAD's Python console or as a macro:
    exec(open("freecad_bridge.py").read())

  Or run standalone if FreeCAD modules are on sys.path:
    python freecad_bridge.py
"""

import json
import socket
import time
import threading
import sys

PORT = 3461
FRAME_INTERVAL = 1.0 / 60  # ~60fps


def get_camera_frame():
    """Read current camera state from FreeCAD and return a frame dict."""
    try:
        import FreeCADGui
        import FreeCAD
    except ImportError:
        return None

    try:
        view = FreeCADGui.ActiveDocument.ActiveView
    except (AttributeError, RuntimeError):
        return None

    try:
        # Get camera orientation as quaternion, convert to 3x3 rotation matrix
        rot = view.getCameraOrientation()
        matrix = rot.toMatrix()

        # FreeCAD Matrix is 4x4, extract 3x3 rotation (row-major)
        r = [
            matrix.A11, matrix.A12, matrix.A13,
            matrix.A21, matrix.A22, matrix.A23,
            matrix.A31, matrix.A32, matrix.A33,
        ]

        # Get camera node for position and zoom
        cam = view.getCameraNode()

        # Position (translation)
        pos = cam.position.getValue()
        tx, ty, tz = float(pos[0]), float(pos[1]), float(pos[2])

        # Scale: use height field for orthographic, focalDistance for perspective
        cam_type = cam.getTypeId().getName()
        if 'Orthographic' in cam_type:
            scale = float(cam.height.getValue())
        else:
            scale = float(cam.focalDistance.getValue())

        # Viewport size
        try:
            vw = int(view.getSize()[0])
            vh = int(view.getSize()[1])
        except Exception:
            vw, vh = 1920, 1080

        # DPI - FreeCAD doesn't expose this easily, default to 96
        dpi = 96

        return {
            'r': r,
            's': scale,
            'tx': tx, 'ty': ty, 'tz': tz,
            'mv': [0.0] * 16,
            'vw': vw, 'vh': vh,
            'dpi': dpi,
            'scx': 0.0, 'scy': 0.0,
            'ts': int(time.time() * 1000),
        }
    except Exception as e:
        print(f"[FreeCADBridge] Error reading camera: {e}")
        return None


def stream_to_client(conn, addr):
    """Stream camera frames to a single connected client."""
    print(f"[FreeCADBridge] Client connected: {addr}")
    frame_count = 0

    try:
        while True:
            frame = get_camera_frame()
            if frame is not None:
                line = json.dumps(frame) + '\n'
                conn.sendall(line.encode('utf-8'))
                frame_count += 1
                if frame_count % 60 == 0:
                    print(f"[FreeCADBridge] Streaming frame {frame_count}, scale={frame['s']:.3f}")
            time.sleep(FRAME_INTERVAL)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
        print(f"[FreeCADBridge] Client disconnected: {addr}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def run_server():
    """Run the TCP server that accepts overlay connections."""
    print(f"[FreeCADBridge] Starting TCP server on port {PORT}")

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', PORT))
    server.listen(1)
    print(f"[FreeCADBridge] Listening on 127.0.0.1:{PORT}")

    try:
        while True:
            conn, addr = server.accept()
            # Handle one client at a time (overlay reconnects if disconnected)
            stream_to_client(conn, addr)
    except KeyboardInterrupt:
        print("[FreeCADBridge] Shutting down")
    finally:
        server.close()


def run_server_background():
    """Start the bridge server in a background thread (for use inside FreeCAD)."""
    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    print(f"[FreeCADBridge] Background server thread started on port {PORT}")
    return t


if __name__ == '__main__':
    # When run as a script directly
    run_server()
