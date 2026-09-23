import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import type { Runner } from "../src/runners.ts";
import { ConfigStore, edit, reload, settingsRoute, updateService } from "../src/settings.ts";

const yaml = `services:
  - { name: jupyter, run: manual, unit: jupyter }
  - { name: llm, unit: bonsai, idle: 20m }
  - { name: voice, run: always, unit: whisper }
`;

async function setup(running: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "kilnhush-"));
  const path = join(dir, "kilnhush.yaml");
  await writeFile(path, yaml);
  const store = await ConfigStore.load(path);
  let now = 1_000_000;
  const active = new Set(running);
  const made: { key: string; readyTimeout: number }[] = [];
  const runner = (spec: { key: string; name: string; readyTimeout: number }): Runner => (made.push(spec), {
    key: spec.key,
    name: spec.name,
    active: async () => active.has(spec.name),
    start: async () => void active.add(spec.name),
    stop: async () => void active.delete(spec.name),
  });
  const agent = new Agent(store.config, {
    runner,
    probe: async () => null,
    gpu: async () => null,
    now: () => now,
    sleep: async () => {},
    log: () => {},
  });
  await agent.init();
  const deps = { store, hostHas: async (p: { unit?: string }) => p.unit !== "missing", discover: async () => ({ found: [], unmanaged: [] }), portFree: async (port: number) => port !== 18080 };
  return { path, store, agent, deps, made, advance: (ms: number) => (now += ms) };
}

const names = (t: { agent: Agent }) => t.agent.config.services.map((s) => s.name);

test("an edit is validated, written with a .bak, and applied", async () => {
  const t = await setup();
  await edit(t.agent, t.store, (source) => source.services.reverse());
  assert.deepEqual(names(t), ["voice", "llm", "jupyter"]);
  assert.match(await readFile(t.path, "utf8"), /^# kilnhush config[^]*name: voice[^]*name: jupyter/);
  assert.equal(await readFile(`${t.path}.bak`, "utf8"), yaml);

  await assert.rejects(edit(t.agent, t.store, (source) => void (source.services[0]!.idle = "soon")), /duration/);
  assert.deepEqual(names(t), ["voice", "llm", "jupyter"], "a rejected edit changes nothing");
});

test("an edit goes through a symlink and keeps the file mode", async () => {
  const t = await setup();
  await chmod(t.path, 0o640);
  const link = join(dirname(t.path), "link.yaml");
  await symlink(t.path, link);
  const store = await ConfigStore.load(link);
  await edit(t.agent, store, (source) => source.services.reverse());
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.match(await readFile(t.path, "utf8"), /name: voice[^]*name: jupyter/);
  assert.equal((await stat(t.path)).mode & 0o777, 0o640);
});

test("a hand edit is never overwritten, reload picks it up", async () => {
  const t = await setup();
  const hand = yaml.replace("idle: 20m", "idle: 5m");
  await writeFile(t.path, hand);
  await assert.rejects(edit(t.agent, t.store, (source) => source.services.reverse()), /kilnhush reload/);
  assert.equal(await readFile(t.path, "utf8"), hand);

  await reload(t.agent, t.store);
  assert.equal(t.agent.service("llm").idle, 5 * 60_000);
  await edit(t.agent, t.store, (source) => source.services.reverse());
});

test("the holder cannot be removed or rerouted while it runs, but its settings can change", async () => {
  const t = await setup(["bonsai"]);
  assert.equal(t.agent.holder, "llm");
  await assert.rejects(edit(t.agent, t.store, (source) => void source.services.splice(1, 1)), /stop llm before removing it/);
  await assert.rejects(edit(t.agent, t.store, (source) => void (source.services[1]!.unit = "other")), /stop llm before changing how it runs/);

  // Back to on_demand restarts its idle clock instead of stopping it on the next tick.
  await edit(t.agent, t.store, (source, current) => updateService(source, current, "llm", { run: "manual" }));
  t.advance(10 * 60_000);
  await edit(t.agent, t.store, (source, current) => updateService(source, current, "llm", { run: "on_demand", idle: "1m" }));
  await t.agent.tick();
  assert.equal(t.agent.holder, "llm");
  t.advance(2 * 60_000);
  await t.agent.tick();
  assert.equal(t.agent.holder, "voice");
});

test("making a service the home demotes the old one and drops settings that stop applying", async () => {
  const t = await setup();
  await edit(t.agent, t.store, (source, current) => updateService(source, current, "jupyter", { run: "always" }));
  assert.equal(t.agent.config.home, "jupyter");
  assert.equal(t.agent.service("voice").run, "on_demand");
  await edit(t.agent, t.store, (source, current) => updateService(source, current, "llm", { run: "manual", remind: "2h" }));
  assert.equal(t.agent.service("llm").idle, 0);
  assert.equal(t.agent.service("llm").remind, 2 * 3_600_000);
});

test("the API adds only units and containers the host has, right above home", async () => {
  const t = await setup();
  const add = (body: object) => settingsRoute(t.agent, t.deps, "add", body);
  assert.equal((await add({ name: "sd", plugin: "comfyui", cmd: ["rm", "-rf", "/"] })).status, 400);
  assert.deepEqual((await add({ name: "sd", plugin: "comfyui", unit: "missing" })).body, { error: "this host has no missing" });
  assert.deepEqual((await add({ name: "comfy", plugin: "comfyui", unit: "comfyui.service", proxy: 18080 })).body, { error: "port 18080 is in use" });
  const added = await add({ name: "comfy", plugin: "comfyui", unit: "comfyui.service", proxy: 18188 });
  assert.equal(added.status, 200);
  assert.deepEqual(names(t), ["jupyter", "llm", "comfy", "voice"]);
  assert.equal(t.agent.service("comfy").url, "http://127.0.0.1:8188");
});

test("a changed start setting reaches the runner, and listen needs a restart", async () => {
  const t = await setup();
  await edit(t.agent, t.store, (source) => void (source.services[1]!.ready_timeout = "5m"));
  assert.deepEqual(
    t.made.filter((m) => m.key === "unit:bonsai").map((m) => m.readyTimeout),
    [120_000, 300_000],
  );
  await assert.rejects(edit(t.agent, t.store, (source) => void (source.listen = "0.0.0.0:7340")), /only with a restart/);
});
