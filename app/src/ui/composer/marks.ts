/* which provider is which mark, and how the menu words a provider. the marks themselves are marks-data.ts, which is not in the app's script
   (it is an svg sprite in index.html, see there); this is the small part that is. pure: nothing here imports solid. */

/** what a provider calls itself, folded (lowercase letters and digits only) to the mark's name */
export const MARK_ALIASES: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  claude: "anthropic",
  google: "google",
  googlevertex: "google",
  googlevertexai: "google",
  vertex: "google",
  vertexai: "google",
  googleaistudio: "google",
  gemini: "gemini",
  googlegemini: "gemini",
  mistral: "mistral",
  mistralai: "mistral",
  meta: "meta",
  metaai: "meta",
  metallama: "meta",
  llama: "meta",
  deepseek: "deepseek",
  openrouter: "openrouter",
  ollama: "ollama",
  perplexity: "perplexity",
  huggingface: "huggingface",
  hf: "huggingface",
  lmstudio: "lmstudio",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  kimi: "moonshot",
  qwen: "qwen",
  alibaba: "qwen",
  nvidia: "nvidia",
  cloudflare: "cloudflare",
  workersai: "cloudflare",
  githubcopilot: "copilot",
  copilot: "copilot",
  vercel: "vercel",
  vercelaigateway: "vercel",
  openai: "openai",
  xai: "xai",
  grok: "xai",
  groq: "groq",
  cohere: "cohere",
  together: "together",
  togetherai: "together",
  fireworks: "fireworks",
  fireworksai: "fireworks",
  cerebras: "cerebras",
  azure: "azure",
  azureopenai: "azure",
  microsoftazure: "azure",
};

/** how the menu says a provider: the words it uses for itself, which are not always the display name */
const WORDS: Readonly<Record<string, string>> = {
  googlevertex: "google",
  googlevertexai: "google",
  googleaistudio: "google",
  amazonbedrock: "bedrock",
  awsbedrock: "bedrock",
  githubcopilot: "copilot",
  microsoftazure: "azure",
  azureopenai: "azure",
};

const fold = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** the provider's own id for a model: the segment of "anthropic/claude-opus-5-5" before the first slash;
    with no slash, the display name lowercased and normalised (runs of anything else become one hyphen) */
export function providerKey(model: { id: string; provider: string }): string {
  const slash = model.id.indexOf("/");
  const head = slash > 0 ? model.id.slice(0, slash).trim().toLowerCase() : "";
  if (head) return head;
  return model.provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** a key or a display name folded to the name of its mark (marks-data.ts), or null when there is none */
export function markNameOf(keyOrName: string): string | null {
  return MARK_ALIASES[fold(keyOrName)] ?? null;
}

/** the provider as the menu words it: lowercase and plain, from the display name ("Mistral AI" is "mistral") */
export function providerWords(display: string): string {
  const folded = fold(display);
  const said = WORDS[folded];
  if (said !== undefined) return said;
  const words = display
    .toLowerCase()
    .replace(/[\u2013\u2014-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // "Mistral AI", "Together AI": the trailing "ai" is the company's suffix, not its name
  if (words.length > 1 && words[words.length - 1] === "ai") words.pop();
  return words.join(" ");
}
