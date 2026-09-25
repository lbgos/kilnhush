// Wyoming speech servers (faster-whisper, piper): raw TCP, no HTTP and no
// busy signal, so only a TCP connect tells that one is up.
import type { Plugin } from "./types.ts";

export const wyoming: Plugin = {
  id: "wyoming",
  name: "Wyoming (Whisper/Piper)",
  port: 10300,
  health: "tcp",
  run: "always",
  idle: 20 * 60_000,
  detect: {
    unit: /^wyoming[\w@.-]*\.service$/,
    image: /(^|\/)(rhasspy|ohf-voice)\/wyoming-(whisper|piper)(:|$)/i,
    cmdline: /\bwyoming_(faster_whisper|piper)\b/,
  },
  route: () => "passive",
};
