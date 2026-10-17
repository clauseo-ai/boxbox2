/* the composer's icons: one place, one drawing grammar (24 box, 1.8 stroke, round caps and joins, currentColor), so a tool
   row, a chip and a sheet button read as one family. decorative always (aria-hidden): every control carries its own
   name. drawn for boxbox, plain geometry. */

import type { JSX } from "solid-js";

const PATHS = {
  plus: "M12 5v14M5 12h14",
  close: "M7 7l10 10M17 7 7 17",
  check: "m6 12.5 4 4 8-9",
  search: "M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13zM16 16l4.5 4.5",
  star: "M12 3.8l2.45 5.1 5.55.78-4.04 3.9.97 5.52L12 16.5l-4.93 2.6.97-5.52L4 9.68l5.55-.78z",
  chevronDown: "m7 10 5 5 5-5",
  chevronUp: "m7 14 5-5 5 5",
  chevronRight: "m9 6 6 6-6 6",
  retry: "M20 12a8 8 0 1 1-2.4-5.7M20 4v5h-5",
  alert: "M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17zM12 8v5M12 16.2v.1",
  photo: "M6.5 5h11A3 3 0 0 1 20.5 8v8a3 3 0 0 1-3 3h-11A3 3 0 0 1 3.5 16V8a3 3 0 0 1 3-3zM9 8.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM20.5 16l-4.5-4.5L7 19",
  command: "M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM14.2 8l-4.4 8",
  file: "M7.5 3.5h6L18.5 8.5v10A2 2 0 0 1 16.5 20.5h-9A2 2 0 0 1 5.5 18.5v-13a2 2 0 0 1 2-2zM13.5 3.5v5h5",
  /* a page with its lines: a file that goes with the message, where `file` is one mentioned by its path */
  doc: "M7.5 3.5h6L18.5 8.5v10A2 2 0 0 1 16.5 20.5h-9A2 2 0 0 1 5.5 18.5v-13a2 2 0 0 1 2-2zM13.5 3.5v5h5M8.8 13h6.4M8.8 16.5h4.4",
  terminal: "M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4zM8 9.5l3 2.5-3 2.5M13 15h3.5",
  agents: "M12 3.5a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM6 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM18 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM12 7.5V11M12 11H6v5M12 11h6v5",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  compact: "M12 3.5v6M9 6.5l3 3 3-3M12 20.5v-6M9 17.5l3-3 3 3M4.5 12h15",
  machine: "M6.5 5h11A1.5 1.5 0 0 1 19 6.5V15H5V6.5A1.5 1.5 0 0 1 6.5 5zM3 18.5h18",
  folder: "M4 7.5A2 2 0 0 1 6 5.5h3.6l2 2.5H18a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  // a branch: the repo's own folder, as it stands
  branch: "M7 3.2a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8zM7 16a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8zM7 8v8M17 7a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8zM17 11.8c0 4-3 6.6-7.6 7",
  // a branch that ends in a plus: a worktree made new, on a branch of its own
  worktree: "M7 3.2a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8zM7 16a2.4 2.4 0 1 0 0 4.8a2.4 2.4 0 1 0 0-4.8zM7 8v8M17 4v6M14 7h6M17 10.5c0 4.2-3 7.3-7.6 8.5",
  tune: "M4.5 8h8M17.5 8h2M4.5 16h2M11.5 16h8M15 5.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4zM9 13.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  return (
    <svg class={props.class ? `cz-i ${props.class}` : "cz-i"} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[props.name]} />
    </svg>
  );
}
