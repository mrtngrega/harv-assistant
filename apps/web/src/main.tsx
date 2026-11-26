import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './index.css';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { startSocket } from './lib/socket.ts';
import './lib/layout.ts';
import './lib/desktop.ts';
import { startNotices } from './lib/noticeFeed.ts';

// Every import loaded: index.html's watchdog won't reload the page.
document.documentElement.dataset.ran = '1';

startSocket();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary whole>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Harv's notices (docs/PLAN.md §6ad): server messages become the bubble, Recent and the sounds.
startNotices();
