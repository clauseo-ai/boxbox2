/* "show all 300 lines" (docs/thread.md, code and copying): apart from code.tsx, which is a chunk of its own, since a command's
   output bed and a diff in the first load show it too */

import { showAllWords } from "./code-text";

/** the control at the foot of a bed that shows its opening lines, which opens it in place to every line. it goes one way: the row's
    head closes the row, and the row opens again with the bed short */
export function ShowAll(props: { count: number; diff?: boolean; /** the row it is in, which its name is told apart by */ row: string; onShow: () => void }) {
  const words = () => showAllWords(props.count, props.diff === true);
  return <button class="bed-all" aria-label={`${words()}, ${props.row}`} onClick={() => props.onShow()}>{words()}<i aria-hidden="true" /></button>;
}
