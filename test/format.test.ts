import assert from "node:assert/strict";
import { test } from "node:test";
import { gpuUse } from "../src/agent.ts";
import type { State } from "../src/api.ts";
import { parseConfig } from "../src/config.ts";
import { formatState } from "../src/format.ts";

const base: State = {
  holder: null,
  switching: null,
  home: "voice",
  homePaused: false,
  pinned: false,
  services: [{ name: "voice", plugin: "Custom", run: "always", idle: 0, proxy: null, models: [] }],
  warnings: [],
  since: 0,
  busy: false,
  risks: [],
  lastActive: 0,
  reminderDue: false,
  gpu: null,
  host: "gpu-host",
  vram: null,
  unmanaged: [],
  events: [],
};

test("a failed switch does not look like one in progress", () => {
  assert.match(formatState({ ...base, switching: "llm" }), /^starting llm…/);
  assert.match(formatState({ ...base, risks: ["cleanup after failed llm start did not finish"] }), /^no service, the last switch failed\n! cleanup/);
  assert.match(formatState({ ...base, homePaused: true }), /^card free, home stopped by hand\n\n○ voice · always on$/);
});

test("GPU memory counts toward the holder, and processes no service owns are named", () => {
  const { services } = parseConfig(`services:
  - { name: llm, unit: bonsai }
  - { name: demo, cmd: [llama-server] }
`);
  const procs = [
    { pid: 10, usedMiB: 6144, owner: { kind: "unit" as const, name: "bonsai.service" }, cmdline: "llama-server" },
    { pid: 11, usedMiB: 1024, owner: { kind: "unit" as const, name: "ollama.service" }, cmdline: "ollama runner" },
    { pid: 123, usedMiB: 2150, owner: null, cmdline: "/usr/bin/python3 train.py" },
  ];
  const use = gpuUse(procs, services, "llm");
  assert.equal(use.vram, 6144);
  assert.equal(gpuUse([{ ...procs[0]!, owner: { kind: "unit", name: "kilnhush.service" } }], services, "demo").vram, 6144);

  const gpu = { name: "RTX 3080", util: 40, memUsed: 9318, memTotal: 10240 };
  const text = formatState({ ...base, holder: "llm", since: 0, lastActive: 0, gpu, ...use }, 60_000);
  assert.match(text, /^llm · 1m00s · 6\.0 GB\n/);
  assert.match(text, /\ngpu-host · RTX 3080 40%\n.*\nalso on the GPU: ollama\.service \(pid 11\) 1\.0 GB, python3 \(pid 123\) 2\.1 GB\n/);
});
