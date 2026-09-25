// ComfyUI. POST /prompt only queues a job and returns, so the queue, not the
// request count, tells whether work is running.
import { type } from "arktype";
import { defaultRoute } from "./custom.ts";
import { activity, get, guard, json } from "./http.ts";
import type { Plugin } from "./types.ts";

const queueSchema = type({ queue_running: "unknown[]", queue_pending: "unknown[]" });

export const comfyui: Plugin = {
  id: "comfyui",
  name: "ComfyUI",
  port: 8188,
  health: "/system_stats",
  run: "on_demand",
  idle: 30 * 60_000,
  detect: {
    unit: /^comfy(ui)?([@.-][\w@.-]*)?\.service$/i,
    image: /comfyui/i,
    cmdline: /comfy[^\s/]*\/main\.py(\s|$)|\bcomfy\s+launch(\s|$)/i,
  },
  /** Writes (POST /prompt, /api/prompt, uploads) are work and a page load opens the UI; the rest, WS /ws included, is passive. */
  route: defaultRoute,
  probe(target) {
    return guard("comfyui", async () => {
      const q = await json(await get(target, "/queue"), queueSchema);
      const n = q.queue_running.length + q.queue_pending.length;
      return activity(n > 0, n > 0 ? [`${n} prompt(s) queued or running`] : []);
    });
  },
};
