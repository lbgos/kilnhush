// HTTP front of the agent: the control API under /api and an OpenAI-compatible
// proxy under /v1 that wakes the mode serving the requested model.
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import { request as requestTls } from "node:https";
import { type } from "arktype";
import { type Agent, BusyError, HeldError } from "./agent.ts";

const switchBody = type({ mode: "string", "force?": "boolean" });
const maxBody = 64 * 1024 * 1024;

export function createAgentServer(agent: Agent, token?: string) {
  const proxyModes = [...agent.config.modes.values()].filter((m) => m.proxy);

  const authorized = (req: IncomingMessage) => {
    if (!token) return true;
    const got = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  /** Picks the proxy mode by the request's `model`, or the only proxy mode. */
  const route = (body: Buffer) => {
    if (proxyModes.length === 1) return proxyModes[0];
    let model: unknown;
    try {
      model = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
    } catch {
      return undefined;
    }
    return proxyModes.find((m) => typeof model === "string" && m.proxy?.models.includes(model));
  };

  const proxy = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const mode = route(body);
    if (!mode?.proxy) return json(res, 404, { error: "no mode serves this model" });

    let release: () => void;
    try {
      release = await agent.acquire(mode.name);
    } catch (err) {
      const status = err instanceof HeldError || err instanceof BusyError ? 503 : 502;
      return json(res, status, { error: (err as Error).message });
    }

    const target = new URL(req.url ?? "/", mode.proxy.target);
    const send = target.protocol === "https:" ? requestTls : request;
    const upstream = send(target, { method: req.method, headers: { ...req.headers, host: target.host } });
    res.once("close", () => {
      release();
      // A client that hangs up mid-stream should stop the generation too.
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.once("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.once("error", (err) => {
      if (res.headersSent) res.destroy();
      else json(res, 502, { error: err.message });
    });
    upstream.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;

    if (path === "/health") return json(res, 200, { ok: true });

    if (path.startsWith("/api/")) {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      if (path === "/api/state" && req.method === "GET") return json(res, 200, await agent.state());
      if (path === "/api/switch" && req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse((await readBody(req)).toString("utf8"));
        } catch {
          return json(res, 400, { error: "body is not JSON" });
        }
        const input = switchBody(parsed);
        if (input instanceof type.errors) return json(res, 400, { error: input.summary });
        if (!agent.config.modes.has(input.mode)) return json(res, 400, { error: `unknown mode ${input.mode}` });
        try {
          await agent.switch(input.mode, input.force ?? false);
        } catch (err) {
          if (err instanceof BusyError) return json(res, 409, { error: err.message, mode: err.mode, risks: err.risks });
          return json(res, 500, { error: (err as Error).message });
        }
        return json(res, 200, await agent.state());
      }
      return json(res, 404, { error: "not found" });
    }

    // Model lists come from config, so listing does not wake anything.
    if (path === "/v1/models" && req.method === "GET") {
      const ids = proxyModes.flatMap((m) => (m.proxy?.models.length ? m.proxy.models : [m.name]));
      return json(res, 200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "kilnhush" })) });
    }
    if (path.startsWith("/v1/")) return proxy(req, res);

    json(res, 404, { error: "not found" });
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: err.message });
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBody) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
