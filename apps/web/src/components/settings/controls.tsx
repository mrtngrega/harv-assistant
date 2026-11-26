import { useEffect, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Icon } from '../tools/explorer/icons.tsx';
import { useConnection } from '../../lib/useHarvSocket.ts';
import { groupId } from '../../lib/settingsJump.ts';

/** An example path in the form of the OS Harv runs on (C:\… on Windows, /home/… on Linux). */
export function useExample(windows: string, linux: string): string {
  return useConnection().platform === 'windows' ? windows : linux;
}

/** The width of every row's label, so controls line up down a section. */
export const LABEL = 'flex-none text-muted @md:w-28';

/** A label and its control side by side; stacked in a narrow window so text boxes keep their room. */
export const ROW = 'flex flex-col items-stretch gap-1.5 text-xs @md:flex-row @md:items-center @md:gap-3';

export const BUTTON =
  'min-h-9 cursor-pointer rounded-lg border border-line bg-white/5 px-3 text-xs hover:bg-white/10 disabled:cursor-default disabled:opacity-40';

export const INPUT =
  'min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/20 px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:border-accent/60';

/**
 * A big section (Appearance, Safety…): its own glass card, clearly apart from the next. Subsections flow
 * in 1–2 CSS columns inside. WebKit (the Linux app) gets two things wrong in CSS columns (2026-11-10):
 * a margin at a column break moves the next column down, and a scrolling box inside is drawn in the
 * wrong place (over the next section). So subsections space themselves with padding, and nothing in
 * Settings scrolls on its own.
 */
export function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section
      id={groupId(title)}
      data-settings-group={title}
      className="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-line bg-black/25 p-4"
    >
      <header className="flex flex-col gap-0.5 border-b border-line pb-2.5">
        <h2 className="m-0 text-sm font-semibold tracking-wide text-accent">{title}</h2>
        {hint && <p className="m-0 text-[11px] text-faint">{hint}</p>}
      </header>
      <div className="columns-1 gap-3 @3xl:columns-2">{children}</div>
    </section>
  );
}

/** A subsection inside a big section: a heading and its settings, no card of its own (no cards in cards). */
export function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-settings-sub className="flex break-inside-avoid flex-col gap-2.5 px-1 pb-5">
      <h3 className="m-0 text-[12px] font-semibold tracking-wide text-ink">{title}</h3>
      {children}
    </div>
  );
}

/**
 * Settings' own navigation (the critique, 2026-11-09: one long scroll with no way to jump): a filter
 * that keeps the subsections whose text matches, and on wide windows a list of the sections beside
 * them, the one in view marked, like macOS System Settings' sidebar.
 */
export function useSettingsNav(root: RefObject<HTMLDivElement | null>, query: string) {
  const [groups, setGroups] = useState<string[]>([]);
  const [current, setCurrent] = useState('');
  const [empty, setEmpty] = useState(false);
  // The sections there are (Devices only with devices).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => setGroups([...el.querySelectorAll<HTMLElement>('[data-settings-group]')].map((g) => g.dataset.settingsGroup!));
    read();
    const watch = new MutationObserver(read);
    watch.observe(el, { childList: true });
    return () => watch.disconnect();
  }, [root]);
  // Which one is in view: the last whose top has passed the upper third of the scroller.
  useEffect(() => {
    const el = root.current;
    const scroller = el?.closest<HTMLElement>('.overflow-y-auto');
    if (!el || !scroller) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let seen = '';
      for (const g of el.querySelectorAll<HTMLElement>('[data-settings-group]:not([hidden])'))
        if (g.getBoundingClientRect().top <= top) seen = g.dataset.settingsGroup!;
      setCurrent(seen || (groups[0] ?? ''));
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [root, groups, query]);
  // The filter: subsections (or a whole section) whose words match stay; a section's own title keeps all of it.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const q = query.trim().toLowerCase();
    const filter = () => {
      let shown = 0;
      for (const g of el.querySelectorAll<HTMLElement>('[data-settings-group]')) {
        const title = (g.dataset.settingsGroup ?? '').toLowerCase();
        const subs = [...g.querySelectorAll<HTMLElement>('[data-settings-sub]')];
        const whole = !q || title.includes(q);
        let any = whole;
        for (const sub of subs) {
          const show = whole || (sub.textContent ?? '').toLowerCase().includes(q);
          sub.hidden = !show;
          any ||= show;
        }
        if (!subs.length) any ||= (g.textContent ?? '').toLowerCase().includes(q);
        g.hidden = !any;
        if (any) shown += 1;
      }
      setEmpty(shown === 0);
    };
    filter();
  }, [root, query, groups]);
  return { groups, current, empty };
}

/** A small grey note under a setting. */
export const Note = ({ children, warn }: { children: ReactNode; warn?: boolean }) => (
  <p className={`m-0 text-[11px] leading-snug ${warn ? 'text-warn' : 'text-faint'}`}>{children}</p>
);

/** Details most people never touch, behind a closed line (pass B, B29). */
export function FineTune({ label = 'Fine-tune', children }: { label?: string; children: ReactNode }) {
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer list-none text-[11px] text-muted select-none hover:text-accent">
        <span className="inline-block w-3 transition-transform group-open:rotate-90">›</span>
        {label}
      </summary>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </details>
  );
}

export function Toggle({ on, label, hint, onChange }: { on: boolean; label: string; hint?: string; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-xs">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-9 flex-none items-center rounded-full p-0.5 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${
          on ? 'bg-accent' : 'bg-white/15'
        }`}
      >
        <span className={`size-4 rounded-full bg-[#0f1620] transition-transform ${on ? 'translate-x-4' : ''}`} />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-ink">{label}</span>
        {hint && <span className="text-faint">{hint}</span>}
      </span>
    </label>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  // Moves freely while dragging; saved when let go, so the settings file isn't written 60 times a second.
  const [live, setLive] = useState<number | null>(null);
  const shown = live ?? value;
  const save = () => {
    if (live !== null && live !== value) onChange(live);
    setLive(null);
  };
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-20 flex-none text-muted @md:w-28">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setLive(Number(e.target.value))}
        onPointerUp={save}
        onKeyUp={save}
        onBlur={save}
        className="min-w-0 flex-1 accent-[var(--color-accent)]"
      />
      {/* A fixed width, so dragging never moves the slider ("7 days" → "180 days" needs the wider one). */}
      <span className={`${unit.length > 2 ? 'w-20' : 'w-12'} flex-none text-right whitespace-nowrap tabular-nums`}>
        {shown}
        {unit}
      </span>
    </label>
  );
}

/** A small row of choices (one picked). */
export function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={ROW}>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`min-h-8 cursor-pointer rounded-lg border px-2.5 ${
              value === o.value ? 'border-accent bg-accent font-semibold text-[#0f1620]' : 'border-line text-muted hover:bg-white/5'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Several choices that can each be on or off. */
export function Chips<T extends string | number>({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: T[];
  options: { value: T; label: string }[];
  onChange: (v: T[]) => void;
}) {
  return (
    <div role="group" aria-label={label} className={ROW}>
      <span className={LABEL}>{label}</span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {options.map((o) => {
          const on = values.includes(o.value);
          return (
            <button
              key={String(o.value)}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(
                  on ? values.filter((v) => v !== o.value) : options.map((x) => x.value).filter((v) => v === o.value || values.includes(v)),
                )
              }
              className={`min-h-8 cursor-pointer rounded-lg border px-2.5 ${on ? 'border-accent bg-accent font-semibold text-[#0f1620]' : 'border-line text-faint hover:bg-white/5'}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A one-line text setting with a Save button (Enter saves too); Save lights up only when something changed. */
export function TextSetting({
  id,
  label,
  value,
  placeholder,
  onSave,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const changed = draft !== null && draft.trim() !== value;
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (changed) onSave(shown.trim());
    setDraft(null);
  };
  return (
    <form onSubmit={save} className={ROW}>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <div className="flex min-w-0 flex-1 gap-2">
        <input
          id={id}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className={INPUT}
        />
        <button type="submit" disabled={!changed} className={BUTTON}>
          Save
        </button>
      </div>
    </form>
  );
}

/** A list of paths (projects, read-only folders) with an × on each. */
export function PathList({
  items,
  onRemove,
}: {
  items: { key: string; title?: string; path: string; label: string }[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
      {items.map((p) => (
        <li key={p.key} className="flex items-center gap-2 rounded-lg bg-black/15 py-1 pr-1 pl-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            {p.title && <span className="truncate">{p.title}</span>}
            <span className={`truncate ${p.title ? 'text-[11px] text-faint' : ''}`} title={p.path}>
              {p.path}
            </span>
          </span>
          <button
            type="button"
            aria-label={p.label}
            title={p.label}
            onClick={() => onRemove(p.key)}
            className="size-7 flex-none cursor-pointer rounded text-muted hover:bg-white/10"
          >
            <Icon name="close" size={12} className="mx-auto block" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A path box with an Add button (projects, read-only folders). */
export function AddPath({
  id,
  label,
  placeholder,
  onAdd,
}: {
  id: string;
  label: string;
  placeholder: string;
  onAdd: (path: string) => void;
}) {
  const [draft, setDraft] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.trim()) return;
        onAdd(draft.trim());
        setDraft('');
      }}
      className="flex gap-2"
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={INPUT}
      />
      <button type="submit" disabled={!draft.trim()} className={BUTTON}>
        Add
      </button>
    </form>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={BUTTON}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          },
          () => {},
        );
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
      <span className="text-faint">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-1.5 py-0.5 text-ink select-all">{value}</code>
      <CopyButton text={value} />
    </div>
  );
}
