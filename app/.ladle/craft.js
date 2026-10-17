/* the craft check: run in the page. flags text crowding its container's edge, surfaces touching each other,
   and surfaces touching the screen's edge. returns counts and the worst offenders. a page can set
   `window.__craftRoot` to a selector to check one surface's subtree (a drive for the thread on a home full of
   windows beneath it); the whole body otherwise. */
(() => {
  const MIN_INSET = 8, MIN_GAP = 6, MIN_EDGE = 12;
  /* marks of a chart sit side by side, not stacked: a step strip's two command bars (`.strip-mk`) read as touching surfaces */
  const skip = ".mk, .marks i, .strip-mk, .ph, .fb, .fb i, .meter, .meter b, .segs i, .scale i, .head, .playhead, .ruler, .ruler *, .rcard, .cap, .chev, .tick, .dot, .send, .round, .demo, .demo *, .strip.sw, .sw, .lbg, .scrim, .stage, #app, .tok, .hash, code, mark, .ins, .sh, .gh, .tkh, .ci, .mini, .mini *, .bed span, .clamp";
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  /* a gradient or a shadow paints only if one of its colours is not fully transparent. a surface drawn in one appearance and
     left clear in the other (a card of paper in light whose colours are all alpha 0 in dark, its padding 0) is not a surface
     there. chrome computes a color-mix as `color(srgb r g b / a)` and a plain colour as `rgb(r, g, b)` or `rgba(r, g, b, a)`,
     inside strings for gradients and shadows, so the alphas are read out of those three shapes */
  const alpha = (inner) => inner.includes("/") ? parseFloat(inner.split("/")[1]) : inner.includes(",") && inner.split(",").length === 4 ? parseFloat(inner.split(",")[3]) : 1;
  const paints = (value) => {
    if (value === "none") return false;
    const colours = [...value.matchAll(/(?:rgba?|color)\(([^)]*)\)/g)];
    return !colours.length || colours.some((m) => alpha(m[1]) > 0);
  };
  const isSurface = (el) => {
    if (el.matches(skip) || !visible(el)) return false;
    /* a layer under another (inert, drawn scaled behind the one on top) is not what is being read: its insets are the top layer's to keep */
    if (el.closest("[inert]")) return false;
    const c = getComputedStyle(el);
    if (c.display === "inline") return false;
    if (el.tagName === "BUTTON" && el.getBoundingClientRect().height <= 36) return false;
    if (c.visibility === "hidden" || el.closest(".overflows") || el.closest("[style*='visibility: hidden']")) return false;
    for (let a = el; a; a = a.parentElement) if (getComputedStyle(a).visibility === "hidden") return false;
    for (let a = el.parentElement; a; a = a.parentElement) { const ac = getComputedStyle(a); if (ac.overflow !== "visible" && a.getBoundingClientRect().width < 1) return false; }
    const bg = c.backgroundColor !== "rgba(0, 0, 0, 0)" && c.backgroundColor !== "transparent";
    const r = el.getBoundingClientRect();
    return (bg || paints(c.backgroundImage) || paints(c.boxShadow)) && parseFloat(c.borderRadius) > 0 && r.width >= 40 && r.height >= 24;
  };
  const root = (window.__craftRoot && document.querySelector(window.__craftRoot)) || document.body;
  const surfaces = [...root.querySelectorAll("*")].filter(isSurface);
  const surfaceOf = (node) => { let el = node.parentElement; while (el && !surfaces.includes(el)) el = el.parentElement; return el; };
  const crowd = [];
  for (const s of surfaces) {
    const sr = s.getBoundingClientRect();
    const walker = document.createTreeWalker(s, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.textContent.trim() && surfaceOf(n) === s ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    let n, worst = null;
    while ((n = walker.nextNode())) {
      const range = document.createRange(); range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (!r.width) continue;
        /* text scrolled out of a clipping box is not crowding */
        if (r.right > sr.right + 1 || r.left < sr.left - 1 || r.bottom > sr.bottom + 1 || r.top < sr.top - 1) continue;
        /* text cut by a clipping box between it and the surface is scrolled or clamped, not crowded */
        let clip = n.parentElement, clipped = false;
        while (clip && clip !== s) { const cs = getComputedStyle(clip); if (cs.overflowX !== "visible" || cs.overflowY !== "visible") { const cr = clip.getBoundingClientRect(); if (r.right > cr.right + 1 || r.left < cr.left - 1 || r.bottom > cr.bottom + 1 || r.top < cr.top - 1) clipped = true; } clip = clip.parentElement; }
        /* a scroller that fades its ends is meant to carry text to its edge */
        for (let m = n.parentElement; m && m !== s; m = m.parentElement) if (getComputedStyle(m).maskImage !== "none" || getComputedStyle(m).webkitMaskImage !== "none") { clipped = true; break; }
        if (clipped) continue;
        const d = { left: r.left - sr.left, right: sr.right - r.right, top: r.top - sr.top, bottom: sr.bottom - r.bottom };
        for (const [side, v] of Object.entries(d)) if (v < MIN_INSET && (!worst || v < worst.v)) worst = { side, v: Math.round(v * 10) / 10, text: n.textContent.trim().slice(0, 30) };
      }
    }
    if (worst) crowd.push({ surface: s.className.toString().slice(0, 40), ...worst });
  }
  const touch = [];
  for (const s of surfaces) {
    const sib = s.nextElementSibling; if (!sib || !surfaces.includes(sib)) continue;
    const a = s.getBoundingClientRect(), b = sib.getBoundingClientRect();
    const gap = b.top - a.bottom;
    if (gap < MIN_GAP && gap > -a.height) touch.push({ a: s.className.toString().slice(0, 30), b: sib.className.toString().slice(0, 30), gap: Math.round(gap) });
  }
  const edge = [];
  for (const s of surfaces) { /* a sheet from the screen's foot spans a phone's width, and the reader the whole screen, by design */ if (s.closest(".strip-row, .wins, .rep-sheet, .reader")) continue; const r = s.getBoundingClientRect(); const d = Math.min(r.left, innerWidth - r.right); if (d < MIN_EDGE && d > -1) edge.push({ surface: s.className.toString().slice(0, 40), d: Math.round(d) }); }
  const group = (arr, key) => Object.entries(arr.reduce((m, x) => { const k = key(x); (m[k] ||= []).push(x); return m; }, {})).map(([k, v]) => ({ k, n: v.length, eg: v[0] })).sort((a, b) => b.n - a.n).slice(0, 12);
  return JSON.stringify({ surfaces: surfaces.length, crowding: crowd.length, touching: touch.length, atEdge: edge.length, crowdBy: group(crowd, (x) => `${x.surface} ${x.side}`), touchBy: group(touch, (x) => `${x.a} | ${x.b}`), edgeBy: group(edge, (x) => x.surface) }, null, 1);
})()
