// The config file as something the agent edits. The bot changes settings
// through the API; each change is validated like a config at startup,
// written atomically next to a .bak copy, and applied to the running agent.
// A file edited by hand since the last load is never overwritten.
import { createHash } from "node:crypto";
import { copyFile, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { type } from "arktype";
import { stringify } from "yaml";
import type { Agent } from "./agent.ts";
import { type Config, type ConfigSource, checkConfig, parseConfig } from "./config.ts";
import type { Discovery } from "./discover.ts";
import { plugins } from "./plugins/index.ts";
import type { Run } from "./plugins/types.ts";

type SourceService = ConfigSource["services"][number];

/** Fields the bot may change on an existing service. */
export type ServicePatch = { run?: Run; idle?: string; remind?: string; wait?: string };

const header = "# kilnhush config. The bot edits this file; hand edits are fine, then run `kilnhush reload`.\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export class ConfigStore {
  #hash: string;

  private constructor(
    readonly path: string,
    public config: Config,
    text: string,
  ) {
    this.#hash = sha(text);
  }

  /** Follows a symlinked config, so edits land in the file it points to. */
  static async load(path: string) {
    const real = await realpath(path);
    const text = await readFile(real, "utf8");
    return new ConfigStore(real, parseConfig(text), text);
  }

  /** Applies `change` to a copy of the source and validates the result. Writes nothing. */
  prepare(change: (source: ConfigSource, current: Config) => void): Config {
    const source = structuredClone(this.config.source);
    change(source, this.config);
    return checkConfig(source);
  }

  /** Writes `next` over the file, unless someone changed the file since it was read. */
  async commit(next: Config) {
    const unchanged = async () => {
      if (sha(await readFile(this.path, "utf8")) !== this.#hash) {
        throw new Error("the config file changed on disk; run `kilnhush reload` first");
      }
    };
    await unchanged();
    const text = header + stringify(next.source);
    const { mode } = await stat(this.path);
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      const file = await open(tmp, "wx", mode & 0o777);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await copyFile(this.path, `${this.path}.bak`);
      // Narrows the window for a hand edit landing mid-write; it cannot close it.
      await unchanged();
      await rename(tmp, this.path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    this.#hash = sha(text);
    this.config = next;
  }

  /** Reads the file again after a hand edit. Returns the new config for the agent to check. */
  async reread() {
    const text = await readFile(this.path, "utf8");
    const config = parseConfig(text);
    return { config, accept: () => this.#accept(config, text) };
  }

  #accept(config: Config, text: string) {
    this.#hash = sha(text);
    this.config = config;
  }
}

/** Applies `change` to the running agent and the file, in that lock-held order. */
export function edit(agent: Agent, store: ConfigStore, change: (source: ConfigSource, current: Config) => void) {
  return agent.reconfigure(
    () => store.prepare(change),
    (next) => store.commit(next),
  );
}

/** Loads a hand-edited file into the running agent. */
export async function reload(agent: Agent, store: ConfigStore) {
  let accept = () => {};
  return agent.reconfigure(
    async () => {
      const read = await store.reread();
      accept = read.accept;
      return read.config;
    },
    async () => accept(),
  );
}

/** Adds a service right above the home service, so its requests can take the card from home. */
export function addService(source: ConfigSource, current: Config, service: SourceService) {
  const home = source.services.findIndex((s) => s.name === current.home);
  source.services.splice(home === -1 ? source.services.length : home, 0, service);
}

export function removeService(source: ConfigSource, name: string) {
  source.services.splice(indexOf(source, name), 1);
}

/** Moves a service to position `to` in the priority list, 0 being the top. */
export function moveService(source: ConfigSource, name: string, to: number) {
  const [service] = source.services.splice(indexOf(source, name), 1);
  if (service) source.services.splice(Math.max(0, Math.min(to, source.services.length)), 0, service);
}

/**
 * Changes soft settings. Settings that stop applying under the new `run` are
 * dropped, and making a service the home demotes the old home to on_demand.
 */
export function updateService(source: ConfigSource, current: Config, name: string, patch: ServicePatch) {
  const service = source.services[indexOf(source, name)];
  if (!service) return;
  if (patch.run) {
    const oldHome = source.services.find((s) => s.name === current.home);
    if (patch.run === "always" && oldHome && oldHome !== service) {
      oldHome.run = "on_demand";
      delete oldHome.remind;
    }
    service.run = patch.run;
    if (patch.run !== "on_demand") delete service.idle;
    if (patch.run !== "manual") delete service.remind;
  }
  if (patch.idle !== undefined) service.idle = patch.idle;
  if (patch.remind !== undefined) service.remind = patch.remind;
  if (patch.wait !== undefined) service.wait = patch.wait;
}

function indexOf(source: ConfigSource, name: string) {
  const i = source.services.findIndex((s) => s.name === name);
  if (i === -1) throw new RangeError(`unknown service ${name}`);
  return i;
}

/** What the bot sees and edits. Durations are in ms. */
export function settingsView(config: Config) {
  return {
    services: config.services.map((s) => ({
      name: s.name,
      plugin: s.plugin.id,
      pluginName: s.plugin.name,
      run: s.run,
      idle: s.idle,
      remind: s.remind,
      wait: s.wait,
      url: s.url ?? null,
      proxy: s.proxy ?? null,
      /** unit:…, container:… or cmd:… per process. */
      procs: s.procs.map((p) => p.key),
    })),
    plugins: [...plugins.values()].map((p) => ({ id: p.id, name: p.name, port: p.port, run: p.run })),
    warnings: config.warnings,
  };
}

export type SettingsView = ReturnType<typeof settingsView>;

const durationText = /^(\d+(ms|s|m|h))+$/;
const addBody = type({
  "+": "reject",
  name: "string",
  plugin: "string",
  "unit?": "string > 0",
  "container?": "string > 0",
  "url?": "string",
  "proxy?": "1 <= number.integer <= 65535",
  "run?": "'on_demand' | 'always' | 'manual'",
});
const updateBody = type({
  "+": "reject",
  name: "string",
  "run?": "'on_demand' | 'always' | 'manual'",
  "idle?": durationText,
  "remind?": durationText,
  "wait?": durationText,
});
const moveBody = type({ "+": "reject", name: "string", to: "number.integer >= 0" });
const nameBody = type({ "+": "reject", name: "string" });

export type SettingsDeps = {
  store: ConfigStore;
  /** Whether the host has the unit or container. The API only adds what exists. */
  hostHas: (proc: { unit?: string; container?: string }) => Promise<boolean>;
  discover: () => Promise<Discovery>;
  /** Whether a proxy could listen on the port now. */
  portFree: (port: number) => Promise<boolean>;
};

/**
 * Handles /api/settings/*. Returns the status and JSON body; the caller has
 * already checked auth and parsed the body. Commands (`cmd`) can only be set
 * in the file, so the API cannot be used to run arbitrary programs.
 */
export async function settingsRoute(agent: Agent, deps: SettingsDeps, action: string, body: unknown) {
  const ok = (config: Config) => ({ status: 200, body: settingsView(config) });
  const bad = (error: string) => ({ status: 400, body: { error } });
  const parse = <T>(schema: (data: unknown) => T | type.errors) => {
    const input = schema(body);
    if (input instanceof type.errors) throw new Error(input.summary);
    return input;
  };
  try {
    switch (action) {
      case "view":
        return ok(agent.config);
      case "discover":
        return { status: 200, body: await deps.discover() };
      case "reload":
        return ok(await reload(agent, deps.store));
      case "add": {
        const input = parse(addBody);
        if (!input.unit === !input.container) return bad("give exactly one of unit or container");
        if (!(await deps.hostHas(input))) return bad(`this host has no ${input.unit ?? input.container}`);
        if (input.proxy !== undefined && !(await deps.portFree(input.proxy))) return bad(`port ${input.proxy} is in use`);
        return ok(await edit(agent, deps.store, (source, current) => addService(source, current, input)));
      }
      case "update": {
        const { name, ...patch } = parse(updateBody);
        return ok(await edit(agent, deps.store, (source, current) => updateService(source, current, name, patch)));
      }
      case "move": {
        const input = parse(moveBody);
        return ok(await edit(agent, deps.store, (source) => moveService(source, input.name, input.to)));
      }
      case "remove": {
        const input = parse(nameBody);
        return ok(await edit(agent, deps.store, (source) => removeService(source, input.name)));
      }
      default:
        return { status: 404, body: { error: "not found" } };
    }
  } catch (err) {
    return bad((err as Error).message);
  }
}
