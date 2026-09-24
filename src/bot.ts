// Telegram front for one agent. Any message gets a status card with a start
// or stop button per service; ⚙ Settings leads to the priority list, one
// screen per service, and services found on the host. Screens are pure
// functions of the agent's answers, and a button edits its message in place.
// A busy service gets a second, explicit "force" button instead of a silent
// stop. Idle reminders are questions; the bot never stops anything on its own.
// Allowed users are the config's telegram.users, read per update; a stranger
// gets in with a code from `kilnhush pair`.
import { setTimeout as sleep } from "node:timers/promises";
import type { ActionResult, AgentClient, SettingsAction, State } from "./api.ts";
import { parseDuration } from "./config.ts";
import type { Discovery } from "./discover.ts";
import { formatDuration, formatState, runLabel } from "./format.ts";
import type { Run } from "./plugins/types.ts";
import { type SettingsView, proposeService } from "./settings.ts";

type Button = { text: string; callback_data: string };
type Keyboard = { inline_keyboard: Button[][] };
export type Screen = { text: string; keyboard: Keyboard };
type Update = {
  update_id: number;
  message?: { chat: Chat; from?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: Chat; message_id: number };
  };
};
type Chat = { id: number; type: string };

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

/*
 * Callback data, all within Telegram's 64 bytes:
 *   st              home                     set             settings
 *   go:/halt:<svc>  start/stop, `f` prefix forces
 *   svc:<svc>       one service              rm:<svc>, rmy:<svc>   ask, then remove
 *   run:/idle:/remind:/wait:<svc>:<value>    up:/down:<svc>  move in the priority list
 *   add             discovered services      addu:/addc:<name>     add a unit/container
 *   users           allowed users            unuser:<id>     remove one
 */
const button = (text: string, data: string): Button => ({ text, callback_data: data });

/** Fits Telegram's 4096-character limit, keeping the end, where screens put their question. */
export function clip(text: string) {
  return text.length <= 4096 ? text : `${text.slice(0, 3500)}\n…\n${text.slice(-500)}`;
}

function rows(buttons: Button[], size: number) {
  const out: Button[][] = [];
  for (let i = 0; i < buttons.length; i += size) out.push(buttons.slice(i, i + size));
  return out;
}

/** 1_200_000 → "20m", 5_400_000 → "1h30m". */
function short(ms: number) {
  const s = Math.round(ms / 1000);
  const parts = [[Math.floor(s / 3600), "h"], [Math.floor((s % 3600) / 60), "m"], [s % 60, "s"]] as const;
  return parts.flatMap(([n, unit]) => (n > 0 ? [`${n}${unit}`] : [])).join("") || "0s";
}

const gb = (mib: number) => `${(mib / 1024).toFixed(1)} GB`;
const withNote = (lines: string[], note?: string) => (note ? [...lines, "", note] : lines).join("\n");

export function homeScreen(s: State, note?: string): Screen {
  const buttons = s.services.map((svc) =>
    svc.name === s.holder ? button(`■ ${svc.name}`, `halt:${svc.name}`) : button(`▶ ${svc.name}`, `go:${svc.name}`),
  );
  return {
    text: withNote([formatState(s)], note),
    keyboard: { inline_keyboard: [...rows(buttons, 3), [button("Refresh", "st"), button("⚙ Settings", "set")]] },
  };
}

export function settingsScreen(v: SettingsView, note?: string): Screen {
  const lines = ["Higher in the list wins the GPU.", ...v.warnings.map((w) => `! ${w}`), `Users: ${v.users.join(", ")}`];
  return {
    text: withNote(lines, note),
    keyboard: {
      inline_keyboard: [
        ...v.services.map((s, i) => [button(`${i + 1}. ${s.name} · ${runLabel[s.run]}`, `svc:${s.name}`)]),
        [button("➕ Add service", "add"), button("Users", "users")],
        [button("Back", "st")],
      ],
    },
  };
}

const runs: Run[] = ["on_demand", "always", "manual"];

export function serviceScreen(v: SettingsView, name: string, note?: string): Screen {
  const i = v.services.findIndex((s) => s.name === name);
  const s = v.services[i];
  if (!s) return settingsScreen(v, note ?? `There is no service ${name}.`);
  const how = {
    on_demand: `Runs when used, stops after ${short(s.idle)} idle.`,
    always: "Always on while nothing else needs the card.",
    manual: `Starts and stops by hand${s.remind ? `, asks after ${short(s.remind)} idle` : ""}.`,
  }[s.run];
  const lines = [
    `${s.name} · ${i + 1} of ${v.services.length}`,
    `${s.pluginName} · ${s.procs.map((p) => p.replace(":", " ")).join(", ")}`,
    how,
    ...(s.run === "manual" ? [] : [`Requests wait up to ${short(s.wait)} for a busy lower service.`]),
    ...(s.proxy ? [`Proxy on port ${s.proxy}.`] : []),
  ];
  /** A row of presets, the current one ticked. `0s` reads as off. */
  const presets = (key: "idle" | "remind" | "wait", current: number, values: string[]) =>
    values.map((d, j) =>
      button(`${parseDuration(d) === current ? "✓ " : ""}${j === 0 ? `${key} ` : ""}${d === "0s" ? "off" : d}`, `${key}:${s.name}:${d}`),
    );
  const move = [...(i > 0 ? [button("↑ Higher", `up:${s.name}`)] : []), ...(i < v.services.length - 1 ? [button("↓ Lower", `down:${s.name}`)] : [])];
  return {
    text: withNote(lines, note),
    keyboard: {
      inline_keyboard: [
        runs.map((r) => button(`${r === s.run ? "✓ " : ""}${runLabel[r]}`, `run:${s.name}:${r}`)),
        ...(move.length > 0 ? [move] : []),
        ...(s.run === "on_demand" ? [presets("idle", s.idle, ["5m", "15m", "30m", "1h", "2h"])] : []),
        ...(s.run === "manual" ? [presets("remind", s.remind, ["0s", "1h", "3h", "8h"])] : []),
        ...(s.run === "manual" ? [] : [presets("wait", s.wait, ["30s", "1m", "5m"])]),
        [button("Remove", `rm:${s.name}`), button("Back", "set")],
      ],
    },
  };
}

export function removeScreen(name: string): Screen {
  return {
    text: `Remove ${name}? It keeps running as it is, kilnhush just stops managing it.`,
    keyboard: { inline_keyboard: [[button("Yes, remove", `rmy:${name}`), button("No", `svc:${name}`)]] },
  };
}

/** Units and containers found on the host that no service uses yet. */
export function addScreen(d: Discovery, v: SettingsView, note?: string): Screen {
  const configured = new Set(v.services.flatMap((s) => s.procs));
  const buttons = d.found.flatMap((f) => {
    const data = `${f.owner.kind === "unit" ? "addu" : "addc"}:${f.owner.name}`;
    // A name too long for callback data has to go in the config file.
    if (configured.has(`${f.owner.kind}:${f.owner.name}`) || Buffer.byteLength(data) > 64) return [];
    const plugin = v.plugins.find((p) => p.id === f.plugin)?.name;
    const use = f.usedMiB > 0 ? gb(f.usedMiB) : f.active ? "running" : undefined;
    return [[button([f.owner.name, plugin, use].filter(Boolean).join(" · "), data)]];
  });
  const text =
    buttons.length > 0
      ? "Found on this host. Tap one to add it; it goes right above the always-on service."
      : "Nothing new found on this host. Add a service to the agent's config file, then run kilnhush reload.";
  return { text: withNote([text], note), keyboard: { inline_keyboard: [...buttons, [button("Back", "set")]] } };
}

export function usersScreen(v: SettingsView, me: number, note?: string): Screen {
  return {
    text: withNote(["Telegram users who can use this bot. Run kilnhush pair on the GPU host to add one."], note),
    keyboard: {
      inline_keyboard: [
        ...v.users.map((id) => [button(`✕ ${id}${id === me ? " (you)" : ""}`, `unuser:${id}`)]),
        [button("Back", "set")],
      ],
    },
  };
}

/** What the bot needs from the agent: an agentClient over HTTP or in the agent's own process. */
export type BotAgent = Omit<AgentClient, "pair">;

export class Bot {
  #lastReminder = "";

  constructor(
    private tg: Telegram,
    private agent: BotAgent,
    private log: (msg: string) => void = console.error,
  ) {}

  async handle(update: Update) {
    // Screens list users, services and processes: only for the user's own chat, never a group.
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    if (chat && chat.type !== "private") return;
    const msg = update.message;
    if (msg) {
      if (!msg.from) return;
      if (!(await this.#view()).users.includes(msg.from.id)) return this.#stranger(msg.chat.id, msg.from.id, msg.text ?? "");
      await this.#send(msg.chat.id, homeScreen(await this.agent.state()));
      return;
    }

    const cb = update.callback_query;
    if (!cb?.message || !cb.data) return;
    if (!(await this.#view()).users.includes(cb.from.id)) {
      await this.tg("answerCallbackQuery", { callback_query_id: cb.id, text: "not allowed" });
      return;
    }
    const target = { chat_id: cb.message.chat.id, message_id: cb.message.message_id };
    const show = (screen: Screen) =>
      this.tg("editMessageText", { ...target, text: clip(screen.text), reply_markup: screen.keyboard }).catch((err: Error) => {
        // Telegram rejects edits that change nothing; that is fine.
        if (!err.message.includes("not modified")) throw err;
      });

    const [verb = "", ...args] = cb.data.split(":");
    const service = args[0] ?? "";
    const force = verb.startsWith("f");
    const action = force ? verb.slice(1) : verb;
    if (service && (action === "go" || action === "halt")) {
      const doing = action === "go" ? `starting ${service}…` : `stopping ${service}…`;
      await this.tg("answerCallbackQuery", { callback_query_id: cb.id, text: doing });
      await show({ text: doing, keyboard: { inline_keyboard: [] } });
      const result: ActionResult = action === "go" ? await this.agent.start(service, force) : await this.agent.stop(service, force);
      await show(await this.#afterSwitch(result, action, service));
      return;
    }
    await this.tg("answerCallbackQuery", { callback_query_id: cb.id });
    await show(await this.#screen(verb, args, cb.from.id));
  }

  async #afterSwitch(result: ActionResult, action: "go" | "halt", service: string): Promise<Screen> {
    if (result.ok) return homeScreen(result.state);
    if (!("busy" in result)) return homeScreen(await this.agent.state(), `error: ${result.error}`);
    const { service: busy, risks } = result.busy;
    const question = action === "go" ? `Force stop ${busy} and start ${service}?` : `Force stop ${busy}?`;
    return {
      text: [`${busy} is busy:`, ...risks.map((r) => `- ${r}`), "", `${question} Running work dies and unsaved edits are lost.`].join("\n"),
      keyboard: {
        inline_keyboard: [
          [button(action === "go" ? `Force start ${service}` : `Force stop ${service}`, `f${action}:${service}`)],
          [button("Cancel", "st")],
        ],
      },
    };
  }

  /** The screen a settings button leads to. A refused edit shows its reason on the same screen. */
  async #screen(verb: string, args: string[], user: number): Promise<Screen> {
    const [name = "", value = ""] = args;
    switch (verb) {
      case "set":
        return settingsScreen(await this.#view());
      case "svc":
        return serviceScreen(await this.#view(), name);
      case "run":
      case "idle":
      case "remind":
      case "wait": {
        const { view, error } = await this.#change("update", { name, [verb]: value });
        return serviceScreen(view, name, error);
      }
      case "up":
      case "down": {
        const at = (await this.#view()).services.findIndex((s) => s.name === name);
        const { view, error } = await this.#change("move", { name, to: Math.max(0, at + (verb === "up" ? -1 : 1)) });
        return serviceScreen(view, name, error);
      }
      case "rm":
        return removeScreen(name);
      case "rmy": {
        const { view, error } = await this.#change("remove", { name });
        return error ? serviceScreen(view, name, error) : settingsScreen(view, `Removed ${name}.`);
      }
      case "add": {
        const [discovery, view] = await Promise.all([this.agent.discover(), this.#view()]);
        return addScreen(discovery, view);
      }
      case "addu":
      case "addc":
        return this.#add(verb === "addu" ? "unit" : "container", args.join(":"));
      case "users":
        return usersScreen(await this.#view(), user);
      case "unuser": {
        const { view, error } = await this.#change("remove-user", { user: Number(name) });
        return usersScreen(view, user, error);
      }
      default:
        return homeScreen(await this.agent.state());
    }
  }

  async #add(kind: "unit" | "container", name: string): Promise<Screen> {
    const [discovery, before] = await Promise.all([this.agent.discover(), this.#view()]);
    const found = discovery.found.find((f) => f.owner.kind === kind && f.owner.name === name);
    if (!found) return addScreen(discovery, before, `${name} is no longer on this host.`);
    const service = proposeService(found, before);
    const { view, error } = await this.#change("add", service);
    if (error) return addScreen(discovery, view, error);
    const proxy = view.services.find((s) => s.name === service.name)?.proxy;
    if (!proxy) return serviceScreen(view, service.name, `Added ${service.name}.`);
    const { host } = await this.agent.state();
    return serviceScreen(view, service.name, `Added ${service.name}. Point its clients at http://${host}:${proxy}, requests there wake it.`);
  }

  /** The agent's settings. Throws when it can't answer, so nobody gets in on a guess. */
  async #view() {
    const res = await this.agent.settings("view");
    if (!res.ok) throw new Error(res.error);
    return res.view;
  }

  /** Applies a settings edit. On refusal, the unchanged settings and the reason. */
  async #change(action: SettingsAction, body: object) {
    const res = await this.agent.settings(action, body);
    return res.ok ? { view: res.view, error: undefined } : { view: await this.#view(), error: res.error };
  }

  #send(chat: number, screen: Screen) {
    return this.tg("sendMessage", { chat_id: chat, text: clip(screen.text), reply_markup: screen.keyboard });
  }

  /** Lets in a stranger who sends `/start <code>`. Anyone else learns only how to get a code. */
  async #stranger(chat: number, user: number, text: string) {
    const code = /^\/start\s+(\S+)/.exec(text)?.[1];
    const paired = code ? await this.agent.settings("redeem", { code, user }) : undefined;
    if (paired?.ok) {
      this.log(`paired Telegram user ${user}`);
      await this.#send(chat, homeScreen(await this.agent.state()));
      return;
    }
    this.log(paired ? `pairing ${user}: ${paired.error}` : `ignored message from ${user}`);
    await this.tg("sendMessage", { chat_id: chat, text: "Run kilnhush pair on the GPU host to get access." });
  }

  /** Sends one question per idle stretch. Answering it is the user's call. */
  async remind(now = Date.now()) {
    const s = await this.agent.state();
    if (!s.reminderDue || !s.holder) return;
    const key = `${s.holder}:${s.lastActive}`;
    if (key === this.#lastReminder) return;
    this.#lastReminder = key;
    const waiting = s.home && s.home !== s.holder ? ` ${s.home} is off while it runs.` : "";
    const text = `${s.holder} idle for ${formatDuration(now - s.lastActive)}.${waiting}`;
    const keyboard: Keyboard = { inline_keyboard: [[button(`Stop ${s.holder}`, `halt:${s.holder}`)], [button("Status", "st")]] };
    // Private chats: the chat id equals the user id.
    for (const user of (await this.#view()).users) await this.tg("sendMessage", { chat_id: user, text, reply_markup: keyboard });
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
