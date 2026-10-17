// A small ntfy server for the end-to-end tests: real HTTP and WebSocket, following ntfy v2.29 where the
// extension depends on it. Not covered: attachments, caching limits, rate limits.
//
// One difference: CORS preflights also allow Authorization explicitly. Real ntfy answers with
// Access-Control-Allow-Headers: *, which doesn't cover Authorization, so the extension needs host
// access to the server; a test can't click Chrome's permission prompt (unit tests cover that path).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface ServerMessage {
  id: string;
  time: number;
  event: 'message';
  topic: string;
  title?: string;
  message?: string;
  priority?: number;
  tags?: string[];
  click?: string;
  content_type?: string;
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
  messages: ServerMessage[];
  /** Messages published by the extension */
  published: PublishedRequest[];
  /** Topic lists of the WebSocket subscriptions accepted so far */
  subscriptions: string[][];
  /** Publish as another client would: stored, and sent to open subscriptions */
  publish(topic: string, fields?: Partial<ServerMessage>): ServerMessage;
  /** Close every open WebSocket (the extension reconnects) */
  dropConnections(): void;
  /** Refuse new WebSocket connections until set back to true */
  acceptConnections: boolean;
  close(): Promise<void>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE',
  'Access-Control-Allow-Headers': 'Authorization, *',
};

function send(res: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  res.writeHead(status, { ...CORS, 'Content-Type': contentType });
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

/** The Authorization value from the header, or from ?auth= (base64url without padding) */
function authOf(req: IncomingMessage, url: URL): string | undefined {
  const query = url.searchParams.get('auth');
  if (query) {
    return Buffer.from(query, 'base64url').toString('utf8');
  }
  return req.headers.authorization;
}

/** RFC 2047 =?utf-8?B?...?= header values, as the extension sends non-ASCII titles */
function decodeHeader(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const encoded = text?.match(/^=\?utf-8\?B\?(.*)\?=$/i);
  return encoded ? Buffer.from(encoded[1]!, 'base64').toString('utf8') : text;
}

export async function startNtfyServer(token = 'tk_e2e'): Promise<NtfyTestServer> {
  let nextId = 0;
  const sockets = new Map<WebSocket, string[]>();
  const wss = new WebSocketServer({ noServer: true });

  const server: NtfyTestServer = {
    url: '',
    token,
    unreadable: new Set(),
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
      server.messages.push(message);
      for (const [socket, topics] of sockets) {
        if (topics.includes(topic)) socket.send(JSON.stringify(message));
      }
      return message;
    },
    dropConnections() {
      for (const socket of sockets.keys()) socket.terminate();
      sockets.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.dropConnections();
        wss.close();
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  };

  const authorized = (req: IncomingMessage, url: URL) => authOf(req, url) === `Bearer ${token}`;

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
    if (!authorized(req, url)) {
      send(res, 401, '{"code":40101,"http":401,"error":"unauthorized"}');
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
      const since = url.searchParams.get('since') ?? 'all';
      const now = Math.floor(Date.now() / 1000);
      const minTime = /^\d+$/.test(since) ? Number(since) : /^\d+h$/.test(since) ? now - parseInt(since, 10) * 3600 : 0;
      const lines = server.messages.filter((m) => topics.includes(m.topic) && m.time >= minTime).map((m) => JSON.stringify(m));
      send(res, 200, lines.join('\n') + (lines.length ? '\n' : ''), 'application/x-ndjson');
      return;
    }

    send(res, 404, '{"code":40401,"http":404,"error":"page not found"}');
  });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, topicPart = '', action] = url.pathname.split('/');
    const topics = topicPart.split(',').filter(Boolean);
    const status =
      action !== 'ws'
        ? 404
        : !authorized(req, url)
          ? 401
          : topics.some((t) => server.unreadable.has(t))
            ? 403
            : !server.acceptConnections
              ? 503
              : 0;
    if (status) {
      socket.write(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, topics);
      server.subscriptions.push(topics);
      ws.on('close', () => sockets.delete(ws));
      ws.on('message', () => {}); // the extension's keepalive frames
      ws.send(JSON.stringify({ id: `open${++nextId}`, time: Math.floor(Date.now() / 1000), event: 'open', topic: topics.join(',') }));
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  server.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return server;
}
