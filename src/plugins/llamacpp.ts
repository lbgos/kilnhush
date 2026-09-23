// llama.cpp's llama-server. /slots shows requests that bypass the proxy.
import { type } from "arktype";
import { defaultRoute } from "./custom.ts";
import { activity, get, guard, json } from "./http.ts";
import type { Plugin } from "./types.ts";

const slotsSchema = type({ is_processing: "boolean" }).array();

/** Model and server info reads; replayed while the server is stopped. */
const cached = new Set(["/v1/models", "/models", "/props"]);

export const llamacpp: Plugin = {
  id: "llamacpp",
  name: "llama.cpp",
  port: 8080,
  health: "/health",
  run: "on_demand",
  idle: 20 * 60_000,
  detect: {
    unit: /^llama[-.]?(cpp|server)[\w@.-]*\.service$/,
    image: /(^|\/)(ggml-org|ggerganov)\/llama\.cpp:server/,
    cmdline: /(^|\/)llama-server(\s|$)/,
  },
  /** Writes are work, a page load opens the built-in web UI. */
  route(req) {
    return req.method === "GET" && cached.has(req.path) ? "cached" : defaultRoute(req);
  },
  /** Busy while any slot is processing. With --no-slots the proxy count alone has to do. */
  probe(target) {
    return guard("llamacpp", async () => {
      const res = await get(target, "/slots");
      if (res.status === 404 || res.status === 501) {
        await res.body?.cancel();
        return activity(false);
      }
      const slots = await json(res, slotsSchema);
      return activity(slots.some((s) => s.is_processing));
    });
  },
};
