// Starts and stops the things a mode is made of: systemd units the host
// already has, or commands the agent runs as its own children.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ServiceSpec } from "./config.ts";

export interface Service {
  readonly key: string;
  readonly name: string;
  /** Resolves once the service is healthy. */
  start(): Promise<void>;
  stop(): Promise<void>;
  active(): Promise<boolean>;
}

const run = promisify(execFile);

export function createService(spec: ServiceSpec): Service {
  return spec.unit ? systemdUnit(spec, spec.unit) : command(spec);
}

function systemdUnit(spec: ServiceSpec, unit: string): Service {
  const active = () =>
    run("systemctl", ["is-active", "--quiet", unit]).then(
      () => true,
      () => false,
    );
  return {
    key: spec.key,
    name: unit,
    active,
    async start() {
      await run("systemctl", ["start", unit], { timeout: spec.readyTimeout });
      await waitReady(spec, active);
    },
    async stop() {
      await run("systemctl", ["stop", unit], { timeout: 120_000 });
    },
  };
}

/** Runs `cmd` in its own process group, so stop() also ends its children. */
function command(spec: ServiceSpec): Service {
  const [file, ...args] = spec.cmd;
  let child: ChildProcess | null = null;
  const running = () => child !== null && child.exitCode === null && child.signalCode === null;

  return {
    key: spec.key,
    name: spec.name,
    active: async () => running(),
    async start() {
      if (!file) throw new Error("empty cmd");
      if (!running()) {
        const proc = spawn(file, args, { detached: true, stdio: ["ignore", "inherit", "inherit"] });
        await new Promise<void>((resolve, reject) => {
          proc.once("spawn", resolve);
          proc.once("error", reject);
        });
        child = proc;
      }
      await waitReady(spec, async () => running());
    },
    async stop() {
      const pgid = child?.pid;
      if (!pgid) return;
      // The leader exiting is not enough: a child that ignores SIGTERM can
      // keep holding VRAM. Wait for the whole group to go.
      signalGroup(pgid, "SIGTERM");
      if (!(await groupGone(pgid, 15_000))) {
        signalGroup(pgid, "SIGKILL");
        if (!(await groupGone(pgid, 5_000))) throw new Error(`${spec.name}: process group ${pgid} survived SIGKILL`);
      }
      child = null;
    },
  };
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

async function groupGone(pgid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw err;
    }
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

async function waitReady(spec: ServiceSpec, alive: () => Promise<boolean>) {
  const deadline = Date.now() + spec.readyTimeout;
  for (;;) {
    if (!(await alive())) throw new Error(`${spec.name} is not running`);
    if (!spec.health || (await healthy(spec.health))) return;
    if (Date.now() > deadline) throw new Error(`${spec.name} not healthy after ${spec.readyTimeout / 1000}s`);
    await sleep(500);
  }
}

export async function healthy(target: string): Promise<boolean> {
  if (target.startsWith("tcp://")) {
    const { hostname, port } = new URL(target);
    return new Promise((resolve) => {
      const sock = connect({ host: hostname, port: Number(port), timeout: 2_000 });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.once("timeout", () => done(false));
    });
  }
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
