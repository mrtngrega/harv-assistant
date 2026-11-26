import { describe, expect, it } from 'vitest';
import { blockedFetchNote, humanCheckLine } from './blockedPages.ts';

const url = { url: 'https://www.autodoc.sk/some-part' };
/** WebFetch's own wording (real samples from Claude Code transcripts). */
const REFUSED_403 =
  'The server returned HTTP 403 Forbidden.\n\nThe response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.';
const REFUSED_429 = 'The server returned HTTP 429 Too Many Requests.\nRetry-After: 60\n\nThe response body was not retrieved.';

describe('a page that refused the fetch goes to Harv’s browser', () => {
  it('notes a refused fetch with the address to open', () => {
    for (const said of [REFUSED_403, REFUSED_429, { result: REFUSED_403 }]) {
      const note = blockedFetchNote('WebFetch', url, said);
      expect(note).toContain('browser_open https://www.autodoc.sk/some-part');
      expect(note).toContain('never solve or click it yourself');
    }
  });

  it('notes a bot-check page that came back as content', () => {
    for (const said of [
      'Just a moment... Enable JavaScript and cookies to continue',
      'The page shows "Verify you are human by completing the action below."',
      'Attention Required! | Cloudflare',
      'Access to this page has been denied. Press & Hold to confirm you are a human',
    ])
      expect(blockedFetchNote('WebFetch', url, said), said).toContain('bot check');
  });

  it('a page built by scripts goes to the browser too', () => {
    for (const said of [
      'You need to enable JavaScript to run this app.',
      'The page content: "Please enable JavaScript to continue." Nothing else is shown.',
      'This site requires JavaScript.',
    ])
      expect(blockedFetchNote('WebFetch', url, said), said).toContain('[Page needs scripts]');
    expect(blockedFetchNote('WebFetch', url, 'A guide: how to enable JavaScript in Firefox settings, step 1…')).toBeNull();
  });

  it('leaves ordinary pages, other failures and other tools alone', () => {
    for (const said of [
      'Prices for the PCV valve: 12,40 €. This site is protected by reCAPTCHA and the Google Privacy Policy applies.',
      'The server returned HTTP 404 Not Found.',
      'The server returned HTTP 401 Unauthorized.',
      'An article about how CAPTCHA systems work.',
    ])
      expect(blockedFetchNote('WebFetch', url, said), said).toBeNull();
    expect(blockedFetchNote('WebSearch', url, REFUSED_403)).toBeNull();
    expect(blockedFetchNote('Bash', url, REFUSED_403)).toBeNull();
  });

  it('a browser snapshot of a human check gets the line, a normal page doesn’t', () => {
    expect(humanCheckLine('Just a moment...', 'Checking if the site connection is secure')).toContain('Never solve');
    expect(humanCheckLine('Autodoc', 'PCV valve 12,40 €')).toBeNull();
  });
});
