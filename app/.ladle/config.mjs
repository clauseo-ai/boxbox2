/* the stories: the thread's (docs/thread.md, verification), one per part
   type per state from the scrubbed fixtures, home's (docs/home.md,
   verification), one per window state from the recorded journal, and the
   shell's (docs/architecture.md, the route table), the whole app at each
   route. `bun run stories` in app/ serves them; `bun run shots` screenshots
   the thread's at three widths with the craft check, `bun run shots:home`
   home's with the naming check, `bun run shots:shell` the shell's with both. */
export default {
  stories: "src/**/*.stories.tsx",
  viteConfig: ".ladle/vite.config.ts",
  port: 61000,
  addons: {
    theme: { enabled: true, defaultState: "dark" },
    width: { enabled: true, options: { phone: 390, ipad: 820, mac: 1512 }, defaultState: 0 },
    rtl: { enabled: false },
    msw: { enabled: false },
  },
};
