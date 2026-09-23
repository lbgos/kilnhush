// The plugin registry. Config refers to plugins by id.
import { custom } from "./custom.ts";
import type { Plugin } from "./types.ts";

export const plugins: ReadonlyMap<string, Plugin> = new Map([custom].map((p) => [p.id, p]));
