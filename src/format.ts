// Plain-text status shared by the bot and the CLI.
import type { State } from "./api.ts";

/** 75_000 → "1m15s", 11_520_000 → "3h12m". */
export function formatDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
  return `${s}s`;
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

export function formatState(s: State, now = Date.now()) {
  const lines = [
    s.mode ? `${s.mode} · ${formatDuration(now - s.since)}` : `switching to ${s.switching ?? s.default}…`,
  ];
  if (s.mode) lines.push(s.busy ? "busy" : `idle ${formatDuration(now - s.lastActive)}`);
  if (s.gpu) {
    const { name, util, memUsed, memTotal } = s.gpu;
    const filled = Math.round((memUsed / Math.max(memTotal, 1)) * 16);
    const gb = (mib: number) => (mib / 1024).toFixed(1);
    lines.push(`${name} ${util}%`, `${"█".repeat(filled)}${"░".repeat(16 - filled)} ${gb(memUsed)}/${gb(memTotal)} GB`);
  }
  for (const risk of s.risks) lines.push(`! ${risk}`);
  if (s.events.length > 0) {
    lines.push("");
    for (const e of s.events.slice(0, 5)) lines.push(`${clock(e.at)} ${e.kind} ${e.text}`);
  }
  return lines.join("\n");
}
