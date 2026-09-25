// The agent's API contract and a small client for it. The CLI and a remote bot
// use the client over HTTP, a bot inside the agent calls the routes directly;
// src/server.ts produces these shapes.
import type { Discovery } from "./discover.ts";
import type { Run } from "./plugins/types.ts";
import type { Gpu } from "./probe.ts";
import type { ServicePatch, SettingsView } from "./settings.ts";

export type AgentEvent = {
  at: number;
  kind: "start" | "stop" | "wake" | "idle" | "refuse" | "fail";
  text: string;
};

export type ServiceInfo = {
  name: string;
  /** Plugin display name. */
  plugin: string;
  run: Run;
  idle: number;
  proxy: number | null;
  models: string[];
};

export type State = {
  /** The service holding the card. Null when the card is free, mid-switch, or after a failed switch. */
  holder: string | null;
  switching: string | null;
  home: string | null;
  homePaused: boolean;
  pinned: boolean;
  /** Epoch ms when the holder became ready. */
  since: number;
  /** The holder's activity. */
  busy: boolean;
  risks: string[];
  lastActive: number;
  /** A manual holder has been idle past its `remind` threshold. */
  reminderDue: boolean;
  /** In priority order, first matters most. */
  services: ServiceInfo[];
  warnings: string[];
  gpu: Gpu | null;
  /** The agent's hostname, for the URLs clients should use. */
  host: string;
  /** GPU memory of the holder's processes in MiB. Null when nvidia-smi shows none. */
  vram: number | null;
  /** GPU processes no configured service owns, e.g. a script started from a shell. */
  unmanaged: { pid: number; name: string; usedMiB: number }[];
  /** Newest first. */
  events: AgentEvent[];
};

export type SettingsAction = "view" | "reload" | "add" | "update" | "move" | "remove" | "redeem" | "remove-user";
export type { ServicePatch };

export type ActionResult =
  | { ok: true; state: State }
  | { ok: false; busy: { service: string; risks: string[] } }
  | { ok: false; error: string };

/** One /api call. Over HTTP for a remote agent, or apiRoutes() from src/server.ts in the agent's own process. */
export type Send = (method: "GET" | "POST", path: string, body: object, timeoutMs: number) => Promise<{ status: number; body: unknown }>;

export function overHttp(baseUrl: string, token?: string): Send {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return async (method, path, body, timeoutMs) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(method === "POST" && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

export type AgentClient = ReturnType<typeof agentClient>;

type Failure = { error?: string; service?: string; risks?: string[] };

export function agentClient(send: Send) {
  /** The server answers 200 with `T`, anything else with a Failure. Nothing checks the shapes at runtime. */
  const call = async <T>(method: "GET" | "POST", path: string, body: object = {}, timeoutMs = 60_000) => {
    const res = await send(method, path, body, timeoutMs);
    if (res.status === 200) return { ok: true as const, body: res.body as T };
    const { error, service, risks } = res.body as Failure;
    return { ok: false as const, status: res.status, service, risks, error: error ?? `agent: ${res.status}` };
  };
  const must = async <T>(method: "GET" | "POST", path: string) => {
    const res = await call<T>(method, path);
    if (!res.ok) throw new Error(res.error);
    return res.body;
  };

  /** Starting waits for the service to become ready, which can take minutes. */
  const act = async (action: "start" | "stop", service: string, force: boolean): Promise<ActionResult> => {
    const res = await call<State>("POST", `/api/${action}`, { service, force }, 10 * 60_000);
    if (res.ok) return { ok: true, state: res.body };
    if (res.status === 409 && res.service && res.risks) return { ok: false, busy: { service: res.service, risks: res.risks } };
    return { ok: false, error: res.error };
  };

  return {
    state: () => must<State>("GET", "/api/state"),
    start: (service: string, force = false) => act("start", service, force),
    stop: (service: string, force = false) => act("stop", service, force),

    /** Reads or edits settings. Edits answer with the new settings or the reason they were refused. */
    async settings(action: SettingsAction, body?: object): Promise<{ ok: true; view: SettingsView } | { ok: false; error: string }> {
      const res = await call<SettingsView>(action === "view" ? "GET" : "POST", `/api/settings/${action}`, body);
      return res.ok ? { ok: true, view: res.body } : { ok: false, error: res.error };
    },

    discover: () => must<Discovery>("GET", "/api/settings/discover"),

    /** A one-time code for a new bot user, with a t.me link when the agent knows the bot. */
    pair: () => must<{ code: string; link: string | null }>("POST", "/api/pair"),
  };
}
