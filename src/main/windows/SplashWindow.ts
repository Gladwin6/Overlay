import { BrowserWindow } from 'electron';
import * as path from 'path';

export class SplashWindow {
  public win: BrowserWindow;

  constructor() {
    this.win = new BrowserWindow({
      width: 1280,
      height: 800,
      frame: false,
      resizable: false,
      backgroundColor: '#0d1117',
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    this.win.loadFile(
      path.join(__dirname, '..', '..', '..', 'renderer', 'splash', 'index.html')
    );

    this.win.once('ready-to-show', () => {
      this.win.show();
    });
  }

  destroy() {
    if (!this.win.isDestroyed()) {
      this.win.destroy();
    }
  }
}
