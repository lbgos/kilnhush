// Runs the real agent, server, proxy and Jupyter probe against the fakes.
// Only process management is stubbed: services start in-process servers.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "../src/agent.ts";
import { agentClient, overHttp } from "../src/api.ts";
import { parseConfig } from "../src/config.ts";
import { fakeJupyter, fakeLlama } from "../src/fake.ts";
import { probeService } from "../src/plugins/index.ts";
import { createAgentServer } from "../src/server.ts";
import type { Runner } from "../src/runners.ts";

const llamaPort = 28080;
const jupyterPort = 28888;
const config = parseConfig(`
services:
  - { name: jupyter, plugin: jupyter, url: "http://127.0.0.1:${jupyterPort}", cmd: [jupyter] }
  - { name: llm, url: "http://127.0.0.1:${llamaPort}", models: [bonsai], cmd: [llama] }
  - { name: voice, run: always, cmd: [voice] }
`);

const servers = new Map<string, Server>();
let llamaStartMs = 0;
const runner = (spec: { key: string; name: string }): Runner => ({
  key: spec.key,
  name: spec.name,
  active: async () => spec.name === "voice" || servers.has(spec.name),
  async start() {
    if (spec.name === "llama") await sleep(llamaStartMs);
    if (spec.name === "llama") servers.set("llama", await fakeLlama(llamaPort, { replyMs: 50 }));
    if (spec.name === "jupyter") servers.set("jupyter", await fakeJupyter(jupyterPort));
  },
  async stop() {
    servers.get(spec.name)?.close();
    servers.delete(spec.name);
  },
});

const agent = new Agent(config, {
  runner,
  probe: probeService,
  gpu: async () => null,
  gpuProcesses: async () => [],
  host: "gpu-host",
  now: Date.now,
  sleep,
  log: () => {},
});
await agent.init();
const server = createAgentServer(agent, "secret").listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const client = agentClient(overHttp(base, "secret"));

after(() => {
  server.close();
  for (const s of servers.values()) s.close();
});

const chat = (stream = false) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bonsai", stream, messages: [{ role: "user", content: "hi" }] }),
  });

test("the API wants the token", async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await client.state()).holder, "voice");
});

test("/v1/models lists configured models without waking anything", async () => {
  const res = (await (await fetch(`${base}/v1/models`)).json()) as { data: { id: string }[] };
  assert.deepEqual(
    res.data.map((m) => m.id),
    ["bonsai"],
  );
  assert.equal(agent.holder, "voice");
});

test("a chat request wakes llm and streams through the proxy", async () => {
  const res = await chat(true);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /"content":"llama-server "/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(agent.holder, "llm");
});

test("jupyter with a busy kernel refuses, force stops it, chat gets 503 meanwhile", async () => {
  assert.equal((await client.start("jupyter")).ok, true);
  await fetch(`http://127.0.0.1:${jupyterPort}/demo?busy=1&tabs=1`, { method: "POST" });

  assert.equal((await chat()).status, 503);

  const refused = await client.start("voice");
  assert.ok(!refused.ok && "busy" in refused);
  assert.deepEqual(refused.busy.risks, [
    "train.ipynb: cell running",
    "train.ipynb: open in 1 browser tab(s), unsaved edits would be lost",
  ]);
  assert.equal(agent.holder, "jupyter");

  const forced = await client.start("voice", true);
  assert.ok(forced.ok);
  assert.equal(forced.state.holder, "voice");
  assert.equal(forced.state.events[0]?.text, "jupyter → voice (forced)");
});

test("a client that leaves while the model loads does not leak an in-flight request", async () => {
  llamaStartMs = 300;
  await assert.rejects(
    fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}", signal: AbortSignal.timeout(50) }),
  );
  await sleep(500);
  const state = await client.state();
  assert.equal(state.holder, "llm");
  assert.equal(state.busy, false);
  assert.deepEqual(state.risks, []);
});
