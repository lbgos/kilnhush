import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, BusyError, HeldError } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import type { Activity } from "../src/probe.ts";
import type { Service } from "../src/services.ts";

const config = parseConfig(`
default: voice
modes:
  voice:
    services: [{ unit: whisper }, { unit: kokoro }]
  llm:
    idle: 20m
    proxy: { target: http://127.0.0.1:8080 }
    services: [{ unit: bonsai }]
  jupyter:
    remind: 3h
    jupyter: { url: http://127.0.0.1:8888 }
    services: [{ unit: jupyter }]
`);

function setup({ running = [] as string[], failStart = "", failStop = [] as string[], cfg = config } = {}) {
  let now = 1_000_000;
  const active = new Set(running);
  const jupyter: Activity = { busy: false, risks: [], lastActive: 0 };
  const log: string[] = [];
  const service = (spec: { key: string; name: string }): Service => ({
    key: spec.key,
    name: spec.name,
    active: async () => active.has(spec.name),
    start: async () => {
      if (spec.name === failStart) throw new Error(`${spec.name} failed`);
      if (active.has(spec.name)) return; // like systemctl start on an active unit
      active.add(spec.name);
      log.push(`start ${spec.name}`);
    },
    stop: async () => {
      if (failStop.includes(spec.name)) throw new Error(`${spec.name} would not stop`);
      active.delete(spec.name);
      log.push(`stop ${spec.name}`);
    },
  });
  const agent = new Agent(cfg, {
    service,
    jupyter: async () => structuredClone(jupyter),
    gpu: async () => null,
    now: () => now,
    log: () => {},
  });
  return { agent, active, jupyter, log, advance: (ms: number) => (now += ms), now: () => now };
}

test("init adopts a running non-default mode instead of starting voice", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  assert.equal(t.agent.current, "jupyter");
  assert.deepEqual(t.log, []);
});

test("init starts the default mode when nothing runs", async () => {
  const t = setup();
  await t.agent.init();
  assert.equal(t.agent.current, "voice");
  assert.deepEqual(t.log, ["start whisper", "start kokoro"]);
});

test("switch stops the old mode in reverse order, then starts the new one", async () => {
  const t = setup();
  await t.agent.init();
  t.log.length = 0;
  await t.agent.switch("jupyter");
  assert.deepEqual(t.log, ["stop kokoro", "stop whisper", "start jupyter"]);
});

test("a busy Jupyter refuses the switch until forced", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  t.jupyter.busy = true;
  t.jupyter.risks = ["train.ipynb: cell running"];

  await assert.rejects(t.agent.switch("voice"), (err) => err instanceof BusyError && err.risks[0] === "train.ipynb: cell running");
  assert.equal(t.agent.current, "jupyter");
  assert.ok(t.active.has("jupyter"));

  await t.agent.switch("voice", true);
  assert.equal(t.agent.current, "voice");
  assert.ok(!t.active.has("jupyter"));
});

test("jupyter never returns to voice on a timer, it only flags a reminder", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  t.jupyter.lastActive = t.now();
  t.advance(4 * 3_600_000);
  await t.agent.tick();
  assert.equal(t.agent.current, "jupyter");
  assert.equal((await t.agent.state()).reminderDue, true);
});

test("a proxied request wakes llm from voice, and idle time brings voice back", async () => {
  const t = setup();
  await t.agent.init();
  const release = await t.agent.acquire("llm");
  assert.equal(t.agent.current, "llm");

  t.advance(30 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.current, "llm", "a request in flight is never idle");

  release();
  t.advance(19 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.current, "llm");
  t.advance(2 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.current, "voice");
});

test("a proxied request cannot take the GPU from jupyter", async () => {
  const t = setup({ running: ["jupyter"] });
  await t.agent.init();
  await assert.rejects(t.agent.acquire("llm"), HeldError);
  assert.equal(t.agent.current, "jupyter");
});

test("a failed switch cleans up and the next tick restores voice", async () => {
  const t = setup({ failStart: "bonsai" });
  await t.agent.init();
  await assert.rejects(t.agent.switch("llm"), /bonsai failed/);
  assert.equal(t.agent.current, null);
  await t.agent.tick();
  assert.equal(t.agent.current, "voice");
  const state = await t.agent.state();
  assert.deepEqual(
    state.events.map((e) => e.kind),
    ["switch", "fail", "switch"],
  );
});

test("init refuses to guess when two modes run at once", async () => {
  const t = setup({ running: ["jupyter", "bonsai"] });
  await assert.rejects(t.agent.init(), /unclear GPU state/);
  assert.deepEqual(t.log, [], "nothing was stopped or started");
});

test("init completes a half-running default mode", async () => {
  const t = setup({ running: ["whisper"] });
  await t.agent.init();
  assert.equal(t.agent.current, "voice");
  assert.deepEqual(t.log, ["start kokoro"]);
});

test("a failed stop keeps the old mode, so recovery does not start voice on top of it", async () => {
  const t = setup({ running: ["bonsai"], failStop: ["bonsai"] });
  await t.agent.init();
  await assert.rejects(t.agent.switch("voice"), /would not stop/);
  assert.equal(t.agent.current, "llm");
  await t.agent.tick();
  assert.ok(!t.active.has("whisper"));
});

test("gpu_guard without a GPU reading blocks the switch", async () => {
  const cfg = parseConfig(`
default: voice
modes:
  voice: { services: [{ unit: whisper }] }
  train: { gpu_guard: 20, services: [{ unit: trainer }] }
`);
  const t = setup({ running: ["trainer"], cfg });
  await t.agent.init();
  await assert.rejects(t.agent.switch("voice"), (err) => err instanceof BusyError && err.risks[0] === "GPU reading unavailable");
});

test("if cleanup after a failed start fails, nothing restarts until a forced switch", async () => {
  const cfg = parseConfig(`
default: voice
modes:
  voice: { services: [{ unit: whisper }] }
  llm:
    idle: 20m
    proxy: { target: http://127.0.0.1:8080 }
    services: [{ unit: bonsai }, { unit: broken }]
`);
  const failStop = ["bonsai"];
  const t = setup({ cfg, failStart: "broken", failStop });
  await t.agent.init();
  await assert.rejects(t.agent.switch("llm"), /broken failed/);
  assert.ok(t.active.has("bonsai"), "bonsai still holds the GPU");

  await t.agent.tick();
  assert.ok(!t.active.has("whisper"), "no automatic recovery on top of it");
  await assert.rejects(t.agent.acquire("llm"), BusyError);
  await assert.rejects(t.agent.switch("voice"), BusyError);
  assert.match((await t.agent.state()).risks[0] ?? "", /cleanup after failed llm start/);

  await assert.rejects(t.agent.switch("voice", true), /bonsai would not stop/, "force still refuses to stack modes");
  failStop.length = 0;
  await t.agent.switch("voice", true);
  assert.equal(t.agent.current, "voice");
  assert.ok(!t.active.has("bonsai"), "the leftover was stopped first");
  assert.deepEqual((await t.agent.state()).risks, []);
});
