// Ollama. It has no busy endpoint (/api/ps only lists loaded models), so the
// proxy's request count is the only busy signal.
import { isWrite } from "./custom.ts";
import type { Plugin } from "./types.ts";

/** Reads that clients poll for model lists; replayed while Ollama is stopped. */
const cached = new Set(["/", "/api/tags", "/api/version", "/v1/models"]);

export const ollama: Plugin = {
  id: "ollama",
  name: "Ollama",
  port: 11434,
  health: "/api/version",
  run: "on_demand",
  idle: 20 * 60_000,
  detect: {
    unit: /^ollama\.service$/,
    image: /(^|\/)ollama\/ollama(:|$)/,
    cmdline: /(^|\/)ollama\s+serve(\s|$)/,
  },
  route({ method, path }) {
    if (isWrite(method)) return "work";
    return method === "GET" && cached.has(path) ? "cached" : "passive";
  },
};
