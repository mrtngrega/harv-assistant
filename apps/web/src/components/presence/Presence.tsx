import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Tab } from '../../lib/chatStore.ts';
import { moonOf, presenceState, PRESENCE_MIN_WIDTH, type Moon, type PresenceState } from '../../lib/presence.ts';
import { useSafety } from '../../lib/safetyStore.ts';
import { onServerMessage } from '../../lib/socket.ts';
import { heldWaiting } from '../../lib/turns.ts';
import { countdown, resetTime } from '../../lib/format.ts';
import { useConnection, useSettings, useUsage } from '../../lib/useHarvSocket.ts';
import { PresenceEngine } from './engine.ts';
import { setHang, useNotices } from '../../lib/notices.ts';

/** A tool ran since the chat's last message (for a chat opened mid-reply). */
const toolSinceAsk = (tab: Tab) => {
  for (let i = tab.lines.length - 1; i >= 0; i--) {
    const kind = tab.lines[i]!.kind;
    if (kind === 'you') return false;
    if (kind === 'tool') return true;
  }
  return false;
};

/** Harv's presence_demo (ms from the start): every state once, ~25 s, nothing real behind it. */
type DemoStep = [number, PresenceState, Moon | null, number?] | [number, 'error' | 'done'];
const DEMO: DemoStep[] = [
  [0, 'thinking', null],
  [2600, 'working', 'files'],
  [3800, 'working', 'files'],
  [5000, 'working', 'memory'],
  [6300, 'working', 'shell'],
  [7600, 'working', 'helpers', 2],
  [9200, 'working', 'web', 2],
  [10600, 'working', 'shell'],
  [11900, 'desktop', null],
  [15000, 'waiting', null],
  [19000, 'asleep', null],
  [23000, 'error'],
  [24800, 'working', 'files'],
  [26000, 'done'],
];

/** The demo: a script of states and tool pulses, then back to what's really happening. */
function playDemo(
  engine: RefObject<PresenceEngine | null>,
  demo: RefObject<number[] | null>,
  real: RefObject<{ state: PresenceState; helpers: number }>,
  setDemoTag: (tag: string | null) => void,
) {
  for (const t of demo.current ?? []) clearTimeout(t);
  const timers: number[] = [];
  demo.current = timers;
  const START = 1500;
  for (const step of DEMO)
    timers.push(
      window.setTimeout(() => {
        const e = engine.current;
        if (!e) return;
        // Asleep shows its countdown tag in the demo too (a made-up time).
        setDemoTag(step[1] === 'asleep' ? '1h 12m' : null);
        if (step[1] === 'error') {
          e.setState('working', 0);
          e.done(false);
        } else if (step[1] === 'done') {
          e.setState('idle', 0);
          e.done(true);
        } else {
          e.setState(step[1], step[3] ?? 0);
          if (step[2]) e.tool(step[2]);
        }
      }, START + step[0]),
    );
  timers.push(
    window.setTimeout(
      () => {
        demo.current = null;
        setDemoTag(null);
        engine.current?.setState(real.current.state, real.current.helpers);
      },
      START + DEMO.at(-1)![0] + 3000,
    ),
  );
}

/** "1h 12m" until the plan limit resets, kept current each minute while `at` is set; null otherwise. */
function useBackIn(at: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    setNow(Date.now());
    // On the minute the countdown changes, then every minute.
    let timer = window.setTimeout(
      function tick() {
        setNow(Date.now());
        timer = window.setTimeout(tick, 60_000);
      },
      ((((at - Date.now()) % 60_000) + 60_000) % 60_000) + 50,
    );
    return () => clearTimeout(timer);
  }, [at]);
  return at === null ? null : countdown(at, now);
}

/**
 * Harv presence (docs/review/pass-c.md C1): his face and six moons in a glass hammock that hangs
 * from the chat's top edge while he works, for the chat on screen only. Nothing in narrow chats or
 * on the phone; the full look on a computer without a battery, the light one on a laptop.
 * Drawn by `PresenceEngine` outside React; this only tells it what happens.
 */
export function Presence({ tab }: { tab: Tab }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const glass = useRef<HTMLDivElement>(null);
  const edge = useRef<SVGPathElement>(null);
  const edgeSvg = useRef<SVGSVGElement>(null);
  const engine = useRef<PresenceEngine | null>(null);
  const [width, setWidth] = useState(0);
  const conn = useConnection();
  const { motion } = useSettings();
  const { approvals, desktop } = useSafety();
  const [demoTag, setDemoTag] = useState<string | null>(null);
  const [toolRan, setToolRan] = useState(() => tab.busy && toolSinceAsk(tab));
  const tier = conn.battery ? 'light' : 'full';
  /** While the demo plays, the real state waits (it comes back when the demo ends). */
  const demo = useRef<number[] | null>(null);
  const real = useRef<{ state: PresenceState; helpers: number }>({ state: 'idle', helpers: 0 });
  const wide = width >= PRESENCE_MIN_WIDTH;

  // The chat's width (the parent's), so the hammock fits it and narrow chats show nothing.
  useEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setWidth(parent.clientWidth));
    ro.observe(parent);
    setWidth(parent.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!wide || !canvas.current || !wrap.current || !glass.current || !edge.current || !edgeSvg.current) return;
    const shell = { clip: box.current!, wrap: wrap.current, glass: glass.current, edge: edge.current, edgeSvg: edgeSvg.current };
    const e = new PresenceEngine(canvas.current, shell, tier, !motion);
    engine.current = e;
    // UI checks drive it without a real turn (dev builds only; Harv always runs the dev server).
    if (import.meta.env.DEV) (window as unknown as { harvPresence?: PresenceEngine }).harvPresence = e;
    return () => {
      e.destroy();
      engine.current = null;
    };
    // The engine is made once per chat; look changes go through setLook below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wide]);

  // UI checks play the demo without a chat turn (dev builds only).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { harvPresenceDemo?: () => void };
    w.harvPresenceDemo = () => playDemo(engine, demo, real, setDemoTag);
    return () => {
      delete w.harvPresenceDemo;
    };
  }, []);

  useEffect(() => engine.current?.setLook(tier, !motion), [tier, motion]);
  useEffect(() => {
    if (wide) engine.current?.resize(width);
  }, [width, wide]);

  // Tool calls and the reply's end, as they happen.
  useEffect(
    () =>
      onServerMessage((msg) => {
        if (!('tabId' in msg) || msg.tabId !== tab.id) return;
        if (msg.type === 'chat.started') setToolRan(false);
        if (msg.type === 'chat.tool') {
          setToolRan(true);
          engine.current?.tool(moonOf(msg.name, msg.detail));
        }
        if (msg.type === 'chat.done' && !demo.current) engine.current?.done(msg.ok || msg.stopped);
        if (msg.type === 'presence.demo') playDemo(engine, demo, real, setDemoTag);
      }),
    [tab.id],
  );

  const state = presenceState({
    busy: tab.busy,
    toolRan,
    waiting: heldWaiting(tab.lines) > 0 || approvals.some((a) => a.tabId === tab.id),
    driving: desktop?.tabId === tab.id,
    asleep: conn.status === 'paused' && (tab.busy || (tab.queued?.length ?? 0) > 0),
  });
  const helpers = (tab.tasks ?? []).filter((t) => t.status === 'running' && t.kind === 'local_agent').length;
  const pausedUntil = useUsage()?.pausedUntil ?? null;
  const realBackIn = useBackIn(state === 'asleep' ? pausedUntil : null);
  const backIn = demoTag ?? realBackIn;
  useEffect(() => {
    real.current = { state, helpers };
    if (!demo.current) engine.current?.setState(state, helpers);
  }, [state, helpers, wide]);

  useEffect(() => () => demo.current?.forEach((t) => clearTimeout(t)), []);

  // A notice: he comes down to say it, and the bubble hangs just under the hammock (docs/PLAN.md §6ad).
  const saying = useNotices().queue[0]?.level ?? null;
  useEffect(() => {
    const e = engine.current;
    if (!wide || !e) return setHang(0);
    e.say(saying);
    setHang(saying ? Math.round(e.reach().depth) + 8 : 0);
  }, [saying, wide, width]);
  useEffect(() => () => setHang(0), []);

  // The mouse near the hammock: he pulls back up out of the way.
  useEffect(() => {
    const area = box.current?.parentElement;
    if (!area || !wide) return;
    // Near = inside the hammock's full-size box; once away, the mouse has to go a bit further out
    // before he comes back (a single edge made him bob up and down under a slow mouse).
    let away = false;
    const move = (ev: PointerEvent) => {
      const e = engine.current;
      if (!e) return;
      const r = area.getBoundingClientRect();
      const { half, depth } = e.reach();
      const x = Math.abs(ev.clientX - r.left - r.width / 2);
      const y = ev.clientY - r.top;
      const margin = away ? 40 : 0;
      // The hammock narrows towards its bottom: the box is its middle part plus the face's column.
      const near = (x < half * 0.55 + margin && y < depth * 0.6 + margin) || (x < half * 0.3 + margin && y < depth + margin);
      if (near !== away) {
        away = near;
        e.setAway(near);
      }
    };
    const leave = () => {
      away = false;
      engine.current?.setAway(false);
    };
    area.addEventListener('pointermove', move);
    area.addEventListener('pointerleave', leave);
    return () => {
      area.removeEventListener('pointermove', move);
      area.removeEventListener('pointerleave', leave);
    };
  }, [wide]);

  return (
    // The box clips (the engine gives it the hammock's height): sliding up, he goes behind the tab
    // bar's bottom edge instead of over the tabs.
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[5] flex justify-center overflow-hidden">
      {/* At rest only a faint glint on the edge, where he'll drop from: a still line, no frames (amber at a limit). */}
      {wide && (
        <div
          className="absolute top-0 h-[1.5px] w-[140px]"
          style={{
            background: `linear-gradient(90deg, transparent, ${state === 'asleep' || state === 'waiting' ? 'rgb(242 184 128 / 0.5)' : 'rgb(168 200 232 / 0.45)'}, transparent)`,
          }}
        />
      )}
      {wide && (
        // The hammock: tinted glass (lighter, so the chat shows through; a blur can't work inside the
        // chat panel's own glass, and broke the clip), a lit edge, and the canvas with his face and
        // moons. It slides by transform (engine.place()); glass and edge are never repainted.
        <div ref={wrap} className="relative shrink-0 origin-top" style={{ visibility: 'hidden', willChange: 'transform' }}>
          <div
            ref={glass}
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(180deg, rgb(16 24 34 / 0.1) 0%, rgb(16 24 34 / 0.34) 100%)',
            }}
          />
          <svg ref={edgeSvg} className="absolute inset-0 size-full overflow-visible">
            <defs>
              <linearGradient id="harv-presence-edge" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="rgb(220 232 245)" stopOpacity="0.08" />
                <stop offset="1" stopColor="rgb(220 232 245)" stopOpacity="0.38" />
              </linearGradient>
            </defs>
            <path ref={edge} fill="none" stroke="url(#harv-presence-edge)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          {/* Its own layer, only as big as the planet system: a frame repaints this and nothing under it. */}
          <canvas ref={canvas} className="absolute" style={{ willChange: 'transform' }} />
        </div>
      )}
      {/* Asleep at a plan limit: when he's back, hanging from the glint; it stays after the hammock goes up (the user, 2026-11-13). */}
      {wide && backIn && (
        <div
          data-presence-reset
          className="absolute top-[5px] rounded-full px-2 py-px text-[10.5px] tracking-wide whitespace-nowrap"
          style={{ color: 'rgb(242 184 128 / 0.9)', background: 'rgb(10 16 24 / 0.55)' }}
          title={pausedUntil ? `The plan limit resets at ${resetTime(pausedUntil)}` : undefined}
        >
          asleep · back in {backIn}
        </div>
      )}
    </div>
  );
}
