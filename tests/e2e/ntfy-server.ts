// A small ntfy server for the end-to-end tests: real HTTP, with the JSON stream for subscriptions,
// following ntfy v2.29 where the extension depends on it. Not covered: attachments, caching limits,
// rate limits, keepalive events. Credentials are only accepted in the Authorization header (real ntfy
// also takes ?auth=, which the extension must not use).
//
// One difference: CORS preflights also allow Authorization explicitly. Real ntfy answers with
// Access-Control-Allow-Headers: *, which doesn't cover Authorization, so the extension needs host
// access to the server; a test can't click Chrome's permission prompt (unit tests cover that path).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ServerMessage {
  id: string;
  time: number;
  event: 'message';
  topic: string;
  sequence_id?: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  content_type?: string;
}

interface ServerDeletion {
  id: string;
  time: number;
  event: 'message_delete';
  topic: string;
  sequence_id: string;
}

export interface PublishedRequest {
  topic: string;
  body: string;
  headers: Record<string, string | undefined>;
}

export interface NtfyTestServer {
  url: string;
  token: string;
  /** Topics the token can't read: their subscription (and any subscription including them) gets 403 */
  unreadable: Set<string>;
  /** Topics the token can't delete from */
  readOnly: Set<string>;
  messages: (ServerMessage | ServerDeletion)[];
  /** Messages published by the extension */
  published: PublishedRequest[];
  /** When set, an accepted publish waits before returning its response. */
  publishGate?: Promise<void>;
  /** Topic lists of the subscriptions (JSON streams) accepted so far */
  subscriptions: string[][];
  /** Publish as another client would: stored, and sent to open subscriptions */
  publish(topic: string, fields?: Partial<ServerMessage>): ServerMessage;
  deleteNotification(topic: string, sequenceId: string): ServerDeletion;
  /** End every open subscription (the extension reconnects) */
  dropConnections(): void;
  /** Refuse new subscriptions until set back to true */
  acceptConnections: boolean;
  close(): Promise<void>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, *',
};

function send(res: ServerResponse, status: number, body: string, contentType = 'application/json', headers = {}): void {
  res.writeHead(status, { ...CORS, 'Content-Type': contentType, ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** RFC 2047 =?utf-8?B?...?= header values, as the extension sends non-ASCII titles */
function decodeHeader(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const encoded = text?.match(/^=\?utf-8\?B\?(.*)\?=$/i);
  return encoded ? Buffer.from(encoded[1]!, 'base64').toString('utf8') : text;
}

export async function startNtfyServer(token = 'tk_e2e'): Promise<NtfyTestServer> {
  let nextId = 0;
  const streams = new Map<ServerResponse, string[]>();
  const deliver = (event: ServerMessage | ServerDeletion) => {
    server.messages.push(event);
    for (const [stream, topics] of streams) {
      if (topics.includes(event.topic)) stream.write(`${JSON.stringify(event)}\n`);
    }
  };

  const server: NtfyTestServer = {
    url: '',
    token,
    unreadable: new Set(),
    readOnly: new Set(),
    messages: [],
    published: [],
    subscriptions: [],
    acceptConnections: true,
    publish(topic, fields = {}) {
      const message: ServerMessage = {
        id: `msg${++nextId}`,
        time: Math.floor(Date.now() / 1000),
        event: 'message',
        topic,
        ...fields,
      };
      deliver(message);
      return message;
    },
    deleteNotification(topic, sequenceId) {
      const event: ServerDeletion = {
        id: `msg${++nextId}`,
        time: Math.floor(Date.now() / 1000),
        event: 'message_delete',
        topic,
        sequence_id: sequenceId,
      };
      deliver(event);
      return event;
    },
    dropConnections() {
      for (const stream of streams.keys()) stream.destroy();
      streams.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.dropConnections();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };

  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }
    if (path === '/v1/health') {
      send(res, 200, '{"healthy":true}');
      return;
    }

    const [, topicPart = '', action] = path.split('/');
    const topics = topicPart.split(',').filter(Boolean);
    if (!authorized(req)) {
      send(res, 401, '{"code":40101,"http":401,"error":"unauthorized"}');
      return;
    }

    if (req.method === 'DELETE' && topics.length === 1 && action) {
      const topic = topics[0]!;
      if (server.readOnly.has(topic)) {
        send(res, 403, '{"code":40301,"http":403,"error":"forbidden"}');
      } else {
        send(res, 200, JSON.stringify(server.deleteNotification(topic, action)));
      }
      return;
    }

    if (req.method === 'POST' && topics.length === 1 && !action) {
      const topic = topics[0]!;
      const body = await readBody(req);
      server.published.push({
        topic,
        body,
        headers: {
          title: decodeHeader(req.headers['x-title']),
          priority: decodeHeader(req.headers['x-priority']),
          tags: decodeHeader(req.headers['x-tags']),
        },
      });
      await server.publishGate;
      const priority = Number(req.headers['x-priority']);
      const message = server.publish(topic, {
        message: body,
        title: decodeHeader(req.headers['x-title']),
        ...(priority ? { priority } : {}),
      });
      send(res, 200, JSON.stringify(message));
      return;
    }

    if (req.method === 'GET' && action === 'auth') {
      const readable = topics.every((topic) => !server.unreadable.has(topic));
      send(res, readable ? 200 : 403, readable ? '{"success":true}' : '{"code":40301,"http":403,"error":"forbidden"}');
      return;
    }

    if (req.method === 'GET' && action === 'json') {
      if (topics.some((topic) => server.unreadable.has(topic))) {
        send(res, 403, '{"code":40301,"http":403,"error":"forbidden"}');
        return;
      }
      // Without poll=1: a subscription, open until either side closes it
      if (!url.searchParams.has('poll')) {
        if (!server.acceptConnections) {
          send(res, 503, '{"code":50301,"http":503,"error":"unavailable"}');
          return;
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        res.write(
          `${JSON.stringify({ id: `open${++nextId}`, time: Math.floor(Date.now() / 1000), event: 'open', topic: topics.join(',') })}\n`,
        );
        streams.set(res, topics);
        server.subscriptions.push(topics);
        req.on('close', () => streams.delete(res));
        return;
      }
      const since = url.searchParams.get('since') ?? 'all';
      const now = Math.floor(Date.now() / 1000);
      const duration = /^\d+[hs]$/.test(since) ? parseInt(since, 10) * (since.endsWith('h') ? 3600 : 1) : undefined;
      const minTime = /^\d+$/.test(since) ? Number(since) : duration === undefined ? 0 : now - duration;
      const lines = server.messages.filter((m) => topics.includes(m.topic) && m.time >= minTime).map((m) => JSON.stringify(m));
      send(res, 200, lines.join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson', {
        'Access-Control-Expose-Headers': 'Date, X-Messages-Truncated',
        'X-Messages-Truncated': '0',
      });
      return;
    }

    send(res, 404, '{"code":40401,"http":404,"error":"page not found"}');
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return server;
}
