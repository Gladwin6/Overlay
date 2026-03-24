import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

export class OverlayWindow {
  public win: BrowserWindow;

  constructor() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { bounds } = primaryDisplay;

    this.win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      focusable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        webSecurity: false,
      },
    });

    // Click-through — overlay doesn't capture mouse by default
    this.win.setIgnoreMouseEvents(true, { forward: true });

    // Visible on ALL macOS desktops/spaces
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Use 'screen-saver' level — highest z-order, ensures overlay sits above
    // SolidWorks, Fusion 360, and other CAD applications on Windows and macOS.
    this.win.setAlwaysOnTop(true, 'screen-saver');

    this.win.loadFile(
      path.join(__dirname, '..', '..', '..', 'renderer', 'overlay', 'index.html')
    );
  }

  /**
   * Move the overlay window to cover a specific display.
   * Must be called before show() when CAD is on a non-primary monitor.
   */
  moveToDisplay(display: Electron.Display) {
    this.win.setBounds({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    });
  }

  show() {
    this.win.showInactive();
    // Re-assert top position every time we show — CAD apps can briefly claim
    // HWND_TOPMOST during their own window operations, knocking us back.
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.moveTop();
  }

  hide() {
    this.win.hide();
  }

  setClickThrough(enabled: boolean) {
    this.win.setIgnoreMouseEvents(enabled, { forward: true });
    this.win.setFocusable(!enabled);
  }

  destroy() {
    if (!this.win.isDestroyed()) {
      this.win.destroy();
    }
  }
}
