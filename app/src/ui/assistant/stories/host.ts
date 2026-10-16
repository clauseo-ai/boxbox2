/* the react side every assistant story shares: a host element that mounts a solid tree and disposes it. written with
   createElement, since this file is react (ladle's host) and the project's jsx is solid's. */

import { createElement, type ReactElement, useEffect, useRef } from "react";

export type Mount = (el: HTMLElement) => () => void;

function Host(props: { mount: Mount }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? props.mount(el) : undefined;
  }, [props.mount]);
  return createElement("div", { ref, className: "story" });
}

/** a ladle story from a solid mount */
export const story = (mount: Mount) => (): ReactElement => createElement(Host, { mount });
