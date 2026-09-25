#!/usr/bin/env node
// Entry point: `kilnhush setup|agent|bot|pair|status|start|stop|reload|fake`.
import { isIP } from "node:net";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Agent } from "./agent.ts";
import { type ActionResult, agentClient, overHttp } from "./api.ts";
import { Bot, telegram } from "./bot.ts";
import { fakeJupyter, fakeLlama } from "./fake.ts";
import { formatState } from "./format.ts";
import { readGpu } from "./probe.ts";
import { apiRoutes, createAgentServer } from "./server.ts";
import { discover, gpuProcesses } from "./discover.ts";
import { Pairing } from "./pairing.ts";
import { plugins, probeService } from "./plugins/index.ts";
import { portFree, proxyPool } from "./proxy.ts";
import { createRunner, hostHas } from "./runners.ts";
import { ConfigStore, type SettingsDeps, reload } from "./settings.ts";
import { paths, readEnvFile, setup } from "./setup.ts";

const usage = `kilnhush setup [--reconfigure] [--gpu N]  find GPU services, install and start the agent (sudo)
kilnhush agent  --config kilnhush.yaml     run on the GPU host, with the bot if KILNHUSH_TG_TOKEN is set
kilnhush bot                              run the bot elsewhere, against KILNHUSH_AGENT
kilnhush pair                             print a link that adds you to the bot
kilnhush status                           print the agent's state
kilnhush start <service> [--force]        give the card to a service
kilnhush stop <service> [--force]         stop the service holding the card
kilnhush reload                           apply a hand-edited config file
kilnhush fake llama|jupyter --port N      stand-ins for the demo

env: KILNHUSH_TOKEN      agent API token (required when the agent listens beyond loopback;
                         read from ${paths.env} when unset and readable)
     KILNHUSH_AGENT      agent URL for bot/status/start/stop, default http://127.0.0.1:7340
     KILNHUSH_TG_TOKEN   Telegram bot token`;

const log = (msg: string) => console.error(`${new Date().toISOString()} ${msg}`);

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "kilnhush.yaml" },
    force: { type: "boolean", default: false },
    reconfigure: { type: "boolean", default: false },
    gpu: { type: "string", default: "0" },
    port: { type: "string" },
    "load-ms": { type: "string" },
    "reply-ms": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const token = process.env.KILNHUSH_TOKEN || readEnvFile(paths.env).KILNHUSH_TOKEN || undefined;
const client = () => agentClient(overHttp(process.env.KILNHUSH_AGENT ?? "http://127.0.0.1:7340", token));
const tgToken = process.env.KILNHUSH_TG_TOKEN || undefined;
const [command, arg] = positionals;

async function agent() {
  const store = await ConfigStore.load(opts.config);
  const { config } = store;
  const url = new URL(`http://${config.listen}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback && !token) throw new Error(`listening on ${config.listen} needs KILNHUSH_TOKEN`);

  for (const warning of config.warnings) log(`config: ${warning}`);
  const agent = new Agent(config, {
    runner: createRunner,
    probe: probeService,
    gpu: () => readGpu(config.gpu),
    gpuProcesses: () => gpuProcesses(config.gpu),
    host: hostname(),
    now: Date.now,
    sleep,
    log,
  });
  await agent.init();
  const settings: SettingsDeps = {
    store,
    hostHas,
    discover: () => discover(agent.config.gpu, plugins.values()),
    portFree: (port) => portFree(port, host),
    pairing: new Pairing(),
  };
  const server = createAgentServer(agent, token, settings);
  server.listen(Number(url.port), host, () => log(`listening on ${config.listen}, ${agent.holder ?? "no service"} holds the card`));
  const proxies = proxyPool(agent, host, log);
  // The next tick waits for this one, so a slow switch never queues ticks up.
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    timer = setTimeout(() => {
      agent
        .tick()
        .catch((err: Error) => log(`tick: ${err.message}`))
        .finally(tick);
    }, agent.config.tick);
  };
  tick();

  const bot = new AbortController();
  if (tgToken) {
    const tg = telegram(tgToken);
    // The username only makes `kilnhush pair` print a t.me link; the bot works without it.
    tg<{ username?: string }>("getMe", {}).then(
      (me) => {
        settings.pairing.bot = me.username ?? null;
        log(`telegram bot @${me.username ?? "?"} started`);
      },
      (err: Error) => log(`telegram: ${err.message}`),
    );
    void new Bot(tg, agentClient(apiRoutes(agent, settings)), log).run(bot.signal);
  }

  const stop = async () => {
    clearTimeout(timer);
    bot.abort();
    // Let proxied responses finish before command services stop, up to 10s.
    const servers = [server, ...proxies.servers()];
    await Promise.race([Promise.all([new Promise((resolve) => server.close(resolve)), proxies.close()]), sleep(10_000)]);
    for (const s of servers) s.closeAllConnections();
    await agent.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.on("SIGHUP", () => {
    reload(agent, store).then(
      () => log("config reloaded"),
      (err: Error) => log(`reload refused: ${err.message}`),
    );
  });
}

/** The bot on another machine than the agent. Users and settings still come from the agent. */
async function bot() {
  if (!tgToken) throw new Error("set KILNHUSH_TG_TOKEN");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  log("bot started");
  await new Bot(telegram(tgToken), client(), log).run(controller.signal);
}

async function main() {
  if (opts.help || !command) return console.log(usage);
  switch (command) {
    case "setup": {
      const gpu = Number(opts.gpu);
      if (!Number.isInteger(gpu) || gpu < 0) throw new Error(`--gpu takes an nvidia-smi index like 0, got ${opts.gpu}`);
      return setup({ reconfigure: opts.reconfigure, gpu });
    }
    case "agent":
      return agent();
    case "bot":
      return bot();
    case "pair": {
      const { code, link } = await client().pair();
      return console.log(`${link ? `open ${link}` : `send /start ${code} to the bot`} within 10 minutes`);
    }
    case "status":
      return console.log(formatState(await client().state()));
    case "reload": {
      const result = await client().settings("reload");
      if (!result.ok) throw new Error(result.error);
      for (const warning of result.view.warnings) console.log(`warning: ${warning}`);
      return console.log("reloaded");
    }
    case "start":
    case "stop": {
      if (!arg) throw new Error(`${command} needs a service`);
      const result: ActionResult = command === "start" ? await client().start(arg, opts.force) : await client().stop(arg, opts.force);
      if (result.ok) return console.log(formatState(result.state));
      if ("busy" in result) {
        console.log(`${result.busy.service} is busy:\n${result.busy.risks.map((r) => `- ${r}`).join("\n")}\nrerun with --force to stop it anyway`);
      } else {
        console.log(`error: ${result.error}`);
      }
      process.exitCode = 1;
      return;
    }
    case "fake": {
      const port = Number(opts.port);
      if (!port) throw new Error("fake needs --port");
      if (arg === "llama") {
        await fakeLlama(port, { loadMs: Number(opts["load-ms"] ?? 0), replyMs: Number(opts["reply-ms"] ?? 500) });
      } else if (arg === "jupyter") {
        await fakeJupyter(port);
      } else {
        throw new Error("fake llama or fake jupyter");
      }
      log(`fake ${arg} on :${port}`);
      return;
    }
    default:
      console.log(usage);
      process.exitCode = 2;
  }
}

main().catch((err: Error) => {
  log(err.message);
  process.exit(1);
});
