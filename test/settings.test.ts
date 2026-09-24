import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import type { Found } from "../src/discover.ts";
import { Pairing } from "../src/pairing.ts";
import type { Runner } from "../src/runners.ts";
import {
  ConfigStore,
  addUser,
  edit,
  proposeService,
  reload,
  removeUser,
  serviceName,
  settingsRoute,
  settingsView,
  updateService,
} from "../src/settings.ts";

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
    gpuProcesses: async () => [],
    host: "gpu-host",
    now: () => now,
    sleep: async () => {},
    log: () => {},
  });
  await agent.init();
  const deps = {
    store,
    hostHas: async (p: { unit?: string }) => p.unit !== "missing",
    discover: async () => ({ found: [], unmanaged: [] }),
    portFree: async (port: number) => port !== 18080,
    pairing: new Pairing(),
  };
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
  const added = await add({ name: "comfy", plugin: "comfyui", unit: "comfyui.service", proxy: 18080 });
  assert.equal(added.status, 200);
  assert.deepEqual(names(t), ["jupyter", "llm", "comfy", "voice"]);
  assert.equal(t.agent.service("comfy").url, "http://127.0.0.1:8188");
  assert.equal(t.agent.service("comfy").proxy, 18081, "18080 was busy on the host");
});

test("a changed start setting reaches the runner, and listen needs a restart", async () => {
  const t = await setup();
  await edit(t.agent, t.store, (source) => void (source.services[1]!.ready_timeout = "5m"));
  assert.deepEqual(
    t.made.filter((m) => m.key === "unit:bonsai.service").map((m) => m.readyTimeout),
    [120_000, 300_000],
  );
  await assert.rejects(edit(t.agent, t.store, (source) => void (source.listen = "0.0.0.0:7340")), /only with a restart/);
});

test("users are added once, and the last one stays", async () => {
  const t = await setup();
  await edit(t.agent, t.store, (source) => addUser(source, 42));
  await edit(t.agent, t.store, (source) => addUser(source, 42));
  assert.deepEqual(t.agent.config.users, [42]);
  await assert.rejects(edit(t.agent, t.store, (source) => removeUser(source, 42)), /last user/);
  await edit(t.agent, t.store, (source) => void (source.telegram = { users: [42, 42] }));
  await assert.rejects(edit(t.agent, t.store, (source) => removeUser(source, 42)), /last user/, "a duplicate is not a second user");
});

test("a discovered service gets a valid free name, its URL and a free proxy port", () => {
  const taken = new Set(["ollama", "comfyui", "comfyui-2"]);
  assert.equal(serviceName("ollama.service", taken), "ollama-2");
  assert.equal(serviceName("ComfyUI", taken), "comfyui-3");
  assert.equal(serviceName("_My.Stack@gpu0", taken), "my-stack-gpu0");
  assert.equal(serviceName("x".repeat(40), new Set(["x".repeat(32)])), `${"x".repeat(30)}-2`);

  const view = settingsView(
    parseConfig(`listen: 0.0.0.0:21434
services:
  - { name: ollama, plugin: ollama, unit: ollama.service }
  - { name: comfyui, plugin: comfyui, container: comfyui, proxy: 18188 }
`),
  );
  const found = (over: Partial<Found>): Found => ({ owner: { kind: "unit", name: "x" }, plugin: null, active: true, usedMiB: 0, ports: [], ...over });
  // Plugin port 11434 plus 10000 is the agent's own port, so the next one.
  assert.deepEqual(proposeService(found({ owner: { kind: "unit", name: "ollama-b.service" }, plugin: "ollama", ports: [11434, 39417] }), view), {
    name: "ollama-b",
    plugin: "ollama",
    unit: "ollama-b.service",
    url: "http://127.0.0.1:11434",
    proxy: 21435,
  });
  // Published on 8188 and 8189, from the plugin's port; 18188 is taken by the other ComfyUI.
  const comfy = found({ owner: { kind: "container", name: "comfy2" }, plugin: "comfyui", ports: [8189, 8188] });
  assert.deepEqual(proposeService(comfy, view), {
    name: "comfy2",
    plugin: "comfyui",
    container: "comfy2",
    url: "http://127.0.0.1:8188",
    proxy: 18189,
  });
  // Seen only on another port than the plugin's.
  assert.equal(proposeService({ ...comfy, ports: [9000] }, view).url, "http://127.0.0.1:9000");
  // No plugin, not listening: nothing to point a URL at.
  assert.deepEqual(proposeService(found({ owner: { kind: "unit", name: "train.service" } }), view), {
    name: "train",
    plugin: "custom",
    unit: "train.service",
  });
  // A stopped service's own port is not free for a proxy, and ports past 65535 wrap.
  const stopped = settingsView(parseConfig(`services:\n  - { name: a, plugin: custom, unit: a, url: "http://127.0.0.1:20000" }`));
  assert.equal(proposeService(found({ plugin: "custom", ports: [10000] }), stopped).proxy, 20001);
  assert.equal(proposeService(found({ plugin: "custom", ports: [60000] }), stopped).proxy, 5488);
  // Wyoming speaks raw TCP, which the HTTP proxy can't carry.
  assert.equal("proxy" in proposeService(found({ plugin: "wyoming" }), view), false);
});
