// The plugin registry. Config refers to plugins by id.
import { a1111 } from "./a1111.ts";
import { comfyui } from "./comfyui.ts";
import { custom } from "./custom.ts";
import { jupyter } from "./jupyter.ts";
import { llamacpp } from "./llamacpp.ts";
import { ollama } from "./ollama.ts";
import { vllm } from "./vllm.ts";
import { wyoming } from "./wyoming.ts";
import type { Plugin } from "./types.ts";

export const plugins: ReadonlyMap<string, Plugin> = new Map(
  [custom, ollama, llamacpp, vllm, comfyui, a1111, jupyter, wyoming].map((p) => [p.id, p]),
);
