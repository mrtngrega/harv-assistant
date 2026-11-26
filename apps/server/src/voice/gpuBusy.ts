// "Never beside a game or Resolve" (voice plan rule 3; the full review, K2: the hook existed, nothing
// set it). The graphics card counts as busy while DaVinci Resolve runs, or while something else has
// kept it working hard for several seconds (a game, a render). Whisper's own clips last a second or
// two, so they never make it look busy. Fed by the metrics collector; read when a clip starts.

/** GPU load (%) that counts as hard work. */
const BUSY_LOAD = 60;
/** That many ticks in a row (~1 s each). */
const BUSY_TICKS = 5;
const RESOLVE = /^resolve(\.exe)?$/i;

export class GpuBusy {
  private loads: number[] = [];
  private resolve = false;

  /** A metrics tick's GPU load (undefined: no GPU reading). */
  tick(load: number | undefined): void {
    this.loads.push(load ?? 0);
    if (this.loads.length > BUSY_TICKS) this.loads.shift();
  }

  /** The process list (every few seconds). */
  processes(list: { name: string }[]): void {
    this.resolve = list.some((p) => RESOLVE.test(p.name));
  }

  busy(): boolean {
    return this.resolve || (this.loads.length === BUSY_TICKS && this.loads.every((l) => l >= BUSY_LOAD));
  }
}
