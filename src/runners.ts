// Starts and stops the processes a service is made of: systemd units and
// docker containers the host already has, or commands the agent runs as its
// own children.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ProcSpec } from "./config.ts";

/** One process of a service, with how long a start may take. */
export type RunnerSpec = ProcSpec & { readyTimeout: number };

export interface Runner {
  readonly key: string;
  readonly name: string;
  /** Resolves once the service is healthy. */
  start(): Promise<void>;
  stop(): Promise<void>;
  active(): Promise<boolean>;
}

const run = promisify(execFile);

export function createRunner(spec: RunnerSpec): Runner {
  if (spec.unit) return systemdUnit(spec, spec.unit);
  if (spec.container) return container(spec, spec.container);
  return command(spec);
}

/** Whether the host has this unit or container at all, running or not. */
export async function hostHas(proc: { unit?: string; container?: string }) {
  try {
    if (proc.unit) {
      const { stdout } = await run("systemctl", ["show", "--property=LoadState", "--value", proc.unit], { timeout: 10_000 });
      return stdout.trim() === "loaded";
    }
    if (proc.container) {
      await run("docker", ["inspect", "--type", "container", "--format", "{{.Id}}", proc.container], { timeout: 10_000 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Maps `systemctl is-active` output to running or not. A unit that is
 * starting or stopping still holds the GPU. Anything unrecognized throws:
 * a failed query must not read as "stopped".
 */
export function unitRunning(state: string) {
  if (state === "inactive" || state === "failed") return false;
  if (["active", "activating", "deactivating", "reloading", "refreshing"].includes(state)) return true;
  throw new Error(`unknown unit state ${JSON.stringify(state)}`);
}

function systemdUnit(spec: RunnerSpec, unit: string): Runner {
  const active = async () => {
    let state: string;
    try {
      state = (await run("systemctl", ["is-active", unit], { timeout: 10_000 })).stdout;
    } catch (err) {
      // is-active exits non-zero for inactive units but still prints the state.
      state = (err as { stdout?: string }).stdout ?? "";
      if (!state.trim()) throw new Error(`systemctl is-active ${unit}: ${(err as Error).message}`);
    }
    return unitRunning(state.trim());
  };
  return {
    key: spec.key,
    name: unit,
    active,
    async start() {
      await run("systemctl", ["start", unit], { timeout: spec.readyTimeout });
      await waitHealthy(spec.name, spec.health, spec.readyTimeout, active);
    },
    async stop() {
      await run("systemctl", ["stop", unit], { timeout: 120_000 });
    },
  };
}

/**
 * Maps `docker inspect` status to running or not. A paused or restarting
 * container still holds VRAM. Anything unrecognized throws.
 */
export function containerRunning(status: string) {
  if (status === "created" || status === "exited" || status === "dead") return false;
  if (["running", "restarting", "paused", "removing"].includes(status)) return true;
  throw new Error(`unknown container status ${JSON.stringify(status)}`);
}

/** A container the host already has. A missing container throws rather than reading as stopped. */
function container(spec: RunnerSpec, name: string): Runner {
  // --type: a volume or image with the same name must not answer instead.
  const status = async () =>
    (await run("docker", ["inspect", "--type", "container", "--format", "{{.State.Status}}", name], { timeout: 10_000 })).stdout.trim();
  const active = async () => containerRunning(await status());
  return {
    key: spec.key,
    name,
    active,
    async start() {
      await run("docker", ["start", name], { timeout: spec.readyTimeout });
      // A crash-looping container reads as active, but it is not coming up.
      await waitHealthy(spec.name, spec.health, spec.readyTimeout, async () => (await status()) === "running");
    },
    async stop() {
      await run("docker", ["stop", "--time", "30", name], { timeout: 120_000 });
    },
  };
}

/** Runs `cmd` in its own process group, so stop() also ends its children. */
function command(spec: RunnerSpec): Runner {
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
      await waitHealthy(spec.name, spec.health, spec.readyTimeout, async () => running());
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

/** Polls `health` until it passes, `alive` turns false, or `timeoutMs` runs out. */
export async function waitHealthy(name: string, health: string | undefined, timeoutMs: number, alive: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await alive())) throw new Error(`${name} is not running`);
    if (!health || (await healthy(health))) return;
    if (Date.now() > deadline) throw new Error(`${name} not healthy after ${timeoutMs / 1000}s`);
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
