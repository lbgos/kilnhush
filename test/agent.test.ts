import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, BusyError, RefusedError } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import type { Activity } from "../src/probe.ts";
import type { Runner } from "../src/runners.ts";

// Priority order: jupyter, llm, comfy, voice.
const config = parseConfig(`
services:
  - { name: jupyter, run: manual, remind: 3h, unit: jupyter }
  - { name: llm, unit: bonsai, idle: 20m, wait: 5s }
  - { name: comfy, unit: comfy, idle: 30m }
  - name: voice
    run: always
    group: [{ unit: whisper }, { unit: kokoro }]
`);

function setup({ running = [] as string[], failStart = "", failStop = [] as string[], cfg = config, startMs = 0 } = {}) {
  let now = 1_000_000;
  const active = new Set(running);
  const probes = new Map<string, Activity>();
  const log: string[] = [];
  const runner = (spec: { key: string; name: string }): Runner => ({
    key: spec.key,
    name: spec.name,
    active: async () => active.has(spec.name),
    start: async () => {
      if (spec.name === failStart) throw new Error(`${spec.name} failed`);
      if (active.has(spec.name)) return; // like systemctl start on an active unit
      await new Promise((resolve) => setTimeout(resolve, startMs));
      active.add(spec.name);
      log.push(`start ${spec.name}`);
    },
    stop: async () => {
      if (failStop.includes(spec.name)) throw new Error(`${spec.name} would not stop`);
      active.delete(spec.name);
      log.push(`stop ${spec.name}`);
    },
  });
  const advance = (ms: number) => (now += ms);
  const agent = new Agent(cfg, {
    runner,
    probe: async (s) => structuredClone(probes.get(s.name) ?? null),
    gpu: async () => null,
    gpuProcesses: async () => [],
    host: "gpu-host",
    now: () => now,
    // Waiting requests poll once a second; let fake time pass instead.
    sleep: async (ms) => {
      advance(ms);
      await new Promise((resolve) => setImmediate(resolve));
    },
    log: () => {},
  });
  const busy = (name: string, risk: string) => probes.set(name, { busy: true, risks: [risk], lastActive: now });
  const quiet = (name: string) => probes.delete(name);
  return { agent, active, log, busy, quiet, advance, now: () => now };
}

test("init adopts a running service instead of starting home", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  assert.equal(t.agent.holder, "jupyter");
  assert.deepEqual(t.log, []);
});

test("init starts home when nothing runs, and completes a half-running home", async () => {
  const t = setup();
  await t.agent.init();
  assert.equal(t.agent.holder, "voice");
  assert.deepEqual(t.log, ["start whisper", "start kokoro"]);

  const half = setup({ running: ["whisper"] });
  await half.agent.init();
  assert.equal(half.agent.holder, "voice");
  assert.deepEqual(half.log, ["start kokoro"]);
});

test("init refuses to guess when two services run at once", async () => {
  const t = setup({ running: ["jupyter", "bonsai"] });
  await assert.rejects(t.agent.init(), /unclear GPU state/);
  assert.deepEqual(t.log, [], "nothing was stopped or started");
});

test("a start by hand stops the holder in reverse order first", async () => {
  const t = setup();
  await t.agent.init();
  t.log.length = 0;
  await t.agent.start("jupyter");
  assert.deepEqual(t.log, ["stop kokoro", "stop whisper", "start jupyter"]);
});

test("a busy Jupyter refuses to stop until forced, then home comes back", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  t.busy("jupyter", "train.ipynb: cell running");

  await assert.rejects(t.agent.stop("jupyter"), (err) => err instanceof BusyError && err.risks[0] === "train.ipynb: cell running");
  await assert.rejects(t.agent.start("voice"), BusyError);
  assert.ok(t.active.has("jupyter"));

  await t.agent.stop("jupyter", true);
  assert.equal(t.agent.holder, null);
  await t.agent.tick();
  assert.equal(t.agent.holder, "voice");
});

test("jupyter never stops on a timer, it only flags a reminder", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  t.advance(4 * 3_600_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "jupyter");
  assert.equal((await t.agent.state()).reminderDue, true);
});

test("a request wakes llm from home, and idle time brings home back", async () => {
  const t = setup();
  await t.agent.init();
  const release = await t.agent.acquire("llm");
  assert.equal(t.agent.holder, "llm");

  t.advance(30 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "llm", "a request in flight is never idle");

  release();
  t.advance(19 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "llm");
  t.advance(2 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "voice");
});

test("requests cannot take the card from jupyter or from a higher-ranked service", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  await assert.rejects(t.agent.acquire("llm"), (err) => err instanceof RefusedError && err.retryAfter === undefined);

  const u = setup({ running: ["bonsai"] });
  await u.agent.init();
  u.advance(5 * 60_000);
  await assert.rejects(
    u.agent.acquire("comfy"),
    (err) => err instanceof RefusedError && err.message === "llm ranks above comfy" && err.retryAfter === 15 * 60,
  );
  assert.equal(u.agent.holder, "llm");
});

test("a higher request waits for a busy lower holder, then takes the card", async () => {
  const t = setup({ running: ["comfy"] });
  await t.agent.init();
  t.busy("comfy", "1 prompt(s) queued or running");
  const waiting = t.agent.acquire("llm");
  await new Promise((resolve) => setImmediate(resolve));
  t.quiet("comfy");
  const release = await waiting;
  assert.equal(t.agent.holder, "llm");
  release();
});

test("a request gives up after its wait while the lower holder stays busy", async () => {
  const t = setup({ running: ["comfy"] });
  await t.agent.init();
  t.busy("comfy", "1 prompt(s) queued or running");
  await assert.rejects(t.agent.acquire("llm"), /gave up waiting for comfy/);
  assert.equal(t.agent.holder, "comfy", "busy work was never stopped");
});

test("while a higher service waits, new requests for the holder queue behind it", async () => {
  const t = setup({ running: ["comfy"] });
  await t.agent.init();
  const first = await t.agent.acquire("comfy");
  const llm = t.agent.acquire("llm");
  await new Promise((resolve) => setImmediate(resolve));
  // comfy is draining: a second comfy request must not keep it busy forever.
  const second = t.agent.acquire("comfy");
  first();
  await llm;
  assert.equal(t.agent.holder, "llm");
  await assert.rejects(second, /llm ranks above comfy/);
});

test("a service started by hand keeps the card against higher requests until it idles out", async () => {
  const t = setup();
  await t.agent.init();
  await t.agent.start("comfy");
  await assert.rejects(t.agent.acquire("llm"), /comfy was started by hand/);
  t.advance(31 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "voice");
  await t.agent.acquire("llm");
  assert.equal(t.agent.holder, "llm");
});

test("stopping home by hand keeps it off until started again", async () => {
  const t = setup();
  await t.agent.init();
  await t.agent.stop("voice");
  await t.agent.tick();
  assert.equal(t.agent.holder, null);
  assert.equal((await t.agent.state()).homePaused, true);
  await t.agent.start("voice");
  assert.equal(t.agent.holder, "voice");
});

test("a failed start cleans up and the next tick restores home", async () => {
  const t = setup({ failStart: "bonsai" });
  await t.agent.init();
  await assert.rejects(t.agent.start("llm"), /bonsai failed/);
  assert.equal(t.agent.holder, null);
  await t.agent.tick();
  assert.equal(t.agent.holder, "voice");
  assert.deepEqual(
    (await t.agent.state()).events.map((e) => e.kind),
    ["start", "fail", "start"],
  );
});

test("a failed stop keeps the holder, so recovery does not start home on top of it", async () => {
  const t = setup({ running: ["bonsai"], failStop: ["bonsai"] });
  await t.agent.init();
  await assert.rejects(t.agent.start("voice"), /would not stop/);
  assert.equal(t.agent.holder, "llm");
  await t.agent.tick();
  assert.ok(!t.active.has("whisper"));
});

test("gpu_guard without a GPU reading blocks the stop", async () => {
  const cfg = parseConfig(`services:\n  - { name: train, run: manual, gpu_guard: 20, unit: trainer }\n  - { name: voice, run: always, unit: whisper }`);
  const t = setup({ running: ["trainer"], cfg });
  await t.agent.init();
  await assert.rejects(t.agent.stop("train"), (err) => err instanceof BusyError && err.risks[0] === "GPU reading unavailable");
});

test("if cleanup after a failed start fails, nothing restarts until a forced start", async () => {
  const cfg = parseConfig(`
services:
  - { name: llm, idle: 20m, group: [{ unit: bonsai }, { unit: broken }] }
  - { name: voice, run: always, unit: whisper }
`);
  const failStop = ["bonsai"];
  const t = setup({ cfg, failStart: "broken", failStop });
  await t.agent.init();
  await assert.rejects(t.agent.start("llm"), /broken failed/);
  assert.ok(t.active.has("bonsai"), "bonsai still holds the GPU");

  await t.agent.tick();
  assert.ok(!t.active.has("whisper"), "no automatic recovery on top of it");
  await assert.rejects(t.agent.acquire("llm"), RefusedError);
  await assert.rejects(t.agent.start("voice"), BusyError);
  assert.match((await t.agent.state()).risks[0] ?? "", /cleanup after failed llm start/);

  await assert.rejects(t.agent.start("voice", true), /bonsai would not stop/, "force still refuses to stack services");
  failStop.length = 0;
  await t.agent.start("voice", true);
  assert.equal(t.agent.holder, "voice");
  assert.ok(!t.active.has("bonsai"), "the leftover was stopped first");
  assert.deepEqual((await t.agent.state()).risks, []);
});

test("shutdown waits for a start in progress and stops what it started", async () => {
  const cfg = parseConfig(`services:\n  - { name: llm, cmd: [llm] }\n  - { name: voice, run: always, cmd: [voice] }`);
  const t = setup({ cfg, startMs: 50 });
  await t.agent.init();
  const starting = t.agent.start("llm");
  await new Promise((resolve) => setTimeout(resolve, 10)); // llm is mid-start
  await t.agent.shutdown();
  await starting;
  assert.deepEqual(t.log, ["start voice", "stop voice", "start llm", "stop llm", "stop voice"], "shutdown ran after the start finished");
  assert.ok(!t.active.has("llm"));
  await assert.rejects(t.agent.start("voice"), /shutting down/);
});

test("home stopped by hand comes back once a woken service idles out", async () => {
  const t = setup();
  await t.agent.init();
  await t.agent.stop("voice");
  (await t.agent.acquire("llm"))();
  t.advance(21 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "voice");
  assert.equal((await t.agent.state()).homePaused, false);
});

test("a request whose client left stops waiting and switches nothing", async () => {
  const t = setup({ running: ["comfy"] });
  await t.agent.init();
  t.busy("comfy", "1 prompt(s) queued or running");
  const left = new AbortController();
  const waiting = t.agent.acquire("llm", left.signal);
  await new Promise((resolve) => setImmediate(resolve));
  left.abort(new Error("client left"));
  t.quiet("comfy");
  await assert.rejects(waiting, /client left/);
  assert.equal(t.agent.holder, "comfy");
});
