// A page that refuses a plain fetch (a bot check) goes to Harv's own browser (PLAN.md "Open now", the
// user's OK 2026-11-22: Autodoc refused WebFetch in the PCV valve chat). The browser is a real one that
// keeps its cookies, so most of these sites let it in; a human check there is the user's one click,
// never Harv's (persona rule 7).

/** How WebFetch words a refused page (real samples: 403 Forbidden, 429 Too Many Requests). */
const REFUSED = /\bThe server returned HTTP (403|429|503)\b/i;

/** What a bot-check page says (Cloudflare, Akamai, PerimeterX, DataDome, hCaptcha, reCAPTCHA). */
export const HUMAN_CHECK =
  /just a moment\.\.\.|attention required!? \| cloudflare|verify(ing)? (that )?you are (a )?human|are you a robot|i'?m not a robot|checking (if the site connection is secure|your browser)|enable javascript and cookies to continue|press (&|and) hold( the button)? to confirm|(complete|solve) the (captcha|challenge)|captcha (challenge|verification)|ddos protection by|request unsuccessful\. incapsula|access denied[^.\n]{0,60}(cloudflare|akamai|reference #)/i;

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/** A page built by scripts: the plain fetch gets only its empty shell (single-page apps, many shops). */
const NEEDS_SCRIPTS =
  /you need to enable javascript to run this app|(please )?enable javascript (in your browser )?to (view|use|continue|see)|this (site|page|app) requires javascript|javascript is (disabled|required)|doesn'?t work properly without javascript/i;

/** The note for a WebFetch the site refused, or null when it went through. */
export function blockedFetchNote(tool: string, input: Record<string, unknown>, result: unknown): string | null {
  if (tool !== 'WebFetch') return null;
  const said = text(result).slice(0, 20_000);
  const refused = REFUSED.exec(said);
  const url = typeof input.url === 'string' ? input.url : 'the page';
  if (!refused && !HUMAN_CHECK.test(said)) {
    return NEEDS_SCRIPTS.test(said)
      ? `[Page needs scripts] ${url} only sent its empty shell (it is built by JavaScript, which a plain fetch doesn't run). Read it in your own browser instead: browser_open ${url}, then use that snapshot.`
      : null;
  }
  const why = refused ? `HTTP ${refused[1]}` : 'a bot check';
  return [
    `[Blocked page] ${url} refused the plain fetch (${why}), likely a bot check. Open it in your own browser instead:`,
    `browser_open ${url}, then read it from that snapshot (your browser is a real one and keeps its cookies, so such sites usually let it in).`,
    'If the page shows a human check ("verify you are human", a captcha, "press and hold"), never solve or click it yourself: say in one line that the page waits for one click from the user in the Browser tab, and take a new snapshot once they say it is done.',
    'No browser tools here (a helper)? Name the blocked addresses in your report, so the chat that asked opens them.',
  ].join(' ');
}

/** The line under a browser snapshot that shows a human check. */
export const humanCheckLine = (title: string, pageText: string): string | null =>
  HUMAN_CHECK.test(`${title}\n${pageText.slice(0, 4000)}`)
    ? '[Human check] This page asks for a human check. Never solve or click it yourself: tell the user in one line that it waits for their one click here in the Browser tab, then take a new browser_snapshot after they say it is done.'
    : null;
