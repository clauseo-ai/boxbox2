/** the away line's words, and its sheet's title (docs/home.md, cleared while you were away). a module of its own: the line
    is in the first load, the sheet's words (away.ts) are not */
export function awayWords(count: number): string {
  return `${count} cleared while you were away`;
}
