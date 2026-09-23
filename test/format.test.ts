import assert from "node:assert/strict";
import { test } from "node:test";
import type { State } from "../src/api.ts";
import { formatState } from "../src/format.ts";

const base: State = {
  mode: null,
  switching: null,
  default: "voice",
  modes: ["voice"],
  since: 0,
  busy: false,
  risks: [],
  lastActive: 0,
  reminderDue: false,
  gpu: null,
  events: [],
};

test("a failed switch does not look like one in progress", () => {
  assert.match(formatState({ ...base, switching: "llm" }), /^switching to llm…/);
  assert.match(formatState({ ...base, risks: ["cleanup after failed llm start did not finish"] }), /^no mode, the last switch failed\n! cleanup/);
});
