// Stand-ins for llama-server and Jupyter, so the demo and tests run on any
// machine without a GPU.
import { type Server, createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const listen = (server: Server, port: number) =>
  new Promise<Server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));

/**
 * Answers /health and /v1/chat/completions after `loadMs` of fake model
 * loading. Replies take `replyMs`; `stream: true` sends SSE chunks.
 */
export async function fakeLlama(port: number, { loadMs = 0, replyMs = 500 } = {}) {
  await sleep(loadMs);
  const words = "hello from a fake llama-server".split(" ");
  const server = createServer(async (req, res) => {
    if (req.url === "/health") return res.writeHead(200).end('{"status":"ok"}');
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") return res.writeHead(404).end();
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const { stream } = JSON.parse(raw || "{}") as { stream?: boolean };
    if (!stream) {
      await sleep(replyMs);
      const message = { role: "assistant", content: words.join(" ") };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const word of words) {
      await sleep(replyMs / words.length);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `${word} ` } }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  return listen(server, port);
}

/**
 * Serves /api, /api/kernels and /api/sessions with one notebook, train.ipynb.
 * POST /demo?busy=1&tabs=2 sets the kernel state.
 */
export function fakeJupyter(port: number) {
  const kernel = { id: "3f2a9c1e-fake", execution_state: "idle", connections: 0, last_activity: new Date().toISOString() };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/api") return json({ version: "fake" });
    if (url.pathname === "/api/kernels") return json([kernel]);
    if (url.pathname === "/api/sessions") return json([{ path: "train.ipynb", kernel: { id: kernel.id } }]);
    if (url.pathname === "/demo" && req.method === "POST") {
      const busy = url.searchParams.get("busy");
      const tabs = url.searchParams.get("tabs");
      if (busy !== null) kernel.execution_state = busy === "1" ? "busy" : "idle";
      if (tabs !== null) kernel.connections = Number(tabs);
      kernel.last_activity = new Date().toISOString();
      return json(kernel);
    }
    res.writeHead(404).end();
  });
  return listen(server, port);
}
