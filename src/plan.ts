// Scheduling decisions as pure functions. The agent takes a snapshot, asks
// what to do, and carries the answer out inside its lock. Nothing here does
// I/O, so each rule has a table test.
import type { Run } from "./plugins/types.ts";

export type View = {
  name: string;
  run: Run;
  /** ms without work before an on_demand service stops. */
  idle: number;
  busy: boolean;
  /** Anything a stop would break. A failed probe is a risk too. */
  risks: string[];
  lastActive: number;
};

export type Snapshot = {
  now: number;
  /** In priority order, first matters most. */
  services: View[];
  /** The service holding the card. */
  holder: string | null;
  /** The holder was started by hand and has not idled out since. */
  pinned: boolean;
  /** The home service was stopped by hand. */
  homePaused: boolean;
  /** Services with a request waiting for the card. */
  waiting: ReadonlySet<string>;
};

export type RequestPlan =
  | { act: "use" }
  | { act: "switch" }
  | { act: "wait"; on: string }
  | { act: "refuse"; reason: string; retryAfter?: number };

export type TickPlan = { act: "none" } | { act: "release"; then: string | null } | { act: "start"; name: string };

const rank = (s: Snapshot, name: string) => s.services.findIndex((v) => v.name === name);
const view = (s: Snapshot, name: string) => {
  const v = s.services.find((v) => v.name === name);
  if (!v) throw new RangeError(`unknown service ${name}`);
  return v;
};
const quiet = (v: View) => !v.busy && v.risks.length === 0;
/** Seconds until an on_demand service idles out, if it ever does on its own. */
const untilIdle = (s: Snapshot, v: View) =>
  v.run === "on_demand" ? Math.max(1, Math.ceil((v.lastActive + v.idle - s.now) / 1000)) : undefined;

/** A higher-ranked service waiting for the card, which `x` has to let through first. */
function waiterAbove(s: Snapshot, x: string) {
  return s.services.find((v, i) => i < rank(s, x) && s.waiting.has(v.name))?.name;
}

/** What a proxied request for `x` should do now. */
export function planRequest(s: Snapshot, x: string): RequestPlan {
  const target = view(s, x);
  const above = waiterAbove(s, x);
  if (s.holder === x) return above ? { act: "wait", on: above } : { act: "use" };
  if (target.run === "manual") return { act: "refuse", reason: `${x} only starts by hand` };
  if (above) return { act: "wait", on: above };
  if (s.holder === null) return { act: "switch" };

  const holder = view(s, s.holder);
  if (holder.run === "manual") return { act: "refuse", reason: `the GPU is held by ${holder.name}, which only stops by hand` };
  if (s.pinned) {
    return { act: "refuse", reason: `${holder.name} was started by hand`, retryAfter: untilIdle(s, holder) };
  }
  if (rank(s, holder.name) < rank(s, x)) {
    return { act: "refuse", reason: `${holder.name} ranks above ${x}`, retryAfter: untilIdle(s, holder) };
  }
  return quiet(holder) ? { act: "switch" } : { act: "wait", on: holder.name };
}

/** What the periodic tick should do: idle out the holder, or bring the home service back. */
export function planTick(s: Snapshot): TickPlan {
  const home = s.services.find((v) => v.run === "always");
  const homeNext = home && s.waiting.size === 0 ? home.name : null;
  // A paused home stays off only while the card is free; a service that
  // idles out hands the card back to it.
  if (s.holder === null) return homeNext && !s.homePaused ? { act: "start", name: homeNext } : { act: "none" };

  const holder = view(s, s.holder);
  if (holder.run !== "on_demand" || !quiet(holder)) return { act: "none" };
  if (s.now - holder.lastActive < holder.idle) return { act: "none" };
  return { act: "release", then: homeNext };
}
