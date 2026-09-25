import assert from "node:assert/strict";
import { test } from "node:test";
import { type Snapshot, type View, planRequest, planTick } from "../src/plan.ts";

const min = 60_000;
const svc = (name: string, run: View["run"], over: Partial<View> = {}): View => ({
  name,
  run,
  idle: 20 * min,
  busy: false,
  risks: [],
  lastActive: 0,
  ...over,
});

// Priority order: jupyter, ollama, comfy, voice.
const snap = (over: Partial<Snapshot> = {}, views: Partial<Record<string, Partial<View>>> = {}): Snapshot => ({
  now: 30 * min,
  services: [
    svc("jupyter", "manual", views.jupyter),
    svc("ollama", "on_demand", views.ollama),
    svc("comfy", "on_demand", views.comfy),
    svc("voice", "always", views.voice),
  ],
  holder: "voice",
  pinned: false,
  homePaused: false,
  waiting: new Set(),
  ...over,
});

test("requests", async (t) => {
  const cases: [string, Snapshot, string, ReturnType<typeof planRequest>][] = [
    ["the holder serves its own requests", snap({ holder: "ollama" }), "ollama", { act: "use" }],
    ["a free card goes to the requester", snap({ holder: null }), "comfy", { act: "switch" }],
    ["a quiet lower holder is evicted", snap(), "comfy", { act: "switch" }],
    ["a busy lower holder is waited for", snap({ holder: "comfy" }, { comfy: { busy: true } }), "ollama", { act: "wait", on: "comfy" }],
    ["a lower holder with risks is waited for", snap({ holder: "comfy" }, { comfy: { risks: ["probe failed"] } }), "ollama", { act: "wait", on: "comfy" }],
    [
      "a higher holder refuses until it idles out",
      snap({ holder: "ollama" }, { ollama: { lastActive: 25 * min } }),
      "comfy",
      { act: "refuse", reason: "ollama ranks above comfy", retryAfter: 900 },
    ],
    [
      "a manual holder refuses with no retry time",
      snap({ holder: "jupyter" }),
      "ollama",
      { act: "refuse", reason: "the GPU is held by jupyter, which only stops by hand" },
    ],
    [
      "a hand-started holder is not evicted by a higher request",
      snap({ holder: "comfy", pinned: true }, { comfy: { lastActive: 29 * min } }),
      "ollama",
      { act: "refuse", reason: "comfy was started by hand", retryAfter: 1140 },
    ],
    ["requests never wake a manual service", snap({ holder: null }), "jupyter", { act: "refuse", reason: "jupyter only starts by hand" }],
    ["a higher waiter goes first on a free card", snap({ holder: null, waiting: new Set(["ollama"]) }), "comfy", { act: "wait", on: "ollama" }],
    ["the holder drains while a higher service waits", snap({ holder: "comfy", waiting: new Set(["ollama"]) }), "comfy", { act: "wait", on: "ollama" }],
    ["a lower waiter does not hold anyone back", snap({ holder: "ollama", waiting: new Set(["comfy"]) }), "ollama", { act: "use" }],
  ];
  for (const [name, s, x, want] of cases) await t.test(name, () => assert.deepEqual(planRequest(s, x), want));
});

test("ticks", async (t) => {
  const cases: [string, Snapshot, ReturnType<typeof planTick>][] = [
    ["an idle on_demand holder is released to home", snap({ holder: "ollama" }), { act: "release", then: "voice" }],
    ["not before its idle time", snap({ holder: "ollama" }, { ollama: { lastActive: 15 * min } }), { act: "none" }],
    ["never while busy", snap({ holder: "ollama" }, { ollama: { busy: true } }), { act: "none" }],
    ["never with risks", snap({ holder: "comfy" }, { comfy: { risks: ["x"] } }), { act: "none" }],
    ["a manual holder stays", snap({ holder: "jupyter" }), { act: "none" }],
    ["home stays", snap(), { act: "none" }],
    ["home comes back to a free card", snap({ holder: null }), { act: "start", name: "voice" }],
    ["unless it was stopped by hand", snap({ holder: null, homePaused: true }), { act: "none" }],
    ["but an idle holder releases to it anyway", snap({ holder: "ollama", homePaused: true }), { act: "release", then: "voice" }],
    ["or a request waits for the card", snap({ holder: null, waiting: new Set(["comfy"]) }), { act: "none" }],
    ["release without home when a request waits", snap({ holder: "ollama", waiting: new Set(["comfy"]) }), { act: "release", then: null }],
  ];
  for (const [name, s, want] of cases) await t.test(name, () => assert.deepEqual(planTick(s), want));
});
