import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './explorer/icons.tsx';
import { fileOfUrl, toBrowserUrl } from '@harv/shared';
import { browser, BROWSER_START, useBrowser } from '../../lib/browser.ts';
import { inApp } from '../../lib/desktop.ts';
import { openFile, useModified } from '../../lib/preview.ts';
import { dropSlot, setTabDragImage } from '../chat/tabDrag.ts';

/**
 * A chat's Browser view (the view switch; docs/PLAN.md §6x): page tabs, back / forward / reload, an
 * address bar, and the area the app's real web view sits over. One browser for every chat:
 * whichever chat shows it sees the same pages, Harv's browser tools use them too, and the view
 * says when Harv is at it. In a plain browser (not the app) there's no browser.
 */
export function BrowserView() {
  const { pages, active, busyUntil, known, downloads } = useBrowser();
  const started = useRef(false);
  const page = pages.find((p) => p.id === active) ?? null;
  const area = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = busyUntil > now;
  const strip = useRef<HTMLDivElement>(null);
  const [dragPage, setDragPage] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  // The newest download shows in the toolbar (handling downloads hides the engine's own notice):
  // while it runs, and for a minute after it ends.
  const download = downloads.at(-1) ?? null;
  const [doneWith, setDoneWith] = useState(0);
  const downloadEnded = !!download && download.state !== 'downloading';
  useEffect(() => {
    if (!download || !downloadEnded) return;
    const timer = window.setTimeout(() => setDoneWith(download.id), 60_000);
    return () => clearTimeout(timer);
  }, [download, downloadEnded]);
  const shown = download && download.id !== doneWith ? download : null;

  // The app's web view goes exactly over the page area, and away when this view isn't showing.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el || !inApp) return;
    const put = () => browser.place(el.getBoundingClientRect());
    put();
    const watch = new ResizeObserver(put);
    watch.observe(el);
    window.addEventListener('resize', put);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', put);
      browser.place(null);
    };
  }, []);

  // Picking Browser with no page open starts one, once the app has said it has none (a reload
  // opened a page each time before). Closing the last page later leaves it empty, with +.
  useEffect(() => {
    if (!inApp || !known || pages.length || started.current) return;
    started.current = true;
    void browser.open(BROWSER_START).catch(() => {});
  }, [known, pages.length]);

  // "Harv is using the browser" stays a few seconds after its last action.
  useEffect(() => {
    if (busyUntil <= Date.now()) return;
    const timer = window.setTimeout(() => setNow(Date.now()), busyUntil - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [busyUntil]);

  // A file of the user's (a mockup) reloads when it changes, like the preview pane.
  const file = page ? fileOfUrl(page.url) : null;
  const modified = useModified(file);
  const lastSeen = useRef<{ file: string; at: number } | null>(null);
  useEffect(() => {
    if (!file || !modified) return;
    const last = lastSeen.current;
    if (last?.file === file && last.at !== modified) void browser.reload();
    lastSeen.current = { file, at: modified };
  }, [file, modified]);

  if (!inApp) {
    return (
      <p className="m-auto max-w-sm p-6 text-center text-muted">
        The browser works in the Harv app (it uses real web views the app places here).
      </p>
    );
  }

  const go = (text: string) => {
    if (!text.trim()) return;
    const url = toBrowserUrl(text);
    void (page ? browser.navigate(url, page.id) : browser.open(url)).catch(() => {});
    setDraft(null);
  };
  const tool = 'flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg text-sm hover:bg-white/10 disabled:opacity-30';

  // Tabs reorder by dragging, like the chat tabs (the user's report, 2026-11-20); the app keeps the order.
  const slotAt = (x: number) => (strip.current ? dropSlot(strip.current, x) : null);
  const drop = (x: number) => {
    const slot = slotAt(x);
    const from = pages.findIndex((p) => p.id === dragPage);
    if (!slot || from < 0) return;
    let to = pages.findIndex((p) => String(p.id) === slot.id) + (slot.after ? 1 : 0);
    if (from < to) to -= 1;
    if (to !== from) void browser.move(dragPage!, to).catch(() => {});
  };
  const endDrag = () => {
    setDragPage(null);
    setDropAt(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Page tabs */}
      <div
        ref={strip}
        onDragOver={(e) => {
          if (dragPage === null) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const next = slotAt(e.clientX);
          if (next && (dropAt?.id !== next.id || dropAt.after !== next.after)) setDropAt(next);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
        }}
        onDrop={(e) => {
          if (dragPage === null) return;
          e.preventDefault();
          e.stopPropagation();
          drop(e.clientX);
          endDrag();
        }}
        className="flex min-w-0 items-center gap-1 border-b border-line px-2 pt-1.5"
      >
        {pages.map((p) => (
          <div
            key={p.id}
            data-tab={String(p.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-harv-page', String(p.id));
              e.dataTransfer.effectAllowed = 'move';
              setTabDragImage(e, p.title || p.url || 'New page');
              setDragPage(p.id);
            }}
            onDragEnd={endDrag}
            className={`flex max-w-[200px] min-w-[80px] flex-[0_1_200px] items-center rounded-t-lg border border-b-0 ${
              p.id === active ? 'border-[rgb(220_232_245/0.18)] bg-white/10' : 'border-transparent'
            } ${dragPage === p.id ? 'opacity-40' : ''} ${
              dragPage !== null && dragPage !== p.id && dropAt?.id === String(p.id)
                ? dropAt.after
                  ? 'shadow-[2px_0_0_0_var(--color-accent)]'
                  : 'shadow-[-2px_0_0_0_var(--color-accent)]'
                : ''
            }`}
          >
            <button
              type="button"
              onClick={() => void browser.select(p.id)}
              title={p.asleep ? `${p.url} (sleeping to save memory: opens again when picked)` : p.url}
              className={`min-w-0 flex-1 cursor-pointer truncate py-1.5 pl-2.5 text-left text-[11px] ${p.id === active ? 'text-ink' : p.asleep ? 'text-faint' : 'text-muted'}`}
            >
              {p.loading ? '◌ ' : p.asleep ? '☾ ' : ''}
              {p.title || p.url || 'New page'}
            </button>
            <button
              type="button"
              onClick={() => void browser.close(p.id)}
              aria-label={`Close ${p.title || 'page'}`}
              className="size-6 flex-none cursor-pointer rounded text-[12px] text-muted hover:bg-white/10"
            >
              <Icon name="close" size={12} className="mx-auto block" />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => void browser.open(BROWSER_START)} aria-label="New page" title="New page" className={tool}>
          +
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <button type="button" className={tool} disabled={!page} onClick={() => void browser.back()} aria-label="Back">
          ←
        </button>
        <button type="button" className={tool} disabled={!page} onClick={() => void browser.forward()} aria-label="Forward">
          →
        </button>
        <button type="button" className={tool} disabled={!page} onClick={() => void browser.reload()} aria-label="Reload">
          ⟳
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(draft ?? '');
          }}
        >
          <label htmlFor="browser-address" className="sr-only">
            Address
          </label>
          <input
            id="browser-address"
            value={draft ?? page?.url ?? ''}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => e.key === 'Escape' && (setDraft(null), e.currentTarget.blur())}
            placeholder="Search Google, or type an address or a file path"
            className="min-h-8 w-full rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60"
          />
        </form>
        {shown && (
          <button
            type="button"
            disabled={shown.state !== 'done'}
            onClick={() => openFile(shown.path, true)}
            title={
              shown.state === 'done'
                ? `Saved: ${shown.path}. Click to show it in its folder.`
                : shown.state === 'failed'
                  ? `The download from ${shown.url} failed.`
                  : `Downloading to ${shown.path}`
            }
            className={`animate-fade-in max-w-[220px] flex-none cursor-pointer truncate rounded-full border px-2.5 py-1 text-[11px] disabled:cursor-default ${
              shown.state === 'failed' ? 'border-warn/50 text-warn' : 'border-line text-muted hover:bg-white/10'
            }`}
          >
            ↓ {shown.state === 'failed' ? 'Download failed' : shown.path.split(/[\\/]/).pop()}
            {shown.state === 'downloading' ? '…' : ''}
          </button>
        )}
        {busy && (
          <span
            className="animate-fade-in flex-none rounded-full border border-accent/50 px-2.5 py-1 text-[11px] text-accent"
            role="status"
          >
            Harv is using the browser
          </span>
        )}
      </div>

      {/* The app's web view sits exactly here. It's a square native view CSS can't clip, so it keeps
          clear of the panel's rounded bottom corners (it covered them). */}
      <div ref={area} className="relative mx-2 mt-2 mb-2 min-h-0 flex-1 bg-black/20">
        {!pages.length && <p className="m-auto p-6 text-center text-muted">No page open. Press + or type an address.</p>}
      </div>
    </div>
  );
}
