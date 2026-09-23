import assert from "node:assert/strict";
import { test } from "node:test";
import { unitRunning } from "../src/services.ts";

test("unit states: starting and stopping units still count as running, unknown output throws", () => {
  assert.equal(unitRunning("active"), true);
  assert.equal(unitRunning("deactivating"), true);
  assert.equal(unitRunning("inactive"), false);
  assert.equal(unitRunning("failed"), false);
  assert.throws(() => unitRunning(""), /unknown unit state/);
  assert.throws(() => unitRunning("Failed to connect to bus"), /unknown unit state/);
});
