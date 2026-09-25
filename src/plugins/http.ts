// Shared plumbing for plugin probes: bounded GETs, checked bodies, and
// turning any failure into a risk.
import { type } from "arktype";
import type { Activity } from "../probe.ts";
import type { ProbeTarget } from "./types.ts";

/**
 * GETs `path` under the service URL, giving up after 5 s. A leading slash is
 * optional; a base path such as http://host/jupyter/ is kept either way.
 */
export function get(target: ProbeTarget, path: string, authorization?: string): Promise<Response> {
  const base = target.url.endsWith("/") ? target.url : `${target.url}/`;
  return fetch(new URL(path.replace(/^\//, ""), base), {
    headers: authorization ? { authorization } : {},
    signal: AbortSignal.timeout(5_000),
  });
}

/** The body of a 2xx answer. Throws on any other status. */
export async function text(res: Response): Promise<string> {
  if (res.ok) return res.text();
  await res.body?.cancel();
  throw new Error(`${new URL(res.url).pathname} answered ${res.status}`);
}

/** The JSON body of a 2xx answer, validated. Throws on any other status, invalid JSON or a schema mismatch. */
export async function json<T>(res: Response, schema: (data: unknown) => T | type.errors): Promise<T> {
  const body = await text(res);
  const path = new URL(res.url).pathname;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${path} sent invalid JSON`);
  }
  const data = schema(parsed);
  if (data instanceof type.errors) throw new Error(`${path} sent unexpected JSON: ${data.summary}`);
  return data;
}

/** Busy means work is running now; an idle answer carries no timestamp. */
export function activity(busy: boolean, risks: string[] = []): Activity {
  return { busy, risks, lastActive: busy ? Date.now() : 0 };
}

/** Runs a probe. Any error becomes the risk "<id>: <message>", because not knowing is not idle. */
export async function guard(id: string, probe: () => Promise<Activity>): Promise<Activity> {
  try {
    return await probe();
  } catch (err) {
    const message = err instanceof Error ? err.message + (err.cause instanceof Error ? `: ${err.cause.message}` : "") : String(err);
    return { busy: false, risks: [`${id}: ${message}`], lastActive: Date.now() };
  }
}
