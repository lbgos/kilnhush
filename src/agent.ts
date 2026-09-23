// The card's owner. One service holds the GPU at a time. Proxied requests,
// starts and stops by hand, and a periodic tick ask src/plan.ts what to do
// and carry the answer out here, one at a time. Taking the card from a
// service asks its probes first and refuses while that would lose work,
// unless forced.
import type { AgentEvent, State } from "./api.ts";
import type { Config, ServiceSpec } from "./config.ts";
import { type Snapshot, planRequest, planTick } from "./plan.ts";
import { type Activity, type Gpu, mergeActivity } from "./probe.ts";
import { type Runner, type RunnerSpec, waitHealthy } from "./runners.ts";

export class BusyError extends Error {
  constructor(
    readonly service: string,
    readonly risks: string[],
  ) {
    super(`${service} is busy: ${risks.join("; ")}`);
  }
}

/** A proxied request that cannot have the card now. `retryAfter` is in seconds. */
export class RefusedError extends Error {
  constructor(
    reason: string,
    readonly retryAfter?: number,
  ) {
    super(reason);
  }
}

export type AgentDeps = {
  runner: (spec: RunnerSpec) => Runner;
  /** The plugin's busy probe, or null for services without one. */
  probe: (service: ServiceSpec) => Promise<Activity | null>;
  gpu: () => Promise<Gpu | null>;
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
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
  #config: Config;
  #holder: string | null = null;
  /** Target of the switch in progress, null for a plain stop. */
  #switching: string | null = null;
  /** Closed while a switch runs, so new requests queue on the lock instead of starting. */
  #gate = false;
  /** The holder was started by hand and has not idled out since. */
  #pinned = false;
  /** The home service was stopped by hand. */
  #homePaused = false;
  /** Set when cleanup after a failed start did not finish. Only a forced switch clears it. */
  #stuck: string | null = null;
  #closing = false;
  #since = 0;
  #inflight = new Map<string, number>();
  #lastRequest = new Map<string, number>();
  #waiting = new Map<string, number>();
  #events: AgentEvent[] = [];
  #lock = new Lock();
  #runners = new Map<string, Runner>();

  constructor(
    config: Config,
    private deps: AgentDeps,
  ) {
    this.#config = config;
    for (const service of config.services) {
      for (const proc of service.procs) {
        if (!this.#runners.has(proc.key)) this.#runners.set(proc.key, deps.runner({ ...proc, readyTimeout: service.readyTimeout }));
      }
    }
  }

  get config() {
    return this.#config;
  }

  get holder() {
    return this.#holder;
  }

  service(name: string): ServiceSpec {
    const service = this.#config.services.find((s) => s.name === name);
    if (!service) throw new RangeError(`unknown service ${name}`);
    return service;
  }

  /**
   * Adopts the service whose processes are exactly the ones running. Starts
   * home when nothing or only part of home runs. Anything else, like two
   * services at once, throws: the agent will not guess which work is safe to
   * stop.
   */
  init() {
    return this.#lock.run(async () => {
      const all = [...this.#runners.values()];
      const states = await Promise.all(all.map((r) => r.active()));
      const running = new Set(all.filter((_, i) => states[i]).map((r) => r.key));
      const keysOf = (s: ServiceSpec) => new Set(s.procs.map((p) => p.key));

      for (const s of this.#config.services) {
        const keys = keysOf(s);
        if (running.size > 0 && keys.size === running.size && [...running].every((k) => keys.has(k))) {
          this.#holder = s.name;
          this.#since = this.deps.now();
          this.#event("start", `found ${s.name} running`);
          return;
        }
      }
      const home = this.#config.home;
      const homeKeys = home ? keysOf(this.service(home)) : new Set<string>();
      if (home && [...running].every((k) => homeKeys.has(k))) return this.#switch(home, true);
      if (running.size === 0) return;
      throw new Error(`unclear GPU state, running: ${[...running].join(", ")}. Stop the extra processes by hand.`);
    });
  }

  /**
   * Gives the card to `name` by hand. Priority does not apply, but a busy
   * holder needs `force`. An on_demand service started this way keeps the
   * card against higher-ranked requests until it idles out once.
   */
  start(name: string, force = false) {
    const target = this.service(name);
    return this.#lock.run(async () => {
      await this.#switch(name, force);
      this.#pinned = target.run === "on_demand";
      if (name === this.#config.home) this.#homePaused = false;
    });
  }

  /**
   * Stops `name` by hand if it holds the card. Stopping home keeps it off
   * until started again or another service idles out.
   */
  stop(name: string, force = false) {
    this.service(name);
    return this.#lock.run(async () => {
      if (this.#holder !== name) return;
      await this.#switch(null, force);
      this.#homePaused = name === this.#config.home;
    });
  }

  /**
   * Called on a timer. Stops an on_demand holder that idled out and brings
   * home back to a free card.
   */
  tick() {
    return this.#lock.run(async () => {
      if (this.#closing || (this.#holder === null && this.#stuck)) return;
      const snap = await this.#snapshot();
      const plan = planTick(snap);
      if (plan.act === "start") {
        await this.#switch(plan.name, true).catch((err: Error) => this.deps.log(`home: ${err.message}`));
      } else if (plan.act === "release") {
        const holder = snap.services.find((v) => v.name === snap.holder);
        this.#event("idle", `${snap.holder} idle ${Math.round((snap.now - (holder?.lastActive ?? snap.now)) / 1000)}s`);
        await this.#switch(plan.then, false)
          .then(() => {
            this.#pinned = false;
            if (plan.then !== null) this.#homePaused = false;
          })
          .catch((err: Error) => this.deps.log(`idle stop: ${err.message}`));
      }
    });
  }

  /**
   * Gets the card for one proxied request to `name` and counts it in flight
   * until the returned release runs. Waits up to the service's `wait` while a
   * lower-ranked holder finishes its work; throws RefusedError when the card
   * is not to be had. An aborted `signal` (the client left) ends the wait
   * and throws its reason instead of switching for nobody.
   */
  async acquire(name: string, signal?: AbortSignal): Promise<() => void> {
    const spec = this.service(name);
    const deadline = this.deps.now() + spec.wait;
    let waiting = false;
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (this.#holder === name && !this.#gate && !this.#waiterAbove(name)) return this.#begin(name);
        const plan = await this.#lock.run(async () => {
          if (this.#closing) throw new RefusedError("the agent is shutting down");
          if (this.#stuck) throw new RefusedError(this.#stuck);
          const p = planRequest(await this.#snapshot(), name);
          if (p.act === "use") return { release: this.#begin(name) };
          if (p.act !== "switch") return p;
          signal?.throwIfAborted();
          this.#event("wake", `request for ${name}`);
          try {
            await this.#switch(name, false);
          } catch (err) {
            // Work arrived at the holder since the snapshot: wait like any busy holder.
            if (err instanceof BusyError) return { act: "wait" as const, on: err.service };
            throw err;
          }
          this.#pinned = false;
          return { release: this.#begin(name) };
        });
        if ("release" in plan) return plan.release;
        if (plan.act === "refuse") throw new RefusedError(plan.reason, plan.retryAfter);
        if (this.deps.now() >= deadline) throw new RefusedError(`gave up waiting for ${plan.on}`, 30);
        if (!waiting) {
          waiting = true;
          this.#waiting.set(name, (this.#waiting.get(name) ?? 0) + 1);
        }
        await this.deps.sleep(1_000);
      }
    } finally {
      if (waiting) this.#waiting.set(name, (this.#waiting.get(name) ?? 1) - 1);
    }
  }

  async state(): Promise<State> {
    const holder = this.#holder;
    const act = holder ? await this.#activity(holder) : null;
    const remind = holder ? this.service(holder).remind : 0;
    const lastActive = act?.lastActive ?? this.#since;
    return {
      holder,
      switching: this.#switching,
      home: this.#config.home,
      homePaused: this.#homePaused,
      pinned: this.#pinned,
      since: this.#since,
      busy: act?.busy ?? false,
      risks: act?.risks ?? (this.#stuck ? [this.#stuck] : []),
      lastActive,
      reminderDue: remind > 0 && !act?.busy && this.deps.now() - lastActive >= remind,
      services: this.#config.services.map((s) => ({
        name: s.name,
        plugin: s.plugin.name,
        run: s.run,
        idle: s.idle,
        proxy: s.proxy ?? null,
        models: s.models,
      })),
      warnings: this.#config.warnings,
      gpu: await this.deps.gpu(),
      events: this.#events.slice(-20).reverse(),
    };
  }

  /**
   * Stops processes the agent spawned itself; units and containers keep
   * running. Command processes are children of the agent and cannot outlive
   * it, so anything that must survive an agent restart belongs in a unit or
   * container. This runs on a normal stop. If the agent crashes, its
   * supervisor has to kill the rest: the example unit uses
   * KillMode=control-group.
   */
  shutdown() {
    // Queue behind a switch in progress, so a command it is starting cannot
    // outlive the agent. Switches queued after this one refuse to run.
    this.#closing = true;
    return this.#lock.run(async () => {
      const holder = this.#holder;
      if (holder) {
        const { risks } = await this.#activity(holder);
        if (risks.length > 0) this.deps.log(`shutdown stops ${holder} command processes despite: ${risks.join("; ")}`);
      }
      await Promise.all(
        [...this.#runners.values()].filter((r) => r.key.startsWith("cmd:")).map((r) => r.stop().catch(() => {})),
      );
    });
  }

  #runnersOf(name: string) {
    return this.service(name).procs.map((p) => this.#runners.get(p.key) as Runner);
  }

  #waiterAbove(name: string) {
    const rank = this.#config.services.findIndex((s) => s.name === name);
    return this.#config.services.slice(0, rank).some((s) => (this.#waiting.get(s.name) ?? 0) > 0);
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

  async #snapshot(): Promise<Snapshot> {
    const holder = this.#holder;
    const act = holder ? await this.#activity(holder) : null;
    return {
      now: this.deps.now(),
      holder,
      pinned: this.#pinned,
      homePaused: this.#homePaused,
      waiting: new Set([...this.#waiting].filter(([, n]) => n > 0).map(([name]) => name)),
      services: this.#config.services.map((s) => ({
        name: s.name,
        run: s.run,
        idle: s.idle,
        ...(s.name === holder && act ? act : { busy: false, risks: [], lastActive: 0 }),
      })),
    };
  }

  async #activity(name: string): Promise<Activity> {
    const spec = this.service(name);
    const now = this.deps.now();
    const act: Activity = {
      busy: false,
      risks: [],
      lastActive: Math.max(this.#since, this.#lastRequest.get(name) ?? 0),
    };
    const inflight = this.#inflight.get(name) ?? 0;
    if (inflight > 0) mergeActivity(act, { busy: true, risks: [`${inflight} request(s) in flight`], lastActive: now });
    const probed = await this.deps.probe(spec);
    if (probed) mergeActivity(act, probed);
    if (spec.gpuGuard > 0) {
      const gpu = await this.deps.gpu();
      if (!gpu) {
        mergeActivity(act, { busy: false, risks: ["GPU reading unavailable"], lastActive: now });
      } else if (gpu.util >= spec.gpuGuard) {
        mergeActivity(act, { busy: true, risks: [`GPU at ${gpu.util}%`], lastActive: now });
      }
    }
    return act;
  }

  /** Stops the holder and starts `target`, or only stops for null. Must run inside the lock. */
  async #switch(target: string | null, force: boolean) {
    if (this.#closing) throw new Error("agent is shutting down");
    const from = this.#holder;
    if (from === target) return;
    if (this.#stuck && !force) throw new BusyError("unknown", [this.#stuck]);
    const what = target ? `${from ?? "none"} → ${target}` : `stop ${from}`;
    const forced = force && from !== null ? " (forced)" : "";

    this.#gate = true;
    this.#switching = target;
    try {
      if (from !== null && !force) {
        const act = await this.#activity(from);
        // A request may have begun before the gate closed; read the count again.
        const inflight = this.#inflight.get(from) ?? 0;
        const risks = act.risks.length > 0 || inflight === 0 ? act.risks : [`${inflight} request(s) in flight`];
        if (risks.length > 0) {
          this.#event("refuse", `${what}: ${risks.join("; ")}`);
          throw new BusyError(from, risks);
        }
      }

      const next = target ? this.#runnersOf(target) : [];
      const keep = new Set(next.map((r) => r.key));
      try {
        // If a stop fails, the holder stays, so recovery never starts home on
        // top of whatever still runs. With no holder, whatever runs is a
        // leftover of a failed switch; stop it before starting the target.
        const old = from !== null ? this.#runnersOf(from).reverse() : [...this.#runners.values()];
        for (const r of old) {
          if (keep.has(r.key)) continue;
          if (from !== null || (await r.active())) await r.stop();
        }
      } catch (err) {
        this.#event("fail", `stopping ${from}: ${(err as Error).message}`);
        throw err;
      }

      this.#holder = null;
      if (target === null) {
        this.#event("stop", `${from}${forced}`);
        return;
      }
      try {
        const spec = this.service(target);
        for (const r of next) await r.start();
        const alive = async () => (await Promise.all(next.map((r) => r.active()))).every(Boolean);
        await waitHealthy(target, spec.health, spec.readyTimeout, alive);
        this.#holder = target;
        this.#stuck = null;
        this.#since = this.deps.now();
        this.#event("start", `${from ?? "none"} → ${target}${forced}`);
      } catch (err) {
        this.#event("fail", `${from ?? "none"} → ${target}: ${(err as Error).message}`);
        const leftovers: string[] = [];
        for (const r of [...next].reverse()) {
          await r.stop().catch((stopErr: Error) => leftovers.push(`${r.name}: ${stopErr.message}`));
        }
        // Something may still hold the GPU. Starting home on top of it could
        // run two services at once, so wait for a person to force the next switch.
        if (leftovers.length > 0) {
          this.#stuck = `cleanup after failed ${target} start did not finish (${leftovers.join("; ")})`;
          this.#event("fail", this.#stuck);
        }
        throw err;
      }
    } finally {
      this.#gate = false;
      this.#switching = null;
    }
  }

  #event(kind: AgentEvent["kind"], text: string) {
    this.#events.push({ at: this.deps.now(), kind, text });
    if (this.#events.length > 100) this.#events.shift();
    this.deps.log(`${kind}: ${text}`);
  }
}
