// The running Harv's health in one line (no tokens): version, status, and whether the dashboard answers.
//   node scripts/ui-check/smoke-health.mjs
const headers = { Origin: 'http://127.0.0.1:4316' };
try {
  const h = await (await fetch('http://127.0.0.1:4317/api/health', { headers, signal: AbortSignal.timeout(5000) })).json();
  const web = await fetch('http://127.0.0.1:4316/', { signal: AbortSignal.timeout(5000) }).then(
    (r) => r.status,
    () => 'down',
  );
  console.log(`server ${h.ok ? 'up' : 'NOT OK'} (version ${h.version}, ${h.status}), dashboard ${web}`);
  process.exit(h.ok && web === 200 ? 0 : 1);
} catch (err) {
  console.log(`server down: ${err.cause?.code ?? err.message}`);
  process.exit(1);
}
