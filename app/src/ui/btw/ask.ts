/* what a btw's send checks and what it leaves (docs/composer.md, btw mode), apart from mode.ts: the composer loads this at
   a btw's send, never in the first load (architecture.md, the script budget). pure, tested in mode.test.ts */

import { btwQuestion } from "./mode";

/** a btw is words: photos and files the draft holds are not sent with it, and a send says so rather than dropping them */
export const BTW_NO_PHOTOS = "a btw takes words only. remove the photos and files, or leave btw to send them to the agent";

/** why a btw draft cannot be asked here now: the composer is not offered btw (the thread's read has not landed, it has no
    turn yet, or its agent does not answer btws). the draft keeps its words and its chip; leaving btw sends them to the
    agent, as the person chooses. null when it can be asked */
export const BTW_UNAVAILABLE = "a btw can't be asked here yet. wait for the thread to load, or tap btw to send it to the agent instead";
/** what holds a btw draft's send, in the order it is said: not offered here, then photos or files in the draft (photos
    still on the device count: a btw takes none, so whether they are read is not its problem). null when it can go */
export function btwSendBlock(input: { offered: boolean; photos: number; held: boolean }): string | null {
  if (!input.offered) return BTW_UNAVAILABLE;
  if (input.photos > 0 || input.held) return BTW_NO_PHOTOS;
  return null;
}

/** after an ask lands, the draft it was asked from goes when it still holds that question: words typed into it while the
    ask was on its way are a new question and stay (and nothing is left to ask twice) */
export const askedDraftGoes = (nowText: string, asked: string): boolean => btwQuestion(nowText) === asked;
