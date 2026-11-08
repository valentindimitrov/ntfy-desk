// Main and fallback server (e.g. the LAN address first, the public one when it doesn't answer).
// Both are the same ntfy server, so message ids, sync state and the token are shared.

import type { NtfyConfig, NtfyServer } from './ntfy';

const HEALTH_TIMEOUT = 4000;

/** ntfy's GET /v1/health answers {"healthy":true}; it sends CORS headers, so no host permission is needed */
export async function isServerUp(apiUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${new URL(apiUrl).origin}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
    if (!response.ok) return false;
    const body = (await response.json()) as { healthy?: boolean };
    return body.healthy !== false;
  } catch {
    return false;
  }
}

export interface ChosenServer extends NtfyServer {
  isFallback: boolean;
}

/** The main server if it is up or there's no fallback; else the fallback if that is up; else the main one */
export async function pickServer(
  config: Pick<NtfyConfig, 'apiUrl' | 'accessToken' | 'fallbackUrl'> & Partial<Pick<NtfyConfig, 'credentials'>>,
): Promise<ChosenServer> {
  const auth = { accessToken: config.accessToken, credentials: config.credentials ?? null };
  const main = { apiUrl: config.apiUrl, ...auth, isFallback: false };
  if (!config.fallbackUrl || (await isServerUp(config.apiUrl))) {
    return main;
  }
  if (await isServerUp(config.fallbackUrl)) {
    return { apiUrl: config.fallbackUrl, ...auth, isFallback: true };
  }
  return main;
}
