// Asks running workloads whether stopping them now would lose work.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
