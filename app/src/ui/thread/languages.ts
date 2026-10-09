/* what a fenced block's info string means (docs/thread.md, code blocks): the name its header shows and the grammar that paints it. this is
   the list of highlight.js 11.12.0's grammars that boxbox registers (highlight-engine.ts), with the aliases an agent writes (hljs knows more,
   which read as the word written and paint plain), as data so a block's header can say its language on the first frame, before the
   highlighter's own code (a chunk of its own) has arrived. a grammar's header name is hljs's own name for it, lowercased, as `ts` reads
   `typescript`; `highlight.test.ts` holds this list to hljs's registry: every grammar and name derived here is hljs's, and every alias written
   is one hljs knows. pure; no dom. */

/** each grammar, and the aliases written for it */
export const LANGUAGES = {
  bash: "sh zsh", c: "", cpp: "c++", css: "", diff: "patch", dockerfile: "docker", go: "golang", ini: "toml", java: "", javascript: "js jsx", json: "jsonc",
  kotlin: "kt", markdown: "md", plaintext: "text txt", python: "py", ruby: "rb", rust: "rs", sql: "", swift: "", typescript: "ts tsx", xml: "html svg", yaml: "yml",
} as const;

export type GrammarKey = keyof typeof LANGUAGES;

/** what a fence's info string comes to: the name the block's header shows (none for an unlabelled fence) and the grammar that paints it (none when plain) */
export type Language = { label?: string; grammar?: string };

/** the longest language word a header shows: past it the word is not a language (a sentence on a fence's line), and a header is one line */
export const INFO_WORD_MAX = 24;

/** the first word of a fence's info string, lowercased and cut at INFO_WORD_MAX: what the author called the language */
export function infoWord(info: string | undefined | null): string {
  return (info ?? "").trim().split(/\s+/)[0]?.replace(/^[{.]+|[}]+$/g, "").toLowerCase().slice(0, INFO_WORD_MAX) ?? "";
}

/** the one class the sanitiser lets through: marked's `language-ts` on the code of a fence. every other class is dropped, since a class is how an agent's html could pass for our controls or for the thread itself (thread.css styles by class) */
export const keepsClass = (tag: string, value: string): boolean => tag === "CODE" && /^language-[\w+#.-]{1,24}$/.test(value);

/** every grammar's key and aliases to its key, built once. what agents write for a shell is added: hljs files "shell" and "console" under its shell session grammar, a prompt-and-output transcript, so they are pointed at bash */
const KEYS = new Map<string, GrammarKey>([["shell", "bash"], ["console", "bash"]]);
for (const [key, aliases] of Object.entries(LANGUAGES) as Array<[GrammarKey, string]>) for (const word of [key, ...aliases.split(" ")]) if (word) KEYS.set(word, key);

/** the language of a fence: `ts` reads typescript, `sh` and `zsh` bash, `yml` yaml. an unknown word is shown as the author wrote it, lowercased, and paints plain; plain text says the word it was written as; no word at all says nothing. hljs names two of its grammars after the pair they serve ("HTML, XML", "TOML, also INI"): the block says the one the author wrote */
export function languageOf(info: string | undefined | null): Language {
  const word = infoWord(info);
  if (!word) return {};
  const grammar = KEYS.get(word);
  if (!grammar || grammar === "plaintext") return { label: word };
  return { label: grammar === "xml" ? (word === "html" || word === "svg" ? word : "xml") : grammar === "ini" ? (word === "ini" ? word : "toml") : grammar === "cpp" ? "c++" : grammar, grammar };
}
