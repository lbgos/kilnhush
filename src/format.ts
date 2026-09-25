// Plain-text status shared by the bot and the CLI.
import type { State } from "./api.ts";
import type { Run } from "./plugins/types.ts";

/** 75_000 → "1m15s", 11_520_000 → "3h12m". */
export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
  return `${s}s`;
}

/** How each run setting reads to a person. */
export const runLabel: Record<Run, string> = {
  on_demand: "when used",
  always: "always on",
  manual: "by hand",
};

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);
const gb = (mib: number) => (mib / 1024).toFixed(1);

function headline(s: State, now: number) {
  if (s.holder) return `${s.holder} · ${formatDuration(now - s.since)}${s.vram === null ? "" : ` · ${gb(s.vram)} GB`}`;
  if (s.switching) return `starting ${s.switching}…`;
  if (s.risks.length > 0) return "no service, the last switch failed";
  return s.homePaused ? "card free, home stopped by hand" : "card free";
}

export function formatState(s: State, now = Date.now()) {
  const lines = [headline(s, now)];
  if (s.holder) lines.push(s.busy ? "busy" : `idle ${formatDuration(now - s.lastActive)}`);
  if (s.gpu) {
    const { name, util, memUsed, memTotal } = s.gpu;
    const filled = Math.round((memUsed / Math.max(memTotal, 1)) * 16);
    lines.push(`${s.host} · ${name} ${util}%`, `${"█".repeat(filled)}${"░".repeat(16 - filled)} ${gb(memUsed)}/${gb(memTotal)} GB`);
  }
  if (s.unmanaged.length > 0) {
    lines.push(`also on the GPU: ${s.unmanaged.map((p) => `${p.name} (pid ${p.pid}) ${gb(p.usedMiB)} GB`).join(", ")}`);
  }
  for (const risk of s.risks) lines.push(`! ${risk}`);
  lines.push("");
  for (const svc of s.services) {
    const port = svc.proxy ? ` · :${svc.proxy}` : "";
    lines.push(`${svc.name === s.holder ? "●" : "○"} ${svc.name} · ${runLabel[svc.run]}${port}`);
  }
  if (s.events.length > 0) {
    lines.push("");
    for (const e of s.events.slice(0, 5)) lines.push(`${clock(e.at)} ${e.kind} ${e.text}`);
  }
  return lines.join("\n");
}
