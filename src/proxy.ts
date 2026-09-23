// Per-service reverse proxies. A service with a `proxy` port gets its own
// listener on the agent's host that forwards to the service URL. proxyPool()
// opens and closes listeners as settings change. The plugin's
// route() decides per request whether it may wake the service and whether it
// counts as work. The /v1 router in src/server.ts uses hold() and forward()
// from here too.
import { type ClientRequest, type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import { request as requestTls } from "node:https";
import { createServer as createNetServer } from "node:net";
import type { Duplex } from "node:stream";
import { type Agent, RefusedError } from "./agent.ts";

/** Largest body kept for replay on a `cached` route. */
const maxCached = 1024 * 1024;
/** Most answers kept per proxy, so varied query strings cannot grow memory without bound. */
const maxEntries = 100;

/**
 * Keeps one proxy listening on `host` per service with a `proxy` port,
 * following config edits. A port that cannot be opened is logged, not fatal.
 */
export function proxyPool(agent: Agent, host: string, log: (msg: string) => void) {
  const listening = new Map<string, { port: number; proxy: Proxy }>();
  const sync = () => {
    const want = new Map(agent.config.services.flatMap((s) => (s.proxy === undefined ? [] : [[s.name, s.proxy] as const])));
    for (const [name, { port, proxy }] of listening) {
      if (want.get(name) === port) continue;
      listening.delete(name);
      void proxy.close();
    }
    for (const [name, port] of want) {
      if (listening.has(name)) continue;
      const proxy = createProxy(agent, name);
      proxy.server.on("error", (err) => log(`proxy for ${name} on port ${port}: ${err.message}`));
      proxy.server.listen(port, host, () => log(`proxy for ${name} on ${host}:${port}`));
      listening.set(name, { port, proxy });
    }
  };
  sync();
  const unsubscribe = agent.onConfig(sync);
  return {
    servers: () => [...listening.values()].map((p) => p.proxy.server),
    close() {
      unsubscribe();
      return Promise.all([...listening.values()].map((p) => p.proxy.close()));
    },
  };
}

export type Proxy = ReturnType<typeof createProxy>;

/**
 * The proxy for service `name`. It reads the service's settings per request,
 * so edits apply at once. Listen on its port yourself; close() ends its
 * WebSockets at once and resolves when HTTP requests have finished.
 */
export function createProxy(agent: Agent, name: string) {
  /** The last 2xx GET answer per path of `cached` routes, replayed while the service is stopped. */
  const cache = new Map<string, { type: string; body: Buffer }>();
  /** Upgraded client sockets. They never count as work and close when the service stops. */
  const sockets = new Set<Duplex>();
  let closed = false;
  const unsubscribe = agent.onStop((stopped) => {
    if (stopped === name) for (const s of sockets) s.destroy();
  });
  /** The service's current settings, or null once it was removed. Config checks guarantee a url. */
  const spec = () => {
    const service = agent.config.services.find((s) => s.name === name);
    return service?.url ? { ...service, url: service.url } : null;
  };

  const remember = (key: string, req: IncomingMessage, up: IncomingMessage) => {
    const type = up.headers["content-type"];
    // Only full answers any client may see, replayable as they are: nothing
    // behind credentials, marked private, partial or compressed.
    if (req.headers.authorization || req.headers.cookie || up.statusCode !== 200 || !type || up.headers["content-encoding"]) return;
    if (/no-store|private/i.test(up.headers["cache-control"] ?? "") || /\*|authorization|cookie/i.test(up.headers.vary ?? "")) return;
    const chunks: Buffer[] = [];
    let size = 0;
    up.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxCached) chunks.push(chunk);
    });
    up.once("end", () => {
      if (size > maxCached) return;
      // Kept in insertion order: a refreshed key moves to the end, the oldest goes first.
      cache.delete(key);
      cache.set(key, { type, body: Buffer.concat(chunks) });
      if (cache.size > maxEntries) cache.delete(cache.keys().next().value ?? "");
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const service = spec();
    if (!service) return json(res, 404, { error: `${name} was removed` });
    const key = req.url ?? "/";
    const method = req.method ?? "GET";
    const path = new URL(key, "http://x").pathname;
    const route = service.plugin.route({ method, path, accept: req.headers.accept ?? "" });

    const cacheable = route === "cached" && method === "GET";
    // Nothing to replay yet, like a client's model list after the agent started:
    // a read without credentials wakes the service once and its answer is kept.
    const firstRead = cacheable && !cache.has(key) && !req.headers.authorization && !req.headers.cookie && !(await agent.running(name));
    if (route === "work" || route === "open" || firstRead) {
      const release = await hold(agent, name, res);
      if (!release) return;
      // Settings may have changed while the request waited; the service started with the new ones.
      const url = spec()?.url;
      if (!url) {
        release();
        return json(res, 404, { error: `${name} was removed` });
      }
      // A page load or a first read wakes the service but is not busy for the whole download.
      const onResponse = firstRead
        ? (up: IncomingMessage) => {
            release();
            remember(key, req, up);
          }
        : route === "open"
          ? release
          : undefined;
      return forward(req, res, url, { onResponse });
    }
    if (await agent.running(name)) {
      return forward(req, res, spec()?.url ?? service.url, { onResponse: cacheable ? (up) => remember(key, req, up) : undefined });
    }
    const hit = cacheable ? cache.get(key) : undefined;
    if (hit) return res.writeHead(200, { "content-type": hit.type, "x-kilnhush-cache": "hit" }).end(hit.body);
    json(res, 503, { error: `${name} is not running` });
  };

  /** Pipes a WebSocket (or any upgrade) through while the service holds the card. */
  const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    // Tracked before waiting, so close() and a service stop reach it.
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const running = await agent.running(name);
    if (closed || socket.destroyed) return socket.destroy();
    const url = spec()?.url;
    if (!url || !running) return socket.end(rawStatus(503, "Service Unavailable"));

    const upstream = open(req, url);
    socket.once("close", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    upstream.once("response", (up) => {
      // The service declined the upgrade. WebSocket clients cannot read the body anyway.
      up.resume();
      socket.end(rawStatus(up.statusCode ?? 502, up.statusMessage ?? ""));
    });
    upstream.once("upgrade", (up, upSocket, upHead) => {
      upSocket.on("error", () => socket.destroy());
      upSocket.once("close", () => socket.destroy());
      socket.once("close", () => upSocket.destroy());
      const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
      for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      // Bytes that arrived with either head belong to the stream.
      if (upHead.length > 0) upSocket.unshift(upHead);
      if (head.length > 0) socket.unshift(head);
      upSocket.pipe(socket).pipe(upSocket);
    });
    upstream.end();
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: err.message });
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(req, socket, head).catch(() => socket.destroy());
  });

  return {
    server,
    close() {
      closed = true;
      unsubscribe();
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Whether a listener could open `port` on `host` right now. */
export function portFree(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * Gets the card for one request to `name` and counts it in flight until the
 * returned release runs or the client leaves. Returns null when the request
 * is already answered: refused, or the client left while the service started.
 */
export async function hold(agent: Agent, name: string, res: ServerResponse) {
  // Listen for the client leaving before acquire(): a service can take
  // minutes to start, and a missed close would leak the in-flight count.
  // Aborting also ends a wait for a busy holder, so nothing switches for a client that left.
  let release: (() => void) | undefined;
  const gone = new AbortController();
  res.once("close", () => {
    gone.abort(new Error("client left"));
    release?.();
  });
  try {
    release = await agent.acquire(name, gone.signal);
  } catch (err) {
    if (gone.signal.aborted) return null;
    if (err instanceof RefusedError) {
      json(res, 503, { error: err.message }, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
    } else {
      json(res, 502, { error: (err as Error).message });
    }
    return null;
  }
  if (gone.signal.aborted) {
    release();
    return null;
  }
  return release;
}

/**
 * Streams `req` to the service at `base` and its answer back. `body` replaces
 * the request stream when the caller has read it already. `onResponse` sees
 * the upstream response before its body is piped.
 */
export function forward(
  req: IncomingMessage,
  res: ServerResponse,
  base: string,
  { body, onResponse }: { body?: Buffer; onResponse?: (up: IncomingMessage) => void } = {},
) {
  if (res.destroyed) return;
  let upstream: ClientRequest;
  try {
    upstream = open(req, base);
  } catch (err) {
    return json(res, 502, { error: (err as Error).message });
  }
  // A client that hangs up mid-stream should stop the generation too.
  res.once("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  upstream.once("response", (up) => {
    onResponse?.(up);
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.once("error", () => res.destroy());
    up.once("aborted", () => res.destroy());
    up.pipe(res);
  });
  upstream.once("error", (err) => {
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: err.message });
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}

/** Starts `req` against the service at `base`. Throws on headers Node will not send. */
function open(req: IncomingMessage, base: string) {
  // Only path and query come from the client, so an absolute or `//host`
  // request target cannot point the proxy elsewhere. A base path like
  // /jupyter/ stays in front.
  const target = new URL(base);
  const { pathname, search } = new URL(req.url ?? "/", "http://x");
  target.pathname = target.pathname.replace(/\/$/, "") + pathname;
  target.search = search;
  const send = target.protocol === "https:" ? requestTls : request;
  // No pooled sockets: one from before a restart would fail with ECONNRESET.
  return send(target, { method: req.method, headers: { ...req.headers, host: target.host }, agent: false });
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A bodiless response for a socket the HTTP server no longer manages. */
function rawStatus(status: number, message: string) {
  return `HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`;
}
