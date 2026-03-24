/**
 * Attractor Renderer — RK4 integrator for chaotic strange attractors.
 * 6 systems, trajectory builder, centering, progressive draw.
 * Renders at 1/3 resolution (PIXEL_SCALE=3) with pixelated upscale.
 */

import * as THREE from 'three';

export interface AttractorDef {
  name: string;
  engine: string;
  param: string;
  deriv: (x: number, y: number, z: number) => [number, number, number];
  dt: number;
  scale: number;
  spread: number;
  eqLines: string[];
}

export const ATTRACTORS: AttractorDef[] = [
  {
    name: 'Thomas', engine: 'thomas', param: 'b = 0.208186',
    deriv: (x, y, z) => [Math.sin(y) - 0.208186 * x, Math.sin(z) - 0.208186 * y, Math.sin(x) - 0.208186 * z],
    dt: 0.02, scale: 0.22, spread: 8,
    eqLines: ['dx/dt = sin(y) \u2013 bx', 'dy/dt = sin(z) \u2013 by', 'dz/dt = sin(x) \u2013 bz'],
  },
  {
    name: 'Halvorsen', engine: 'halvorsen', param: 'a = 1.89',
    deriv: (x, y, z) => [-1.89 * x - 4 * y - 4 * z - y * y, -1.89 * y - 4 * z - 4 * x - z * z, -1.89 * z - 4 * x - 4 * y - x * x],
    dt: 0.004, scale: 0.06, spread: 6,
    eqLines: ['dx/dt = \u2013ax \u2013 4y \u2013 4z \u2013 y\u00B2', 'dy/dt = \u2013ay \u2013 4z \u2013 4x \u2013 z\u00B2', 'dz/dt = \u2013az \u2013 4x \u2013 4y \u2013 x\u00B2'],
  },
  {
    name: 'Aizawa', engine: 'aizawa', param: 'a=0.95 b=0.7 d=3.5',
    deriv: (x, y, z) => {
      const a = 0.95, b = 0.7, d = 3.5, e = 0.25, f = 0.1;
      return [(z - b) * x - d * y, d * x + (z - b) * y, 0.6 + a * z - z * z * z / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x];
    },
    dt: 0.005, scale: 0.45, spread: 3,
    eqLines: ['dx/dt = (z\u2013b)x \u2013 dy', 'dy/dt = dx + (z\u2013b)y', 'dz/dt = c + az \u2013 z\u00B3/3 \u2013 r\u00B2'],
  },
  {
    name: 'Chen\u2013Lee', engine: 'chen-lee', param: 'a=5 b=\u221210 c=\u22120.38',
    deriv: (x, y, z) => [5 * x - y * z, -10 * y + x * z, -0.38 * z + x * y / 3],
    dt: 0.002, scale: 0.03, spread: 20,
    eqLines: ['dx/dt = ax \u2013 yz', 'dy/dt = by + xz', 'dz/dt = cz + xy/3'],
  },
  {
    name: 'Nose\u2013Hoover', engine: 'nose-hoover', param: 'a = 1.5',
    deriv: (x, y, z) => [y, -x + y * z, 1.5 - y * y],
    dt: 0.01, scale: 0.35, spread: 4,
    eqLines: ['dx/dt = y', 'dy/dt = \u2013x + yz', 'dz/dt = a \u2013 y\u00B2'],
  },
  {
    name: 'Hadley', engine: 'hadley', param: 'a=0.2 b=4 f=8',
    deriv: (x, y, z) => {
      const a = 0.2, b = 4, f = 8, g = 1;
      return [-y * y - z * z - a * x + a * f, x * y - b * x * z - y + g, b * x * y + x * z - z];
    },
    dt: 0.005, scale: 0.30, spread: 5,
    eqLines: ['dx/dt = \u2013y\u00B2 \u2013 z\u00B2 \u2013 ax + af', 'dy/dt = xy \u2013 bxz \u2013 y + g', 'dz/dt = bxy + xz \u2013 z'],
  },
];

function rk4(deriv: AttractorDef['deriv'], x: number, y: number, z: number, dt: number): [number, number, number] {
  const [k1x, k1y, k1z] = deriv(x, y, z);
  const [k2x, k2y, k2z] = deriv(x + k1x * dt / 2, y + k1y * dt / 2, z + k1z * dt / 2);
  const [k3x, k3y, k3z] = deriv(x + k2x * dt / 2, y + k2y * dt / 2, z + k2z * dt / 2);
  const [k4x, k4y, k4z] = deriv(x + k3x * dt, y + k3y * dt, z + k3z * dt);
  return [
    x + (k1x + 2 * k2x + 2 * k3x + k4x) * dt / 6,
    y + (k1y + 2 * k2y + 2 * k3y + k4y) * dt / 6,
    z + (k1z + 2 * k2z + 2 * k3z + k4z) * dt / 6,
  ];
}

export interface BuiltTrajectories {
  numTraj: number;
  pts: number;
  lineObjs: THREE.Line[];
}

export function buildTrajectories(
  attractor: AttractorDef,
  group: THREE.Group,
  seeds = 3,
  siblings = 1,
  perturb = 0.30,
  pts = 15000,
): BuiltTrajectories {
  const numTraj = seeds * siblings;
  const trajs: Float32Array[] = [];

  for (let s = 0; s < seeds; s++) {
    for (let sib = 0; sib < siblings; sib++) {
      let x = (Math.random() - 0.5) * attractor.spread + (Math.random() - 0.5) * perturb;
      let y = (Math.random() - 0.5) * attractor.spread + (Math.random() - 0.5) * perturb;
      let z = (Math.random() - 0.5) * attractor.spread + (Math.random() - 0.5) * perturb;
      const warmup = 2000 + (s * siblings + sib) * 2500;
      for (let i = 0; i < warmup; i++) [x, y, z] = rk4(attractor.deriv, x, y, z, attractor.dt);
      const arr: number[] = [];
      for (let i = 0; i < pts; i++) {
        [x, y, z] = rk4(attractor.deriv, x, y, z, attractor.dt);
        arr.push(x * attractor.scale, y * attractor.scale, z * attractor.scale);
      }
      trajs.push(new Float32Array(arr));
    }
  }

  // Center
  let cx = 0, cy = 0, cz = 0, tot = 0;
  for (const t of trajs) {
    for (let i = 0; i < pts; i++) {
      cx += t[i * 3]; cy += t[i * 3 + 1]; cz += t[i * 3 + 2]; tot++;
    }
  }
  cx /= tot; cy /= tot; cz /= tot;
  for (const t of trajs) {
    for (let i = 0; i < pts; i++) {
      t[i * 3] -= cx; t[i * 3 + 1] -= cy; t[i * 3 + 2] -= cz;
    }
  }

  const lineObjs: THREE.Line[] = [];
  for (let t = 0; t < numTraj; t++) {
    const color = t % 2 === 0 ? new THREE.Color('#ff6b35') : new THREE.Color('#ffffff');
    const opacity = t % 2 === 0 ? 0.5 : 0.35;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(trajs[t], 3));
    geo.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.NormalBlending, depthTest: false, depthWrite: false,
    });

    const line = new THREE.Line(geo, mat);
    group.add(line);
    lineObjs.push(line);
  }

  return { numTraj, pts, lineObjs };
}

export function pickRandomAttractor(): AttractorDef {
  return ATTRACTORS[Math.floor(Math.random() * ATTRACTORS.length)];
}
