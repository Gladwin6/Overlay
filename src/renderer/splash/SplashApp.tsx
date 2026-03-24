/**
 * Splash Screen — Cinematic terminal-style launch sequence.
 *
 * 7 phases: header fade → command typing (6% typo rate) → equations →
 * tagline → integration info → attractor builds progressively → hold + fade.
 * Pixel art: render at 1/3 resolution, image-rendering: pixelated.
 * ESC to skip, ~15s total.
 */

import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { pickRandomAttractor, buildTrajectories, AttractorDef, BuiltTrajectories } from './AttractorRenderer';
import { LOGO_SPLASH_BASE64 } from '../../shared/logo';

const { ipcRenderer } = window.require('electron');

const PIXEL_SCALE = 1;
const BUILD_SPEED = 80;
const STAGGER = 40;

// Adjacent keys for typo simulation
const ADJACENT_KEYS: Record<string, string> = {
  'a':'sqz','b':'vgn','c':'xdv','d':'sfe','e':'wrd','f':'dgr','g':'fht',
  'h':'gjy','i':'uoj','j':'hku','k':'jli','l':'kop','m':'nj','n':'bhm',
  'o':'ipl','p':'ol','q':'wa','r':'etf','s':'awd','t':'rfy','u':'yih',
  'v':'cfb','w':'qae','x':'zsc','y':'tgu','z':'asx',
};

function adjacentKey(ch: string): string {
  const lower = ch.toLowerCase();
  const adj = ADJACENT_KEYS[lower];
  if (!adj) return ch;
  const pick = adj[Math.floor(Math.random() * adj.length)];
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? pick.toUpperCase() : pick;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Orange torus logo — rendered as a smooth <img> tag */
function SplashLogo() {
  return (
    <img
      src={LOGO_SPLASH_BASE64}
      width={80}
      height={68}
      style={{ marginTop: 4, opacity: 0.95 }}
      alt="Hanomi"
    />
  );
}

export function SplashApp() {
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const loaderBarRef = useRef<HTMLDivElement>(null);
  const skippedRef = useRef(false);
  const [headerVisible, setHeaderVisible] = useState(false);
  const [terminalOpacity, setTerminalOpacity] = useState(1);
  const [canvasOpacity, setCanvasOpacity] = useState(0);
  const [loaderOpacity, setLoaderOpacity] = useState(0);
  const [skipText, setSkipText] = useState('ESC to skip');
  const attractorRef = useRef<AttractorDef>(pickRandomAttractor());
  const builtRef = useRef<BuiltTrajectories | null>(null);
  const groupRef = useRef<THREE.Group>(new THREE.Group());

  // ── Three.js Setup ─────────────────────────────────────────────

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
    camera.position.set(0, 0, 9);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0d1117, 1);

    const canvasEl = renderer.domElement;
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    canvasEl.style.imageRendering = 'auto';
    container.appendChild(canvasEl);

    const group = groupRef.current;
    group.rotation.x = Math.random() * Math.PI * 2;
    group.rotation.y = Math.random() * Math.PI * 2;
    group.rotation.z = Math.random() * Math.PI * 2;
    group.visible = false;
    scene.add(group);

    // Build trajectories
    builtRef.current = buildTrajectories(attractorRef.current, group);

    let frameId: number;
    function animate() {
      frameId = requestAnimationFrame(animate);
      if (group.visible) {
        group.rotation.y += 0.0012 * 1.9;
        group.rotation.x += 0.0005 * 1.9;
      }
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      renderer.dispose();
    };
  }, []);

  // ── ESC handler ────────────────────────────────────────────────

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') skipAll();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  // ── Skip All ───────────────────────────────────────────────────

  function skipAll() {
    if (skippedRef.current) return;
    skippedRef.current = true;

    setTerminalOpacity(0);
    groupRef.current.visible = true;
    setCanvasOpacity(1);

    if (builtRef.current) {
      for (const line of builtRef.current.lineObjs) {
        line.geometry.setDrawRange(0, builtRef.current.pts);
      }
    }

    setLoaderOpacity(1);
    if (loaderBarRef.current) loaderBarRef.current.style.width = '100%';

    setTimeout(() => {
      setSkipText('COMPLETE');
      notifyComplete();
    }, 600);
  }

  function notifyComplete() {
    ipcRenderer.send('splash:complete');
  }

  // ── Terminal Helpers ───────────────────────────────────────────

  function addLine(html?: string): HTMLDivElement {
    const div = document.createElement('div');
    div.style.minHeight = '1.75em';
    div.style.whiteSpace = 'pre-wrap';
    div.style.wordBreak = 'break-all';
    if (html) div.innerHTML = html;
    outputRef.current?.appendChild(div);
    return div;
  }

  async function humanType(parentEl: HTMLElement, text: string, baseDelay = 50) {
    const textNode = document.createTextNode('');
    const cursor = document.createElement('span');
    cursor.style.cssText = 'display:inline-block;width:7.8px;height:15px;background:#c9d1d9;vertical-align:text-bottom;animation:cursorBlink 1s step-end infinite';
    parentEl.appendChild(textNode);
    parentEl.appendChild(cursor);

    let current = '';
    for (let i = 0; i < text.length; i++) {
      if (skippedRef.current) { textNode.textContent = text; break; }

      if (Math.random() < 0.06 && /[a-zA-Z]/.test(text[i]) && i > 4 && i < text.length - 2) {
        current += adjacentKey(text[i]);
        textNode.textContent = current;
        await sleep(baseDelay + Math.random() * 25);
        await sleep(120 + Math.random() * 220);
        current = current.slice(0, -1);
        textNode.textContent = current;
        await sleep(55 + Math.random() * 35);
      }

      current += text[i];
      textNode.textContent = current;

      let d = baseDelay + (Math.random() - 0.5) * baseDelay * 0.7;
      if (text[i] === ' ') d += 18;
      if ('.,;:!?-'.includes(text[i])) d += 55;
      if (Math.random() < 0.07 && text[i] === ' ' && i > 5) d += 250 + Math.random() * 400;
      await sleep(Math.max(15, d));
    }
    cursor.remove();
  }

  async function streamLine(lineEl: HTMLDivElement, finalHTML: string, charDelay = 12) {
    const temp = document.createElement('div');
    temp.innerHTML = finalHTML;
    const plainText = temp.textContent || '';
    for (let i = 0; i < plainText.length; i++) {
      if (skippedRef.current) break;
      lineEl.textContent = plainText.substring(0, i + 1);
      await sleep(charDelay + Math.random() * 8);
    }
    lineEl.innerHTML = finalHTML;
  }

  // ── Main Sequence ──────────────────────────────────────────────

  useEffect(() => {
    const attractor = attractorRef.current;

    async function run() {
      if (skippedRef.current) return;

      try {
      // Phase 1: Header
      setHeaderVisible(true);
      await sleep(1000);

      // Phase 2: Command
      const cmdLine = addLine();
      const prompt = document.createElement('span');
      prompt.style.color = '#3fb950';
      prompt.textContent = '$ ';
      cmdLine.appendChild(prompt);

      const cmdSpan = document.createElement('span');
      cmdSpan.style.color = '#e6edf3';
      cmdLine.appendChild(cmdSpan);
      await humanType(cmdSpan, `Hanomi init --engine ${attractor.engine}`, 52);
      await sleep(500);

      // Phase 3: Output
      addLine();
      const l1 = addLine();
      await streamLine(l1, `<span style="color:#ff6b35">\u25CF</span> <span style="color:#e6edf3">Loading attractor engine</span>`, 18);
      await sleep(180);

      addLine(`  <span style="color:#30363d">\u2514\u2500</span> <span style="color:#8b949e">${attractor.name} system</span> <span style="color:#ff6b35">(${attractor.param})</span>`);
      await sleep(120);

      for (const eq of attractor.eqLines) {
        addLine(`  <span style="color:#30363d">\u2514\u2500</span> <span style="color:#484f58">${eq}</span>`);
        await sleep(90);
      }
      await sleep(350);
      addLine();

      // Phase 4: Tagline
      const tagLine = addLine();
      tagLine.innerHTML = `<span style="color:#ff6b35">\u25CF</span> `;
      const tagSpan = document.createElement('span');
      tagSpan.style.color = '#6e7681';
      tagLine.appendChild(tagSpan);
      await humanType(tagSpan, '"We enable engineers to become artists and inventors again."', 38);

      tagLine.innerHTML = `<span style="color:#ff6b35">\u25CF</span> <span style="color:#6e7681">"We enable engineers to become </span><span style="color:#ff6b35">artists</span><span style="color:#6e7681"> and </span><span style="color:#ff6b35">inventors</span><span style="color:#6e7681"> again."</span>`;
      await sleep(700);
      addLine();

      // Phase 5: Integration info
      const built = builtRef.current;
      if (!built) return;

      const l2 = addLine();
      await streamLine(l2, `<span style="color:#3fb950">\u25CF</span> <span style="color:#e6edf3">Integrating trajectories</span>`, 18);
      await sleep(150);

      addLine(`  <span style="color:#30363d">\u2514\u2500</span> <span style="color:#8b949e">${built.numTraj} trajectories \u00D7 ${built.pts.toLocaleString()} points</span>`);
      await sleep(120);
      addLine(`  <span style="color:#30363d">\u2514\u2500</span> <span style="color:#8b949e">RK4 integration (dt = ${attractor.dt})</span>`);
      await sleep(120);
      addLine(`  <span style="color:#30363d">\u2514\u2500</span> <span style="color:#8b949e">Normal blending \u00B7 orange/white/dark palette</span>`);
      await sleep(350);
      addLine();

      const renderLine = addLine();
      await streamLine(renderLine, `<span style="color:#3fb950">\u25CF</span> <span style="color:#e6edf3">Rendering attractor...</span>`, 20);
      await sleep(600);

      // Phase 6: Terminal dims, attractor builds
      setTerminalOpacity(0.10);
      groupRef.current.visible = true;
      setCanvasOpacity(1);
      await sleep(800);
      setLoaderOpacity(1);

      const maxProgress = built.pts + (built.numTraj - 1) * STAGGER;
      let buildProgress = 0;

      const b = built; // non-null (checked above)
      await new Promise<void>(resolve => {
        function buildStep() {
          if (skippedRef.current) { resolve(); return; }
          buildProgress += BUILD_SPEED;

          for (let t = 0; t < b.numTraj; t++) {
            const stagger = t * STAGGER;
            const count = Math.min(Math.max(0, buildProgress - stagger), b.pts);
            b.lineObjs[t].geometry.setDrawRange(0, count);
          }

          const pct = Math.min(100, (buildProgress / maxProgress) * 100);
          if (loaderBarRef.current) loaderBarRef.current.style.width = pct + '%';

          if (buildProgress < maxProgress) {
            requestAnimationFrame(buildStep);
          } else {
            resolve();
          }
        }
        buildStep();
      });

      // Phase 7: Hold + fade
      await sleep(4000);
      setTerminalOpacity(0);
      await sleep(500);
      setCanvasOpacity(0);
      setLoaderOpacity(0);
      await sleep(2000);
      setSkipText('COMPLETE');
      notifyComplete();

      } catch (err) {
        console.error('[Splash] Animation error:', err);
        // Still complete even if animation fails
        notifyComplete();
      }
    }

    run();
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0d1117' }}>
      <style>{`@keyframes cursorBlink { 50% { opacity: 0; } }`}</style>

      {/* Terminal */}
      <div
        ref={terminalRef}
        style={{
          position: 'fixed', inset: 0, zIndex: 10,
          padding: '28px 36px', overflow: 'hidden',
          opacity: terminalOpacity,
          transition: 'opacity 1.8s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 28,
          opacity: headerVisible ? 1 : 0, transition: 'opacity 0.8s ease',
        }}>
          <SplashLogo />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 6 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3', letterSpacing: 0.2 }}>
              Hanomi Platform v1.0.0
            </div>
            <div style={{ fontSize: 12, color: '#8b949e' }}>
              {attractorRef.current.name} Engine &middot; macOS
            </div>
            <div style={{ fontSize: 12, color: '#484f58' }}>~/Hanomi-overlay</div>
          </div>
        </div>
        <div ref={outputRef} style={{ fontSize: 13, lineHeight: 1.75 }} />
      </div>

      {/* 3D Canvas */}
      <div
        ref={canvasContainerRef}
        style={{
          position: 'fixed', inset: 0, zIndex: 5,
          opacity: canvasOpacity,
          transition: 'opacity 2.5s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />

      {/* Loader */}
      <div style={{
        position: 'fixed', bottom: 36, left: '50%', transform: 'translateX(-50%)',
        zIndex: 20, textAlign: 'center',
        opacity: loaderOpacity, transition: 'opacity 0.6s ease',
      }}>
        <div style={{ width: 120, height: 2, background: '#21262d' }}>
          <div ref={loaderBarRef} style={{ width: '0%', height: '100%', background: '#ff6b35', transition: 'width 0.2s linear' }} />
        </div>
        <div style={{ fontSize: 9, color: '#484f58', marginTop: 5, letterSpacing: 1.5 }}>RENDERING</div>
      </div>

      {/* Skip */}
      <div
        onClick={skipAll}
        style={{
          position: 'fixed', bottom: 14, right: 24,
          fontSize: 10, color: '#30363d', zIndex: 25, cursor: 'pointer',
        }}
      >
        {skipText}
      </div>
    </div>
  );
}
