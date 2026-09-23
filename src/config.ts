// Loads the agent's YAML config and rejects setups the agent cannot run safely.
import { readFileSync } from "node:fs";
import { type } from "arktype";
import { parse as parseYaml } from "yaml";

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

const duration = type("string").pipe((text, ctx) => parseDuration(text) ?? ctx.error("a duration like 20m or 1h30m"));

const serviceSchema = type({
  "+": "reject",
  "unit?": "string > 0",
  "cmd?": "string[]",
  /** http(s)://... must answer 2xx, tcp://host:port must accept a connection. */
  "health?": /^(https?|tcp):\/\/.+/,
  "ready_timeout?": duration,
});

const modeSchema = type({
  "+": "reject",
  services: serviceSchema.array(),
  /** Return to the default mode after this long without proxied requests. */
  "idle?": duration,
  /** Flag the mode in /api/state once idle this long, so the bot can ask. */
  "remind?": duration,
  /** Treat the mode as busy while GPU utilization is at or above this percent. */
  "gpu_guard?": "0 <= number.integer <= 100",
  "proxy?": { "+": "reject", target: "string.url", "models?": "string[]" },
  "jupyter?": { "+": "reject", url: "string.url", "token_env?": "string" },
});

const configSchema = type({
  "+": "reject",
  "listen?": "string",
  default: "string",
  "tick?": duration,
  /** nvidia-smi index of the GPU this agent manages. */
  "gpu?": "number.integer >= 0",
  modes: { "[string]": modeSchema },
});

/** Parses and validates config YAML. Throws with every problem listed. */
export function parseConfig(yamlText: string) {
  const raw = configSchema(parseYaml(yamlText));
  if (raw instanceof type.errors) throw new Error(`config: ${raw.summary}`);

  const problems: string[] = [];
  const proxyCount = Object.values(raw.modes).filter((m) => m.proxy).length;
  const modes = new Map(
    Object.entries(raw.modes).map(([name, m]) => {
      const bad = (msg: string) => problems.push(`mode ${name}: ${msg}`);
      if (m.services.length === 0) bad("no services");
      if (m.idle && !m.proxy) bad("idle needs proxy, idle time is measured from proxied requests");
      if (m.idle && name === raw.default) bad("the default mode cannot have idle");
      if (m.proxy && m.jupyter) bad("proxy and jupyter cannot be combined");
      if (m.proxy && proxyCount > 1 && !m.proxy.models?.length) bad("proxy needs models when several modes proxy");

      const services = m.services.map((s, i) => {
        const cmd = s.cmd ?? [];
        if (Boolean(s.unit) === cmd.length > 0) bad(`service ${i} needs exactly one of unit or cmd`);
        return {
          key: s.unit ? `unit:${s.unit}` : `cmd:${cmd.join(" ")}`,
          name: s.unit ?? cmd[0] ?? "?",
          unit: s.unit,
          cmd,
          health: s.health,
          readyTimeout: s.ready_timeout ?? 120_000,
        };
      });
      const mode = {
        name,
        services,
        idle: m.idle ?? 0,
        remind: m.remind ?? 0,
        gpuGuard: m.gpu_guard ?? 0,
        proxy: m.proxy && { target: m.proxy.target, models: m.proxy.models ?? [] },
        jupyter: m.jupyter && { url: m.jupyter.url, tokenEnv: m.jupyter.token_env },
      };
      return [name, mode] as const;
    }),
  );
  if (!modes.has(raw.default)) problems.push(`default mode ${raw.default} is not defined`);
  if (problems.length > 0) throw new Error(`config:\n  ${problems.join("\n  ")}`);

  return { listen: raw.listen ?? "127.0.0.1:7340", default: raw.default, tick: raw.tick ?? 10_000, gpu: raw.gpu ?? 0, modes };
}

export function loadConfig(path: string) {
  return parseConfig(readFileSync(path, "utf8"));
}

export type Config = ReturnType<typeof parseConfig>;
export type ModeSpec = Config["modes"] extends Map<string, infer M> ? M : never;
export type ServiceSpec = ModeSpec["services"][number];
export type JupyterSpec = NonNullable<ModeSpec["jupyter"]>;
