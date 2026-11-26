import { spawn } from 'node:child_process';

/** Runs a program without a window; rejects with the last line it wrote to stderr (or its exit code). */
export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-600)));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').at(-1) || `${cmd} exited with ${code}`))));
  });
}
