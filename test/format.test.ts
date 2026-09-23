import assert from "node:assert/strict";
import { test } from "node:test";
import type { State } from "../src/api.ts";
import { formatState } from "../src/format.ts";

const base: State = {
  holder: null,
  switching: null,
  home: "voice",
  homePaused: false,
  pinned: false,
  services: [{ name: "voice", plugin: "Custom", run: "always", idle: 0, proxy: null, models: [] }],
  warnings: [],
  since: 0,
  busy: false,
  risks: [],
  lastActive: 0,
  reminderDue: false,
  gpu: null,
  events: [],
};

test("a failed switch does not look like one in progress", () => {
  assert.match(formatState({ ...base, switching: "llm" }), /^starting llm…/);
  assert.match(formatState({ ...base, risks: ["cleanup after failed llm start did not finish"] }), /^no service, the last switch failed\n! cleanup/);
  assert.match(formatState({ ...base, homePaused: true }), /^card free, home stopped by hand\n\n○ voice · always on$/);
});
