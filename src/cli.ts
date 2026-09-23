#!/usr/bin/env node
// Entry point: `kilnhush agent|bot|status|switch|fake`.
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { Agent } from "./agent.ts";
import { agentClient } from "./api.ts";
import { Bot, telegram } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { fakeJupyter, fakeLlama } from "./fake.ts";
import { formatState } from "./format.ts";
import { probeJupyter, readGpu } from "./probe.ts";
import { createAgentServer } from "./server.ts";
import { createService } from "./services.ts";

const usage = `kilnhush agent  --config kilnhush.yaml     run on the GPU host
kilnhush bot                              Telegram bot, configured by env
kilnhush status                           print the agent's state
kilnhush switch <mode> [--force]          switch modes
kilnhush fake llama|jupyter --port N      stand-ins for the demo

env: KILNHUSH_TOKEN      agent API token (required when the agent listens beyond loopback)
     KILNHUSH_AGENT      agent URL for bot/status/switch, default http://127.0.0.1:7340
     KILNHUSH_TG_TOKEN   Telegram bot token
     KILNHUSH_TG_USERS   comma-separated Telegram user ids allowed to use the bot`;

const log = (msg: string) => console.error(`${new Date().toISOString()} ${msg}`);

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", default: "kilnhush.yaml" },
    force: { type: "boolean", default: false },
    port: { type: "string" },
    "load-ms": { type: "string" },
    "reply-ms": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const token = process.env.KILNHUSH_TOKEN || undefined;
const client = () => agentClient(process.env.KILNHUSH_AGENT ?? "http://127.0.0.1:7340", token);
const [command, arg] = positionals;

async function agent() {
  const config = loadConfig(opts.config);
  const url = new URL(`http://${config.listen}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (!loopback && !token) throw new Error(`listening on ${config.listen} needs KILNHUSH_TOKEN`);

  const agent = new Agent(config, { service: createService, jupyter: probeJupyter, gpu: readGpu, now: Date.now, log });
  await agent.init();
  const server = createAgentServer(agent, token);
  server.listen(Number(url.port), host, () => log(`listening on ${config.listen}, mode ${agent.current}`));
  const timer = setInterval(() => agent.tick().catch((err: Error) => log(`tick: ${err.message}`)), config.tick);

  const stop = async () => {
    clearInterval(timer);
    server.close();
    await agent.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function bot() {
  const tgToken = process.env.KILNHUSH_TG_TOKEN;
  const users = new Set((process.env.KILNHUSH_TG_USERS ?? "").split(",").filter(Boolean).map(Number));
  if (!tgToken || users.size === 0) throw new Error("set KILNHUSH_TG_TOKEN and KILNHUSH_TG_USERS");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  log(`bot for ${users.size} user(s)`);
  await new Bot(telegram(tgToken), client(), users, log).run(controller.signal);
}

async function main() {
  if (opts.help || !command) return console.log(usage);
  switch (command) {
    case "agent":
      return agent();
    case "bot":
      return bot();
    case "status":
      return console.log(formatState(await client().state()));
    case "switch": {
      if (!arg) throw new Error("switch needs a mode");
      const result = await client().switch(arg, opts.force);
      if (result.ok) return console.log(formatState(result.state));
      if ("busy" in result) {
        console.log(`${result.busy.mode} is busy:\n${result.busy.risks.map((r) => `- ${r}`).join("\n")}\nrerun with --force to stop it anyway`);
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
