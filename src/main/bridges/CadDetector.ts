/**
 * CadDetector — Auto-detects which CAD software is running and returns
 * the appropriate bridge configuration.
 *
 * Scans running processes for known CAD executables.
 * Works on Windows (tasklist) and macOS (ps).
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface DetectedCad {
  name: string;           // Human-readable name
  process: string;        // Process name found
  bridgeType: CadBridgeType;
  pid?: number;
}

export type CadBridgeType =
  | 'solidworks'
  | 'fusion360'
  | 'inventor'
  | 'autocad'
  | 'catia'
  | 'onshape'
  | 'freecad'
  | 'nx'
  | 'creo'
  | 'solidedge'
  | 'unknown';

// Process name → CAD info mapping
const CAD_SIGNATURES: { process: string; name: string; bridgeType: CadBridgeType }[] = [
  { process: 'SLDWORKS.exe',        name: 'SolidWorks',       bridgeType: 'solidworks' },
  { process: 'sldworks.exe',        name: 'SolidWorks',       bridgeType: 'solidworks' },
  { process: 'Fusion360.exe',       name: 'Fusion 360',       bridgeType: 'fusion360' },
  { process: 'fusion360.exe',       name: 'Fusion 360',       bridgeType: 'fusion360' },
  { process: 'Inventor.exe',        name: 'Inventor',         bridgeType: 'inventor' },
  { process: 'inventor.exe',        name: 'Inventor',         bridgeType: 'inventor' },
  { process: 'acad.exe',            name: 'AutoCAD',          bridgeType: 'autocad' },
  { process: 'CATIA.exe',           name: 'CATIA',            bridgeType: 'catia' },
  { process: 'CNEXT.exe',           name: 'CATIA V6/3DX',     bridgeType: 'catia' },
  { process: 'ugraf.exe',           name: 'NX (Siemens)',     bridgeType: 'nx' },
  { process: 'xtop.exe',            name: 'Creo (PTC)',       bridgeType: 'creo' },
  { process: 'Edge.exe',            name: 'Solid Edge',       bridgeType: 'solidedge' },
  { process: 'FreeCAD.exe',         name: 'FreeCAD',          bridgeType: 'freecad' },
  { process: 'freecad',             name: 'FreeCAD',          bridgeType: 'freecad' },
  { process: 'FreeCADLink.exe',     name: 'FreeCAD',          bridgeType: 'freecad' },
  // Onshape is browser-based — detect via window title
];

/**
 * Scan running processes and detect CAD software.
 * Returns all detected CAD applications (multiple can run simultaneously).
 */
export async function detectRunningCad(): Promise<DetectedCad[]> {
  const detected: DetectedCad[] = [];

  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? 'tasklist /FO CSV /NH'
      : 'ps -eo pid,comm';

    const { stdout } = await execAsync(cmd, { timeout: 5000 });

    if (isWin) {
      // Parse CSV: "process.exe","PID","Session","Session#","Memory"
      for (const line of stdout.split('\n')) {
        const match = line.match(/"([^"]+)","(\d+)"/);
        if (!match) continue;
        const [, procName, pidStr] = match;
        const sig = CAD_SIGNATURES.find(s =>
          s.process.toLowerCase() === procName.toLowerCase()
        );
        if (sig && !detected.find(d => d.bridgeType === sig.bridgeType)) {
          detected.push({
            name: sig.name,
            process: procName,
            bridgeType: sig.bridgeType,
            pid: parseInt(pidStr, 10),
          });
        }
      }
    } else {
      // Parse: PID COMM
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [pidStr, procName] = parts;
        const sig = CAD_SIGNATURES.find(s =>
          procName.toLowerCase().includes(s.process.toLowerCase())
        );
        if (sig && !detected.find(d => d.bridgeType === sig.bridgeType)) {
          detected.push({
            name: sig.name,
            process: procName,
            bridgeType: sig.bridgeType,
            pid: parseInt(pidStr, 10),
          });
        }
      }
    }

    // Check for Onshape (browser-based) — look for browser windows with "Onshape" in title
    if (isWin) {
      try {
        const { stdout: titles } = await execAsync(
          'powershell -Command "Get-Process | Where-Object {$_.MainWindowTitle -like \'*Onshape*\'} | Select-Object -First 1 Id,MainWindowTitle | Format-List"',
          { timeout: 3000 }
        );
        if (titles.includes('Onshape')) {
          detected.push({ name: 'Onshape', process: 'browser', bridgeType: 'onshape' });
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error('[CadDetector] Process scan failed:', err);
  }

  return detected;
}

/**
 * Get the best CAD to connect to (prefer SolidWorks > Fusion > Inventor > others).
 */
export async function detectBestCad(): Promise<DetectedCad | null> {
  const all = await detectRunningCad();
  if (all.length === 0) return null;

  // Priority order
  const priority: CadBridgeType[] = [
    'solidworks', 'fusion360', 'inventor', 'catia',
    'autocad', 'nx', 'creo', 'solidedge', 'freecad', 'onshape',
  ];

  for (const bt of priority) {
    const found = all.find(d => d.bridgeType === bt);
    if (found) return found;
  }

  return all[0];
}
