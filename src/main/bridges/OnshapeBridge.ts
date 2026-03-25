/**
 * OnshapeBridge — Onshape REST API Camera Bridge
 *
 * Onshape is browser-based, so there's no local COM/.exe bridge.
 * Instead, this bridge polls the Onshape REST API for the current
 * document's view state.
 *
 * Requirements:
 *   - Onshape API keys (access key + secret key) configured
 *   - Active document ID and workspace ID
 *
 * The bridge polls at ~10fps (API rate limits) and emits standardized
 * camera frames. View state comes from the Onshape AppElement / viewport API.
 */

import { CadBridge, CameraFrame, BridgeStatus } from './CadBridge';
import * as https from 'https';
import * as crypto from 'crypto';

const POLL_INTERVAL = 100; // ~10fps — Onshape API rate limits apply

export interface OnshapeConfig {
  accessKey: string;
  secretKey: string;
  documentId: string;
  workspaceId: string;
  elementId?: string;
  baseUrl?: string;
}

export class OnshapeBridge implements CadBridge {
  readonly name = 'Onshape';
  private pollTimer: NodeJS.Timeout | null = null;
  private _status: BridgeStatus = 'stopped';
  private frameCallback: ((frame: CameraFrame) => void) | null = null;
  private statusCallback: ((status: BridgeStatus, detail?: string) => void) | null = null;
  private config: OnshapeConfig | null = null;
  private frameCount = 0;

  get status(): BridgeStatus { return this._status; }

  /**
   * Set Onshape API configuration. Must be called before start().
   */
  setConfig(config: OnshapeConfig): void {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config) {
      this._status = 'error';
      this.statusCallback?.('error', 'Onshape API configuration not set. Call setConfig() first.');
      return;
    }

    this._status = 'connecting';
    this.statusCallback?.('connecting', 'Connecting to Onshape API...');

    // Test connection with a simple API call
    try {
      await this.testConnection();
      this._status = 'live';
      this.statusCallback?.('live', 'Connected to Onshape');
      this.startPolling();
    } catch (err: any) {
      this._status = 'error';
      this.statusCallback?.('error', `Onshape API error: ${err.message}`);
    }
  }

  stop(): void {
    this._status = 'stopped';
    this.statusCallback?.('stopped');
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  onFrame(callback: (frame: CameraFrame) => void): void {
    this.frameCallback = callback;
  }

  onStatus(callback: (status: BridgeStatus, detail?: string) => void): void {
    this.statusCallback = callback;
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const frame = await this.fetchViewState();
        if (frame) {
          this.frameCallback?.(frame);
          this.frameCount++;
          if (this.frameCount % 60 === 0) {
            console.log(`[OnshapeBridge] Streaming — frame ${this.frameCount}`);
          }
        }
      } catch (err: any) {
        if (this._status === 'live') {
          console.error('[OnshapeBridge] Poll error:', err.message);
        }
      }
    }, POLL_INTERVAL);
  }

  private async testConnection(): Promise<void> {
    const cfg = this.config!;
    const path = `/api/v6/documents/${cfg.documentId}`;
    const response = await this.apiRequest('GET', path);
    if (!response || response.error) {
      throw new Error(response?.message || 'Failed to connect to Onshape');
    }
  }

  private async fetchViewState(): Promise<CameraFrame | null> {
    const cfg = this.config!;

    // Fetch the document's current view state via the shaded views or camera endpoint
    // Onshape REST API: GET /api/v6/partstudios/d/{did}/w/{wid}/e/{eid}/shadedviews
    // This gives us the camera matrix for the current view
    const eid = cfg.elementId || '';
    if (!eid) {
      // Without an element ID, we can't get view state — return identity frame
      return {
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        scale: 1,
        panX: 0, panY: 0,
        viewportWidth: 1920, viewportHeight: 1080,
        dpi: 96, isZUp: true,
        timestamp: Date.now(),
      };
    }

    try {
      const path = `/api/v6/partstudios/d/${cfg.documentId}/w/${cfg.workspaceId}/e/${eid}/shadedviews`;
      const params = '?outputHeight=1080&outputWidth=1920&pixelSize=0.003&viewMatrix=';

      const response = await this.apiRequest('GET', path + params);

      if (response && response.images && response.images.length > 0) {
        // Extract view matrix if available in response
        const viewMatrix = response.viewMatrix || response.camera?.viewMatrix;

        if (viewMatrix && Array.isArray(viewMatrix) && viewMatrix.length >= 12) {
          return {
            rotation: [
              viewMatrix[0], viewMatrix[1], viewMatrix[2],
              viewMatrix[4], viewMatrix[5], viewMatrix[6],
              viewMatrix[8], viewMatrix[9], viewMatrix[10],
            ],
            scale: viewMatrix[3] || 1,
            panX: viewMatrix[7] || 0,
            panY: viewMatrix[11] || 0,
            viewportWidth: 1920,
            viewportHeight: 1080,
            dpi: 96,
            isZUp: true, // Onshape is Z-up
            timestamp: Date.now(),
          };
        }
      }
    } catch { /* fall through to default */ }

    // Return a default identity frame if we can't get camera data
    return {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: 1,
      panX: 0, panY: 0,
      viewportWidth: 1920, viewportHeight: 1080,
      dpi: 96, isZUp: true,
      timestamp: Date.now(),
    };
  }

  /**
   * Make an authenticated Onshape API request using API keys (HMAC).
   */
  private apiRequest(method: string, apiPath: string): Promise<any> {
    const cfg = this.config!;
    const baseUrl = cfg.baseUrl || 'https://cad.onshape.com';
    const url = new URL(apiPath, baseUrl);

    // Onshape API key authentication
    const nonce = crypto.randomBytes(12).toString('base64');
    const date = new Date().toUTCString();
    const contentType = 'application/json';

    // Build HMAC signature
    const stringToSign = [
      method.toLowerCase(),
      nonce,
      date,
      contentType,
      url.pathname + url.search,
    ].join('\n');

    const signature = crypto
      .createHmac('sha256', cfg.secretKey)
      .update(stringToSign, 'utf8')
      .digest('base64');

    const auth = `On ${cfg.accessKey}:HmacSHA256:${nonce}:${date}:${signature}`;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': contentType,
          'Accept': 'application/json',
          'Authorization': auth,
          'Date': date,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.end();
    });
  }
}
