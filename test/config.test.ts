import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseConfig, parseDuration } from "../src/config.ts";

test("parseDuration", () => {
  assert.equal(parseDuration("20m"), 1_200_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("500ms"), 500);
  assert.equal(parseDuration("20"), undefined);
  assert.equal(parseDuration("20m junk"), undefined);
});

test("example configs load", () => {
  for (const name of ["demo", "vm111"]) {
    const config = loadConfig(`examples/${name}.yaml`);
    assert.ok(config.modes.has(config.default));
  }
});

test("idle without a proxy is rejected, since nothing would measure it", () => {
  assert.throws(
    () =>
      parseConfig(`
default: voice
modes:
  voice: { services: [{ unit: a }] }
  jupyter: { idle: 2h, services: [{ unit: b }] }
`),
    /jupyter: idle needs proxy/,
  );
});

test("unknown keys and bad durations are rejected", () => {
  assert.throws(() => parseConfig(`default: v\nmodes: { v: { services: [{ unit: a }], idel: 2m } }`), /idel/);
  assert.throws(() => parseConfig(`default: v\ntick: soon\nmodes: { v: { services: [{ unit: a }] } }`), /duration/);
});
