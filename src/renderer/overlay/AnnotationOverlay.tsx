/**
 * Annotation Overlay
 *
 * SVG layer on top of Three.js canvas for placing/displaying annotations
 * on the 3D model. Ported from hanomi-platform CadOverlayPage.jsx.
 *
 * Features:
 *   - Annotation pin (circle r=14, yellow accent)
 *   - Leader line (ASME Y14.2: 15-75° angles, horizontal shoulder)
 *   - Back-face detection: 35% opacity, dashed leader, no drop shadow
 *   - Stable label layout: force-directed offsets computed once, stored
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as THREE from 'three';
import { Annotation, AlignmentState } from '../../shared/types';
import { colors, fonts } from '../../shared/design-tokens';

interface AnnotationOverlayProps {
  annotations: Annotation[];
  alignment: AlignmentState;
  camera: THREE.OrthographicCamera | null;
  modelGroup: THREE.Group | null;
  width: number;
  height: number;
  isAnnotateMode: boolean;
  onAnnotationAdd?: (worldPoint: THREE.Vector3, worldNormal: THREE.Vector3) => void;
  raycaster?: THREE.Raycaster;
  scene?: THREE.Scene;
}

interface LabelOffset {
  dx: number;
  dy: number;
}

const PIN_RADIUS = 14;
const LABEL_WIDTH = 160;
const LABEL_HEIGHT = 32;
const SHOULDER_LENGTH = 30;

export function AnnotationOverlay({
  annotations,
  alignment,
  camera,
  modelGroup,
  width,
  height,
  isAnnotateMode,
  onAnnotationAdd,
  raycaster,
  scene,
}: AnnotationOverlayProps) {
  const labelOffsetsRef = useRef<Map<string, LabelOffset>>(new Map());
  const [, forceRender] = useState(0);

  // ── World-to-screen projection (uses current camera + model state) ──
  const worldToScreen = useCallback((worldPoint: { x: number; y: number; z: number }): { x: number; y: number } | null => {
    if (!camera || !modelGroup) return null;

    // The annotation worldPoint is in the original model coordinate space.
    // The model child inside modelGroup has position offset (-center) and
    // modelGroup has quaternion (from bridge) + scale.
    // Use the model child's matrixWorld to transform correctly.
    const modelChild = modelGroup.children[0];
    const matrix = modelChild ? modelChild.matrixWorld : modelGroup.matrixWorld;

    const vec = new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z);
    vec.applyMatrix4(matrix);
    vec.project(camera);

    return {
      x: (vec.x * 0.5 + 0.5) * width,
      y: (-vec.y * 0.5 + 0.5) * height,
    };
  }, [camera, modelGroup, width, height]);

  // ── Back-face detection ──────────────────────────────────────────
  const isBackFacing = useCallback((worldNormal: { x: number; y: number; z: number }): boolean => {
    if (!camera) return false;
    // Use actual camera direction
    const viewDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const normal = new THREE.Vector3(worldNormal.x, worldNormal.y, worldNormal.z);
    if (modelGroup) normal.applyQuaternion(modelGroup.quaternion);
    return normal.dot(viewDir) < 0;
  }, [camera, modelGroup]);

  // ── Force-directed label layout (computed once when items change) ──
  useEffect(() => {
    const offsets = new Map<string, LabelOffset>();
    const positions: { id: string; x: number; y: number }[] = [];

    for (const ann of annotations) {
      const screen = worldToScreen(ann.worldPoint);
      if (screen) {
        positions.push({ id: ann.id, x: screen.x, y: screen.y });
      }
    }

    // Simple radial offset layout
    const angleStep = (2 * Math.PI) / Math.max(positions.length, 1);
    positions.forEach((pos, i) => {
      const angle = angleStep * i - Math.PI / 4; // start NE
      const dist = 80 + (i % 2) * 30; // stagger
      offsets.set(pos.id, {
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
      });
    });

    labelOffsetsRef.current = offsets;
    forceRender(n => n + 1);
  }, [annotations.length]); // only recompute when annotation count changes

  // ── Click handler for annotation placement ───────────────────────
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!isAnnotateMode || !raycaster || !camera || !scene || !onAnnotationAdd) return;

    const mouse = new THREE.Vector2(
      (e.clientX / width) * 2 - 1,
      -(e.clientY / height) * 2 + 1
    );
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);
    const hit = intersects.find((i: any) => i.object.isMesh);

    if (hit) {
      const normal = hit.face
        ? hit.face.normal.clone().applyQuaternion(hit.object.getWorldQuaternion(new THREE.Quaternion()))
        : new THREE.Vector3(0, 1, 0);
      onAnnotationAdd(hit.point.clone(), normal);
    }
  }, [isAnnotateMode, raycaster, camera, scene, width, height, onAnnotationAdd]);

  // ── Render annotations ───────────────────────────────────────────
  const annotationElements = useMemo(() => {
    return annotations.map(ann => {
      const screen = worldToScreen(ann.worldPoint);
      if (!screen) return null;

      const backFacing = isBackFacing(ann.worldNormal);
      const opacity = backFacing ? 0.35 : 1;
      const offset = labelOffsetsRef.current.get(ann.id) || { dx: 60, dy: -60 };

      const anchorX = screen.x;
      const anchorY = screen.y;
      const labelX = anchorX + offset.dx;
      const labelY = anchorY + offset.dy;

      // Leader line: anchor → elbow → label edge
      // Horizontal shoulder extends from elbow to label
      const elbowX = labelX;
      const elbowY = anchorY + (labelY - anchorY) * 0.6;

      return (
        <g key={ann.id} opacity={opacity}>
          {/* Leader line */}
          <polyline
            points={`${anchorX},${anchorY} ${elbowX},${elbowY} ${labelX},${labelY}`}
            fill="none"
            stroke={colors.annotationYellow}
            strokeWidth={1.5}
            strokeDasharray={backFacing ? '4,3' : 'none'}
          />

          {/* Anchor pin */}
          <circle
            cx={anchorX}
            cy={anchorY}
            r={PIN_RADIUS}
            fill={colors.annotationPin}
            stroke={colors.textWhite}
            strokeWidth={2}
            filter={backFacing ? undefined : 'url(#pinShadow)'}
          />
          <text
            x={anchorX}
            y={anchorY + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fill={colors.textWhite}
            fontSize={10}
            fontWeight={700}
            fontFamily={fonts.sans}
          >
            {annotations.indexOf(ann) + 1}
          </text>

          {/* Label box */}
          <rect
            x={labelX - LABEL_WIDTH / 2}
            y={labelY - LABEL_HEIGHT / 2}
            width={LABEL_WIDTH}
            height={LABEL_HEIGHT}
            rx={6}
            fill="rgba(0,0,0,0.8)"
            stroke={colors.annotationYellow}
            strokeWidth={1}
          />
          <text
            x={labelX}
            y={labelY + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fill={colors.textWhite}
            fontSize={11}
            fontFamily={fonts.sans}
          >
            {ann.text || `Annotation ${annotations.indexOf(ann) + 1}`}
          </text>
        </g>
      );
    });
  }, [annotations, alignment.rotationX, alignment.rotationY, worldToScreen, isBackFacing]);

  return (
    <svg
      width={width}
      height={height}
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: isAnnotateMode ? 'auto' : 'none',
        cursor: isAnnotateMode ? 'crosshair' : 'default',
        zIndex: 10,
      }}
      onClick={handleClick}
    >
      <defs>
        <filter id="pinShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="1" stdDeviation="3" floodColor="rgba(0,0,0,0.3)" />
        </filter>
      </defs>
      {annotationElements}
    </svg>
  );
}
