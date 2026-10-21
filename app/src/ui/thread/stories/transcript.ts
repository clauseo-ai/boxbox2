/* the open thread as the worker would hold it, for the stories that put a
   thread on the stage over a recorded fleet (home at the ipad and mac
   widths, the shell's thread): the native session the thread's stories
   read (../fixtures/notes-asks.json), at its last recorded moment. */

import type { Message } from "../../../sync/protocol";
import type { ThreadView } from "../../../sync/reducer";
import cmxUrl from "../fixtures/cmx-deploy.json?url";
import northstarUrl from "../fixtures/northstar-heavy.json?url";
import notesUrl from "../fixtures/notes-asks.json?url";

/** the notes session's transcript under `key`, live; fetched, never imported, so the type checker never reads the json */
export async function notesTranscript(key: string): Promise<ThreadView> {
  const file = (await (await fetch(notesUrl)).json()) as { snapshots: Array<{ messages: unknown[] }> };
  // the fixture is the daemon's message list, recorded through the same contract the worker reads
  const messages = (file.snapshots.at(-1)?.messages ?? []) as Message[];
  return { key, status: "live", messages };
}

/** the two long imported sessions' transcripts, for the story that opens threads as heavy as a working day's: each key
    in turn is given one of them, told `times` over (each telling with ids of its own) so a thread has the tens of turns a long
    one does, as a thread opened before is held in the cache */
export async function heavyTranscripts(keys: readonly string[], times = 8): Promise<Record<string, ThreadView>> {
  const files = await Promise.all(
    [northstarUrl, cmxUrl].map(async (url) => {
      const messages = ((await (await fetch(url)).json()) as { messages: unknown[] }).messages as Message[];
      return Array.from({ length: times }, (_, k) => messages.map((m) => retold(m, k))).flat();
    }),
  );
  const threads: Record<string, ThreadView> = {};
  keys.forEach((key, i) => {
    const messages = files[i % files.length];
    if (messages) threads[key] = { key, status: "live", messages };
  });
  return threads;
}

/** a message told again, the `k`th time: the same words under ids of its own (the first telling keeps the recorded ids) */
function retold(m: Message, k: number): Message {
  if (k === 0) return m;
  const id = `${m.info.id}_${k}`;
  const parent = (m.info as { parentID?: string }).parentID;
  return { ...m, info: { ...m.info, id, ...(parent ? { parentID: `${parent}_${k}` } : {}) }, parts: m.parts.map((p) => ({ ...p, id: `${p.id}_${k}`, messageID: id })) } as Message;
}
