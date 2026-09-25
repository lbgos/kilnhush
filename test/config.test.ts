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
  for (const name of ["demo", "vm111"]) assert.ok(loadConfig(`examples/${name}.yaml`).services.length > 0);
});

const one = (service: string, extra = "") => parseConfig(`${extra}services:\n  - ${service}`);

test("defaults come from the plugin and the url", () => {
  const [s] = one(`{ name: web, unit: web.service, url: "http://127.0.0.1:9000", health: /ready }`).services;
  assert.equal(s?.plugin.id, "custom");
  assert.equal(s?.run, "on_demand");
  assert.equal(s?.health, "http://127.0.0.1:9000/ready");
  assert.equal(s?.idle, 20 * 60_000);
  assert.deepEqual(s?.procs.map((p) => p.key), ["unit:web.service"]);
  assert.equal(one(`{ name: t, unit: t, url: "http://h:7", health: tcp }`).services[0]?.health, "tcp://h:7");
  assert.equal(one(`{ name: t, unit: t, url: "http://h:7/api/", health: /ready }`).services[0]?.health, "http://h:7/api/ready");
});

test("a group keeps each process's own health check", () => {
  const { services, home } = parseConfig(`
services:
  - name: voice
    run: always
    group:
      - { unit: whisper.service, health: "tcp://127.0.0.1:10300" }
      - { container: kokoro }
`);
  assert.equal(home, "voice");
  assert.deepEqual(
    services[0]?.procs.map((p) => [p.key, p.health]),
    [
      ["unit:whisper.service", "tcp://127.0.0.1:10300"],
      ["container:kokoro", undefined],
    ],
  );
});

test("each service runs exactly one way", () => {
  assert.throws(() => one("{ name: a, unit: a, container: b }"), /exactly one of unit, container, cmd or group/);
  assert.throws(() => one("{ name: a }"), /exactly one of unit, container, cmd or group/);
  assert.throws(() => one("{ name: a, group: [{ unit: x, cmd: [y] }] }"), /group entry 0 needs exactly one/);
});

test("settings that would never apply are rejected", () => {
  assert.throws(() => one("{ name: a, unit: a, run: manual, idle: 5m }"), /idle only applies to run: on_demand/);
  assert.throws(() => one("{ name: a, unit: a, remind: 1h }"), /remind only applies to run: manual/);
  assert.throws(() => one("{ name: a, unit: a, proxy: 18000 }"), /proxy needs url/);
  assert.throws(() => one("{ name: A b, unit: a }"), /names use a-z/);
  assert.throws(() => one("{ name: a, plugin: nope, unit: a }"), /unknown plugin nope/);
});

test("services cannot share names, processes, models, proxy ports or the home role", () => {
  const two = (a: string, b: string) => parseConfig(`services:\n  - ${a}\n  - ${b}`);
  const url = `url: "http://127.0.0.1:1"`;
  assert.throws(() => two("{ name: a, unit: x }", "{ name: a, unit: y }"), /share the name a/);
  assert.throws(() => two("{ name: a, unit: x }", "{ name: b, group: [{ unit: x }] }"), /share unit:x/);
  assert.throws(() => two(`{ name: a, unit: x, ${url}, models: [m] }`, `{ name: b, unit: y, ${url}, models: [m] }`), /both serve model m/);
  assert.throws(() => two(`{ name: a, unit: x, ${url}, proxy: 9 }`, `{ name: b, unit: y, ${url}, proxy: 9 }`), /share proxy port 9/);
  assert.throws(() => two("{ name: a, unit: x, run: always }", "{ name: b, unit: y, run: always }"), /only one service can run always/);
});

test("an on_demand service ranked below home gets a warning", () => {
  const { warnings } = parseConfig(`services:\n  - { name: voice, unit: v, run: always }\n  - { name: llm, unit: l }`);
  assert.deepEqual(warnings, ["llm ranks below voice, so its requests never take the card from voice"]);
});

test("the agent needs a listen port and a tick of at least a second", () => {
  const voice = "{ name: voice, run: always, unit: whisper }";
  assert.throws(() => one(voice, "listen: 0.0.0.0\n"), /listen: give host:port/);
  assert.throws(() => one(voice, "tick: 0s\n"), /tick: at least 1s/);
  assert.equal(one(voice, "listen: \"[::]:7340\"\n").listen, "[::]:7340");
});
