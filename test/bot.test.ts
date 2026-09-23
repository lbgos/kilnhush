import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentClient, State, SwitchResult } from "../src/api.ts";
import { Bot, type Telegram } from "../src/bot.ts";

const state = (over: Partial<State> = {}): State => ({
  mode: "jupyter",
  switching: null,
  default: "voice",
  modes: ["voice", "llm", "jupyter"],
  since: 0,
  busy: false,
  risks: [],
  lastActive: 0,
  reminderDue: false,
  gpu: null,
  events: [],
  ...over,
});

function setup(switchResults: SwitchResult[], current = state()) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const switches: [string, boolean][] = [];
  const tg = (async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    return true;
  }) as Telegram;
  const agent: AgentClient = {
    state: async () => current,
    switch: async (mode, force = false) => {
      switches.push([mode, force]);
      const next = switchResults.shift();
      assert.ok(next, "unexpected switch");
      return next;
    },
  };
  return { bot: new Bot(tg, agent, new Set([42]), () => {}), calls, switches };
}

const press = (data: string, from = 42) => ({
  update_id: 1,
  callback_query: { id: "q", from: { id: from }, data, message: { chat: { id: 42 }, message_id: 7 } },
});

test("a busy mode gets a force button instead of a stop", async () => {
  const t = setup([
    { ok: false, busy: { mode: "jupyter", risks: ["train.ipynb: cell running"] } },
    { ok: true, state: state({ mode: "voice" }) },
  ]);

  await t.bot.handle(press("sw:voice"));
  const warning = t.calls.at(-1);
  assert.match(String(warning?.body.text), /jupyter is busy:\n- train.ipynb: cell running/);
  assert.deepEqual(warning?.body.reply_markup, {
    inline_keyboard: [[{ text: "Force → voice", callback_data: "fsw:voice" }], [{ text: "Cancel", callback_data: "st" }]],
  });

  await t.bot.handle(press("fsw:voice"));
  assert.deepEqual(t.switches, [
    ["voice", false],
    ["voice", true],
  ]);
});

test("strangers cannot switch", async () => {
  const t = setup([]);
  await t.bot.handle(press("fsw:voice", 666));
  assert.deepEqual(t.switches, []);
  assert.equal(t.calls[0]?.method, "answerCallbackQuery");
});

test("one reminder per idle stretch, and it only asks", async () => {
  const t = setup([], state({ reminderDue: true, lastActive: 1000 }));
  await t.bot.remind(1000 + 3 * 3_600_000);
  await t.bot.remind(1000 + 4 * 3_600_000);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]?.body.text, "jupyter idle for 3h00m. voice is off while it runs.");
  assert.deepEqual(t.switches, []);
});
