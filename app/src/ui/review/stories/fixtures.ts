/* the made-up checkout the review stories share: a patch, a review of it and the agent's note, and the server's answer to a merge */

import type { Merged, Review } from "../model";

export const PATCH = [
  "diff --git a/src/ui/pricing/toggle.tsx b/src/ui/pricing/toggle.tsx",
  "index 3f2a1b0..9c8d7e6 100644",
  "--- a/src/ui/pricing/toggle.tsx",
  "+++ b/src/ui/pricing/toggle.tsx",
  "@@ -12,7 +12,9 @@ export function Toggle(props: ToggleProps) {",
  "   const [yearly, setYearly] = createSignal(false);",
  "-  return <button onClick={() => setYearly(!yearly())}>monthly</button>;",
  "+  return (",
  "+    <button aria-pressed={yearly()} onClick={() => setYearly(!yearly())}>",
  "+      {yearly() ? \"yearly\" : \"monthly\"}",
  "+    </button>",
  "+  );",
  " }",
  "diff --git a/docs/pricing.md b/docs/pricing.md",
  "new file mode 100644",
  "index 0000000..4b825dc",
  "--- /dev/null",
  "+++ b/docs/pricing.md",
  "@@ -0,0 +1,2 @@",
  "+the yearly price is ten months of the monthly one.",
  "+it renews on the day it started.",
  "",
].join("\n");

export const review: Review = {
  checkout: "site-fix",
  branch: "agent/site-fix",
  base: "main",
  baseRef: "refs/heads/main",
  commits: 3,
  dirty: false,
  mergeable: true,
  additions: 44,
  deletions: 6,
  files: [
    { path: "src/ui/pricing/toggle.tsx", status: "modified", additions: 40, deletions: 6 },
    { path: "src/ui/pricing/pricing.css", status: "modified", additions: 2, deletions: 0 },
    { path: "docs/pricing.md", status: "added", additions: 2, deletions: 0 },
    { path: "src/ui/pricing/old-banner.tsx", status: "deleted", additions: 0, deletions: 18 },
    { path: "~/Library/Developer/Xcode/DerivedData/Boxbox-bdjqhkgwmdkcxmchlrmqzzvhsldc/SourcePackages/checkouts/SampleBufferDisplayRendererCompositor.swift", status: "added", additions: 4391, deletions: 0 },
  ],
  diff: PATCH,
  truncated: false,
};

export const NOTE = "the annual toggle is in and the table holds at 320 wide. tests pass; the checkout page was not touched.";
export const merged: Merged = { merged: true, commit: "9c8d7e6", base: "main", branch: "agent/site-fix", commits: 3, stopped: [] };
