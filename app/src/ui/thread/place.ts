/* the place line above a thread's title (docs/thread.md, the stage): the repo's name, its folder's last part. a thread whose folder
   has no such name reads as a word, not a stray glyph: the root of the disk ("/") is the machine itself, a home folder is "home".
   pure. */

import { repoName } from "../window/repo";

/** a home folder: /Users/<name>, /home/<name>, /root, or ~ */
const HOME = /^(?:~|\/root|\/(?:Users|home)\/[^/\\]+)$/;

/** what the place line calls a thread's folder: the repo's name; the machine's name for the disk's root (or no folder); "home" for a
    home folder */
export function placeName(root: string, host: string): string {
  const trimmed = root.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return host;
  if (HOME.test(trimmed)) return "home";
  return repoName(trimmed);
}
