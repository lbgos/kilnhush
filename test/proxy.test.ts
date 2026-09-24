// Runs the real agent and per-service proxies against the fakes. Only process
// management is stubbed: services start in-process servers.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { connect } from "node:net";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "../src/agent.ts";
import { parseConfig } from "../src/config.ts";
import { fakeComfy, fakeLlama } from "../src/fake.ts";
import { probeService } from "../src/plugins/index.ts";
import { proxyPool } from "../src/proxy.ts";
import type { Runner } from "../src/runners.ts";

// comfy ranks above llm, so a comfy that holds the card refuses llm requests.
const configText = `
services:
  - { name: comfy, plugin: comfyui, url: "http://127.0.0.1:29188", proxy: 29189, cmd: [comfy] }
  - { name: llm, plugin: llamacpp, url: "http://127.0.0.1:29080", proxy: 29081, cmd: [llama] }
  - { name: voice, run: always, cmd: [voice] }
`;
const config = parseConfig(configText);
const comfy = "http://127.0.0.1:29189";
const llm = "http://127.0.0.1:29081";

const servers = new Map<string, Server>();
const startMs = { comfy: 0, llama: 0 };
const runner = (spec: { key: string; name: string }): Runner => ({
  key: spec.key,
  name: spec.name,
  active: async () => spec.name === "voice" || servers.has(spec.name),
  async start() {
    if (spec.name === "comfy") {
      await sleep(startMs.comfy);
      servers.set("comfy", await fakeComfy(29188));
    }
    if (spec.name === "llama") {
      await sleep(startMs.llama);
      servers.set("llama", await fakeLlama(29080, { replyMs: 50 }));
    }
  },
  async stop() {
    servers.get(spec.name)?.close();
    servers.delete(spec.name);
  },
});

const agent = new Agent(config, { runner, probe: probeService, gpu: async () => null, gpuProcesses: async () => [], host: "gpu-host", now: Date.now, sleep, log: () => {} });
await agent.init();
const proxies = proxyPool(agent, "127.0.0.1", () => {});
await Promise.all(proxies.servers().map((s) => once(s, "listening")));

after(async () => {
  for (const s of servers.values()) s.close();
  await proxies.close();
});

test("a passive request to a stopped service gets 503 and wakes nothing", async () => {
  const res = await fetch(`${llm}/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "llm is not running" });
  assert.equal(agent.holder, "voice");
});

test("a work request wakes llm through its own port and streams", async () => {
  const res = await fetch(`${llm}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ stream: true }) });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  assert.match(text, /"content":"hello "/);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(agent.holder, "llm");
});

test("a cached route replays its last answer after the service stops", async () => {
  const live = await (await fetch(`${llm}/v1/models`)).text();
  await fetch(`${llm}/v1/models?private`, { headers: { authorization: "Bearer secret" } });
  await agent.stop("llm");
  const hidden = await fetch(`${llm}/v1/models?private`, { headers: { authorization: "Bearer secret" } });
  assert.equal(hidden.status, 503, "answers behind credentials are not replayed and wake nothing");
  const replay = await fetch(`${llm}/v1/models`);
  assert.equal(replay.headers.get("x-kilnhush-cache"), "hit");
  assert.equal(replay.headers.get("content-type"), "application/json");
  assert.equal(await replay.text(), live);
  assert.equal(agent.holder, null);
});

test("a first public read with nothing to replay wakes the service once", async () => {
  const first = await fetch(`${llm}/v1/models?fresh`);
  assert.equal(first.status, 200);
  await first.text();
  assert.equal(agent.holder, "llm");
  await agent.stop("llm");
  assert.equal((await fetch(`${llm}/v1/models?fresh`)).headers.get("x-kilnhush-cache"), "hit");
  assert.equal(agent.holder, null);
});

test("a page load wakes comfy without staying in flight, and a poll during the wake waits for it", async () => {
  startMs.comfy = 200;
  const page = fetch(`${comfy}/`, { headers: { accept: "text/html" } });
  await sleep(50);
  const poll = fetch(`${comfy}/queue`);
  const res = await page;
  // The fake sends the rest of the page 200 ms after the headers.
  const state = await agent.state();
  assert.deepEqual([state.holder, state.busy, state.risks], ["comfy", false, []]);
  assert.match(await res.text(), /fake/);
  assert.equal((await poll).status, 200);
});

test("a request refused by priority gets 503 with Retry-After", async () => {
  const res = await fetch(`${llm}/v1/chat/completions`, { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal(agent.holder, "comfy");
});

test("a WebSocket passes through while comfy runs, closes when it stops, and never wakes it", async () => {
  const ws = new WebSocket(`${comfy.replace("http", "ws")}/ws`);
  const message = await new Promise<string>((resolve, reject) => {
    ws.addEventListener("message", (e) => resolve(String(e.data)));
    ws.addEventListener("error", () => reject(new Error("WebSocket failed")));
  });
  assert.match(message, /"type":"status"/);
  const closed = new Promise((resolve) => ws.addEventListener("close", resolve));
  await agent.stop("comfy");
  await closed;

  const refused = new WebSocket(`${comfy.replace("http", "ws")}/ws`);
  await new Promise((resolve) => refused.addEventListener("error", resolve));
  assert.equal(agent.holder, null);
});

test("a client that leaves while llm starts does not leak an in-flight request", async () => {
  startMs.llama = 300;
  await assert.rejects(fetch(`${llm}/v1/chat/completions`, { method: "POST", body: "{}", signal: AbortSignal.timeout(50) }));
  await sleep(500);
  const state = await agent.state();
  assert.deepEqual([state.holder, state.busy, state.risks], ["llm", false, []]);
});

test("a proxy port moved in settings listens at once, the old one closes", async () => {
  await agent.reconfigure(() => parseConfig(configText.replace("proxy: 29081", "proxy: 29082")));
  await Promise.all(proxies.servers().map((s) => (s.listening ? null : once(s, "listening"))));
  assert.equal((await fetch("http://127.0.0.1:29082/health")).status, 200);
  // A fresh connection: fetch would reuse its kept-alive socket to the old port.
  const old = connect(29081, "127.0.0.1");
  await assert.rejects(once(old, "connect"), /ECONNREFUSED/);
});
