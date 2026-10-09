/* the pure parts of the probes: sse framing, the a1 cursor, and which asks
   cmx2's ASKS.md marks landed. no io here, so wire.test.ts can hold them. */

/** one sse frame as it came off the wire: `raw` is its exact text, the unit
    a1's byte-identical replay is judged on */
export interface Frame {
  raw: string;
  id: string | undefined;
  event: string | undefined;
  data: string;
}

/** splits complete frames off the front of `buffer` (lf or crlf line ends)
    and returns what is left for the next chunk */
export function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const text = buffer.replaceAll("\r\n", "\n");
  const frames: Frame[] = [];
  let start = 0;
  for (let end = text.indexOf("\n\n", start); end >= 0; end = text.indexOf("\n\n", start)) {
    const raw = text.slice(start, end);
    start = end + 2;
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (raw.length > 0) frames.push({ raw, id, event, data: data.join("\n") });
  }
  return { frames, rest: text.slice(start) };
}

/** a1's cursor, `<epoch>:<seq>`: the epoch is any run without a colon or
    space, the seq a non-negative integer */
export interface Cursor {
  epoch: string;
  seq: number;
}

export function parseCursor(id: string | undefined): Cursor | undefined {
  const match = /^([^:\s]+):(\d+)$/.exec(id ?? "");
  if (!match?.[1] || !match[2]) return undefined;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? { epoch: match[1], seq } : undefined;
}

/** the asks cmx2's ASKS.md marks landed. its table is `| # | ask | owner |
    shape |`; an ask is landed when its owner cell says so as a word ("m6,
    landed at abc1234") and not "not landed". the shape cell is prose and
    never counts. a missing file means nothing has landed. */
export function landedAsks(asksMd: string | undefined): Set<string> {
  const landed = new Set<string>();
  for (const line of (asksMd ?? "").split("\n")) {
    const row = /^\|\s*(a\d+)\s*\|(.*)\|\s*$/.exec(line.trim());
    if (!row?.[1] || !row[2]) continue;
    const owner = row[2].split("|")[1] ?? "";
    if (/\blanded\b/i.test(owner) && !/\bnot\s+landed\b/i.test(owner)) landed.add(row[1]);
  }
  return landed;
}

/** the first place `value` appears anywhere under `root`, as a dotted path; a4's echo may sit at the
    top of an event's properties or inside its info, and the contract does not say which */
export function findValue(root: unknown, value: string, path = ""): string | undefined {
  if (root === value) return path || ".";
  if (root === null || typeof root !== "object") return undefined;
  for (const [key, child] of Object.entries(root)) {
    const found = findValue(child, value, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return undefined;
}
