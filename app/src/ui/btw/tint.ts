/* the btw tint (docs/design.md, colour: the btw exception). colour means which repo everywhere else; a btw is the one
   thing on the stage that is not the thread, and the owner asked that it be unmistakable, so it wears one fixed hue,
   citron, from the one gap left in the hue wheel: every other hue is a repo's (repo.ts, the ten and the five), and the
   amber beside it is a state (a blocked report's gold, a machine's strain), so the yellow sits clear of both, lemon and
   not gold. it is a palette of the repo palette's shape, so the composer window in btw mode is the same window recipe
   in this hue and the same proofs hold it (tint.test.ts); the card reads the css tokens styles.css declares from these
   same values, which the test holds equal. */

import type { RepoColour } from "../window/repo";

export const BTW_COLOUR: RepoColour = { name: "citron", top: "#4b4100", bottom: "#201b00", light: "#ffe680" };
