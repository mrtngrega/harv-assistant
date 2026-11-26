import { EFFORT_LEVELS, type EffortLevel } from '@harv/shared';
import { chat, useChat } from '../lib/chatStore.ts';
import { useCatalog } from '../lib/useHarvSocket.ts';
import { Rollout } from './Rollout.tsx';

const EFFORT_LABEL: Record<EffortLevel, string> = { low: 'LOW', medium: 'MED', high: 'HIGH', xhigh: 'XHI', max: 'MAX' };

function Segment({ on, label, title, onClick }: { on: boolean; label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`min-h-[34px] cursor-pointer rounded-[9px] px-3 text-xs font-semibold whitespace-nowrap transition-colors ${
        on ? 'bg-accent text-[#0f1620]' : 'text-[#d5dee7] hover:bg-white/5'
      }`}
    >
      {label}
    </button>
  );
}

/** `effort` when the model has it (or lists none), else the highest it has below it, else its lowest. */
export function nearestEffort(effort: EffortLevel, has: readonly EffortLevel[]): EffortLevel {
  if (!has.length || has.includes(effort)) return effort;
  const at = EFFORT_LEVELS.indexOf(effort);
  const below = has.filter((e) => EFFORT_LEVELS.indexOf(e) < at);
  const byRank = (a: EffortLevel, b: EffortLevel) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b);
  return below.length ? below.sort(byRank).at(-1)! : [...has].sort(byRank)[0]!;
}

export function ModelSwitcher() {
  const catalog = useCatalog();
  const { model, effort } = useChat();
  const current = catalog?.models.find((m) => m.id === model);
  const efforts = current?.efforts.length ? current.efforts : EFFORT_LEVELS;

  const models = (
    <div
      role="group"
      aria-label="Model"
      className={`flex max-w-full flex-wrap gap-1 rounded-xl p-[3px] ${ROLLED}`}
    >
      <Segment on={model === 'auto'} label="AUTO" title="Harv picks the model and effort" onClick={() => chat.setModel('auto')} />
      {catalog ? (
        catalog.models.map((m) => (
          <Segment
            key={m.id}
            on={model === m.id}
            label={m.name}
            title={m.description}
            onClick={() => {
              chat.setModel(m.id);
              // A model without the current effort: the nearest one it has, so one effort stays lit (the full review, U18).
              const near = nearestEffort(effort, m.efforts);
              if (near !== effort) chat.setEffort(near);
            }}
          />
        ))
      ) : (
        <span className="flex items-center px-3 text-xs text-faint">loading models…</span>
      )}
    </div>
  );
  // AUTO picks per message; each reply's [model·effort] tag says what it picked and why.
  const effortRow =
    model !== 'auto' ? (
      <div role="group" aria-label="Effort" className={`flex gap-1 rounded-xl p-[3px] ${ROLLED}`}>
        {efforts.map((e) => (
          <Segment key={e} on={effort === e} label={EFFORT_LABEL[e]} title={`${e} effort`} onClick={() => chat.setEffort(e)} />
        ))}
      </div>
    ) : null;

  // Folded to the current pick; each rolls out on its own on hover (the user's wish, 2026-11-14).
  return (
    <div className="flex items-center gap-2">
      <Rollout label="Model" folded={<Folded label={model === 'auto' ? 'AUTO' : (current?.name ?? model)} />}>
        {models}
      </Rollout>
      {effortRow && (
        <Rollout label="Effort" folded={<Folded label={EFFORT_LABEL[effort]} />}>
          {effortRow}
        </Rollout>
      )}
    </div>
  );
}

/** The open row over its neighbours: glass dark enough to read on. */
const ROLLED = 'border border-[rgb(220_232_245/0.12)] bg-[rgb(16_24_34/0.92)] shadow-lg backdrop-blur-md';

/** A folded picker: the current pick, lit like the selected segment, and a hint that more is behind it. */
export function Folded({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1 rounded-xl border border-transparent bg-black/20 p-[3px]">
      <span className="flex min-h-[34px] items-center gap-1.5 rounded-[9px] bg-accent px-3 text-xs font-semibold whitespace-nowrap text-[#0f1620]">
        {label}
      </span>
      <span aria-hidden="true" className="pr-1.5 pl-0.5 text-[10px] text-muted">
        ‹
      </span>
    </span>
  );
}
