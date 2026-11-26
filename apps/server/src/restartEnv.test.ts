import { describe, expect, it } from 'vitest';
import { restartEnv } from './restartEnv.ts';

describe('the restart script’s environment', () => {
  it('drops npm’s PATH folders and npm_* variables, keeping each folder once (Windows)', () => {
    const layer =
      'C:\\Harv\\node_modules\\.bin;C:\\node_modules\\.bin;C:\\Program Files\\nodejs\\node_modules\\npm\\node_modules\\@npmcli\\run-script\\lib\\node-gyp-bin';
    const env = {
      Path: `${layer};${layer};C:\\Windows\\system32;C:\\Program Files\\nodejs;c:\\windows\\System32\\;C:\\Tools`,
      npm_lifecycle_event: 'harv',
      npm_config_user_agent: 'npm/11',
      INIT_CWD: 'C:\\Harv',
      HARV_HOME: 'C:\\Users\\me\\.harv',
    };
    const out = restartEnv(env, ';');
    expect(out.Path).toBe('C:\\Windows\\system32;C:\\Program Files\\nodejs;C:\\Tools');
    expect(out).toEqual({ Path: out.Path, HARV_HOME: 'C:\\Users\\me\\.harv' });
  });

  it('does the same with Linux paths, case kept', () => {
    const out = restartEnv({ PATH: '/home/me/Harv/node_modules/.bin:/usr/bin:/usr/bin:/Usr/bin:/home/me/.local/bin' }, ':');
    expect(out.PATH).toBe('/usr/bin:/Usr/bin:/home/me/.local/bin');
  });

  it('stays the same length however many restarts it goes through', () => {
    let env: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\Program Files\\nodejs' };
    for (let i = 0; i < 30; i++)
      env = restartEnv({ ...env, Path: `C:\\Harv\\node_modules\\.bin;C:\\Harv\\apps\\server\\node_modules\\.bin;${env.Path}` }, ';');
    expect(env.Path).toBe('C:\\Windows;C:\\Program Files\\nodejs');
  });
});
