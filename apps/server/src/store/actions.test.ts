import { describe, expect, it } from 'vitest';
import { ActionStore } from './actions.ts';

describe('ActionStore.byBackupDir', () => {
  it('finds the action a backup folder belongs to, with whether Restore still works', () => {
    const store = new ActionStore(':memory:');
    const base = { tabId: 't', at: 1, tool: 'Edit', tier: 'yellow' as const, reason: '', input: {} };
    store.add({ ...base, id: 'a1', summary: 'edit notes.md', status: 'running' });
    store.update('a1', { status: 'done', backupDir: '/b/one' });
    store.add({ ...base, id: 'a2', summary: 'delete old.txt', status: 'running' });
    store.update('a2', { status: 'undone', backupDir: '/b/two' });

    expect(store.byBackupDir('/b/one')).toMatchObject({ id: 'a1', summary: 'edit notes.md', canUndo: true });
    expect(store.byBackupDir('/b/two')).toMatchObject({ id: 'a2', canUndo: false });
    expect(store.byBackupDir('/b/none')).toBeNull();
    store.close();
  });
});

describe('ActionStore.forgetChat', () => {
  it('drops a deleted chat held items and blanks its inputs, keeping the summary and Undo (the full review, D18)', () => {
    const store = new ActionStore(':memory:');
    const base = { at: 1, tool: 'Bash', tier: 'red' as const, reason: '', status: 'running' as const };
    store.add({ ...base, id: 'a1', tabId: 'gone', summary: 'write secrets.txt', input: { command: 'echo hi > secrets.txt' } });
    store.update('a1', { status: 'done', backupDir: '/b/one', result: 'ok' });
    store.add({ ...base, id: 'a2', tabId: 'kept', summary: 'list files', input: { command: 'ls' } });
    store.setHeld('gone', [{ n: 1, key: 'k', summary: 's', at: 1 }]);
    store.setHeld('kept', [{ n: 1, key: 'k', summary: 's', at: 1 }]);

    store.forgetChat('gone');
    expect(store.allHeld().has('gone')).toBe(false);
    expect(store.allHeld().has('kept')).toBe(true);
    expect(store.byBackupDir('/b/one')).toMatchObject({ id: 'a1', summary: 'write secrets.txt', canUndo: true });
    expect(store.byBackupDir('/b/one')?.result).toBeUndefined();
    store.close();
  });
});
