// Jupyter Server and JupyterLab. Run by hand only: kernels hold state that a
// stop loses, and tabs keep kernel WebSockets open, so requests never wake it.
import { type } from "arktype";
import type { Activity } from "../probe.ts";
import { get, guard, json } from "./http.ts";
import type { Plugin, ProbeTarget } from "./types.ts";

const kernelsSchema = type({ id: "string", execution_state: "string", connections: "number", last_activity: "string" }).array();
const sessionsSchema = type({ path: "string", kernel: { id: "string" } }).array();

/**
 * Reads /api/kernels and /api/sessions. A kernel running code makes the
 * service busy, including kernels started without a session, like remote
 * kernels from an editor. A kernel with an open connection is a risk:
 * JupyterLab keeps unsaved edits in the browser, where the server can neither
 * see nor save them.
 */
export function probeKernels(target: ProbeTarget): Promise<Activity> {
  const auth = target.token && `token ${target.token}`;
  return guard("jupyter", async () => {
    const [kernels, sessions] = await Promise.all([
      get(target, "/api/kernels", auth).then((res) => json(res, kernelsSchema)),
      get(target, "/api/sessions", auth).then((res) => json(res, sessionsSchema)),
    ]);
    const paths = new Map(sessions.map((s) => [s.kernel.id, s.path]));
    const act: Activity = { busy: false, risks: [], lastActive: 0 };
    for (const k of kernels) {
      const label = paths.get(k.id) ?? `kernel ${k.id.slice(0, 8)}`;
      act.lastActive = Math.max(act.lastActive, Date.parse(k.last_activity) || 0);
      if (k.execution_state === "busy") {
        act.busy = true;
        act.risks.push(`${label}: cell running`);
      }
      if (k.connections > 0) {
        act.risks.push(`${label}: open in ${k.connections} browser tab(s), unsaved edits would be lost`);
      }
    }
    if (act.busy) act.lastActive = Date.now();
    return act;
  });
}

export const jupyter: Plugin = {
  id: "jupyter",
  name: "Jupyter",
  port: 8888,
  health: "/api",
  run: "manual",
  idle: 30 * 60_000,
  detect: {
    unit: /^jupyter(-?lab)?([@.-][\w@.-]*)?\.service$/,
    image: /(^|\/)jupyter\/[\w.-]+(:|$)/,
    cmdline: /\bjupyter[-\s](lab|server|notebook)(\s|$)/,
  },
  route: () => "passive",
  probe: probeKernels,
};
