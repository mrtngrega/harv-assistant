import { MOONS, type Moon, type PresenceState } from '../../lib/presence.ts';

// Harv presence (docs/review/pass-c.md C1; after docs/review/presence-mockup.html v5): a glass hammock
// hanging from the chat's top edge while Harv works, his face in it with six moons round it.
// It lives outside React, so its frames never re-render the chat.
//
// How it's drawn, and what it costs (the notebook's battery, PLAN §6p; the user's GPU checks 2026-11-12):
// - The hammock itself is DOM: a fixed-shape tinted-glass element (clip-path; no backdrop blur: it
//   can't work inside the chat panel's own glass) with an SVG edge, made once per size and never
//   touched again. Sliding down and up is a CSS transform on its wrapper, which the compositor
//   moves without redrawing; while it hangs still no style is written at all; at rest it's hidden.
//   The box round it clips, so it comes out from under the tab bar and goes back behind it.
// - Only the face and moons are on the canvas, which is its own layer and only as big as the
//   system (not the hammock), so a frame repaints and uploads that and nothing else (on the
//   notebook's WebKitGTK a canvas frame otherwise re-rasters the glass and the edge under it).
//   Everything round and soft (glows, the face's body, the moons' lit spheres, the orbit rings) is
//   drawn once into sprites and reused; no blur filters, no per-frame gradients, no clip.
// - No frames at rest, while the window is hidden, or while the mouse keeps him up; a still frame
//   after 10 s of waiting or sleeping; the full look 60 frames a second, the light one (a battery
//   computer) 30 at the screen's plain resolution, paced to the screen; motion off draws once per
//   change.

export type Tier = 'full' | 'light';

/** The DOM parts the engine moves (made by Presence.tsx). */
export interface Shell {
  /** The box round it all: clips the slide at the chat's top edge (the tab bar's bottom). */
  clip: HTMLElement;
  /** Holds glass, edge and canvas; slides by transform. */
  wrap: HTMLElement;
  /** The tinted glass, clipped to the hammock's shape. */
  glass: HTMLElement;
  /** The SVG path of its edge. */
  edge: SVGPathElement;
  edgeSvg: SVGSVGElement;
}

const C = { accent: '#a8c8e8', warn: '#f2b880', bad: '#f08a8a', grey: '#8a98a6', ink: '#dce8f5' };
/**
 * Laps per orbit cycle: every moon its own speed (inner ones faster). Whole numbers, so all six line
 * up in one row (on the right, where the orbits are far enough apart) once a cycle and no more:
 * rare, like the DVD logo hitting the corner (the user, 2026-11-12). Pairs still meet more often.
 */
const LAPS: Record<Moon, number> = { memory: 21, files: 17, shell: 14, web: 11, helpers: 8, desktop: 6 };
/** Orbit-clock seconds per cycle: ~4 minutes of work at the working pace. */
const ORBIT_CYCLE = 300;
/** Where in the cycle they line up. */
const LINE_AT = 0.37;
/** Orbit radius per moon (× the system's size): far enough apart that moons side by side on the right don't touch. */
const ORBIT = (i: number) => 0.4 + i * 0.14;
/** The orbit clock runs on across chats and turns (it starts somewhere random, not at the line). */
let orbitClock = (0.45 + Math.random() * 0.5) * ORBIT_CYCLE;
const TILT = -0.16;
const FLAT = 0.42;
/** The hammock's depth (× R). */
const DEPTH = 1.78;
/** How round the bottom is: the curve's inner control point (× half width). */
const BELLY = 0.62;
/**
 * The planet system inside the hammock: its size (× R; face, orbits, moons and labels all scale with
 * it) and how high the face sits (× R). As big as fits with a little air all round, see fits()
 * (the user, 2026-11-12: the hammock stays as it is, the system fills it).
 */
const SYSTEM = 1.1;
const FACE_FROM_BOTTOM = 0.94;
/** The face's radius (× the system's size). */
const FACE = 0.32;
/** Room kept between a label and the hammock's edge (px). */
const AIR = 4;
/** Waiting or asleep this long: one still frame, no loop. */
const FREEZE_S = 10;
/** Asleep this long at a plan limit: the hammock goes back up (the user, 2026-11-12). */
const SLEEP_UP_S = 60;
/**
 * Frame budget: the full look 60 a second, the light one (a battery computer) 30. The user's pick after
 * the notebook's GPU measured ~55-70 % busy at 45 fps and ~30 % at 20 (WebKitGTK repaints with every frame).
 */
const FRAME_MS = { full: 1000 / 60, light: 1000 / 30 } as const;
/** After the mouse leaves, he waits this long before dropping back. */
const BACK_MS = 450;
/**
 * The slide is one spring [stiffness, damping] both ways, so it never jumps when it turns round
 * half-way. Down: a little under-damped, it overshoots ~5 % (the slack stretches) and settles.
 * Up: critically damped, a soft start and no bounce; quicker when the mouse wants him out of the way.
 */
const SPRING = { down: [55, 10.4], up: [140, 23.7], away: [300, 34.6] } as const;
/** The most the overshoot stretches the hammock. */
const STRETCH = 1.08;

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
};
const ease = (from: number, to: number, rate: number, dt: number) => from + (to - from) * Math.min(1, dt * rate);

// ── Sprites: drawn once, reused every frame ──

const sprites = new Map<string, HTMLCanvasElement>();
/** `family`: a sprite made per size; only the newest size is kept (dragging the window's edge made hundreds). */
function cached(key: string, size: number, paint: (g: CanvasRenderingContext2D, s: number) => void, family?: string): HTMLCanvasElement {
  let s = sprites.get(key);
  if (s) return s;
  if (family) for (const old of [...sprites.keys()]) if (old.startsWith(family)) sprites.delete(old);
  s = document.createElement('canvas');
  s.width = s.height = Math.max(8, Math.ceil(size));
  paint(s.getContext('2d')!, s.width);
  sprites.set(key, s);
  return s;
}

/** A soft round glow. */
const glowSprite = (color: string) =>
  cached(`glow ${color}`, 64, (g, s) => {
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, rgba(color, 1));
    grad.addColorStop(0.35, rgba(color, 0.45));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });

/** A small lit sphere (light from the top left), plain or lit up. */
const moonSprite = (color: string, lit: boolean) =>
  cached(`moon ${color} ${lit}`, 48, (g, s) => {
    const r = s / 2 - 1;
    const grad = g.createRadialGradient(s / 2 - r * 0.35, s / 2 - r * 0.4, r * 0.1, s / 2, s / 2, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, lit ? '#e8f2fc' : color);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(s / 2, s / 2, r, 0, 6.29);
    g.fill();
  });

/** Harv's face without the eyes: dark glass with a lit rim's highlight (size in device pixels). */
const faceSprite = (px: number) =>
  cached(
    `face ${Math.round(px)}`,
    px,
    (g, s) => {
      const r = s / 2 - 1;
      const c = s / 2;
      const body = g.createRadialGradient(c - r * 0.35, c - r * 0.4, r * 0.1, c, c, r);
      body.addColorStop(0, '#2c4054');
      body.addColorStop(1, '#0d141c');
      g.fillStyle = body;
      g.beginPath();
      g.arc(c, c, r, 0, 6.29);
      g.fill();
      g.beginPath();
      g.arc(c, c, r * 0.82, Math.PI * 1.15, Math.PI * 1.45);
      g.strokeStyle = 'rgba(255,255,255,0.2)';
      g.lineWidth = Math.max(1, r * 0.05);
      g.lineCap = 'round';
      g.stroke();
    },
    'face ',
  );

/** The six orbit rings, faint (size in device pixels; `unit` = the system's size in them). */
const orbitSprite = (px: number, unit: number, line: number) =>
  cached(
    `orbits ${Math.round(px)}`,
    px,
    (g, s) => {
      g.lineWidth = line;
      g.strokeStyle = rgba(C.ink, 0.085);
      MOONS.forEach((_, i) => {
        g.beginPath();
        g.ellipse(s / 2, s / 2, unit * ORBIT(i), unit * ORBIT(i) * FLAT, TILT, 0, 6.29);
        g.stroke();
      });
    },
    'orbits ',
  );

export class PresenceEngine {
  private ctx: CanvasRenderingContext2D;
  /** Canvas pixels per CSS pixel. */
  private scale = 1;
  private chatWidth = 0;
  // The fixed layout (layout()). R is the hammock's unit, S the planet system's.
  private W = 0;
  private H = 0;
  private R = 0;
  private S = 0;
  private D = 0;
  private half = 0;
  private cx = 0;
  private cy = 0;
  /** The hammock's half width at each pixel row (labels and fits() ask it). */
  private rows = new Float32Array(0);
  /** The canvas inside the hammock: only the system's box (CSS px, whole numbers). */
  private box = { x: 0, y: 0, w: 0, h: 0 };
  /** Nothing is on the canvas (so a hidden frame needn't clear it again). */
  private blank = true;
  // Time and the loop
  private state: PresenceState = 'idle';
  /** When the state began (wall clock, ms): a frozen frame stops `t`, not this. */
  private sinceMs = 0;
  private t = 0;
  private last = 0;
  private running = false;
  private timer = 0;
  private backTimer = 0;
  private raf = 0;
  /** Time owed to the next frame (vsync-paced, so 30 a second on a 60 Hz screen is every other frame). */
  private owed = 0;
  private tick = 0;
  private awayUntil = 0;
  // Motion
  private ext = 0;
  private extV = 0;
  private away = false;
  private flash = 0;
  private shake = 0;
  private linger = 0;
  private blink = 0;
  private nextBlink = 2;
  private look = { x: 0, y: 0 };
  private focus: Moon | null = null;
  private focusUntil = 0;
  private core = 0;
  /** 0–1: working with no tool in hand (thinking or writing between tools); he mulls instead of staring. */
  private mull = 0;
  private glow: Record<Moon, number> = { memory: 0, files: 0, shell: 0, web: 0, helpers: 0, desktop: 0 };
  private pulses: { to: Moon; k: number; hit: boolean }[] = [];
  private helpers = 0;
  /** Each moon's make-way offset on its orbit (radians), see spread(). */
  private offset: Record<Moon, number> = { memory: 0, files: 0, shell: 0, web: 0, helpers: 0, desktop: 0 };
  /** The moons whose names this frame shows (drawn last, see labels()). */
  private named: { m: Moon; x: number; y: number; size: number; alpha: number }[] = [];
  /** The wrapper's transform as last set (only changed when it moves). */
  private shown = '';

  constructor(
    private canvas: HTMLCanvasElement,
    private shell: Shell,
    private tier: Tier,
    private still: boolean,
  ) {
    this.ctx = canvas.getContext('2d')!;
    document.addEventListener('visibilitychange', this.onVisible);
    this.place();
  }

  destroy() {
    this.stop();
    clearTimeout(this.timer);
    clearTimeout(this.backTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.shell.clip.style.height = '';
  }

  setLook(tier: Tier, still: boolean) {
    if (tier === this.tier && still === this.still) return;
    const resized = tier !== this.tier;
    this.tier = tier;
    this.still = still;
    this.stop();
    // The light look's canvas has its own resolution.
    if (resized && this.chatWidth) this.layout();
    this.kick();
  }

  /** The chat's width: the hammock's size and shape follow it (made once per size). */
  resize(chatWidth: number) {
    if (chatWidth === this.chatWidth) return;
    this.chatWidth = chatWidth;
    this.layout();
  }

  private layout() {
    const R = this.radius();
    this.R = R;
    this.S = R * SYSTEM;
    this.half = Math.min(this.chatWidth / 2 - 14, Math.max(R * 2.8, this.chatWidth * 0.3));
    this.D = R * DEPTH;
    this.W = Math.ceil(this.half * 2 + 4);
    this.H = Math.ceil(this.D + 2);
    this.cx = this.W / 2;
    this.cy = this.D - R * FACE_FROM_BOTTOM;
    const d = this.pathData();
    this.measure();
    const { clip, wrap, glass, edge, edgeSvg } = this.shell;
    // Room for the overshoot's stretch; everything above the box's top is cut off (the slide).
    clip.style.height = `${Math.ceil(this.H * STRETCH) + 2}px`;
    wrap.style.width = `${this.W}px`;
    wrap.style.height = `${this.H}px`;
    glass.style.clipPath = `path('${d} Z')`;
    edgeSvg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    edge.setAttribute('d', d);

    // The canvas: the system's box only. Its widest things are a lit moon's glow and a label.
    const k = this.k();
    const pad = 30 * k + 4;
    const reachX = this.S * ORBIT(MOONS.length - 1) + pad;
    const reachY = this.S * ORBIT(MOONS.length - 1) * 0.45 + pad;
    const x = Math.max(0, Math.floor(this.cx - reachX));
    const y = Math.max(0, Math.floor(this.cy - reachY));
    this.box = {
      x,
      y,
      w: Math.min(this.W, Math.ceil(this.cx + reachX)) - x,
      h: Math.min(this.H, Math.ceil(this.cy + reachY)) - y,
    };
    // The light look draws at the screen's plain resolution (a 1.05× notebook screen gains nothing
    // from 10 % more pixels to draw and upload); a real high-density screen gets 1.5×.
    const dpr = window.devicePixelRatio || 1;
    this.scale = this.tier === 'light' ? (dpr < 1.3 ? 1 : Math.min(dpr, 1.5)) : Math.min(2, dpr);
    const { canvas, box } = this;
    canvas.width = Math.ceil(box.w * this.scale);
    canvas.height = Math.ceil(box.h * this.scale);
    canvas.style.left = `${box.x}px`;
    canvas.style.top = `${box.y}px`;
    canvas.style.width = `${box.w}px`;
    canvas.style.height = `${box.h}px`;
    // Drawing keeps the hammock's coordinates.
    this.ctx.setTransform(this.scale, 0, 0, this.scale, -box.x * this.scale, -box.y * this.scale);
    this.blank = true;
    this.draw();
  }

  /** The hammock's outline: one long slack curve, leaving the bar far out, round at the bottom. */
  private pathData(): string {
    const { cx, half, D } = this;
    const n = (v: number) => v.toFixed(1);
    return (
      `M ${n(cx - half)} 0 C ${n(cx - half * 0.8)} 0 ${n(cx - half * BELLY)} ${n(D)} ${n(cx)} ${n(D)} ` +
      `C ${n(cx + half * BELLY)} ${n(D)} ${n(cx + half * 0.8)} 0 ${n(cx + half)} 0`
    );
  }

  /** The same curve as numbers: how wide the hammock is at each pixel row. */
  private measure() {
    const { half, D } = this;
    const rows = new Float32Array(Math.ceil(D) + 1);
    // From the rim down to the bottom: each row ends with its narrowest point.
    for (let i = 0; i <= 1200; i++) {
      const t = 1 - i / 1200;
      const u = 1 - t;
      const x = 3 * u * u * t * half * BELLY + 3 * u * t * t * half * 0.8 + t * t * t * half;
      const y = u * u * u * D + 3 * u * u * t * D;
      rows[Math.floor(y)] = x;
    }
    for (let r = rows.length - 2; r >= 0; r--) if (!rows[r]) rows[r] = rows[r + 1]!;
    this.rows = rows;
  }

  /** Is a point inside the hammock, with `air` px to spare? */
  private inside(x: number, y: number, air: number): boolean {
    if (y < air || y + air >= this.D) return false;
    const dx = Math.abs(x - this.cx) + air;
    return dx < this.rows[Math.floor(y)]! && dx < this.rows[Math.floor(y + air)]!;
  }

  private radius(chatWidth = this.chatWidth) {
    // 50 % bigger than the mockup (the user, 2026-11-12), never too big for the chat.
    return Math.max(84, Math.min(144, chatWidth * 0.135, chatWidth * 0.16));
  }

  /** Pixel sizes (moons, trails, labels) grow with the system. */
  private k() {
    return (this.S || this.radius() * SYSTEM) / 75;
  }

  setState(state: PresenceState, helpers: number) {
    this.helpers = helpers;
    if (state === this.state) return this.kick();
    const was = this.state;
    this.state = state;
    this.sinceMs = performance.now();
    if (state === 'desktop') {
      this.focus = 'desktop';
      this.focusUntil = Infinity;
      this.glow.desktop = 1;
    } else if (was === 'desktop') this.focus = null;
    this.kick();
  }

  /** A tool call: a pulse from the core to its moon, and the eyes turn there. No moon: the core glows. */
  tool(moon: Moon | null) {
    if (!moon) {
      this.core = 1;
    } else {
      // (Capped: while the mouse keeps him up nothing moves, and a long run of tools would pile up.)
      if (this.pulses.length < 8) this.pulses.push({ to: moon, k: 0, hit: false });
      this.focus = moon;
      this.focusUntil = this.t + 2.4;
      if (this.still) this.glow[moon] = 1;
    }
    this.kick();
  }

  /** The reply ended: a short flash (or a flinch on an error), then he pulls back up. */
  done(ok: boolean) {
    if (this.ext < 0.05 && this.state === 'idle') return;
    if (ok) this.flash = 1;
    else this.shake = 1;
    this.linger = 2;
    this.kick();
  }

  /**
   * A notice (docs/PLAN.md §6ad): he comes down to say it (the bubble hangs under him), looks at it,
   * amber for a warning, and doesn't pull up under the mouse meanwhile. null: nothing to say.
   */
  say(level: 'normal' | 'warning' | 'urgent' | null) {
    if (level === this.saying) return;
    this.saying = level;
    if (!level) this.linger = Math.max(this.linger, 0.6);
    this.kick();
  }
  private saying: 'normal' | 'warning' | 'urgent' | null = null;

  /** The mouse came near: he pulls back up out of the way. */
  setAway(away: boolean) {
    if (away === this.away) return;
    this.away = away;
    clearTimeout(this.backTimer);
    if (!away) {
      this.awayUntil = performance.now() + BACK_MS;
      // Nothing runs while he's up: come back when the wait is over.
      this.backTimer = window.setTimeout(() => this.kick(), BACK_MS + 20);
    }
    this.kick();
  }

  /** Away now, or the mouse left only a moment ago. */
  private isAway() {
    if (this.saying) return false;
    return this.away || performance.now() < this.awayUntil;
  }

  /** Always its full size, also while it's pulled up (a box that shrank with it made it flicker). */
  reach(): { half: number; depth: number } {
    return { half: this.half, depth: this.D };
  }

  /**
   * Does the whole system fit inside the hammock (UI checks)? Samples every moon round its orbit at
   * its biggest (lit, with the near part of its glow, at the breath's far end) and its label, and
   * the face's glow; returns the points that stick out.
   */
  fits(): { misses: number; worst: string } {
    if (!this.rows.length) return { misses: -1, worst: 'no layout' };
    const saved = { ...this.offset };
    const k = this.k();
    let misses = 0;
    let worst = '';
    const miss = (what: string) => {
      misses++;
      worst = what;
    };
    for (const m of MOONS)
      for (let a = 0; a < 6.28; a += 0.05) {
        this.offset[m] = a - this.angle(m) + this.offset[m];
        for (const breath of [-1.5 * k, 1.5 * k]) {
          const p = this.moonPos(m, this.cx, this.cy + breath, this.S);
          const size = (2.8 + p.depth * 1.7 + 2.8) * k;
          const at = `${m} at ${a.toFixed(2)} (${Math.round(p.x - this.cx)}, ${Math.round(p.y)} of depth ${Math.round(this.D)})`;
          for (let b = 0; b < 6.28; b += 0.785)
            if (!this.inside(p.x + Math.cos(b) * size * 1.6, p.y + Math.sin(b) * size * 1.6, 1)) miss(at);
          if (this.labelSpot(m, p.x, p.y, size).tight) miss(`the label of ${at}`);
        }
      }
    Object.assign(this.offset, saved);
    if (!this.inside(this.cx, this.cy + this.S * FACE * 1.5, 1)) miss('the face');
    return { misses, worst };
  }

  private age(): number {
    return (performance.now() - this.sinceMs) / 1000;
  }

  private wantOut(): boolean {
    if (this.saying) return true;
    if (this.state === 'asleep') return this.age() < SLEEP_UP_S;
    return this.state !== 'idle' || this.linger > 0;
  }

  private frozen(): boolean {
    return (
      (this.state === 'waiting' || this.state === 'asleep' || (!!this.saying && this.state === 'idle')) &&
      this.age() > FREEZE_S &&
      Math.abs(this.ext - 1) < 0.004 &&
      Math.abs(this.extV) < 0.01
    );
  }

  private onVisible = () => {
    if (document.hidden) this.stop();
    else this.kick();
  };

  /** Starts the loop if anything has to move; motion off draws once instead. */
  private kick() {
    if (this.still) {
      this.settleStill();
      this.place();
      this.draw();
      return;
    }
    if (this.running || document.hidden) return;
    this.running = true;
    this.last = this.tick = performance.now();
    this.owed = FRAME_MS[this.tier];
    this.schedule();
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private schedule() {
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  /** A frozen sleep still goes back up after a minute: wake for that. */
  private wakeForSleep() {
    if (this.state !== 'asleep' || this.age() >= SLEEP_UP_S) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.kick(), (SLEEP_UP_S - this.age()) * 1000 + 50);
  }

  /** Motion off: everything goes straight to where it ends; time doesn't run. */
  private settleStill() {
    const out = (this.state !== 'idle' || !!this.saying) && this.wantOut();
    this.wakeForSleep();
    this.ext = this.isAway() || !out ? 0 : 1;
    this.extV = 0;
    this.flash = this.shake = this.linger = this.blink = 0;
    this.pulses = [];
    if (!out) for (const m of MOONS) this.glow[m] = 0;
    this.look = this.lookTarget();
    // The moons stand still, but still apart.
    for (let k = 0; k < 40; k++) this.spread(0);
  }

  private frame(now: number) {
    if (!this.running) return;
    // Paced to the screen: draw when a frame's worth of time is owed (60 or 30 a second, any refresh rate).
    this.owed += now - this.tick;
    this.tick = now;
    const budget = FRAME_MS[this.tier];
    if (this.owed < budget - 2) return this.schedule();
    this.owed = Math.min(this.owed - budget, budget);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.step(dt);
    this.place();
    this.draw();
    // Up and still (work over, or the mouse keeps him up): nothing to draw, so no frames.
    const up = this.ext < 0.002 && Math.abs(this.extV) < 0.002 && (!this.wantOut() || this.isAway());
    if (up || this.frozen()) {
      this.running = false;
      this.wakeForSleep();
      return;
    }
    this.schedule();
  }

  private step(dt: number) {
    this.linger = Math.max(0, this.linger - dt);
    const away = this.isAway();
    const target = this.wantOut() && !away ? 1 : 0;
    const [stiff, damp] = SPRING[target ? 'down' : away ? 'away' : 'up'];
    // Small steps: a late frame mustn't make the stiff springs overshoot.
    for (let left = dt; left > 1e-6; left -= 1 / 240) {
      const h = Math.min(left, 1 / 240);
      this.extV += ((target - this.ext) * stiff - this.extV * damp) * h;
      this.ext += this.extV * h;
    }
    if (this.ext <= 0) {
      this.ext = 0;
      this.extV = Math.max(0, this.extV);
    }
    this.flash = Math.max(0, this.flash - dt * 1.4);
    this.shake = Math.max(0, this.shake - dt * 1.1);
    this.core = Math.max(0, this.core - dt * 1.2);
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && (this.state === 'working' || this.state === 'idle')) {
      this.blink = 1;
      this.nextBlink = 2.5 + Math.random() * 3;
    }
    this.blink = Math.max(0, this.blink - dt * 7);
    orbitClock += dt * this.speed();
    this.spread(dt);
    if (this.focus && (this.t > this.focusUntil || !['working', 'desktop'].includes(this.state))) this.focus = null;
    // The user's report (2026-11-14): between tools he just stared. Eased in, so a quick next tool doesn't flicker it.
    const mulling = this.state === 'working' && !this.focus && !this.still;
    this.mull = ease(this.mull, mulling ? 1 : 0, mulling ? 1.5 : 5, dt);
    const want = this.lookTarget();
    this.look.x = ease(this.look.x, want.x, 6, dt);
    this.look.y = ease(this.look.y, want.y, 6, dt);
    for (const m of MOONS) this.glow[m] = Math.max(0, this.glow[m] - dt * 0.8);
    for (const p of this.pulses) {
      p.k += dt * 1.5;
      if (p.k >= 1 && !p.hit) {
        p.hit = true;
        this.glow[p.to] = 1;
      }
    }
    this.pulses = this.pulses.filter((p) => p.k < 1.1);
  }

  /**
   * Slides the hammock (a transform the compositor moves, no repaint): fully up = hidden. The
   * spring's overshoot stretches it a little from the top. Hanging still, nothing is written.
   */
  private place() {
    const e = this.ext;
    const { wrap } = this.shell;
    if (e < 0.004) {
      if (this.shown !== 'hidden') {
        wrap.style.visibility = 'hidden';
        this.shown = 'hidden';
      }
      return;
    }
    // At rest exactly no offset, so the glass and the canvas sit on whole pixels.
    const slide = -(1 - Math.min(1, e)) * (this.H + 2);
    const stretch = Math.min(STRETCH, Math.max(1, e));
    const t = `translate3d(0, ${Math.abs(slide) < 0.05 ? 0 : slide.toFixed(1)}px, 0) scaleY(${stretch < 1.0005 ? 1 : stretch.toFixed(3)})`;
    if (t === this.shown) return;
    if (this.shown === 'hidden' || !this.shown) wrap.style.visibility = 'visible';
    wrap.style.transform = t;
    this.shown = t;
  }

  private tint(): string {
    if (this.saying && this.saying !== 'normal') return C.warn;
    if (this.state === 'waiting') return C.warn;
    if (this.state === 'asleep') return C.grey;
    if (this.shake > 0.05) return C.bad;
    return C.accent;
  }

  private speed(): number {
    const s = { idle: 0.5, thinking: 1.6, working: 1.2, waiting: 0.2, desktop: 1, asleep: 0.1 }[this.state];
    return this.still ? 0 : s;
  }

  // ── Orbits ──

  /** A moon's angle on its orbit now: its own speed on the orbit clock, plus its make-way offset. */
  private angle(m: Moon): number {
    const laps = LAPS[m] * (orbitClock / ORBIT_CYCLE - LINE_AT);
    return 2 * Math.PI * (laps - Math.floor(laps)) + this.offset[m];
  }

  /** Moon sizes as drawn (nearer ones bigger, a lit one bigger still). */
  private size(m: Moon, depth: number) {
    return (2.8 + depth * 1.7 + this.glow[m] * 2.8) * this.k();
  }

  /**
   * Moons never overlap: when two come too close (where the flattened orbits run near each other),
   * the one behind holds back and the one ahead moves on, so the faster one passes on the side,
   * where the orbits are apart. The offsets ease back to nothing, so the line-up still comes.
   */
  private spread(dt: number) {
    const S = this.S || this.radius() * SYSTEM;
    for (const m of MOONS) this.offset[m] *= Math.max(0, 1 - dt * 0.35);
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < MOONS.length; i++)
        for (let j = i + 1; j < MOONS.length; j++) {
          const a = MOONS[i]!;
          const b = MOONS[j]!;
          const pa = this.moonPos(a, 0, 0, S);
          const pb = this.moonPos(b, 0, 0, S);
          const need = this.size(a, pa.depth) + this.size(b, pb.depth) + 3 * this.k();
          const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
          if (d >= need) continue;
          let gap = this.angle(b) - this.angle(a);
          gap = Math.atan2(Math.sin(gap), Math.cos(gap));
          const push = Math.min(0.12, ((need - d) / (S * ORBIT(i))) * 0.8);
          const ahead = gap >= 0 ? b : a;
          const behind = gap >= 0 ? a : b;
          this.offset[ahead] += push;
          this.offset[behind] -= push;
        }
  }

  /** Where a moon is (`S` = the system's size; `back` = that far behind on its orbit, for trails). */
  private moonPos(m: Moon, x: number, y: number, S: number, back = 0) {
    const i = MOONS.indexOf(m);
    const rad = S * ORBIT(i);
    const a = this.angle(m) - back;
    const dx = Math.cos(a) * rad;
    const dy = Math.sin(a) * rad * FLAT;
    return {
      x: x + dx * Math.cos(TILT) - dy * Math.sin(TILT),
      y: y + dx * Math.sin(TILT) + dy * Math.cos(TILT),
      front: Math.sin(a) > 0,
      depth: (Math.sin(a) + 1) / 2,
    };
  }

  private lookTarget(): { x: number; y: number } {
    // Saying something: he looks down at his bubble.
    if (this.saying || this.state === 'waiting') return { x: 0, y: 1 };
    if (this.state === 'asleep') return { x: 0, y: 0.4 };
    if (this.state === 'thinking') return { x: this.still ? 0 : Math.sin(this.t * 2.4) * 0.9, y: -0.2 };
    if (this.state === 'working' && !this.focus) {
      // Mulling: a slow, wandering glance up and around (two speeds that never line up), not the thinking scan.
      const t = this.t;
      return {
        x: (Math.sin(t * 0.83) * 0.65 + Math.sin(t * 0.31) * 0.25) * this.mull,
        y: (-0.25 + Math.sin(t * 0.57) * 0.3) * this.mull,
      };
    }
    if (!this.focus || !this.S) return { x: 0, y: 0 };
    const p = this.moonPos(this.focus, 0, 0, this.S);
    return {
      x: Math.max(-1, Math.min(1, p.x / (this.S * 0.6))),
      y: Math.max(-1, Math.min(1, p.y / (this.S * 0.35))),
    };
  }

  // ── Drawing (the canvas: face and moons only) ──

  private draw() {
    const { ctx, box } = this;
    if (!box.w) return;
    const hidden = this.ext < 0.004;
    if (hidden && this.blank) return;
    ctx.clearRect(box.x, box.y, box.w, box.h);
    this.blank = hidden;
    if (hidden) return;
    const { S, cx } = this;
    // A slow breath: the system floats a little inside the still hammock.
    const cy = this.cy + (this.still ? 0 : Math.sin(this.t * 1.3) * 1.5 * this.k());
    this.orbits(cx, cy, S);
    if (this.tier === 'full') this.trails(cx, cy, S);
    this.moons(cx, cy, S, false);
    this.face(cx, cy, S * FACE);
    this.moons(cx, cy, S, true);
    this.drawPulses(cx, cy, S);
    this.labels();
    if (this.state === 'asleep') this.zees(cx, cy, S * FACE);
  }

  private sprite(img: HTMLCanvasElement, x: number, y: number, r: number, alpha: number) {
    if (alpha <= 0.01) return;
    const ctx = this.ctx;
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * Math.min(1, alpha);
    ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = a;
  }

  private face(x: number, y: number, pr: number) {
    const ctx = this.ctx;
    const col = this.tint();
    if (this.shake > 0 && !this.still) x += Math.sin(this.t * 70) * this.shake * pr * 0.12;
    // Mulling, the glow breathes slowly.
    const breath = this.mull * (0.5 + 0.5 * Math.sin(this.t * 2.1)) * 0.25;
    this.sprite(glowSprite(col), x, y, pr * 2.3, 0.4 + this.flash * 0.6 + this.core * 0.5 + breath);
    this.sprite(faceSprite(pr * 2 * this.scale), x, y, pr, 1);
    ctx.beginPath();
    ctx.arc(x, y, pr, 0, 6.29);
    ctx.strokeStyle = rgba(col, 0.55 + this.flash * 0.45 + this.core * 0.3);
    ctx.lineWidth = Math.max(1, pr * 0.06);
    ctx.stroke();

    // The eyes: where they look and how open they are says what he's doing.
    let open = 1 - this.blink;
    const w = pr * 0.2;
    let h = pr * 0.42;
    if (this.state === 'thinking') h *= 0.45;
    h *= 1 - this.mull * 0.3;
    if (this.state === 'waiting') h *= 1.08;
    if (this.state === 'asleep') open = 0.08;
    const ex = this.look.x * pr * 0.36;
    const ey = this.look.y * pr * 0.24;
    const gap = pr * 0.27;
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const ecx = x + side * gap + ex;
      const ecy = y + ey - pr * 0.04;
      // Their glow: a sprite, not a blur filter (the GPU cost, 2026-11-12).
      if (this.tier === 'full') this.sprite(glowSprite(col), ecx, ecy, pr * 0.42, 0.55);
      if (this.state === 'desktop') {
        // Crosshair eyes: Harv has the mouse.
        ctx.lineWidth = Math.max(1, pr * 0.06);
        ctx.beginPath();
        ctx.arc(ecx, ecy, w * 0.75, 0, 6.29);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ecx, ecy, w * 0.18, 0, 6.29);
        ctx.fill();
      } else if (this.shake > 0.3) {
        // The flinch on an error.
        ctx.lineWidth = Math.max(1.2, pr * 0.07);
        const k = w * 0.7;
        ctx.beginPath();
        ctx.moveTo(ecx - k, ecy - k);
        ctx.lineTo(ecx + k, ecy + k);
        ctx.moveTo(ecx + k, ecy - k);
        ctx.lineTo(ecx - k, ecy + k);
        ctx.stroke();
      } else {
        const hh = Math.max(pr * 0.04, h * open);
        ctx.beginPath();
        ctx.roundRect(ecx - w / 2, ecy - hh / 2, w, hh, w / 2);
        ctx.fill();
      }
    }
    ctx.lineCap = 'butt';
  }

  /** Asleep at a plan limit: a slow "z" drifting up from his face. */
  private zees(x: number, y: number, pr: number) {
    const ctx = this.ctx;
    ctx.font = `600 ${Math.round(11 * this.k())}px "IBM Plex Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < 2; i++) {
      const k = this.still ? 0.4 + i * 0.3 : (this.t * 0.35 + i * 0.5) % 1;
      // In softly, out softly (it used to pop in at full strength).
      ctx.fillStyle = rgba(C.ink, Math.min(1, k * 6) * (1 - k) * 0.8);
      ctx.fillText('z', x + pr * (0.9 + k * 0.6), y - pr * (0.6 + k * 1.2));
    }
  }

  /** The moons are his tools: faint when he only came down to say something (docs/PLAN.md §6ad). */
  private moonDim() {
    return this.saying && this.state === 'idle' ? 0.35 : 1;
  }

  private orbits(x: number, y: number, S: number) {
    const ctx = this.ctx;
    // All six rings are one sprite; only the ring in use is drawn over it.
    const half = S * ORBIT(MOONS.length - 1) + 2;
    const line = Math.max(1, this.scale);
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * this.moonDim();
    ctx.drawImage(orbitSprite(half * 2 * this.scale, S * this.scale, line), x - half, y - half, half * 2, half * 2);
    ctx.globalAlpha = a0;
    if (!this.focus) return;
    const rad = S * ORBIT(MOONS.indexOf(this.focus));
    ctx.beginPath();
    ctx.ellipse(x, y, rad, rad * FLAT, TILT, 0, 6.29);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(C.ink, 0.14);
    ctx.stroke();
  }

  /** The full look only: a faint trail behind each moon along its orbit. */
  private trails(x: number, y: number, S: number) {
    const ctx = this.ctx;
    const col = this.tint();
    for (const m of MOONS) {
      const lit = this.glow[m];
      ctx.fillStyle = lit > 0.05 ? '#ffffff' : col;
      for (let k = 1; k <= 5; k++) {
        const p = this.moonPos(m, x, y, S, k * 0.09);
        ctx.globalAlpha = (0.16 + lit * 0.3) * (1 - k / 6) * (0.5 + p.depth * 0.5) * this.moonDim();
        ctx.beginPath();
        ctx.arc(p.x, p.y, (1.6 + lit) * this.k(), 0, 6.29);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Where a moon's label goes: below it, or above it where the hammock leaves no room below
   * (`tight`: neither fits, for fits()).
   */
  private labelSpot(m: Moon, x: number, y: number, size: number): { fs: number; below: boolean; tight: boolean } {
    const fs = Math.min(13, Math.round(10 * this.k()));
    // IBM Plex Mono: every letter is 0.6 of the font size wide.
    const halfW = m.length * fs * 0.3 + 1;
    const fitsAt = (top: number) =>
      this.inside(x - halfW, top, AIR) &&
      this.inside(x + halfW, top, AIR) &&
      this.inside(x - halfW, top + fs, AIR) &&
      this.inside(x + halfW, top + fs, AIR);
    const below = fitsAt(y + size + 3);
    return { fs, below, tight: !below && !fitsAt(y - size - 3 - fs) };
  }

  private moons(x: number, y: number, S: number, front: boolean) {
    const ctx = this.ctx;
    const col = this.tint();
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * this.moonDim();
    for (const m of MOONS) {
      const p = this.moonPos(m, x, y, S);
      if (p.front !== front) continue;
      const g = this.glow[m];
      const size = this.size(m, p.depth);
      this.sprite(glowSprite(col), p.x, p.y, size * 4, 0.7 * g);
      this.sprite(moonSprite(col, g > 0.05), p.x, p.y, size, 0.65 + p.depth * 0.35);
      if (g > 0.25 || this.focus === m) this.named.push({ m, x: p.x, y: p.y, size, alpha: Math.max(g, this.focus === m ? 0.8 : 0) });
      if (m === 'helpers') {
        ctx.fillStyle = rgba(C.ink, 0.85);
        for (let h = 0; h < Math.min(this.helpers, 5); h++) {
          const a = this.t * 3 + h * 2.1;
          ctx.beginPath();
          ctx.arc(p.x + Math.cos(a) * 10 * this.k(), p.y + Math.sin(a) * 5.5 * this.k(), 1.8 * this.k(), 0, 6.29);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = a0;
  }

  /** The names of the moons in use, over everything else, with a dark halo (the chat's text shows through the glass). */
  private labels() {
    const ctx = this.ctx;
    for (const { m, x, y, size, alpha } of this.named) {
      const { fs, below } = this.labelSpot(m, x, y, size);
      const ty = below ? y + size + 3 : y - size - 3;
      ctx.font = `${fs}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = below ? 'top' : 'bottom';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = rgba('#0d141c', alpha * 0.55);
      ctx.strokeText(m, x, ty);
      ctx.fillStyle = rgba(C.ink, alpha);
      ctx.fillText(m, x, ty);
    }
    this.named.length = 0;
  }

  private drawPulses(x: number, y: number, S: number) {
    const ctx = this.ctx;
    for (const p of this.pulses) {
      const end = this.moonPos(p.to, x, y, S);
      const e = 1 - Math.pow(1 - Math.min(1, p.k), 3);
      const px = x + (end.x - x) * e;
      const py = y + (end.y - y) * e - Math.sin(e * Math.PI) * 8 * this.k();
      this.sprite(glowSprite(this.tint()), px, py, 9 * this.k(), 0.8);
      ctx.beginPath();
      ctx.arc(px, py, 2.4 * this.k(), 0, 6.29);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
    }
  }
}
