# kilnhush

A mode switcher for people with one GPU and more services than VRAM.

Say you run speech-to-text for Home Assistant, a local LLM your coding agent calls, and sometimes a notebook to train something. Each one fits on the card alone. Together they don't. So you write scripts that stop one thing to start another, and one day a script stops Jupyter three hours into a training run.

kilnhush puts one agent in front of the card. You group services into modes, and one mode owns the GPU at a time. An LLM mode wakes on the first API request and steps aside once nobody uses it. A mode that holds real work, like Jupyter, never stops on a timer. It also never stops while something is running, unless you say so twice. A Telegram bot shows what holds the card and switches modes from your phone.

## A day with it

- **08:00** Voice mode. Whisper and Kokoro answer Home Assistant.
- **10:15** Your coding agent sends a request to `/v1/chat/completions`. kilnhush stops voice, starts the 27B model and forwards the request once the model is up. The agent just sees a slow first answer.
- **10:40** Twenty minutes without requests. The model goes away, voice comes back.
- **14:00** You tap `jupyter` in Telegram and start a training run.
- **16:30** The coding agent asks the model again. It gets `503 GPU is held by jupyter mode`, and your run keeps going.
- **17:00** You tap `voice` by accident. The bot says a cell is running and `train.ipynb` is open in a browser tab, and shows a Force button. You don't press it.
- **23:00** Training ended at 19:00 and nothing happened since. The bot asks once whether to give the card back to voice.

```text
$ kilnhush switch voice
jupyter is busy:
- train.ipynb: cell running
- train.ipynb: open in 1 browser tab(s), unsaved edits would be lost
rerun with --force to stop it anyway
```

Two cards on one host work too. Run one agent per GPU, each with its own config, port and `gpu:` index, and pin each unit to its card with `CUDA_VISIBLE_DEVICES`.

## Why I built it

My box has an RTX 3080 with 10 GB: voice for Home Assistant, Bonsai 27B for agents, JupyterLab for training. Before kilnhush that was three scripts that knew nothing about each other, and one of them stopped Jupyter with unsaved work in it. That setup is `examples/vm111.yaml`.

## How it decides

A mode is a list of services. A service is a systemd unit the host already has, or a command the agent runs itself. One mode owns the GPU at a time.

| Mode kind | Starts | Stops |
|---|---|---|
| default (`voice`) | at boot, and whenever nothing else runs | when another mode is asked for |
| with `proxy` + `idle` (`bonsai`) | on the first `/v1/*` request | after `idle` with no requests in flight |
| manual (`jupyter`) | from the bot or `kilnhush switch` | from the bot or CLI, never on a timer |

Before a switch, the agent probes the current mode. Each risk it finds blocks the switch:

- a request still in flight through the proxy
- a Jupyter kernel running a cell
- a notebook open in a browser tab. JupyterLab keeps unsaved edits in the browser, and the server can't see them or save them.
- GPU utilization over `gpu_guard`, for training started from a terminal instead of a notebook
- Jupyter not answering, because not knowing is not the same as idle

A blocked switch returns the risks. The bot shows them with a separate Force button. After a manual mode has been idle for `remind`, the bot asks once whether to stop it. It never stops it on its own.

A request for the LLM while Jupyter holds the card gets a 503 with `GPU is held by jupyter mode`. It does not wake anything.

## Demo

This runs anywhere. It uses a fake llama-server, a fake Jupyter and `sleep` as voice. You need Node 22.18 or newer and pnpm.

```bash
pnpm install
pnpm build
node dist/cli.js agent --config examples/demo.yaml
```

In another terminal:

```bash
node dist/cli.js status

# Wakes the llm mode. The fake model takes 3s to load.
curl -s localhost:7340/v1/chat/completions -d '{"messages":[]}'

node dist/cli.js switch jupyter
curl -s -X POST 'localhost:18888/demo?busy=1&tabs=1'   # a cell runs, a tab is open

curl -s localhost:7340/v1/chat/completions -d '{}'     # 503, jupyter holds the GPU
node dist/cli.js switch voice                          # refused, lists both risks
node dist/cli.js switch voice --force
```

The llm mode returns to voice 30s after its last request. The agent prints every decision, and `/api/state` keeps the last 20.

## Config

`examples/vm111.yaml`, the 3080 box from above:

```yaml
listen: 0.0.0.0:7340
default: voice
modes:
  voice:
    services:
      - unit: wyoming-faster-whisper.service
        health: tcp://127.0.0.1:10300
      - unit: wyoming-kokoro.service
        health: tcp://127.0.0.1:10800
      - unit: qwen35-3080.service
        health: http://127.0.0.1:8080/health
  bonsai:
    idle: 20m
    proxy:
      target: http://127.0.0.1:8080
    services:
      - unit: bonsai-3080.service
        health: http://127.0.0.1:8080/health
        ready_timeout: 3m
  jupyter:
    remind: 3h
    gpu_guard: 20
    jupyter:
      url: http://127.0.0.1:8888
      token_env: JUPYTER_TOKEN
    services:
      - unit: jupyter-3080.service
        health: http://127.0.0.1:8888/api
```

The loader rejects unknown keys. It also rejects `idle` on a mode without `proxy`, since nothing would measure that idle time. With several proxied modes, each lists its `models`, and the agent routes by the request's `model` field. `/v1/models` answers from config, so listing models doesn't wake anything.

Services a mode shares with the next one keep running through the switch. If a mode fails to start, the agent stops what it started and brings the default mode back on the next tick.

## Run it

The agent runs as root on the GPU host, so it can drive `systemctl`. The bot can run anywhere that reaches the agent. Put it on something always on, like a small container, so it still answers when the GPU machine is down.

| Env | Used by | Meaning |
|---|---|---|
| `KILNHUSH_TOKEN` | agent, bot, CLI | bearer token for `/api/*`. The agent refuses to listen beyond loopback without it |
| `KILNHUSH_AGENT` | bot, CLI | agent URL, default `http://127.0.0.1:7340` |
| `KILNHUSH_TG_TOKEN` | bot | Telegram bot token |
| `KILNHUSH_TG_USERS` | bot | comma-separated Telegram user ids. Everyone else is ignored |

Unit files are in `examples/`. `/v1/*` is open without a token, like llama-server itself, so keep the port on your LAN.

Set JupyterLab's autosave interval low. The server can't save a notebook that is still open in a browser, so frequent autosave is the only guard against unsaved edits. In Settings → Document Manager, set `autosaveInterval` to 30.

## Not in scope

It does not share one GPU between several models by priority, the way [GridCore](https://www.youtube.com/watch?v=Mu3xzCVoHXc) does. llama-swap swaps models on a timer but doesn't know about notebooks or other services. kilnhush is for the case where your modes can't fit together anyway. The hard part is knowing when stopping one is safe.

## Development

TypeScript on Node, no framework. The only dependencies are `arktype` for config and request validation and `yaml`.

```bash
pnpm check   # typecheck, tests, build
```

The tests run the real agent, proxy and Jupyter probe against the fakes. Only process management is stubbed.

[MIT](LICENSE)
