// node scripts/chrome-oauth.ts [--repo owner/name ...]: creates the Chrome Web Store credentials of the
// Publish to stores workflow (docs/store-publishing.md, "Chrome credentials") and stores them as secrets of
// each repository's `store-chrome` environment: CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN.
//
// The owner runs it, never an agent. It reads the OAuth client's id and secret from CHROME_CLIENT_ID and
// CHROME_CLIENT_SECRET (for example through `pass-cli run`), else asks for them without echo. It opens Google's
// consent page, receives the code on a local port (loopback redirect, with PKCE and a state check), exchanges
// it for a refresh token, checks that the token can read each repository's Chrome item (its CHROME_PUBLISHER_ID
// and CHROME_EXTENSION_ID variables), and only then pipes the three values into `gh secret set`. No value is
// printed, written to a file or passed as an argument; errors show HTTP statuses only.
//
// Imports only Node built-ins, like the other release scripts.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHROME_API = 'https://chromewebstore.googleapis.com';
const DEFAULT_REPOSITORY = 'valentindimitrov/ntfy-desk';
const ENVIRONMENT = 'store-chrome';
/** How long the consent page may take */
const CONSENT_TIMEOUT = 5 * 60_000;

const base64url = (data: Buffer) => data.toString('base64url');

export type Pkce = { verifier: string; challenge: string };

export function createPkce(random: (size: number) => Buffer = randomBytes): Pkce {
  const verifier = base64url(random(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

/** Google's consent page: offline access and a fresh consent, so the answer carries a refresh token */
export function authorizationUrl(clientId: string, redirectUri: string, pkce: Pkce, state: string): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();
  return url.toString();
}

/** The code from the redirect to the local port, once the state matches */
export function codeFromCallback(requestUrl: string, state: string): string {
  const params = new URL(requestUrl, 'http://127.0.0.1').searchParams;
  const error = params.get('error');
  if (error) throw new Error(`Google refused the consent: ${error.replace(/[^\w.-]/g, '').slice(0, 60)}`);
  if (params.get('state') !== state) throw new Error('The answer from the consent page has the wrong state: nothing was stored');
  const code = params.get('code');
  if (!code) throw new Error('The answer from the consent page has no code');
  return code;
}

async function postForm(
  fetchImpl: typeof fetch,
  service: string,
  url: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      body: new URLSearchParams(form),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`${service}: no response (network error or time limit)`);
  }
  // The body may echo what was sent: only the status is shown
  if (!response.ok) throw new Error(`${service}: HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${service}: unexpected response`);
  }
  if (typeof body !== 'object' || body === null) throw new Error(`${service}: unexpected response`);
  return body as Record<string, unknown>;
}

export type Tokens = { accessToken: string; refreshToken: string };

export async function exchangeCode(
  fetchImpl: typeof fetch,
  client: { id: string; secret: string },
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Tokens> {
  const body = await postForm(fetchImpl, 'Google token exchange', TOKEN_URL, {
    client_id: client.id,
    client_secret: client.secret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const accessToken = body['access_token'];
  const refreshToken = body['refresh_token'];
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('Google token exchange: no access token');
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('Google token exchange: no refresh token (revoke the app at myaccount.google.com/permissions, then run this again)');
  }
  const scope = body['scope'];
  if (typeof scope === 'string' && !scope.split(' ').includes(SCOPE))
    throw new Error(`Google token exchange: the token lacks the scope ${SCOPE}`);
  return { accessToken, refreshToken };
}

/** Reads the item's status with the new token: proves the account owns the item and the API is enabled */
export async function checkItem(fetchImpl: typeof fetch, accessToken: string, publisher: string, item: string): Promise<void> {
  const url = `${CHROME_API}/v2/publishers/${encodeURIComponent(publisher)}/items/${encodeURIComponent(item)}:fetchStatus`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`Chrome Web Store item ${item}: no response (network error or time limit)`);
  }
  if (!response.ok) {
    const hint =
      response.status === 403
        ? ": is the Chrome Web Store API enabled in the client's project, and did you sign in with the account that owns the item?"
        : '';
    throw new Error(`Chrome Web Store item ${item}: HTTP ${response.status}${hint}`);
  }
}

export function parseRepositories(args: readonly string[]): string[] {
  const repositories: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== '--repo') throw new Error(`Unknown argument ${String(arg)}: use --repo owner/name (repeatable)`);
    const value = args[++index];
    if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error('--repo needs owner/name');
    repositories.push(value);
  }
  return repositories.length ? [...new Set(repositories)] : [DEFAULT_REPOSITORY];
}

function gh(args: string[], input?: string): string {
  const result = spawnSync('gh', args, { input, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${String(result.status)})`);
  return result.stdout.trim();
}

function variable(repository: string, name: string): string {
  const value = gh(['variable', 'get', name, '-R', repository]);
  if (!value) throw new Error(`${repository} has no ${name} variable`);
  return value;
}

/** Asks on the terminal; the answer to a hidden question isn't echoed */
async function ask(question: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Set CHROME_CLIENT_ID and CHROME_CLIENT_SECRET, or run this in a terminal');
  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(question);
  if (hidden) Object.assign(prompt, { _writeToOutput: () => undefined });
  const answer = await new Promise<string>((resolve) => prompt.question('', resolve));
  prompt.close();
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

async function readClient(): Promise<{ id: string; secret: string }> {
  const id = process.env['CHROME_CLIENT_ID']?.trim() || (await ask('OAuth client ID: ', false));
  const secret = process.env['CHROME_CLIENT_SECRET']?.trim() || (await ask('OAuth client secret (not shown): ', true));
  delete process.env['CHROME_CLIENT_ID'];
  delete process.env['CHROME_CLIENT_SECRET'];
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error('The client ID should end in .apps.googleusercontent.com');
  if (!secret) throw new Error('No client secret');
  return { id, secret };
}

function openInBrowser(url: string): void {
  // Vivaldi on the Mac; the system's default browser elsewhere
  const [command, args] = process.platform === 'darwin' ? ['open', ['-a', 'Vivaldi', url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
}

/** Waits on a local port for the consent page's redirect */
async function receiveCode(state: string, open: (redirectUri: string) => void): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    const timer = setTimeout(() => finish(new Error('No answer from the consent page within 5 minutes')), CONSENT_TIMEOUT);
    const server = createServer((request, response) => {
      if (!request.url?.startsWith('/?')) {
        response.writeHead(404).end();
        return;
      }
      try {
        const code = codeFromCallback(request.url, state);
        response
          .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Done: you can close this tab and go back to the terminal.');
        finish(undefined, code);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('That did not work: see the terminal.');
        finish(error instanceof Error ? error : new Error('The consent page failed'));
      }
    });
    const finish = (error?: Error, code?: string) => {
      clearTimeout(timer);
      server.close();
      if (error || !code) reject(error ?? new Error('No code'));
      else resolve({ code, redirectUri });
    };
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return finish(new Error('Could not open a local port'));
      redirectUri = `http://127.0.0.1:${address.port}`;
      open(redirectUri);
    });
  });
}

async function main(args: string[]): Promise<void> {
  const repositories = parseRepositories(args);
  const items = repositories.map((repository) => ({
    repository,
    publisher: variable(repository, 'CHROME_PUBLISHER_ID'),
    item: variable(repository, 'CHROME_EXTENSION_ID'),
  }));
  const client = await readClient();

  const pkce = createPkce();
  const state = base64url(randomBytes(16));
  const { code, redirectUri } = await receiveCode(state, (redirect) => {
    const url = authorizationUrl(client.id, redirect, pkce, state);
    console.log('Sign in with the Google account that owns the Chrome Web Store items. If no browser opened, open:');
    console.log(url);
    openInBrowser(url);
  });
  const tokens = await exchangeCode(fetch, client, code, pkce.verifier, redirectUri);

  for (const { repository, publisher, item } of items) {
    await checkItem(fetch, tokens.accessToken, publisher, item);
    console.log(`The token reads ${repository}'s Chrome item.`);
  }
  const values: [string, string][] = [
    ['CHROME_CLIENT_ID', client.id],
    ['CHROME_CLIENT_SECRET', client.secret],
    ['CHROME_REFRESH_TOKEN', tokens.refreshToken],
  ];
  for (const { repository } of items) {
    for (const [name, value] of values) gh(['secret', 'set', name, '--env', ENVIRONMENT, '-R', repository], value);
    console.log(`Stored ${values.map(([name]) => name).join(', ')} in ${repository}'s ${ENVIRONMENT} environment.`);
  }
  console.log(`Check: gh secret list -e ${ENVIRONMENT} -R ${repositories[0] ?? DEFAULT_REPOSITORY}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed');
    process.exitCode = 1;
  });
}
