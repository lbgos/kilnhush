// One-time codes that let a new Telegram user in. `kilnhush pair` asks the
// agent for a code; the bot redeems it when that user sends `/start <code>`.
// Codes live in memory only, so an agent restart drops them.
import { randomInt } from "node:crypto";

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const ttl = 10 * 60_000;

export class Pairing {
  #codes = new Map<string, number>();
  /** The bot's Telegram username once it is known, for t.me links. */
  bot: string | null = null;

  constructor(private now: () => number = Date.now) {}

  create() {
    const now = this.now();
    for (const [code, expires] of this.#codes) if (expires <= now) this.#codes.delete(code);
    const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
    this.#codes.set(code, now + ttl);
    return { code, link: this.bot ? `https://t.me/${this.bot}?start=${code}` : null };
  }

  /** Whether `code` was issued, is unused and has not expired. */
  valid(code: string) {
    return (this.#codes.get(code.toLowerCase()) ?? 0) > this.now();
  }

  /** Uses up `code`. True when it was valid. */
  redeem(code: string) {
    const expires = this.#codes.get(code.toLowerCase());
    this.#codes.delete(code.toLowerCase());
    return expires !== undefined && expires > this.now();
  }
}
