/* the dom write probe (docs/home.md, verification): a MutationObserver over a story that counts every attribute and text
   write, and the ones that set the value already there, by the element's class and the attribute. a write that changes
   nothing still dirties style and wakes webkit's accessibility cache, so the writes stories hold the same-value count at 0.
   a record's new value is the old value of the next record for the same node and attribute, or what the node holds once
   the batch is read, so two writes inside one batch are each judged against the value before them */

export type WriteCounts = { total: number; same: number; text: number; sameText: number; by: Record<string, number>; /** child lists that lost an element, by the parent */ rebuilt: Record<string, number> };

const label = (node: Node): string => {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return "?";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  return cls ? `${el.localName}.${cls}` : el.localName;
};

export function probeWrites(root: Node): { counts: WriteCounts; reset: () => void; stop: () => void } {
  const counts: WriteCounts = { total: 0, same: 0, text: 0, sameText: 0, by: {}, rebuilt: {} };
  const read = (records: MutationRecord[]) => {
    const next = new Map<string, string | null>();
    const ids = new WeakMap<Node, number>();
    let id = 0;
    const keyOf = (r: MutationRecord) => {
      let n = ids.get(r.target);
      if (n === undefined) ids.set(r.target, (n = id++));
      return `${n}|${r.type === "attributes" ? r.attributeName : "#text"}`;
    };
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i] as MutationRecord; // i runs over the list's own indices
      if (r.type === "childList") {
        if ([...r.removedNodes].some((n) => n instanceof Element)) {
          const at = label(r.target);
          counts.rebuilt[at] = (counts.rebuilt[at] ?? 0) + 1;
        }
        continue;
      }
      const key = keyOf(r);
      const now = next.has(key) ? (next.get(key) ?? null) : r.type === "attributes" ? (r.target as Element).getAttribute(r.attributeName ?? "") : r.target.nodeValue;
      next.set(key, r.oldValue);
      if (r.type === "attributes") {
        counts.total++;
        if (now === r.oldValue) {
          counts.same++;
          const at = `${label(r.target)} ${r.attributeName ?? ""}`;
          counts.by[at] = (counts.by[at] ?? 0) + 1;
        }
      } else {
        counts.text++;
        if (now === r.oldValue) {
          counts.sameText++;
          const at = `${label(r.target)} #text`;
          counts.by[at] = (counts.by[at] ?? 0) + 1;
        }
      }
    }
  };
  const observer = new MutationObserver(read);
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
  return {
    counts,
    reset: () => {
      read(observer.takeRecords());
      Object.assign(counts, { total: 0, same: 0, text: 0, sameText: 0, by: {}, rebuilt: {} });
    },
    stop: () => {
      read(observer.takeRecords());
      observer.disconnect();
    },
  };
}
