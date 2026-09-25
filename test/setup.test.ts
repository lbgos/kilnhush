import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import type { Found } from "../src/discover.ts";
import { candidates, localAddress, parseChoice, planConfig, setEnv } from "../src/setup.ts";

const found = (name: string, plugin: string | null, ports: number[], kind: "unit" | "container" = "unit"): Found => ({
  owner: { kind, name },
  plugin,
  active: false,
  usedMiB: 0,
  ports,
});

// A host like VM111: Jupyter, a llama.cpp model, ComfyUI in docker, two Wyoming units, and a stray unit.
const host = [
  found("wyoming-faster-whisper.service", "wyoming", [10300]),
  found("bonsai.service", "llamacpp", [8080]),
  found("comfyui", "comfyui", [8188], "container"),
  found("jupyter.service", "jupyter", [8888]),
  found("wyoming-kokoro.service", "wyoming", [10800]),
  found("backup.service", null, []),
];

test("setup offers known services, with Wyoming units grouped as voice", () => {
  assert.deepEqual(
    candidates(host).map((c) => c.label),
    ["bonsai.service", "comfyui", "jupyter.service", "voice (wyoming-faster-whisper.service, wyoming-kokoro.service)"],
  );
  assert.deepEqual(candidates([host[0]!]).map((c) => c.label), ["wyoming-faster-whisper.service"]);
  // A stopped unit listens on nothing, so it can't get a health check: it stays out of the group.
  const stopped = [...host, found("wyoming-piper.service", "wyoming", [])];
  assert.deepEqual(candidates(stopped).map((c) => c.label).slice(3), [
    "voice (wyoming-faster-whisper.service, wyoming-kokoro.service)",
    "wyoming-piper.service",
  ]);
});

test("the planned config is valid, ranks manual first and home last, and avoids busy ports", () => {
  const offered = candidates(host);
  const voice = offered[3]!;
  const source = planConfig(offered, voice, new Set([18080]));
  const config = parseConfig(JSON.stringify(source));
  assert.deepEqual(config.warnings, []);
  assert.deepEqual(
    config.services.map((s) => [s.name, s.run, s.proxy ?? null]),
    [
      ["jupyter", "manual", 18888],
      ["bonsai", "on_demand", 18081],
      ["comfyui", "on_demand", 18188],
      ["voice", "always", null],
    ],
  );
  assert.equal(config.services[1]!.readyTimeout, 5 * 60_000);
  assert.equal(config.services[0]!.tokenEnv, "JUPYTER_TOKEN");
  assert.deepEqual(
    config.services[3]!.procs.map((p) => p.health),
    ["tcp://127.0.0.1:10300", "tcp://127.0.0.1:10800"],
  );

  // Without a home, Wyoming stops being always-on and nothing runs always.
  assert.equal(parseConfig(JSON.stringify(planConfig(offered, null, new Set()))).home, null);
});

test("choices are 1-based numbers, empty takes the default", () => {
  assert.deepEqual(parseChoice("", 3, [0, 1, 2]), [0, 1, 2]);
  assert.deepEqual(parseChoice("3, 1 3", 3, []), [2, 0]);
  assert.equal(parseChoice("4", 3, []), null);
  assert.equal(parseChoice("two", 3, []), null);
});

test("a reconfigure keeps each known service's name and proxy, and the paired users", () => {
  const previous = parseConfig(`telegram: { users: [42] }
services:
  - { name: llm, plugin: llamacpp, unit: bonsai.service, url: "http://127.0.0.1:8080", proxy: 18080 }
`);
  // 18080 is busy: the old agent's own proxy still listens there.
  const source = planConfig(candidates(host), null, new Set([18080]), previous);
  const config = parseConfig(JSON.stringify(source));
  assert.deepEqual(config.users, [42]);
  const llm = config.services.find((s) => s.procs[0]?.key === "unit:bonsai.service");
  assert.deepEqual([llm?.name, llm?.proxy], ["llm", 18080]);
  assert.ok(config.services.every((s) => s === llm || s.proxy !== 18080));
});

test("the env file gets one line per key and keeps the rest", () => {
  assert.equal(
    setEnv("JUPYTER_TOKEN=abc", { KILNHUSH_TOKEN: "t" }),
    "JUPYTER_TOKEN=abc\nKILNHUSH_TOKEN=t\n",
    "a file without a final newline is not glued onto",
  );
  assert.equal(
    setEnv("KILNHUSH_TG_TOKEN=\n# note\nKILNHUSH_TG_TOKEN=old\n", { KILNHUSH_TG_TOKEN: "new" }),
    "KILNHUSH_TG_TOKEN=new\n# note\n",
  );
  assert.equal(setEnv("", { A: "1" }), "A=1\n");
});

test("setup reaches the agent where it listens", () => {
  assert.equal(localAddress("0.0.0.0:7340"), "127.0.0.1:7340");
  assert.equal(localAddress("192.168.1.5:7340"), "192.168.1.5:7340");
  assert.equal(localAddress("[::]:7340"), "127.0.0.1:7340");
});
