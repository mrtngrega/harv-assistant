// Claude Code's status line for the Harv dev sessions (.claude/settings.json; pass C, C14):
// model · context used · session % · weekly %, amber at 75 % and red-amber at 90 % (the dev rule: tell the user then).
// The meters come from Claude Code's own input when it sends rate limits, else from the running Harv
// (like scripts/ui-check/usage.mjs; no tokens), cached a minute so the line stays fast.
// Only in this repo's project settings: user settings would load into every Harv chat too.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CACHE = join(tmpdir(), 'harv-statusline-usage.json');
const LAST_INPUT = join(tmpdir(), 'harv-statusline-input.json');
const AMBER = '\x1b[38;2;242;184;128m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const read = async () => {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

/** Claude Code's own rate limits, if this version sends them: [{ label, percent }]. */
function fromInput(input) {
  const limits = input.rate_limits ?? input.rateLimits;
  if (!limits || typeof limits !== 'object') return null;
  // A percentage, or a 0–1 fraction (`utilization`).
  const pct = (v) => {
    const n = v?.used_percentage ?? v?.percent ?? v?.used_percent;
    if (typeof n === 'number') return Math.round(n);
    return typeof v?.utilization === 'number' ? Math.round(v.utilization * 100) : null;
  };
  const out = [];
  const session = limits.five_hour ?? limits.session ?? limits.fiveHour;
  const weekly = limits.seven_day ?? limits.weekly ?? limits.sevenDay;
  if (pct(session) !== null) out.push({ label: 'session', percent: pct(session) });
  if (pct(weekly) !== null) out.push({ label: 'week', percent: pct(weekly) });
  return out.length ? out : null;
}

/** How full this session's context is, from Claude Code's own input: "context 18% · 176k/1M", or null. */
function contextText(input) {
  const c = input.context_window;
  if (!c || typeof c !== 'object') return null;
  const size = c.context_window_size ?? c.size ?? c.max_tokens;
  const u = c.current_usage;
  const used =
    u && typeof u === 'object'
      ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
      : (c.used_tokens ?? c.total_input_tokens);
  let pct = c.used_percentage ?? c.used_percent;
  if (typeof pct !== 'number' && typeof used === 'number' && size) pct = (used / size) * 100;
  if (typeof pct !== 'number') return null;
  const k = (n) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
  const text = `context ${Math.round(pct)}%${typeof used === 'number' && size ? ` · ${k(used)}/${k(size)}` : ''}`;
  return pct >= 75 ? `${AMBER}${text}${RESET}` : text;
}

/** The meters Harv knows, cached a minute. */
async function fromHarv() {
  try {
    const cached = JSON.parse(readFileSync(CACHE, 'utf8'));
    if (Date.now() - cached.at < 60_000) return cached.meters;
  } catch {
    // No cache yet.
  }
  const meters = await new Promise((resolve) => {
    let WebSocket;
    try {
      WebSocket = createRequire(import.meta.url)('ws');
    } catch {
      return resolve(null);
    }
    const ws = new WebSocket('ws://127.0.0.1:4317/ws', { headers: { Origin: 'http://127.0.0.1:4316' } });
    const done = (v) => {
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        // Already closed.
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 1500);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type !== 'hello') return;
      const list = (m.usage?.meters ?? [])
        .filter((x) => /session|all models/i.test(x.label))
        .map((x) => ({ label: /session/i.test(x.label) ? 'session' : 'week', percent: Math.round(x.percent) }));
      done(list.length ? list : null);
    });
    ws.on('error', () => done(null));
  });
  if (meters) writeFileSync(CACHE, JSON.stringify({ at: Date.now(), meters }));
  return meters;
}

const input = await read();
try {
  writeFileSync(LAST_INPUT, JSON.stringify({ keys: Object.keys(input), context_window: input.context_window ?? null }));
} catch {
  // Only a note for finding out what Claude Code sends.
}
const meters = fromInput(input) ?? (await fromHarv());
const model = input.model?.display_name ?? '';
const shown = (meters ?? []).map(({ label, percent }) => {
  const text = `${label} ${percent}%`;
  if (percent >= 90) return `${BOLD}${AMBER}${text} · stop soon${RESET}`;
  if (percent >= 75) return `${AMBER}${text}${RESET}`;
  return text;
});
const parts = [
  model && `${DIM}${model}${RESET}`,
  contextText(input),
  ...(shown.length ? shown : [`${DIM}plan usage: Harv not reachable${RESET}`]),
];
process.stdout.write(parts.filter(Boolean).join(' · '));
