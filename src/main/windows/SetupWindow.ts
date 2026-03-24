import { BrowserWindow, screen, session } from 'electron';
import * as path from 'path';

export class SetupWindow {
  public win: BrowserWindow;

  constructor() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

    this.win = new BrowserWindow({
      width: 300,
      height: 640,
      x: screenW - 300 - 20,  // right edge with margin
      y: 20,
      resizable: false,
      minimizable: true,
      maximizable: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      roundedCorners: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
      },
    });

    // Grant media permissions for screen capture (needed on Windows)
    this.win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media');
    });

    // Visible on ALL macOS desktops/spaces (no-op on Windows)
    if (process.platform === 'darwin') {
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    // Use 'screen-saver' level to stay above CAD applications on Windows.
    // 'modal-panel' is macOS-only semantics; on Windows all levels = HWND_TOPMOST anyway,
    // but 'screen-saver' gives the highest priority on both platforms.
    this.win.setAlwaysOnTop(true, 'screen-saver');

    this.win.loadFile(
      path.join(__dirname, '..', '..', '..', 'renderer', 'setup', 'index.html')
    );
  }

  show() {
    this.win.show();
    this.win.focus();
  }

  hide() {
    this.win.hide();
  }

  destroy() {
    if (!this.win.isDestroyed()) {
      this.win.destroy();
    }
  }
}
