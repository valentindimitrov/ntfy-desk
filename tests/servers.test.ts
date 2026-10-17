import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendNotification } from '@/utils/ntfy';
import { createReceiver } from '@/utils/receiver';
import { isServerUp, pickServer, withFallback } from '@/utils/servers';
import { getReceiverStatus } from '@/utils/status';
import { FakeStream, installFakeNtfy, sleep, type FakeServer } from './helpers/fake-ntfy';

let server: FakeServer;
const main = 'https://ntfy.lan';
const fallback = 'https://ntfy.example.com';
const config = { apiUrl: main, fallbackUrl: fallback, accessToken: 'tk_x' };

beforeEach(async () => {
  fakeBrowser.reset();
  server = installFakeNtfy();
  await fakeBrowser.storage.sync.set({ apiUrl: main, fallbackUrl: fallback, topics: 'alerts' });
  await fakeBrowser.storage.local.set({ accessToken: 'tk_x' });
});

describe('picking a server', () => {
  it('uses the main server while it answers', async () => {
    expect(await isServerUp(main)).toBe(true);
    expect(await pickServer(config)).toMatchObject({ apiUrl: main, isFallback: false });
  });

  it('uses the fallback when the main server is down, and the main one when both are', async () => {
    server.downHosts = ['ntfy.lan'];
    expect(await pickServer(config)).toMatchObject({ apiUrl: fallback, isFallback: true });
    server.downHosts = ['ntfy.lan', 'ntfy.example.com'];
    expect(await pickServer(config)).toMatchObject({ apiUrl: main, isFallback: false });
  });

  it('sends Basic authentication from the stored credentials to the fallback too', async () => {
    server.downHosts = ['ntfy.lan'];
    const credentials = { username: 'alice', password: 'secret' };
    await withFallback({ ...config, accessToken: '', credentials }, (s) => sendNotification(s, 'inbox', { message: 'x' }));
    const basic = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
    expect(server.requests.map((r) => [r.url, r.auth])).toEqual([
      ['https://ntfy.lan/inbox', basic],
      ['https://ntfy.example.com/inbox', basic],
    ]);
  });

  it('skips the health check without a fallback', async () => {
    await pickServer({ ...config, fallbackUrl: '' });
    expect(server.requests).toEqual([]);
  });
});

describe('sending', () => {
  it('retries on the fallback when the main server gives no response', async () => {
    server.downHosts = ['ntfy.lan'];
    await withFallback(config, (s) => sendNotification(s, 'inbox', { message: 'x' }));
    expect(server.requests.map((r) => r.url)).toEqual(['https://ntfy.lan/inbox', 'https://ntfy.example.com/inbox']);
  });

  it("doesn't retry an HTTP error: the server answered", async () => {
    server.pollStatus = 200;
    const failing = async () => {
      throw new Error('HTTP 403: Forbidden');
    };
    let calls = 0;
    await expect(withFallback(config, () => (calls++, failing()))).rejects.toThrow('HTTP 403');
    expect(calls).toBe(1);
  });
});

describe('receiving', () => {
  it('connects to the fallback while the main server is down, and back to the main one when it returns', async () => {
    server.downHosts = ['ntfy.lan'];
    const receiver = createReceiver({ onNewMessage: () => {} });
    await receiver.connect();
    expect(new URL(FakeStream.instances.at(-1)!.url).host).toBe('ntfy.example.com');
    FakeStream.instances.at(-1)!.accept();
    await sleep(5);
    expect(await getReceiverStatus()).toMatchObject({ state: 'connected', server: 'ntfy.example.com', usingFallback: true });

    // Polls go to the server in use
    await receiver.sync();
    const polls = server.requests.filter((r) => r.url.includes('/json'));
    expect(polls.every((r) => r.url.startsWith(fallback))).toBe(true);

    server.downHosts = [];
    await receiver.connect(); // the alarm calls this every minute
    expect(new URL(FakeStream.instances.at(-1)!.url).host).toBe('ntfy.lan');
    receiver.close();
  });
});
