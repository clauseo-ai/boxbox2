/* what bench/window.ts puts in the page, before the app's own scripts: the
   frame recorder for the scroll law, the layout-shift entries, the page's
   errors and a frame pump. it is a string because the root project has no
   dom types (docs/gotchas.md, typescript, the root project); everything it
   hands back is plain json.

   the recorder measures what is painted: each frame it makes a new
   ResizeObserver on a 1 px sentinel, whose first report comes in that
   frame's rendering update after layout and before paint, and after every
   observer made before it, so the stage's own compensation (an observer
   made at mount) has already run. a measurement taken in an animation
   frame callback would see a fill-in a task mounted before the stage's
   observer put the reader's place back, and call that drift.

   the reader's eye is the first visible text line below the bar: a text
   node and offset found with caretRangeFromPoint, measured each frame as
   the box of one character there. per pair of frames with the same anchor:
     dy  how far the line moved on screen
     dP  how far it moved in the scroller's content (dy plus the change of
         scrollTop): a change of layout above it, a fill-in, whether or not
         the stage put the view back
   in a still frame (no input of the drive's in flight) the line may not
   move: |dy| <= 1. while a touch or its momentum runs, nothing above the
   line may change: |dP| <= 1. */

export const PAGE = String.raw`(() => {
  if (window.__win) return;
  const W = {};
  window.__win = W;
  W.errors = [];
  addEventListener('error', (e) => W.errors.push('error: ' + String(e.message).slice(0, 200)));
  addEventListener('unhandledrejection', (e) => W.errors.push('rejection: ' + String(e.reason).slice(0, 200)));
  /* headless chrome advances frames only when something asks for one (docs/gotchas.md): a running loop ticks like a screen */
  const pump = () => requestAnimationFrame(pump);
  requestAnimationFrame(pump);

  const describe = (node) => {
    if (!node || !node.nodeName) return 'nothing';
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return node.nodeName.toLowerCase();
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const turn = el.closest && el.closest('section.turn');
    return el.nodeName.toLowerCase() + cls + (turn ? ' in turn ' + W.turnIndex(turn) : '');
  };

  /* check 5's first half: the browser's layout-shift entries (webkit has none) */
  W.shiftSupported = !!(window.PerformanceObserver && (PerformanceObserver.supportedEntryTypes || []).includes('layout-shift'));
  W.shifts = [];
  /* a shift all of whose sources are inside a home window's live tail ('.win .tail', window.tsx's Line: the streaming thread's own
     window rotating its lines). check 9's hops count and print these apart, unjudged (home's lane); a source with no node is judged */
  W.inWinTail = (e) => {
    const srcs = e.sources || [];
    return srcs.length > 0 && srcs.every((s) => { const n = s.node; const el = n ? (n.nodeType === 1 ? n : n.parentElement) : null; return !!(el && el.closest('.win .tail')); });
  };
  /* where a shift's source is, for check 9's hops: 'tail' in a home window's live tail, 'inspector' in the details panel
     (aside.inspector, or .details where it is drawn), 'chips' in the composer's model and effort chips (.cz-chip), 'stage' in the thread's
     stage, 'page' in home outside them (its rail, its window cards, its bar). a node the page has let go of by the time the entry is read
     (a panel drawn again) is placed by where its box was on screen; one with no box to place it by counts as the stage's */
  const regionOf = (rect) => {
    if (!rect || !(rect.width || rect.height)) return null;
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const inside = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
    const any = (sel) => [...document.querySelectorAll(sel)].some(inside);
    if (any('.win .tail')) return 'tail';
    if (any('.inspector, .details')) return 'inspector';
    if (any('.cz-chip')) return 'chips';
    if (any('.wins')) return 'page';
    const sc = W.sc();
    if (sc && inside(sc.closest('.thread-stage') || sc)) return 'stage';
    return 'page';
  };
  /* by the element's own ancestors, which a subtree the page let go of whole still has (home remakes a window card); null when
     none of them says */
  const elementClass = (el) => {
    if (el.closest('.win .tail')) return 'tail';
    if (el.closest('.inspector, .details')) return 'inspector';
    if (el.closest('.cz-chip')) return 'chips';
    if (el.closest('.thread-stage')) return 'stage';
    if (el.closest('.wins, .win')) return 'page';
    return null;
  };
  const sourceClass = (s) => {
    const n = s.node; const el = n ? (n.nodeType === 1 ? n : n.parentElement) : null;
    if (el) { const c = elementClass(el); if (c) return c; if (el.isConnected) return 'page'; }
    return regionOf(s.currentRect) || regionOf(s.previousRect) || 'stage';
  };
  /* an entry's class, from the sources that moved (chrome lists a node whose box did not change beside one that did: the stage bar's
     title as the thread starts, next to a window's clock that moved 81 px; every source when none moved): 'tail' when every one is in a
     window's tail; else, leaving the tail's out, the first of 'stage', 'inspector', 'chips' any of them is in (a judged line takes an
     entry it shares with home), and 'page' when all are home's. an entry with no source counts as the stage's */
  const movedBox = (s) => { const a = s.previousRect, b = s.currentRect; return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5 || Math.abs(a.width - b.width) > 0.5 || Math.abs(a.height - b.height) > 0.5; };
  W.shiftClass = (e) => {
    const all = e.sources || [];
    if (!all.length) return 'stage';
    const srcs = all.some(movedBox) ? all.filter(movedBox) : all;
    const where = srcs.map(sourceClass);
    if (where.every((x) => x === 'tail')) return 'tail';
    for (const judged of ['stage', 'inspector', 'chips']) if (where.includes(judged)) return judged;
    return 'page';
  };
  if (W.shiftSupported) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { const cls = W.shiftClass(e); W.shifts.push({ t: e.startTime, v: e.value, input: e.hadRecentInput, tail: cls === 'tail', cls, src: (e.sources || []).slice(0, 2).map((s) => describe(s.node)) }); }
    }).observe({ type: 'layout-shift', buffered: true });
  }
  /* what the drive was doing when, so a shift outside a pass can be put down to it */
  W.marks = [];
  W.mark = (name) => { W.marks.push({ t: performance.now(), name }); return true; };
  W.shiftsLabelled = (t0, t1) => W.shifts.filter((s) => !s.input && s.t >= t0 && s.t <= t1).map((s) => {
    let during = 'before any mark';
    for (const m of W.marks) if (m.t <= s.t) during = m.name;
    return { t: Math.round(s.t), v: Math.round(s.v * 100000) / 100000, during, src: s.src };
  });
  W.shiftsBetween = (t0, t1) => {
    const inside = W.shifts.filter((s) => s.t >= t0 && s.t <= t1);
    const counted = inside.filter((s) => !s.input);
    return { supported: W.shiftSupported, entries: inside.length, counted: counted.length, sum: counted.reduce((a, s) => a + s.v, 0), withInput: inside.filter((s) => s.input).reduce((a, s) => a + s.v, 0), worst: counted.sort((a, b) => b.v - a.v).slice(0, 3) };
  };

  /* ---------- the stage ---------- */
  W.sc = () => [...document.querySelectorAll('.stage-scroll')].find((s) => !s.closest('[inert]')) || null;
  W.stage = () => { const s = W.sc(); return s ? s.closest('.thread-stage') : null; };
  /* where the bar's foot is under the scroller's top, laid out: the stage's own reading of it (stage.tsx, goToAsk) */
  W.barBottom = (s) => { const bar = s.parentElement && s.parentElement.querySelector(':scope > .stage-bar'); return bar ? bar.offsetTop + bar.offsetHeight - s.offsetTop : 0; };
  W.turnEls = () => { const s = W.sc(); return s ? [...s.querySelectorAll('section.turn[data-turn]')] : []; };
  W.turnIndex = (el) => W.turnEls().indexOf(el);
  /* a turn holding what it reads, as against the empty box of a turn not mounted */
  const CONTENT = '.row, .you, .answer, .report, .mark, .tape, .ledger';
  W.mounted = (el) => !!el.querySelector(CONTENT);
  W.layoutTop = (el, s) => el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
  W.ready = () => { const s = W.sc(); return !!s && W.turnEls().some(W.mounted); };
  W.facts = () => { const s = W.sc(); if (!s) return null; return { st: s.scrollTop, sh: s.scrollHeight, ch: s.clientHeight, gap: s.scrollHeight - s.clientHeight - s.scrollTop, bar: W.barBottom(s), turns: W.turnEls().length, mounted: W.turnEls().filter(W.mounted).length, nodes: document.getElementsByTagName('*').length }; };
  W.toEnd = () => { const s = W.sc(); s.scrollTop = s.scrollHeight; return s.scrollTop; };
  W.toTop = () => { const s = W.sc(); s.scrollTop = 0; return s.scrollTop; };
  W.scrollTo = (top) => { const s = W.sc(); s.scrollTop = top; return s.scrollTop; };

  /** resolves once the scroller has been still (no node added or removed under it, no change of scrollTop or scrollHeight) for quiet ms */
  W.settle = (quiet, max) => new Promise((done) => {
    const s = W.sc();
    if (!s) { done({ ms: 0, quiet: false }); return; }
    const t0 = performance.now();
    let last = t0, sig = '';
    const mo = new MutationObserver(() => { last = performance.now(); });
    mo.observe(s, { childList: true, subtree: true, characterData: true });
    const look = () => {
      const now = performance.now();
      const k = s.scrollTop + '/' + s.scrollHeight;
      if (k !== sig) { sig = k; last = now; }
      if (now - last >= quiet || now - t0 >= max) { mo.disconnect(); done({ ms: Math.round(now - t0), quiet: now - last >= quiet }); }
      else requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  /** resolves once scrollTop has not changed for quiet ms (a fling's momentum is over) */
  W.scrollIdle = (quiet, max) => new Promise((done) => {
    const s = W.sc(); const t0 = performance.now(); let last = t0, at = s.scrollTop;
    const look = () => { const now = performance.now(); if (s.scrollTop !== at) { at = s.scrollTop; last = now; } if (now - last >= quiet || now - t0 >= max) done(Math.round(now - t0)); else requestAnimationFrame(look); };
    requestAnimationFrame(look);
  });
  /** resolves the frame after a wheel the drive sent has moved the scroller (or 600 ms) */
  W.moved = (from) => new Promise((done) => {
    const s = W.sc(); const t0 = performance.now();
    const look = () => { if (Math.abs(s.scrollTop - from) >= 1 || performance.now() - t0 > 600) requestAnimationFrame(() => done(s.scrollTop)); else requestAnimationFrame(look); };
    requestAnimationFrame(look);
  });

  /* ---------- the reader's eye ---------- */
  const caret = (x, y) => {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r; }
    return null;
  };
  const charBox = (node, off) => {
    const r = document.createRange();
    r.setStart(node, off);
    r.setEnd(node, Math.min(node.data.length, off + 1));
    const b = r.getClientRects()[0];
    return b && b.height > 0 ? b : null;
  };
  let seq = 0;
  W.pick = () => {
    const s = W.sc(); if (!s) return null;
    const r = s.getBoundingClientRect();
    const top = r.top + W.barBottom(s);
    const xs = [0.2, 0.4, 0.6, 0.8].map((f) => r.left + r.width * f);
    for (let y = Math.ceil(top) + 1; y < r.bottom - 8; y += 4) {
      for (const x of xs) {
        const range = caret(x, y);
        if (!range) continue;
        const node = range.startContainer;
        if (!node || node.nodeType !== 3 || !s.contains(node) || !node.data.trim()) continue;
        let off = Math.min(range.startOffset, node.data.length - 1);
        while (off > 0 && /\s/.test(node.data[off])) off--;
        const box = charBox(node, off);
        if (!box || box.top < top - 0.5 || box.bottom > r.bottom) continue;
        const turn = node.parentElement && node.parentElement.closest('section.turn');
        return { id: ++seq, node, off, turn, dTurn: turn ? box.top - turn.getBoundingClientRect().top : 0, text: node.data.trim().slice(0, 48) };
      }
    }
    return null;
  };
  /* where the anchor's line is under the scroller's top; a line whose node was replaced is followed by its turn's box */
  W.y = (a) => {
    const s = W.sc(); const top = s.getBoundingClientRect().top;
    if (a.node.isConnected) { const b = charBox(a.node, Math.min(a.off, a.node.data.length - 1)); if (b) return { y: b.top - top, lost: false }; }
    if (a.turn && a.turn.isConnected) return { y: a.turn.getBoundingClientRect().top - top + a.dTurn, lost: true };
    return null;
  };

  /* a finger on the glass, from its first touch to its last lift (chrome's synthetic gesture sends real touch events) */
  W.touching = false;
  for (const type of ['touchstart', 'touchend', 'touchcancel']) addEventListener(type, (e) => { W.touching = e.type === 'touchstart' || e.touches.length > 0; }, { capture: true, passive: true });

  /* ---------- the frame recorder ---------- */
  let sentinel = null;
  const sentinelEl = () => {
    if (sentinel && sentinel.isConnected) return sentinel;
    sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    sentinel.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;contain:strict';
    document.body.appendChild(sentinel);
    return sentinel;
  };
  const r1 = (n) => Math.round(n * 10) / 10;
  W.rec = null;
  W.start = (label) => {
    W.rec = { label, mode: 'still', inputPairs: 0, step: 0, frames: 0, pairs: 0, still: 0, touch: 0, fills: 0, fillPx: 0, stillFills: 0, worst: 0, worstTouch: 0, lost: 0, drift: 0, touchFill: 0, viol: [], touchViol: [], blankFrames: 0, blankWorst: 0, blankViol: [], gaps: 0, worstGap: 0, lastT: 0, anchor: null, last: null, t0: performance.now() };
    const r = W.rec;
    const tick = () => requestAnimationFrame(() => {
      if (W.rec !== r) return;
      const ro = new ResizeObserver(() => { ro.disconnect(); if (W.rec !== r) return; frame(r); tick(); });
      ro.observe(sentinelEl());
    });
    tick();
    return true;
  };
  W.stop = () => { const r = W.rec; W.rec = null; if (!r) return null; r.t1 = performance.now(); delete r.anchor; delete r.last; return r; };
  W.mode = (m) => { if (W.rec) W.rec.mode = m; return true; };
  /** how much of the view, in px, empty turn boxes cover: a turn not mounted that the reader can see */
  W.blankInView = () => {
    const s = W.sc(); if (!s) return { px: 0, turns: [] };
    const sr = s.getBoundingClientRect();
    const top = sr.top + W.barBottom(s), bottom = sr.bottom;
    let px = 0; const turns = [];
    const els = W.turnEls();
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.bottom <= top || r.top >= bottom || W.mounted(els[i])) continue;
      px += Math.min(bottom, r.bottom) - Math.max(top, r.top);
      turns.push(i);
    }
    return { px: Math.round(px), turns };
  };
  const frame = (r) => {
    const s = W.sc(); if (!s) return;
    r.frames++;
    const now = performance.now();
    if (r.lastT) { const gap = now - r.lastT; r.worstGap = Math.max(r.worstGap, gap); if (gap > 50) r.gaps++; }
    r.lastT = now;
    const blank = W.blankInView();
    if (blank.px > 0) { r.blankFrames++; r.blankWorst = Math.max(r.blankWorst, blank.px); if (r.blankViol.length < 8) r.blankViol.push({ step: r.step, px: blank.px, turns: blank.turns.slice(0, 4), st: Math.round(s.scrollTop), mode: r.inputPairs > 0 ? 'input' : r.mode }); }
    const st = s.scrollTop;
    const mode = r.inputPairs > 0 ? 'input' : r.mode;
    if (r.inputPairs > 0) r.inputPairs--;
    if (r.anchor && r.last) {
      const m = W.y(r.anchor);
      if (m) {
        r.pairs++;
        if (m.lost) r.lost++;
        const dy = m.y - r.last.y, dP = dy + (st - r.last.st);
        if (Math.abs(dP) >= 0.5) { r.fills++; r.fillPx += Math.abs(dP); }
        if (mode === 'still') {
          r.still++;
          if (Math.abs(dP) >= 0.5) r.stillFills++;
          r.worst = Math.max(r.worst, Math.abs(dy));
          if (Math.abs(dy) > 1) { r.drift++; if (r.viol.length < 12) r.viol.push({ step: r.step, dy: r1(dy), dP: r1(dP), st: Math.round(st), line: r.anchor.text, lost: m.lost }); }
        } else if (mode === 'touch') {
          /* a touch is in progress while the finger is down and while its momentum still moves the view (a frame within 50 ms of the
             last one in which the view moved with nothing above the eye changing); after that the fling is over and the frame is a
             still one */
          if (Math.abs(dy) > 0.5 && Math.abs(dP) < 0.5) r.lastMoveT = now;
          if (W.touching || now - (r.lastMoveT || 0) <= 50) {
            r.touch++;
            r.worstTouch = Math.max(r.worstTouch, Math.abs(dP));
            if (Math.abs(dP) > 1) { r.touchFill++; if (r.touchViol.length < 12) r.touchViol.push({ step: r.step, dP: r1(dP), dy: r1(dy), st: Math.round(st), line: r.anchor.text, finger: W.touching }); }
          } else {
            r.still++;
            if (Math.abs(dP) >= 0.5) r.stillFills++;
            r.worst = Math.max(r.worst, Math.abs(dy));
            if (Math.abs(dy) > 1) { r.drift++; if (r.viol.length < 12) r.viol.push({ step: r.step, dy: r1(dy), dP: r1(dP), st: Math.round(st), line: r.anchor.text, lost: m.lost, after: 'the fling' }); }
          }
        }
        r.last = { y: m.y, st };
      } else { r.anchor = null; r.last = null; }
    }
    const band = W.barBottom(s);
    if (!r.anchor || !r.last || r.last.y < band - 1 || r.last.y > s.clientHeight - 24) {
      r.anchor = W.pick();
      const m = r.anchor && W.y(r.anchor);
      r.last = m ? { y: m.y, st } : null;
    }
  };
  /** one programmatic step up of d px, written in an animation frame; the pair of frames that holds it is the input's */
  W.prog = (d) => new Promise((done) => requestAnimationFrame(() => {
    const s = W.sc(); const before = s.scrollTop;
    if (W.rec) { W.rec.inputPairs = 1; W.rec.step++; }
    s.scrollTop = before - d;
    done({ before, after: s.scrollTop });
  }));
  W.stepNext = () => { if (W.rec) W.rec.step++; return true; };

  /* the step's own anchor: taken at rest before the input, read again once the step has settled */
  let stepAnchor = null;
  W.snap = () => { stepAnchor = W.pick(); if (!stepAnchor) return null; const m = W.y(stepAnchor); const s = W.sc(); return { y: m.y, st: s.scrollTop, line: stepAnchor.text }; };
  W.since = () => { if (!stepAnchor) return null; const m = W.y(stepAnchor); const s = W.sc(); return m ? { y: m.y, st: s.scrollTop, lost: m.lost } : null; };

  /* ---------- the end's pin (check 2) ---------- */
  W.pinWatch = null;
  W.watchPin = () => {
    const w = { frames: 0, landedAt: -1, after: 0, off: 0, worst: 0, offs: [], grew: 0, lastSh: -1, t0: performance.now() };
    W.pinWatch = w;
    const tick = () => requestAnimationFrame(() => {
      if (W.pinWatch !== w) return;
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        if (W.pinWatch !== w) return;
        const s = W.sc();
        if (s && W.ready()) {
          w.frames++;
          const gap = s.scrollHeight - s.clientHeight - s.scrollTop;
          if (w.lastSh >= 0 && s.scrollHeight !== w.lastSh) w.grew++;
          w.lastSh = s.scrollHeight;
          if (w.landedAt < 0 && gap <= 1) w.landedAt = Math.round(performance.now() - w.t0);
          else if (w.landedAt >= 0) {
            w.after++;
            w.worst = Math.max(w.worst, gap);
            if (gap > 1) { w.off++; if (w.offs.length < 10) w.offs.push({ t: Math.round(performance.now() - w.t0), gap: r1(gap), sh: s.scrollHeight }); }
          }
        }
        tick();
      });
      ro.observe(sentinelEl());
    });
    tick();
    return true;
  };
  W.stopPin = () => { const w = W.pinWatch; W.pinWatch = null; return w; };

  /* ---------- a turn settling (check 9): the view holds painted rows in every frame ---------- */
  /* what the reader sees, read where it is painted: blank is a frame with no stage on screen, the thread gone from the store, the
     stage's "reading" or "nothing here" line, no turn with rows in the view, or an empty turn box in it */
  const viewNow = (key) => {
    const s = W.sc();
    const stored = (window.boxbox && window.boxbox.threads ? window.boxbox.threads() : []).find((t) => t.key === key) || null;
    const why = [];
    if (!s) why.push('no stage on screen');
    if (!stored) why.push('the thread is not in the store');
    else if (!stored.messages) why.push('the store holds the thread with no messages');
    const empty = s && s.parentElement ? s.parentElement.querySelector('.stage-empty') : null;
    if (empty) why.push('the stage says "' + empty.textContent.trim() + '"');
    let mountedInView = 0, turnsInView = 0;
    const blank = s ? W.blankInView() : { px: 0, turns: [] };
    if (s) {
      const sr = s.getBoundingClientRect(); const top = sr.top + W.barBottom(s);
      for (const el of W.turnEls()) { const r = el.getBoundingClientRect(); if (r.bottom <= top || r.top >= sr.bottom) continue; turnsInView++; if (W.mounted(el)) mountedInView++; }
      if (!mountedInView) why.push(turnsInView ? 'no turn in view holds rows' : 'no turn in view at all');
      if (blank.px > 0) why.push('empty turn boxes cover ' + blank.px + ' px of the view');
    }
    return { why, stored, mountedInView, turnsInView, blank };
  };
  /** what the dom shows at a blank frame, for the report */
  W.viewSnapshot = (key) => {
    const s = W.sc();
    const v = viewNow(key);
    const stages = [...document.querySelectorAll('.thread-stage')].map((st) => ({ thread: st.getAttribute('data-thread'), inert: !!st.closest('[inert]'), turns: st.querySelectorAll('section.turn').length }));
    const els = W.turnEls();
    return {
      why: v.why, url: location.href, stages, layers: document.querySelectorAll('[inert]').length,
      store: v.stored, threads: (window.boxbox && window.boxbox.threads ? window.boxbox.threads() : []).map((t) => t.key + ':' + t.status + ':' + t.messages).slice(0, 8),
      scroller: s ? { st: Math.round(s.scrollTop), sh: s.scrollHeight, ch: s.clientHeight, children: s.firstElementChild ? s.firstElementChild.children.length : 0 } : null,
      turns: els.length, mounted: els.filter(W.mounted).length, turnsInView: v.turnsInView, mountedInView: v.mountedInView, blank: v.blank,
      text: s ? s.innerText.replace(/\s+/g, ' ').slice(0, 160) : document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
      errors: W.errors.slice(-4),
    };
  };
  W.viewWatch = null;
  /** the stage's last four turns as painted: id, height, rows held, and the classes of the last turn's rows */
  W.tailNow = () => {
    const els = W.turnEls().slice(-4);
    const last = els[els.length - 1];
    return { turns: els.map((el) => el.getAttribute('data-turn').slice(-6) + ':' + Math.round(el.getBoundingClientRect().height) + (W.mounted(el) ? '' : ' empty')), lastRows: last ? [...last.querySelectorAll('.row, .you, .answer, .report, .mark, .tape, .ledger')].map((r) => r.className.split(' ').slice(0, 2).join('.') + ':' + Math.round(r.getBoundingClientRect().height)).slice(-8) : [] };
  };
  /** what a frame's content height is made of, for a dip's report: the scroller's end padding and its --hold, the thread's height,
      every turn's height, and a row in view with where it sits on screen (whether the view moved) */
  W.frameFacts = () => {
    const s = W.sc();
    if (!s) return null;
    const sr = s.getBoundingClientRect();
    const thread = s.firstElementChild;
    /* the first row the view shows any of: a row taller than the view (a long answer) counts, as the reader sees it */
    let eye = null;
    const viewTop = sr.top + W.barBottom(s);
    for (const r of s.querySelectorAll('.row, .you, .answer, .ledger, .report, .mark')) { const q = r.getBoundingClientRect(); if (q.height > 0 && q.bottom > viewTop && q.top < sr.bottom) { eye = { row: r, y: Math.round(q.top - sr.top) }; break; } }
    return { st: Math.round(s.scrollTop), pad: getComputedStyle(s).paddingBottom, hold: s.style.getPropertyValue('--hold') || '0', threadH: thread ? Math.round(thread.getBoundingClientRect().height) : null, heights: W.turnEls().map((el) => [el.getAttribute('data-turn').slice(-6), Math.round(el.getBoundingClientRect().height), W.mounted(el) ? 1 : 0]), eye };
  };
  /** a dip's report from the frame before and this one: what changed height, the padding, and whether the row in view moved */
  W.dipFacts = (before, now) => {
    if (!before || !now) return null;
    const was = new Map(before.heights.map((x) => [x[0], x]));
    const changed = now.heights.filter((x) => { const b = was.get(x[0]); return !b || b[1] !== x[1] || b[2] !== x[2]; }).map((x) => { const b = was.get(x[0]); return x[0] + ': ' + (b ? b[1] + (b[2] ? '' : ' empty') : 'new') + ' -> ' + x[1] + (x[2] ? '' : ' empty'); });
    const gone = before.heights.filter((x) => !now.heights.some((y) => y[0] === x[0])).map((x) => x[0] + ': ' + x[1] + ' gone');
    /* the row the view showed in the frame before, where it is now: what the reader was looking at moved or held */
    let eyeDy = null;
    const s = W.sc();
    if (before.eye && before.eye.row.isConnected && s) eyeDy = Math.round(before.eye.row.getBoundingClientRect().top - s.getBoundingClientRect().top) - before.eye.y;
    return { st: before.st + ' -> ' + now.st, pad: before.pad + ' -> ' + now.pad, hold: before.hold + ' -> ' + now.hold, thread: before.threadH + ' -> ' + now.threadH, turnsChanged: changed.length + gone.length, changed: changed.concat(gone).slice(0, 8), eye: eyeDy !== null ? 'the row in view moved ' + eyeDy + ' px on screen' : before.eye ? 'the row in view is gone' : 'the view showed no row', held: eyeDy !== null && Math.abs(eyeDy) <= 1 };
  };
  W.watchView = (key) => {
    const w = { key, frames: 0, blankFrames: 0, run: 0, longest: 0, first: null, firstAt: -1, blankNow: false, phase: 'before', phases: {}, t0: performance.now(), drops: 0, dips: 0, drop: null, dip: null, dipsHeld: 0, dipHeld: null, tail: null, paintTurns: -1, paintSh: 0 };
    W.viewWatch = w;
    /* after paint, what was painted: the thread's stage drawing fewer turns than the frame before, or its content losing more than
       200 px, is another set of turns drawn for a frame (a re-open); the settle's own rows (the working line going) are smaller */
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (W.viewWatch !== w) return;
      const s = W.sc();
      const on = s && (s.closest('.thread-stage') || { getAttribute: () => null }).getAttribute('data-thread') === key;
      const turns = on ? W.turnEls().length : -1;
      const sh = on ? s.scrollHeight : 0;
      if (on && w.paintTurns >= 0 && performance.now() - W.lastInput > 1000) {
        if (turns < w.paintTurns) { w.drops++; if (!w.drop) w.drop = { at: Math.round(performance.now() - w.t0), phase: w.phase, from: w.paintTurns, to: turns, shFrom: w.paintSh, sh, turns: W.turnEls().map((el) => el.getAttribute('data-turn').slice(-6) + ':' + Math.round(el.getBoundingClientRect().height) + (W.mounted(el) ? '' : ' empty')) }; }
        if (sh < w.paintSh - 200) {
          /* content lost: judged when the view moved with it (or no row in view says), printed apart when a box out of the view was
             measured again and the row in view held still, the place kept (the window's own correction of a far turn's estimate) */
          const what = W.dipFacts(w.facts, W.frameFacts());
          const d = { at: Math.round(performance.now() - w.t0), phase: w.phase, shFrom: w.paintSh, sh, before: w.tail, now: W.tailNow(), what };
          if (what && what.held) { w.dipsHeld++; if (!w.dipHeld) w.dipHeld = d; } else { w.dips++; if (!w.dip) w.dip = d; }
        }
      }
      w.paintTurns = turns; w.paintSh = sh; w.tail = on ? W.tailNow() : null; w.facts = on ? W.frameFacts() : null;
      requestAnimationFrame(() => ch.port2.postMessage(0));
    };
    requestAnimationFrame(() => ch.port2.postMessage(0));
    const tick = () => requestAnimationFrame(() => {
      if (W.viewWatch !== w) return;
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        if (W.viewWatch !== w) return;
        w.frames++;
        const v = viewNow(key);
        w.blankNow = v.why.length > 0;
        if (w.blankNow) {
          w.blankFrames++; w.run++; w.longest = Math.max(w.longest, w.run);
          w.phases[w.phase] = (w.phases[w.phase] || 0) + 1;
          if (!w.first) { w.first = W.viewSnapshot(key); w.firstAt = Math.round(performance.now() - w.t0); w.first.phase = w.phase; }
        } else w.run = 0;
        tick();
      });
      ro.observe(sentinelEl());
    });
    tick();
    return true;
  };
  W.viewPhase = (phase) => { if (W.viewWatch) W.viewWatch.phase = phase; return true; };
  W.stopView = () => { const w = W.viewWatch; W.viewWatch = null; if (w) { w.last = W.viewSnapshot(w.key); delete w.tail; delete w.facts; } return w; };

  /* ---------- hops between threads (check 9): shifts and scroll writes per second ---------- */
  /* the reader's own input, wherever it lands: a shift or a scroll within a second of it is theirs */
  W.lastInput = -Infinity;
  for (const type of ['pointerdown', 'wheel', 'keydown', 'touchstart']) addEventListener(type, () => { W.lastInput = performance.now(); }, { capture: true, passive: true });
  W.hopWatch = null;
  W.watchHops = () => {
    const w = { seconds: {}, frames: 0, blankFrames: 0, first: null, firstAt: -1, phase: 'before', t0: performance.now(), lastKey: null, lastSt: null, lastSh: 0, lastTurns: 0, grewAt: -Infinity, lastScroller: null, still: null };
    W.hopWatch = w;
    const bucket = (t) => { const k = Math.floor((t - w.t0) / 1000); return (w.seconds[k] = w.seconds[k] || { writes: 0, writesQuiet: 0, shifts: 0, shiftsQuiet: 0, score: 0, tailShifts: 0, tailScore: 0, inspectorShifts: 0, inspectorScore: 0, chipShifts: 0, chipScore: 0, pageShifts: 0, pageScore: 0, writesGrowing: 0, writesFollow: 0, writesStill: 0, blank: 0, eyeDown: 0, eyeDownPx: 0, drops: 0, dips: 0, dipsHeld: 0, keys: {}, phase: w.phase }); };
    w.drop = null; w.dip = null; w.dipHeld = null; w.tail = null; w.paintKey = null; w.paintTurns = 0; w.paintSh = 0;
    /* a stage shows a section for every turn of its thread (a far one as a box of its height), and a streaming thread only grows: the
       count going down while the same thread stays on stage, or its content losing more than 200 px, is the stage drawing another set of
       turns for a frame (a re-open), away from the reader's input. read after paint (a message posted from the frame), what was painted */
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (W.hopWatch !== w) return;
      const now = performance.now();
      const b = bucket(now);
      const s = W.sc();
      const key = s ? (s.closest('.thread-stage') || { getAttribute: () => null }).getAttribute('data-thread') : null;
      const turns = s ? W.turnEls().length : 0;
      const sh = s ? s.scrollHeight : 0;
      if (key && key === w.paintKey && now - W.lastInput > 1000) {
        if (turns < w.paintTurns) { b.drops++; if (!w.drop) w.drop = { at: Math.round(now - w.t0), phase: w.phase, from: w.paintTurns, to: turns, shFrom: w.paintSh, sh, turns: W.turnEls().map((el) => el.getAttribute('data-turn').slice(-6) + ':' + Math.round(el.getBoundingClientRect().height) + (W.mounted(el) ? '' : ' empty')) }; }
        if (sh < w.paintSh - 200) {
          const what = W.dipFacts(w.facts, W.frameFacts());
          const d = { at: Math.round(now - w.t0), phase: w.phase, shFrom: w.paintSh, sh, before: w.tail, now: W.tailNow(), what };
          if (turns >= w.paintTurns && what && what.held) { b.dipsHeld++; if (!w.dipHeld) w.dipHeld = d; } else { b.dips++; if (!w.dip && turns >= w.paintTurns) w.dip = d; }
        }
      }
      w.paintKey = key; w.paintTurns = turns; w.paintSh = sh; w.tail = s ? W.tailNow() : null; w.facts = s ? W.frameFacts() : null;
      requestAnimationFrame(() => ch.port2.postMessage(0));
    };
    requestAnimationFrame(() => ch.port2.postMessage(0));
    if (W.shiftSupported) {
      w.po = new PerformanceObserver((list) => {
        if (W.hopWatch !== w) return;
        for (const e of list.getEntries()) {
          if (e.startTime < w.t0) continue;
          const b = bucket(e.startTime);
          b.shifts++;
          if (e.hadRecentInput) continue;
          const cls = W.shiftClass(e);
          if (cls === 'tail') { b.tailShifts++; b.tailScore += e.value; }
          else if (cls === 'inspector') { b.inspectorShifts++; b.inspectorScore += e.value; }
          else if (cls === 'chips') { b.chipShifts++; b.chipScore += e.value; }
          else if (cls === 'page') { b.pageShifts++; b.pageScore += e.value; }
          else { b.shiftsQuiet++; b.score += e.value; }
        }
      });
      w.po.observe({ type: 'layout-shift' });
    }
    const tick = () => requestAnimationFrame(() => {
      if (W.hopWatch !== w) return;
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        if (W.hopWatch !== w) return;
        w.frames++;
        const now = performance.now();
        const b = bucket(now);
        const s = W.sc();
        const key = s ? (s.closest('.thread-stage') || {}).getAttribute?.('data-thread') : null;
        if (key) b.keys[key] = (b.keys[key] || 0) + 1;
        /* a write: the same stage's scroller at another place than the frame before. one away from input is the stage's own: one while its turn count is growing (rose in the last 500 ms: a log coming in, a
           new turn) is the place kept under it, and a view at the end moved down by what the content grew, less than a screen, is the
           streaming thread's follow; any other is a write on a still thread */
        const turnsNow = s ? W.turnEls().length : 0;
        if (s && s === w.lastScroller && turnsNow > w.lastTurns) w.grewAt = now;
        if (s && s === w.lastScroller && w.lastSt !== null && Math.abs(s.scrollTop - w.lastSt) >= 0.5) {
          b.writes++;
          if (now - W.lastInput > 1000) {
            b.writesQuiet++;
            const dSt = s.scrollTop - w.lastSt, dSh = s.scrollHeight - w.lastSh;
            if (now - w.grewAt <= 500) b.writesGrowing++;
            else if (dSt > 0 && dSt < s.clientHeight && Math.abs(dSh - dSt) <= 2 && s.scrollHeight - s.scrollTop - s.clientHeight <= 2) b.writesFollow++;
            else { b.writesStill++; if (!w.still) w.still = { at: Math.round(now - w.t0), phase: w.phase, key, st: Math.round(s.scrollTop), dSt: Math.round(dSt), sh: s.scrollHeight, dSh, ch: s.clientHeight, turns: turnsNow }; }
          }
        }
        w.lastSh = s ? s.scrollHeight : 0; w.lastTurns = turnsNow;
        /* the eye's line moving down the screen away from the reader's input: a view that follows the end only ever moves up, and one
           scrolled up does not move at all, so a line going down is the page's own doing (the measure for an engine with no layout-shift
           entries) */
        if (s && s === w.lastScroller && w.eye && w.eyeY !== null) {
          const m = W.y(w.eye);
          if (m && !m.lost) { const dy = m.y - w.eyeY; if (dy > 1 && now - W.lastInput > 1000) { b.eyeDown++; b.eyeDownPx += Math.round(dy); } w.eyeY = m.y; }
          else w.eye = null;
        }
        if (s && (s !== w.lastScroller || !w.eye || w.eyeY === null || w.eyeY < W.barBottom(s) - 1 || w.eyeY > s.clientHeight - 24)) { w.eye = W.pick(); const m = w.eye && W.y(w.eye); w.eyeY = m ? m.y : null; }
        w.lastScroller = s; w.lastSt = s ? s.scrollTop : null;
        if (key) {
          const v = viewNow(key);
          if (v.why.length) { w.blankFrames++; b.blank++; if (!w.first) { w.first = W.viewSnapshot(key); w.firstAt = Math.round(now - w.t0); w.first.phase = w.phase; } }
        }
        tick();
      });
      ro.observe(sentinelEl());
    });
    tick();
    return true;
  };
  W.hopPhase = (phase) => { if (W.hopWatch) W.hopWatch.phase = phase; return true; };
  W.stopHops = () => { const w = W.hopWatch; W.hopWatch = null; if (!w) return null; if (w.po) w.po.disconnect(); delete w.po; delete w.lastScroller; delete w.eye; delete w.tail; delete w.facts; return w; };

  /* ---------- names (check 6), the cheap reading: every control's label as the dom says it ---------- */
  const CONTROLS = 'button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=slider], [role=menuitem], [role=menuitemcheckbox], [role=checkbox], [role=switch], [role=tab], [role=link]';
  W.domDupes = () => {
    const seen = new Map();
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (el.closest('[inert], [aria-hidden="true"]') || !el.getClientRects().length) continue;
      const by = el.getAttribute('aria-labelledby');
      const name = (el.getAttribute('aria-label') || (by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : '') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([name, n]) => name + ' x' + n);
  };

  /* ---------- the dom on open (check 7) ---------- */
  W.census = () => {
    const s = W.sc(); if (!s) return null;
    const sr = s.getBoundingClientRect();
    const turns = W.turnEls().map((el, i) => { const r = el.getBoundingClientRect(); return { i, top: Math.round(r.top - sr.top), bottom: Math.round(r.bottom - sr.top), mounted: W.mounted(el), ask: !!el.querySelector('.row[data-ask] .ask-card') }; });
    return { ch: s.clientHeight, st: s.scrollTop, sh: s.scrollHeight, nodes: document.getElementsByTagName('*').length, turns };
  };

  /* ---------- where a target landed (check 3) ---------- */
  W.place = (selector) => {
    const s = W.sc(); if (!s) return null;
    const el = s.querySelector(selector);
    const url = new URL(location.href);
    const base = { bar: W.barBottom(s), st: s.scrollTop, max: s.scrollHeight - s.clientHeight, ch: s.clientHeight, at: url.searchParams.get('at') };
    if (!el) return { ...base, found: false };
    const r = el.getBoundingClientRect(), sr = s.getBoundingClientRect();
    const turn = el.closest('section.turn');
    const card = el.querySelector('.ask-card');
    return { ...base, found: true, top: r.top - sr.top, bottom: r.bottom - sr.top, open: el.classList.contains('open'), lit: el.classList.contains('lit'), mounted: turn ? W.mounted(turn) : false, focused: !!card && document.activeElement === card };
  };
})();`;
