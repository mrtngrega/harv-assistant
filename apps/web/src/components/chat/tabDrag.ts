import { type DragEvent } from 'react';

// Dragging chat tabs in ChatPanel's tab bar: the drag picture and the slot a drop lands in.

/**
 * A small drag picture for a tab: the engine's own snapshot of the tab came out huge under
 * the mouse in WebKitGTK (the notebook's app). Off screen for the snapshot, removed right after.
 */
export function setTabDragImage(e: DragEvent, title: string) {
  const ghost = document.createElement('div');
  ghost.textContent = title;
  Object.assign(ghost.style, {
    position: 'fixed',
    top: '-1000px',
    left: '0',
    maxWidth: '180px',
    padding: '4px 10px',
    font: '12px "IBM Plex Mono", monospace',
    color: '#dce8f5',
    background: 'rgb(16 24 34 / 0.92)',
    border: '1px solid rgb(220 232 245 / 0.25)',
    borderRadius: '8px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

/** Where a tab dropped at `x` lands: before the first tab whose middle is right of it, else after the last. */
export function dropSlot(bar: HTMLElement, x: number): { id: string; after: boolean } | null {
  const tabs = [...bar.querySelectorAll<HTMLElement>('[data-tab]')];
  const before = tabs.find((t) => {
    const r = t.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  if (before) return { id: before.dataset.tab!, after: false };
  const last = tabs.at(-1);
  return last ? { id: last.dataset.tab!, after: true } : null;
}
