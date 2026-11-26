import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SCOPE,
  authorizationUrl,
  checkItem,
  codeFromCallback,
  createPkce,
  exchangeCode,
  parseRepositories,
} from '../../scripts/chrome-oauth.ts';

const client = { id: '123-abc.apps.googleusercontent.com', secret: 'client-secret-value' };
const REDIRECT = 'http://127.0.0.1:43210';

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
}

describe('Chrome OAuth helper', () => {
  it('makes a PKCE pair whose challenge is the SHA-256 of the verifier', () => {
    const pkce = createPkce(() => Buffer.alloc(32, 7));
    expect(pkce.verifier).toMatch(/^[\w-]{43}$/);
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
  });

  it('asks for offline access to the Chrome Web Store scope with a fresh consent', () => {
    const url = new URL(authorizationUrl(client.id, REDIRECT, { verifier: 'v', challenge: 'c' }, 'state-1'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      state: 'state-1',
    });
    // The client secret never goes to the browser
    expect(url.toString()).not.toContain(client.secret);
  });

  it('takes the code only from an answer with the right state', () => {
    expect(codeFromCallback('/?state=s1&code=4%2Fabc', 's1')).toBe('4/abc');
    expect(() => codeFromCallback('/?state=other&code=x', 's1')).toThrow('wrong state');
    expect(() => codeFromCallback('/?state=s1', 's1')).toThrow('no code');
    expect(() => codeFromCallback('/?error=access_denied%3Cb%3E&state=s1', 's1')).toThrow(/^Google refused the consent: access_deniedb$/);
  });

  it('exchanges the code with the verifier and returns both tokens', async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(200, { access_token: 'access', refresh_token: 'refresh', scope: SCOPE }, calls);
    await expect(exchangeCode(fetchImpl, client, 'code-1', 'verifier-1', REDIRECT)).resolves.toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    expect(calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(Object.fromEntries(calls[0]?.init.body as URLSearchParams)).toEqual({
      client_id: client.id,
      client_secret: client.secret,
      code: 'code-1',
      code_verifier: 'verifier-1',
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
    });
  });

  it('refuses an answer without a refresh token or the scope, and shows only the status of a failure', async () => {
    await expect(exchangeCode(fakeFetch(200, { access_token: 'a' }), client, 'c', 'v', REDIRECT)).rejects.toThrow('no refresh token');
    await expect(
      exchangeCode(fakeFetch(200, { access_token: 'a', refresh_token: 'r', scope: 'openid' }), client, 'c', 'v', REDIRECT),
    ).rejects.toThrow('lacks the scope');
    const failure = exchangeCode(fakeFetch(400, { error: 'invalid_client', echo: client.secret }), client, 'c', 'v', REDIRECT);
    await expect(failure).rejects.toThrow(/^Google token exchange: HTTP 400$/);
  });

  it("checks the item's status with the new token", async () => {
    const calls: Call[] = [];
    await expect(checkItem(fakeFetch(200, {}, calls), 'access', 'pub-1', 'item-1')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/item-1:fetchStatus');
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer access');
    await expect(checkItem(fakeFetch(403, {}), 'access', 'pub-1', 'item-1')).rejects.toThrow(
      /item item-1: HTTP 403: is the Chrome Web Store API enabled/,
    );
  });

  it('reads the repositories, ntfy Desk by default', () => {
    expect(parseRepositories([])).toEqual(['valentindimitrov/ntfy-desk']);
    expect(parseRepositories(['--repo', 'a/b', '--repo', 'c/d', '--repo', 'a/b'])).toEqual(['a/b', 'c/d']);
    expect(() => parseRepositories(['--repo'])).toThrow('--repo needs owner/name');
    expect(() => parseRepositories(['a/b'])).toThrow('Unknown argument');
  });
});
