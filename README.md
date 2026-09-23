# kilnhush

Switch one GPU between services that don't fit in VRAM together, without killing work that is still running.

- An LLM wakes on its first `/v1/*` request and gives the card back when idle.
- Jupyter only stops by hand, and not while a cell runs or a notebook is open.
- A Telegram bot shows what holds the card and switches modes.

```text
$ kilnhush switch voice
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
node dist/cli.js switch jupyter
curl -s -X POST 'localhost:18888/demo?busy=1&tabs=1'
node dist/cli.js switch voice                        # refused
node dist/cli.js switch voice --force
```

## Config

```yaml
default: voice
modes:
  voice:
    services:
      - unit: wyoming-faster-whisper.service
        health: tcp://127.0.0.1:10300
  bonsai:
    idle: 20m                        # back to voice after 20 min without requests
    proxy: { target: http://127.0.0.1:8080 }
    services:
      - unit: bonsai-3080.service
        health: http://127.0.0.1:8080/health
  jupyter:
    remind: 3h                       # the bot asks, it never stops it
    gpu_guard: 20                    # busy while GPU utilization >= 20%
    jupyter: { url: http://127.0.0.1:8888, token_env: JUPYTER_TOKEN }
    services:
      - unit: jupyter-3080.service
```

A service is a systemd `unit` or a `cmd` the agent runs itself. Full example: [`examples/vm111.yaml`](examples/vm111.yaml), my RTX 3080 with Home Assistant voice, Bonsai 27B and JupyterLab.

## Details

**What blocks a switch.** A proxied request in flight, a kernel running a cell, a notebook open in a browser tab, GPU utilization over `gpu_guard`, or a probe that got no answer. `--force` or the bot's Force button overrides it.

**Proxy.** `/v1/*` routes by the request's `model` when several modes proxy. `/v1/models` answers from config and wakes nothing. While a manual mode holds the card, requests get 503.

**Startup.** The agent adopts the mode whose services are running. If what runs matches no single mode, it refuses to start rather than guess.

**Limits.** A notebook opened with no kernel has no session, so Jupyter can't report it. Set JupyterLab's `autosaveInterval` low. `cmd` services stop with the agent, so run long work as a systemd unit.

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
