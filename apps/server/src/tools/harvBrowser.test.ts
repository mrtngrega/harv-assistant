import { describe, expect, it } from 'vitest';
import type { BrowserHost } from './browserHost.ts';
import { formatDownloads, formatSnapshot, formatTabs, HarvBrowser } from './harvBrowser.ts';

/** A host whose click starts a download that ends on the third look (old downloads stay old). */
const downloadingHost = (finish: 'done' | 'failed') => {
  let looks = 0;
  const old = { id: 4, url: 'https://old.test/a.zip', path: '/home/u/Downloads/a.zip', state: 'done' };
  return {
    call: (action: string, params: { script?: string } = {}) => {
      if (action === 'eval')
        return Promise.resolve(params.script?.includes('readyState') ? 'complete' : { title: 'Shop', url: 'https://shop.test' });
      if (action !== 'list') return Promise.resolve(null);
      looks += 1;
      if (looks === 1) return Promise.resolve({ pages: [], active: null, downloads: [old] });
      const made = {
        id: 5,
        url: 'https://shop.test/invoice.pdf',
        path: '/home/u/Downloads/invoice (1).pdf',
        state: looks >= 3 ? finish : 'downloading',
      };
      return Promise.resolve({ pages: [], active: null, downloads: [old, made] });
    },
  } as unknown as BrowserHost;
};

describe('downloads in Harv’s browser (2026-11-24: nothing said where a file landed)', () => {
  it('a click that downloads says where the new file landed, not older ones', async () => {
    const said = await new HarvBrowser(downloadingHost('done'), () => {}).click(1);
    expect(said).toContain('[Downloads] Downloaded invoice (1).pdf to /home/u/Downloads/invoice (1).pdf');
    expect(said).not.toContain('a.zip');
  }, 20_000);

  it('a failed download says so', async () => {
    const said = await new HarvBrowser(downloadingHost('failed'), () => {}).click(1);
    expect(said).toContain('The download from https://shop.test/invoice.pdf failed');
  }, 20_000);

  it('names files from Windows paths too, and a slow one as still downloading', () => {
    expect(formatDownloads([{ id: 1, url: 'u', path: 'C:\\Users\\u\\Downloads\\x.zip', state: 'downloading' }])).toBe(
      "Still downloading x.zip to C:\\Users\\u\\Downloads\\x.zip (browser_tabs says when it's done)",
    );
    expect(formatDownloads([])).toBe('');
  });
});

/** A host that answers like a loaded, empty page. */
const fakeHost = (calls: string[]) =>
  ({
    call: (action: string, params: { script?: string } = {}) => {
      calls.push(action);
      if (action === 'eval') return Promise.resolve(params.script?.includes('readyState') ? 'complete' : null);
      return Promise.resolve({ id: 1 });
    },
  }) as unknown as BrowserHost;

describe('HarvBrowser.open', () => {
  it('shows the Browser view of the chat that opened a page, before loading it', async () => {
    const calls: string[] = [];
    const shown: string[] = [];
    const browser = new HarvBrowser(
      fakeHost(calls),
      () => {},
      (tabId) => (shown.push(tabId), calls.push('show')),
    );
    await browser.open('https://example.com', false, 'tab-1');
    expect(shown).toEqual(['tab-1']);
    expect(calls.indexOf('show')).toBeLessThan(calls.indexOf('open'));
  }, 10_000);

  it('shows nothing without a chat', async () => {
    const shown: string[] = [];
    const browser = new HarvBrowser(
      fakeHost([]),
      () => {},
      (tabId) => shown.push(tabId),
    );
    await browser.open('https://example.com');
    expect(shown).toEqual([]);
  }, 10_000);
});

/** A host that numbers new pages and logs opens and closes ("open 3", "close 1"). */
const countingHost = (log: string[]) => {
  let next = 0;
  return {
    call: (action: string, params: { id?: number; script?: string } = {}) => {
      if (action === 'eval') return Promise.resolve(params.script?.includes('readyState') ? 'complete' : null);
      if (action === 'open') {
        next += 1;
        log.push(`open ${next}`);
        return Promise.resolve({ id: next });
      }
      if (action === 'close') log.push(`close ${params.id ?? 'active'}`);
      return Promise.resolve({ id: params.id ?? next });
    },
  } as unknown as BrowserHost;
};

describe('HarvBrowser page tabs (2026-11-18: the app puts old tabs to sleep, Harv keeps them all)', () => {
  it('never closes tabs by itself', async () => {
    const log: string[] = [];
    const browser = new HarvBrowser(countingHost(log), () => {});
    for (let i = 0; i < 8; i++) await browser.open(`https://example.com/${i}`);
    expect(log.filter((l) => l.startsWith('close'))).toEqual([]);
    expect(log).toHaveLength(8);
  }, 60_000);

  it('same_tab never opens a tab', async () => {
    const log: string[] = [];
    const browser = new HarvBrowser(countingHost(log), () => {});
    for (let i = 0; i < 3; i++) await browser.open(`https://example.com/${i}`, true);
    expect(log).toEqual([]);
  }, 30_000);

  it('switches to a tab by number and shows the asking chat', async () => {
    const calls: string[] = [];
    const shown: string[] = [];
    const host = {
      call: (action: string, params: { id?: number; script?: string } = {}) => {
        calls.push(params.id ? `${action} ${params.id}` : action);
        if (action === 'eval') return Promise.resolve(params.script?.includes('readyState') ? 'complete' : null);
        return Promise.resolve({ id: params.id });
      },
    } as unknown as BrowserHost;
    const browser = new HarvBrowser(
      host,
      () => {},
      (t) => shown.push(t),
    );
    await browser.select(3, 'tab-1');
    expect(calls[0]).toBe('select 3');
    expect(shown).toEqual(['tab-1']);
  }, 10_000);

  it('lists tabs with the showing and sleeping ones marked', () => {
    const text = formatTabs(
      [
        { id: 1, url: 'https://a.example', title: 'A', loading: false },
        { id: 2, url: 'https://b.example', title: 'B', loading: false, asleep: true },
      ],
      1,
    );
    expect(text).toMatch(/^2 page tabs/);
    expect(text).toContain('[1] A · https://a.example (showing)');
    expect(text).toContain('[2] B · https://b.example (sleeping: reloads when picked)');
    expect(formatTabs([], null)).toBe('No page tabs are open.');
  });

  it('runs parallel calls one after another', async () => {
    const order: string[] = [];
    let busy = false;
    const host = {
      call: async (action: string, params: { script?: string } = {}) => {
        if (action === 'eval' && params.script?.includes('readyState')) return 'complete';
        if (action === 'open') {
          expect(busy).toBe(false);
          busy = true;
          order.push('open');
          await new Promise((r) => setTimeout(r, 20));
          busy = false;
          return { id: order.length };
        }
        return null;
      },
    } as unknown as BrowserHost;
    const browser = new HarvBrowser(host, () => {});
    await Promise.all([browser.open('https://a.example'), browser.open('https://b.example'), browser.snapshot()]);
    expect(order).toEqual(['open', 'open']);
  }, 30_000);
});

// The ShopNotes chat (2026-11-23): Harv couldn't pick from a dropdown and wrote a Chrome script instead.
describe('dropdowns in a snapshot', () => {
  it('lists their options, marks the picked one and a locked one', () => {
    const el = { tag: 'select', role: '', text: '', type: '', formSubmit: '' };
    const s = formatSnapshot({
      url: 'http://localhost:5000/profile.html',
      title: 'Profil',
      text: '',
      elements: [
        { ...el, ref: 1, name: 'brand', options: ['Pick', '*Škoda', 'Volkswagen'] },
        { ...el, ref: 2, name: 'model', options: ['*First pick a brand'], disabled: true },
      ],
    });
    expect(s).toContain('[1] select · brand options: Pick | [Škoda] | Volkswagen');
    expect(s).toContain('[2] select · model (locked) options: [First pick a brand]');
  });
});
