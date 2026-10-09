/* a model's one name in the whole app: the composer's chip and its menu, the thread's facts line and its details all
   say "opus 5.5" for `anthropic/claude-opus-5-5`, never the slug and never two spellings */

/** a model id in the form a person says it, lowercase: "anthropic/claude-opus-5-5" is "opus 5.5", "gpt-5.2-codex" is
    "gpt 5.2 codex". a dated id loses its date, a "-latest" id says so */
export function modelName(id: string): string {
  let name = (id.split("/").at(-1) ?? id).replace(/-\d{8}$/, "");
  const latest = name.endsWith("-latest");
  if (latest) name = name.slice(0, -"-latest".length);
  // a version written with dashes ("5-5", "4-6") reads as one with a point
  name = name.replace(/^claude-/, "").replace(/(\d)-(?=\d)/g, "$1.").replace(/-/g, " ").trim().toLowerCase();
  return latest ? `${name} (latest)` : name;
}
