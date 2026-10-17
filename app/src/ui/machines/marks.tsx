/* the os marks a machine card's tile draws (design.md, the machines: what a machine is). drawn here in the app's icon
   line (a 24 grid, a 1.6 stroke, round ends and joins, currentColor), not copied from anyone's logo files: an apple, a
   window of four panes, ubuntu's circle of friends, debian's swirl, a penguin for any other linux, and a plain screen
   where the os is not known. identity only, so each is aria-hidden: the card's words say the os. */

import { Match, Switch } from "solid-js";
import type { OsMark as Mark } from "./system";

export function OsMark(props: { mark: Mark }) {
  return (
    <svg class="os-mark" viewBox="0 0 24 24" aria-hidden="true" data-mark={props.mark}>
      <Switch>
        <Match when={props.mark === "apple"}>
          <path d="M12 7.7c-1-.8-2.2-1.2-3.5-1.1C6 6.8 4.6 8.8 4.6 11.6c0 4 2.6 8.6 5 8.6.9 0 1.5-.5 2.4-.5s1.5.5 2.4.5c1.6 0 3.2-2 4.2-4.5-1.5-.8-2.5-2.3-2.5-4 0-1.5.8-2.9 2-3.7-.9-1.2-2.2-1.9-3.7-1.9-1 0-1.7.3-2.4.8z" />
          <path d="M12.2 5.4c.1-1.5 1.1-2.7 2.6-3 0 1.6-1 2.8-2.6 3z" />
        </Match>
        <Match when={props.mark === "windows"}>
          <path d="M4.8 4.8h6.3v6.3H4.8zM12.9 4.8h6.3v6.3h-6.3zM4.8 12.9h6.3v6.3H4.8zM12.9 12.9h6.3v6.3h-6.3z" />
        </Match>
        <Match when={props.mark === "ubuntu"}>
          <path d="M17.47 14.91A6.2 6.2 0 0 1 11.78 18.2M6.74 15.29a6.2 6.2 0 0 1 0-6.58M11.78 5.8a6.2 6.2 0 0 1 5.69 3.29" />
          <circle cx="19.2" cy="12" r="1.7" />
          <circle cx="8.4" cy="18.24" r="1.7" />
          <circle cx="8.4" cy="5.76" r="1.7" />
        </Match>
        <Match when={props.mark === "debian"}>
          <path d="M15.4 18.6a7 7 0 1 1 3.5-6.9 4.9 4.9 0 0 1-4.9 4.9 3.5 3.5 0 0 1-3.5-3.5 2.3 2.3 0 0 1 2.3-2.3c1 0 1.7.6 1.9 1.4" />
        </Match>
        <Match when={props.mark === "linux"}>
          <path d="M12 3.4c-2.1 0-3.5 1.7-3.5 4.1 0 1.4-.5 2.4-1.4 3.6-1 1.5-1.9 3.2-1.9 5.1 0 2.4 3 4.4 6.8 4.4s6.8-2 6.8-4.4c0-1.9-.9-3.6-1.9-5.1-.9-1.2-1.4-2.2-1.4-3.6 0-2.4-1.4-4.1-3.5-4.1z" />
          <path d="M9.6 12.7c-.7 1.1-1 2.3-1 3.4 0 1.6 1.5 2.7 3.4 2.7s3.4-1.1 3.4-2.7c0-1.1-.3-2.3-1-3.4M10.7 7.3v.5M13.3 7.3v.5M11 9.5l1 .8 1-.8" />
        </Match>
        <Match when={props.mark === "machine"}>
          <path d="M5 5.2h14a1.3 1.3 0 0 1 1.3 1.3v8.6a1.3 1.3 0 0 1-1.3 1.3H5a1.3 1.3 0 0 1-1.3-1.3V6.5A1.3 1.3 0 0 1 5 5.2zM9 20h6M12 16.4V20" />
        </Match>
      </Switch>
    </svg>
  );
}
