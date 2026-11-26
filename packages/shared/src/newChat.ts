/**
 * "Start a new chat and …" (typed or spoken, English or Slovak): the user wants a new tab with the
 * rest as its first message, while the chat they're in keeps working (docs/PLAN.md §6ac). Caught by
 * rule, no model call, in the server (`ChatManager.send`) and the dashboard (no local line in the old tab).
 *
 * Returns the task for the new chat ('' = just open one), or null when the message isn't such a request.
 * Strict on purpose: a new/another/separate word is required ("open a chat about X" may mean an old
 * one), the task must follow a separator ("start a new chat feature" is not a request), and "tab" is
 * left out ("open a new tab" means the browser; "make a new tab for X" is a coding request). The new
 * chat gets the user's whole message (nothing lost by the cut): this only decides that it moves.
 */

/** "hey Harv, please", "could you", "let's", "okay"… in front (English and Slovak). */
const LEAD =
  /^(?:(?:hey|hi|ok(?:ay)?|so|now|alright|right|hej|dobre|tak|teraz)[\s,.!]+)*(?:harv[\s,.!:]+)?(?:(?:please|pls|can you|could you|would you|will you|let'?s|go|now|prosím|prosim|môžeš|mozes|môžete|mozete)[\s,]+)*/i;

const VERB = String.raw`(?:start|open|begin|spin up|fire up|launch|otvor|otvorte|otvoriť|otvorit|začni|zacni|založ|zaloz)`;
const ADJ = String.raw`(?:new|another|separate|second|fresh|different|other|nový|novy|nová|nova|novú|novu|ďalší|dalsi|ďalšiu|dalsiu|iný|iny|inú|inu|druhý|druhy|samostatný|samostatny)`;
const NOUN = String.raw`(?:chat|conversation|thread|rozhovor|konverzáciu|konverzaciu)`;
const ARTICLE = String.raw`(?:(?:a|an|one more|one|me a|us a|jeden|jednu)\s+)?`;
/** What may sit between "a new chat" and the task. */
const SEP = String.raw`(?:\s*[,:;.!-]+\s*|\s+(?:and|to|then|for|about|on|where|which|that|so|with|in which|and in it|a|kde|na|o|pre|v ktorom|a v ňom|a v nom)\s+)`;

const VERB_FORM = new RegExp(
  String.raw`^${VERB}\s+${ARTICLE}${ADJ}\s+${NOUN}(?:\s+(?:please|pls|for me|now|prosím|prosim))?(?:(?:${SEP})([\s\S]*))?$`,
  'i',
);
/** "in a new chat, look up X" / "new chat: X" / "v novom chate zisti X". */
const IN_FORM = new RegExp(
  String.raw`^(?:(?:in|on|v|na)\s+${ARTICLE}(?:new|another|separate|second|fresh|different|other|novom|novej|inom|inej|ďalšom|dalsom|druhom)\s+(?:chat|conversation|thread|chate)|new chat)\s*[,:;-]?\s+([\s\S]+)$`,
  'i',
);

export function newChatTask(message: string): string | null {
  const text = message.trim().replace(LEAD, '');
  if (!text || text.startsWith('/')) return null;
  const m = VERB_FORM.exec(text) ?? IN_FORM.exec(text);
  if (!m) return null;
  const task = (m[1] ?? '')
    .trim()
    .replace(/^[,:;.!-]+\s*/, '')
    .trim();
  // "start a new chat." or "open a new chat please": nothing to do there yet.
  if (/^(?:please|pls|now|prosím|prosim|for me|thanks|thank you|[.!?]*)$/i.test(task)) return '';
  return task.charAt(0).toUpperCase() + task.slice(1);
}
