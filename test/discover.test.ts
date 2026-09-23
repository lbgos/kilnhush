import assert from "node:assert/strict";
import { test } from "node:test";
import { type Deps, type Found, discover, gpuProcesses, parseCgroup } from "../src/discover.ts";
import { custom } from "../src/plugins/custom.ts";
import type { Plugin } from "../src/plugins/types.ts";

const plugin = (id: string, detect: Plugin["detect"]): Plugin => ({ ...custom, id, name: id, detect });
const plugins = [
  plugin("ollama", { unit: /^ollama\.service$/, image: /^ollama\/ollama/, cmdline: /\bollama (serve|runner)\b/ }),
  plugin("llamacpp", { unit: /^llama/, image: /llama\.cpp/, cmdline: /\bllama-server\b/ }),
  plugin("comfyui", { image: /comfyui/i }),
  plugin("wyoming", { unit: /^wyoming-/, image: /wyoming-/ }),
];

const COMFY = "3f9a1c0d5e7b2a4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c";
const PIPER = "b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3";

const commands: Record<string, string> = {
  "nvidia-smi -i 0 --query-compute-apps=pid,used_memory --format=csv,noheader,nounits":
    "4127, 5230\n4188, 2890\n9001, 6120\n7310, 812\n5555, 1400\n6001, 300\n",
  "systemctl list-units --type=service --all --no-legend --plain": [
    "ollama.service           loaded    active   running Ollama Service",
    "sshd.service             loaded    active   running OpenSSH Daemon",
    "bonsai-3080.service      loaded    active   running Bonsai on the 3080",
    "kilnhush.service         loaded    active   running kilnhush",
    "wyoming-piper.service    not-found inactive dead    wyoming-piper.service",
  ].join("\n"),
  "systemctl list-unit-files --type=service --no-legend": [
    "ollama.service                disabled        disabled",
    "sshd.service                  enabled         disabled",
    "wyoming-whisper.service       disabled        disabled",
    "llama@.service                disabled        disabled",
    "llama-old.service             masked          enabled",
  ].join("\n"),
  "docker ps --all --no-trunc --format {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Ports}}": [
    `${COMFY}\tcomfyui\tyanwk/comfyui-boot:cu124\trunning\t0.0.0.0:8188->8188/tcp, [::]:8188->8188/tcp`,
    `${PIPER}\tpiper\trhasspy/wyoming-piper\texited\t`,
    `c0ffee${"0".repeat(58)}\tpostgres\tpostgres:16\trunning\t5432/tcp`,
  ].join("\n"),
  "ss -ltnpH": [
    'LISTEN 0      4096       127.0.0.1:11434      0.0.0.0:*    users:(("ollama",pid=4100,fd=3))',
    'LISTEN 0      512        127.0.0.1:39417      0.0.0.0:*    users:(("ollama",pid=4127,fd=8))',
    'LISTEN 0      4096         0.0.0.0:8188       0.0.0.0:*    users:(("docker-proxy",pid=2210,fd=7))',
    'LISTEN 0      4096            [::]:8188          [::]:*    users:(("docker-proxy",pid=2216,fd=7))',
    'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=880,fd=3),("sshd",pid=881,fd=3))',
    'LISTEN 0      512        127.0.0.1:8081       0.0.0.0:*    users:(("llama-server",pid=5555,fd=5))',
  ].join("\n"),
};

const cgroup = (path: string) => `0::${path}\n`;
const argv = (...args: string[]) => args.map((a) => `${a}\0`).join("");
const files: Record<string, string> = {
  "/proc/4100/cgroup": cgroup("/system.slice/ollama.service"),
  "/proc/4127/cgroup": cgroup("/system.slice/ollama.service"),
  "/proc/4127/cmdline": argv("/usr/bin/ollama", "runner", "--model", "/var/lib/ollama/blobs/sha256-6a0746a1"),
  "/proc/4188/cgroup": cgroup("/system.slice/ollama.service"),
  "/proc/9001/cgroup": cgroup(`/system.slice/docker-${COMFY}.scope`),
  "/proc/9001/cmdline": argv("python", "main.py", "--listen"),
  "/proc/7310/cgroup": cgroup("/user.slice/user-1000.slice/session-3.scope"),
  "/proc/7310/cmdline": argv("python3", "train.py"),
  "/proc/5555/cgroup": cgroup("/system.slice/bonsai-3080.service"),
  "/proc/5555/cmdline": argv("/opt/llama.cpp/build/bin/llama-server", "-m", "bonsai.gguf", "--port", "8081"),
  "/proc/6001/cgroup": cgroup("/system.slice/kilnhush.service"),
  "/proc/2210/cgroup": cgroup("/system.slice/docker.service"),
  "/proc/2216/cgroup": cgroup("/system.slice/docker.service"),
  "/proc/880/cgroup": cgroup("/system.slice/sshd.service"),
  "/proc/881/cgroup": cgroup("/system.slice/sshd.service"),
};

/** A host whose tools print recorded output. Anything not listed is missing, like a real ENOENT. */
function host(cmds: Record<string, string> = commands): Deps {
  const missing = (what: string) => Object.assign(new Error(`${what}: ENOENT`), { code: "ENOENT" });
  return {
    run: async (cmd, args) => cmds[[cmd, ...args].join(" ")] ?? Promise.reject(missing(cmd)),
    readFile: async (path) => files[path] ?? Promise.reject(missing(path)),
  };
}

const find = (found: Found[], name: string) => found.find((f) => f.owner.name === name);

test("a GPU process in a system unit belongs to that unit, deduped with its listings", async () => {
  const { found } = await discover(0, plugins, host());
  assert.equal(found.filter((f) => f.owner.name === "ollama.service").length, 1);
  assert.deepEqual(find(found, "ollama.service"), {
    owner: { kind: "unit", name: "ollama.service" },
    plugin: "ollama",
    active: true,
    usedMiB: 5230 + 2890,
    ports: [11434, 39417],
  });
});

test("a GPU process in a docker scope belongs to its container, with published ports", async () => {
  const { found } = await discover(0, plugins, host());
  assert.deepEqual(find(found, "comfyui"), {
    owner: { kind: "container", name: "comfyui" },
    plugin: "comfyui",
    active: true,
    usedMiB: 6120,
    ports: [8188],
  });
});

test("a process from a login session is unmanaged", async () => {
  const { unmanaged } = await discover(0, plugins, host());
  assert.deepEqual(unmanaged, [{ pid: 7310, usedMiB: 812, owner: null, cmdline: "python3 train.py" }]);
});

test("installed services a plugin recognizes are found while stopped; others, templates and self are not", async () => {
  const { found } = await discover(0, plugins, host());
  assert.deepEqual(find(found, "wyoming-whisper.service"), {
    owner: { kind: "unit", name: "wyoming-whisper.service" },
    plugin: "wyoming",
    active: false,
    usedMiB: 0,
    ports: [],
  });
  assert.equal(find(found, "piper")?.active, false);
  assert.deepEqual(
    found.map((f) => f.owner.name),
    ["ollama.service", "comfyui", "bonsai-3080.service", "wyoming-whisper.service", "piper"],
  );
});

test("a unit whose name matches nothing gets its plugin from the GPU process cmdline", async () => {
  const { found } = await discover(0, plugins, host());
  assert.deepEqual(find(found, "bonsai-3080.service"), {
    owner: { kind: "unit", name: "bonsai-3080.service" },
    plugin: "llamacpp",
    active: true,
    usedMiB: 1400,
    ports: [8081],
  });
});

test("without docker, container processes are unmanaged and the rest still works", async () => {
  const { found, unmanaged } = await discover(
    0,
    plugins,
    host(Object.fromEntries(Object.entries(commands).filter(([cmd]) => !cmd.startsWith("docker ")))),
  );
  assert.deepEqual(
    found.map((f) => f.owner.name),
    ["ollama.service", "bonsai-3080.service", "wyoming-whisper.service"],
  );
  assert.deepEqual(
    unmanaged.map((p) => p.pid),
    [9001, 7310],
  );
});

test("a host with none of the tools finds nothing", async () => {
  assert.deepEqual(await discover(0, plugins, host({})), { found: [], unmanaged: [] });
  assert.deepEqual(await gpuProcesses(0, host({})), []);
});

test("parseCgroup", () => {
  const cases: [string, ReturnType<typeof parseCgroup>][] = [
    [cgroup("/system.slice/ollama.service"), { kind: "unit", name: "ollama.service" }],
    [cgroup("/system.slice/system-llama.slice/llama@qwen.service"), { kind: "unit", name: "llama@qwen.service" }],
    [cgroup("/system.slice/foo.service/payload"), { kind: "unit", name: "foo.service" }],
    [cgroup(`/system.slice/docker-${COMFY}.scope`), { kind: "container", id: COMFY }],
    [cgroup(`/docker/${COMFY}`), { kind: "container", id: COMFY }],
    [cgroup(`/machine.slice/libpod-${COMFY}.scope/container`), { kind: "container", id: COMFY }],
    [
      cgroup(`/user.slice/user-1000.slice/user@1000.service/user.slice/docker-${COMFY}.scope`),
      { kind: "container", id: COMFY },
    ],
    [`12:pids:/system.slice/foo.service\n1:name=systemd:/system.slice/foo.service\n`, { kind: "unit", name: "foo.service" }],
    [cgroup("/user.slice/user-1000.slice/user@1000.service/app.slice/ollama.service"), null],
    [cgroup("/system.slice/run-r3b1.scope"), null],
    ["", null],
  ];
  for (const [text, owner] of cases) assert.deepEqual(parseCgroup(text), owner, text);
});
