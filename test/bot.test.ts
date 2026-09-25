import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "../src/agent.ts";
import { type ActionResult, type State, agentClient } from "../src/api.ts";
import { Bot, type BotAgent, type Telegram, clip } from "../src/bot.ts";
import { parseConfig } from "../src/config.ts";
import { Pairing } from "../src/pairing.ts";
import type { Runner } from "../src/runners.ts";
import { ConfigStore, settingsView } from "../src/settings.ts";
import { apiRoutes } from "../src/server.ts";

const info = (name: string, run: State["services"][number]["run"]) => ({ name, plugin: "Custom", run, idle: 0, proxy: null, models: [] });

const state = (over: Partial<State> = {}): State => ({
  holder: "jupyter",
  switching: null,
  home: "voice",
  homePaused: false,
  pinned: false,
  services: [info("jupyter", "manual"), info("llm", "on_demand"), info("voice", "always")],
  warnings: [],
  since: 0,
  busy: false,
  risks: [],
  lastActive: 0,
  reminderDue: false,
  gpu: null,
  host: "gpu-host",
  vram: null,
  unmanaged: [],
  events: [],
  ...over,
});

const yaml = `telegram: { users: [42] }
services:
  - { name: jupyter, run: manual, unit: jupyter }
  - { name: llm, unit: bonsai, idle: 20m }
  - { name: voice, run: always, unit: whisper }
`;

/** A client that answers settings from `yaml` and state from the test. */
const fakeAgent = (over: Pick<BotAgent, "state" | "start" | "stop">): BotAgent => ({
  ...over,
  settings: async (action) => (action === "view" ? { ok: true, view: settingsView(parseConfig(yaml)) } : { ok: false, error: "read only" }),
  discover: async () => ({ found: [], unmanaged: [] }),
});

function setup(results: ActionResult[], current = state()) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const actions: string[] = [];
  const tg = (async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    return true;
  }) as Telegram;
  const act = (verb: string) => async (service: string, force = false) => {
    actions.push(`${verb} ${service}${force ? " forced" : ""}`);
    const next = results.shift();
    assert.ok(next, "unexpected action");
    return next;
  };
  const agent = fakeAgent({ state: async () => current, start: act("start"), stop: act("stop") });
  return { bot: new Bot(tg, agent, () => {}), calls, actions };
}

const press = (data: string, from = 42) => ({
  update_id: 1,
  callback_query: { id: "q", from: { id: from }, data, message: { chat: { id: 42, type: "private" }, message_id: 7 } },
});

test("a busy service gets a force button instead of a stop", async () => {
  const t = setup([
    { ok: false, busy: { service: "jupyter", risks: ["train.ipynb: cell running"] } },
    { ok: true, state: state({ holder: null }) },
  ]);

  await t.bot.handle(press("halt:jupyter"));
  const warning = t.calls.at(-1);
  assert.match(String(warning?.body.text), /jupyter is busy:\n- train.ipynb: cell running\n\nForce stop jupyter\?/);
  assert.deepEqual(warning?.body.reply_markup, {
    inline_keyboard: [[{ text: "Force stop jupyter", callback_data: "fhalt:jupyter" }], [{ text: "Cancel", callback_data: "st" }]],
  });

  await t.bot.handle(press("fhalt:jupyter"));
  assert.deepEqual(t.actions, ["stop jupyter", "stop jupyter forced"]);
});

test("the status card has a stop button for the holder and start buttons for the rest", async () => {
  const t = setup([]);
  await t.bot.handle({ update_id: 1, message: { chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/start" } });
  assert.deepEqual(t.calls[0]?.body.reply_markup, {
    inline_keyboard: [
      [
        { text: "■ jupyter", callback_data: "halt:jupyter" },
        { text: "▶ llm", callback_data: "go:llm" },
        { text: "▶ voice", callback_data: "go:voice" },
      ],
      [
        { text: "Refresh", callback_data: "st" },
        { text: "⚙ Settings", callback_data: "set" },
      ],
    ],
  });
});

test("strangers cannot switch", async () => {
  const t = setup([]);
  await t.bot.handle(press("fhalt:jupyter", 666));
  assert.deepEqual(t.actions, []);
  assert.equal(t.calls[0]?.method, "answerCallbackQuery");
});

test("one reminder per idle stretch, and it only asks", async () => {
  const t = setup([], state({ reminderDue: true, lastActive: 1000 }));
  await t.bot.remind(1000 + 3 * 3_600_000);
  await t.bot.remind(1000 + 4 * 3_600_000);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]?.body.text, "jupyter idle for 3h00m. voice is off while it runs.");
  assert.deepEqual(t.actions, []);
});

test("each update is confirmed with Telegram before the bot acts on it", async () => {
  const controller = new AbortController();
  const order: string[] = [];
  const u1 = press("fgo:voice");
  const u2 = { ...press("st"), update_id: 2 };
  const polls: Record<string, unknown[]> = { "0/50": [u1, u2], "2/0": [u2], "3/0": [] };
  const tg = (async (method: string, body: { offset?: number; timeout?: number }) => {
    if (method === "getUpdates") {
      const key = `${body.offset}/${body.timeout}`;
      order.push(`poll ${key}`);
      if (!(key in polls)) {
        controller.abort();
        return [];
      }
      return polls[key];
    }
    if (method === "answerCallbackQuery") order.push("answer");
    return true;
  }) as Telegram;
  const agent = fakeAgent({
    state: async () => state({ holder: "voice" }),
    start: async (service, force = false) => {
      order.push(`start ${service} ${force}`);
      return { ok: true, state: state({ holder: service }) };
    },
    stop: async () => ({ ok: false, error: "unexpected" }),
  });
  await new Bot(tg, agent, () => {}).run(controller.signal);
  assert.deepEqual(order.slice(0, 4), ["poll 0/50", "poll 2/0", "answer", "start voice true"]);
  assert.ok(order.indexOf("poll 3/0") < order.lastIndexOf("answer"), "update 2 confirmed before it was handled");
});

/** The real agent and settings API in-process, as `kilnhush agent` runs the bot, with a fake Telegram. */
async function live() {
  const dir = await mkdtemp(join(tmpdir(), "kilnhush-"));
  const path = join(dir, "kilnhush.yaml");
  await writeFile(path, yaml);
  const store = await ConfigStore.load(path);
  const runner = (spec: { key: string; name: string }): Runner => ({
    key: spec.key,
    name: spec.name,
    active: async () => false,
    start: async () => {},
    stop: async () => {},
  });
  let now = 1_000_000;
  const agent = new Agent(store.config, {
    runner,
    probe: async () => null,
    gpu: async () => null,
    gpuProcesses: async () => [],
    host: "gpu-host",
    now: () => now,
    sleep: async () => {},
    log: () => {},
  });
  const pairing = new Pairing(() => now);
  const client = agentClient(
    apiRoutes(agent, { store, pairing, hostHas: async () => true, portFree: async () => true, discover: async () => ({ found: [], unmanaged: [] }) }),
  );
  const sent: { method: string; body: { text?: string; reply_markup?: { inline_keyboard: { callback_data: string }[][] } } }[] = [];
  const tg = (async (method: string, body: (typeof sent)[number]["body"]) => {
    sent.push({ method, body });
    return true;
  }) as Telegram;
  const bot = new Bot(tg, client, () => {});
  const say = (from: number, text: string) => bot.handle({ update_id: 1, message: { chat: { id: from, type: "private" }, from: { id: from }, text } });
  const file = async () => parseConfig(await readFile(path, "utf8"));
  return { bot, client, sent, say, file, path, advance: (ms: number) => (now += ms) };
}

test("long screens fit Telegram's limit and keep their question", () => {
  const text = clip(`${"- risk\n".repeat(1000)}Force stop jupyter?`);
  assert.ok(text.length <= 4096);
  assert.match(text, /Force stop jupyter\?$/);
});

test("the bot stays silent in groups, even for its users", async () => {
  const t = await live();
  await t.bot.handle({ update_id: 1, message: { chat: { id: -100, type: "group" }, from: { id: 42 }, text: "/start" } });
  assert.deepEqual(t.sent, []);
});

test("a pairing code lets one stranger in once, and strangers see nothing else", async () => {
  const t = await live();
  const refused = "Run kilnhush pair on the GPU host to get access.";

  await t.say(7, "/start");
  await t.say(7, "/start wrongcode");
  assert.deepEqual(
    t.sent.map((c) => c.body),
    [{ chat_id: 7, text: refused }, { chat_id: 7, text: refused }],
  );

  const { code, link } = await t.client.pair();
  assert.match(code, /^[a-z2-7]{8}$/);
  assert.equal(link, null, "no link before the bot's username is known");
  // A hand edit makes the write fail; the code still works after a reload.
  await writeFile(t.path, `${await readFile(t.path, "utf8")}\n`);
  await t.say(7, `/start ${code}`);
  assert.deepEqual((await t.file()).users, [42]);
  await t.client.settings("reload");
  await t.say(7, `/start ${code}`);
  assert.deepEqual((await t.file()).users, [42, 7]);
  assert.match(String(t.sent.at(-1)?.body.text), /jupyter/, "the new user gets the home screen");

  await t.say(8, `/start ${code}`);
  assert.equal(t.sent.at(-1)?.body.text, refused, "a used code is gone");
  const late = await t.client.pair();
  t.advance(11 * 60_000);
  await t.say(8, `/start ${late.code}`);
  assert.equal(t.sent.at(-1)?.body.text, refused, "an expired code is refused");
  assert.deepEqual((await t.file()).users, [42, 7]);
});

test("settings buttons edit the config file, and a refused edit says why on the same screen", async () => {
  const t = await live();
  const press = (data: string) =>
    t.bot.handle({ update_id: 1, callback_query: { id: "q", from: { id: 42 }, data, message: { chat: { id: 42, type: "private" }, message_id: 7 } } });
  const screen = () => t.sent.filter((c) => c.method === "editMessageText").at(-1)?.body;

  await press("set");
  assert.deepEqual(
    screen()?.reply_markup?.inline_keyboard.slice(0, 3).map(([b]) => b?.callback_data),
    ["svc:jupyter", "svc:llm", "svc:voice"],
  );
  await press("up:llm");
  await press("run:jupyter:on_demand");
  await press("idle:jupyter:15m");
  const config = await t.file();
  assert.deepEqual(
    config.services.map((s) => [s.name, s.run, s.idle / 60_000]),
    [
      ["llm", "on_demand", 20],
      ["jupyter", "on_demand", 15],
      ["voice", "always", 0],
    ],
  );
  assert.match(String(screen()?.text), /^jupyter · 2 of 3\n/);

  await press("idle:voice:5m");
  assert.match(String(screen()?.text), /^voice · 3 of 3\n[^]*idle only applies to run: on_demand$/);
});
