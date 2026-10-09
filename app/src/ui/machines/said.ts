/* how an api answer is said, apart from the verb telemetry (verb.ts) so that code with no browser in it, and its tests, can use
   the words without pulling in the device's. */

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** an api error's message, in the server's voice, or what to say when there was none */
export function said(error: unknown, status: number): string {
  const message = (error as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof message === "string" ? message : `the server answered ${status}. try again.`;
}

export const UNREACHABLE = "the boxbox server is not answering. check it is running, then try again.";
