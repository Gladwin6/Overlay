import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { IPC, AlignmentState, Annotation, ScreenRegion } from '../../shared/types';
import type { SWCameraFrame } from '../../main/tracking/SWBridgeReceiver';
import { AnnotationOverlay } from './AnnotationOverlay';
import { PoseDatabaseGenerator } from './PoseDatabaseGenerator';
import { SilhouetteAligner } from './SilhouetteAligner';

const { ipcRenderer } = window.require('electron');

const TARGET_SIZE = 55;

export function OverlayApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [isAnnotateMode, setIsAnnotateMode] = useState(false);
  const [vendorAnnotations, setVendorAnnotations] = useState<any[]>([]);
  const modelIsZUpRef = useRef(true); // SolidWorks always Z-up — camera uses raw axes
  const [currentAlignment, setCurrentAlignment] = useState<AlignmentState>({
    positionX: 0, positionY: 0, positionZ: 0,
    rotationX: 0, rotationY: 0, rotationZ: 0,
    scale: 1,
  });
  const [windowSize, setWindowSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [maskRegions, setMaskRegions] = useState<{ viewCube: ScreenRegion; viewport: ScreenRegion } | null>(null);

  const poseDbGeneratorRef = useRef<PoseDatabaseGenerator | null>(null);
  const silhouetteAlignerRef = useRef<SilhouetteAligner | null>(null);

  // Smooth interpolation refs — declared early so the animation loop can access them
  const targetQuatRef = useRef(new THREE.Quaternion());
  const currentQuatRef = useRef(new THREE.Quaternion());
  const hasTargetRef = useRef(false);
  const targetPosRef = useRef({ x: 0, y: 0 });
  const targetScaleRef = useRef(1);
  const targetVpRef = useRef({ w: 0, h: 0 });

  // SW Bridge refs — also needed in animation loop
  const swBridgeLive    = useRef(false);
  const alignScaleRef   = useRef(1);
  const alignPosRef     = useRef({ x: 0, y: 0 });

  const stateRef = useRef<{
    scene: THREE.Scene | null;
    camera: THREE.OrthographicCamera | null;
    renderer: THREE.WebGLRenderer | null;
    modelGroup: THREE.Group | null;
    frameId: number | null;
    needsRender: boolean;
    modelScale: number;
    modelCenter: THREE.Vector3;
    raycaster: THREE.Raycaster;
  }>({
    scene: null,
    camera: null,
    renderer: null,
    modelGroup: null,
    frameId: null,
    needsRender: true,
    modelScale: 1,
    modelCenter: new THREE.Vector3(),
    raycaster: new THREE.Raycaster(),
  });

  // ── Vendor Annotations (from review session) ────────────────────

  useEffect(() => {
    const onAnnotation = (_e: any, ann: any) => {
      setVendorAnnotations(prev => [...prev, ann]);
    };
    const onAnnotationDelete = (_e: any, id: string) => {
      setVendorAnnotations(prev => prev.filter(a => a.id !== id));
    };
    ipcRenderer.on('review:annotation', onAnnotation);
    ipcRenderer.on('review:annotation-delete', onAnnotationDelete);
    return () => {
      ipcRenderer.removeListener('review:annotation', onAnnotation);
      ipcRenderer.removeListener('review:annotation-delete', onAnnotationDelete);
    };
  }, []);

  // ── Platform Annotations (3D world points from hanomi-platform) ──

  useEffect(() => {
    const onPlatformAnnotation = (_e: any, ann: any) => {
      // Convert platform annotation to overlay Annotation format
      if (ann.worldPoint) {
        const newAnn: Annotation = {
          id: ann.id || `plat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          worldPoint: ann.worldPoint,
          worldNormal: ann.worldNormal || { x: 0, y: 1, z: 0 },
          text: ann.text || '',
          createdAt: ann.timestamp || Date.now(),
        };
        setAnnotations(prev => {
          // Avoid duplicates
          if (prev.find(a => a.id === newAnn.id)) return prev;
          return [...prev, newAnn];
        });
        console.log('[Overlay] Platform annotation received:', newAnn.text);
      }
    };
    const onPlatformAnnotationDelete = (_e: any, id: string) => {
      setAnnotations(prev => prev.filter(a => a.id !== id));
    };
    ipcRenderer.on('platform:annotation', onPlatformAnnotation);
    ipcRenderer.on('platform:annotation-delete', onPlatformAnnotationDelete);
    return () => {
      ipcRenderer.removeListener('platform:annotation', onPlatformAnnotation);
      ipcRenderer.removeListener('platform:annotation-delete', onPlatformAnnotationDelete);
    };
  }, []);

  // ── CAD Bridge Camera (pixel-perfect, auto-detected) ────────────
  // When a bridge is live (e.g., SolidWorks COM), it sends exact camera data.
  // This takes priority over view cube tracking.

  const bridgeLiveRef = useRef(false);
  const bridgeCamRef = useRef<{ pos: THREE.Vector3; up: THREE.Vector3; zoom: number } | null>(null);

  // Manual correction rotation — Ctrl+Shift+X/Y/Z to rotate 90°, Ctrl+Shift+R to reset
  const correctionRef = useRef(new THREE.Euler(0, 0, 0));
  const [correctionLabel, setCorrectionLabel] = useState('0,0,0');

  useEffect(() => {
    const step = Math.PI / 2;
    const updateLabel = () => {
      const c = correctionRef.current;
      setCorrectionLabel(`${Math.round(c.x * 180/Math.PI)},${Math.round(c.y * 180/Math.PI)},${Math.round(c.z * 180/Math.PI)}`);
      stateRef.current.needsRender = true;
    };
    const onRotate = (_e: any, axis: string) => {
      const c = correctionRef.current;
      if (axis === 'x') c.x += step;
      else if (axis === 'y') c.y += step;
      else if (axis === 'z') c.z += step;
      updateLabel();
    };
    const onReset = () => {
      const c = correctionRef.current;
      c.x = 0; c.y = 0; c.z = 0;
      updateLabel();
    };
    ipcRenderer.on('correction:rotate', onRotate);
    ipcRenderer.on('correction:reset', onReset);
    return () => {
      ipcRenderer.removeListener('correction:rotate', onRotate);
      ipcRenderer.removeListener('correction:reset', onReset);
    };
  }, []);

  useEffect(() => {
    const _br = new THREE.Vector3();
    const _bu = new THREE.Vector3();
    const _bb = new THREE.Vector3();
    const _bcr = new THREE.Vector3();
    const _bcu = new THREE.Vector3();

    let bridgeFrameCount = 0;
    const _q = new THREE.Quaternion();

    const onBridgeCamera = (_e: any, frame: any) => {
      bridgeLiveRef.current = true;
      bridgeFrameCount++;
      const { camera, modelGroup: mg, scene, renderer: rend } = stateRef.current;
      if (!camera || !mg || !scene || !rend) return;

      const r = frame.rotation;
      if (!r || r.length < 9) return;

      // ── Clean transposed matrix ──
      const m4 = new THREE.Matrix4();
      m4.set(
        r[0], r[3], r[6], 0,
        r[1], r[4], r[7], 0,
        r[2], r[5], r[8], 0,
        0,    0,    0,    1
      );

      _q.setFromRotationMatrix(m4);
      mg.quaternion.copy(_q);
      mg.scale.setScalar(stateRef.current.modelScale);

      // Fixed camera
      camera.matrixAutoUpdate = true;
      camera.position.set(0, 0, 200);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);

      // ── Scale ──
      const dpi = frame.dpi > 0 ? frame.dpi : 96;
      const vpW = frame.viewportWidth || window.innerWidth;
      const vpH = frame.viewportHeight || window.innerHeight;
      const frustumH = vpW / 12;
      const ms = stateRef.current.modelScale;
      const ppm = frame.scale * dpi * 39.3701;
      const autoZoom = ms > 0 ? Math.max(0.02, ppm * frustumH / (ms * vpH) * 1.55) : 1;
      camera.zoom = autoZoom;
      camera.updateProjectionMatrix();

      // ── Position: offset model to match SW viewport pan ──
      // panX/panY from bridge = model offset from SW viewport center in logical px
      // The SW viewport center is offset from the overlay window center
      // because the feature tree panel shifts the viewport right
      const panX = frame.panX ?? 0;
      const panY = frame.panY ?? 0;
      const swVpW = frame.viewportWidth || vpW;
      const vpOffsetX = (vpW - swVpW) / 2;

      const pxPerWorld = vpH / frustumH;
      const worldPerPx = 1.0 / (autoZoom * pxPerWorld);
      mg.position.set(
        -(panX + vpOffsetX) * worldPerPx,  // negated: CSS scaleX(-1)
        -panY * worldPerPx,
        0
      );

      // Let animate loop render (synced with display)
      stateRef.current.needsRender = true;

      // Debug
      if (bridgeFrameCount <= 5 || bridgeFrameCount % 10 === 0) {
        setBridgeDebug(`BR #${bridgeFrameCount} | q=(${_q.x.toFixed(2)},${_q.y.toFixed(2)},${_q.z.toFixed(2)},${_q.w.toFixed(2)}) | r0=[${r[0].toFixed(2)},${r[1].toFixed(2)},${r[2].toFixed(2)}]`);
      }
    };

    ipcRenderer.on('bridge:camera', onBridgeCamera);
    return () => { ipcRenderer.removeListener('bridge:camera', onBridgeCamera); };
  }, []);

  // ── View Cube Rotation (raw axes → quaternion, platform approach) ──
  // This mirrors hanomi-platform's axesToQuaternion() exactly.
  // Raw detected 2D axis projections → rotation matrix → quaternion.
  // No Euler angles, no axis mapping, no smoothing in the tracker.
  // Temporal smoothing via quaternion slerp here in the renderer.

  useEffect(() => {
    let prevQ: THREE.Quaternion | null = null;

    const onAxes = (_e: any, data: { x: number[] | null; y: number[] | null; z: number[] | null; confidence: number }) => {
      // Skip view cube when bridge is live (bridge has priority)
      if (bridgeLiveRef.current) return;

      const { x: xDir, y: yDir, z: zDir, confidence } = data;
      const detected = [xDir, yDir, zDir].filter(Boolean);
      if (detected.length < 2) return;

      // Build camera right/up vectors from raw 2D projections
      // (identical to hanomi-platform viewCubeTracker.js axesToQuaternion)
      const right = new THREE.Vector3(
        xDir ? xDir[0] : 0,
        yDir ? yDir[0] : 0,
        zDir ? zDir[0] : 0,
      );
      const up = new THREE.Vector3(
        xDir ? -xDir[1] : 0,
        yDir ? -yDir[1] : 0,
        zDir ? -zDir[1] : 0,
      );

      const rLen = right.length();
      const uLen = up.length();
      if (rLen < 0.001 || uLen < 0.001) return;

      right.normalize();
      up.normalize();
      const forward = new THREE.Vector3().crossVectors(right, up).normalize();
      up.crossVectors(forward, right).normalize();

      // Build rotation matrix: columns = [right, up, forward]
      const mat = new THREE.Matrix4();
      const te = mat.elements;
      te[0] = right.x;   te[1] = right.y;   te[2] = right.z;   te[3] = 0;
      te[4] = up.x;      te[5] = up.y;      te[6] = up.z;      te[7] = 0;
      te[8] = forward.x; te[9] = forward.y; te[10] = forward.z; te[11] = 0;
      te[12] = 0;         te[13] = 0;         te[14] = 0;         te[15] = 1;

      const newQ = new THREE.Quaternion().setFromRotationMatrix(mat);

      // Hemisphere consistency with previous frame
      if (prevQ && newQ.dot(prevQ) < 0) {
        newQ.set(-newQ.x, -newQ.y, -newQ.z, -newQ.w);
      }

      // Adaptive temporal smoothing via slerp
      // High confidence → trust new result more (less smoothing)
      const dampWeight = confidence > 0.8 ? 0.3 : confidence > 0.5 ? 0.5 : 0.7;
      if (prevQ) {
        // Check angular distance — if too large, it's an outlier, smooth heavily
        const dotAbs = Math.min(1, Math.abs(newQ.dot(prevQ)));
        const angDiff = 2 * Math.acos(dotAbs);
        if (angDiff > 0.5) { // > ~30 degrees jump
          newQ.slerp(prevQ, 0.8); // Heavy smoothing for jumps
        } else {
          newQ.slerp(prevQ, dampWeight);
        }
      }
      prevQ = newQ.clone();

      // Set as target for the animation loop's slerp
      targetQuatRef.current.copy(newQ);

      // Hemisphere consistency with current interpolated camera
      if (hasTargetRef.current && targetQuatRef.current.dot(currentQuatRef.current) < 0) {
        targetQuatRef.current.set(
          -targetQuatRef.current.x, -targetQuatRef.current.y,
          -targetQuatRef.current.z, -targetQuatRef.current.w
        );
      }

      if (!hasTargetRef.current) {
        const { camera } = stateRef.current;
        if (camera) {
          currentQuatRef.current.copy(targetQuatRef.current);
          const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(newQ);
          const upDir = new THREE.Vector3(0, 1, 0).applyQuaternion(newQ);
          camera.position.copy(backward.multiplyScalar(200));
          camera.up.copy(upDir);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();
          hasTargetRef.current = true;
        }
      }

      stateRef.current.needsRender = true;
    };

    // Also keep silhouette match as fallback/correction
    const onSilhouetteMatch = (_e: any, data: any) => {
      if (data.score > 30) return; // Only use high-quality silhouette matches
      const silQ = new THREE.Quaternion(data.qx, data.qy, data.qz, data.qw);
      if (prevQ && silQ.dot(prevQ) < 0) silQ.set(-silQ.x, -silQ.y, -silQ.z, -silQ.w);
      // Blend silhouette result gently (20%) with current view cube tracking
      if (prevQ) {
        prevQ.slerp(silQ, 0.2);
        targetQuatRef.current.copy(prevQ);
        stateRef.current.needsRender = true;
      }
    };

    ipcRenderer.on('viewcube:axes', onAxes);
    ipcRenderer.on('silhouette:match', onSilhouetteMatch);
    return () => {
      ipcRenderer.removeListener('viewcube:axes', onAxes);
      ipcRenderer.removeListener('silhouette:match', onSilhouetteMatch);
    };
  }, []);

  // ── Initialize Three.js ──────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = window.innerWidth;
    const height = window.innerHeight;

    const scene = new THREE.Scene();

    const aspect = width / height;
    const frustumSize = width / 12;
    const camera = new THREE.OrthographicCamera(
      -frustumSize * aspect / 2, frustumSize * aspect / 2,
      frustumSize / 2, -frustumSize / 2,
      0.1, 2000
    );
    camera.position.set(0, 0, 200);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.9);
    dir1.position.set(5, 10, 7);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dir2.position.set(-5, -3, -5);
    scene.add(dir2);

    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.renderer = renderer;

    // Interpolation factor: 0.35 at 60fps ≈ 12ms effective lag. Feels instant.
    const SLERP_FACTOR = 0.35;
    const dist = 200;

    function animate() {
      stateRef.current.frameId = requestAnimationFrame(animate);

      // Smooth camera interpolation: slerp toward target quaternion every frame
      // Skip when ANY bridge is live — bridge handlers own the camera directly
      if (hasTargetRef.current && !swBridgeLive.current && !bridgeLiveRef.current) {
        const current = currentQuatRef.current;
        const target = targetQuatRef.current;
        const dotVal = Math.abs(current.dot(target));

        // Only interpolate if not already at target (avoid unnecessary renders)
        if (dotVal < 0.9999) {
          current.slerp(target, SLERP_FACTOR);

          // Extract camera vectors from interpolated quaternion
          const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(current);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(current);
          camera.position.copy(backward.multiplyScalar(dist));
          camera.up.copy(up);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();

          // Smooth position and scale too
          const { modelGroup } = stateRef.current;
          if (modelGroup) {
            const vpW = targetVpRef.current.w || window.innerWidth;
            const vpH = targetVpRef.current.h || window.innerHeight;
            const referenceSize = Math.max(vpW, vpH);
            const pixelToWorld = TARGET_SIZE / (referenceSize * 0.5);
            const tx = targetPosRef.current.x * pixelToWorld;
            const ty = -targetPosRef.current.y * pixelToWorld;
            modelGroup.position.x += (tx - modelGroup.position.x) * SLERP_FACTOR;
            modelGroup.position.y += (ty - modelGroup.position.y) * SLERP_FACTOR;
            const targetS = stateRef.current.modelScale * targetScaleRef.current;
            const curS = modelGroup.scale.x;
            modelGroup.scale.setScalar(curS + (targetS - curS) * SLERP_FACTOR);
          }

          stateRef.current.needsRender = true;
        }
      }

      // Always render when bridge is live (rotation updates every frame)
      if (stateRef.current.needsRender || bridgeLiveRef.current) {
        renderer.render(scene, camera);
        stateRef.current.needsRender = false;
      }
    }
    animate();

    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const a = w / h;
      const f = w / 12;
      camera.left = -f * a / 2;
      camera.right = f * a / 2;
      camera.top = f / 2;
      camera.bottom = -f / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      stateRef.current.needsRender = true;
      setWindowSize({ width: w, height: h });
    };
    window.addEventListener('resize', onResize);

    // Handle display changes (moved to different monitor, resolution changed)
    const onDisplayChanged = () => {
      setTimeout(onResize, 100); // slight delay for window bounds to settle
    };
    ipcRenderer.on('display-changed', onDisplayChanged);

    return () => {
      window.removeEventListener('resize', onResize);
      ipcRenderer.removeListener('display-changed', onDisplayChanged);
      if (stateRef.current.frameId) cancelAnimationFrame(stateRef.current.frameId);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  // ── GLTF Loading ─────────────────────────────────────────────────

  useEffect(() => {
    const handleGltfData = (_event: any, data: { url: string; directory: string; filename: string }) => {
      const { scene } = stateRef.current;
      if (!scene) return;

      console.log('[Overlay] Loading GLTF:', data.filename);

      if (stateRef.current.modelGroup) {
        stateRef.current.modelGroup.traverse((child: any) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (Array.isArray(child.material)) {
              child.material.forEach((m: any) => m.dispose());
            } else {
              child.material.dispose();
            }
          }
        });
        scene.remove(stateRef.current.modelGroup);
        stateRef.current.modelGroup = null;
      }

      // Clear annotations when new GLTF loads
      setAnnotations([]);

      const loader = new GLTFLoader();
      if (data.directory) {
        loader.setPath('file://' + data.directory + '/');
      }

      loader.load(
        data.directory ? data.filename : data.url,
        (gltf) => {
          const model = gltf.scene;

          model.traverse((child: any) => {
            if (child.isMesh && !child.geometry.attributes.normal) {
              child.geometry.computeVertexNormals();
            }
          });

          const box = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const scale = TARGET_SIZE / maxDim;

          stateRef.current.modelScale = scale;
          stateRef.current.modelCenter = center.clone();

          const group = new THREE.Group();
          model.position.set(-center.x, -center.y, -center.z);
          group.add(model);
          group.scale.setScalar(scale);

          // GLB/GLTF spec mandates Y-up. Most exporters (Blender, Fusion, online converters)
          // follow this. SolidWorks STEP-to-GLTF converters sometimes export Z-up.
          //
          // Auto-detect: if the model is taller in Z than Y, it's likely Z-up and needs
          // the -90° X rotation. Otherwise leave it as-is (Y-up, standard).
          // Always apply -90° X rotation for SolidWorks exports.
          // SolidWorks STEP→GLB converters produce Z-up models. The old heuristic
          // (size.z > size.y * 1.5) fails for flat/wide parts. Since this app is
          // designed for SolidWorks, always assume Z-up.
          // SolidWorks Z-up → Three.js Y-up: -90° around X
          // Additional -90° around X to match observed model orientation
          // No model rotation — camera from SolidWorks Transform handles orientation.
          // Both model and camera stay in SolidWorks Z-up coordinate space.
          group.rotation.x = 0;
          modelIsZUpRef.current = true;
          console.log('[Overlay] No model rotation — using raw SolidWorks camera vectors');

          group.traverse((child: any) => {
            if (child.isMesh) {
              child.material = new THREE.MeshBasicMaterial({
                color: 0xb8b8b8,
                transparent: true,
                opacity: 0.05,
                side: THREE.DoubleSide,
                depthWrite: false,
              });

              const edgesGeo = new THREE.EdgesGeometry(child.geometry, 20);
              const edgesMat = new THREE.LineBasicMaterial({
                color: 0x00d9ff,
                linewidth: 1,
                transparent: true,
                opacity: 0.85,
              });
              const edges = new THREE.LineSegments(edgesGeo, edgesMat);
              child.add(edges);
            }
          });

          scene.add(group);
          stateRef.current.modelGroup = group;
          stateRef.current.needsRender = true;

          // Force matrix world update so child.matrixWorld is correct for the aligner
          group.updateMatrixWorld(true);

          // Build silhouette alignment database from the model (delay slightly to ensure render cycle)
          if (silhouetteAlignerRef.current) silhouetteAlignerRef.current.dispose();
          silhouetteAlignerRef.current = new SilhouetteAligner();
          setTimeout(() => {
            try {
              console.log('[SilhouetteAligner] Starting database build...');
              let lineSegCount = 0;
              group.traverse((c: any) => { if (c.isLineSegments) lineSegCount++; });
              console.log(`[SilhouetteAligner] Found ${lineSegCount} LineSegments in model`);
              silhouetteAlignerRef.current!.buildDatabase(group, (pct) => {
                if (pct % 25 === 0) console.log(`[SilhouetteAligner] ${pct}%`);
              });
            } catch (err) {
              console.error('[SilhouetteAligner] Database build failed:', err);
            }
          }, 500);

          console.log('[Overlay] GLTF loaded:', data.filename, `(${scale.toFixed(3)}x scale)`);
        },
        undefined,
        (error) => {
          console.error('[Overlay] GLTF load error:', error);
        }
      );
    };

    ipcRenderer.on(IPC.GLTF_DATA, handleGltfData);
    return () => { ipcRenderer.removeListener(IPC.GLTF_DATA, handleGltfData); };
  }, []);

  // ── Model Pose Database Generation ───────────────────────────────

  useEffect(() => {
    const handleGenerate = () => {
      const { modelGroup } = stateRef.current;
      if (!modelGroup) {
        console.warn('[Overlay] MODELPOSE_GENERATE received but no model loaded');
        return;
      }
      console.log('[Overlay] Starting pose database generation...');
      if (poseDbGeneratorRef.current) {
        poseDbGeneratorRef.current.cancel();
      }
      poseDbGeneratorRef.current = new PoseDatabaseGenerator();
      poseDbGeneratorRef.current.generate(modelGroup, (pct) => {
        if (pct % 10 === 0) {
          console.log(`[Overlay] Pose database: ${pct}%`);
        }
      });
    };

    ipcRenderer.on(IPC.MODELPOSE_GENERATE, handleGenerate);
    return () => {
      ipcRenderer.removeListener(IPC.MODELPOSE_GENERATE, handleGenerate);
      poseDbGeneratorRef.current?.cancel();
    };
  }, []);

  // ── Alignment Updates (with smooth interpolation) ───────────────
  // Tracking data arrives at ~30fps. The overlay renders at 60fps.
  // Instead of snapping the camera, we store the target quaternion and
  // slerp toward it every animation frame for buttery-smooth motion.

  useEffect(() => {
    const handleAlignment = (_event: any, alignment: AlignmentState) => {
      const { camera } = stateRef.current;
      if (!camera) return;

      const dist = 200;

      // When SW bridge is live it owns the camera orientation
      if (swBridgeLive.current) {
        alignScaleRef.current = alignment.scale;
        alignPosRef.current   = { x: alignment.positionX, y: alignment.positionY };
        stateRef.current.needsRender = true;
        return;
      }

      // Compute target quaternion from tracking data
      let targetBackward: THREE.Vector3 | null = null;
      let targetUp: THREE.Vector3 | null = null;

      if (alignment.viewCubeAxes) {
        const axes = alignment.viewCubeAxes;
        const xd = axes.x || [0, 0];
        const yd = axes.y || [0, 0];
        const zd = axes.z || [0, 0];

        // Build camera vectors from raw axis projections (platform approach).
        //
        // If the model was auto-rotated (Z-up detected), the model is now in
        // SolidWorks' coordinate space, so camera uses raw axes directly.
        //
        // If the model was NOT rotated (Y-up / flat model), SolidWorks is still
        // Z-up but the model is Y-up, so camera needs Z-up→Y-up transform:
        // (x,y,z) → (x,z,-y) = -90° around X axis.
        let right: THREE.Vector3;
        let up: THREE.Vector3;

        if (modelIsZUpRef.current) {
          // Model was rotated to Z-up space → camera uses raw SolidWorks axes
          right = new THREE.Vector3(xd[0], yd[0], zd[0]);
          up = new THREE.Vector3(-xd[1], -yd[1], -zd[1]);
        } else {
          // Model is in Y-up space → apply Z-up→Y-up: swap Y↔Z, negate new Z
          // right_yup = (right.x, right.z, -right.y) = (xd[0], zd[0], -yd[0])
          // up_yup = (up.x, up.z, -up.y) = (-xd[1], -zd[1], yd[1])
          right = new THREE.Vector3(xd[0], zd[0], -yd[0]);
          up = new THREE.Vector3(-xd[1], -zd[1], yd[1]);
        }

        const rLen = right.length();
        const uLen = up.length();
        if (rLen > 0.001 && uLen > 0.001) {
          right.normalize();
          up.normalize();
          const forward = new THREE.Vector3().crossVectors(right, up).normalize();
          up.crossVectors(forward, right).normalize();
          targetBackward = forward;
          targetUp = up;
        }
      } else {
        const radX = THREE.MathUtils.degToRad(alignment.rotationX);
        const radY = THREE.MathUtils.degToRad(alignment.rotationY);
        const pos = new THREE.Vector3(
          dist * Math.sin(radY) * Math.cos(radX),
          dist * Math.sin(radX),
          dist * Math.cos(radY) * Math.cos(radX)
        );
        targetBackward = pos.normalize();
        const radZ = THREE.MathUtils.degToRad(alignment.rotationZ || 0);
        if (Math.abs(radZ) > 0.01) {
          const fwd = targetBackward.clone().negate();
          const worldUp = new THREE.Vector3(0, 1, 0);
          const r = new THREE.Vector3().crossVectors(worldUp, fwd).normalize();
          const naturalUp = new THREE.Vector3().crossVectors(fwd, r).normalize();
          const cosZ = Math.cos(radZ), sinZ = Math.sin(radZ);
          targetUp = naturalUp.clone().multiplyScalar(cosZ)
            .add(new THREE.Vector3().crossVectors(fwd, naturalUp).multiplyScalar(sinZ));
        } else {
          targetUp = new THREE.Vector3(0, 1, 0);
        }
      }

      if (targetBackward && targetUp) {
        // Build quaternion directly from camera basis vectors (no clone needed)
        // Camera convention: columns = [right, up, backward]
        const right = new THREE.Vector3().crossVectors(targetUp, targetBackward).normalize();
        const upOrtho = new THREE.Vector3().crossVectors(targetBackward, right).normalize();
        const m = new THREE.Matrix4().makeBasis(right, upOrtho, targetBackward);
        targetQuatRef.current.setFromRotationMatrix(m);

        // Hemisphere consistency: keep on same side as current
        if (hasTargetRef.current && targetQuatRef.current.dot(currentQuatRef.current) < 0) {
          targetQuatRef.current.set(
            -targetQuatRef.current.x, -targetQuatRef.current.y,
            -targetQuatRef.current.z, -targetQuatRef.current.w
          );
        }

        // On first tracking frame, snap immediately (no interpolation)
        if (!hasTargetRef.current) {
          currentQuatRef.current.copy(targetQuatRef.current);
          camera.position.copy(targetBackward.clone().multiplyScalar(dist));
          camera.up.copy(upOrtho);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();
          hasTargetRef.current = true;
        }
      }

      // Store position/scale targets
      targetVpRef.current = {
        w: alignment.viewportWidth || window.innerWidth,
        h: alignment.viewportHeight || window.innerHeight,
      };
      targetPosRef.current = { x: alignment.positionX, y: alignment.positionY };
      targetScaleRef.current = alignment.scale;

      stateRef.current.needsRender = true;
      setCurrentAlignment(alignment);
    };

    ipcRenderer.on(IPC.ALIGNMENT_UPDATE, handleAlignment);
    return () => { ipcRenderer.removeListener(IPC.ALIGNMENT_UPDATE, handleAlignment); };
  }, []);

  // ── SolidWorks COM Bridge ─────────────────────────────────────────
  // Rotation: exact from Orientation3 matrix.
  // Scale:    absolute formula — Scale2 × DPI × 39.37 gives pixels/metre.
  //           No manual scale needed.
  // Position: bounding-box centre projected through view matrix gives
  //           exact screen offset (scx/scy). Combined with the CAD
  //           viewport centre (set from ROI when bridge goes live).
  //           No manual position needed once ROI is drawn.

  const [swDebug, setSwDebug] = useState<string | null>(null);
  const [bridgeDebug, setBridgeDebug] = useState<string | null>(null);

  // Pre-allocated vectors to avoid per-frame GC pressure
  const _right    = useRef(new THREE.Vector3());
  const _up       = useRef(new THREE.Vector3());
  const _backward = useRef(new THREE.Vector3());
  const _camRight = useRef(new THREE.Vector3());
  const _camUp    = useRef(new THREE.Vector3());

  useEffect(() => {
    const onStatus = (_e: any, status: string) => {
      swBridgeLive.current = (status === 'live');
    };
    ipcRenderer.on(IPC.SW_BRIDGE_STATUS, onStatus);

    let swFrameCount = 0;
    const handleSWCamera = (_event: any, frame: SWCameraFrame) => {
      swBridgeLive.current = true;
      swFrameCount++;
      if (swFrameCount <= 3 || swFrameCount % 60 === 0) {
        console.log('[SW Bridge] frame', swFrameCount,
          's:', frame.s?.toFixed(4), 'dpi:', frame.dpi,
          'scx:', frame.scx?.toFixed(1), 'scy:', frame.scy?.toFixed(1));
      }

      const { modelGroup, camera } = stateRef.current;
      if (!modelGroup || !camera) return;

      // ── Rotation ─────────────────────────────────────────────────
      // Use raw camera vectors — no coordinate conversion.
      const r = frame.r;
      if (r.length < 9) return;

      const right = _right.current.set(r[0], r[1], r[2]);
      const up    = _up.current.set(   r[3], r[4], r[5]);
      if (right.length() < 0.001 || up.length() < 0.001) return;
      right.normalize();
      up.normalize();
      up.sub(right.clone().multiplyScalar(right.dot(up))).normalize();
      const backward = _backward.current.crossVectors(right, up).normalize();
      camera.position.copy(backward.clone().multiplyScalar(200));
      camera.up.copy(up);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();

      // ── Scale — fully automatic ───────────────────────────────────
      // pixels/metre = Scale2 × DPI × 39.3701  (Scale2 at DPI=96 baseline → logical px/m)
      // model height in logical px on SW screen = maxDim_metres × ppm
      // model height in Three.js px at zoom Z   = TARGET_SIZE / frustumSize × screenH × Z
      // Solve for Z:
      //   Z = (maxDim_m × ppm) / (TARGET_SIZE / frustumH × screenH)
      //     = (TARGET_SIZE/modelScale × ppm) / (TARGET_SIZE × screenH / frustumH)
      //     = ppm × frustumH / (modelScale × screenH)
      const dpi          = frame.dpi > 0 ? frame.dpi : 96;
      // FIX: Use viewport dimensions from ROI, not full window (overlay covers whole display)
      const vpWidth      = currentAlignment.viewportWidth || window.innerWidth;
      const vpHeight     = currentAlignment.viewportHeight || window.innerHeight;
      const frustumH     = vpWidth / 12;                      // Three.js frustum height (world units)
      const ms           = stateRef.current.modelScale;       // TARGET_SIZE / maxDim_metres

      // Use raw Scale2 directly — no EMA lag when zooming
      const ppm          = frame.s * dpi * 39.3701;          // logical px per metre

      const autoZoom     = ms > 0
        ? Math.max(0.02, ppm * frustumH / (ms * vpHeight))
        : 1;

      camera.zoom = autoZoom * alignScaleRef.current;   // user slider is a multiplier on top
      camera.updateProjectionMatrix();

      // ── Position — fully automatic ────────────────────────────────
      // scx/scy from bridge = model bbox centre offset from SW viewport centre (logical px).
      // alignPosRef = SW viewport centre offset from overlay centre (logical px, set from ROI).
      // Together: model centre in overlay coordinates = alignPosRef + scx/scy.
      // Convert logical-px offset to Three.js world position (camera-space, then → world).
      // FIX: Use viewport height from ROI, not full window height
      const pxPerWorld   = vpHeight / frustumH;               // logical px per world unit (zoom=1)
      const worldPerPx   = 1.0 / (camera.zoom * pxPerWorld);  // world units per logical px
      const dX = alignPosRef.current.x + (frame.scx ?? 0);    // px right  from overlay centre
      const dY = alignPosRef.current.y + (frame.scy ?? 0);    // px down   from overlay centre

      const camRight = _camRight.current.setFromMatrixColumn(camera.matrixWorld, 0);
      const camUp    = _camUp.current.setFromMatrixColumn(camera.matrixWorld, 1);
      modelGroup.position
        .set(0, 0, 0)
        .addScaledVector(camRight,  dX * worldPerPx)
        .addScaledVector(camUp,    -dY * worldPerPx);   // screen-down = world-up negative

      modelGroup.scale.setScalar(stateRef.current.modelScale);
      stateRef.current.needsRender = true;

      if (swFrameCount <= 5 || swFrameCount % 60 === 0) {
        setSwDebug(`SW #${swFrameCount} | s=${frame.s?.toFixed(3)} | dpi=${frame.dpi} | ms=${ms.toFixed(1)} | zoom=${autoZoom.toFixed(3)} | scx=${(frame.scx??0).toFixed(0)},scy=${(frame.scy??0).toFixed(0)}`);
      }
    };

    ipcRenderer.on(IPC.SW_CAMERA_UPDATE, handleSWCamera);
    return () => {
      ipcRenderer.removeListener(IPC.SW_CAMERA_UPDATE, handleSWCamera);
      ipcRenderer.removeListener(IPC.SW_BRIDGE_STATUS, onStatus);
    };
  }, []);

  // ── Annotate Mode Toggle ─────────────────────────────────────────

  useEffect(() => {
    const handler = (_event: any, enabled: boolean) => {
      setIsAnnotateMode(enabled);
    };
    ipcRenderer.on(IPC.OVERLAY_ANNOTATE_MODE, handler);
    return () => { ipcRenderer.removeListener(IPC.OVERLAY_ANNOTATE_MODE, handler); };
  }, []);

  // ── Edge Snap: Periodic overlay edge snapshot ───────────────────
  // Captures the overlay's rendered edges (already on screen), crops to viewport ROI,
  // converts to binary edge image, sends to main for Chamfer comparison.
  // Uses requestIdleCallback to avoid blocking animation frames.

  useEffect(() => {
    const SNAP_W = 200;  // Low-res for speed (half of viewport capture)
    const SNAP_H = 150;

    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = SNAP_W;
    snapCanvas.height = SNAP_H;
    const snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const doSnap = () => {
      if (cancelled) return;

      const { renderer } = stateRef.current;
      if (!renderer || !snapCtx) {
        timer = setTimeout(doSnap, 1000);
        return;
      }

      const vpW = currentAlignment.viewportWidth;
      const vpH = currentAlignment.viewportHeight;
      if (!vpW || !vpH) {
        timer = setTimeout(doSnap, 1000);
        return;
      }

      // Use requestIdleCallback so we don't block animation
      const idleCb = typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 50);

      idleCb(() => {
        if (cancelled) return;

        const displayW = window.innerWidth;
        const displayH = window.innerHeight;
        const vpCenterX = displayW / 2 + (currentAlignment.positionX || 0);
        const vpCenterY = displayH / 2 + (currentAlignment.positionY || 0);
        const vpLeft = vpCenterX - vpW / 2;
        const vpTop = vpCenterY - vpH / 2;

        // Read from already-rendered canvas (NO extra render call)
        const srcCanvas = renderer.domElement;
        snapCtx.clearRect(0, 0, SNAP_W, SNAP_H);
        snapCtx.drawImage(
          srcCanvas,
          vpLeft, vpTop, vpW, vpH,
          0, 0, SNAP_W, SNAP_H
        );

        const imgData = snapCtx.getImageData(0, 0, SNAP_W, SNAP_H);
        const rgba = imgData.data;
        const gray = new Uint8Array(SNAP_W * SNAP_H);

        for (let i = 0; i < SNAP_W * SNAP_H; i++) {
          gray[i] = rgba[i * 4 + 3] > 30 ? 255 : 0;
        }

        const buffer = gray.buffer.slice(0);
        ipcRenderer.send(IPC.EDGESNAP_OVERLAY_EDGES, buffer, SNAP_W, SNAP_H);

        // Schedule next snap (1fps)
        timer = setTimeout(doSnap, 1000);
      });
    };

    timer = setTimeout(doSnap, 2000);  // Start after 2s to let things settle
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [currentAlignment]);

  // ── Align Mode (mouse drag to rotate/pan/zoom) ─────────────────

  const [isAlignMode, setIsAlignMode] = useState(false);
  const dragRef = useRef<{ button: number; startX: number; startY: number; lastX: number; lastY: number } | null>(null);

  useEffect(() => {
    const handler = (_event: any, enabled: boolean) => { setIsAlignMode(enabled); };
    ipcRenderer.on(IPC.OVERLAY_ALIGN_MODE, handler);
    return () => { ipcRenderer.removeListener(IPC.OVERLAY_ALIGN_MODE, handler); };
  }, []);

  // ROI mask visualization
  useEffect(() => {
    const handler = (_event: any, regions: { viewCube: ScreenRegion; viewport: ScreenRegion } | null) => {
      setMaskRegions(regions);
    };
    ipcRenderer.on(IPC.ROI_VERIFY, handler);
    return () => { ipcRenderer.removeListener(IPC.ROI_VERIFY, handler); };
  }, []);

  const handleAlignMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isAlignMode) return;
    e.preventDefault();
    dragRef.current = { button: e.button, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
  }, [isAlignMode]);

  const handleAlignMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isAlignMode || !dragRef.current) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;

    if (dragRef.current.button === 0 && !e.shiftKey) {
      // Left-drag: rotate
      ipcRenderer.send(IPC.ALIGNMENT_NUDGE, { rotationY: dx * 0.3, rotationX: dy * 0.3 });
    } else {
      // Right-drag or shift+left-drag: pan
      ipcRenderer.send(IPC.ALIGNMENT_NUDGE, { positionX: dx, positionY: dy });
    }
  }, [isAlignMode]);

  const handleAlignMouseUp = useCallback(() => { dragRef.current = null; }, []);

  const handleAlignWheel = useCallback((e: React.WheelEvent) => {
    if (!isAlignMode) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.04 : 0.96;
    ipcRenderer.send(IPC.ALIGNMENT_NUDGE, { scale: factor });
  }, [isAlignMode]);

  // ── Annotation Handlers ──────────────────────────────────────────

  const handleAnnotationAdd = useCallback((worldPoint: THREE.Vector3, worldNormal: THREE.Vector3) => {
    const id = `ann_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newAnnotation: Annotation = {
      id,
      worldPoint: { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z },
      worldNormal: { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z },
      text: '',
      createdAt: Date.now(),
    };
    setAnnotations(prev => [...prev, newAnnotation]);
    // Notify main process
    ipcRenderer.send(IPC.ANNOTATION_ADD, newAnnotation);
  }, []);

  return (
    <>
      <div
        ref={containerRef}
        onMouseDown={handleAlignMouseDown}
        onMouseMove={handleAlignMouseMove}
        onMouseUp={handleAlignMouseUp}
        onMouseLeave={handleAlignMouseUp}
        onWheel={handleAlignWheel}
        onContextMenu={isAlignMode ? (e) => e.preventDefault() : undefined}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          overflow: 'hidden',
          background: 'transparent',
          transform: 'scaleX(-1)',  // Mirror fix: flip rendered output horizontally
          cursor: isAlignMode ? 'move' : 'default',
          pointerEvents: isAlignMode ? 'auto' : 'none',
        }}
      />
      {/* SW Bridge live debug */}
      {swDebug && (
        <div style={{
          position: 'fixed', bottom: 8, left: 8, zIndex: 200,
          padding: '3px 8px', borderRadius: 4,
          background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(0,217,255,0.4)',
          fontSize: 10, color: '#00d9ff', fontFamily: 'monospace',
          pointerEvents: 'none',
        }}>{swDebug}</div>
      )}
      {bridgeDebug && (
        <div style={{
          position: 'fixed', bottom: 28, left: 8, zIndex: 200,
          padding: '3px 8px', borderRadius: 4,
          background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,165,0,0.6)',
          fontSize: 10, color: '#ffa500', fontFamily: 'monospace',
          pointerEvents: 'none',
        }}>{bridgeDebug}</div>
      )}
      {/* Align mode indicator */}
      {isAlignMode && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 100, padding: '6px 16px', borderRadius: 20,
          background: 'rgba(0,217,255,0.15)', border: '1px solid rgba(0,217,255,0.4)',
          fontSize: 11, fontWeight: 600, color: '#00d9ff', fontFamily: 'system-ui',
          backdropFilter: 'blur(8px)', pointerEvents: 'none',
        }}>
          ALIGN MODE — Drag to rotate &middot; Shift+drag to pan &middot; Scroll to zoom
        </div>
      )}
      {/* Mask visualization (ROI verification) */}
      {maskRegions && (
        <>
          {/* View Cube mask — blue */}
          <div style={{
            position: 'fixed', pointerEvents: 'none', zIndex: 90,
            left: maskRegions.viewCube.x,
            top: maskRegions.viewCube.y,
            width: maskRegions.viewCube.width,
            height: maskRegions.viewCube.height,
            border: '2px solid rgba(0,150,255,0.8)',
            background: 'rgba(0,150,255,0.12)',
            borderRadius: 4,
          }}>
            <span style={{
              position: 'absolute', top: -18, left: 0,
              fontSize: 10, fontWeight: 700, color: 'rgba(0,150,255,0.9)',
              fontFamily: 'system-ui', textShadow: '0 1px 3px rgba(0,0,0,0.5)',
            }}>VIEW CUBE</span>
          </div>
          {/* Viewport mask — green */}
          <div style={{
            position: 'fixed', pointerEvents: 'none', zIndex: 90,
            left: maskRegions.viewport.x,
            top: maskRegions.viewport.y,
            width: maskRegions.viewport.width,
            height: maskRegions.viewport.height,
            border: '2px solid rgba(0,200,80,0.7)',
            background: 'rgba(0,200,80,0.08)',
            borderRadius: 4,
          }}>
            <span style={{
              position: 'absolute', top: -18, left: 0,
              fontSize: 10, fontWeight: 700, color: 'rgba(0,200,80,0.9)',
              fontFamily: 'system-ui', textShadow: '0 1px 3px rgba(0,0,0,0.5)',
            }}>CAD REGION</span>
          </div>
          {/* Verification banner */}
          <div style={{
            position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
            zIndex: 100, padding: '8px 20px', borderRadius: 20,
            background: 'rgba(0,0,0,0.7)', border: '1px solid rgba(255,255,255,0.15)',
            fontSize: 12, fontWeight: 600, color: '#fff', fontFamily: 'system-ui',
            pointerEvents: 'none',
          }}>
            Verify tracking regions — <span style={{ color: 'rgba(0,150,255,0.9)' }}>blue</span> = view cube, <span style={{ color: 'rgba(0,200,80,0.9)' }}>green</span> = CAD region
          </div>
        </>
      )}
      <AnnotationOverlay
        annotations={annotations}
        alignment={currentAlignment}
        camera={stateRef.current.camera}
        modelGroup={stateRef.current.modelGroup}
        width={windowSize.width}
        height={windowSize.height}
        isAnnotateMode={isAnnotateMode}
        onAnnotationAdd={handleAnnotationAdd}
        raycaster={stateRef.current.raycaster}
        scene={stateRef.current.scene || undefined}
      />
      {/* Vendor annotations from review session — rendered as SVG overlay */}
      {vendorAnnotations.length > 0 && (
        <svg
          style={{
            position: 'fixed', inset: 0, width: '100vw', height: '100vh',
            pointerEvents: 'none', zIndex: 150,
          }}
          viewBox={`0 0 ${windowSize.width} ${windowSize.height}`}
        >
          {vendorAnnotations.map((a: any) => {
            const color = '#FF6B35';
            const sw = 2;
            const W = windowSize.width;
            const H = windowSize.height;
            switch (a.type) {
              case 'pin':
                return (
                  <g key={a.id}>
                    <circle cx={(a.x || 0) * W} cy={(a.y || 0) * H} r={8} fill={color} opacity={0.9} />
                    <text x={(a.x || 0) * W + 12} y={(a.y || 0) * H + 4} fill={color} fontSize={13} fontWeight="bold" fontFamily="system-ui">
                      {a.text || ''}
                    </text>
                  </g>
                );
              case 'arrow':
                return (
                  <line key={a.id}
                    x1={(a.x1 || 0) * W} y1={(a.y1 || 0) * H}
                    x2={(a.x2 || 0) * W} y2={(a.y2 || 0) * H}
                    stroke={color} strokeWidth={sw} markerEnd="url(#vendor-arrow)"
                  />
                );
              case 'circle':
                return (
                  <ellipse key={a.id}
                    cx={(a.cx || 0) * W} cy={(a.cy || 0) * H}
                    rx={(a.rx || 0) * W} ry={(a.ry || 0) * H}
                    stroke={color} strokeWidth={sw} fill="none"
                  />
                );
              case 'freehand':
                if (!a.points || a.points.length < 2) return null;
                const d = a.points.map((p: any, i: number) =>
                  `${i === 0 ? 'M' : 'L'}${p.x * W},${p.y * H}`
                ).join(' ');
                return <path key={a.id} d={d} stroke={color} strokeWidth={sw} fill="none" />;
              case 'text':
                return (
                  <text key={a.id} x={(a.x || 0) * W} y={(a.y || 0) * H}
                    fill={color} fontSize={16} fontWeight="bold" fontFamily="system-ui">
                    {a.text || ''}
                  </text>
                );
              default:
                return null;
            }
          })}
          <defs>
            <marker id="vendor-arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" fill="#FF6B35" />
            </marker>
          </defs>
        </svg>
      )}
    </>
  );
}
