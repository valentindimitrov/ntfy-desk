// A fake ntfy server (fetch, including the JSON stream of subscriptions) for the receiving tests. since= follows ntfy v2.29:
// a unix time or duration selects by message time; a message id selects by row id, which is
// global across topics, and an unknown (expired) id replays the whole cache.

import { vi } from 'vitest';
import type { NtfyMessage } from '@/utils/ntfy';

export interface FakeServer {
  messages: NtfyMessage[];
  /** Topics the credentials can't read (GET /<topic>/auth answers 403) */
  unreadable: string[];
  /** /auth fails with a network error */
  authDown: boolean;
  /** HTTP status of polls (200 by default) */
  pollStatus: number;
  /** Hosts that don't answer: requests to them reject with a TypeError, like fetch does */
  downHosts: string[];
  /** While set, /auth answers wait for it */
  authGate: Promise<void> | null;
  /** While set, poll answers wait for it */
  pollGate: Promise<void> | null;
  now: number;
  requests: { url: string; auth: string | null }[];
  publish(topic: string, time: number, extra?: Partial<NtfyMessage>): NtfyMessage;
}

/**
 * A subscription (GET /<topics>/json without poll=1): the fetch waits until accept() or refuse(), then
 * the response body streams what deliver() and send() write. The body is pulled one chunk at a time,
 * so deliver() resolves once the receiver has handled its chunk and asks for the next one.
 */
export class FakeStream {
  static instances: FakeStream[] = [];

  /** The receiver aborted the request (close, resubscribe or idle limit) */
  aborted = false;
  readonly response: Promise<Response>;
  private respond!: (response: Response) => void;
  private fail!: (error: unknown) => void;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** Written, not yet read */
  private queue: { chunk: Uint8Array; handled: () => void }[] = [];
  /** Read by the receiver, not yet handled (until it asks for the next chunk) */
  private inFlight: (() => void)[] = [];
  /** A read waiting for something to be written */
  private wake: (() => void) | null = null;

  constructor(
    public url: string,
    public auth: string | null,
    signal: AbortSignal | undefined,
  ) {
    FakeStream.instances.push(this);
    this.response = new Promise((resolve, reject) => {
      this.respond = resolve;
      this.fail = reject;
    });
    signal?.addEventListener('abort', () => {
      this.aborted = true;
      const reason: unknown = signal.reason;
      this.fail(reason);
      try {
        this.controller?.error(reason);
      } catch {
        // Already closed
      }
      this.release();
    });
  }

  /** The server accepted the subscription: 200 and an open body */
  accept(): void {
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: async (controller) => {
          // The receiver asks for more: it has handled everything it read before
          this.inFlight.splice(0).forEach((handled) => handled());
          if (this.queue.length === 0) {
            await new Promise<void>((resolve) => (this.wake = resolve));
          }
          const next = this.queue.shift();
          if (next && !this.aborted) {
            this.inFlight.push(next.handled);
            controller.enqueue(next.chunk);
          }
        },
      },
      { highWaterMark: 0 },
    );
    this.respond(new Response(body, { status: 200 }));
  }

  /** The server refused the subscription with an HTTP status */
  refuse(status: number): void {
    this.respond(new Response('', { status }));
  }

  /** Write raw text to the body; resolves when the receiver has handled it */
  send(text: string): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ chunk: new TextEncoder().encode(text), handled: resolve });
      this.wake?.();
      this.wake = null;
    });
  }

  /** A message as a line, as ntfy streams it */
  deliver(message: NtfyMessage): Promise<void> {
    return this.send(`${JSON.stringify(message)}\n`);
  }

  /** The server ended the response */
  end(): void {
    try {
      this.controller?.close();
    } catch {
      // Already closed
    }
    this.release();
  }

  private release(): void {
    this.inFlight.splice(0).forEach((handled) => handled());
    this.queue.splice(0).forEach(({ handled }) => handled());
    this.wake?.();
    this.wake = null;
  }
}

export function installFakeNtfy(): FakeServer {
  let nextId = 0;
  const server: FakeServer = {
    messages: [],
    unreadable: [],
    authDown: false,
    pollStatus: 200,
    downHosts: [],
    authGate: null,
    pollGate: null,
    now: 10000,
    requests: [],
    publish(topic, time, extra = {}) {
      const message: NtfyMessage = { id: `m${++nextId}`, event: 'message', topic, time, title: 't', message: 'x', ...extra };
      server.messages.push(message);
      return message;
    },
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    server.requests.push({ url: url.toString(), auth: headers.get('Authorization') });
    const topic = url.pathname.split('/')[1] ?? '';
    // A subscription: created at once, answered when the test accepts or refuses it
    if (url.pathname.endsWith('/json') && !url.searchParams.has('poll')) {
      if (server.downHosts.includes(url.host)) {
        throw new TypeError('Failed to fetch');
      }
      return new FakeStream(url.toString(), headers.get('Authorization'), init?.signal ?? undefined).response;
    }
    // Some latency, so concurrent calls interleave
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
    if (server.downHosts.includes(url.host)) {
      throw new TypeError('Failed to fetch');
    }
    if (url.pathname === '/v1/health') {
      return new Response('{"healthy":true}', { status: 200 });
    }

    if (url.pathname.endsWith('/auth')) {
      if (server.authGate) await server.authGate;
      if (server.authDown) throw new TypeError('Failed to fetch');
      const readable = !server.unreadable.includes(topic);
      return new Response('{"success":true}', { status: readable ? 200 : 403 });
    }

    if (server.pollGate) await server.pollGate;
    if (server.pollStatus !== 200) {
      return new Response('', { status: server.pollStatus });
    }
    const since = url.searchParams.get('since') ?? 'all';
    let messages = server.messages.filter((m) => m.topic === topic);
    if (/^\d+$/.test(since)) {
      messages = messages.filter((m) => m.time >= Number(since));
    } else if (/^\d+h$/.test(since)) {
      messages = messages.filter((m) => m.time >= server.now - parseInt(since, 10) * 3600);
    } else if (since !== 'all') {
      const row = server.messages.findIndex((m) => m.id === since);
      messages = messages.filter((m) => server.messages.indexOf(m) > row);
    }
    return new Response(messages.map((m) => JSON.stringify(m)).join('\n'), { status: 200 });
  });

  FakeStream.instances = [];
  vi.stubGlobal('fetch', fetchMock);
  return server;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
