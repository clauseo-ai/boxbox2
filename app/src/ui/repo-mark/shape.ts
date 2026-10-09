/* the squircle every repo mark is cut to: a superellipse, |x|^n + |y|^n = 1, the continuous corner of an ios icon
   (the curvature eases into the straight edge instead of meeting it, which is what a border-radius cannot do).
   n = 5 is the nearest superellipse to apple's icon. one shape, drawn as a path in a 100 by 100 box and used as a css
   mask (repo-mark.css), so it scales to any size and works in safari, which has no `corner-shape`. repo-mark.css holds
   this path as a data uri; shape.test.ts proves the two are the same, so they cannot drift. */

/** the superellipse exponent */
export const SQUIRCLE_N = 5;

/** points around the whole shape: two degrees apart or less is smooth to the eye at any size a mark is drawn */
const STEPS = 160;

/** the squircle as an svg path in a 100 by 100 box */
export function squirclePath(n: number = SQUIRCLE_N, steps: number = STEPS): string {
  const power = 2 / n;
  const points: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = 50 + 50 * Math.sign(cos) * Math.abs(cos) ** power;
    const y = 50 + 50 * Math.sign(sin) * Math.abs(sin) ** power;
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `${points.join("")}Z`;
}
