# kilnhush

A small GPU mode switcher for a homelab, with a Telegram bot on top.

I have one RTX 3080 with 10 GB and more things that want it than fit: Whisper and Kokoro for Home Assistant voice, an on-demand LLM, and JupyterLab for training. They mostly can't run together, so the card switches between modes. Today that is three separate scripts that don't know about each other. kilnhush replaces them with one config and one bot.

**Early.** Nothing to run yet. This README describes the target.

## What it does

- Each mode is a set of systemd units or `llama-server` processes plus a busy probe: `/metrics` for llama, the kernels API for Jupyter, a port check for Wyoming.
- An LLM mode stops itself after an idle timeout and brings the default mode back.
- Jupyter never stops on a timer. A running training job must not die because a TTL ran out.
- Stop asks the probe first. If a kernel is busy or the GPU is loaded, the bot shows what is running and wants a second, explicit confirm.
- If Jupyter sits idle for hours while voice is off, the bot asks once whether to stop it. It does not act on its own.

## Why not a scheduler

Tools like llama-swap and Ollama swap models on a timer. Full GPU schedulers share one card between several models by priority. On a 10 GB card the modes exclude each other anyway. The hard part is knowing when a mode is safe to stop.

[MIT](LICENSE)
