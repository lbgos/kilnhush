// The plugin registry. Config refers to plugins by id.
import { a1111 } from "./a1111.ts";
import { comfyui } from "./comfyui.ts";
import { custom } from "./custom.ts";
import { jupyter } from "./jupyter.ts";
import { llamacpp } from "./llamacpp.ts";
import { ollama } from "./ollama.ts";
import { vllm } from "./vllm.ts";
import { wyoming } from "./wyoming.ts";
import type { ServiceSpec } from "../config.ts";
import type { Activity } from "../probe.ts";
import type { Plugin } from "./types.ts";

export const plugins: ReadonlyMap<string, Plugin> = new Map(
  [custom, ollama, llamacpp, vllm, comfyui, a1111, jupyter, wyoming].map((p) => [p.id, p]),
);

/** Runs a configured service's plugin probe with its token, or null when there is nothing to ask. */
export function probeService(service: ServiceSpec): Promise<Activity | null> {
  const { plugin, url, tokenEnv } = service;
  if (!plugin.probe || !url) return Promise.resolve(null);
  return plugin.probe({ url, token: tokenEnv ? process.env[tokenEnv] : undefined });
}
