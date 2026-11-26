import { answerStart } from '../lib/chatStore.ts';
import { Icon } from './tools/explorer/icons.tsx';
import { STRIP_ACTION, STRIP_NOTE, STRIP_QUIET } from './strip.ts';

/**
 * A chat from before Harv started just continues its session with Claude. This quiet note at the
 * right of the status line offers a new session instead (the critique, 2026-11-09: a box over every
 * chat after each restart was a click per chat; 2026-11-10: a row of its own made the bottom of the
 * chat three stacked lines). Sending a message or × answers it.
 */
export function StartChoice({ tabId }: { tabId: string }) {
  // 24 px targets (they were 20×12 and 15 px tall: the full review, U26), the status line's own row height.
  return (
    <span role="note" className="animate-fade-in ml-auto flex min-w-0 flex-none items-center gap-1 text-[11px] text-faint">
      <span className={`${STRIP_NOTE} hidden truncate md:inline`}>Harv still remembers this chat ·</span>
      <button
        type="button"
        onClick={() => answerStart(tabId, 'new')}
        className={`${STRIP_ACTION} text-accent/90 hover:bg-white/10 hover:text-accent`}
      >
        start it clean
      </button>
      <button
        type="button"
        aria-label="Keep his memory of this chat"
        title="Keep his memory of this chat"
        onClick={() => answerStart(tabId, 'continue')}
        className={`${STRIP_ACTION} ${STRIP_QUIET} hover:text-ink`}
      >
        <Icon name="close" size={12} className="block" />
      </button>
    </span>
  );
}
