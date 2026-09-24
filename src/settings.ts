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
import type { Discovery, Found } from "./discover.ts";
import type { Pairing } from "./pairing.ts";
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

/** Lets Telegram user `id` use the bot. */
export function addUser(source: ConfigSource, id: number) {
  const users = source.telegram?.users ?? [];
  source.telegram = { ...source.telegram, users: users.includes(id) ? users : [...users, id] };
}

/** Takes Telegram user `id` off the bot. The last user stays, so the bot never locks everyone out. */
export function removeUser(source: ConfigSource, id: number) {
  const users = source.telegram?.users ?? [];
  if (!users.includes(id)) throw new RangeError(`unknown user ${id}`);
  if (new Set(users).size === 1) throw new Error("the last user can't be removed");
  source.telegram = { ...source.telegram, users: users.filter((u) => u !== id) };
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
    /** Telegram user ids allowed to use the bot. */
    users: config.users,
    /** The agent's own port. */
    port: config.port,
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
const userBody = type({ "+": "reject", user: "number.integer" });
const redeemBody = type({ "+": "reject", code: "string", user: "number.integer" });

export type SettingsDeps = {
  store: ConfigStore;
  /** Whether the host has the unit or container. The API only adds what exists. */
  hostHas: (proc: { unit?: string; container?: string }) => Promise<boolean>;
  discover: () => Promise<Discovery>;
  /** Whether a proxy could listen on the port now. */
  portFree: (port: number) => Promise<boolean>;
  pairing: Pairing;
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
        // A proxy port something else listens on moves to the next free one; the view shows which.
        const taken = reservedPorts(agent.config.port, [...agent.config.services, { url: input.url }]);
        let { proxy } = input;
        for (let tries = 0; proxy !== undefined && (taken.has(proxy) || !(await deps.portFree(proxy))); tries++) {
          if (tries === 20 || proxy === 65_535) return bad(`no free proxy port from ${input.proxy}`);
          proxy++;
        }
        return ok(await edit(agent, deps.store, (source, current) => addService(source, current, { ...input, proxy })));
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
      case "redeem": {
        const input = parse(redeemBody);
        // The code is used up only once the user is saved, so a refused edit can be retried.
        if (!deps.pairing.valid(input.code)) return bad("unknown or expired code");
        const next = await edit(agent, deps.store, (source) => addUser(source, input.user));
        deps.pairing.redeem(input.code);
        return ok(next);
      }
      case "remove-user": {
        const input = parse(userBody);
        return ok(await edit(agent, deps.store, (source) => removeUser(source, input.user)));
      }
      default:
        return { status: 404, body: { error: "not found" } };
    }
  } catch (err) {
    return bad((err as Error).message);
  }
}

/**
 * A service name from a unit or container name: no `.service`, lowercase,
 * other characters as `-`, at most 32 characters, `-2`, `-3`… when taken.
 */
export function serviceName(raw: string, taken: ReadonlySet<string>) {
  const base =
    raw
      .replace(/\.service$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^[_-]+/, "")
      .slice(0, 32) || "service";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 32 - `-${i}`.length)}-${i}`;
  return name;
}

/**
 * The /api/settings/add body for a discovered unit or container. The URL uses
 * the plugin's port when the service listens there (or nothing was seen), else
 * its first listening port. The proxy goes on that port + 10000, or the next
 * port no other proxy and not the agent uses. Raw TCP services (Wyoming, whose
 * health check is "tcp") get no proxy: it only carries HTTP and WebSockets.
 */
export function proposeService(found: Found, view: SettingsView) {
  const plugin = plugins.get(found.plugin ?? "custom");
  const { ports } = found;
  const port = plugin && plugin.port > 0 && (ports.length === 0 || ports.includes(plugin.port)) ? plugin.port : ports[0];
  const taken = reservedPorts(view.port, view.services);
  // Ports past 65535 wrap around into 1024 and up.
  const next = (p: number) => ((p - 1_024) % (65_536 - 1_024)) + 1_024;
  let proxy = port === undefined || plugin?.health === "tcp" ? undefined : next(port + 10_000);
  while (proxy !== undefined && taken.has(proxy)) proxy = next(proxy + 1);
  return {
    name: serviceName(found.owner.name, new Set(view.services.map((s) => s.name))),
    plugin: plugin?.id ?? "custom",
    ...(found.owner.kind === "unit" ? { unit: found.owner.name } : { container: found.owner.name }),
    ...(port !== undefined && { url: `http://127.0.0.1:${port}` }),
    ...(proxy !== undefined && { proxy }),
  };
}

/** Ports a new proxy must not take: the agent's, every proxy's and every service's own. */
function reservedPorts(agentPort: number, services: readonly { url?: string | null; proxy?: number | null }[]) {
  return new Set([agentPort, ...services.flatMap((s) => [s.proxy ?? 0, Number(URL.parse(s.url ?? "")?.port || 0)])]);
}
