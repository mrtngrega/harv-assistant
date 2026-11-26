import { browserRefs, type BrowserElement } from '../tools/browserRefs.ts';
import { SECRET_FIELD, SEARCH_FIELD } from './browser.ts';
import { type DesktopRisk, kindOf } from './desktop.ts';

// Harv's browser holds the same risky kinds as desktop control (the full review, S16): buying,
// paying, deleting and typing into a password or card field, unless the user's message asked for
// that kind. Sending stays with the sending check (it also looks at who it goes to). A plain
// "Confirm"/"Accept" is held only on a page that takes money (D4): cookie banners don't ask.

/** Fields for money (not a plain password). */
const MONEY_FIELD = /(card|cc-|cvc|cvv|iban|account.?number|security.?code)/i;
/** Addresses of a checkout. */
const MONEY_PAGE = /\/(checkout|cart|basket|payment|pay|order|kosik|pokladna|objednavka|platba)(\b|\/|$)/i;

/** The page takes money: a card or IBAN field, or a checkout/cart/payment address. */
function takesMoney(): boolean {
  let path = '';
  try {
    path = new URL(browserRefs.url).pathname;
  } catch {
    /* not a web address */
  }
  if (MONEY_PAGE.test(path)) return true;
  return [...browserRefs.elements.values()].some((el) => MONEY_FIELD.test(`${el.name} ${el.type}`));
}

const site = () => {
  try {
    return new URL(browserRefs.url).hostname || 'a local page';
  } catch {
    return 'the page';
  }
};
/** The page is served by this computer itself (localhost, 127.x, ::1). */
export const onLoopback = (url = browserRefs.url) => {
  try {
    return /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
};
const label = (el: BrowserElement) => (el.text || el.name || el.tag).trim().slice(0, 60);

/** A form's submit button that buys or deletes. */
const formKind = (el: BrowserElement) => {
  const k = el.formSubmit ? kindOf(el.formSubmit) : null;
  return k === 'buy' || k === 'delete' ? k : null;
};

/** What makes this browser action risky (buy, delete, a secret field), or null. `lastTyped` is the field Harv typed into last. */
export function browserRisk(tool: string, input: Record<string, unknown>, lastTyped?: BrowserElement): DesktopRisk | null {
  const name = tool.replace('mcp__harv__browser_', '');
  const ref = Number(input.ref);
  const el = Number.isFinite(ref) ? browserRefs.elements.get(ref) : undefined;
  switch (name) {
    case 'click': {
      if (!el) return null;
      const kind = kindOf(`${el.text} ${el.name}`) ?? (el.type === 'submit' ? formKind(el) : null);
      if (kind === 'buy' || kind === 'delete') return { kind, why: `Clicks “${label(el)}” on ${site()}.` };
      if (kind === 'commit' && takesMoney()) return { kind: 'buy', why: `Clicks “${label(el)}” on a payment page (${site()}).` };
      return null;
    }
    case 'type': {
      if (!el) return null;
      // A login on this computer's own page (a dev app on localhost) is the user's test account, not a
      // secret of theirs (the ShopNotes chat, 2026-11-23: a seeded test login was held). Money fields still ask.
      const what = `${el.type} ${el.name} ${el.text}`;
      // A dropdown's pick isn't a secret ("card type", "PIN delivery"): only typed fields are.
      if (el.tag !== 'select' && (el.type === 'password' || SECRET_FIELD.test(what)) && !(onLoopback() && !MONEY_FIELD.test(what)))
        return { kind: 'secret', why: `Types into the “${label(el)}” field on ${site()}.` };
      const kind = input.submit === true ? formKind(el) : null;
      return kind
        ? { kind, why: `Types into “${label(el)}” and submits a form that ${kind === 'buy' ? 'buys' : 'deletes'} (${site()}).` }
        : null;
    }
    case 'press': {
      if (!/^(enter|return)$/i.test(String(input.key ?? '')) || !lastTyped) return null;
      if (SEARCH_FIELD.test(lastTyped.name) || lastTyped.type === 'search') return null;
      const kind = formKind(lastTyped) ?? (takesMoney() ? 'buy' : null);
      return kind
        ? { kind, why: `Presses Enter in “${label(lastTyped)}” on ${site()}: that ${kind === 'buy' ? 'may buy or pay' : 'deletes'}.` }
        : null;
    }
    default:
      return null;
  }
}

/** The element a browser_type call types into (the gate keeps it for a later Enter). */
export const typedInto = (input: Record<string, unknown>): BrowserElement | undefined => {
  const ref = Number(input.ref);
  return Number.isFinite(ref) ? browserRefs.elements.get(ref) : undefined;
};
