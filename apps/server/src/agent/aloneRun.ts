import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel } from '@harv/shared';
import { buildOptions, SUBSCRIPTION_KEY_SOURCES, type ChatContext } from './options.ts';

const TIMEOUT_MS = 10 * 60_000;

/**
 * One task run on its own, with no chat (a background job): a fresh,
 * unsaved session with Harv's prompt and tools behind the same safety gate, so a small context
 * every time. Returns its last words, or why there are none.
 */
export async function runAlone(
  prompt: string,
  model: string,
  effort: EffortLevel,
  chat: ChatContext,
): Promise<{ text: string } | { error: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const q = query({
    prompt,
    options: { ...buildOptions(model, effort, abort, { chat }), persistSession: false, maxTurns: 40, includePartialMessages: false },
  });
  let said = '';
  try {
    for await (const msg of q) {
      // Same hard stop as chat sessions: never run on anything but the subscription.
      if (msg.type === 'system' && msg.subtype === 'init' && !SUBSCRIPTION_KEY_SOURCES.has(msg.apiKeySource)) {
        return { error: `Claude Code isn't using your subscription (${msg.apiKeySource})` };
      }
      if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
        const text = msg.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
        if (text.trim()) said = text.trim();
      }
      if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error && msg.result.trim()) return { text: msg.result.trim() };
        if (said) return { text: said };
        const why = msg.subtype === 'success' ? msg.result : [msg.subtype, ...msg.errors].join(': ');
        return { error: why.trim() || msg.subtype };
      }
    }
    return said ? { text: said } : { error: 'the run ended without an answer' };
  } catch (err) {
    if (said) return { text: said };
    return { error: abort.signal.aborted ? 'it took longer than 10 minutes' : (err as Error).message.split('\n')[0]! };
  } finally {
    clearTimeout(timer);
    q.close();
  }
}
