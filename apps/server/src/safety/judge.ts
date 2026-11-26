import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES } from '../agent/options.ts';

// The cheap checks behind "ask first" (the user's rules, 2026-11-11): did the user's own message ask
// for exactly this action (then it's their yes), and does their reply to a held action agree. Plain
// replies are read by the rules below; only unclear ones cost a Haiku call, and only while something is held.

const TIMEOUT_MS = 20_000;

/** One Haiku·low turn with no tools and no saved session; null when it fails or isn't on the subscription. */
async function askHaiku(system: string, message: string): Promise<Record<string, unknown> | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const q = query({
    prompt: message,
    options: {
      ...buildOptions('haiku', 'low', abort),
      systemPrompt: system,
      tools: [],
      maxTurns: 1,
      persistSession: false,
      includePartialMessages: false,
    },
  });
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) return null;
      if (msg.type === 'result') {
        if (msg.subtype !== 'success') return null;
        const json = /\{[\s\S]*\}/.exec(msg.result)?.[0];
        return json ? (JSON.parse(json) as Record<string, unknown>) : null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    q.close();
  }
}

/** Lowercase, without accents (Slovak "áno" → "ano"), single spaces. */
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// The quick rules decide only when the WHOLE reply is a known short answer (the full review, S5: "ok stop"
// was read as a yes because only the first word counted). Everything else is read by Haiku.
const YES =
  '(yes|yeah|yep|yup|ya|ok|okay|k|sure|sure thing|go|go ahead|do it|approved|fine|jo|joj|hej|ano|dobre|ok jo|mozes|mozes ist|sprav to|urob to|do toho|pokracuj|v pohode|jasne)';
const NO =
  "(no|nope|nah|nie|wait|stop|don'?t|do not|not that|not that one|cancel|never ?mind|zrus|zrus to|pockaj|nerob|nerob to|necha?j|nechaj tak)";
/** Words that may follow a short answer without changing it. */
const FILLER = '(please|pls|harv|prosim|prosim ta)';
const ITEMS = String.raw`(?<items>(?:#?\d+\s*(?:,|and|a|&|\s)\s*)*#?\d+)`;
const WHOLE_YES = new RegExp(`^${YES}( ${FILLER})?$`);
const WHOLE_NO = new RegExp(
  `^${NO}(,? ${NO})*,?( ${FILLER}| it| to| that| tak| leave it| leave that| skip it| not now| not yet| later| nechaj to| teraz nie| neskor)?$`,
);
const YES_ITEMS = new RegExp(`^${YES}[ ,:]*${ITEMS}( ${FILLER})?$`);
const YES_EXCEPT = new RegExp(`^${YES}[ ,]*(?:but not|except|okrem|ale nie|bez) ${ITEMS}$`);
/** "ok, and now do X": a yes followed by the next instruction (the user's rule, 2026-11-17). */
const YES_AND = new RegExp(`^${YES},? (and then|and now|and|then|now|a potom|a teraz|a|potom|teraz) \\S`);
/** …unless what follows takes the yes back or puts it off ("ok and then stop", "jo a potom nie"). */
const TAKES_BACK =
  /\b(stop|wait|cancel|don'?t|do not|not|never|later|leave|skip|undo|instead|nie|nerob|nechaj|zrus|pockaj|neskor|radsej|bez)\b/;

export type ReplyVerdict = { kind: 'yes'; items: number[] | 'all'; except?: number[] } | { kind: 'no' } | { kind: 'unclear' };

const numbers = (s: string) => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));

/**
 * The user's reply to held actions, by the quick rules: a whole short yes or no, "yes 1 and 3",
 * "yes but not 2", and "ok, and now do X" (a yes, then the next instruction). A reply ending in "?"
 * is a question (unclear). Anything else is null: Haiku reads it.
 */
export function readReply(reply: string): ReplyVerdict | null {
  const raw = plain(reply);
  if (!raw) return { kind: 'no' };
  if (/\?$/.test(raw)) return { kind: 'unclear' };
  const t = raw.replace(/[\s.!,]+$/, '').replace(/^([a-z]+)[!.,]+(?= |$)/, '$1');
  if (WHOLE_NO.test(t)) return { kind: 'no' };
  if (WHOLE_YES.test(t)) return { kind: 'yes', items: 'all' };
  const picked = YES_ITEMS.exec(t);
  if (picked) return { kind: 'yes', items: numbers(picked.groups!.items!) };
  const except = YES_EXCEPT.exec(t);
  if (except) return { kind: 'yes', items: 'all', except: numbers(except.groups!.items!) };
  const and = YES_AND.exec(t);
  if (and && !TAKES_BACK.test(t.slice(and[0].length - 1))) return { kind: 'yes', items: 'all' };
  return null;
}

const REPLY_PROMPT = `Harv, a personal assistant, held some actions until the user agrees. Read the user's reply and decide.
Reply with ONLY one JSON object: {"decision": "yes" | "no" | "unclear", "items": [<numbers of the held actions the yes covers>]}
"yes": the reply clearly agrees to some or all of them (list exactly which; all if it doesn't single any out). "no": it refuses them, or is about something else entirely. "unclear": it can't be told. The rest of a reply may be a new instruction; that doesn't change the decision.
A reply that agrees and then takes it back or puts it off ("ok stop", "yes but later", "ok wait", "fine, leave it") is a no.
If Harv's last message did not ask about these actions, a bare "ok" or "thanks" answers something else: unclear.`;

/**
 * The reply read by Haiku when the quick rules can't tell, or when the held actions are old (`fresh`
 * false: held before Harv's last message, so a bare "ok" may answer something else). Unclear when the check fails.
 */
export async function judgeReply(
  reply: string,
  held: { n: number; summary: string }[],
  harvSaid?: string,
  fresh = true,
): Promise<ReplyVerdict> {
  const quick = fresh ? readReply(reply) : null;
  if (quick) return quick;
  const list = held.map((h) => `#${h.n}: ${h.summary}`).join('\n');
  const before = harvSaid ? `Harv's last message:\n${harvSaid.slice(-1500)}\n\n` : '';
  const out = await askHaiku(REPLY_PROMPT, `${before}Held actions:\n${list}\n\nThe user's reply:\n${reply.slice(0, 1500)}`);
  if (!out) return { kind: 'unclear' };
  if (out.decision === 'no') return { kind: 'no' };
  if (out.decision !== 'yes') return { kind: 'unclear' };
  const items = Array.isArray(out.items) ? out.items.map(Number).filter((n) => held.some((h) => h.n === n)) : [];
  return { kind: 'yes', items: items.length ? items : 'all' };
}

const REQUEST_PROMPT = `Harv, a personal assistant, is about to do a risky action. Decide whether the user's own message asked for exactly this action outright (e.g. "uninstall Steam" for uninstalling Steam), or whether it's Harv's own idea for reaching some goal (e.g. "make my PC faster" doesn't ask for turning the firewall off). If Harv's previous message described or offered exactly this action (asked "Go ahead?", said "I can do it from here if you'd rather") and the user clearly agrees ("yes", "jo", "do it", "you can do it yourself"), that counts as asked, even when the reply itself names nothing: it answers Harv's message. Compare what Harv's message described with the action's command, not with the user's words alone.
- The message must name what the action touches (the program, file, folder, setting). A goal is not a yes for a step Harv chose: "clean up my disk" doesn't ask for uninstalling Steam.
- An action much bigger than what was asked is Harv's own idea: "delete old.log" doesn't ask for deleting the whole logs folder.
- A program's own parts are that program: "close RivaTuner" asks for closing RTSS.exe together with its helper processes (RTSSHooksLoader64.exe, EncoderServer.exe), and "uninstall Steam" for its service too. Another program the user didn't name is not part of it ("close only RivaTuner" doesn't ask for closing MSI Afterburner).
- A polite request is a request ("can you uninstall Steam?", "môžeš odinštalovať Steam?"). A question about what would happen, or whether it's safe, is not.
Reply with ONLY one JSON object: {"asked": true | false}. When unsure: false.`;

/**
 * Questions that ask about an action instead of asking for it ("what would happen if I uninstalled
 * Steam?", "is it safe to turn the firewall off?"): never the user's yes, and no Haiku call for them.
 */
const ONLY_ASKING = new RegExp(
  [
    String.raw`\bwhat (would|will|happens|happened|if)\b`,
    String.raw`\b(is|would) it (be )?(safe|ok|okay|a good idea|bad|risky)\b`,
    String.raw`\bshould (i|we|you)\b`,
    String.raw`\b(how|why) (would|does|do|is|did)\b`,
    String.raw`\bco (by|sa stane|ak)\b`,
    String.raw`\bje (to )?bezpecne\b`,
    String.raw`\bmal (by )?som\b`,
    String.raw`\bmali by sme\b`,
  ].join('|'),
);

/** The message only asks about an action, so it can't be the yes for it (pass C, the Fable playbook P2). */
export const onlyAsking = (message: string) => /\?\s*$/.test(message.trim()) && ONLY_ASKING.test(plain(message));

/**
 * Is this held action the user's yes already? `byTask` (this computer and the user's own other ones):
 * the job asked for in the recent messages covers the steps it plainly needs, like Claude Code's auto
 * mode (the user, 2026-11-26: "the rules limiting harv should … be the exact same as claude code auto
 * mode"; 9 of 9 holds on 25–26 Nov were steps of the job he gave). Otherwise (a computer that isn't
 * the user's) only an outright request for exactly this action counts.
 */
export async function askedOutright(message: string, action: string, harvSaid?: string, byTask = false): Promise<boolean> {
  const last = message.split('\n---\n').at(-1) ?? message;
  if (!message.trim() || onlyAsking(last)) return false;
  const before = harvSaid
    ? `Harv's message just before (Harv may have asked about this action; the user may be answering):\n${harvSaid}\n\n`
    : '';
  const said = byTask
    ? `The user's recent messages in this chat (oldest first, separated by ---):\n${message.slice(-3000)}`
    : `The user's message:\n${message.slice(0, 2000)}`;
  const out = await askHaiku(byTask ? TASK_PROMPT : REQUEST_PROMPT, `${before}${said}\n\nThe action:\n${action.slice(0, 1000)}`);
  // "covered", not "asked": Haiku read {"asked": true} as "Harv should ask" and inverted 12 of 14 live cases (2026-11-26).
  if (byTask) return out?.covered === true && out.beyond !== true && !/^\s*none\s*$/i.test(String(out.job ?? 'none'));
  return out?.asked === true;
}

/**
 * The job covers its steps (auto mode), on this computer and the user's own other ones. Grew from the
 * own-computer rule (2026-11-22, the Windows debloat chat needed nine yeses: "you do it, you have full access").
 */
const TASK_PROMPT = `Harv, a personal assistant that works like Claude Code in auto mode, is about to take a step that can't simply be undone. Decide whether the job the user asked for in their recent messages covers this step. The user's request for a job is the yes for the steps that job plainly needs, done the way a capable helper would do them. Covered, for example: stopping or restarting the programs, emulators, servers, scripts and test runs the job uses (Harv's own or the project's); installing what the job needs; changing the settings, services or registry keys the job is about; committing and pushing the work of a project; rebooting the device being worked on when the job calls for it; cleaning up the job's own temporary files; on the user's other computers the same (e.g. "clean up the Windows from bloatware" covers removing those apps, turning off ads, telemetry and tips, a restore point). If Harv's last message offered exactly this step and the user agreed ("yes", "jo", "do it", "do everything, don't ask"), it is covered.
Not covered:
- For a broad goal ("tidy up my PC", "make it faster", "fix my internet"), a system change Harv picked himself (stopping or disabling a service, uninstalling a program, a registry or startup change): only covered when the user named that thing or agreed to Harv's plan that listed it. Stopping the things the job itself started (its emulator, server, test run, a stuck script of its own) is always covered.
- Steps beyond the job: deleting the user's own files, data or projects the job didn't call for; removing programs the user didn't mean; closing programs the user is using that the job doesn't need (their browser, game, editor, music); turning security, antivirus or the firewall off when the job didn't call for it.
- A much bigger version of what was asked ("delete old.log" doesn't cover deleting the whole logs folder).
- Anything the user said no to, wanted kept, or only asked about ("what would happen if…", "is it safe to…").
A program's own parts are that program ("close RivaTuner" covers RTSS.exe and its helpers, not MSI Afterburner). Match package names to the user's words for them (Microsoft.GamingApp is the Xbox app, Microsoft.YourPhone is Phone Link, Microsoft.WindowsStore is the Store).
Reply with ONLY one JSON object: {"job": "<the job the user asked for, or none>", "kept": ["<each thing the user said stays>"], "beyond": true | false, "covered": true | false}: fill job, kept and beyond first. "covered": true means the job covers this step, so Harv may go ahead without asking; false means Harv must ask first. covered is false when job is none, beyond is true, or the step removes or stops something in kept. When unsure: false.`;
