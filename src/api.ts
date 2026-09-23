// The agent's HTTP contract and a small client for it. The bot and the CLI use
// the client; the agent server produces these shapes.
import type { Gpu } from "./probe.ts";

export type AgentEvent = {
  at: number;
  kind: "switch" | "wake" | "idle" | "refuse" | "fail";
  text: string;
};

export type State = {
  /** Null while switching or after a failed switch. */
  mode: string | null;
  switching: string | null;
  default: string;
  modes: string[];
  /** Epoch ms when the current mode became ready. */
  since: number;
  busy: boolean;
  risks: string[];
  lastActive: number;
  /** The mode has been idle past its `remind` threshold. */
  reminderDue: boolean;
  gpu: Gpu | null;
  /** Newest first. */
  events: AgentEvent[];
};

export type SwitchResult =
  | { ok: true; state: State }
  | { ok: false; busy: { mode: string; risks: string[] } }
  | { ok: false; error: string };

export type AgentClient = ReturnType<typeof agentClient>;

export function agentClient(baseUrl: string, token?: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const url = (path: string) => new URL(path, baseUrl);

  return {
    async state(): Promise<State> {
      const res = await fetch(url("/api/state"), { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`agent: ${res.status} ${await res.text()}`);
      return (await res.json()) as State;
    },

    /** Switching waits for the new mode to become ready, which can take minutes. */
    async switch(mode: string, force = false): Promise<SwitchResult> {
      const res = await fetch(url("/api/switch"), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ mode, force }),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      const body = (await res.json()) as { error?: string; mode?: string; risks?: string[] } & Partial<State>;
      if (res.ok) return { ok: true, state: body as State };
      if (res.status === 409 && body.mode && body.risks) return { ok: false, busy: { mode: body.mode, risks: body.risks } };
      return { ok: false, error: body.error ?? `agent: ${res.status}` };
    },
  };
}
