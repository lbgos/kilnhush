// The mode state machine. One mode owns the GPU at a time. Switching away
// from a mode asks its probes first and refuses while stopping would lose
// work, unless forced. Modes with `idle` wake on proxied requests and fall
// back to the default mode on their own; the rest only change by hand.
import type { AgentEvent, State } from "./api.ts";
import type { Config, JupyterSpec, ModeSpec, ServiceSpec } from "./config.ts";
import { type Activity, type Gpu, mergeActivity } from "./probe.ts";
import type { Service } from "./services.ts";

export class BusyError extends Error {
  constructor(
    readonly mode: string,
    readonly risks: string[],
  ) {
    super(`${mode} is busy: ${risks.join("; ")}`);
  }
}

/** A proxied request wants the GPU, but a mode that only stops by hand holds it. */
export class HeldError extends Error {
  constructor(readonly mode: string) {
    super(`GPU is held by ${mode} mode`);
  }
}

export type AgentDeps = {
  service: (spec: ServiceSpec) => Service;
  jupyter: (spec: JupyterSpec) => Promise<Activity>;
  gpu: () => Promise<Gpu | null>;
  now: () => number;
  log: (msg: string) => void;
};

/** Runs async sections one at a time, in call order. */
class Lock {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => {});
    return result;
  }
}

export class Agent {
  #current: string | null = null;
  #switching: string | null = null;
  /** Set when cleanup after a failed start did not finish. Only a forced switch clears it. */
  #stuck: string | null = null;
  #closing = false;
  #since = 0;
  #inflight = new Map<string, number>();
  #lastRequest = new Map<string, number>();
  #events: AgentEvent[] = [];
  #lock = new Lock();
  #services = new Map<string, Service>();

  constructor(
    readonly config: Config,
    private deps: AgentDeps,
  ) {
    for (const mode of config.modes.values()) {
      for (const spec of mode.services) {
        if (!this.#services.has(spec.key)) this.#services.set(spec.key, deps.service(spec));
      }
    }
  }

  get current() {
    return this.#current;
  }

  mode(name: string): ModeSpec {
    const mode = this.config.modes.get(name);
    if (!mode) throw new RangeError(`unknown mode ${name}`);
    return mode;
  }

  /**
   * Adopts the mode whose services are exactly the ones running. Starts the
   * default mode when only (some of) its services run. Anything else, like
   * two modes at once or half of a manual mode, throws: the agent will not
   * guess which work is safe to stop.
   */
  init() {
    return this.#lock.run(async () => {
      const all = [...this.#services.values()];
      const states = await Promise.all(all.map((s) => s.active()));
      const running = new Set(all.filter((_, i) => states[i]).map((s) => s.key));
      const keysOf = (name: string) => new Set(this.mode(name).services.map((s) => s.key));

      for (const name of this.config.modes.keys()) {
        const keys = keysOf(name);
        if (running.size > 0 && keys.size === running.size && [...running].every((k) => keys.has(k))) {
          this.#current = name;
          this.#since = this.deps.now();
          this.#event("switch", `found ${name} running`);
          return;
        }
      }
      const defaults = keysOf(this.config.default);
      if ([...running].every((k) => defaults.has(k))) return this.#switch(this.config.default, true);
      throw new Error(`unclear GPU state, running: ${[...running].join(", ")}. Stop the extra services by hand.`);
    });
  }

  /** Throws BusyError when the current mode has risks and `force` is false. */
  switch(target: string, force = false) {
    this.mode(target);
    return this.#lock.run(() => this.#switch(target, force));
  }

  /**
   * Called on a timer. Restarts the default mode after a failed switch and
   * returns idle modes to it.
   */
  tick() {
    return this.#lock.run(async () => {
      const current = this.#current;
      if (this.#closing) return;
      if (current === null) {
        if (this.#stuck) return;
        await this.#switch(this.config.default, true).catch((err: Error) => this.deps.log(`recover: ${err.message}`));
        return;
      }
      const mode = this.mode(current);
      if (!mode.idle) return;
      const act = await this.#activity(current);
      if (act.busy || act.risks.length > 0) return;
      const idleFor = this.deps.now() - act.lastActive;
      if (idleFor < mode.idle) return;
      this.#event("idle", `${current} idle ${Math.round(idleFor / 1000)}s`);
      await this.#switch(this.config.default, false).catch((err: Error) => this.deps.log(`idle return: ${err.message}`));
    });
  }

  /**
   * Makes `name` the current mode for one proxied request and counts it in
   * flight until the returned release runs. Wakes the mode when the default
   * mode or another idle-managed mode holds the GPU.
   */
  async acquire(name: string): Promise<() => void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      // While a switch away from `name` stops its services, `current` still
      // names it; new requests must wait for the switch instead.
      if (this.#current === name && this.#switching === null) return this.#begin(name);
      await this.#lock.run(async () => {
        const current = this.#current;
        if (current === name) return;
        if (this.#stuck) throw new BusyError("unknown", [this.#stuck]);
        if (current !== null && current !== this.config.default && !this.mode(current).idle) {
          throw new HeldError(current);
        }
        this.#event("wake", `request for ${name}`);
        await this.#switch(name, false);
      });
    }
    throw new Error(`${name} kept changing while waiting`);
  }

  async state(): Promise<State> {
    const current = this.#current;
    const act = current
      ? await this.#activity(current)
      : { busy: false, risks: this.#stuck ? [this.#stuck] : [], lastActive: this.#since };
    const remind = current ? this.mode(current).remind : 0;
    return {
      mode: current,
      switching: this.#switching,
      default: this.config.default,
      modes: [...this.config.modes.keys()],
      since: this.#since,
      busy: act.busy,
      risks: act.risks,
      lastActive: act.lastActive,
      reminderDue: remind > 0 && !act.busy && this.deps.now() - act.lastActive >= remind,
      gpu: await this.deps.gpu(),
      events: this.#events.slice(-20).reverse(),
    };
  }

  /**
   * Stops services the agent spawned itself; systemd units keep running.
   * Command services are children of the agent and cannot outlive it, so
   * anything that must survive an agent restart belongs in a unit. This runs
   * on a normal stop. If the agent crashes, its supervisor has to kill the
   * rest: the example unit uses KillMode=control-group.
   */
  shutdown() {
    // Queue behind a switch in progress, so a command it is starting cannot
    // outlive the agent. Switches queued after this one refuse to run.
    this.#closing = true;
    return this.#lock.run(async () => {
      const current = this.#current;
      if (current) {
        const { risks } = await this.#activity(current);
        if (risks.length > 0) this.deps.log(`shutdown stops ${current} command services despite: ${risks.join("; ")}`);
      }
      await Promise.all(
        [...this.#services.values()].filter((s) => s.key.startsWith("cmd:")).map((s) => s.stop().catch(() => {})),
      );
    });
  }

  #servicesOf(name: string) {
    return this.mode(name).services.map((spec) => this.#services.get(spec.key) as Service);
  }

  #begin(name: string) {
    this.#inflight.set(name, (this.#inflight.get(name) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inflight.set(name, (this.#inflight.get(name) ?? 1) - 1);
      this.#lastRequest.set(name, this.deps.now());
    };
  }

  async #activity(name: string): Promise<Activity> {
    const mode = this.mode(name);
    const now = this.deps.now();
    const act: Activity = {
      busy: false,
      risks: [],
      lastActive: Math.max(this.#since, this.#lastRequest.get(name) ?? 0),
    };
    const inflight = this.#inflight.get(name) ?? 0;
    if (inflight > 0) mergeActivity(act, { busy: true, risks: [`${inflight} request(s) in flight`], lastActive: now });
    if (mode.jupyter) mergeActivity(act, await this.deps.jupyter(mode.jupyter));
    if (mode.gpuGuard > 0) {
      const gpu = await this.deps.gpu();
      if (!gpu) {
        mergeActivity(act, { busy: false, risks: ["GPU reading unavailable"], lastActive: now });
      } else if (gpu.util >= mode.gpuGuard) {
        mergeActivity(act, { busy: true, risks: [`GPU at ${gpu.util}%`], lastActive: now });
      }
    }
    return act;
  }

  /** Must run inside the lock. */
  async #switch(target: string, force: boolean) {
    if (this.#closing) throw new Error("agent is shutting down");
    const from = this.#current;
    if (from === target) return;
    if (this.#stuck && !force) throw new BusyError("unknown", [this.#stuck]);
    if (from !== null && !force) {
      const act = await this.#activity(from);
      // The await above lets requests start, so read the counter again.
      const inflight = this.#inflight.get(from) ?? 0;
      const risks = act.risks.length > 0 || inflight === 0 ? act.risks : [`${inflight} request(s) in flight`];
      if (risks.length > 0) {
        this.#event("refuse", `${from} → ${target}: ${risks.join("; ")}`);
        throw new BusyError(from, risks);
      }
    }

    this.#switching = target;
    const next = this.#servicesOf(target);
    const keep = new Set(next.map((s) => s.key));
    try {
      // If a stop fails, `current` keeps naming the old mode, so recovery
      // never starts the default mode on top of whatever is still running.
      // With no current mode, whatever still runs is a leftover of a failed
      // switch. Stop it before starting the target.
      const old = from !== null ? this.#servicesOf(from).reverse() : [...this.#services.values()];
      for (const s of old) {
        if (keep.has(s.key)) continue;
        if (from !== null || (await s.active())) await s.stop();
      }
    } catch (err) {
      this.#switching = null;
      this.#event("fail", `stopping ${from}: ${(err as Error).message}`);
      throw err;
    }

    this.#current = null;
    try {
      for (const s of next) await s.start();
      this.#current = target;
      this.#stuck = null;
      this.#since = this.deps.now();
      this.#event("switch", `${from ?? "none"} → ${target}${force && from !== null ? " (forced)" : ""}`);
    } catch (err) {
      this.#event("fail", `${from ?? "none"} → ${target}: ${(err as Error).message}`);
      const leftovers: string[] = [];
      for (const s of [...next].reverse()) {
        await s.stop().catch((stopErr: Error) => leftovers.push(`${s.name}: ${stopErr.message}`));
      }
      // Something may still hold the GPU. Recovering on top of it could run
      // two modes at once, so wait for a person to force the next switch.
      if (leftovers.length > 0) {
        this.#stuck = `cleanup after failed ${target} start did not finish (${leftovers.join("; ")})`;
        this.#event("fail", this.#stuck);
      }
      throw err;
    } finally {
      this.#switching = null;
    }
  }

  #event(kind: AgentEvent["kind"], text: string) {
    this.#events.push({ at: this.deps.now(), kind, text });
    if (this.#events.length > 100) this.#events.shift();
    this.deps.log(`${kind}: ${text}`);
  }
}
