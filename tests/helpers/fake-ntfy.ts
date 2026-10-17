// A fake ntfy server (fetch) and WebSocket for the receiving tests. since= follows ntfy v2.29:
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
  now: number;
  requests: { url: string; auth: string | null }[];
  publish(topic: string, time: number, extra?: Partial<NtfyMessage>): NtfyMessage;
}

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void | Promise<void>) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** The server accepted the connection */
  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  deliver(message: NtfyMessage): void | Promise<void> {
    return this.onmessage?.({ data: JSON.stringify(message) });
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

  FakeWebSocket.instances = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return server;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
