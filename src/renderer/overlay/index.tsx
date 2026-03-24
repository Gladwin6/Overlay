import React from 'react';
import { createRoot } from 'react-dom/client';
import { OverlayApp } from './OverlayApp';

const root = createRoot(document.getElementById('root')!);
root.render(<OverlayApp />);
