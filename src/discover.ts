// Finds GPU services on the host: the units and containers holding the card
// now, plus installed ones a plugin recognizes, running or not. Every source
// is optional. A host without nvidia-smi, systemd or docker yields fewer
// results, never an error.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Plugin } from "./plugins/types.ts";
import { containerRunning, unitRunning } from "./runners.ts";

export type Owner = { kind: "unit" | "container"; name: string };
export type GpuProcess = { pid: number; usedMiB: number; owner: Owner | null; cmdline: string };
/**
 * A unit or container worth offering. `active`: running now. `ports`: its
 * listening TCP ports, sorted, empty when unknown. May include internal ports,
 * e.g. an Ollama runner's.
 */
export type Found = { owner: Owner; plugin: string | null; active: boolean; usedMiB: number; ports: number[] };
/** `unmanaged`: GPU processes outside any system unit or known container, e.g. from a login session. */
export type Discovery = { found: Found[]; unmanaged: GpuProcess[] };

/** Host access, injectable for tests. Both throw when the tool or file is missing. */
export type Deps = {
  run(cmd: string, args: string[]): Promise<string>;
  readFile(path: string): Promise<string>;
};

const exec = promisify(execFile);

export const hostDeps: Deps = {
  run: async (cmd, args) => (await exec(cmd, args, { timeout: 10_000 })).stdout,
  readFile: (path) => readFile(path, "utf8"),
};

/** The agent's own unit. GPU processes in it are services it runs from `cmd`. */
const SELF = "kilnhush.service";

/** GPU compute processes on one GPU with the unit or container that owns each. */
export async function gpuProcesses(gpu: number, deps: Deps = hostDeps): Promise<GpuProcess[]> {
  return readProcesses(gpu, deps, once(() => listContainers(deps)));
}

export async function discover(gpu: number, plugins: Iterable<Plugin>, deps: Deps = hostDeps): Promise<Discovery> {
  const list = [...plugins];
  const match = (field: keyof Plugin["detect"], value: string) => list.find((p) => p.detect[field]?.test(value))?.id ?? null;
  const containers = once(() => listContainers(deps));
  const [procs, units, listeners, byName] = await Promise.all([
    readProcesses(gpu, deps, containers),
    listUnits(deps),
    lines(deps, "ss", ["-ltnpH"]),
    containers().then((cs) => new Map(cs.map((c) => [c.name, c]))),
  ]);

  const found = new Map<string, Found>();
  const entry = (owner: Owner) => {
    let f = found.get(key(owner));
    if (!f) {
      const image = owner.kind === "container" ? byName.get(owner.name)?.image : undefined;
      const plugin = owner.kind === "unit" ? match("unit", owner.name) : image ? match("image", image) : null;
      f = { owner, plugin, active: false, usedMiB: 0, ports: [] };
      found.set(key(owner), f);
    }
    return f;
  };

  const unmanaged: GpuProcess[] = [];
  for (const p of procs) {
    if (!p.owner) unmanaged.push(p);
    else if (p.owner.kind !== "unit" || p.owner.name !== SELF) {
      const f = entry(p.owner);
      f.active = true;
      f.usedMiB += p.usedMiB;
      // e.g. bonsai-3080.service running llama-server.
      f.plugin ??= match("cmdline", p.cmdline);
    }
  }
  for (const u of units) {
    if (match("unit", u.name)) entry({ kind: "unit", name: u.name }).active ||= u.active;
  }
  for (const c of byName.values()) {
    if (match("image", c.image)) entry({ kind: "container", name: c.name }).active ||= c.active;
  }

  if (found.size > 0) {
    // Listeners are matched by owner, not by GPU pid: Ollama serves on 11434
    // from a parent process while its runners hold the GPU.
    const owners = new Map(procs.map((p) => [p.pid, p.owner]));
    for (const { pid, port } of parseListeners(listeners)) {
      if (!owners.has(pid)) owners.set(pid, await ownerOf(pid, deps, containers));
      const owner = owners.get(pid);
      if (owner) found.get(key(owner))?.ports.push(port);
    }
    // Bridged containers listen through docker-proxy, so their host ports come from docker.
    for (const c of byName.values()) found.get(key({ kind: "container", name: c.name }))?.ports.push(...c.ports);
    for (const f of found.values()) f.ports = [...new Set(f.ports)].sort((a, b) => a - b);
  }
  return { found: [...found.values()], unmanaged };
}

export type CgroupOwner = { kind: "unit"; name: string } | { kind: "container"; id: string };

/**
 * Reads the owner from a /proc/<pid>/cgroup file: a docker (or podman) scope
 * anywhere in the path, else the first service under /system.slice. User
 * sessions and user units are not ours to manage and read as null.
 */
export function parseCgroup(text: string): CgroupOwner | null {
  const entries = text.split("\n").map((line) => line.split(":"));
  // cgroup v2 has one "0::<path>" line; v1 hosts keep systemd's view under name=systemd.
  const line = entries.find(([id, ctrl]) => id === "0" && ctrl === "") ?? entries.find(([, ctrl]) => ctrl === "name=systemd");
  const path = line?.slice(2).join(":");
  if (!path) return null;
  const docker = /\/(?:docker|libpod)-([0-9a-f]{64})\.scope(?:\/|$)|\/docker\/([0-9a-f]{64})(?:\/|$)/.exec(path);
  const id = docker?.[1] ?? docker?.[2];
  if (id) return { kind: "container", id };
  if (!path.startsWith("/system.slice/")) return null;
  const name = path.split("/").find((s) => s.endsWith(".service"));
  return name ? { kind: "unit", name } : null;
}

type Container = { id: string; name: string; image: string; active: boolean; ports: number[] };
type Unit = { name: string; active: boolean };

async function readProcesses(gpu: number, deps: Deps, containers: () => Promise<Container[]>): Promise<GpuProcess[]> {
  const rows = await lines(deps, "nvidia-smi", [
    "-i",
    String(gpu),
    "--query-compute-apps=pid,used_memory",
    "--format=csv,noheader,nounits",
  ]);
  const procs = rows.flatMap((row) => {
    const [pid, used] = row.split(",").map(Number);
    // used_memory is "[N/A]" on some drivers.
    return pid ? [{ pid, usedMiB: used || 0 }] : [];
  });
  return Promise.all(
    procs.map(async (p) => ({
      ...p,
      owner: await ownerOf(p.pid, deps, containers),
      cmdline: (await deps.readFile(`/proc/${p.pid}/cmdline`).catch(() => "")).split("\0").filter(Boolean).join(" "),
    })),
  );
}

async function ownerOf(pid: number, deps: Deps, containers: () => Promise<Container[]>): Promise<Owner | null> {
  const ref = parseCgroup(await deps.readFile(`/proc/${pid}/cgroup`).catch(() => ""));
  if (ref?.kind !== "container") return ref;
  const c = (await containers()).find((c) => c.id === ref.id);
  return c ? { kind: "container", name: c.name } : null;
}

/** All containers with full ids, so cgroup ids resolve without `docker inspect`. */
async function listContainers(deps: Deps): Promise<Container[]> {
  const rows = await lines(deps, "docker", [
    "ps",
    "--all",
    "--no-trunc",
    "--format",
    "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Ports}}",
  ]);
  return rows.flatMap((row) => {
    const [id, name, image, state, ports = ""] = row.split("\t");
    if (!id || !name || !image || !state) return [];
    // Ports looks like "0.0.0.0:8188->8188/tcp, [::]:8188->8188/tcp, 9000/tcp".
    const published = [...ports.matchAll(/:(\d+)(?:-\d+)?->\d+(?:-\d+)?\/tcp/g)].map((m) => Number(m[1]));
    return [{ id, name, image, active: isRunning(containerRunning, state), ports: published }];
  });
}

/** Loaded units with their state plus installed unit files, minus templates, masked units and aliases. */
async function listUnits(deps: Deps): Promise<Unit[]> {
  const [loaded, files] = await Promise.all([
    lines(deps, "systemctl", ["list-units", "--type=service", "--all", "--no-legend", "--plain"]),
    lines(deps, "systemctl", ["list-unit-files", "--type=service", "--no-legend"]),
  ]);
  const units = new Map<string, Unit>();
  for (const row of loaded) {
    const [name, load, active] = row.split(/\s+/);
    if (name && load === "loaded" && active) units.set(name, { name, active: isRunning(unitRunning, active) });
  }
  for (const row of files) {
    const [name, state] = row.split(/\s+/);
    if (name && state && !state.startsWith("masked") && state !== "alias" && !units.has(name)) {
      units.set(name, { name, active: false });
    }
  }
  return [...units.values()].filter((u) => u.name !== SELF && !u.name.endsWith("@.service"));
}

/** Listening sockets from `ss -ltnpH` rows, one per owning pid. */
function parseListeners(rows: string[]) {
  return rows.flatMap((row) => {
    const local = row.split(/\s+/)[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!port) return [];
    return [...row.matchAll(/pid=(\d+)/g)].map((m) => ({ pid: Number(m[1]), port }));
  });
}

/** Output lines of a command, or none when the tool is missing or fails. */
async function lines(deps: Deps, cmd: string, args: string[]) {
  try {
    return (await deps.run(cmd, args))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A running-state check from services.ts; states it does not know read as stopped, which is only a display hint here. */
function isRunning(running: (state: string) => boolean, state: string) {
  try {
    return running(state);
  } catch {
    return false;
  }
}

const key = (o: Owner) => `${o.kind}:${o.name}`;

function once<T>(f: () => Promise<T>) {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}
