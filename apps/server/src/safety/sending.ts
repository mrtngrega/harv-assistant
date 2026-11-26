import { BROWSER_TOOLS, browserSends } from './browser.ts';
import { isDesktopTool } from './desktop.ts';
import { SHELL_TOOLS, str } from './base.ts';
import { connectorCall } from './connectors.ts';
import { splitCommand, unquote, words } from './shell.ts';
import { isMyComputer } from './myComputers.ts';
import { programAt, remoteTarget, sshHost } from './remote.ts';

/** Connector tools that only look things up. */
export const MCP_READ = /^(get|list|read|search|query|fetch|find|guide|describe|view|lookup|export|status)([_-]|$)/i;

/** The user's own private Claude Docs on claude.ai: writing there touches nothing outside their account. */
export const PRIVATE_MCP = /^claude_ai_Claude_Docs$/i;

/** Words in a connector tool's name that mean it sends something to someone. */
const MCP_SENDS = /(^|[_-])(send|post|reply|forward|share|invite|publish|comment|message|mail|email|tweet|dm|notify)/i;

/** A whole word or phrase, letters of any language (JS's \b only knows ASCII, so "napíš" would never end). */
const phrase = (body: string) => new RegExp(`(?<![\\p{L}\\d])(?:${body})(?![\\p{L}\\d])`, 'iu');

/** Words that turn the verb after them into a no ("don't send it", "do not delete anything", "nemaž"). */
const NEGATION = /(?<![\p{L}])(don'?t|do not|does not|doesn'?t|never|not|no|nie|nerob|nemaž|nemaz|neposielaj)(?![\p{L}])/iu;

/**
 * The message says this, and not right after a "don't" (the full review, S12: "do not delete anything"
 * and "don't send it yet" counted as asking). A negation within three words before the match cancels it.
 */
export function saidWithoutNo(re: RegExp, message: string): boolean {
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of message.matchAll(all)) {
    const before = message.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-3).join(' ');
    if (!NEGATION.test(before)) return true;
  }
  return false;
}

/**
 * What in the user's message asks Harv to send (English and Slovak), as real phrases: "text file",
 * "Postgres", "shared folder" or "napíš mi funkciu" (write me a function) aren't asking (docs/PLAN.md §6u).
 */
const ASKS_TO_SEND = [
  // Not "sent" or "forwarded": "I sent you the file yesterday" tells, it doesn't ask (S12).
  phrase('send|sends|sending|resend'),
  phrase('e-?mail(s|ed|ing)?'),
  phrase('mail\\s+(it|this|that|them|him|her|me|us|to)'),
  phrase('text\\s+(him|her|them|me|us|my|mom|dad|back)'),
  phrase('(post|posted|posting)\\s+(it|this|that|them|on|to|in)'),
  phrase('(reply|replies|replied|respond|answer)\\s+(to|him|her|them)'),
  phrase('forward|forwards|forwarding'),
  phrase('share(d)?\\s+((it|this|that|them)\\s+)?(with|to|on)'),
  phrase('message\\s+(him|her|them|me|us)|dm|tweet|invite|publish'),
  // "upload … to <somewhere>", but not to a folder on this PC ("to my workspace").
  phrase(
    'upload(ed|ing)?\\s+.{0,40}?(?<![\\p{L}])to\\s+(?!((my|the|your)\\s+)?(workspace|folder|desktop|downloads|documents)(?![\\p{L}]))(?!(my|the|your)\\s+(workspace|folder|desktop|downloads|documents)(?![\\p{L}]))[\\p{L}\\d]+',
  ),
  // Slovak: pošli / pošlite / pošleš / poslať, odošli, odpíš / odpovedz, prepošli, zdieľaj s, zverejni.
  phrase('po[sš]l(i|ite|e[sš]|eme|ete)|posla[tť]|odo[sš]li(te)?|odosla[tť]|odp[ií][sš](te)?|odpovedz(te)?|prepo[sš]li(te)?|zverejni(te)?'),
  phrase('zdie[lľ]aj(te)?\\s+(to\\s+)?(s|so|na)'),
  // "napíš" only with someone to write to or a message word ("napíš mu", "napíš Jankovi", "napíš mail").
  /(?<![\p{L}\d])nap[ií][sš](te)?\s+(mu|jej|im|n[aá]m|mail|e-?mail|spr[aá]vu|sms|odpove[dď]|\p{Lu}\p{Ll}+(ovi|e|i))(?![\p{L}\d])/u,
];

/** Fields a connector's send tool names its recipients in. */
const RECIPIENT_KEYS =
  /^(to|cc|bcc|recipients?|emails?|address(es)?|users?|user_?ids?|usernames?|channels?|channel_?ids?|chats?|chat_?ids?|conversations?|threads?|phone|numbers?|invitees?|attendees?|attendee_?emails|people|email_?address(es)?|chat_?space_?ids?)$/i;

function recipientsOf(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim())
      out.push(
        ...v
          .split(/[,;]/)
          .map((x) => x.trim())
          .filter(Boolean),
      );
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) if (typeof x === 'string') add(x);
  };
  for (const [k, v] of Object.entries(input)) if (RECIPIENT_KEYS.test(k)) add(v);
  return out;
}

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\d._%+-]+/gu) ?? [];

/**
 * The user's message names this recipient: an address or its name part, a name (Slovak endings
 * allowed: "Peter" in "Petrovi"), or, for an id nobody types ("C04ABC123"), the service ("on Slack").
 */
function mentions(message: string, recipient: string, service: string): boolean {
  const said = message.toLowerCase();
  const r = recipient.toLowerCase().replace(/^[@#]/, '');
  if (said.includes(r)) return true;
  const local = r.includes('@') ? r.split('@')[0]! : r;
  const parts = local.split(/[\s._-]+/).filter((p) => p.length >= 3 && /\p{L}/u.test(p));
  const heard = wordsOf(message);
  if (parts.some((p) => heard.some((w) => w.startsWith(p.slice(0, Math.max(3, p.length - 2)))))) return true;
  const idLike = /\d/.test(r) && !/\s/.test(r) && !r.includes('@');
  return idLike && service.length >= 3 && said.includes(service.toLowerCase());
}

/**
 * A call that sends something to someone (mail, messages, posts, invites, shares, uploads, GitHub posts,
 * copies to another machine, scripts that post or mail). The user's rule (persona rule 19): Harv asks
 * first only when they didn't ask for it.
 */
export function isSending(tool: string, input: Record<string, unknown>): boolean {
  if (BROWSER_TOOLS.includes(tool)) return browserSends(tool, input);
  // Desktop control has its own card (before risky actions, safety/desktop.ts), whatever it does.
  if (isDesktopTool(tool)) return false;
  const connector = connectorCall(tool, input);
  if (connector) return connector.kind === 'send';
  if (tool.startsWith('mcp__') && !SHELL_TOOLS.includes(tool)) {
    const [, server = '', ...rest] = tool.split('__');
    return !PRIVATE_MCP.test(server) && server !== 'harv' && MCP_SENDS.test(rest.join('__'));
  }
  if (!SHELL_TOOLS.includes(tool)) return false;
  const command = str(input, 'command');
  return sendsData(command) || scriptSends(command);
}

/**
 * For a connector send, "email" only counts as a verb ("email Peter the notes", "email it to me"):
 * "check my email" asks to read, and a mail Harv reads then must not count as the user asking.
 */
const EMAIL_VERB = phrase('e-?mail(ed|ing)?\\s+(it|this|that|them|him|her|me|us|back|the|a|my)');
// A name after it ("email Peter"): case matters here, so not through phrase()'s `i` flag.
const EMAIL_NAME = /(?<![\p{L}\d])[eE]-?mail(ed|ing)?\s+\p{Lu}/u;
const CONNECTOR_ASKS = [...ASKS_TO_SEND.filter((_, i) => i !== 1), EMAIL_VERB, EMAIL_NAME];

function asksConnectorSend(message: string): boolean {
  return CONNECTOR_ASKS.some((re) => re.test(message));
}

/** The user's message for this turn asked to send something (a free check of its words, no model call). */
export function asksToSend(message: string): boolean {
  return ASKS_TO_SEND.some((re) => saidWithoutNo(re, message));
}

/**
 * The user asked for this send: their message asks to send, and a connector send's recipients are
 * ones it names. Sending to someone else in the same reply still gets a card.
 */
export function askedToSend(tool: string, input: Record<string, unknown>, message: string, unattended = false): boolean {
  const connector = connectorCall(tool, input);
  if (connector) {
    if (connector.kind !== 'send') return true;
    // No names in the input (a reply, a saved draft, an RSVP): only a message asking for exactly that,
    // and never in a turn nobody typed (a mail Harv just read can't ask for it).
    if (connector.asks) return !unattended && connector.asks.test(message);
    const people = recipientsOf(input);
    return asksConnectorSend(message) && people.length > 0 && people.every((r) => mentions(message, r, connector.service));
  }
  if (!asksToSend(message)) return false;
  if (!tool.startsWith('mcp__') || SHELL_TOOLS.includes(tool)) return true;
  const service = (tool.split('__')[1] ?? '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  return recipientsOf(input).every((r) => mentions(message, r, service));
}

/**
 * Other ways to send (docs/PLAN.md §6u): GitHub CLI commands that post for others to see, and copies
 * to another machine (scp/rsync to host:path, sftp, ftp).
 */
function sendsElsewhere(command: string): boolean {
  return splitCommand(command).some((segment) => {
    if (/(?<![\w.-])gh\s+(issue|pr)\s+(create|comment|review|edit|close|reopen|merge)\b/i.test(segment)) return true;
    if (/(?<![\w.-])gh\s+(release\s+(create|upload|edit)|gist\s+(create|edit))\b/i.test(segment)) return true;
    if (
      /(?<![\w.-])gh\s+api\b/i.test(segment) &&
      /\s(-X|--method)\s*(post|put|patch|delete)\b|\s(-f|-F|--field|--raw-field|--input)\b/i.test(segment)
    )
      return true;
    if (/(?<![\w.-])(sftp|ftp|lftp)(\.exe)?\s/i.test(segment)) return true;
    // Taildrop to a device that isn't one of the user's own computers.
    const ws = words(segment);
    const at = programAt(ws);
    if (
      at >= 0 &&
      /(^|[\\/])tailscale(\.exe)?$/i.test(unquote(ws[at]!)) &&
      /^file$/i.test(ws[at + 1] ?? '') &&
      /^cp$/i.test(ws[at + 2] ?? '')
    ) {
      const target = ws
        .slice(at + 3)
        .filter((w) => !w.startsWith('-'))
        .at(-1);
      return !!target && unquote(target).endsWith(':') && !isMyComputer(unquote(target));
    }
    if (!/(?<![\w.-])(scp|rsync|pscp)(\.exe)?\s/i.test(segment)) return false;
    // A remote target is host:path (a drive letter like C:\ isn't a host); one of the user's own computers isn't someone else.
    return ws.slice(1).some((w) => remoteTarget(w) && !isMyComputer(unquote(w)));
  });
}

/** Code in a command (heredocs, `python -c`, `node -e`) that posts or mails: requests.post, smtplib, fetch with POST… */
export function scriptSends(command: string): boolean {
  return /\b(requests|httpx|session|client)\.(post|put|patch)\s*\(|\bsmtplib\b|\burlopen\s*\([^)]*data\s*=|\baxios\.(post|put|patch)\b|\bfetch\s*\([^)]*method\s*:\s*['"](post|put|patch)['"]|\bnodemailer\b|\bwebhook(s)?\.(send|execute)\b|\bdiscord(_webhook)?\b[^\n]*\.(send|post)\s*\(/i.test(
    command,
  );
}

/**
 * Sending data out: curl/wget uploads and POST-like requests, PowerShell web requests
 * with a changing method, mail. curl's flags are case-sensitive (`-f` only fails
 * quietly, `-F` posts a form), so they're read word by word.
 */
export function sendsData(command: string): boolean {
  if (sendsElsewhere(command)) return true;
  if (/send-mailmessage/i.test(command)) return true;
  // PowerShell's web cmdlets (and their aliases: PowerShell 5.1's curl and wget are Invoke-WebRequest).
  // Parameters may be shortened (`-Met Post`) or joined with a colon (`-Method:Post`); a body is data sent.
  if (
    /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget)\b/i.test(command) &&
    /\s-met\w*(\s+|:)['"]?(post|put|patch|delete)\b|\s-(bo|bod|body|inf\w*|form)\b|\s-in(?=\s)/i.test(command)
  )
    return true;
  // .NET uploads (WebClient, HttpClient), BITS uploads, raw sockets, and input fed to a remote shell.
  if (/\.upload(string|file|data|values)(taskasync|async)?\s*\(|\.(post|put|patch|send)async\s*\(|-transfertype\s+upload/i.test(command))
    return true;
  if (/(^|[\s;|&(])(nc|ncat|netcat|socat)(\.exe)?\s/i.test(command)) return true;
  // Input fed to a remote shell, unless that's one of the user's own computers (their own work there).
  const fed = splitCommand(command).filter((s) => sshHost(s) !== null && (/\s<\s*\S/.test(s) || /\|\s*(\S*[\\/])?ssh\b/i.test(command)));
  if (fed.some((s) => !isMyComputer(sshHost(s)!))) return true;
  if (/\|\s*(\S*[\\/])?ssh\b/i.test(command) && fed.length === 0) return true;
  return splitCommand(command).some((segment) => {
    const ws = words(segment).map(unquote);
    const at = ws.findIndex((w) => /(^|[^\w-])(curl|wget)(\.exe)?$/i.test(w));
    if (at === -1) return false;
    const args = ws.slice(at + 1);
    if (/wget(\.exe)?$/i.test(ws[at]!)) return args.some((a) => /^--(post-data|post-file|method|body-data|body-file)\b/.test(a));
    return args.some(
      (a, j) =>
        (/^-[a-zA-Z]*[dFTK]/.test(a) && !a.startsWith('--')) ||
        /^--(data|form|upload-file|json|config)\b/.test(a) ||
        /^-X(post|put|patch|delete)$/i.test(a) ||
        ((a === '-X' || a === '--request') && /^(post|put|patch|delete)$/i.test(args[j + 1] ?? '')),
    );
  });
}
