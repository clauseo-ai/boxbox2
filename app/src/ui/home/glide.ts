/* what a stage's contents do while its edge moves (design.md, motion law; docs/home.md, the folds).

   the card's edge glides by clip-path while the layout is committed once, so every box inside the card is
   laid out where it will end up (or where it started, for a card that shrinks), and a box that is somewhere
   else on screen than its layout says is carried there by a translate. which boxes are carried is decided
   from two measurements and nothing else, so the stage's markup is not part of the contract: a box that
   stayed where it was is left alone, a box that moved as one piece is carried as one piece, and a box that
   stretched (a bar from edge to edge, the scroller) is looked through to the boxes inside it, unless it has
   words of its own, which no box inside it can carry. a stretched box that only paints (the flood, a rule) is
   stretched back to the width it had, since a scale draws its gradients and its lines exactly as the layout would.

   what a carry cannot do is reflow: a paragraph laid out at one width breaks its lines elsewhere at another, and a
   translate keeps the breaks of the layout it is carried from. `carriers` says when that happened (a box with words
   that run over more than one line, and a width that changed), and the move dissolves the content instead of
   pretending (edge.ts). */

export type Span = { left: number; right: number };

/** where the words in a box sit in it */
export type Align = "left" | "right" | "center";

/** a box with where its layout puts it while the edge moves and where it has to look to be while it does. `text` is
    where its own words sit, or null for a box that has none (a container, a background), and `wraps` that they run over
    more than one line in one layout or the other. `paint` is true for a box that only paints: no corners, border or
    shadow of its own, which a stretch would distort */
export type Boxed<T> = { el: T; layout: Span; visual: Span; text: Align | null; wraps: boolean; paint: boolean; inside: Boxed<T>[] };

/** `dx` moves the box; `sx`, where there is one, also stretches it about its middle, and `dx` is then how far its middle moves */
export type Carry<T> = { el: T; dx: number; sx?: number };

/** closer than this is the same place: a rect is read to a fraction of a pixel */
const SAME = 0.5;

/** `side` is the edge of the card that travels: a box that stretched and has nothing inside to look through is
    stretched to its old width if it only paints, and else carried with that edge, since its edge is what moved */
export function carriers<T>(boxes: readonly Boxed<T>[], side: "left" | "right"): { carried: Carry<T>[]; reflows: boolean } {
  const carried: Carry<T>[] = [];
  let reflows = false;
  const carry = (el: T, dx: number) => {
    if (Math.abs(dx) >= SAME) carried.push({ el, dx });
  };
  const visit = (box: Boxed<T>) => {
    const left = box.visual.left - box.layout.left;
    const right = box.visual.right - box.layout.right;
    if (Math.abs(left) < SAME && Math.abs(right) < SAME) return;
    if (Math.abs(left - right) < SAME) {
      carry(box.el, left);
      return;
    }
    // a stretched box with words of its own is carried whole, by the edge its words hang from: its children go with it
    if (box.text !== null) {
      if (box.wraps) reflows = true;
      carry(box.el, box.text === "left" ? left : box.text === "right" ? right : (left + right) / 2);
      return;
    }
    if (box.inside.length > 0) {
      for (const inner of box.inside) visit(inner);
      return;
    }
    const was = box.layout.right - box.layout.left;
    if (box.paint && was >= 1) {
      carried.push({ el: box.el, dx: (left + right) / 2, sx: (box.visual.right - box.visual.left) / was });
      return;
    }
    carry(box.el, side === "left" ? left : right);
  };
  for (const box of boxes) visit(box);
  return { carried, reflows };
}
