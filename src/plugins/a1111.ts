// Stable Diffusion WebUI: AUTOMATIC1111 and Forge, started with --api.
import { type } from "arktype";
import { defaultRoute } from "./custom.ts";
import { activity, get, guard, json } from "./http.ts";
import type { Plugin } from "./types.ts";

const progressSchema = type({ state: { job_count: "number" } });

export const a1111: Plugin = {
  id: "a1111",
  name: "Stable Diffusion WebUI (A1111/Forge)",
  port: 7860,
  health: "/sdapi/v1/progress",
  run: "on_demand",
  idle: 30 * 60_000,
  detect: {
    unit: /^(a1111|automatic1111|sd-?webui|stable-diffusion-webui|sd-forge)\b[\w@.-]*\.service$/i,
    image: /stable-diffusion-webui|automatic1111|a1111|sd-forge|webui-forge/i,
    cmdline: /(^|[\s/])webui\.(sh|py)(\s|$)|(stable-diffusion-webui|forge)[^\s/]*\/launch\.py(\s|$)/i,
  },
  // The UI polls progress with POST while a render runs; that is not work.
  route: (req) => (req.path === "/internal/progress" ? "passive" : defaultRoute(req)),
  /** Busy while jobs run or wait. The target token is "user:pass" for --api-auth. */
  probe(target) {
    const auth = target.token && `Basic ${Buffer.from(target.token).toString("base64")}`;
    return guard("a1111", async () => {
      const progress = await json(await get(target, "/sdapi/v1/progress?skip_current_image=true", auth), progressSchema);
      const jobs = progress.state.job_count;
      return activity(jobs > 0, jobs > 0 ? [`${jobs} image job(s) running or queued`] : []);
    });
  },
};
