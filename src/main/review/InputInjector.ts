/**
 * InputInjector — Translates vendor mouse/keyboard events to OS-level input.
 * Uses robotjs for cross-platform input simulation.
 * Events use normalized 0-1 coordinates; this module converts them to
 * absolute screen pixels within the designer's ROI.
 */

const robot = require('robotjs');

// Speed up robotjs — disable mouse movement delay
robot.setMouseDelay(0);
robot.setKeyboardDelay(0);

interface ROI {
  x: number;      // screen-space left
  y: number;      // screen-space top
  width: number;
  height: number;
}

interface ControlInput {
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'wheel' | 'keydown' | 'keyup';
  x?: number;      // normalized 0-1
  y?: number;
  button?: number;  // 0=left, 1=middle, 2=right
  deltaY?: number;
  key?: string;
  code?: string;
  modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean };
}

const BUTTON_MAP: Record<number, string> = {
  0: 'left',
  1: 'middle',
  2: 'right',
};

export class InputInjector {
  private roi: ROI | null = null;
  private active = false;

  setROI(roi: ROI): void {
    this.roi = roi;
    console.log(`[InputInjector] ROI set: ${roi.x},${roi.y} ${roi.width}x${roi.height}`);
  }

  start(): void {
    this.active = true;
    console.log('[InputInjector] Active — accepting vendor input');
  }

  stop(): void {
    this.active = false;
    console.log('[InputInjector] Stopped');
  }

  inject(event: ControlInput): void {
    if (!this.active || !this.roi) return;

    const { type } = event;

    // Mouse events — convert normalized coords to screen pixels within ROI
    if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup') {
      if (event.x === undefined || event.y === undefined) return;
      const screenX = Math.round(this.roi.x + event.x * this.roi.width);
      const screenY = Math.round(this.roi.y + event.y * this.roi.height);

      if (type === 'mousemove') {
        robot.moveMouse(screenX, screenY);
      } else if (type === 'mousedown') {
        robot.moveMouse(screenX, screenY);
        const btn = BUTTON_MAP[event.button ?? 0] || 'left';
        robot.mouseToggle('down', btn);
      } else if (type === 'mouseup') {
        robot.moveMouse(screenX, screenY);
        const btn = BUTTON_MAP[event.button ?? 0] || 'left';
        robot.mouseToggle('up', btn);
      }
    }

    // Scroll
    if (type === 'wheel' && event.deltaY !== undefined) {
      // robotjs scrollMouse: positive = up, negative = down
      // Browser wheel: positive deltaY = scroll down
      const scrollAmount = Math.round(-event.deltaY / 30);
      if (scrollAmount !== 0) {
        robot.scrollMouse(0, scrollAmount);
      }
    }

    // Keyboard — only whitelisted keys (validated server-side, but double-check)
    if (type === 'keydown' || type === 'keyup') {
      const key = mapKeyToRobotjs(event.code || event.key || '');
      if (!key) return;

      const modifiers: string[] = [];
      if (event.modifiers?.ctrl) modifiers.push('control');
      if (event.modifiers?.shift) modifiers.push('shift');
      if (event.modifiers?.alt) modifiers.push('alt');

      if (type === 'keydown') {
        robot.keyToggle(key, 'down', modifiers);
      } else {
        robot.keyToggle(key, 'up', modifiers);
      }
    }
  }
}

function mapKeyToRobotjs(code: string): string | null {
  const MAP: Record<string, string> = {
    'ArrowUp': 'up',
    'ArrowDown': 'down',
    'ArrowLeft': 'left',
    'ArrowRight': 'right',
    'Tab': 'tab',
    'Enter': 'enter',
    'Escape': 'escape',
    'Delete': 'delete',
    'Backspace': 'backspace',
    'PageUp': 'pageup',
    'PageDown': 'pagedown',
    'Home': 'home',
    'End': 'end',
    'Space': 'space',
  };
  return MAP[code] || null;
}
