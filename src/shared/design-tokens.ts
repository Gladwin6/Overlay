// Design tokens — direct hex values (not CSS vars, since Electron overlay has no DOM theme)
// Ported from hanomi-platform/src/tokens.js

export const colors = {
  // Brand
  brandOrange: '#ff6b35',
  brandOrangeDark: '#e55a2b',

  // Overlay-specific
  edgeDefault: '#00d9ff',
  edgeHighlight: '#ff6b35',
  faceDefault: '#b8b8b8',

  // Text
  textPrimary: '#1a1a1a',
  textSecondary: '#666666',
  textMuted: '#999999',
  textWhite: '#ffffff',

  // Backgrounds
  bgPrimary: '#ffffff',
  bgSecondary: '#f5f5f5',
  bgDark: '#1a1a1a',
  bgOverlay: 'rgba(0, 0, 0, 0.85)',

  // Status
  statusGreen: '#22c55e',
  statusYellow: '#f59e0b',
  statusRed: '#ef4444',

  // Annotations
  annotationYellow: '#fbbf24',
  annotationPin: '#f59e0b',

  // UI
  border: '#e5e5e5',
  borderLight: '#f0f0f0',
  shadow: 'rgba(0, 0, 0, 0.1)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
} as const;

export const fonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
} as const;
