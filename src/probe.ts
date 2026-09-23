// Asks running workloads whether stopping them now would lose work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

type JupyterSession = {
  path: string;
  kernel: { execution_state: string; connections: number; last_activity: string };
};

/**
 * Reads /api/sessions. A kernel running a cell makes the mode busy. A notebook
 * open in a browser tab is a risk: JupyterLab keeps unsaved edits in the
 * browser, where the server can neither see nor save them. No answer is also
 * a risk, because not knowing is not the same as idle.
 */
export async function probeJupyter(spec: JupyterSpec): Promise<Activity> {
  const now = Date.now();
  const failed = (why: string): Activity => ({ busy: false, risks: [`jupyter ${why}`], lastActive: now });
  const token = spec.tokenEnv ? process.env[spec.tokenEnv] : undefined;
  let sessions: JupyterSession[];
  try {
    const res = await fetch(new URL("api/sessions", spec.url.endsWith("/") ? spec.url : `${spec.url}/`), {
      headers: token ? { authorization: `token ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return failed(`answered ${res.status}`);
    sessions = (await res.json()) as JupyterSession[];
  } catch (err) {
    return failed(`did not answer: ${(err as Error).message}`);
  }

  const act: Activity = { busy: false, risks: [], lastActive: 0 };
  for (const { path, kernel } of sessions) {
    act.lastActive = Math.max(act.lastActive, Date.parse(kernel.last_activity) || 0);
    if (kernel.execution_state === "busy") {
      act.busy = true;
      act.risks.push(`${path}: cell running`);
    }
    if (kernel.connections > 0) {
      act.risks.push(`${path}: open in ${kernel.connections} browser tab(s), unsaved edits would be lost`);
    }
  }
  if (act.busy) act.lastActive = now;
  return act;
}

export type Gpu = { name: string; util: number; memUsed: number; memTotal: number };

/** Reads the first GPU from nvidia-smi. Null where nvidia-smi is missing or fails. */
export async function readGpu(): Promise<Gpu | null> {
  try {
    const { stdout } = await promisify(execFile)(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
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
