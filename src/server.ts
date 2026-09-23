// HTTP front of the agent: the control API under /api and an OpenAI-compatible
// proxy under /v1 that wakes the service serving the requested model.
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type } from "arktype";
import { type Agent, BusyError } from "./agent.ts";
import { forward, hold, json } from "./proxy.ts";
import { type SettingsDeps, settingsRoute } from "./settings.ts";

const actionBody = type({ service: "string", "force?": "boolean" });
const maxBody = 64 * 1024 * 1024;

/** Without `settings`, the /api/settings routes answer 404. */
export function createAgentServer(agent: Agent, token?: string, settings?: SettingsDeps) {
  const modelServices = () => agent.config.services.filter((s) => s.models.length > 0);

  const authorized = (req: IncomingMessage) => {
    if (!token) return true;
    const got = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  /** Picks the service by the request's `model`, or the only service that lists models. */
  const route = (body: Buffer) => {
    const candidates = modelServices();
    if (candidates.length === 1) return candidates[0];
    let model: unknown;
    try {
      model = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
    } catch {
      return undefined;
    }
    return candidates.find((s) => typeof model === "string" && s.models.includes(model));
  };

  const proxy = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const service = route(body);
    if (!service?.url) return json(res, 404, { error: "no service serves this model" });
    // hold() releases the card when the response closes.
    const release = await hold(agent, service.name, res);
    if (!release) return;
    // Settings may have changed while the request waited; the service started with the new ones.
    const url = agent.config.services.find((s) => s.name === service.name)?.url;
    if (!url) {
      release();
      return json(res, 404, { error: `${service.name} was removed` });
    }
    forward(req, res, url, { body });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;

    if (path === "/health") return json(res, 200, { ok: true });

    if (path.startsWith("/api/")) {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      if (path === "/api/state" && req.method === "GET") return json(res, 200, await agent.state());
      if (settings && path.startsWith("/api/settings/")) {
        const action = path.slice("/api/settings/".length);
        const read = action === "view" || action === "discover";
        if (req.method !== (read ? "GET" : "POST")) return json(res, 405, { error: "method not allowed" });
        let body: unknown = {};
        if (!read) {
          try {
            body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "body is not JSON" });
          }
        }
        const result = await settingsRoute(agent, settings, action, body);
        return json(res, result.status, result.body);
      }
      if ((path === "/api/start" || path === "/api/stop") && req.method === "POST") {
        let parsed: unknown;
        try {
          parsed = JSON.parse((await readBody(req)).toString("utf8"));
        } catch {
          return json(res, 400, { error: "body is not JSON" });
        }
        const input = actionBody(parsed);
        if (input instanceof type.errors) return json(res, 400, { error: input.summary });
        if (!agent.config.services.some((s) => s.name === input.service)) {
          return json(res, 400, { error: `unknown service ${input.service}` });
        }
        try {
          if (path === "/api/start") await agent.start(input.service, input.force ?? false);
          else await agent.stop(input.service, input.force ?? false);
        } catch (err) {
          if (err instanceof BusyError) return json(res, 409, { error: err.message, service: err.service, risks: err.risks });
          return json(res, 500, { error: (err as Error).message });
        }
        return json(res, 200, await agent.state());
      }
      return json(res, 404, { error: "not found" });
    }

    // Model lists come from config, so listing does not wake anything.
    if (path === "/v1/models" && req.method === "GET") {
      const ids = modelServices().flatMap((s) => s.models);
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
