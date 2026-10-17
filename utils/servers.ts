// Main and fallback server (e.g. the LAN address first, the public one when it doesn't answer).
// Both are the same ntfy server, so message ids, sync cursors and the token are shared.

import { isNoResponse, type NtfyConfig, type NtfyServer } from './ntfy';

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
export async function pickServer(config: Pick<NtfyConfig, 'apiUrl' | 'accessToken' | 'fallbackUrl'>): Promise<ChosenServer> {
  const main = { apiUrl: config.apiUrl, accessToken: config.accessToken, isFallback: false };
  if (!config.fallbackUrl || (await isServerUp(config.apiUrl))) {
    return main;
  }
  if (await isServerUp(config.fallbackUrl)) {
    return { apiUrl: config.fallbackUrl, accessToken: config.accessToken, isFallback: true };
  }
  return main;
}

/**
 * Run a request on the main server; if it gets no response (unreachable, or no answer within the time
 * limit), run it again on the fallback. HTTP errors aren't retried: the server answered. After a time
 * limit the main server may still have taken the message, so it can arrive twice: better than not at all.
 */
export async function withFallback<T>(
  config: Pick<NtfyConfig, 'apiUrl' | 'accessToken' | 'fallbackUrl'>,
  request: (server: NtfyServer) => Promise<T>,
): Promise<T> {
  try {
    return await request({ apiUrl: config.apiUrl, accessToken: config.accessToken });
  } catch (error) {
    if (isNoResponse(error) && config.fallbackUrl) {
      return request({ apiUrl: config.fallbackUrl, accessToken: config.accessToken });
    }
    throw error;
  }
}
