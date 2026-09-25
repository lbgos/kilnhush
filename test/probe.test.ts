import assert from "node:assert/strict";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { probeKernels } from "../src/plugins/jupyter.ts";
import { parseSmi } from "../src/probe.ts";

async function jupyter(routes: Record<string, unknown>) {
  const server: Server = createServer((req, res) => {
    const body = routes[req.url ?? ""];
    if (body === undefined) return res.writeHead(500).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const kernel = (id: string, state: string, connections = 0) => ({
  id,
  execution_state: state,
  connections,
  last_activity: "2026-09-23T10:00:00Z",
});

test("a busy kernel without a session still blocks", async () => {
  const { server, url } = await jupyter({
    "/api/kernels": [kernel("aaaaaaaa-1", "idle", 1), kernel("bbbbbbbb-2", "busy")],
    "/api/sessions": [{ path: "train.ipynb", kernel: { id: "aaaaaaaa-1" } }],
  });
  const act = await probeKernels({ url });
  server.close();
  assert.equal(act.busy, true);
  assert.deepEqual(act.risks, [
    "train.ipynb: open in 1 browser tab(s), unsaved edits would be lost",
    "kernel bbbbbbbb: cell running",
  ]);
});

test("either endpoint failing is a risk, not idle", async () => {
  const { server, url } = await jupyter({ "/api/kernels": [] });
  const act = await probeKernels({ url });
  server.close();
  assert.equal(act.busy, false);
  assert.match(act.risks[0] ?? "", /api\/sessions answered 500/);
});

test("unexpected JSON is a risk, not a crash", async () => {
  const { server, url } = await jupyter({ "/api/kernels": [{ id: 7 }], "/api/sessions": [] });
  const act = await probeKernels({ url });
  server.close();
  assert.match(act.risks[0] ?? "", /api\/kernels sent unexpected JSON/);
});

test("parseSmi", () => {
  assert.deepEqual(parseSmi("NVIDIA GeForce RTX 3080, 7, 812, 10240\n"), {
    name: "NVIDIA GeForce RTX 3080",
    util: 7,
    memUsed: 812,
    memTotal: 10240,
  });
  assert.equal(parseSmi("garbage"), null);
});
