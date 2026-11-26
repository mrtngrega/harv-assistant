// One run of every check that uses no plan usage, with one report (for the review, and before
// handing work over). Each step runs on its own with a time limit; a step is "problem" when it
// fails or its output shows a known bad sign, "skipped" when what it needs isn't there.
//   node scripts/ui-check/smoke.mjs [--app] [--rust] [--quick]
//     --app       also the checks in the running app (start it with
//                 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9444)
//     --rust      also cargo fmt --check and clippy for the app
//     --quick     skip the test suite, typecheck and lint (only the live checks)
// Report: scripts/ui-check/out/smoke-<date>.md (gitignored); the summary prints at the end.
// Exit code 1 when any step is a problem. Never sends a chat message.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'scripts', 'ui-check', 'out');
const args = new Set(process.argv.slice(2));

/** Runs a program; resolves with its exit code and output, killed after `limit` seconds. */
function run(cmd, argv, limit, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // A shell command goes as one string (Node warns about argv with shell: true).
    const child = spawn(opts.shell ? [cmd, ...argv].join(' ') : cmd, opts.shell ? [] : argv, {
      cwd: opts.cwd ?? ROOT,
      shell: opts.shell ?? false,
      windowsHide: true,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      out += `\n[smoke: stopped after ${limit} s]`;
      child.kill();
    }, limit * 1000);
    child.on('error', (err) => (out += `\n[smoke: ${err.message}]`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, secs: (Date.now() - started) / 1000 });
    });
  });
}

const node = (script, ...rest) => ['node', [join('scripts', 'ui-check', script), ...rest]];
const npm = (...rest) => ['npm', rest, { shell: true }];

// Signs of trouble in a check's output (each check prints rather than failing).
const BAD = /Console errors|EXCEPTION|Uncaught|\bFAIL\b|✗|NEEDS THE KEY|^error:/im;

const steps = [];
const step = (group, name, [cmd, argv, opts], limit, check = {}) => steps.push({ group, name, cmd, argv, opts, limit, ...check });

if (!args.has('--quick')) {
  step('code', 'typecheck', npm('run', 'typecheck'), 300);
  step('code', 'lint', npm('run', 'lint'), 300);
  step('code', 'tests', npm('test'), 600, { summary: /Tests\s+.*$/m });
}
if (args.has('--rust')) {
  const tauri = { shell: true, cwd: join(ROOT, 'apps', 'desktop', 'src-tauri') };
  step('code', 'cargo fmt --check', ['cargo', ['fmt', '--check'], tauri], 120);
  step('code', 'cargo clippy', ['cargo', ['clippy', '--', '-D', 'warnings'], tauri], 900);
}

step('server', 'health', node('smoke-health.mjs'), 20, { summary: /^.*$/m });
step('server', 'busy', node('busy.mjs'), 20, { ok: [0, 2], summary: /^Harv:.*$/m });
step('server', 'usage', node('usage.mjs'), 20, { summary: /^Session:.*$/m });

step('dashboard', 'widths 420–1500', node('shots.mjs'), 120);
step('dashboard', 'status line', node('status-line.mjs'), 60);
step('dashboard', 'approval card', node('approval-card.mjs'), 60);
step('dashboard', 'watchdog notice', node('watchdog-toast.mjs'), 60);
step('dashboard', 'presence states', node('presence.mjs'), 120, {
  bad: /"misses":[1-9]|at rest: [1-9]|after it went up: [1-9]|Console errors|EXCEPTION/,
});
step('dashboard', 'stats panel shifts (8 s)', node('watch-shifts.mjs', '1280', '8'), 60, {
  bad: /vertical shift:|Console errors|EXCEPTION/,
});

if (args.has('--app')) {
  step('app', 'look', node('app-look.mjs', '9444', 'smoke'), 60);
  step('app', 'tabs', node('app-tabs.mjs', '9444'), 60);
  step('app', 'notices', node('notices.mjs', '9444'), 120);
  step('app', 'centering', node('centering.mjs', '9444'), 120);
  step('app', 'talk (sends nothing)', node('talk.mjs'), 60);
}
const head = (await run('git', ['rev-parse', '--short', 'HEAD'], 10)).out.trim();
const results = [];
for (const s of steps) {
  process.stdout.write(`${s.group} › ${s.name} … `);
  const r = await run(s.cmd, s.argv, s.limit, s.opts);
  let state = (s.ok ?? [0]).includes(r.code) ? 'ok' : 'problem';
  let note = '';
  if (state === 'ok' && (s.bad ?? BAD).test(r.out)) {
    state = 'problem';
    note = 'bad sign in the output';
  }
  if (/ECONNREFUSED|connect ECONN|Could not resolve hostname|Connection timed out|No inspectable targets|no app on/i.test(r.out)) {
    state = 'skipped';
    note = 'not reachable';
  }
  const line = s.summary?.exec(r.out)?.[0]?.trim();
  if (line && !note) note = line;
  if (!note && state === 'problem') note = `exit ${r.code}`;
  results.push({ ...s, ...r, state, note });
  console.log(`${state} (${r.secs.toFixed(1)} s)${note ? ` ${note}` : ''}`);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const mark = { ok: '✓', problem: '✗ problem', skipped: '– skipped' };
const md = [
  `# Smoke run ${new Date().toLocaleString('en-GB')} (commit ${head})`,
  '',
  `Flags: ${[...args].join(' ') || 'none'}. Uses no plan usage.`,
  '',
  '| Group | Step | Result | Time | Note |',
  '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.group} | ${r.name} | ${mark[r.state]} | ${r.secs.toFixed(1)} s | ${r.note.replace(/\|/g, '/')} |`),
  '',
  ...results
    .filter((r) => r.state !== 'ok')
    .flatMap((r) => [`## ${r.group} › ${r.name}`, '', '```', r.out.trim().split('\n').slice(-40).join('\n'), '```', '']),
].join('\n');
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `smoke-${stamp}.md`);
writeFileSync(file, md);
const count = (s) => results.filter((r) => r.state === s).length;
console.log(`\n${count('ok')} ok, ${count('problem')} problems, ${count('skipped')} skipped. Report: ${file}`);
process.exit(count('problem') ? 1 : 0);
