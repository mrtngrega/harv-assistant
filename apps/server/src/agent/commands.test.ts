import { describe, expect, it } from 'vitest';
import { asksForSkill, toCommandInfo } from './commands.ts';

describe('toCommandInfo', () => {
  it('leaves out commands Claude Code lists as removed', () => {
    const names = toCommandInfo([
      { name: 'agents', description: '(removed) Ask Claude to create/manage subagents', argumentHint: '' },
      { name: 'compact', description: 'Clear history but keep a summary', argumentHint: '' },
    ]).map((c) => c.name);
    expect(names).toContain('compact');
    expect(names).toContain('btw');
    expect(names).not.toContain('agents');
  });
});

describe('asksForSkill', () => {
  const known = (n: string) => ['compact', 'docx'].includes(n);
  const override = (w: string) => ['opus', 'haiku', 'high'].includes(w);
  const installed = (n: string) => ['code-review', 'docx', 'impeccable'].includes(n);
  it('spots a skill the chat does not list, asked for by name', () => {
    expect(asksForSkill('/simplify the last change', known, override)).toBe(true);
    expect(asksForSkill('/frontend-design make a landing page', known, override)).toBe(true);
    expect(asksForSkill('use the code-review skill on this', known, override, installed)).toBe(true);
    expect(asksForSkill('Run my impeccable skill over the Settings page', known, override, installed)).toBe(true);
  });
  // The full review, K28: the bare words loaded every skill.
  it('leaves talk about skills and plugins alone, and names that are not installed or already listed', () => {
    for (const text of [
      'what plugins do I have?',
      'Is there a skill for editing PDFs?',
      'My English skills are rusty',
      'Which plugin do I need in OBS for this?',
      'pozri tento skill z reelu',
      'use the pdf-wizard skill', // not installed
      'use the docx skill', // the chat has it already
    ])
      expect(asksForSkill(text, known, override, installed), text).toBe(false);
  });
  it('leaves known commands, Harv’s own words, model overrides and plain messages alone', () => {
    expect(asksForSkill('/docx a letter', known, override)).toBe(false);
    expect(asksForSkill('/compact', known, override)).toBe(false);
    expect(asksForSkill('/btw what time is it', known, override)).toBe(false);
    expect(asksForSkill('/opus explain this', known, override)).toBe(false);
    expect(asksForSkill('/c/Users/me/file.txt', known, override)).toBe(false);
    expect(asksForSkill('how good is my GPU?', known, override)).toBe(false);
    expect(asksForSkill('read ~/.claude/plugins/x/README.md and tell me its heading', known, override)).toBe(false);
    expect(asksForSkill('open SKILL.md in the docx folder', known, override)).toBe(false);
  });
});
