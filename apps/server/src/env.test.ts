import { describe, expect, it } from 'vitest';
import { stripBilledCredentials } from './env.ts';

describe('stripBilledCredentials', () => {
  it('removes API credentials so Claude can only use the subscription login', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      PATH: '/bin',
    };
    expect(stripBilledCredentials(env)).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(env).toEqual({ PATH: '/bin' });
  });

  it('removes every name that moves Claude Code off the subscription (S8), keeps the rest', () => {
    const billed = [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_BEARER_TOKEN_BEDROCK',
    ];
    const env: NodeJS.ProcessEnv = { ANTHROPIC_MODEL: 'x', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', PATH: '/bin' };
    for (const name of billed) env[name] = '1';
    expect(stripBilledCredentials(env).sort()).toEqual([...billed].sort());
    expect(env).toEqual({ ANTHROPIC_MODEL: 'x', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', PATH: '/bin' });
  });

  it('reports nothing when no credentials are set', () => {
    expect(stripBilledCredentials({ PATH: '/bin' })).toEqual([]);
  });
});
