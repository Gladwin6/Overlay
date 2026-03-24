import { io, Socket } from 'socket.io-client';
import { BrowserWindow, screen } from 'electron';
import { InputInjector } from './InputInjector';

const SERVER_URL = 'http://localhost:3001';

export class ReviewSession {
  private socket: Socket | null = null;
  private roomCode: string | null = null;
  private controlState: 'idle' | 'requested' | 'active' = 'idle';
  private setupWindow: BrowserWindow | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private inputInjector: InputInjector = new InputInjector();

  start(setupWin: BrowserWindow, overlayWin: BrowserWindow | null): void {
    this.setupWindow = setupWin;
    this.overlayWindow = overlayWin;

    this.socket = io(SERVER_URL, { transports: ['websocket'] });

    this.socket.on('connect', () => {
      console.log('[Review] Connected to server');
      this.socket!.emit('room:create');
    });

    this.socket.on('room:joined', (data: any) => {
      this.roomCode = data.code;
      console.log(`[Review] Room created: ${this.roomCode}`);
      this.sendToSetup('review:room-code', this.roomCode);
      this.sendToSetup('review:status', { status: 'waiting', code: this.roomCode });
    });

    this.socket.on('room:peer-joined', () => {
      console.log('[Review] Vendor joined — sending peer-joined to setup renderer');
      this.sendToSetup('review:status', { status: 'connected', code: this.roomCode });
      // Notify renderer to initiate WebRTC offer
      this.sendToSetup('room:peer-joined', {});
      // Also try signaling directly — trigger screen capture from main process
      this.startScreenShare();
    });

    this.socket.on('room:peer-left', () => {
      console.log('[Review] Vendor left');
      this.controlState = 'idle';
      this.sendToSetup('review:status', { status: 'waiting', code: this.roomCode });
    });

    // WebRTC signaling - relay to renderer
    this.socket.on('signal:offer', (offer: any) => {
      this.sendToSetup('signal:offer', offer);
    });
    this.socket.on('signal:answer', (answer: any) => {
      this.sendToSetup('signal:answer', answer);
    });
    this.socket.on('signal:ice', (candidate: any) => {
      this.sendToSetup('signal:ice', candidate);
    });

    // Annotations from vendor
    this.socket.on('annotation:create', (ann: any) => {
      if (ann.author === 'vendor') {
        this.sendToSetup('review:annotation', ann);
        this.sendToOverlay('review:annotation', ann);
      }
    });
    this.socket.on('annotation:delete', (id: string) => {
      this.sendToSetup('review:annotation-delete', id);
      this.sendToOverlay('review:annotation-delete', id);
    });

    // Control requests from vendor
    this.socket.on('control:request', () => {
      this.controlState = 'requested';
      this.sendToSetup('review:control-request', {});
    });

    // Remote control input from vendor — inject as OS input
    this.socket.on('control:input', (event: any) => {
      if (this.controlState === 'active') {
        this.inputInjector.inject(event);
      }
    });

    // Chat from vendor
    this.socket.on('chat:message', (msg: any) => {
      this.sendToSetup('review:chat-message', msg);
    });

    this.socket.on('disconnect', () => {
      console.log('[Review] Disconnected from server');
      this.sendToSetup('review:status', { status: 'disconnected' });
    });
  }

  stop(): void {
    this.inputInjector.stop();
    this.socket?.disconnect();
    this.socket = null;
    this.roomCode = null;
    this.controlState = 'idle';
  }

  // Relay WebRTC signaling from renderer to server
  relaySignal(event: string, data: any): void {
    this.socket?.emit(event, data);
  }

  grantControl(): void {
    this.controlState = 'active';
    this.socket?.emit('control:grant');
    // Set ROI to the full primary display if not set
    if (!this.inputInjector['roi']) {
      const primaryDisplay = screen.getPrimaryDisplay();
      this.inputInjector.setROI({
        x: primaryDisplay.bounds.x,
        y: primaryDisplay.bounds.y,
        width: primaryDisplay.bounds.width,
        height: primaryDisplay.bounds.height,
      });
    }
    this.inputInjector.start();
    this.sendToSetup('review:status', { status: 'controlling', code: this.roomCode });
  }

  denyControl(): void {
    this.controlState = 'idle';
    this.socket?.emit('control:deny');
  }

  revokeControl(): void {
    this.controlState = 'idle';
    this.inputInjector.stop();
    this.socket?.emit('control:revoke');
    this.sendToSetup('review:status', { status: 'connected', code: this.roomCode });
  }

  setROI(roi: { x: number; y: number; width: number; height: number }): void {
    this.inputInjector.setROI(roi);
  }

  sendChat(text: string): void {
    this.socket?.emit('chat:message', text);
  }

  getSocket(): Socket | null {
    return this.socket;
  }

  getRoomCode(): string | null {
    return this.roomCode;
  }

  private async startScreenShare(): Promise<void> {
    try {
      const { desktopCapturer } = require('electron');
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length > 0) {
        const sourceId = sources[0].id;
        console.log(`[Review] Got screen source: ${sourceId} — sending to setup renderer`);
        this.sendToSetup('review:screen-source', { sourceId });
      } else {
        console.error('[Review] No screen sources available');
      }
    } catch (err: any) {
      console.error('[Review] Failed to get screen sources:', err.message);
    }
  }

  private sendToSetup(channel: string, data: any): void {
    try {
      if (this.setupWindow && !this.setupWindow.isDestroyed()) {
        this.setupWindow.webContents.send(channel, data);
      }
    } catch (_) {}
  }

  private sendToOverlay(channel: string, data: any): void {
    try {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.webContents.send(channel, data);
      }
    } catch (_) {}
  }
}
