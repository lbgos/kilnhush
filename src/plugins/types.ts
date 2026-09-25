// What a plugin knows about one kind of GPU service: where it usually
// listens, how to tell it is ready or busy, which of its HTTP routes are
// real work, and how discovery recognizes it on a host.
import type { Activity } from "../probe.ts";

/**
 * How a service gets the card.
 * - on_demand: wakes on a work request through its proxy, stops after `idle`.
 * - always: the home service; runs whenever nothing else holds the card.
 * - manual: starts and stops only by hand, never automatically.
 */
export type Run = "on_demand" | "always" | "manual";

/**
 * How the proxy treats a request.
 * - work: wakes the service, counts as in flight until the response ends.
 * - open: wakes the service (a page load) but does not count as in flight.
 * - passive: never wakes; answered with 503 while the service is stopped.
 * - cached: like passive, but the last good response is replayed while stopped.
 * WebSocket upgrades are always passive.
 */
export type RouteClass = "work" | "open" | "passive" | "cached";

export type ProbeTarget = {
  /** The service's own base URL, e.g. http://127.0.0.1:8188. */
  url: string;
  token?: string;
};

export type Plugin = {
  id: string;
  /** Display name, e.g. "ComfyUI". */
  name: string;
  /** The port the service listens on by default. */
  port: number;
  /** Readiness check: a path under the service URL, "tcp" to only connect, or null for none. */
  health: string | null;
  run: Run;
  /** Default idle time in ms for on_demand services. */
  idle: number;
  /** Hints for discovery. Any match suggests this plugin. */
  detect: { unit?: RegExp; image?: RegExp; cmdline?: RegExp };
  route(req: { method: string; path: string; accept: string }): RouteClass;
  /**
   * Busy state and risks beyond proxied requests, e.g. queued ComfyUI prompts.
   * Must not throw: a failed probe returns a risk, because not knowing is not idle.
   */
  probe?(target: ProbeTarget): Promise<Activity>;
};
