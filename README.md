# kilnhush

Switch one GPU between services that don't fit in VRAM together, without killing work that is still running.

- An LLM wakes on its first `/v1/*` request and gives the card back when idle.
- Jupyter only stops by hand, and not while a cell runs or a notebook is open.
- A Telegram bot shows what holds the card and starts or stops services.

```text
$ kilnhush stop jupyter
jupyter is busy:
- train.ipynb: cell running
- train.ipynb: open in 1 browser tab(s), unsaved edits would be lost
rerun with --force to stop it anyway
```

## Try it

Runs anywhere with Node 22.18+ and pnpm. The demo uses a fake llama-server and a fake Jupyter.

```bash
pnpm install && pnpm build
node dist/cli.js agent --config examples/demo.yaml

# another terminal
curl -s localhost:7340/v1/chat/completions -d '{}'   # wakes llm
node dist/cli.js start jupyter
curl -s -X POST 'localhost:18888/demo?busy=1&tabs=1'
node dist/cli.js stop jupyter                        # refused
node dist/cli.js stop jupyter --force                # voice comes back
```

## Config

Services in priority order, first matters most:

```yaml
services:
  - name: jupyter
    plugin: jupyter
    run: manual                      # only by hand; the bot asks after 3h idle
    remind: 3h
    unit: jupyter-3080.service
  - name: bonsai
    plugin: llamacpp                 # on_demand: wakes on /v1 requests, stops after idle
    idle: 20m
    models: [bonsai]
    unit: bonsai-3080.service
  - name: voice
    plugin: wyoming
    run: always                      # runs whenever the card is free
    unit: wyoming-faster-whisper.service
```

A service runs as a systemd `unit`, a docker `container`, a `cmd` the agent runs itself, or a `group` of those. Plugins (`ollama`, `llamacpp`, `vllm`, `comfyui`, `a1111`, `jupyter`, `wyoming`, `custom`) know each program's port, health check and how to tell it is busy. Full example: [`examples/vm111.yaml`](examples/vm111.yaml), my RTX 3080 with Home Assistant voice, Bonsai 27B and JupyterLab.

## Details

**Who gets the card.** A request takes the card from a lower-ranked service once that one has nothing running. It waits up to `wait` (60s) for running work to finish, and never takes the card from a higher-ranked or manual service: it gets a 503 with `Retry-After`. A service started by hand keeps the card until it idles out once.

**What blocks a stop.** A proxied request in flight, a kernel running a cell, a notebook open in a browser tab, a queued ComfyUI prompt, a running A1111 render, GPU utilization over `gpu_guard`, or a probe that got no answer. `--force` or the bot's Force button overrides it.

**Proxy.** Give a service `proxy: <port>` and point its clients there instead of at the service. Real work (a generation, a prompt, opening the web UI) wakes it; the plugin decides what counts. Health checks and status polls never wake anything: they get a 503 while the service is off, or its last answer for things like `/v1/models`. WebSockets pass through while it runs and close when it stops. The agent's own `/v1/*` routes by the request's `model` across all services with `models`.

**Settings.** The agent owns its config file. Edits through the API (the bot uses it) are validated, written atomically with a `.bak`, and applied live; the service holding the card can't be removed or rerouted until it stops. The API only adds units and containers that exist on the host, never commands. After editing the file by hand, run `kilnhush reload` (or send SIGHUP).

**Startup.** The agent adopts the service whose processes are running. If what runs matches no single service, it refuses to start rather than guess.

**Limits.** A notebook opened with no kernel has no session, so Jupyter can't report it. Set JupyterLab's `autosaveInterval` low. `cmd` services stop with the agent, so run long work as a systemd unit. Run the agent under a supervisor that kills its whole cgroup if it crashes, like the example unit's `KillMode=control-group`.

**Run.** The agent runs as root on the GPU host. The bot runs anywhere that reaches it. Unit files are in [`examples/`](examples).

| Env | Meaning |
|---|---|
| `KILNHUSH_TOKEN` | bearer token for `/api/*`, required unless the agent listens on loopback |
| `KILNHUSH_AGENT` | agent URL for bot and CLI, default `http://127.0.0.1:7340` |
| `KILNHUSH_TG_TOKEN` | Telegram bot token |
| `KILNHUSH_TG_USERS` | comma-separated Telegram user ids allowed to use the bot |

`/v1/*` has no auth, same as llama-server. Keep it on your LAN.

## Development

TypeScript on Node. Dependencies: `arktype`, `yaml`. `pnpm check` runs typecheck, tests and build.

[MIT](LICENSE)
