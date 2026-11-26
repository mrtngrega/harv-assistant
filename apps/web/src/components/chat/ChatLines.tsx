import { memo, useState } from 'react';
import { lineTime } from '../../lib/format.ts';
import { useSettings } from '../../lib/useHarvSocket.ts';
import { chat, type Line } from '../../lib/chatStore.ts';
import { useSafety } from '../../lib/safetyStore.ts';
import { HELD_PREFIX, isHeld, plainTool } from '../../lib/turns.ts';
import { ActionBadge } from '../ApprovalCard.tsx';
import { FileCards } from './FileCards.tsx';
import { RichText } from './RichText.tsx';
import { Icon } from '../tools/explorer/icons.tsx';
import { lastPart } from '../../lib/drafts.ts';

// One chat line and its parts (the log of ChatPanel): replies, thoughts, tool steps, files, model tags.

/** An attached file: an upload (▤), or a file or folder on the PC pointed at by its path (@, nothing copied). */
export function FileChip({
  name,
  path,
  folder,
  detail,
  onRemove,
}: {
  name: string;
  path?: string;
  folder?: boolean;
  detail?: string;
  onRemove?: () => void;
}) {
  return (
    <span
      title={path ? `${path} (by path: Harv works on it where it is)` : undefined}
      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-[rgb(220_232_245/0.2)] bg-white/5 py-0.5 pr-1 pl-2 text-[11px]"
    >
      <span aria-hidden="true" className="text-accent">
        {path ? '@' : '▤'}
      </span>
      <span className="truncate text-ink">
        {name}
        {folder ? '/' : ''}
      </span>
      {detail && <span className="flex-none text-faint">{detail}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="size-6 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
        >
          <Icon name="close" size={12} className="mx-auto block" />
        </button>
      )}
    </span>
  );
}

export function Thinking() {
  return (
    <span aria-label="Harv is thinking" className="inline-flex gap-1 text-accent">
      <span className="animate-blink">●</span>
      <span className="animate-blink [animation-delay:.2s]">●</span>
      <span className="animate-blink [animation-delay:.4s]">●</span>
    </span>
  );
}

export function Time({ at }: { at: number }) {
  if (!useSettings().showTimes) return null;
  return (
    <time dateTime={new Date(at).toISOString()} className="mr-2 text-faint tabular-nums">
      {lineTime(at)}
    </time>
  );
}

/** Rewind (Claude Code's /rewind): asks once more, since the later messages go. */
export function RewindButton({ line }: { line: Line }) {
  const [sure, setSure] = useState(false);
  const btn = 'cursor-pointer rounded px-1.5 text-[11px] hover:bg-white/10';
  if (!sure)
    return (
      <button
        type="button"
        onClick={() => setSure(true)}
        title="Rewind: put the files Harv changed and the conversation back to before this message (the later messages go)"
        className={`${btn} text-muted opacity-0 group-hover:opacity-100 hover:text-accent focus:opacity-100`}
      >
        ⟲ rewind
      </button>
    );
  return (
    <span className="text-[11px] text-warn">
      rewind to here? this and everything after it goes ·{' '}
      <button type="button" onClick={() => chat.rewind(line.id)} className={`${btn} text-warn`}>
        yes
      </button>
      <button type="button" onClick={() => setSure(false)} className={`${btn} text-muted`}>
        no
      </button>
    </span>
  );
}

/** Messages Harv's own commands handled: never sent to Claude, so there's nothing to rewind to. */
export const LOCAL_COMMAND = /^\/(report|btw)\b/i;

/**
 * A reply's [model·effort]: the reason AUTO picked it shows on hover, and on a click right there
 * (the critique, 2026-11-09: hover alone hid it). ↑ = AUTO stepped up mid-reply (the reason says why).
 */
export function ModelTag({ tag, reason }: { tag: string; reason?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={reason}
        aria-expanded={reason ? open : undefined}
        onClick={() => reason && setOpen((o) => !o)}
        className="cursor-pointer rounded text-[11px] text-faint hover:text-muted"
      >
        [{reason?.startsWith('↑') && <span className="text-accent">↑ </span>}
        {tag}]
      </button>
      {open && reason && <span className="min-w-0 text-[11px] text-muted">{reason}</span>}
    </>
  );
}

export function ChatLineView({
  line,
  onHarder,
  head = true,
  waits = false,
}: {
  line: Line;
  onHarder?: () => void;
  head?: boolean;
  waits?: boolean;
}) {
  const { showTimes, showTags } = useSettings();
  switch (line.kind) {
    case 'you':
      return (
        <div className="group animate-fade-in rounded-md border-l-2 border-accent bg-accent/10 px-2.5 py-1.5 whitespace-pre-wrap text-white">
          <div className="float-right ml-2">{!LOCAL_COMMAND.test(line.text) && <RewindButton line={line} />}</div>
          <Time at={line.at} />
          <span className="text-accent">you ›</span> {line.text}
          {line.files && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {/* Files and folders on the PC are stored by their full path, uploads by their name. */}
              {line.files.map((name, i) =>
                /^[a-z]:[\\/]|^\//i.test(name) ? <FileChip key={i} name={lastPart(name)} path={name} /> : <FileChip key={i} name={name} />,
              )}
            </div>
          )}
        </div>
      );
    case 'harv':
      // One header per reply (pass B, B3): later blocks of the same reply are plain text.
      if (!head)
        return line.text ? (
          <div className="harv-md animate-fade-in">
            <RichText text={line.text} streaming={line.streaming} />
            {!line.streaming && <FileCards text={line.text} />}
          </div>
        ) : null;
      return (
        <div className="group animate-fade-in">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Time at={line.at} />
            <span className={`text-ok ${showTimes ? '-ml-2' : ''}`}>harv ›</span>
            {line.tag && showTags && <ModelTag tag={line.tag} reason={line.reason} />}
            {line.streaming && line.text === '' && <Thinking />}
            {onHarder && (
              <button
                type="button"
                onClick={onHarder}
                title="Run that again one step up (a stronger model or more effort)"
                className={`cursor-pointer rounded px-1.5 text-[11px] text-muted opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-accent focus:opacity-100`}
              >
                ↑ try harder
              </button>
            )}
          </div>
          {line.text && (
            <div className="harv-md mt-1">
              <RichText text={line.text} streaming={line.streaming} />
            </div>
          )}
          {line.text && !line.streaming && <FileCards text={line.text} />}
        </div>
      );
    case 'tool':
      return <ToolLine line={line} />;
    case 'thinking':
      return <ThoughtLine line={line} />;
    case 'notice':
      // A held action waits for the user's yes (pass B, B6): amber while it waits, the exact call under it.
      if (isHeld(line)) {
        const [first, ...command] = line.text.slice(HELD_PREFIX.length).trim().split('\n');
        return (
          <div
            className={`animate-fade-in rounded-md border-l-2 px-2.5 py-1.5 ${waits ? 'border-warn bg-warn/10' : 'border-line text-muted'}`}
          >
            <Time at={line.at} />
            <span className={waits ? 'text-warn' : ''}>{waits ? 'waiting for your yes ›' : 'was held ›'}</span> {first}
            {command.length > 0 && (
              <pre className="mt-1 mb-0 overflow-x-auto rounded bg-black/25 px-2 py-1 text-[12px] whitespace-pre-wrap text-ink">
                {command.join('\n')}
              </pre>
            )}
          </div>
        );
      }
      return (
        <div className="animate-fade-in whitespace-pre-line text-muted">
          <Time at={line.at} />— {line.text}
        </div>
      );
    case 'error':
      return (
        <div className="animate-fade-in text-warn">
          <Time at={line.at} />! {line.text}
        </div>
      );
  }
}

/**
 * A line re-renders only when it changes (lines are replaced, never edited in place), or
 * when "try harder" comes or goes. Typing re-renders the panel on every key, and parsing
 * every reply's Markdown again made typing lag in long chats.
 */
export const ChatLine = memo(
  ChatLineView,
  (a, b) => a.line === b.line && !a.onHarder === !b.onHarder && a.head === b.head && a.waits === b.waits,
);

/** The mark after a line's time (✻ thinking, ▸ a tool): one fixed slot, so both columns line up (✻ comes from another font). */
export const GLYPH = 'inline-block w-[1.5ch] text-center';

/** What Claude thought before answering, folded like Claude Code's: "✻ thought for 12s", open to read. */
export function ThoughtLine({ line }: { line: Line }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="animate-fade-in text-faint">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? 'Hide the thinking' : 'Show what Harv thought'}
        className="cursor-pointer rounded hover:text-muted"
      >
        <Time at={line.at} />
        <span className={`${GLYPH} text-accent/70`}>✻</span> thought for {line.tag ?? 'a moment'} {open ? '▾' : '▸'}
      </button>
      {open && <div className="mt-1 border-l border-line pl-3 whitespace-pre-wrap text-muted italic">{line.text}</div>}
    </div>
  );
}

/** A tool call; non-green ones show their tier, status and Undo from the action log. */
export function ToolLine({ line }: { line: Line }) {
  const { actions } = useSafety();
  const action = line.ref ? actions[line.ref] : undefined;
  const [raw, setRaw] = useState(false);
  const plain = plainTool(line.text, action);
  return (
    <div className="animate-fade-in text-faint">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={plain === line.text ? undefined : raw}
          onClick={() => plain !== line.text && setRaw(!raw)}
          title={plain === line.text ? undefined : raw ? 'Hide the exact call' : 'Show the exact call'}
          className="min-w-0 cursor-pointer truncate rounded text-left hover:text-muted"
        >
          <Time at={line.at} />
          <span className={GLYPH}>▸</span> {plain}
        </button>
        {action && action.tier !== 'green' && <ActionBadge action={action} />}
      </div>
      {raw && <div className="mt-1 border-l border-line pl-3 font-mono break-all whitespace-pre-wrap text-muted">{line.text}</div>}
    </div>
  );
}

/** A finished turn's thoughts and tool steps, folded into one row (pass B, B5). */
export function StepsRow({ lines, seconds }: { lines: Line[]; seconds: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="animate-fade-in text-faint">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={open ? 'Fold the steps' : 'Show what Harv did'}
        className="cursor-pointer rounded hover:text-muted"
      >
        <Time at={lines[0]!.at} />
        <span className={GLYPH}>{open ? '▾' : '▸'}</span> {lines.length} {lines.length === 1 ? 'step' : 'steps'}
        {seconds > 0 ? ` · ${seconds}s` : ''}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1 border-l border-line pl-3">
          {lines.map((l) => (l.kind === 'tool' ? <ToolLine key={l.id} line={l} /> : <ThoughtLine key={l.id} line={l} />))}
        </div>
      )}
    </div>
  );
}
