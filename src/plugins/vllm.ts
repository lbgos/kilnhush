// vLLM's OpenAI-compatible server. /metrics shows requests that bypass the proxy.
import { isWrite } from "./custom.ts";
import { activity, get, guard, text } from "./http.ts";
import type { Plugin } from "./types.ts";

/**
 * Sums vllm:num_requests_running and vllm:num_requests_waiting over all
 * series (one per model or engine). Throws when neither is present, since
 * then the answer says nothing about work.
 */
function queuedRequests(metrics: string): number {
  let total = 0;
  let seen = false;
  for (const line of metrics.split("\n")) {
    const m = /^vllm:num_requests_(?:running|waiting)(?:\{.*\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    seen = true;
    total += Number(m[1]);
  }
  if (!seen) throw new Error("/metrics has no vllm:num_requests_running");
  return total;
}

export const vllm: Plugin = {
  id: "vllm",
  name: "vLLM",
  port: 8000,
  health: "/health",
  run: "on_demand",
  idle: 20 * 60_000,
  detect: {
    unit: /^vllm[\w@.-]*\.service$/,
    image: /(^|\/)vllm\/vllm-openai(:|$)/,
    cmdline: /\bvllm\s+serve(\s|$)|\bvllm\.entrypoints\.openai\.api_server\b/,
  },
  route({ method, path }) {
    if (isWrite(method)) return "work";
    return method === "GET" && path === "/v1/models" ? "cached" : "passive";
  },
  probe(target) {
    return guard("vllm", async () => activity(queuedRequests(await text(await get(target, "/metrics"))) > 0));
  },
};
