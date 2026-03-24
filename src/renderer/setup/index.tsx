import React from 'react';
import { createRoot } from 'react-dom/client';
import { SetupApp } from './SetupApp';

const root = createRoot(document.getElementById('root')!);
root.render(<SetupApp />);
