// The agent's HTTP contract and a small client for it. The bot and the CLI use
// the client; the agent server produces these shapes.
import type { Run } from "./plugins/types.ts";
import type { Gpu } from "./probe.ts";

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
  /** Newest first. */
  events: AgentEvent[];
};

export type ActionResult =
  | { ok: true; state: State }
  | { ok: false; busy: { service: string; risks: string[] } }
  | { ok: false; error: string };

export type AgentClient = ReturnType<typeof agentClient>;

export function agentClient(baseUrl: string, token?: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const url = (path: string) => new URL(path, baseUrl);

  /** Starting waits for the service to become ready, which can take minutes. */
  const act = async (action: "start" | "stop", service: string, force: boolean): Promise<ActionResult> => {
    const res = await fetch(url(`/api/${action}`), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ service, force }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const body = (await res.json()) as { error?: string; service?: string; risks?: string[] } & Partial<State>;
    if (res.ok) return { ok: true, state: body as State };
    if (res.status === 409 && body.service && body.risks) return { ok: false, busy: { service: body.service, risks: body.risks } };
    return { ok: false, error: body.error ?? `agent: ${res.status}` };
  };

  return {
    async state(): Promise<State> {
      const res = await fetch(url("/api/state"), { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`agent: ${res.status} ${await res.text()}`);
      return (await res.json()) as State;
    },
    start: (service: string, force = false) => act("start", service, force),
    stop: (service: string, force = false) => act("stop", service, force),
  };
}
