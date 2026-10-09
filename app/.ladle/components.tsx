/* ladle's global provider: the app's tokens and fonts around every story,
   and the page's ground (dark or light, as the system or the root's
   data-theme says). written with createElement, since this file is react and
   the project's jsx is solid's; ladle's own types are not imported, as their
   sources would be checked as solid jsx. */

import { type ReactElement, type ReactNode, createElement, useEffect } from "react";
import "../src/styles.css";

/* an uncaught error or rejection in a story is kept on the page (`window.__boxboxErrors`) for the screenshot test
   (shots.ts) to read and fail on, and written to the console for a person. installed before the first story renders. */
declare global {
  interface Window {
    __boxboxErrors?: string[];
  }
}
if (typeof window !== "undefined" && window.__boxboxErrors === undefined) {
  const errors: string[] = (window.__boxboxErrors = []);
  const note = (message: string) => { errors.push(message); console.error(`page error: ${message}`); };
  window.addEventListener("error", (e) => note(e.message));
  window.addEventListener("unhandledrejection", (e) => note(String(e.reason)));
}

export const Provider = ({ children }: { children: ReactNode }): ReactElement => {
  useEffect(() => {
    /* the app's html never scrolls (styles.css); a story does */
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    document.body.style.background = "var(--ground)";
  }, []);
  return createElement("div", { className: "ladle-ground" }, children);
};
