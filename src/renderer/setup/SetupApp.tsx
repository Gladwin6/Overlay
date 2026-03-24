import React, { useState, useEffect, useCallback, useRef } from 'react';
import { IPC, CVTrackingStatus, CalibrationProfile, AlignmentState, ScreenRegion, ViewCubeResult } from '../../shared/types';
import { colors, spacing, radii, fonts } from '../../shared/design-tokens';
import { LOGO_SMALL_BASE64 } from '../../shared/logo';
import { RendererScreenCapture, CaptureRegions, CropPreviewCallback } from './RendererScreenCapture';

const { ipcRenderer } = window.require('electron');

const COLLAPSED_HEIGHT = 56;
const EXPANDED_WIDTH = 300;
const EXPANDED_HEIGHT = 640;

// ── Reusable Components ──────────────────────────────────────────────

function Section({ title, icon, expanded, onToggle, badge, children }: {
  title: string; icon: string; expanded: boolean; onToggle: () => void;
  badge?: string | null; children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: `1px solid rgba(0,0,0,0.06)` }}>
      <div onClick={onToggle} style={sty.sectionHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: '#999', transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>&#9654;</span>
          <SectionIcon name={icon} />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#1a1a1a' }}>{title}</span>
        </div>
        {badge && <span style={sty.badge}>{badge}</span>}
      </div>
      {expanded && <div style={{ padding: `0 ${spacing.lg}px ${spacing.md}px` }}>{children}</div>}
    </div>
  );
}

function SectionIcon({ name }: { name: string }) {
  const iconMap: Record<string, string> = {
    cube: '\u25A2', tag: '\u2691', radio: '\u25CE', save: '\u2630', eye: '\u25C9',
    settings: '\u2699', layers: '\u25A7', move: '\u21C6',
  };
  return <span style={{ fontSize: 14, color: '#999', width: 18, textAlign: 'center' }}>{iconMap[name] || '\u25A1'}</span>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: '#444' }}>{label}</span>
      <div onClick={onChange} style={{
        width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
        background: checked ? '#1a1a1a' : '#ddd', transition: 'background 0.2s',
        position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: checked ? 18 : 2,
          width: 16, height: 16, borderRadius: 8, background: '#fff',
          transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }} />
      </div>
    </div>
  );
}

function Btn({ children, primary, secondary, danger, disabled, onClick, style: extraStyle }: {
  children: React.ReactNode; primary?: boolean; secondary?: boolean; danger?: boolean;
  disabled?: boolean; onClick?: () => void; style?: React.CSSProperties;
}) {
  const base: React.CSSProperties = {
    padding: `${spacing.sm}px ${spacing.lg}px`, border: 'none', borderRadius: radii.md,
    fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    opacity: disabled ? 0.4 : 1, transition: 'opacity 0.15s', width: '100%',
  };
  if (primary) Object.assign(base, { background: colors.brandOrange, color: '#fff' });
  else if (secondary) Object.assign(base, { background: 'transparent', color: colors.brandOrange, border: `1px dashed ${colors.brandOrange}` });
  else if (danger) Object.assign(base, { background: colors.statusRed, color: '#fff' });
  else Object.assign(base, { background: '#f5f5f5', color: '#333', border: `1px solid ${colors.border}` });

  return <button onClick={disabled ? undefined : onClick} style={{ ...base, ...extraStyle }}>{children}</button>;
}

// ── Main Setup App ───────────────────────────────────────────────────

export function SetupApp() {
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const [gltfFile, setGltfFile] = useState<string | null>(null);
  const [trackingStatus, setTrackingStatus] = useState<CVTrackingStatus>({
    fps: 0, trackedPoints: 0, confidence: 0, isTracking: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [profiles, setProfiles] = useState<CalibrationProfile[]>([]);
  const [profileName, setProfileName] = useState('');
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [currentAlignment, setCurrentAlignment] = useState<AlignmentState>({
    positionX: 0, positionY: 0, positionZ: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0, scale: 1,
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    model: true, tracking: false, align: false, calibration: false, swbridge: false, debug: true, review: false,
  });

  // ROI (Region of Interest) state
  const [viewCubeRegion, setViewCubeRegion] = useState<ScreenRegion | null>(null);
  const [viewportRegion, setViewportRegion] = useState<ScreenRegion | null>(null);
  const [isDefiningROI, setIsDefiningROI] = useState(false);
  const [roiStep, setRoiStep] = useState<'idle' | 'viewcube' | 'viewport' | 'verify'>('idle');
  const [roiScreenshot, setRoiScreenshot] = useState<string | null>(null); // base64 data URL
  const [vcRotation, setVcRotation] = useState<ViewCubeResult | null>(null);
  const AXIS_SOURCES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
  type AxisSource = typeof AXIS_SOURCES[number];
  // Default to Z-up mapping (SolidWorks, eDrawings, CATIA)
  const [axisMapping, setAxisMapping] = useState<{ x: AxisSource; y: AxisSource; z: AxisSource }>({ x: '+x', y: '+z', z: '-y' });

  // Send default mapping to tracker on mount (ensures UI and tracker are in sync)
  useEffect(() => {
    ipcRenderer.send(IPC.AXIS_MAPPING, { x: '+x', y: '+z', z: '-y' });
  }, []);

  // Debug crop preview state
  const [debugVcPreview, setDebugVcPreview] = useState<string | null>(null);
  const [debugVpPreview, setDebugVpPreview] = useState<string | null>(null);
  const [debugVcSize, setDebugVcSize] = useState<{ width: number; height: number } | null>(null);
  const [debugVpSize, setDebugVpSize] = useState<{ width: number; height: number } | null>(null);

  const toggleSection = (key: string) => {
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // ── Panel Collapse/Expand ───────────────────────────────────────────

  const collapsePanel = useCallback(() => {
    setIsPanelCollapsed(true);
    ipcRenderer.send(IPC.SETUP_RESIZE, { width: EXPANDED_WIDTH, height: COLLAPSED_HEIGHT });
  }, []);

  const expandPanel = useCallback(() => {
    setIsPanelCollapsed(false);
    ipcRenderer.send(IPC.SETUP_RESIZE, { width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT });
  }, []);

  const togglePanel = useCallback(() => {
    if (isPanelCollapsed) expandPanel();
    else collapsePanel();
  }, [isPanelCollapsed, expandPanel, collapsePanel]);

  // ── IPC Listeners ──────────────────────────────────────────────────

  useEffect(() => {
    const onStatus = (_e: any, status: CVTrackingStatus) => setTrackingStatus(status);
    ipcRenderer.on(IPC.TRACKING_STATUS, onStatus);
    return () => { ipcRenderer.removeListener(IPC.TRACKING_STATUS, onStatus); };
  }, []);

  useEffect(() => {
    const onAlignment = (_e: any, a: AlignmentState) => setCurrentAlignment(a);
    ipcRenderer.on(IPC.ALIGNMENT_UPDATE, onAlignment);
    return () => { ipcRenderer.removeListener(IPC.ALIGNMENT_UPDATE, onAlignment); };
  }, []);

  useEffect(() => {
    const onGltf = (_e: any, data: { url: string; filename: string }) => {
      setGltfFile(data.filename);
      setIsLoading(false);
    };
    ipcRenderer.on(IPC.GLTF_DATA, onGltf);
    return () => { ipcRenderer.removeListener(IPC.GLTF_DATA, onGltf); };
  }, []);

  // Listen for collapse command from main (desktop switch)
  useEffect(() => {
    const onCollapse = () => {
      setIsPanelCollapsed(true);
      setOverlayVisible(false);
      ipcRenderer.send(IPC.SETUP_RESIZE, { width: EXPANDED_WIDTH, height: COLLAPSED_HEIGHT });
    };
    ipcRenderer.on(IPC.SETUP_COLLAPSE, onCollapse);
    return () => { ipcRenderer.removeListener(IPC.SETUP_COLLAPSE, onCollapse); };
  }, []);

  // Listen for view cube rotation updates
  useEffect(() => {
    const onVcRotation = (_e: any, result: ViewCubeResult) => setVcRotation(result);
    ipcRenderer.on(IPC.VIEWCUBE_ROTATION, onVcRotation);
    return () => { ipcRenderer.removeListener(IPC.VIEWCUBE_ROTATION, onVcRotation); };
  }, []);

  // Listen for ROI drawing trigger from main (transparent mode — no screenshot needed)
  useEffect(() => {
    const onScreenshot = (_e: any, _mode: string) => {
      setRoiScreenshot('transparent');
      setIsDefiningROI(true);
      setRoiStep('viewcube');
    };
    ipcRenderer.on(IPC.ROI_SCREENSHOT, onScreenshot);
    return () => { ipcRenderer.removeListener(IPC.ROI_SCREENSHOT, onScreenshot); };
  }, []);

  // ── Renderer-side screen capture (video stream) ─────────────────────
  const captureRef = useRef<RendererScreenCapture | null>(null);

  // ── Align drag pad ───────────────────────────────────────────────────
  const alignDragRef = useRef<{ button: number; lastX: number; lastY: number } | null>(null);

  const handleAlignPadMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    alignDragRef.current = { button: e.button, lastX: e.clientX, lastY: e.clientY };
  }, []);

  const handleAlignPadMouseMove = useCallback((e: React.MouseEvent) => {
    if (!alignDragRef.current) return;
    const dx = e.clientX - alignDragRef.current.lastX;
    const dy = e.clientY - alignDragRef.current.lastY;
    alignDragRef.current.lastX = e.clientX;
    alignDragRef.current.lastY = e.clientY;
    if (alignDragRef.current.button === 0 && !e.shiftKey) {
      ipcRenderer.send(IPC.ALIGNMENT_NUDGE, { rotationY: dx * 0.5, rotationX: dy * 0.5 });
    } else {
      ipcRenderer.send(IPC.ALIGNMENT_NUDGE, { positionX: dx * 2, positionY: dy * 2 });
    }
  }, []);

  const handleAlignPadMouseUp = useCallback(() => { alignDragRef.current = null; }, []);

  const handleAlignPadWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    ipcRenderer.send(IPC.ALIGNMENT_NUDGE, { scale: e.deltaY < 0 ? 1.04 : 0.96 });
  }, []);

  useEffect(() => {
    const onCaptureStart = (_e: any, sourceId: string, regions?: { viewCube: ScreenRegion; viewport: ScreenRegion }, displayBounds?: { x: number; y: number; width: number; height: number } | null) => {
      console.log('[SetupApp] CAPTURE_START received, sourceId:', sourceId, 'regions:', regions ? 'dual-mask' : 'legacy', 'displayOrigin:', displayBounds ? `(${displayBounds.x},${displayBounds.y})` : '(0,0)');
      // Stop any existing capture
      if (captureRef.current) {
        captureRef.current.stop();
      }
      captureRef.current = new RendererScreenCapture();
      // Set ROI regions + display bounds so the capture subtracts the correct display origin
      if (regions) {
        captureRef.current.setRegions(regions, displayBounds ?? undefined);
        // Wire up crop preview callback for debug UI
        captureRef.current.setCropPreviewCallback((vcUrl, vpUrl, vcSize, vpSize) => {
          setDebugVcPreview(vcUrl);
          setDebugVpPreview(vpUrl);
          setDebugVcSize(vcSize);
          setDebugVpSize(vpSize);
        });
      }
      captureRef.current.start(sourceId);
    };

    const onCaptureStop = () => {
      console.log('[SetupApp] CAPTURE_STOP received');
      if (captureRef.current) {
        captureRef.current.stop();
        captureRef.current = null;
      }
      // Clear debug previews
      setDebugVcPreview(null);
      setDebugVpPreview(null);
      setDebugVcSize(null);
      setDebugVpSize(null);
      // If review session is active but lost the stream, the reviewStreamRef
      // is independent and keeps the WebRTC connection alive
    };

    ipcRenderer.on(IPC.CAPTURE_START, onCaptureStart);
    ipcRenderer.on(IPC.CAPTURE_STOP, onCaptureStop);

    return () => {
      ipcRenderer.removeListener(IPC.CAPTURE_START, onCaptureStart);
      ipcRenderer.removeListener(IPC.CAPTURE_STOP, onCaptureStop);
      // Cleanup on unmount
      if (captureRef.current) {
        captureRef.current.stop();
        captureRef.current = null;
      }
    };
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────

  // Electron's native file dialog crashes when navigating to Downloads folder.
  // Use drag-and-drop + manual path input as alternatives.
  const [showPathInput, setShowPathInput] = useState(false);
  const [pathInputValue, setPathInputValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const loadGltfFromPath = useCallback(async (filePath: string) => {
    const trimmed = filePath.trim().replace(/^"(.*)"$/, '$1'); // strip quotes
    if (!trimmed) return;
    const ext = trimmed.toLowerCase();
    if (!ext.endsWith('.glb') && !ext.endsWith('.gltf')) {
      console.warn('[SetupApp] Not a GLTF/GLB file:', trimmed);
      return;
    }
    setIsLoading(true);
    setShowPathInput(false);
    setPathInputValue('');
    console.log('[SetupApp] Loading file:', trimmed);
    const result = await ipcRenderer.invoke(IPC.GLTF_LOAD, trimmed);
    if (!result) setIsLoading(false);
  }, []);

  const handleLoadGltf = useCallback(() => {
    setShowPathInput(prev => !prev);
  }, []);

  const handleBrowseNative = useCallback(async () => {
    setIsLoading(true);
    const result = await ipcRenderer.invoke(IPC.GLTF_LOAD);
    if (!result) setIsLoading(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      loadGltfFromPath((file as any).path || file.name);
    }
  }, [loadGltfFromPath]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Hide overlay during drag so it doesn't intercept drop events
  // (overlay is at screen-saver z-level and captures drag before setup window)
  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      ipcRenderer.send('overlay:hide-for-drag', true);
    };
    const onDragEnd = () => {
      ipcRenderer.send('overlay:hide-for-drag', false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setTimeout(() => ipcRenderer.send('overlay:hide-for-drag', false), 200);
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragend', onDragEnd);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragleave', (e) => {
      // Only restore if leaving the window entirely
      if (!e.relatedTarget && e.clientX === 0 && e.clientY === 0) {
        ipcRenderer.send('overlay:hide-for-drag', false);
      }
    });
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragend', onDragEnd);
      document.removeEventListener('drop', onDrop);
    };
  }, []);

  const handleStartTracking = useCallback(() => { ipcRenderer.send(IPC.TRACKING_START); }, []);
  const handleStopTracking = useCallback(() => { ipcRenderer.send(IPC.TRACKING_STOP); }, []);

  // SolidWorks COM bridge
  const [swBridgeStatus, setSwBridgeStatus] = useState<string>('stopped');
  const [swBridgeDetail, setSwBridgeDetail] = useState<string>('');

  // Model pose tracking status
  const [modelPoseStatus, setModelPoseStatus] = useState<string>('');

  // Review Session
  const [reviewStatus, setReviewStatus] = useState<string>('idle'); // idle | waiting | connected | controlling | disconnected
  const [roomCode, setRoomCode] = useState<string>('');
  const [chatMessages, setChatMessages] = useState<{author: string, text: string, timestamp: number}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [controlRequested, setControlRequested] = useState(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const reviewStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const [micMuted, setMicMuted] = useState(false);

  // Alignment score
  const [alignScore, setAlignScore] = useState<{ grade: string; overlapPercent: number; meanDistance: number; offsetX: number; offsetY: number } | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<{ status: string; cadName: string; detail?: string } | null>(null);

  useEffect(() => {
    const handler = (_e: any, status: string, detail: string) => {
      setSwBridgeStatus(status);
      setSwBridgeDetail(detail || '');
    };
    ipcRenderer.on(IPC.SW_BRIDGE_STATUS, handler);
    return () => { ipcRenderer.removeListener(IPC.SW_BRIDGE_STATUS, handler); };
  }, []);

  // Alignment score + bridge status listeners
  useEffect(() => {
    const onScore = (_e: any, score: any) => setAlignScore(score);
    const onBridge = (_e: any, data: any) => setBridgeStatus(data);
    ipcRenderer.on('alignment:score', onScore);
    ipcRenderer.on('bridge:status', onBridge);
    return () => {
      ipcRenderer.removeListener('alignment:score', onScore);
      ipcRenderer.removeListener('bridge:status', onBridge);
    };
  }, []);

  useEffect(() => {
    const onRoomCode = (_e: any, code: string) => setRoomCode(code);
    const onStatus = (_e: any, data: any) => {
      setReviewStatus(data.status);
      if (data.status !== 'controlling') setControlRequested(false);
    };
    const onControlRequest = () => setControlRequested(true);
    const onChatMessage = (_e: any, msg: any) => {
      setChatMessages(prev => [...prev, msg]);
    };

    ipcRenderer.on('review:room-code', onRoomCode);
    ipcRenderer.on('review:status', onStatus);
    ipcRenderer.on('review:control-request', onControlRequest);
    ipcRenderer.on('review:chat-message', onChatMessage);

    // WebRTC: when vendor joins, create offer with screen capture stream
    const onPeerJoined = async () => {
      // Always use the independent review stream (not tracking capture — it can be stopped)
      let stream = reviewStreamRef.current;

      if (!stream) {
        console.log('[Review] No capture — starting screen capture now');
        try {
          // Use getDisplayMedia (auto-approved by main process handler)
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } },
            audio: false,
          });
          reviewStreamRef.current = stream;
          console.log('[Review] Screen capture started via getDisplayMedia');
        } catch (err) {
          console.error('[Review] Screen capture failed:', err);
          // Fallback to desktopCapturer
          try {
            const { desktopCapturer } = (window as any).require('electron');
            const sources = await desktopCapturer.getSources({ types: ['screen'] });
            if (sources.length > 0) {
              stream = await navigator.mediaDevices.getUserMedia({
                video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sources[0].id, maxWidth: 1920, maxHeight: 1080 } } as any,
                audio: false,
              });
              reviewStreamRef.current = stream;
              console.log('[Review] Screen capture started via desktopCapturer fallback');
            }
          } catch (err2) {
            console.error('[Review] Both capture methods failed:', err2);
            return;
          }
        }
      }

      // Clean up any existing peer connection
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      peerConnectionRef.current = pc;

      // Add screen capture tracks to the connection
      if (!stream) { console.error('[Review] No stream available for WebRTC'); return; }
      stream.getTracks().forEach(track => pc.addTrack(track, stream!));

      // Also add microphone audio if available
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        micStream.getAudioTracks().forEach(track => pc.addTrack(track, micStream));
        micStreamRef.current = micStream;
      } catch (e) {
        console.warn('[Review] Mic not available:', e);
      }

      // Send ICE candidates to vendor via server
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ipcRenderer.send('signal:ice', e.candidate.toJSON());
        }
      };

      // Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ipcRenderer.send('signal:offer', { type: offer.type, sdp: offer.sdp });
      console.log('[Review] WebRTC offer sent');
    };

    // Handle answer from vendor
    const onSignalAnswer = async (_e: any, answer: any) => {
      const pc = peerConnectionRef.current;
      if (pc && pc.signalingState !== 'closed') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('[Review] WebRTC answer received');
      }
    };

    // Handle ICE candidates from vendor
    const onSignalIce = async (_e: any, candidate: any) => {
      const pc = peerConnectionRef.current;
      if (pc && pc.signalingState !== 'closed') {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (e) { /* ignore */ }
      }
    };

    // Receive screen sourceId from main process — capture and create WebRTC offer
    const onScreenSource = async (_e: any, data: { sourceId: string }) => {
      console.log('[Review] Received screen sourceId:', data.sourceId);
      if (!reviewStreamRef.current) {
        try {
          // Use Electron's chromeMediaSource with the sourceId from main process
          reviewStreamRef.current = await navigator.mediaDevices.getUserMedia({
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: data.sourceId,
                maxWidth: 1920,
                maxHeight: 1080,
              },
            } as any,
            audio: false,
          });
          console.log('[Review] Screen capture OK, triggering WebRTC offer');
        } catch (err) {
          console.error('[Review] Screen capture FAILED:', err);
          return;
        }
      }
      // Now create the WebRTC offer with the stream
      onPeerJoined();
    };

    ipcRenderer.on('room:peer-joined', onPeerJoined);
    ipcRenderer.on('review:screen-source', onScreenSource);
    ipcRenderer.on('signal:answer', onSignalAnswer);
    ipcRenderer.on('signal:ice', onSignalIce);

    return () => {
      ipcRenderer.removeListener('review:room-code', onRoomCode);
      ipcRenderer.removeListener('review:status', onStatus);
      ipcRenderer.removeListener('review:control-request', onControlRequest);
      ipcRenderer.removeListener('review:chat-message', onChatMessage);
      ipcRenderer.removeListener('room:peer-joined', onPeerJoined);
      ipcRenderer.removeListener('review:screen-source', onScreenSource);
      ipcRenderer.removeListener('signal:answer', onSignalAnswer);
      ipcRenderer.removeListener('signal:ice', onSignalIce);
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handler = (_e: any, status: string) => {
      setModelPoseStatus(status);
    };
    ipcRenderer.on(IPC.MODELPOSE_STATUS, handler);
    return () => { ipcRenderer.removeListener(IPC.MODELPOSE_STATUS, handler); };
  }, []);

  const handleSwBridgeToggle = useCallback(() => {
    if (swBridgeStatus === 'stopped' || swBridgeStatus === 'error') {
      ipcRenderer.send(IPC.SW_BRIDGE_START);
    } else {
      ipcRenderer.send(IPC.SW_BRIDGE_STOP);
    }
  }, [swBridgeStatus]);

  const handleToggleOverlay = useCallback(() => {
    const next = !overlayVisible;
    setOverlayVisible(next);
    ipcRenderer.send(IPC.OVERLAY_TOGGLE, next);
  }, [overlayVisible]);

  const [isAligning, setIsAligning] = useState(false);

  const nudge = useCallback((delta: Record<string, number>) => {
    ipcRenderer.send(IPC.ALIGNMENT_NUDGE, delta);
  }, []);

  const handleResetAlignment = useCallback(() => { ipcRenderer.send(IPC.ALIGNMENT_RESET); }, []);

  const handleToggleAlignMode = useCallback(() => {
    const next = !isAligning;
    setIsAligning(next);
    ipcRenderer.send(IPC.OVERLAY_ALIGN_MODE, next);
  }, [isAligning]);

  // Calibration
  const loadProfiles = useCallback(async () => {
    const list = await ipcRenderer.invoke(IPC.CALIBRATION_LIST);
    setProfiles(list || []);
  }, []);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);

  const handleSaveProfile = useCallback(async () => {
    const name = profileName.trim() || `Profile ${profiles.length + 1}`;
    await ipcRenderer.invoke(IPC.CALIBRATION_SAVE, name);
    setProfileName('');
    loadProfiles();
  }, [profileName, profiles.length, loadProfiles]);

  const handleApplyProfile = useCallback((id: string) => { ipcRenderer.send(IPC.CALIBRATION_APPLY, id); }, []);

  const handleDeleteProfile = useCallback(async (id: string) => {
    await ipcRenderer.invoke(IPC.CALIBRATION_DELETE, id);
    loadProfiles();
  }, [loadProfiles]);

  // ── ROI Definition Handlers ──────────────────────────────────────────

  const handleDefineROI = useCallback(() => {
    ipcRenderer.send(IPC.ROI_DEFINE);
  }, []);

  const handleROIRegionDefined = useCallback((region: ScreenRegion) => {
    if (roiStep === 'viewcube') {
      setViewCubeRegion(region);
      setRoiStep('viewport');
    } else if (roiStep === 'viewport') {
      setViewportRegion(region);
      setRoiStep('verify');
      // Send regions to main for verification overlay
      ipcRenderer.send(IPC.ROI_VERIFY, {
        viewCube: viewCubeRegion,
        viewport: region,
      });
    }
  }, [roiStep, viewCubeRegion]);

  const handleROIConfirm = useCallback(() => {
    if (viewCubeRegion && viewportRegion) {
      ipcRenderer.send(IPC.ROI_REGIONS, {
        viewCube: viewCubeRegion,
        viewport: viewportRegion,
      });
    }
    setIsDefiningROI(false);
    setRoiStep('idle');
    setRoiScreenshot(null);
  }, [viewCubeRegion, viewportRegion]);

  const handleROICancel = useCallback(() => {
    setIsDefiningROI(false);
    setRoiStep('idle');
    setRoiScreenshot(null);
    setViewCubeRegion(null);
    setViewportRegion(null);
    // Tell main to restore windows and clear verification overlay
    ipcRenderer.send(IPC.ROI_CANCEL);
  }, []);

  const hasROI = viewCubeRegion !== null && viewportRegion !== null;

  // ── Render ─────────────────────────────────────────────────────────

  // Collapsed view — just logo + title + expand chevron
  if (isPanelCollapsed) {
    return (
      <div style={{
        ...sty.container, height: COLLAPSED_HEIGHT,
        cursor: 'pointer', overflow: 'hidden',
      }} onClick={expandPanel}>
        <div style={{
          ...sty.header, borderBottom: 'none',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LogoSmall />
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1a1a', letterSpacing: 0.3 }}>Hanomi Platform</span>
              <span style={{ fontSize: 10, color: '#999', marginLeft: 6 }}>v1.0</span>
            </div>
          </div>
          <div style={{
            ...sty.iconBtn,
            fontSize: 12, color: '#999', transform: 'rotate(90deg)',
          }}>
            &#9654;
          </div>
        </div>
      </div>
    );
  }

  // ── ROI Drawing Overlay ───────────────────────────────────────────
  if (isDefiningROI && roiScreenshot) {
    return (
      <ROIDrawingOverlay
        screenshot={roiScreenshot}
        step={roiStep}
        viewCubeRegion={viewCubeRegion}
        viewportRegion={viewportRegion}
        onRegionDefined={handleROIRegionDefined}
        onConfirm={handleROIConfirm}
        onCancel={handleROICancel}
      />
    );
  }

  // Expanded view — full panel
  return (
    <div style={sty.container}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div style={sty.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <LogoSmall />
          <div>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1a1a', letterSpacing: 0.3 }}>Hanomi Platform</span>
            <span style={{ fontSize: 10, color: '#999', marginLeft: 6 }}>v1.0</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <div onClick={handleToggleOverlay} style={sty.iconBtn} title="Toggle overlay">
            {overlayVisible ? '\u25C9' : '\u25CB'}
          </div>
          <div onClick={collapsePanel} style={{
            ...sty.iconBtn,
            fontSize: 12, color: '#999', transform: 'rotate(-90deg)',
          }} title="Collapse panel">
            &#9654;
          </div>
          <div onClick={() => ipcRenderer.send('app:quit')} style={{
            ...sty.iconBtn,
            fontSize: 13, color: '#999',
          }} title="Quit"
            onMouseEnter={e => (e.currentTarget.style.color = '#e53e3e')}
            onMouseLeave={e => (e.currentTarget.style.color = '#999')}
          >
            ✕
          </div>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────── */}
      <div style={sty.content}>

        {/* Model Section */}
        <Section title="3D Model" icon="cube" expanded={expanded.model} onToggle={() => toggleSection('model')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
            {gltfFile && (
              <div style={sty.fileChip}>
                <span style={{ fontSize: 12, color: '#1a1a1a', fontWeight: 500 }}>{gltfFile}</span>
                <span style={{ fontSize: 10, color: colors.statusGreen, fontWeight: 600 }}>loaded</span>
              </div>
            )}
            <Toggle label="Overlay" checked={overlayVisible} onChange={handleToggleOverlay} />
            {/* Drop zone for GLB/GLTF files */}
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={handleLoadGltf}
              style={{
                border: `2px dashed ${isDragOver ? colors.brandOrange : '#ccc'}`,
                borderRadius: radii.md,
                padding: `${spacing.md}px`,
                textAlign: 'center',
                cursor: 'pointer',
                background: isDragOver ? 'rgba(255,107,53,0.08)' : 'transparent',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: isDragOver ? colors.brandOrange : '#555' }}>
                {isLoading ? 'Loading...' : isDragOver ? 'Drop here' : 'Drop .glb/.gltf file here'}
              </div>
            </div>
            <Btn primary onClick={handleBrowseNative} disabled={isLoading}>
              {isLoading ? 'Loading...' : gltfFile ? 'Load Different Model' : 'Browse...'}
            </Btn>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                type="text"
                placeholder="C:\path\to\model.glb"
                value={pathInputValue}
                onChange={(e) => setPathInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadGltfFromPath(pathInputValue); }}
                style={{
                  flex: 1, padding: '6px 8px', fontSize: 11, border: `1px solid ${colors.border}`,
                  borderRadius: radii.sm, outline: 'none', fontFamily: fonts.mono,
                }}
              />
              <Btn primary onClick={() => loadGltfFromPath(pathInputValue)} style={{ width: 'auto', padding: '6px 10px' }}>
                Load
              </Btn>
            </div>
          </div>
        </Section>

        {/* Tracking Section */}
        <Section title="Tracking" icon="radio" expanded={expanded.tracking}
          onToggle={() => toggleSection('tracking')}
          badge={trackingStatus.isTracking ? 'ON' : hasROI ? 'ROI' : null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
            <div style={{ fontSize: 11, color: '#999' }}>
              {hasROI
                ? 'Dual-mask tracking: view cube (rotation) + CAD region (pan/zoom).'
                : 'Define tracking regions first, then start tracking.'}
            </div>

            {/* ROI Definition */}
            {!trackingStatus.isTracking && (
              <>
                <Btn secondary={hasROI} primary={!hasROI} onClick={handleDefineROI} disabled={!gltfFile}>
                  {hasROI ? 'Redefine Regions' : 'Define Tracking Regions'}
                </Btn>
                {hasROI && (
                  <div style={{ fontSize: 9, fontFamily: fonts.mono, color: '#aaa', lineHeight: 1.6 }}>
                    <div>ViewCube: {viewCubeRegion!.width}x{viewCubeRegion!.height} @ ({viewCubeRegion!.x},{viewCubeRegion!.y})</div>
                    <div>CAD Region: {viewportRegion!.width}x{viewportRegion!.height} @ ({viewportRegion!.x},{viewportRegion!.y})</div>
                  </div>
                )}
              </>
            )}

            {/* Start/stop toggle */}
            {!trackingStatus.isTracking ? (
              <Btn primary onClick={handleStartTracking} disabled={!gltfFile || !hasROI}>
                Start Tracking
              </Btn>
            ) : (
              <Btn danger onClick={handleStopTracking}>Stop Tracking</Btn>
            )}

            {/* Model pose tracking status */}
            {modelPoseStatus && (
              <div style={{
                padding: '4px 8px',
                fontSize: 10,
                color: modelPoseStatus === 'ready' ? '#4caf50' : '#ff9800',
                background: modelPoseStatus === 'ready' ? '#e8f5e9' : '#fff3e0',
                borderRadius: 4,
                marginTop: 4,
              }}>
                Model Tracking: {modelPoseStatus === 'ready' ? 'LIVE' : 'building database...'}
              </div>
            )}

            {/* Live diagnostics */}
            {trackingStatus.isTracking && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={sty.statusRow}>
                  <span style={{
                    ...sty.statusDot,
                    background: trackingStatus.confidence > 0.3 ? colors.statusGreen
                      : trackingStatus.confidence > 0.1 ? colors.brandOrange
                      : colors.statusRed,
                  }} />
                  <span>{trackingStatus.fps} fps</span>
                  <span style={{ color: '#999' }}>|</span>
                  <span>{trackingStatus.trackedPoints} pts</span>
                  <span style={{ color: '#999' }}>|</span>
                  <span>{(trackingStatus.confidence * 100).toFixed(0)}%</span>
                </div>
                {/* Confidence bar */}
                <div style={{ height: 3, borderRadius: 2, background: '#eee', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    width: `${Math.min(100, trackingStatus.confidence * 100)}%`,
                    background: trackingStatus.confidence > 0.3 ? colors.statusGreen
                      : trackingStatus.confidence > 0.1 ? colors.brandOrange
                      : colors.statusRed,
                    transition: 'width 0.3s',
                  }} />
                </div>
                {/* View cube rotation (absolute) */}
                {vcRotation && (
                  <div style={{ fontSize: 9, fontFamily: fonts.mono, color: '#aaa', lineHeight: 1.4 }}>
                    VC rot({vcRotation.rotationX.toFixed(1)}, {vcRotation.rotationY.toFixed(1)}, {vcRotation.rotationZ.toFixed(1)})
                    {' '}[{vcRotation.strategy}] {(vcRotation.confidence * 100).toFixed(0)}%
                  </div>
                )}
                {/* Current alignment values */}
                <div style={{ fontSize: 9, fontFamily: fonts.mono, color: '#aaa', lineHeight: 1.4 }}>
                  rot({currentAlignment.rotationX.toFixed(1)}, {currentAlignment.rotationY.toFixed(1)})
                  {' '}pos({currentAlignment.positionX.toFixed(0)}, {currentAlignment.positionY.toFixed(0)})
                  {' '}s={currentAlignment.scale.toFixed(2)}
                </div>
                {/* Frame diff diagnostic — shows if screen captures are changing */}
                <div style={{
                  fontSize: 9, fontFamily: fonts.mono, lineHeight: 1.4,
                  color: (trackingStatus.frameDiff || 0) === 0 ? colors.statusRed : '#aaa',
                }}>
                  frame diff: {(trackingStatus.frameDiff || 0).toLocaleString()}
                  {(trackingStatus.frameDiff || 0) === 0 && ' (FROZEN!)'}
                </div>
              </div>
            )}

            {/* Alignment Score HUD */}
            {alignScore && (
              <div style={{
                marginTop: 8, padding: '8px 10px', borderRadius: 6,
                background: alignScore.grade === 'perfect' ? 'rgba(76,175,80,0.15)' :
                            alignScore.grade === 'good' ? 'rgba(139,195,74,0.15)' :
                            alignScore.grade === 'fair' ? 'rgba(255,152,0,0.15)' :
                            'rgba(244,67,54,0.15)',
                border: `1px solid ${
                  alignScore.grade === 'perfect' ? 'rgba(76,175,80,0.4)' :
                  alignScore.grade === 'good' ? 'rgba(139,195,74,0.4)' :
                  alignScore.grade === 'fair' ? 'rgba(255,152,0,0.4)' :
                  'rgba(244,67,54,0.4)'
                }`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                    color: alignScore.grade === 'perfect' ? '#4CAF50' :
                           alignScore.grade === 'good' ? '#8BC34A' :
                           alignScore.grade === 'fair' ? '#FF9800' : '#F44336'
                  }}>
                    Alignment: {alignScore.grade}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: fonts.mono, color: '#888' }}>
                    {alignScore.overlapPercent}% overlap
                  </span>
                </div>
                <div style={{ fontSize: 9, fontFamily: fonts.mono, color: '#aaa', lineHeight: 1.5 }}>
                  mean dist: {alignScore.meanDistance}px · offset: ({alignScore.offsetX}, {alignScore.offsetY})px
                </div>
              </div>
            )}

            {/* Bridge Auto-Detection Status */}
            {bridgeStatus && (
              <div style={{ marginTop: 6, fontSize: 10, fontFamily: fonts.mono, color: bridgeStatus.status === 'live' ? '#4CAF50' : '#888' }}>
                Bridge: {bridgeStatus.cadName} — {bridgeStatus.status}
                {bridgeStatus.detail && ` (${bridgeStatus.detail})`}
              </div>
            )}
          </div>
        </Section>

        {/* SolidWorks COM Bridge Section */}
        <Section title="SolidWorks Bridge" icon="settings" expanded={expanded.swbridge}
          onToggle={() => toggleSection('swbridge')}
          badge={swBridgeStatus === 'live' ? 'LIVE' : swBridgeStatus === 'error' ? 'ERR' : null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
            <div style={{ fontSize: 11, color: '#999' }}>
              {swBridgeStatus === 'stopped'       && 'Reads exact camera from SolidWorks — pixel-perfect overlay.'}
              {swBridgeStatus === 'launching'     && 'Launching SwBridge.exe...'}
              {swBridgeStatus === 'connecting_pipe' && 'Connecting to bridge pipe...'}
              {swBridgeStatus === 'waiting_sw'    && 'Waiting for SolidWorks to open...'}
              {swBridgeStatus === 'live'          && 'Live — reading SolidWorks camera at 60 fps.'}
              {swBridgeStatus === 'error'         && (swBridgeDetail || 'Bridge error. See console.')}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <div style={{
                width: 8, height: 8, borderRadius: 4, flexShrink: 0,
                background: swBridgeStatus === 'live'  ? colors.statusGreen
                          : swBridgeStatus === 'error' ? colors.statusRed
                          : swBridgeStatus === 'stopped' ? '#ccc'
                          : colors.brandOrange,
              }} />
              <span style={{ fontSize: 11, color: '#666', flex: 1 }}>{swBridgeStatus}</span>
            </div>
            <Btn
              primary={swBridgeStatus === 'stopped' || swBridgeStatus === 'error'}
              danger={swBridgeStatus === 'live' || swBridgeStatus === 'waiting_sw' || swBridgeStatus === 'launching' || swBridgeStatus === 'connecting_pipe'}
              onClick={handleSwBridgeToggle}
              disabled={!gltfFile}
            >
              {swBridgeStatus === 'stopped' || swBridgeStatus === 'error'
                ? 'Connect SolidWorks'
                : 'Disconnect'}
            </Btn>
            {swBridgeStatus === 'error' && swBridgeDetail.includes('not found') && (
              <div style={{ fontSize: 10, color: colors.statusRed, lineHeight: 1.4 }}>
                Build the bridge first: open PowerShell in sw-bridge/ and run <code>.\build.ps1</code>
              </div>
            )}
          </div>
        </Section>

        {/* Debug Section — live crop previews + axis detection */}
        {hasROI && (
          <Section title="Debug" icon="eye" expanded={expanded.debug}
            onToggle={() => toggleSection('debug')}
            badge={debugVcPreview ? 'LIVE' : null}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
              {/* Axis mapping controls */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* Per-axis cycle buttons */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: '#888', marginRight: 2 }}>Map:</span>
                  {(['x', 'y', 'z'] as const).map(axis => {
                    const src = axisMapping[axis];
                    const srcAxis = src[1]; // 'x','y','z'
                    const isNeg = src[0] === '-';
                    const axisColor = srcAxis === 'x' ? '#c00' : srcAxis === 'y' ? '#070' : '#00c';
                    const axisBg = srcAxis === 'x' ? '#fee' : srcAxis === 'y' ? '#efe' : '#eef';
                    return (
                      <button
                        key={axis}
                        onClick={() => {
                          const idx = AXIS_SOURCES.indexOf(src);
                          const nextSrc = AXIS_SOURCES[(idx + 1) % AXIS_SOURCES.length];
                          const next = { ...axisMapping, [axis]: nextSrc };
                          setAxisMapping(next);
                          ipcRenderer.send(IPC.AXIS_MAPPING, next);
                        }}
                        title={`Overlay ${axis.toUpperCase()} ← detected ${src.toUpperCase()} (click to cycle)`}
                        style={{
                          padding: '2px 6px', fontSize: 10, fontWeight: 600, borderRadius: 4,
                          cursor: 'pointer', border: '1px solid',
                          background: axisBg, color: axisColor, borderColor: axisColor,
                          minWidth: 42, textAlign: 'center',
                        }}
                      >
                        {axis.toUpperCase()}:{isNeg ? '-' : '+'}{srcAxis.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
                {/* Preset buttons */}
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => {
                      const m = { x: '+x' as AxisSource, y: '+y' as AxisSource, z: '+z' as AxisSource };
                      setAxisMapping(m);
                      ipcRenderer.send(IPC.AXIS_MAPPING, m);
                    }}
                    style={{
                      padding: '1px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                      border: '1px solid #ddd', background: '#f5f5f5', color: '#666',
                    }}
                  >Default</button>
                  <button
                    onClick={() => {
                      const m = { x: '+x' as AxisSource, y: '+z' as AxisSource, z: '-y' as AxisSource };
                      setAxisMapping(m);
                      ipcRenderer.send(IPC.AXIS_MAPPING, m);
                    }}
                    style={{
                      padding: '1px 6px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                      border: '1px solid #ddd', background: '#f5f5f5', color: '#666',
                    }}
                  >Z-up</button>
                </div>
              </div>
              {debugVcPreview ? (
                <>
                  {/* View Cube crop + Overlay orientation side by side */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(0,150,255,0.9)', marginBottom: 4 }}>
                        View Cube {debugVcSize && <span style={{ fontWeight: 400, fontFamily: fonts.mono }}>({debugVcSize.width}&times;{debugVcSize.height})</span>}
                      </div>
                      <VCCropWithAxes
                        imageSrc={debugVcPreview}
                        axes={vcRotation?.axes || null}
                        imageWidth={debugVcSize?.width || 150}
                        imageHeight={debugVcSize?.height || 150}
                      />
                    </div>
                    {vcRotation && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, color: '#666', marginBottom: 4 }}>
                          Overlay
                        </div>
                        <DebugOrientationCube
                          rotationX={vcRotation.rotationX}
                          rotationY={vcRotation.rotationY}
                          rotationZ={vcRotation.rotationZ}
                          axes={vcRotation.axes}
                        />
                      </div>
                    )}
                  </div>

                  {/* View Cube axis detection info */}
                  {vcRotation && (
                    <div style={{
                      fontSize: 9, fontFamily: fonts.mono, color: '#888', lineHeight: 1.6,
                      background: '#f5f5f5', borderRadius: radii.sm, padding: '4px 6px',
                    }}>
                      <div style={{ fontWeight: 600, color: '#555', marginBottom: 2 }}>
                        VC: [{vcRotation.strategy}] {(vcRotation.confidence * 100).toFixed(0)}% conf
                      </div>
                      <div>
                        rot X={vcRotation.rotationX.toFixed(1)}&deg; Y={vcRotation.rotationY.toFixed(1)}&deg; Z={vcRotation.rotationZ.toFixed(1)}&deg;
                      </div>
                      {vcRotation.axes && (
                        <>
                          <div style={{ marginTop: 2 }}>
                            <span style={{ color: '#e00' }}>R:{vcRotation.axes.pixelCounts.red || 0}px</span>
                            {' '}<span style={{ color: '#0a0' }}>G:{vcRotation.axes.pixelCounts.green || 0}px</span>
                            {' '}<span style={{ color: '#06f' }}>B:{vcRotation.axes.pixelCounts.blue || 0}px</span>
                          </div>
                          <div>
                            X:{vcRotation.axes.x ? `[${vcRotation.axes.x[0].toFixed(2)},${vcRotation.axes.x[1].toFixed(2)}]` : 'none'}
                            {' '}Y:{vcRotation.axes.y ? `[${vcRotation.axes.y[0].toFixed(2)},${vcRotation.axes.y[1].toFixed(2)}]` : 'none'}
                            {' '}Z:{vcRotation.axes.z ? `[${vcRotation.axes.z[0].toFixed(2)},${vcRotation.axes.z[1].toFixed(2)}]` : 'none'}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* CAD Region crop preview */}
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(0,200,80,0.9)', marginTop: 4 }}>
                    CAD Region {debugVpSize && <span style={{ fontWeight: 400, fontFamily: fonts.mono }}>({debugVpSize.width}&times;{debugVpSize.height})</span>}
                  </div>
                  <img src={debugVpPreview!} alt="VP crop" style={{
                    width: '100%', height: 'auto', borderRadius: radii.sm,
                    border: '1px solid rgba(0,200,80,0.3)',
                  }} />

                  {/* Region coordinates */}
                  <div style={{ fontSize: 9, fontFamily: fonts.mono, color: '#aaa', lineHeight: 1.6 }}>
                    <div>VC: {viewCubeRegion!.width}x{viewCubeRegion!.height} @ ({viewCubeRegion!.x},{viewCubeRegion!.y})</div>
                    <div>CAD: {viewportRegion!.width}x{viewportRegion!.height} @ ({viewportRegion!.x},{viewportRegion!.y})</div>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: '#999' }}>
                  Start tracking to see live crop previews.
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Align Section */}
        <Section title="Align" icon="move" expanded={expanded.align} onToggle={() => toggleSection('align')}
          badge={isAligning ? 'ACTIVE' : null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
            <Btn primary={!isAligning} danger={isAligning} onClick={handleToggleAlignMode} disabled={!gltfFile}>
              {isAligning ? 'Done Aligning' : 'Start Aligning'}
            </Btn>

            {isAligning && (
              <>
                {/* Drag pad — drag here to align the overlay */}
                <div
                  onMouseDown={handleAlignPadMouseDown}
                  onMouseMove={handleAlignPadMouseMove}
                  onMouseUp={handleAlignPadMouseUp}
                  onMouseLeave={handleAlignPadMouseUp}
                  onWheel={handleAlignPadWheel}
                  onContextMenu={e => e.preventDefault()}
                  style={{
                    height: 100, borderRadius: radii.md, cursor: 'move',
                    background: 'linear-gradient(135deg, rgba(0,217,255,0.08) 0%, rgba(0,100,200,0.12) 100%)',
                    border: '1px dashed rgba(0,217,255,0.4)',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 4,
                    userSelect: 'none',
                  }}
                >
                  <span style={{ fontSize: 18, opacity: 0.5 }}>&#8645;</span>
                  <span style={{ fontSize: 10, color: 'rgba(0,217,255,0.8)', fontWeight: 600 }}>Drag to rotate</span>
                  <span style={{ fontSize: 9, color: '#aaa' }}>Shift+drag to pan · Scroll to zoom</span>
                </div>
              </>
            )}

            {/* Scale slider — drag to match overlay size to SolidWorks model */}
            <div style={{ fontSize: 10, color: '#bbb', marginTop: 4 }}>
              Scale &nbsp;<span style={{ color: '#00d9ff', fontWeight: 700 }}>{currentAlignment.scale.toFixed(3)}×</span>
            </div>
            <input
              type="range" min="0.02" max="5" step="0.01"
              value={currentAlignment.scale}
              onChange={e => {
                const s = parseFloat(e.target.value);
                const factor = s / currentAlignment.scale;
                nudge({ scale: factor });
              }}
              style={{ width: '100%', accentColor: '#00d9ff', cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#666', marginTop: -4 }}>
              <span>0.02×</span><span>Small</span><span>1×</span><span>Large</span><span>5×</span>
            </div>

            {/* Pan buttons — coarse (50px) and fine (5px) */}
            <div style={{ fontSize: 10, color: '#bbb', marginTop: 6 }}>Position</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 3, textAlign: 'center' }}>
              <div />
              <div style={{ display: 'flex', gap: 2 }}>
                <NudgeBtn label="↑↑" onClick={() => nudge({ positionY: -50 })} />
                <NudgeBtn label="↑" onClick={() => nudge({ positionY: -5 })} />
              </div>
              <div />
              <div style={{ display: 'flex', gap: 2 }}>
                <NudgeBtn label="◄◄" onClick={() => nudge({ positionX: -50 })} />
                <NudgeBtn label="◄" onClick={() => nudge({ positionX: -5 })} />
              </div>
              <div />
              <div style={{ display: 'flex', gap: 2 }}>
                <NudgeBtn label="►" onClick={() => nudge({ positionX: 5 })} />
                <NudgeBtn label="►►" onClick={() => nudge({ positionX: 50 })} />
              </div>
              <div />
              <div style={{ display: 'flex', gap: 2 }}>
                <NudgeBtn label="↓" onClick={() => nudge({ positionY: 5 })} />
                <NudgeBtn label="↓↓" onClick={() => nudge({ positionY: 50 })} />
              </div>
              <div />
            </div>

            {/* Rotation fine-tune (only needed without SW bridge) */}
            <div style={{ fontSize: 10, color: '#bbb', marginTop: 4 }}>Rotation fine-tune</div>
            <div style={sty.nudgeGrid}>
              <NudgeBtn label="Rot L" onClick={() => nudge({ rotationY: -2 })} />
              <NudgeBtn label="Rot U" onClick={() => nudge({ rotationX: -2 })} />
              <NudgeBtn label="Rot D" onClick={() => nudge({ rotationX: 2 })} />
              <NudgeBtn label="Rot R" onClick={() => nudge({ rotationY: 2 })} />
            </div>
            <Btn onClick={handleResetAlignment}>Reset Alignment</Btn>
          </div>
        </Section>

        {/* Calibration Profiles */}
        <Section title="Calibration" icon="save" expanded={expanded.calibration}
          onToggle={() => toggleSection('calibration')}
          badge={profiles.length > 0 ? profiles.length.toString() : null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
            <div style={{ fontSize: 11, color: '#999' }}>Save alignment per desktop for auto-relock.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="text" value={profileName} onChange={e => setProfileName(e.target.value)}
                placeholder="Profile name..." style={sty.input} />
              <Btn primary onClick={handleSaveProfile} style={{ width: 'auto', padding: '6px 14px' }}>Save</Btn>
            </div>
            {profiles.map(p => (
              <div key={p.id} style={sty.profileRow}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#1a1a1a' }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: '#999' }}>{p.windowName}</div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <span onClick={() => handleApplyProfile(p.id)} style={sty.profileAction}>Apply</span>
                  <span onClick={() => handleDeleteProfile(p.id)} style={{ ...sty.profileAction, color: colors.statusRed }}>Del</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Live Review Section */}
        <Section
          title="Live Review"
          icon="eye"
          expanded={expanded.review}
          onToggle={() => toggleSection('review')}
          badge={reviewStatus === 'connected' || reviewStatus === 'controlling' ? 'LIVE' : reviewStatus === 'waiting' ? 'WAIT' : null}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sm }}>
            {/* Status row */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#999' }}>
                {reviewStatus === 'idle' ? 'Start a session to invite a vendor.' :
                 reviewStatus === 'waiting' ? 'Waiting for vendor to join...' :
                 reviewStatus === 'connected' ? 'Vendor connected.' :
                 reviewStatus === 'controlling' ? 'Vendor is controlling.' :
                 'Disconnected.'}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700,
                color: reviewStatus === 'connected' || reviewStatus === 'controlling' ? colors.statusGreen
                     : reviewStatus === 'waiting' ? colors.brandOrange
                     : '#aaa',
              }}>
                {reviewStatus === 'waiting' ? 'WAITING' :
                 reviewStatus === 'connected' ? 'LIVE' :
                 reviewStatus === 'controlling' ? 'CTRL' : ''}
              </span>
            </div>

            {reviewStatus === 'idle' ? (
              <Btn primary onClick={async () => {
                // Start screen capture immediately (no tracking needed)
                if (!reviewStreamRef.current) {
                  try {
                    const { desktopCapturer } = (window as any).require('electron');
                    const sources = await desktopCapturer.getSources({ types: ['screen'] });
                    if (sources.length > 0) {
                      reviewStreamRef.current = await navigator.mediaDevices.getUserMedia({
                        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sources[0].id, maxWidth: 1920, maxHeight: 1080 } } as any,
                        audio: false,
                      });
                      console.log('[Review] Screen capture started');
                    }
                  } catch (err) {
                    console.error('[Review] Screen capture failed:', err);
                  }
                }
                ipcRenderer.send('review:start');
              }}>
                Start Review Session
              </Btn>
            ) : (
              <>
                {/* Room Code */}
                <div style={{
                  background: '#1a1a2e', borderRadius: radii.md, padding: '10px 14px',
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: 10, color: '#999', marginBottom: 4 }}>Share this code with vendor</div>
                  <div style={{
                    fontSize: 22, fontWeight: 800, fontFamily: fonts.mono,
                    color: '#fff', letterSpacing: 2,
                  }}>{roomCode}</div>
                </div>

                {/* Mic Mute Toggle */}
                <button
                  onClick={() => {
                    const ms = micStreamRef.current;
                    if (ms) {
                      const track = ms.getAudioTracks()[0];
                      if (track) {
                        track.enabled = !track.enabled;
                        setMicMuted(!track.enabled);
                      }
                    }
                  }}
                  style={{
                    width: '100%', padding: '6px 0', borderRadius: 6,
                    border: `1px solid ${micMuted ? colors.statusRed : colors.statusGreen}`,
                    background: micMuted ? '#fde8e8' : '#e8fde8',
                    cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    color: micMuted ? colors.statusRed : colors.statusGreen,
                  }}
                >
                  {micMuted ? '🔇 Mic Muted' : '🎤 Mic On'}
                </button>

                {/* Control Request banner */}
                {controlRequested && (
                  <div style={{
                    background: '#fff3e0', borderRadius: radii.md, padding: spacing.sm,
                  }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#e65100', marginBottom: 6 }}>
                      Vendor wants control
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => {
                          ipcRenderer.send('review:control-grant');
                          setControlRequested(false);
                        }}
                        style={{
                          flex: 1, padding: 6, borderRadius: radii.sm, border: 'none',
                          cursor: 'pointer', background: colors.statusGreen,
                          color: '#fff', fontWeight: 600, fontSize: 12,
                        }}
                      >Allow</button>
                      <button
                        onClick={() => {
                          ipcRenderer.send('review:control-deny');
                          setControlRequested(false);
                        }}
                        style={{
                          flex: 1, padding: 6, borderRadius: radii.sm, border: 'none',
                          cursor: 'pointer', background: colors.statusRed,
                          color: '#fff', fontWeight: 600, fontSize: 12,
                        }}
                      >Deny</button>
                    </div>
                  </div>
                )}

                {/* Revoke Control */}
                {reviewStatus === 'controlling' && (
                  <Btn danger onClick={() => ipcRenderer.send('review:control-revoke')}>
                    Revoke Control
                  </Btn>
                )}

                {/* Chat */}
                <div style={{
                  maxHeight: 120, overflowY: 'auto', fontSize: 11,
                  borderRadius: radii.sm, background: '#fafafa',
                  border: `1px solid ${colors.border}`, padding: '4px 6px',
                }}>
                  {chatMessages.length === 0 ? (
                    <div style={{ color: '#bbb', fontStyle: 'italic' }}>No messages yet.</div>
                  ) : chatMessages.map((m, i) => (
                    <div key={i} style={{
                      padding: '2px 0',
                      color: m.author === 'vendor' ? '#e65100' : '#1565c0',
                    }}>
                      <strong>{m.author}:</strong> {m.text}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    value={chatInput}
                    onChange={(e: any) => setChatInput(e.target.value)}
                    onKeyDown={(e: any) => {
                      if (e.key === 'Enter' && chatInput.trim()) {
                        ipcRenderer.send('review:chat-send', chatInput.trim());
                        setChatMessages(prev => [...prev, { author: 'designer', text: chatInput.trim(), timestamp: Date.now() }]);
                        setChatInput('');
                      }
                    }}
                    placeholder="Chat..."
                    style={{
                      ...sty.input, flex: 1, padding: '5px 8px',
                      fontSize: 11,
                    }}
                  />
                </div>

                {/* Stop Session */}
                <Btn onClick={() => {
                  ipcRenderer.send('review:stop');
                  // Stop standalone review stream
                  if (reviewStreamRef.current) {
                    reviewStreamRef.current.getTracks().forEach(t => t.stop());
                    reviewStreamRef.current = null;
                  }
                  if (peerConnectionRef.current) {
                    peerConnectionRef.current.close();
                    peerConnectionRef.current = null;
                  }
                  setReviewStatus('idle');
                  setRoomCode('');
                  setChatMessages([]);
                  setControlRequested(false);
                }}>
                  Stop Session
                </Btn>
              </>
            )}
          </div>
        </Section>
      </div>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <div style={sty.footer}>
        <span>v1.0</span>
        <span style={{ display: 'flex', gap: 8 }}>
          <span title="Overlay toggle">O</span>
          <span title="Reset align">R</span>
          <span title="Skip splash">Esc</span>
        </span>
      </div>
    </div>
  );
}

function LogoSmall() {
  return <img src={LOGO_SMALL_BASE64} width={28} height={24} alt="Hanomi" />;
}

/** VC crop image with detected axis vectors overlaid as colored lines */
function VCCropWithAxes({ imageSrc, axes, imageWidth, imageHeight }: {
  imageSrc: string;
  axes: { x: [number, number] | null; y: [number, number] | null; z: [number, number] | null } | null;
  imageWidth: number;
  imageHeight: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Display size: fit within 150px, preserve aspect ratio
  const aspect = imageWidth / imageHeight;
  const DW = aspect >= 1 ? 150 : Math.round(150 * aspect);
  const DH = aspect >= 1 ? Math.round(150 / aspect) : 150;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    c.width = DW * dpr;
    c.height = DH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = () => {
      ctx.clearRect(0, 0, DW, DH);

      // Draw the crop image (preserving aspect ratio)
      if (imgRef.current && imgRef.current.complete) {
        ctx.drawImage(imgRef.current, 0, 0, DW, DH);
      }

      // Draw detected axis vectors from center
      // axes are scaled by centroidDist / halfSize where halfSize = max(w,h)/2
      // For display, scale by max(DW,DH)/2 to match
      if (axes) {
        const cx = DW / 2;
        const cy = DH / 2;
        const half = Math.max(DW, DH) / 2;

        const axisData: { dir: [number, number] | null; color: string; label: string }[] = [
          { dir: axes.x, color: '#ff3030', label: 'X' },
          { dir: axes.y, color: '#00cc00', label: 'Y' },
          { dir: axes.z, color: '#3060ff', label: 'Z' },
        ];

        for (const ax of axisData) {
          if (!ax.dir) continue;
          const ex = cx + ax.dir[0] * half;
          const ey = cy + ax.dir[1] * half;
          ctx.strokeStyle = ax.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          ctx.fillStyle = ax.color;
          ctx.beginPath();
          ctx.arc(ex, ey, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 10px system-ui';
          ctx.strokeStyle = ax.color;
          ctx.lineWidth = 2.5;
          ctx.strokeText(ax.label, ex + 5, ey - 3);
          ctx.fillText(ax.label, ex + 5, ey - 3);
        }

        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };

    if (!imgRef.current) imgRef.current = new Image();
    imgRef.current.onload = draw;
    imgRef.current.src = imageSrc;
    if (imgRef.current.complete) draw();
  }, [imageSrc, axes, DW, DH]);

  return (
    <canvas ref={canvasRef} width={DW} height={DH} style={{
      width: DW, height: DH, borderRadius: radii.sm,
      border: '1px solid rgba(0,150,255,0.3)',
    }} />
  );
}

/** Debug cube — uses detected 2D axes DIRECTLY as projection basis.
 *  This guarantees the cube matches the axis overlay on the crop image.
 *  Falls back to rotation angles if axes not available. */
function DebugOrientationCube({ rotationX, rotationY, rotationZ, axes }: {
  rotationX: number; rotationY: number; rotationZ: number;
  axes?: { x: [number, number] | null; y: [number, number] | null; z: [number, number] | null } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = 120, H = 120;
    c.width = W * dpr;
    c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);

    // Project 3D→2D using detected axes directly as the projection basis.
    // axes.x/y/z are 2D projections of world X/Y/Z in canvas space (Y-down).
    // A 3D point (px, py, pz) projects to:
    //   screen_x = px * xDir[0] + py * yDir[0] + pz * zDir[0]
    //   screen_y = px * xDir[1] + py * yDir[1] + pz * zDir[1]
    const xd = axes?.x || [0, 0];
    const yd = axes?.y || [0, 0];
    const zd = axes?.z || [0, 0];

    const sc = 36;
    const proj = (p: number[]): [number, number] => [
      cx + (p[0] * xd[0] + p[1] * yd[0] + p[2] * zd[0]) * sc,
      cy + (p[0] * xd[1] + p[1] * yd[1] + p[2] * zd[1]) * sc,
    ];

    // Cube wireframe
    const s = 0.7;
    const v = [[-s,-s,-s],[s,-s,-s],[s,s,-s],[-s,s,-s],[-s,-s,s],[s,-s,s],[s,s,s],[-s,s,s]];
    const edges: [number,number][] = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    for (const [a, b] of edges) {
      const [x1, y1] = proj(v[a]), [x2, y2] = proj(v[b]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // Colored axes
    const al = 1.3;
    const axisData = [
      { to: [al, 0, 0], color: '#e03030', label: 'X' },
      { to: [0, al, 0], color: '#20a030', label: 'Y' },
      { to: [0, 0, al], color: '#3060e0', label: 'Z' },
    ];
    const [ox, oy] = proj([0, 0, 0]);

    for (const ax of axisData) {
      const [ex, ey] = proj(ax.to);
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = ax.color;
      ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = 'bold 10px system-ui';
      ctx.fillText(ax.label, ex + 4, ey - 3);
    }

    // Rotation text
    ctx.fillStyle = '#999';
    ctx.font = '9px monospace';
    ctx.fillText(`${rotationX.toFixed(0)}\u00B0 ${rotationY.toFixed(0)}\u00B0 ${rotationZ.toFixed(0)}\u00B0`, 4, H - 4);
  }, [rotationX, rotationY, rotationZ, axes]);

  return (
    <canvas ref={canvasRef} width={120} height={120} style={{
      width: 120, height: 120, borderRadius: radii.sm,
      border: '1px solid rgba(0,0,0,0.08)', background: '#fafafa',
    }} />
  );
}

function NudgeBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={sty.nudgeBtn}>{label}</button>
  );
}

// ── ROI Drawing Overlay ───────────────────────────────────────────────

function ROIDrawingOverlay({ screenshot, step, viewCubeRegion, viewportRegion, onRegionDefined, onConfirm, onCancel }: {
  screenshot: string;
  step: 'viewcube' | 'viewport' | 'verify' | 'idle';
  viewCubeRegion: ScreenRegion | null;
  viewportRegion: ScreenRegion | null;
  onRegionDefined: (region: ScreenRegion) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [startPt, setStartPt] = useState<{ x: number; y: number } | null>(null);
  const [currentPt, setCurrentPt] = useState<{ x: number; y: number } | null>(null);

  // Make #root transparent so desktop shows through during ROI drawing
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) {
      root.style.background = 'transparent';
      root.style.backdropFilter = 'none';
      (root.style as any).webkitBackdropFilter = 'none';
      root.style.boxShadow = 'none';
      root.style.borderRadius = '0';
    }
    return () => {
      // Restore frosted glass panel style on unmount
      if (root) {
        root.style.background = 'rgba(255, 255, 255, 0.97)';
        root.style.backdropFilter = 'blur(20px) saturate(1.8)';
        (root.style as any).webkitBackdropFilter = 'blur(20px) saturate(1.8)';
        root.style.boxShadow = '0 8px 32px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)';
        root.style.borderRadius = '14px';
      }
    };
  }, []);

  // Current drag rect in pixels (relative to container)
  const dragRect = (startPt && currentPt) ? {
    x: Math.min(startPt.x, currentPt.x),
    y: Math.min(startPt.y, currentPt.y),
    w: Math.abs(currentPt.x - startPt.x),
    h: Math.abs(currentPt.y - startPt.y),
  } : null;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (step === 'verify') return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setStartPt(pt);
    setCurrentPt(pt);
    setDrawing(true);
  }, [step]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!drawing) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCurrentPt({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, [drawing]);

  const handleMouseUp = useCallback(() => {
    if (!drawing || !startPt || !currentPt) return;
    setDrawing(false);

    // Coordinates are already in window-space pixels — which equals work-area-space
    // because the window covers the entire work area. No scaling needed.
    const x = Math.round(Math.min(startPt.x, currentPt.x));
    const y = Math.round(Math.min(startPt.y, currentPt.y));
    const w = Math.round(Math.abs(currentPt.x - startPt.x));
    const h = Math.round(Math.abs(currentPt.y - startPt.y));

    if (w > 10 && h > 10) {
      onRegionDefined({ x, y, width: w, height: h });
    }

    setStartPt(null);
    setCurrentPt(null);
  }, [drawing, startPt, currentPt, onRegionDefined]);

  const stepLabel = step === 'viewcube' ? 'Draw a rectangle around the VIEW CUBE (orientation gizmo)'
    : step === 'viewport' ? 'Now draw a rectangle around the CAD PART (model area, excluding toolbars)'
    : 'Verify the regions look correct';

  const stepColor = step === 'viewcube' ? 'rgba(0,150,255,0.9)' : step === 'viewport' ? 'rgba(0,200,80,0.9)' : '#fff';

  const isVC = step === 'viewcube';
  const borderColor = isVC ? 'rgba(0,150,255,0.9)' : 'rgba(0,200,80,0.9)';
  const fillColor = isVC ? 'rgba(0,150,255,0.12)' : 'rgba(0,200,80,0.08)';

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => { if (drawing) { setDrawing(false); setStartPt(null); setCurrentPt(null); } }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'transparent',
        cursor: step === 'verify' ? 'default' : 'crosshair',
      }}
    >
      {/* Previously drawn view cube region (blue dashed) */}
      {viewCubeRegion && step !== 'viewcube' && (
        <div style={{
          position: 'absolute',
          left: viewCubeRegion.x, top: viewCubeRegion.y,
          width: viewCubeRegion.width, height: viewCubeRegion.height,
          border: '2px dashed rgba(0,150,255,0.8)',
          background: 'rgba(0,150,255,0.12)',
          borderRadius: 3, pointerEvents: 'none',
        }}>
          <span style={{
            position: 'absolute', top: -18, left: 0,
            fontSize: 10, fontWeight: 700, color: 'rgba(0,150,255,0.9)',
            fontFamily: 'system-ui', textShadow: '0 1px 3px rgba(0,0,0,0.7)',
          }}>VIEW CUBE</span>
        </div>
      )}

      {/* Previously drawn CAD region (green dashed) — during verify */}
      {viewportRegion && step === 'verify' && (
        <div style={{
          position: 'absolute',
          left: viewportRegion.x, top: viewportRegion.y,
          width: viewportRegion.width, height: viewportRegion.height,
          border: '2px dashed rgba(0,200,80,0.8)',
          background: 'rgba(0,200,80,0.08)',
          borderRadius: 3, pointerEvents: 'none',
        }}>
          <span style={{
            position: 'absolute', top: -18, left: 0,
            fontSize: 10, fontWeight: 700, color: 'rgba(0,200,80,0.9)',
            fontFamily: 'system-ui', textShadow: '0 1px 3px rgba(0,0,0,0.7)',
          }}>CAD REGION</span>
        </div>
      )}

      {/* Current drag rectangle */}
      {dragRect && dragRect.w > 2 && dragRect.h > 2 && (
        <div style={{
          position: 'absolute',
          left: dragRect.x, top: dragRect.y,
          width: dragRect.w, height: dragRect.h,
          border: `2px solid ${borderColor}`,
          background: fillColor,
          borderRadius: 3, pointerEvents: 'none',
        }}>
          <span style={{
            position: 'absolute', bottom: -18, left: 4,
            fontSize: 10, fontFamily: 'monospace', color: '#fff',
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
          }}>
            {dragRect.w}x{dragRect.h}px
          </span>
        </div>
      )}

      {/* Single centered pill — step indicator + label + action buttons */}
      <div style={{
        position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
        padding: '8px 12px 8px 16px', borderRadius: 28,
        background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(16px)',
        border: '1px solid rgba(255,255,255,0.15)',
        display: 'flex', alignItems: 'center', gap: 12,
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}>
        <span style={{
          width: 26, height: 26, borderRadius: 13, display: 'flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          background: stepColor, color: '#fff', fontSize: 12, fontWeight: 700,
        }}>
          {step === 'viewcube' ? '1' : step === 'viewport' ? '2' : '\u2713'}
        </span>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 600, fontFamily: 'system-ui' }}>
          {stepLabel}
        </span>
        {step === 'verify' && (
          <button onClick={onConfirm} style={{
            padding: '6px 16px', borderRadius: 20, border: 'none',
            background: colors.brandOrange, color: '#fff', fontSize: 12,
            fontWeight: 600, cursor: 'pointer', marginLeft: 4,
          }}>
            Confirm
          </button>
        )}
        <button onClick={onCancel} style={{
          padding: '6px 16px', borderRadius: 20,
          border: '1px solid rgba(255,255,255,0.25)',
          background: 'transparent', color: '#aaa', fontSize: 12,
          fontWeight: 500, cursor: 'pointer',
        }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const sty: Record<string, React.CSSProperties> = {
  container: {
    height: '100vh', display: 'flex', flexDirection: 'column',
    fontFamily: fonts.sans, background: 'rgba(255,255,255,0.97)',
    borderRadius: 14, overflow: 'hidden',
  },
  header: {
    padding: `${spacing.md}px ${spacing.lg}px`,
    borderBottom: `1px solid rgba(0,0,0,0.06)`,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    // @ts-ignore — Electron-specific CSS property for window dragging
    '-webkit-app-region': 'drag',
  },
  iconBtn: {
    width: 28, height: 28, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', fontSize: 14, color: '#666',
    // @ts-ignore
    '-webkit-app-region': 'no-drag',
  },
  content: {
    flex: 1, overflowY: 'auto' as const,
  },
  sectionHeader: {
    padding: `${spacing.md}px ${spacing.lg}px`,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    cursor: 'pointer', userSelect: 'none' as const,
  },
  badge: {
    fontSize: 10, fontWeight: 600, color: '#666',
    background: '#f0f0f0', borderRadius: 10,
    padding: '2px 8px', minWidth: 22, textAlign: 'center' as const,
  },
  fileChip: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: `${spacing.xs}px ${spacing.sm}px`,
    background: '#f8f8f8', borderRadius: radii.sm,
    border: `1px solid ${colors.border}`,
  },
  statusRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: `${spacing.xs}px ${spacing.sm}px`,
    background: '#f8f8f8', borderRadius: radii.sm,
    fontSize: 11, fontFamily: fonts.mono,
  },
  statusDot: {
    width: 6, height: 6, borderRadius: '50%',
    background: colors.statusGreen,
  },
  nudgeGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 3,
  },
  nudgeBtn: {
    padding: '5px 2px', fontSize: 9, fontWeight: 600,
    border: `1px solid ${colors.border}`, borderRadius: radii.sm,
    background: '#fff', cursor: 'pointer', fontFamily: fonts.mono,
    textAlign: 'center' as const,
  },
  input: {
    flex: 1, padding: `6px ${spacing.sm}px`,
    border: `1px solid ${colors.border}`, borderRadius: radii.md,
    fontSize: 12, outline: 'none', fontFamily: fonts.sans,
  },
  profileRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: `${spacing.xs}px ${spacing.sm}px`,
    background: '#f8f8f8', borderRadius: radii.sm,
  },
  profileAction: {
    fontSize: 10, fontWeight: 600, cursor: 'pointer',
    color: colors.brandOrange, padding: '2px 6px',
  },
  footer: {
    padding: `${spacing.sm}px ${spacing.lg}px`,
    borderTop: `1px solid rgba(0,0,0,0.06)`,
    display: 'flex', justifyContent: 'space-between',
    fontSize: 10, color: '#999',
  },
};
