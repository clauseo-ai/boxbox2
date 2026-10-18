/* pairing a thread with a digit key (docs/board.md, the channel): `POST /api/board/pin` arms the board for 30 s, and the
   next digit pressed takes the thread in its window's livery. what came of it reaches the store through `board.here`
   (store.ts, boardHere), which settles the pin when it shows the thread on a paired key. */

import { api } from "../api/client";
import { setBoardPairing, setBoardPin, state } from "../store";

/** the server holds an armed pin this long (docs/board.md); the app waits as long, and then says nothing was pressed */
export const PIN_MS = 30_000;

/** `#rrggbb` as the wire's three bytes */
export function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** what a refusal says, by the server's answer (its document: 409 no board here, 503 its stream is not reading) */
export function refusalOf(status: number): string {
  switch (status) {
    case 401:
      return "you are signed out. sign in, then pair again.";
    case 409:
      return "the board is not plugged into this mac now. plug it in, then pair again.";
    case 503:
      return "the board is not answering yet. pair again in a moment.";
    default:
      return `the server answered ${status}, so nothing was paired. try again.`;
  }
}

/** arms the board for `key`, in the window's light tone (the bright one of its pair, which a key's led can show) */
export async function armPin(key: string, light: string): Promise<void> {
  const was = state.board.bound[key] ? (state.board.digits[key] ?? null) : null;
  try {
    const { response } = await api.POST("/api/board/pin", { body: { key, color: rgbOf(light) } });
    if (response.status === 204) setBoardPin({ key, phase: "armed", until: Date.now() + PIN_MS, was });
    // no [board] on this server: there is nothing to pair with, so the menu stops offering it rather than failing again
    else if (response.status === 404) {
      setBoardPairing(false);
      setBoardPin(null);
    } else setBoardPin({ key, phase: "refused", why: refusalOf(response.status) });
  } catch {
    setBoardPin({ key, phase: "refused", why: "the server is not answering, so nothing was paired. try again." });
  }
}
