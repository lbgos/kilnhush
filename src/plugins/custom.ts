import type { Plugin, RouteClass } from "./types.ts";

/** Anything but GET, HEAD and OPTIONS. */
export function isWrite(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

/**
 * Generic HTTP rule: writes are work, a browser page load wakes the service,
 * everything else (polling, status reads) never does.
 */
export function defaultRoute(req: { method: string; accept: string }): RouteClass {
  if (isWrite(req.method)) return "work";
  return req.accept.includes("text/html") ? "open" : "passive";
}

/** Any service kilnhush has no specific knowledge of. */
export const custom: Plugin = {
  id: "custom",
  name: "Custom",
  port: 0,
  health: null,
  run: "on_demand",
  idle: 20 * 60_000,
  detect: {},
  route: defaultRoute,
};
