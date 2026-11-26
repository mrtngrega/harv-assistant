import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname } from 'node:path';
import { fullPath } from '../safety/paths.ts';
import { toBrowserUrl, type BrowserDownload, type BrowserHolds, type BrowserPage } from '@harv/shared';
import type { BrowserHost } from './browserHost.ts';
import { setBrowserRefs, type BrowserElement } from './browserRefs.ts';
import { humanCheckLine } from '../agent/blockedPages.ts';
import { localTarget } from '../safety/browser.ts';
import { isSecretFile } from '../safety/targets.ts';

// What Harv does in the shared browser (its browser_* tools): small scripts run in the page by
// the app (synchronous: the engines don't wait for promises), plus open/back through the app.
// Waiting for a page happens here, by asking again.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Keeps what goes back to the model small: it counts against the user's plan. */
const MAX_TEXT = 6000;

/** A downloaded file's name, from its path on either system. */
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** What became of downloads, as lines for the model (empty when there were none). */
export function formatDownloads(downloads: BrowserDownload[]): string {
  return downloads
    .map((d) =>
      d.state === 'done'
        ? `Downloaded ${fileName(d.path)} to ${d.path}`
        : d.state === 'failed'
          ? `The download from ${d.url} failed (the site refused it or it was cancelled)`
          : d.path
            ? `Still downloading ${fileName(d.path)} to ${d.path} (browser_tabs says when it's done)`
            : `Still downloading from ${d.url} into the Downloads folder (browser_tabs says when it's done)`,
    )
    .join('\n');
}

/** The browser's tabs as text for the model. */
export function formatTabs(pages: BrowserPage[], active: number | null): string {
  if (!pages.length) return 'No page tabs are open.';
  const lines = pages.map(
    (p) =>
      `[${p.id}] ${p.title || '(no title)'} · ${p.url}${p.id === active ? ' (showing)' : ''}${p.asleep ? ' (sleeping: reloads when picked)' : ''}`,
  );
  return `${pages.length} page tab${pages.length === 1 ? '' : 's'} (use the number with browser_switch):\n${lines.join('\n')}`;
}

/**
 * Numbers what can be clicked or typed into (data-harv-ref) and returns them with the page's
 * text. A function body: the app wraps it and returns its value.
 */
/**
 * Page helper: every match in the page and inside its open shadow roots (web components keep their
 * buttons and fields there, out of plain querySelectorAll: 2026-11-24).
 */
const DEEP_ALL = `
  const deepAll = (sel) => {
    const found = [];
    const walk = (root) => {
      found.push(...root.querySelectorAll(sel));
      for (const host of root.querySelectorAll('*')) if (host.shadowRoot) walk(host.shadowRoot);
    };
    walk(document);
    return found;
  };`;

export const SNAPSHOT_SCRIPT = `${DEEP_ALL}
  deepAll('[data-harv-ref]').forEach((el) => el.removeAttribute('data-harv-ref'));
  // Custom dropdowns, menus and toggles too (role=combobox/option/radio/switch…): many shops build their
  // selects from divs, and their choices are only these roles (2026-11-24).
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=checkbox], [role=radio], [role=switch], [role=option], [role=combobox], [role=treeitem], [role=slider], [role=spinbutton], [role=searchbox], [role=textbox], [aria-haspopup]:not([aria-haspopup=false]), [contenteditable=true], summary';
  const stateOf = (el) => {
    const s = [];
    const exp = el.getAttribute('aria-expanded');
    if (exp === 'true') s.push('open');
    else if (exp === 'false') s.push('closed');
    if (el.getAttribute('aria-selected') === 'true') s.push('selected');
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || (el.type === 'checkbox' || el.type === 'radio') && el.checked) s.push('checked');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('locked');
    return s.join(', ');
  };
  const out = [];
  const seen = new Set();
  let ref = 1;
  // A page nobody sees may not be laid out at all (the notebook's app in the tray: WebKitGTK gave
  // every link a 0×0 box, so Harv saw nothing to click, 2026-11-24): then sizes say nothing, and
  // only what the page itself hides is left out.
  const laidOut = innerWidth > 0 && innerHeight > 0 && document.body && document.body.getBoundingClientRect().width > 0;
  for (const el of deepAll(sel)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (laidOut && (r.width < 2 || r.height < 2 || r.bottom < -200 || r.top > innerHeight * 3)) continue;
    if (!laidOut && el.closest('[hidden], [aria-hidden=true]')) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const key = el.tagName + label + Math.round(r.top) + Math.round(r.left);
    if (seen.has(key)) continue;
    seen.add(key);
    const form = el.form || el.closest('form');
    const submit = form ? form.querySelector('button[type=submit], input[type=submit], button:not([type])') : null;
    el.setAttribute('data-harv-ref', String(ref));
    out.push({
      ref: ref++,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: label,
      type: (el.getAttribute('type') || '').toLowerCase(),
      name: [el.getAttribute('name'), el.id, el.getAttribute('autocomplete')].filter(Boolean).join(' ').slice(0, 80),
      formSubmit: submit ? (submit.innerText || submit.value || '').trim().slice(0, 60) : '',
      state: stateOf(el),
      ...(el instanceof HTMLSelectElement
        ? { options: [...el.options].slice(0, 40).map((o) => (o.selected ? '*' : '') + o.text.trim().slice(0, 40)), disabled: el.disabled }
        : {}),
    });
    if (out.length >= 150) break;
  }
  const main = document.querySelector('main, [role=main], article') || document.body;
  const text = (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${MAX_TEXT});
  return { url: location.href, title: document.title, elements: out, text };
`;

interface Snapshot {
  url: string;
  title: string;
  elements: BrowserElement[];
  text: string;
}

const elementLine = (e: BrowserElement) => {
  const line =
    `[${e.ref}] ${e.role || e.tag}${e.type ? `(${e.type})` : ''} ${e.tag === 'select' ? '' : e.text ? `"${e.text}"` : ''}${e.name ? ` · ${e.name}` : ''}`
      .replace(/\s+/g, ' ')
      .trim();
  const state = e.state || (e.disabled ? 'locked' : '');
  const withState = state ? `${line} (${state})` : line;
  if (!e.options) return withState;
  // A dropdown: its choices (* = picked), so browser_type can pick one by its text.
  return `${withState} options: ${e.options.map((o) => (o.startsWith('*') ? `[${o.slice(1)}]` : o)).join(' | ')}`;
};

/** A snapshot as text for the model: where, what can be used (by ref), and what the page says. */
export function formatSnapshot(s: Snapshot): string {
  return [
    `${s.title || '(no title)'} · ${s.url}`,
    '',
    // The exact inputs: the follow-up tools are deferred, and Haiku guessed {"element":"1"} before
    // loading them, two failed calls per click (2026-11-24).
    s.elements.length
      ? `Elements (use their numbers: browser_click {"ref": 3}, browser_type {"ref": 3, "text": "…", "submit": true}, browser_upload {"ref": 3, "path": "…"}):\n${s.elements.map(elementLine).join('\n')}`
      : 'No clickable elements found.',
    '',
    `Page text:\n${s.text || '(none)'}`,
  ].join('\n');
}

/** A page script that finds element `ref` from the last snapshot (or says it's gone). */
const byRef = (ref: number) =>
  `${DEEP_ALL} const el = deepAll('[data-harv-ref="${ref}"]')[0]; if (!el) return { gone: true }; el.scrollIntoView({ block: 'center' });`;

/** The largest file browser_upload carries into a page (it travels inside a page script). */
const MAX_UPLOAD = 20e6;
const TYPES: Record<string, string> = {
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const mimeOf = (path: string) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

const GONE = (ref: number) => `No element [${ref}] on the page any more (it changed). Take a new browser_snapshot.`;

/** Keys a page script can press on the focused element. */
const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
};

export class HarvBrowser {
  constructor(
    private host: BrowserHost,
    /** Tells the dashboards Harv is using the browser (the tab shows it). */
    private busy: () => void,
    /** Shows the browser in that chat (Harv opened pages the user had to go looking for, 2026-11-15). */
    private show: (tabId: string) => void = () => {},
  ) {}

  /** One browser action at a time: parallel calls raced and read each other's pages (2026-11-18). */
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private eval<T>(script: string): Promise<T> {
    return this.host.call('eval', { script }) as Promise<T>;
  }

  /** What the app says the browser holds (null if it couldn't say). */
  private holds(): Promise<BrowserHolds | null> {
    return this.host.call('list').then(
      (v) => v as BrowserHolds | null,
      () => null,
    );
  }

  /**
   * Runs a step that may start a download (a click, Enter, opening a file's address) and adds where
   * any file it downloaded landed: the app saves downloads in the user's Downloads folder and says
   * so (browser.rs on_download). Waits up to `waitMs` for one still on its way.
   */
  private async withDownloads(step: () => Promise<string>, waitMs = 30_000): Promise<string> {
    const lastId = (h: BrowserHolds | null) => Math.max(0, ...(h?.downloads ?? []).map((d) => d.id));
    const before = lastId(await this.holds());
    const said = await step();
    const end = Date.now() + waitMs;
    let mine: BrowserDownload[];
    for (;;) {
      mine = ((await this.holds())?.downloads ?? []).filter((d) => d.id > before);
      if (!mine.some((d) => d.state === 'downloading') || Date.now() >= end) break;
      await sleep(1000);
    }
    const note = formatDownloads(mine);
    return note ? `${said}\n\n[Downloads] ${note}` : said;
  }

  /** Waits until the page has loaded (or a while has passed), then a moment for scripts to draw it. */
  private async settle(ms = 15_000): Promise<void> {
    await sleep(400);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const state = await this.eval<string>('return document.readyState').catch(() => 'loading');
      if (state === 'complete') break;
      await sleep(400);
    }
    await sleep(600);
  }

  snapshot(): Promise<string> {
    return this.serial(() => this.read());
  }

  private async read(): Promise<string> {
    this.busy();
    const s = await this.eval<Snapshot | null>(SNAPSHOT_SCRIPT);
    if (!s) return 'The page gave no answer (still loading?). Try again.';
    // Wherever the page ended up (a link, a redirect, a page Harv wrote): never a login secret (the full review, S1).
    const file = localTarget(s.url);
    if (file && isSecretFile(file)) {
      await this.host.call('navigate', { url: 'about:blank' }).catch(() => undefined);
      return `Refused: the page went to ${file}, which may hold login secrets; Harv never reads those. Do the rest of the task.`;
    }
    setBrowserRefs(s.url, s.elements);
    const check = humanCheckLine(s.title, s.text);
    return check ? `${check}\n\n${formatSnapshot(s)}` : formatSnapshot(s);
  }

  /**
   * Opens `target` (an address, a file path or words to search) in a new page tab, and reads it.
   * Tabs are cheap to keep: the app keeps only the few most recent live and puts the rest to
   * sleep (browser.rs AWAKE; ten live tabs made the notebook hot, 2026-11-18).
   */
  open(target: string, sameTab = false, tabId?: string): Promise<string> {
    return this.serial(async () => {
      this.busy();
      if (tabId) this.show(tabId);
      const url = toBrowserUrl(target, homedir());
      return this.withDownloads(async () => {
        await this.host.call(sameTab ? 'navigate' : 'open', { url });
        await this.settle();
        return this.read();
      });
    });
  }

  /** Closes the page tab that is showing. */
  close(): Promise<string> {
    return this.serial(async () => {
      this.busy();
      await this.host.call('close');
      return 'Closed the page tab that was showing.';
    });
  }

  /** The page tabs, numbered by id, with the showing one and the sleeping ones marked. */
  tabs(): Promise<string> {
    return this.serial(async () => {
      const state = (await this.host.call('list')) as BrowserHolds | null;
      const tabs = formatTabs(state?.pages ?? [], state?.active ?? null);
      const downloads = formatDownloads((state?.downloads ?? []).slice(-5));
      return downloads ? `${tabs}\n\nRecent downloads (newest last):\n${downloads}` : tabs;
    });
  }

  /** Shows tab `id` (waking it if it sleeps), and reads it. */
  select(id: number, tabId?: string): Promise<string> {
    return this.serial(async () => {
      this.busy();
      if (tabId) this.show(tabId);
      await this.host.call('select', { id });
      await this.settle();
      return this.read();
    });
  }

  click(ref: number): Promise<string> {
    return this.serial(() => this.withDownloads(() => this.clickNow(ref)));
  }

  private async clickNow(ref: number): Promise<string> {
    this.busy();
    const r = await this.eval<{ gone?: boolean } | null>(`${byRef(ref)} el.click(); return { clicked: true };`);
    if (!r || r.gone) return GONE(ref);
    await this.settle(8000);
    const where = await this.eval<{ title: string; url: string }>('return { title: document.title, url: location.href }');
    return `Clicked [${ref}]. Now on: ${where.title || '(no title)'} · ${where.url}. Take a browser_snapshot to see the page.`;
  }

  /** Types into a field (replacing what's there), like the user would; submit sends Enter / the form. */
  type(ref: number, value: string, submit: boolean): Promise<string> {
    return this.serial(() => (submit ? this.withDownloads(() => this.typeNow(ref, value, submit)) : this.typeNow(ref, value, submit)));
  }

  private async typeNow(ref: number, value: string, submit: boolean): Promise<string> {
    this.busy();
    const r = await this.eval<{ gone?: boolean; picked?: string; choices?: string[]; locked?: boolean } | null>(`${byRef(ref)}
      el.focus();
      const text = ${JSON.stringify(value)};
      if (el instanceof HTMLSelectElement) {
        // A dropdown: pick the option by its text (what the user sees) or its value, like choosing it.
        if (el.disabled) return { locked: true };
        const want = text.trim().toLowerCase();
        const opts = [...el.options];
        const o = opts.find((x) => x.text.trim().toLowerCase() === want) || opts.find((x) => x.value.toLowerCase() === want)
          || opts.find((x) => x.text.trim().toLowerCase().includes(want));
        if (!o) return { choices: opts.map((x) => x.text.trim()).slice(0, 40) };
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, o.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { picked: o.text.trim() };
      }
      if (el.isContentEditable) {
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, text);
      } else {
        // The native setter, so pages built with React and the like see the change.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (${submit}) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        const form = el.form || el.closest('form');
        if (go && form) form.requestSubmit ? form.requestSubmit() : form.submit();
      }
      return { typed: true };`);
    if (!r || r.gone) return GONE(ref);
    if (r.locked) return `Dropdown [${ref}] is locked (disabled): the page unlocks it after an earlier choice. Pick that first.`;
    if (r.choices) return `Dropdown [${ref}] has no option "${value}". Its options: ${r.choices.join(' | ')}.`;
    if (r.picked !== undefined) {
      await sleep(500);
      return `Picked "${r.picked}" in dropdown [${ref}]. Take a browser_snapshot: the page may have changed (other dropdowns unlocked, prices shown).`;
    }
    if (submit) await this.settle(8000);
    return submit ? `Typed into [${ref}] and submitted. Take a browser_snapshot to see the result.` : `Typed into [${ref}].`;
  }

  press(key: string): Promise<string> {
    return this.serial(() => this.withDownloads(() => this.pressNow(key)));
  }

  private async pressNow(key: string): Promise<string> {
    this.busy();
    const k = KEYS[key.toLowerCase().replace(/\s+/g, '')];
    if (!k)
      return `Unknown key "${key}". Known: ${Object.values(KEYS)
        .map((x) => x.code)
        .join(', ')}.`;
    await this.eval(`
      const el = document.activeElement || document.body;
      const opts = { key: ${JSON.stringify(k.key)}, code: ${JSON.stringify(k.code)}, keyCode: ${k.keyCode}, which: ${k.keyCode}, bubbles: true, cancelable: true };
      const go = el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (go && opts.key === 'Enter') { const form = el.form || el.closest && el.closest('form'); if (form) form.requestSubmit ? form.requestSubmit() : form.submit(); else if (el.click && el !== document.body) el.click(); }
      if (go && opts.key === 'PageDown') scrollBy(0, innerHeight * 0.85);
      if (go && opts.key === 'PageUp') scrollBy(0, -innerHeight * 0.85);
      return true;`);
    if (k.key === 'Enter') await this.settle(8000);
    return `Pressed ${k.key}.`;
  }

  scroll(direction: 'up' | 'down'): Promise<string> {
    return this.serial(async () => {
      this.busy();
      const at = await this.eval<{ y: number; max: number }>(
        `scrollBy(0, ${direction === 'down' ? '' : '-'}innerHeight * 0.85); return { y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) };`,
      );
      return `Scrolled ${direction} (${at.y} of ${at.max} px). Take a browser_snapshot to read what's shown.`;
    });
  }

  /**
   * Puts a file from this computer into the page: into its upload box (a file input, also a hidden one
   * of the element's form), else dropped onto the element like a drag from the file manager. The page
   * gets it the way a picked file arrives, with no file dialog (the ShopNotes chat, 2026-11-23: desktop
   * clicks on Gmail's paper clip did nothing, so a mail went out without its zip).
   */
  upload(ref: number, path: string): Promise<string> {
    return this.serial(async () => {
      this.busy();
      const file = fullPath(path);
      if (isSecretFile(file)) return `Refused: ${file} may hold login secrets; Harv never sends those.`;
      let size: number;
      try {
        const s = statSync(file);
        if (!s.isFile()) return `${file} is not a file. Pack a folder into a zip first.`;
        size = s.size;
      } catch {
        return `No file at ${file}.`;
      }
      if (size > MAX_UPLOAD)
        return `${basename(file)} is ${Math.round(size / 1e6)} MB; the browser takes files up to ${MAX_UPLOAD / 1e6} MB this way. Share a big one by a link (Drive) instead.`;
      const data = readFileSync(file).toString('base64');
      const r = await this.eval<{ gone?: boolean; via?: string } | null>(`${byRef(ref)}
        const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0));
        const file = new File([bytes], ${JSON.stringify(basename(file))}, { type: ${JSON.stringify(mimeOf(file))}, lastModified: Date.now() });
        const dt = new DataTransfer();
        dt.items.add(file);
        const isFile = (x) => x && x.tagName === 'INPUT' && x.type === 'file';
        const input = isFile(el) ? el : el.querySelector('input[type=file]') || (el.form || el.closest('form') || document.createElement('i')).querySelector('input[type=file]');
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { via: 'input' };
        }
        for (const type of ['dragenter', 'dragover', 'drop'])
          el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        return { via: 'drop' };`);
      if (!r || r.gone) return GONE(ref);
      await sleep(1500);
      return `Put ${basename(file)} (${Math.round(size / 1024)} KB) into [${ref}] (${r.via === 'input' ? 'its upload box' : 'dropped onto it'}). Take a browser_snapshot and check the page shows it (an attachment chip, a file name) before you go on; if it doesn't, try the page's drop area or another element.`;
    });
  }

  back(): Promise<string> {
    return this.serial(async () => {
      this.busy();
      await this.host.call('back');
      await this.settle(8000);
      return this.read();
    });
  }
}
