// Harv runs only on the user's Claude subscription. If an API key, an auth token or another
// provider's switch were present, Claude Code / the Agent SDK would use it and bill per token,
// so strip the whole family from this process before anything else can read it.

/**
 * Every environment name that moves Claude Code off the subscription (a key, a token, another
 * endpoint or cloud provider). One list: the startup strip, each query's env and the gate use it
 * (the full review, S8).
 */
export const BILLED_ENV_NAMES = String.raw`ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|BEDROCK_\w+|VERTEX_\w+|FOUNDRY_\w+)|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|AWS_BEARER_TOKEN_BEDROCK`;
export const BILLED_ENV = new RegExp(`^(?:${BILLED_ENV_NAMES})$`, 'i');

/** Removes every billed name from `env` (in place); returns the names removed. */
export function stripBilledCredentials(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (BILLED_ENV.test(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
