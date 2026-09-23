// Asks running workloads whether stopping them now would lose work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type } from "arktype";
import type { JupyterSpec } from "./config.ts";

export type Activity = {
  /** Work is running at this moment. */
  busy: boolean;
  /** What a stop would break. Any risk blocks a switch unless it is forced. */
  risks: string[];
  /** Epoch ms of the last observed work. */
  lastActive: number;
};

export function mergeActivity(into: Activity, from: Activity) {
  into.busy ||= from.busy;
  into.risks.push(...from.risks);
  into.lastActive = Math.max(into.lastActive, from.lastActive);
}

const kernelsSchema = type({ id: "string", execution_state: "string", connections: "number", last_activity: "string" }).array();
const sessionsSchema = type({ path: "string", kernel: { id: "string" } }).array();

/**
 * Reads /api/kernels and /api/sessions. A kernel running code makes the mode
 * busy, including kernels started without a session, like remote kernels from
 * an editor. A kernel with an open connection is a risk: JupyterLab keeps
 * unsaved edits in the browser, where the server can neither see nor save
 * them. No answer is also a risk, because not knowing is not the same as idle.
 */
export async function probeJupyter(spec: JupyterSpec): Promise<Activity> {
  const now = Date.now();
  const token = spec.tokenEnv ? process.env[spec.tokenEnv] : undefined;
  const base = spec.url.endsWith("/") ? spec.url : `${spec.url}/`;
  const get = async <T>(path: string, schema: (data: unknown) => T | type.errors): Promise<T> => {
    const res = await fetch(new URL(path, base), {
      headers: token ? { authorization: `token ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    const data = schema(await res.json());
    if (data instanceof type.errors) throw new Error(`${path} sent unexpected JSON: ${data.summary}`);
    return data;
  };

  let kernels: typeof kernelsSchema.infer;
  let sessions: typeof sessionsSchema.infer;
  try {
    [kernels, sessions] = await Promise.all([get("api/kernels", kernelsSchema), get("api/sessions", sessionsSchema)]);
  } catch (err) {
    return { busy: false, risks: [`jupyter: ${(err as Error).message}`], lastActive: now };
  }

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
  if (act.busy) act.lastActive = now;
  return act;
}

export type Gpu = { name: string; util: number; memUsed: number; memTotal: number };

/** Reads one GPU from nvidia-smi. Null where nvidia-smi is missing or fails. */
export async function readGpu(index = 0): Promise<Gpu | null> {
  try {
    const { stdout } = await promisify(execFile)(
      "nvidia-smi",
      ["-i", String(index), "--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 5_000 },
    );
    return parseSmi(stdout);
  } catch {
    return null;
  }
}

export function parseSmi(stdout: string): Gpu | null {
  const [name, ...nums] = (stdout.trim().split("\n")[0] ?? "").split(",").map((f) => f.trim());
  const [util, memUsed, memTotal] = nums.map(Number);
  if (!name || util === undefined || memUsed === undefined || memTotal === undefined || nums.length !== 3) return null;
  if ([util, memUsed, memTotal].some(Number.isNaN)) return null;
  return { name, util, memUsed, memTotal };
}
