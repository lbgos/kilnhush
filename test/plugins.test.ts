import assert from "node:assert/strict";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { plugins } from "../src/plugins/index.ts";
import type { Plugin } from "../src/plugins/types.ts";

/** Runs a plugin's probe against a one-off fake server. */
async function probe(id: string, handle: (req: IncomingMessage, res: ServerResponse) => void, token?: string) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const act = await plugin(id).probe?.({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token });
    assert.ok(act, `${id} has no probe`);
    return act;
  } finally {
    server.close();
  }
}

function plugin(id: string): Plugin {
  const p = plugins.get(id);
  assert.ok(p, `no plugin ${id}`);
  return p;
}

const send = (body: unknown, status = 200) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status).end(typeof body === "string" ? body : JSON.stringify(body));
};

const idle = { busy: false, risks: [], lastActive: 0 };

test("llamacpp probe reads /slots", async () => {
  const busy = await probe("llamacpp", send([{ is_processing: false }, { is_processing: true }]));
  assert.equal(busy.busy, true);
  assert.ok(busy.lastActive > 0);
  assert.deepEqual(await probe("llamacpp", send([{ is_processing: false }])), idle);
  assert.deepEqual(await probe("llamacpp", send("disabled", 501)), idle, "--no-slots is not a risk");
  assert.match((await probe("llamacpp", send("<html>"))).risks[0] ?? "", /^llamacpp: \/slots sent invalid JSON/);
  assert.match((await probe("llamacpp", send("", 500))).risks[0] ?? "", /^llamacpp: \/slots answered 500/);
});

test("vllm probe sums running and waiting over all series", async () => {
  const metrics = (running: string, waiting: string) =>
    [
      "# HELP vllm:num_requests_running Number of requests in model execution batches.",
      `vllm:num_requests_running{engine="0",model_name="a"} ${running}`,
      'vllm:num_requests_running{engine="1",model_name="b"} 0.0',
      `vllm:num_requests_waiting{engine="0",model_name="a"} ${waiting}`,
      'vllm:num_requests_running_total{model_name="a"} 9.0',
    ].join("\n");
  assert.equal((await probe("vllm", send(metrics("0.0", "1.0")))).busy, true);
  assert.deepEqual(await probe("vllm", send(metrics("0.0", "0.0"))), idle);
  assert.match((await probe("vllm", send("up 1\n"))).risks[0] ?? "", /^vllm: \/metrics has no vllm:num_requests_running/);
});

test("comfyui probe treats a queued prompt as busy and a risk", async () => {
  const busy = await probe("comfyui", send({ queue_running: [[0, "a"]], queue_pending: [[1, "b"]] }));
  assert.equal(busy.busy, true);
  assert.deepEqual(busy.risks, ["2 prompt(s) queued or running"]);
  assert.deepEqual(await probe("comfyui", send({ queue_running: [], queue_pending: [] })), idle);
  assert.match((await probe("comfyui", send({ queue: 1 }))).risks[0] ?? "", /^comfyui: \/queue sent unexpected JSON/);
});

test("a1111 probe sends basic auth and reads job_count", async () => {
  const progress = (jobs: number) => (req: IncomingMessage, res: ServerResponse) => {
    const ok =
      req.url === "/sdapi/v1/progress?skip_current_image=true" &&
      req.headers.authorization === `Basic ${Buffer.from("u:p").toString("base64")}`;
    res.writeHead(ok ? 200 : 401).end(JSON.stringify({ progress: 0, state: { job_count: jobs } }));
  };
  assert.deepEqual((await probe("a1111", progress(1), "u:p")).risks, ["1 image job(s) running or queued"]);
  assert.deepEqual(await probe("a1111", progress(0), "u:p"), idle);
  assert.match((await probe("a1111", progress(0))).risks[0] ?? "", /^a1111: .* answered 401/);
});

test("jupyter probe sends the token", async () => {
  const act = await probe(
    "jupyter",
    (req, res) => res.writeHead(req.headers.authorization === "token t" ? 200 : 403).end("[]"),
    "t",
  );
  assert.deepEqual(act, idle);
});

test("an unreachable service is a risk", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  const act = await plugin("comfyui").probe?.({ url: `http://127.0.0.1:${port}` });
  assert.equal(act?.busy, false);
  assert.match(act?.risks[0] ?? "", /^comfyui: fetch failed: .*ECONNREFUSED/);
});

test("route classes", () => {
  const cases: [id: string, method: string, path: string, accept: string, expected: string][] = [
    ["ollama", "POST", "/api/chat", "*/*", "work"],
    ["ollama", "DELETE", "/api/delete", "*/*", "work"],
    ["ollama", "GET", "/api/tags", "*/*", "cached"],
    ["ollama", "GET", "/", "text/html", "cached"],
    ["ollama", "HEAD", "/", "*/*", "passive"],
    ["ollama", "GET", "/api/ps", "*/*", "passive"],
    ["ollama", "POST", "/api/show", "*/*", "passive"],
    ["llamacpp", "POST", "/completion", "*/*", "work"],
    ["llamacpp", "GET", "/props", "*/*", "cached"],
    ["llamacpp", "GET", "/", "text/html,application/xhtml+xml", "open"],
    ["llamacpp", "GET", "/slots", "*/*", "passive"],
    ["vllm", "POST", "/v1/chat/completions", "*/*", "work"],
    ["vllm", "GET", "/v1/models", "*/*", "cached"],
    ["vllm", "GET", "/", "text/html", "passive"],
    ["comfyui", "POST", "/prompt", "*/*", "work"],
    ["comfyui", "POST", "/api/prompt", "*/*", "work"],
    ["comfyui", "GET", "/", "text/html", "open"],
    ["comfyui", "GET", "/ws", "*/*", "passive"],
    ["comfyui", "GET", "/queue", "*/*", "passive"],
    ["a1111", "POST", "/sdapi/v1/txt2img", "*/*", "work"],
    ["a1111", "GET", "/sdapi/v1/progress", "*/*", "passive"],
    ["a1111", "POST", "/internal/progress", "*/*", "passive"],
    ["jupyter", "POST", "/api/kernels", "*/*", "passive"],
    ["jupyter", "GET", "/lab", "text/html", "passive"],
    ["wyoming", "POST", "/", "*/*", "passive"],
  ];
  for (const [id, method, path, accept, expected] of cases) {
    assert.equal(plugin(id).route({ method, path, accept }), expected, `${id} ${method} ${path}`);
  }
});

test("registry ids are unique", () => {
  assert.deepEqual([...plugins.keys()], ["custom", "ollama", "llamacpp", "vllm", "comfyui", "a1111", "jupyter", "wyoming"]);
});

test("detect matches documented samples and only them", () => {
  const cases: [kind: "unit" | "image" | "cmdline", sample: string, id: string | null][] = [
    ["unit", "ollama.service", "ollama"],
    ["image", "ollama/ollama:latest", "ollama"],
    ["cmdline", "/usr/local/bin/ollama serve", "ollama"],
    ["cmdline", "/usr/local/bin/ollama runner --model x", null],
    ["unit", "llama-server.service", "llamacpp"],
    ["image", "ghcr.io/ggml-org/llama.cpp:server-cuda", "llamacpp"],
    ["image", "ghcr.io/ggml-org/llama.cpp:full", null],
    ["cmdline", "/opt/llama.cpp/build/bin/llama-server -m model.gguf --port 8080", "llamacpp"],
    ["image", "vllm/vllm-openai:v0.10.0", "vllm"],
    ["cmdline", "/opt/venv/bin/python3 /opt/venv/bin/vllm serve Qwen/Qwen3-8B", "vllm"],
    ["cmdline", "python3 -m vllm.entrypoints.openai.api_server --model x", "vllm"],
    ["unit", "comfyui.service", "comfyui"],
    ["image", "yanwk/comfyui-boot:cu124-slim", "comfyui"],
    ["cmdline", "python /opt/ComfyUI/main.py --listen 0.0.0.0", "comfyui"],
    ["cmdline", "/home/u/.local/bin/comfy launch -- --listen", "comfyui"],
    ["cmdline", "python /srv/app/main.py", null],
    ["unit", "stable-diffusion-webui-forge.service", "a1111"],
    ["unit", "forgejo.service", null],
    ["cmdline", "bash ./webui.sh --api --listen", "a1111"],
    ["cmdline", "python3 /opt/stable-diffusion-webui/launch.py --api", "a1111"],
    ["cmdline", "python3 launch.py", null],
    ["unit", "jupyter.service", "jupyter"],
    ["unit", "jupyterhub.service", null],
    ["image", "quay.io/jupyter/pytorch-notebook:latest", "jupyter"],
    ["cmdline", "/usr/bin/python3 /usr/bin/jupyter-lab --no-browser", "jupyter"],
    ["cmdline", "python -m ipykernel_launcher -f kernel.json", null],
    ["unit", "wyoming-whisper.service", "wyoming"],
    ["image", "rhasspy/wyoming-piper:latest", "wyoming"],
    ["cmdline", "python3 -m wyoming_faster_whisper --model small-int8 --uri tcp://0.0.0.0:10300", "wyoming"],
    ["unit", "open-webui.service", null],
    ["image", "ghcr.io/open-webui/open-webui:main", null],
    ["cmdline", "/usr/bin/python3 /usr/bin/foo serve", null],
  ];
  for (const [kind, sample, id] of cases) {
    const matches = [...plugins.values()].filter((p) => p.detect[kind]?.test(sample)).map((p) => p.id);
    assert.deepEqual(matches, id ? [id] : [], `${kind} ${sample}`);
  }
});
