// `kilnhush setup`: takes a GPU host from nothing to a running agent. It finds
// the GPU services, asks four questions, writes the config, env file and
// systemd unit, starts the agent and pairs the first Telegram user. An
// existing config is kept unless --reconfigure; the rest is redone each run.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { agentClient, overHttp } from "./api.ts";
import { type Config, type ConfigSource, parseConfig } from "./config.ts";
import { type Found, discover } from "./discover.ts";
import { plugins, probeService } from "./plugins/index.ts";
import type { Run } from "./plugins/types.ts";
import { proposeService, serviceName } from "./settings.ts";

type SourceService = ConfigSource["services"][number];

export const paths = {
  config: "/etc/kilnhush/kilnhush.yaml",
  env: "/etc/kilnhush/env",
  unit: "/etc/systemd/system/kilnhush.service",
};

const listen = "0.0.0.0:7340";
/** Plugins whose first start loads a model, which can take minutes. */
const slowStart = new Set(["ollama", "llamacpp", "vllm"]);

/** What the wizard offers: one found unit or container, or all Wyoming ones as a single voice service. */
export type Candidate = { label: string; plugin: string; found: Found[] };

export function candidates(found: Found[]): Candidate[] {
  const known = found.filter((f) => f.plugin !== null);
  const voice = known.filter((f) => f.plugin === "wyoming");
  const one = (f: Found): Candidate => ({ label: f.owner.name, plugin: f.plugin ?? "custom", found: [f] });
  // Speech-to-text and text-to-speech serve one Home Assistant pipeline, so they share the card as a group.
  // Only members with a port of their own join: the port is how each member's health is checked.
  // The rest, like stopped units that listen on nothing, are offered one by one.
  const taken = new Set<number>();
  const member = voice.filter((f) => {
    const port = f.ports[0];
    if (port === undefined || taken.has(port)) return false;
    taken.add(port);
    return true;
  });
  const grouped = member.length > 1 ? [{ label: `voice (${member.map((f) => f.owner.name).join(", ")})`, plugin: "wyoming", found: member }] : member.map(one);
  const loose = voice.filter((f) => !member.includes(f)).map(one);
  return [...known.filter((f) => f.plugin !== "wyoming").map(one), ...grouped, ...loose];
}

/**
 * The config for the picked services. Order is manual, then on_demand, then
 * the home, so requests can always take the card from home. `busy`: ports
 * something already listens on, which proxies avoid.
 */
export function planConfig(picked: Candidate[], home: Candidate | null, busy: ReadonlySet<number>, previous: Config | null = null): ConfigSource {
  const services: SourceService[] = [];
  const view = { port: Number(listen.split(":")[1]), services };
  // A service set up before keeps its name, URL and proxy port, so its clients keep working.
  const before = (f: Found) => {
    const key = f.owner.kind === "unit" ? `unit:${f.owner.name}` : `container:${f.owner.name}`;
    const old = previous?.services.find((s) => s.procs.length === 1 && s.procs[0]?.key === key);
    return old && previous?.source.services.find((s) => s.name === old.name);
  };
  const reserved = new Set([...busy, ...(previous?.services.flatMap((s) => (s.proxy ? [s.proxy] : [])) ?? [])]);
  for (const c of picked) {
    const plugin = plugins.get(c.plugin);
    const run: Run = c === home ? "always" : plugin?.run === "always" ? "on_demand" : (plugin?.run ?? "on_demand");
    const [first] = c.found;
    if (!first) continue;
    if (c.found.length > 1) {
      const names = new Set(services.map((s) => s.name));
      const port = (f: Found) => f.ports[0];
      services.push({
        name: serviceName("voice", names),
        plugin: c.plugin,
        run,
        url: `http://127.0.0.1:${port(first)}`,
        group: c.found.map((f) => ({
          ...(f.owner.kind === "unit" ? { unit: f.owner.name } : { container: f.owner.name }),
          health: `tcp://127.0.0.1:${port(f)}`,
        })),
      });
      continue;
    }
    const old = before(first);
    const proposed = { ...proposeService(first, view, reserved), ...(old && { name: old.name, ...(old.url && { url: old.url }), ...(old.proxy && { proxy: old.proxy }) }) };
    services.push({
      ...proposed,
      run,
      ...(slowStart.has(proposed.plugin) && { ready_timeout: "5m" }),
      // Jupyter needs its token to see running cells; setup leaves a JUPYTER_TOKEN line in the env file.
      ...(proposed.plugin === "jupyter" && { token_env: "JUPYTER_TOKEN" }),
    });
  }
  const rank = { manual: 0, on_demand: 1, always: 2 } as const;
  services.sort((a, b) => rank[a.run ?? "on_demand"] - rank[b.run ?? "on_demand"]);
  const users = previous?.users ?? [];
  return { listen, ...(users.length > 0 && { telegram: { users } }), services };
}

/** The systemd unit that runs the agent. The name matters: discovery skips kilnhush.service. */
export function agentUnit(node: string, cli: string, config: string) {
  return `[Unit]
Description=kilnhush GPU scheduler
After=network-online.target docker.service

[Service]
ExecStart=${node} ${cli} agent --config ${config}
EnvironmentFile=${paths.env}
Restart=on-failure
RestartSec=5
# If the agent dies without cleaning up, systemd kills its whole cgroup,
# including command services in their own process groups.
KillMode=control-group

[Install]
WantedBy=multi-user.target
`;
}

/** KEY=value lines of an env file; empty when it is missing or unreadable. */
export function readEnvFile(path: string): Record<string, string> {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      return m ? [[m[1], m[2]!.trim()]] : [];
    }),
  );
}

/** Numbered choices like "1,3", or "" for `fallback`. Returns the indexes, or null when unreadable. */
export function parseChoice(answer: string, count: number, fallback: number[]): number[] | null {
  if (answer.trim() === "") return fallback;
  const picked = answer.split(/[\s,]+/).filter(Boolean).map((n) => Number(n) - 1);
  return picked.every((i) => Number.isInteger(i) && i >= 0 && i < count) ? [...new Set(picked)] : null;
}

const exec = promisify(execFile);
const sh = async (cmd: string, args: string[]) => (await exec(cmd, args, { timeout: 60_000 })).stdout;

export async function setup(opts: { reconfigure: boolean; gpu: number }) {
  if (process.getuid?.() !== 0) throw new Error("setup manages system units; run it with sudo");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, fallback = "") => (await rl.question(fallback ? `${question} [${fallback}] ` : `${question} `)).trim() || fallback;
  const say = (text = "") => console.log(text);
  let agentStopped = false;

  try {
    await mkdir("/etc/kilnhush", { recursive: true, mode: 0o755 });
    const existing = await readFile(paths.config, "utf8").catch(() => null);
    const previous = existing === null ? null : parseOr(existing, opts.reconfigure);
    const env = readEnvFile(paths.env);
    // Probes read service tokens, like Jupyter's, from the environment.
    for (const [key, value] of Object.entries(env)) process.env[key] ??= value;

    let config;
    let bootOff: Found[] = [];
    /** The config and unit this run replaced, put back if the new agent does not come up. */
    let replaced: { config: string; unit: string | null } | null = null;
    if (previous && !opts.reconfigure) {
      config = previous;
      say(`Keeping ${paths.config}. Run \`kilnhush setup --reconfigure\` to start over.`);
    } else {
      // A running agent would start home again while services stop, and its proxies would read as busy ports.
      if (previous) agentStopped = await sh("systemctl", ["stop", "kilnhush.service"]).then(() => true, () => false);
      const plan = await wizard(opts.gpu, previous, ask, say);
      const text = `# kilnhush config. The bot edits this file; hand edits are fine, then run \`kilnhush reload\`.\n${stringify(plan.source)}`;
      config = parseConfig(text);
      for (const f of plan.stop) await stopSafely(f, config, ask, say);
      if (existing !== null) {
        await copyFile(paths.config, `${paths.config}.bak`);
        replaced = { config: existing, unit: await readFile(paths.unit, "utf8").catch(() => null) };
      }
      await writeFile(paths.config, text, { mode: 0o644 });
      say(`Wrote ${paths.config}.`);
      bootOff = plan.bootOff;
    }

    const values: Record<string, string> = {};
    if (!env.KILNHUSH_TOKEN) values.KILNHUSH_TOKEN = randomBytes(24).toString("base64url");
    if (!env.KILNHUSH_TG_TOKEN) {
      say("\nThe bot is how you manage kilnhush. Create one with @BotFather in Telegram and paste its token (empty to skip).");
      values.KILNHUSH_TG_TOKEN = await ask("Bot token:");
    }
    if (config.services.some((s) => s.tokenEnv === "JUPYTER_TOKEN") && !env.JUPYTER_TOKEN) {
      values.JUPYTER_TOKEN = "";
      say(`Put Jupyter's token in ${paths.env} (JUPYTER_TOKEN=), or kilnhush cannot tell when cells run.`);
    }
    Object.assign(env, values);
    const envText = await readFile(paths.env, "utf8").catch(() => "");
    // The file holds the API and bot tokens: root only, whatever mode it had.
    await writeFile(paths.env, setEnv(envText, values), { mode: 0o600 });
    await chmod(paths.env, 0o600);

    await writeFile(paths.unit, agentUnit(process.execPath, realpathSync(process.argv[1] ?? ""), paths.config));
    await sh("systemctl", ["daemon-reload"]);
    await sh("systemctl", ["enable", "kilnhush.service"]);
    await sh("systemctl", ["restart", "kilnhush.service"]);
    agentStopped = false;
    const client = agentClient(overHttp(`http://${localAddress(config.listen)}`, env.KILNHUSH_TOKEN));
    // The agent listens once a service it found running is healthy, and a model can take minutes to load.
    const state = await waitFor(Math.max(60_000, ...config.services.map((s) => s.readyTimeout)) + 10_000, () => client.state());
    if (!state) {
      let restored = "";
      if (replaced) {
        await writeFile(paths.config, replaced.config);
        if (replaced.unit !== null) await writeFile(paths.unit, replaced.unit);
        await sh("systemctl", ["daemon-reload"]);
        await sh("systemctl", ["restart", "kilnhush.service"]).catch(() => {});
        restored = ` The old config is back in place and the agent restarted with it; the new one is in ${paths.config}.new.`;
        await writeFile(`${paths.config}.new`, stringify(config.source));
      }
      throw new Error(`the agent did not come up; see \`journalctl -u kilnhush -n 50\`. Boot settings were left as they were.${restored}`);
    }
    say(`\nkilnhush is running; ${state.holder ?? "no service"} holds the card.`);

    // Only now that the agent runs: until then, these services still have to start on their own.
    for (const f of bootOff) {
      if (f.owner.kind === "unit") await sh("systemctl", ["disable", f.owner.name]);
      // Docker restarts containers with a restart policy at boot, whatever systemd does.
      else await sh("docker", ["update", "--restart=no", f.owner.name]);
    }

    if (env.KILNHUSH_TG_TOKEN) {
      const users = await usersNow(client);
      if (users.length === 0) await pair(client, say);
      else say(`${users.length} Telegram user(s) can use the bot. Add more with \`sudo kilnhush pair\`.`);
    }
    await firewallHint(config.port, config.services.flatMap((s) => (s.proxy ? [s.proxy] : [])), say);

    const moved = config.services.filter((s) => s.proxy && s.url);
    if (moved.length > 0) {
      say("\nPoint clients at the proxies, so their requests wake the services:");
      for (const s of moved) say(`  ${s.name}: ${new URL(s.url ?? "").port} → ${hostname()}:${s.proxy}`);
    }
  } finally {
    rl.close();
    // Setup gave up after stopping the agent: bring the old one back.
    if (agentStopped) await sh("systemctl", ["start", "kilnhush.service"]).catch(() => {});
  }
}

/** The existing config, or null when it is broken and about to be replaced anyway. */
function parseOr(text: string, replacing: boolean) {
  try {
    return parseConfig(text);
  } catch (err) {
    if (replacing) return null;
    throw new Error(`${paths.config} is broken; fix it or run \`kilnhush setup --reconfigure\`.\n${(err as Error).message}`);
  }
}

/** Where to reach an agent listening on `listen` from this host. */
export function localAddress(listen: string) {
  const url = new URL(`http://${listen}`);
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  return url.host;
}

/** `text` with each key in `values` set once: replaced where it was, else appended. Other lines stay. */
export function setEnv(text: string, values: Record<string, string>) {
  const out: string[] = [];
  const done = new Set<string>();
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    const key = /^([A-Z_][A-Z0-9_]*)=/.exec(line)?.[1];
    if (key === undefined || !(key in values)) {
      if (line !== "" || out.length > 0) out.push(line);
    } else if (!done.has(key)) {
      out.push(`${key}=${values[key]}`);
      done.add(key);
    }
  }
  for (const [key, value] of Object.entries(values)) if (!done.has(key)) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

/** Asks the setup questions. Returns the new config and what to stop now and keep from starting at boot. */
async function wizard(gpu: number, previous: Config | null, ask: (q: string, fallback?: string) => Promise<string>, say: (text?: string) => void) {
  say("Looking for GPU services…");
  const found = candidates((await discover(gpu, plugins.values())).found);
  if (found.length === 0) throw new Error("found no service kilnhush has a plugin for; write the config by hand, see examples/");
  found.forEach((c, i) => say(`  ${i + 1}. ${c.label}  ${plugins.get(c.plugin)?.name ?? c.plugin}${c.found.some((f) => f.active) ? ", running" : ""}`));

  let picked: Candidate[] = [];
  while (picked.length === 0) {
    const answer = await ask("Which should kilnhush manage?", found.map((_, i) => i + 1).join(","));
    picked = (parseChoice(answer, found.length, []) ?? []).map((i) => found[i]!);
    if (picked.length === 0) say("Give numbers from the list, like 1,3.");
  }

  const voice = picked.findIndex((c) => c.plugin === "wyoming");
  say("\nOne service can run whenever nothing else needs the card, like voice for Home Assistant.");
  picked.forEach((c, i) => say(`  ${i + 1}. ${c.label}`));
  let home: Candidate | null = null;
  for (;;) {
    const answer = await ask("Which one runs always?", voice === -1 ? "none" : String(voice + 1));
    if (answer === "none") break;
    const i = parseChoice(answer, picked.length, []);
    if (i?.length === 1) {
      home = picked[i[0]!]!;
      break;
    }
    say("Give one number, or none.");
  }

  let stop: Found[] = [];
  const running = picked.filter((c) => c.found.some((f) => f.active));
  if (running.length > 1) {
    say("\nOnly one service may hold the card, but these run now:");
    running.forEach((c, i) => say(`  ${i + 1}. ${c.label}`));
    let keep: number[] | null = null;
    while (keep?.length !== 1) keep = parseChoice(await ask("Which one keeps running?", "1"), running.length, [0]);
    stop = running.filter((_, i) => i !== keep[0]).flatMap((c) => c.found.filter((f) => f.active));
  }

  const boot = (await ask("\nkilnhush starts these services from now on. Stop them from starting at boot by themselves? [Y/n]", "y")).toLowerCase();
  if (!boot.startsWith("y")) say("If two of them start at boot, the agent refuses to guess and waits for you to stop one.");
  const bootOff = boot.startsWith("y") ? picked.flatMap((c) => c.found) : [];

  const busy = new Set((await sh("ss", ["-ltnH"]).catch(() => "")).split("\n").flatMap((row) => {
    const local = row.trim().split(/\s+/)[3] ?? "";
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    return port ? [port] : [];
  }));
  const source = planConfig(picked, home, busy, previous);
  if (gpu !== 0) source.gpu = gpu;
  return { source, stop, bootOff };
}

/** Stops a service that must not hold the card, after asking when it may be doing work. */
async function stopSafely(f: Found, config: Config, ask: (q: string, fallback?: string) => Promise<string>, say: (text?: string) => void) {
  const key = f.owner.kind === "unit" ? `unit:${f.owner.name}` : `container:${f.owner.name}`;
  const spec = config.services.find((s) => s.procs.some((p) => p.key === key));
  const activity = spec ? await probeService(spec).catch(() => null) : null;
  if (!activity || activity.busy || activity.risks.length > 0) {
    say(activity ? `\n${f.owner.name} is busy:\n${activity.risks.map((r) => `- ${r}`).join("\n")}` : `\nkilnhush can't tell whether ${f.owner.name} is doing work.`);
    const answer = (await ask(`Stop ${f.owner.name} now? Running work dies. [y/N]`, "n")).toLowerCase();
    if (!answer.startsWith("y")) throw new Error(`stop ${f.owner.name} when it is done, then run setup again. Nothing was changed.`);
  }
  if (f.owner.kind === "unit") await sh("systemctl", ["stop", f.owner.name]);
  else await sh("docker", ["stop", f.owner.name]);
}

/** Prints the pairing link and waits until someone uses it, up to 10 minutes. */
async function pair(client: ReturnType<typeof agentClient>, say: (text?: string) => void) {
  const before = await usersNow(client);
  // The agent learns the bot's username just after it starts; the link needs it.
  let code = await client.pair();
  for (let i = 0; !code.link && i < 10; i++) {
    await sleep(1_000);
    code = await client.pair();
  }
  say(code.link ? `\nOpen ${code.link} and press Start.` : `\nSend /start ${code.code} to your bot.`);
  say("Waiting for you in Telegram…");
  const joined = await waitFor(10 * 60_000, async () => (await usersNow(client)).find((u) => !before.includes(u)));
  say(joined ? `Paired Telegram user ${joined}. Add others later from the bot or with \`kilnhush pair\`.` : "No one paired. Run `sudo kilnhush pair` for a new link.");
}

async function usersNow(client: ReturnType<typeof agentClient>) {
  const view = await client.settings("view");
  return view.ok ? view.view.users : [];
}

async function firewallHint(port: number, proxies: number[], say: (text?: string) => void) {
  const ports = [port, ...proxies];
  const ufw = await sh("ufw", ["status"]).catch(() => "");
  if (/Status: active/.test(ufw)) say(`\nufw is on. To let clients in: sudo ufw allow ${ports.join(",")}/tcp`);
  const firewalld = await sh("firewall-cmd", ["--state"]).catch(() => "");
  if (firewalld.trim() === "running") {
    say(`\nfirewalld is on. To let clients in:\n${ports.map((p) => `  sudo firewall-cmd --permanent --add-port=${p}/tcp`).join("\n")}\n  sudo firewall-cmd --reload`);
  }
}

/** Calls `f` once a second until it returns something other than undefined, or time runs out. */
async function waitFor<T>(ms: number, f: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await f().catch(() => undefined);
    if (value !== undefined || Date.now() > deadline) return value;
    await sleep(1_000);
  }
}
