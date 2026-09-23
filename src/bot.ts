// Telegram front for one agent. Any message gets a status card with a button
// per mode. A busy mode gets a second, explicit "force" button instead of a
// silent stop. Idle reminders are questions; the bot never switches on its own.
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentClient, State } from "./api.ts";
import { formatDuration, formatState } from "./format.ts";

type Button = { text: string; callback_data: string };
type Keyboard = { inline_keyboard: Button[][] };

type Update = {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
};

export type Telegram = <T = unknown>(method: string, body: object) => Promise<T>;

export function telegram(token: string, baseUrl = "https://api.telegram.org"): Telegram {
  return async <T>(method: string, body: object) => {
    const res = await fetch(`${baseUrl}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  };
}

function modeKeyboard(s: State): Keyboard {
  return {
    inline_keyboard: [
      s.modes.map((m) => ({ text: m === s.mode ? `✓ ${m}` : m, callback_data: `sw:${m}` })),
      [{ text: "Refresh", callback_data: "st" }],
    ],
  };
}

export class Bot {
  #lastReminder = "";

  constructor(
    private tg: Telegram,
    private agent: AgentClient,
    private users: ReadonlySet<number>,
    private log: (msg: string) => void = console.error,
  ) {}

  async handle(update: Update) {
    const msg = update.message;
    if (msg) {
      if (!msg.from || !this.users.has(msg.from.id)) return this.log(`ignored message from ${msg.from?.id}`);
      const s = await this.agent.state();
      await this.tg("sendMessage", { chat_id: msg.chat.id, text: formatState(s), reply_markup: modeKeyboard(s) });
      return;
    }

    const cb = update.callback_query;
    if (!cb?.message || !cb.data) return;
    if (!this.users.has(cb.from.id)) {
      await this.tg("answerCallbackQuery", { callback_query_id: cb.id, text: "not allowed" });
      return;
    }
    const target = { chat_id: cb.message.chat.id, message_id: cb.message.message_id };
    const edit = (text: string, keyboard?: Keyboard) =>
      this.tg("editMessageText", { ...target, text, ...(keyboard && { reply_markup: keyboard }) }).catch((err: Error) => {
        // Telegram rejects edits that change nothing; that is fine.
        if (!err.message.includes("not modified")) throw err;
      });

    const [action, mode] = cb.data.split(":");
    if (action === "st" || !mode) {
      await this.tg("answerCallbackQuery", { callback_query_id: cb.id });
      const s = await this.agent.state();
      await edit(formatState(s), modeKeyboard(s));
      return;
    }

    const force = action === "fsw";
    await this.tg("answerCallbackQuery", { callback_query_id: cb.id, text: `switching to ${mode}…` });
    await edit(`switching to ${mode}…`);
    const result = await this.agent.switch(mode, force);
    if (result.ok) {
      await edit(formatState(result.state), modeKeyboard(result.state));
    } else if ("busy" in result) {
      const { risks } = result.busy;
      await edit(
        [
          `${result.busy.mode} is busy:`,
          ...risks.map((r) => `- ${r}`),
          "",
          "Force stops it anyway. Running cells die and unsaved edits are lost.",
        ].join("\n"),
        {
          inline_keyboard: [
            [{ text: `Force → ${mode}`, callback_data: `fsw:${mode}` }],
            [{ text: "Cancel", callback_data: "st" }],
          ],
        },
      );
    } else {
      const s = await this.agent.state();
      await edit(`${formatState(s)}\n\nerror: ${result.error}`, modeKeyboard(s));
    }
  }

  /** Sends one question per idle stretch. Answering it is the user's call. */
  async remind(now = Date.now()) {
    const s = await this.agent.state();
    if (!s.reminderDue || !s.mode) return;
    const key = `${s.mode}:${s.lastActive}`;
    if (key === this.#lastReminder) return;
    this.#lastReminder = key;
    const text = `${s.mode} idle for ${formatDuration(now - s.lastActive)}. ${s.default} is off while it runs.`;
    const keyboard: Keyboard = {
      inline_keyboard: [[{ text: `Switch to ${s.default}`, callback_data: `sw:${s.default}` }], [{ text: "Status", callback_data: "st" }]],
    };
    // Private chats: the chat id equals the user id.
    for (const user of this.users) await this.tg("sendMessage", { chat_id: user, text, reply_markup: keyboard });
  }

  /**
   * Telegram confirms an update only when a later getUpdates asks for a higher
   * offset. Each update is confirmed before it is handled, so a bot restart in
   * the middle of a switch cannot replay a Force button.
   */
  async run(signal: AbortSignal) {
    const reminders = setInterval(() => this.remind().catch((err: Error) => this.log(`remind: ${err.message}`)), 60_000);
    const poll = (offset: number, timeout: number) =>
      this.tg<Update[]>("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] });
    let offset = 0;
    let pending: Update[] = [];
    try {
      while (!signal.aborted) {
        let update: Update | undefined;
        try {
          if (pending.length === 0) pending = await poll(offset, 50);
          update = pending[0];
          if (!update) continue;
          // The answer confirms `update` and lists what is still waiting.
          pending = await poll(update.update_id + 1, 0);
          offset = update.update_id + 1;
        } catch (err) {
          this.log(`getUpdates: ${(err as Error).message}`);
          await sleep(5_000);
          continue;
        }
        const { update_id } = update;
        await this.handle(update).catch((err: Error) => this.log(`update ${update_id}: ${err.message}`));
      }
    } finally {
      clearInterval(reminders);
    }
  }
}
