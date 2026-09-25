// Stand-ins for llama-server, Jupyter and ComfyUI, so the demo and tests run
// on any machine without a GPU.
import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const listen = (server: Server, port: number) =>
  new Promise<Server>((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));

/**
 * Answers /health, /v1/models and /v1/chat/completions after `loadMs` of
 * fake model loading. Replies take `replyMs`; `stream: true` sends SSE chunks.
 */
export async function fakeLlama(port: number, { loadMs = 0, replyMs = 500 } = {}) {
  await sleep(loadMs);
  const words = "hello from a fake llama-server".split(" ");
  const server = createServer(async (req, res) => {
    if (req.url === "/health") return res.writeHead(200).end('{"status":"ok"}');
    if (req.url?.startsWith("/v1/models")) {
      return res.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[{"id":"bonsai"}]}');
    }
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

/**
 * Serves the page (sent in two parts, 200 ms apart), /system_stats, an empty
 * /queue, and WS /ws, which sends one status message and stays open.
 */
export function fakeComfy(port: number) {
  const server = createServer(async (req, res) => {
    const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/system_stats") return json({ system: { os: "fake" } });
    if (req.url === "/queue") return json({ queue_running: [], queue_pending: [] });
    if (req.url !== "/") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html" }).write("<!doctype html><title>ComfyUI</title>");
    await sleep(200);
    res.end("<p>fake</p>");
  });
  server.on("upgrade", (req, socket) => {
    socket.on("error", () => {});
    socket.resume();
    const key = req.headers["sec-websocket-key"];
    if (req.url !== "/ws" || !key) return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
    const status = Buffer.from(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 0 } } } }));
    // One unmasked text frame; the message is under 126 bytes.
    socket.write(Buffer.concat([Buffer.from([0x81, status.length]), status]));
  });
  return listen(server, port);
}
