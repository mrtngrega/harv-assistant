/**
 * The user's claude.ai connectors (Gmail, Google Calendar, Drive, Docs, Sheets, Canva, Figma), tool by
 * tool: what each call really does, read from its name and its input (docs/review/connectors-plan.md K1).
 * Names alone misled the gate: Gmail's `get_message` looked like sending, `reply` had no recipients to
 * check, a calendar invite didn't look like sending at all.
 *
 * Kinds: `read` runs freely; `write` runs (logged); `send` reaches other people (the sending rule:
 * asked for outright with the people named, else held); `delete` is gone for good and `public` opens a
 * file to anyone (both asked, the user's outright request is the yes).
 */

export type ConnectorKind = 'read' | 'write' | 'send' | 'delete' | 'public';

export interface ConnectorCall {
  /** The service as the user says it ("Gmail", "Google Calendar"). */
  service: string;
  name: string;
  kind: ConnectorKind;
  /**
   * A send whose recipients aren't in the input (a reply, a saved draft, an RSVP): the user's message
   * has to ask for exactly this (`asks`), since there are no names to check.
   */
  asks?: RegExp;
}

/** The connectors this table knows; any other MCP server falls back to the old name rules. */
const KNOWN = new Set(['Gmail', 'Google_Calendar', 'Google_Drive', 'Google_Docs', 'Google_Sheets', 'Canva', 'Figma']);

/** Look-ups by name, wider than the generic MCP list: downloads and Figma's `whoami` only read too. */
const READS =
  /^(get|list|read|search|query|fetch|find|describe|view|lookup|export|status|download|whoami|help|resolve|suggest)([_-]|$)|^weave_(find|list|get)_/i;

/** A whole phrase, letters of any language (same as sending.ts). */
const phrase = (body: string) => new RegExp(`(?<![\\p{L}\\d])(?:${body})(?![\\p{L}\\d])`, 'iu');

const ASKS_REPLY = phrase('repl(y|ies|ied)|respond|answer|write back|odp[ií][sš](te)?|odpovedz(te)?|odpoveď|odpisa[tť]');
const ASKS_REPLY_ALL = phrase('reply[ -]?all|(to|with) (everyone|everybody|all of them)|v[sš]etk[ýy]m');
const ASKS_SEND_DRAFT = phrase(
  'send (it|this|that|the (draft|mail|e-?mail|message|reply))|send it off|po[sš]li (to|ho|ju)|odo[sš]li(te)?|posla[tť] (to|ho)',
);
const ASKS_RSVP = phrase(
  'accept|decline|rsvp|respond|answer|(say|tell them) (yes|no)|prijm(i|ite)|potvrď|potvrd(i|iť)|odmietni(te)?|odpovedz',
);

const SERVICE_NAME: Record<string, string> = {
  Gmail: 'Gmail',
  Google_Calendar: 'Google Calendar',
  Google_Drive: 'Google Drive',
  Google_Docs: 'Google Docs',
  Google_Sheets: 'Google Sheets',
  Canva: 'Canva',
  Figma: 'Figma',
};

const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null);

/** What a known connector call does, or null for a tool this table doesn't know. */
export function connectorCall(tool: string, input: Record<string, unknown>): ConnectorCall | null {
  const [prefix, server = '', ...rest] = tool.split('__');
  if (prefix !== 'mcp' || !server.startsWith('claude_ai_')) return null;
  const key = server.slice('claude_ai_'.length);
  if (!KNOWN.has(key)) return null;
  const name = rest.join('__');
  const service = SERVICE_NAME[key] ?? key;
  const call = (kind: ConnectorKind, asks?: RegExp): ConnectorCall => ({ service, name, kind, ...(asks ? { asks } : {}) });

  if (READS.test(name)) return call('read');

  switch (`${key}/${name}`) {
    // Mail out. A reply goes to the sender (or everyone with replyAll) unless `to`/`cc`/`bcc` override it.
    case 'Gmail/reply': {
      const named = ['to', 'cc', 'bcc'].some((k) => nonEmpty(input[k]));
      if (input.replyAll === true) return call('send', ASKS_REPLY_ALL);
      return named ? call('send') : call('send', ASKS_REPLY);
    }
    case 'Gmail/send_message':
      return nonEmpty(input.draftId) ? call('send', ASKS_SEND_DRAFT) : call('send');
    case 'Gmail/forward':
      return call('send');
    case 'Gmail/delete_draft':
    case 'Gmail/delete_label':
      return call('delete');

    // An event with guests mails them an invitation; answering an invite tells the organiser.
    case 'Google_Calendar/create_event':
    case 'Google_Calendar/update_event':
      return nonEmpty(input.attendees) || nonEmpty(input.attendeeEmails) ? call('send') : call('write');
    case 'Google_Calendar/respond_to_event':
      return call('send', ASKS_RSVP);
    case 'Google_Calendar/delete_event':
      return call('delete');

    // Sharing with a person is sending; a link for anyone (or an audience) is public.
    case 'Google_Drive/share_file':
      return nonEmpty(input.permissionId) ? call('public') : call('send');

    // Others on a design see comments; a brand template goes to the whole team.
    case 'Canva/comment-on-design':
    case 'Canva/reply-to-comment':
      return call('send');
    case 'Canva/publish-brand-template':
      return call('public');
  }
  // Everything else changes the user's own things: labels, the bin, drafts, events without guests,
  // files, docs, sheets, designs. It runs, logged.
  return call('write');
}

/** A file reference in a connector's input (`sha256:<hash>:<path>`, the attachment form): the paths it names. */
export function referencedFiles(input: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === 'string') {
      const m = /^sha256:[0-9a-f]{64}:(.+)$/i.exec(v.trim());
      if (m) out.push(m[1]!);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(input, 0);
  return out;
}
