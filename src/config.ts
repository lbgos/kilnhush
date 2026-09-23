// Loads the agent config: an ordered list of services, first matters most.
// Each service is one plugin's kind of program, run as a systemd unit, a
// docker container, a command, or a group of those that share the card.
import { readFileSync } from "node:fs";
import { type } from "arktype";
import { parse as parseYaml } from "yaml";
import { custom } from "./plugins/custom.ts";
import { plugins } from "./plugins/index.ts";

const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Parses "500ms", "20m" or "1h30m" into milliseconds. */
export function parseDuration(text: string): number | undefined {
  const re = /(\d+)(ms|s|m|h)/y;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    total += Number(match[1]) * unitMs[match[2] as keyof typeof unitMs];
    if (re.lastIndex === text.length) return total;
  }
  return undefined;
}

export const duration = type("string").pipe((text, ctx) => parseDuration(text) ?? ctx.error("a duration like 20m or 1h30m"));

const runnerFields = {
  "unit?": "string > 0",
  /** Docker container name. */
  "container?": "string > 0",
  /** Only from YAML: the bot cannot set commands. */
  "cmd?": "string[] > 0",
} as const;

const procSchema = type({
  "+": "reject",
  ...runnerFields,
  /** http(s)://... must answer 2xx, tcp://host:port must accept a connection. */
  "health?": /^(https?|tcp):\/\/.+/,
});

const nameRe = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const serviceSchema = type({
  "+": "reject",
  name: "string",
  "plugin?": "string",
  "run?": "'on_demand' | 'always' | 'manual'",
  ...runnerFields,
  "group?": procSchema.array(),
  /** The service's own base URL. Defaults to 127.0.0.1 on the plugin's port. */
  "url?": "string",
  /** A path under url, "tcp", or a full http(s):// or tcp:// URL. Defaults to the plugin's. */
  "health?": "string",
  "ready_timeout?": duration,
  /** on_demand: stop after this long without work. */
  "idle?": duration,
  /** How long a request waits for a busy lower service before a 503. */
  "wait?": duration,
  /** manual: flag the service in state once idle this long, so the bot can ask. */
  "remind?": duration,
  /** Busy while GPU utilization is at or above this percent. */
  "gpu_guard?": "0 <= number.integer <= 100",
  /** Env var holding the service's API token, sent to its probe. */
  "token_env?": "string",
  /** Model ids routed to this service by the /v1 router on the main port. */
  "models?": "string[]",
  /** Port for this service's own proxy on the agent's host. */
  "proxy?": "1 <= number.integer <= 65535",
});

const configSchema = type({
  "+": "reject",
  "listen?": "string",
  "tick?": duration,
  /** nvidia-smi index of the GPU this agent manages. */
  "gpu?": "number.integer >= 0",
  "telegram?": { "+": "reject", "users?": "number.integer[]" },
  services: serviceSchema.array(),
});

export type RawConfig = typeof configSchema.infer;

/** Parses and validates config YAML. Throws with every problem listed. */
export function parseConfig(yamlText: string) {
  return checkConfig(parseYaml(yamlText));
}

/** Validates an already parsed config object, e.g. one the bot edited. */
export function checkConfig(input: unknown) {
  const raw = configSchema(input);
  if (raw instanceof type.errors) throw new Error(`config: ${raw.summary}`);

  const problems: string[] = [];
  const warnings: string[] = [];
  const listen = raw.listen ?? "127.0.0.1:7340";
  const listenPort = Number(URL.parse(`http://${listen}`)?.port || 0);
  if (!listenPort) problems.push(`listen: give host:port, got ${listen}`);
  if (raw.tick !== undefined && raw.tick < 1_000) problems.push("tick: at least 1s");

  const services = raw.services.map((s) => {
    const bad = (msg: string) => problems.push(`service ${s.name}: ${msg}`);
    if (!nameRe.test(s.name)) bad("names use a-z, 0-9, - and _, up to 32 characters");
    const plugin = plugins.get(s.plugin ?? "custom");
    if (!plugin) bad(`unknown plugin ${s.plugin}`);
    const p = plugin ?? custom;
    const run = s.run ?? p.run;

    const url = s.url ?? (p.port > 0 ? `http://127.0.0.1:${p.port}` : undefined);
    const parsedUrl = url === undefined ? null : URL.parse(url);
    if (url !== undefined && (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol))) {
      bad(`url ${url} is not an http(s) URL`);
    }
    const base = parsedUrl && ["http:", "https:"].includes(parsedUrl.protocol) ? parsedUrl : null;
    const health = resolveHealth(s.health ?? p.health ?? undefined, base, bad);

    const direct = { unit: s.unit, container: s.container, cmd: s.cmd };
    const kinds = [s.unit, s.container, s.cmd, s.group].filter((k) => k !== undefined).length;
    if (kinds !== 1) bad("needs exactly one of unit, container, cmd or group");
    if (s.group?.length === 0) bad("group is empty");
    const procs = (s.group ?? (kinds === 1 ? [direct] : [])).map((g, i) => {
      if ([g.unit, g.container, g.cmd].filter((k) => k !== undefined).length !== 1) {
        bad(`group entry ${i} needs exactly one of unit, container or cmd`);
      }
      const key = g.unit ? `unit:${g.unit}` : g.container ? `container:${g.container}` : `cmd:${(g.cmd ?? []).join(" ")}`;
      return {
        key,
        name: g.unit ?? g.container ?? g.cmd?.[0] ?? "?",
        unit: g.unit,
        container: g.container,
        cmd: g.cmd ?? [],
        health: "health" in g ? g.health : undefined,
      };
    });

    if (s.idle !== undefined && run !== "on_demand") bad("idle only applies to run: on_demand");
    if (s.remind !== undefined && run !== "manual") bad("remind only applies to run: manual");
    if (s.proxy !== undefined && !base) bad("proxy needs url");
    if (s.models?.length && !base) bad("models need url");
    if (p.probe && !base) bad(`the ${p.name} plugin needs url`);
    if (s.proxy !== undefined && s.proxy === listenPort) bad(`proxy port ${s.proxy} is the agent's own port`);

    return {
      name: s.name,
      plugin: p,
      run,
      url: base?.href.replace(/\/$/, ""),
      health,
      procs,
      readyTimeout: s.ready_timeout ?? 120_000,
      idle: run === "on_demand" ? (s.idle ?? p.idle) : 0,
      wait: s.wait ?? 60_000,
      remind: s.remind ?? 0,
      gpuGuard: s.gpu_guard ?? 0,
      tokenEnv: s.token_env,
      models: s.models ?? [],
      proxy: s.proxy,
    };
  });

  const seen = (what: string, values: (string | number | undefined)[]) => {
    const owners = new Map<string | number, number>();
    values.forEach((v, i) => {
      if (v === undefined) return;
      const first = owners.get(v);
      if (first !== undefined) problems.push(`services ${services[first]?.name} and ${services[i]?.name} share ${what} ${v}`);
      else owners.set(v, i);
    });
  };
  seen("the name", services.map((s) => s.name));
  seen("proxy port", services.map((s) => s.proxy));
  // Startup adopts a service by what runs, so no process may belong to two services.
  const procOwners = services.flatMap((s, i) => s.procs.map((p) => [p.key, i] as const));
  const byKey = new Map<string, number>();
  for (const [key, i] of procOwners) {
    const first = byKey.get(key);
    if (first !== undefined && first !== i) problems.push(`services ${services[first]?.name} and ${services[i]?.name} share ${key}`);
    byKey.set(key, first ?? i);
  }
  const models = new Map<string, string>();
  for (const s of services) {
    for (const m of s.models) {
      const other = models.get(m);
      if (other) problems.push(`services ${other} and ${s.name} both serve model ${m}`);
      models.set(m, s.name);
    }
  }

  const homes = services.filter((s) => s.run === "always");
  if (homes.length > 1) problems.push(`only one service can run always, found ${homes.map((s) => s.name).join(", ")}`);
  const home = homes[0];
  if (home) {
    const below = services.slice(services.indexOf(home) + 1).filter((s) => s.run === "on_demand");
    for (const s of below) warnings.push(`${s.name} ranks below ${home.name}, so its requests never take the card from ${home.name}`);
  }
  if (problems.length > 0) throw new Error(`config:\n  ${problems.join("\n  ")}`);

  return {
    listen,
    tick: raw.tick ?? 10_000,
    gpu: raw.gpu ?? 0,
    users: raw.telegram?.users ?? [],
    services,
    home: home?.name ?? null,
    warnings,
    /** The validated input, for edits that write the file back. */
    raw,
  };
}

/** A health setting made absolute against the service URL. */
function resolveHealth(value: string | undefined, base: URL | null, bad: (msg: string) => void) {
  if (value === undefined) return undefined;
  if (/^(https?|tcp):\/\/.+/.test(value)) return value;
  if (!base) {
    bad(`health ${value} needs url`);
    return undefined;
  }
  if (value === "tcp") return `tcp://${base.hostname}:${base.port || (base.protocol === "https:" ? 443 : 80)}`;
  if (value.startsWith("/")) return new URL(value, base).href;
  bad(`health ${value} is not a path, "tcp" or a URL`);
  return undefined;
}

export function loadConfig(path: string) {
  return parseConfig(readFileSync(path, "utf8"));
}

export type Config = ReturnType<typeof checkConfig>;
export type ServiceSpec = Config["services"][number];
export type ProcSpec = ServiceSpec["procs"][number];
