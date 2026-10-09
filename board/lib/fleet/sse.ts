/* minimal sse parser: feed text chunks, get event payloads out. ported from
   the relay (same semantics as CmxKit's SSEParser): data: lines, blank-line
   dispatch, comment lines ignored. chunk-safe: partial lines carry across
   feeds. id/retry ignored: the cmx global feed doesn't replay. */

export type SSEEvent = {
  event: string | undefined;
  data: string;
};

export function createSSEParser() {
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;

  function feed(chunk: string): SSEEvent[] {
    buffer += chunk;
    const out: SSEEvent[] = [];
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        if (dataLines.length > 0) {
          out.push({ event: eventName, data: dataLines.join("\n") });
        }
        dataLines = [];
        eventName = undefined;
        continue;
      }
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "data") dataLines.push(value);
      else if (field === "event") eventName = value;
    }
    return out;
  }

  return { feed };
}
