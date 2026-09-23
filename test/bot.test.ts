import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionResult, AgentClient, State } from "../src/api.ts";
import { Bot, type Telegram } from "../src/bot.ts";

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
  events: [],
  ...over,
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
  const agent: Pick<AgentClient, "state" | "start" | "stop"> = { state: async () => current, start: act("start"), stop: act("stop") };
  return { bot: new Bot(tg, agent, new Set([42]), () => {}), calls, actions };
}

const press = (data: string, from = 42) => ({
  update_id: 1,
  callback_query: { id: "q", from: { id: from }, data, message: { chat: { id: 42 }, message_id: 7 } },
});

test("a busy service gets a force button instead of a stop", async () => {
  const t = setup([
    { ok: false, busy: { service: "jupyter", risks: ["train.ipynb: cell running"] } },
    { ok: true, state: state({ holder: null }) },
  ]);

  await t.bot.handle(press("halt:jupyter"));
  const warning = t.calls.at(-1);
  assert.match(String(warning?.body.text), /jupyter is busy:\n- train.ipynb: cell running/);
  assert.deepEqual(warning?.body.reply_markup, {
    inline_keyboard: [[{ text: "Force stop jupyter", callback_data: "fhalt:jupyter" }], [{ text: "Cancel", callback_data: "st" }]],
  });

  await t.bot.handle(press("fhalt:jupyter"));
  assert.deepEqual(t.actions, ["stop jupyter", "stop jupyter forced"]);
});

test("the status card has a stop button for the holder and start buttons for the rest", async () => {
  const t = setup([]);
  await t.bot.handle({ update_id: 1, message: { chat: { id: 42 }, from: { id: 42 }, text: "/start" } });
  assert.deepEqual(t.calls[0]?.body.reply_markup, {
    inline_keyboard: [
      [
        { text: "■ jupyter", callback_data: "halt:jupyter" },
        { text: "▶ llm", callback_data: "go:llm" },
        { text: "▶ voice", callback_data: "go:voice" },
      ],
      [{ text: "Refresh", callback_data: "st" }],
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
  const agent: Pick<AgentClient, "state" | "start" | "stop"> = {
    state: async () => state({ holder: "voice" }),
    start: async (service, force = false) => {
      order.push(`start ${service} ${force}`);
      return { ok: true, state: state({ holder: service }) };
    },
    stop: async () => ({ ok: false, error: "unexpected" }),
  };
  await new Bot(tg, agent, new Set([42]), () => {}).run(controller.signal);
  assert.deepEqual(order.slice(0, 4), ["poll 0/50", "poll 2/0", "answer", "start voice true"]);
  assert.ok(order.indexOf("poll 3/0") < order.lastIndexOf("answer"), "update 2 confirmed before it was handled");
});
