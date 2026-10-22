//! protocol 3's patches (`docs/protocol.md`, sections 6 to 8): a thread as
//! the fields that changed, a tail as drops and puts, the window order as
//! removes and inserts, and a settled text as its length and hash. each
//! diff has its apply beside it, the rule a client follows, so a test can
//! hold every patch to "applying it to the base gives the new value".

use super::stream::{OrderOp, TailPatch, TextOf, ThreadField, ThreadPatch, ThreadSet};
use super::thread::{TailItem, Thread};

/// the most items a tail holds.
pub const TAIL_ITEMS: usize = 12;

/// why a patch cannot apply: a protocol error on the client.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PatchError {
    #[error("the patch is for {patch}, the base is {base}")]
    Key { patch: String, base: String },
    #[error("a tail put at {index} is past the tail's length {length}")]
    TailIndex { index: u32, length: usize },
    #[error("the tail would hold {0} items")]
    TailLength(usize),
    #[error("the tail drops {drop} of {length} items")]
    TailDrop { drop: u32, length: usize },
    #[error("an order op at {at} is out of range for {length} keys")]
    Order { at: u32, length: usize },
}

/// the patch from `prev` to `next`, two states of one key; none when they
/// are equal (a change that changes nothing journals nothing).
#[must_use]
#[allow(
    clippy::float_cmp,
    reason = "any change to a value is sent, exactly as the client must hold it"
)]
pub fn thread(prev: &Thread, next: &Thread) -> Option<ThreadPatch> {
    let mut set = ThreadSet::default();
    let mut unset = Vec::new();
    let mut any = false;
    macro_rules! required {
        ($($field:ident),*) => {$(
            if prev.$field != next.$field {
                set.$field = Some(next.$field.clone());
                any = true;
            }
        )*};
    }
    macro_rules! optional {
        ($($field:ident => $name:ident),*) => {$(
            if prev.$field != next.$field {
                match &next.$field {
                    Some(value) => set.$field = Some(value.clone()),
                    None => unset.push(ThreadField::$name),
                }
                any = true;
            }
        )*};
    }
    required!(
        title, created, updated, activity, queued, agents, processes, needs
    );
    optional!(
        said => Said, generation => Generation, parent => Parent,
        forked_from => ForkedFrom, place => Place, origin => Origin, sends => Sends, model => Model, effort => Effort,
        context => Context, cost => Cost, tokens => Tokens, vcs => Vcs,
        changes => Changes, read => Read, cleared => Cleared
    );
    if prev.browse_only != next.browse_only {
        if next.browse_only {
            set.browse_only = Some(true);
        } else {
            unset.push(ThreadField::BrowseOnly);
        }
        any = true;
    }
    let tail = tail(&prev.tail, &next.tail);
    if !any && tail.is_none() {
        return None;
    }
    Some(ThreadPatch {
        key: next.key.clone(),
        set: (set != ThreadSet::default()).then_some(set),
        unset,
        tail,
    })
}

/// a thread patch applied to its base, as a client applies it: checked
/// whole before anything changes.
///
/// # Errors
/// the patch is for another key, or its tail does not fit the base.
pub fn apply_thread(base: &Thread, patch: &ThreadPatch) -> Result<Thread, PatchError> {
    if patch.key != base.key {
        return Err(PatchError::Key {
            patch: patch.key.clone(),
            base: base.key.clone(),
        });
    }
    let mut next = base.clone();
    if let Some(tail) = &patch.tail {
        next.tail = apply_tail(&base.tail, tail)?;
    }
    if let Some(set) = &patch.set {
        macro_rules! required {
            ($($field:ident),*) => {$(
                if let Some(value) = &set.$field {
                    next.$field = value.clone();
                }
            )*};
        }
        macro_rules! optional {
            ($($field:ident),*) => {$(
                if let Some(value) = &set.$field {
                    next.$field = Some(value.clone());
                }
            )*};
        }
        required!(
            title, created, updated, activity, queued, agents, processes, needs
        );
        optional!(
            said,
            generation,
            parent,
            forked_from,
            place,
            origin,
            sends,
            model,
            effort,
            context,
            cost,
            tokens,
            vcs,
            changes,
            read,
            cleared
        );
        if let Some(browse_only) = set.browse_only {
            next.browse_only = browse_only;
        }
    }
    for field in &patch.unset {
        match field {
            ThreadField::Said => next.said = None,
            ThreadField::Generation => next.generation = None,
            ThreadField::Parent => next.parent = None,
            ThreadField::ForkedFrom => next.forked_from = None,
            ThreadField::Place => next.place = None,
            ThreadField::Origin => next.origin = None,
            ThreadField::Sends => next.sends = None,
            ThreadField::Model => next.model = None,
            ThreadField::Effort => next.effort = None,
            ThreadField::Context => next.context = None,
            ThreadField::Cost => next.cost = None,
            ThreadField::Tokens => next.tokens = None,
            ThreadField::Vcs => next.vcs = None,
            ThreadField::Changes => next.changes = None,
            ThreadField::BrowseOnly => next.browse_only = false,
            ThreadField::Read => next.read = None,
            ThreadField::Cleared => next.cleared = None,
        }
    }
    Ok(next)
}

/// the tail patch from `prev` to `next`: the drop that leaves the fewest
/// puts. none when they are equal.
#[must_use]
pub fn tail(prev: &[TailItem], next: &[TailItem]) -> Option<TailPatch> {
    if prev == next {
        return None;
    }
    // dropping everything and putting every item always works; a smaller
    // drop works when what is left is no longer than the new tail
    let mut best: Option<(usize, Vec<u32>)> = None;
    for drop in 0..=prev.len() {
        let base = &prev[drop..];
        if base.len() > next.len() {
            continue;
        }
        let puts: Vec<u32> = (0..next.len())
            .filter(|&i| base.get(i) != next.get(i))
            .filter_map(|i| u32::try_from(i).ok())
            .collect();
        if best.as_ref().is_none_or(|(_, b)| puts.len() < b.len()) {
            best = Some((drop, puts));
        }
    }
    let (drop, puts) = best?;
    Some(TailPatch {
        drop: u32::try_from(drop).unwrap_or(u32::MAX),
        put: puts
            .into_iter()
            .filter_map(|i| Some((i, next.get(i as usize)?.clone())))
            .collect(),
    })
}

/// a tail patch applied to its base.
///
/// # Errors
/// a drop past the base, a put past the length, or a tail past 12 items.
pub fn apply_tail(base: &[TailItem], patch: &TailPatch) -> Result<Vec<TailItem>, PatchError> {
    let drop = patch.drop as usize;
    if drop > base.len() {
        return Err(PatchError::TailDrop {
            drop: patch.drop,
            length: base.len(),
        });
    }
    let mut next = base[drop..].to_vec();
    for (index, item) in &patch.put {
        let at = *index as usize;
        match at.cmp(&next.len()) {
            std::cmp::Ordering::Less => next[at] = item.clone(),
            std::cmp::Ordering::Equal => next.push(item.clone()),
            std::cmp::Ordering::Greater => {
                return Err(PatchError::TailIndex {
                    index: *index,
                    length: next.len(),
                });
            }
        }
    }
    if next.len() > TAIL_ITEMS {
        return Err(PatchError::TailLength(next.len()));
    }
    Ok(next)
}

/// the edits from `prev` to `next`, two window orders: removes and inserts
/// around their longest common run of keys, so a key moving to the front is
/// one remove and one insert. none when the whole list is no larger than
/// the edits.
#[must_use]
pub fn order(prev: &[String], next: &[String]) -> Option<Vec<OrderOp>> {
    let ops = order_ops(prev, next);
    let size = |json: Result<Vec<u8>, serde_json::Error>| json.map_or(usize::MAX, |v| v.len());
    (size(serde_json::to_vec(&ops)) < size(serde_json::to_vec(next))).then_some(ops)
}

fn order_ops(prev: &[String], next: &[String]) -> Vec<OrderOp> {
    let (n, m) = (prev.len(), next.len());
    // the longest common subsequence, by a table of suffix lengths
    let mut table = vec![0u16; (n + 1) * (m + 1)];
    let at = |i: usize, j: usize| i * (m + 1) + j;
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[at(i, j)] = if prev[i] == next[j] {
                table[at(i + 1, j + 1)] + 1
            } else {
                table[at(i + 1, j)].max(table[at(i, j + 1)])
            };
        }
    }
    // walk it, writing ops against the list as it is being edited: `pos`
    // is the index in the edited list that `prev[i]` and `next[j]` meet at
    let mut ops: Vec<OrderOp> = Vec::new();
    let (mut i, mut j, mut pos) = (0usize, 0usize, 0u32);
    while i < n || j < m {
        if i < n && j < m && prev[i] == next[j] {
            i += 1;
            j += 1;
            pos += 1;
        } else if j < m && (i == n || table[at(i, j + 1)] >= table[at(i + 1, j)]) {
            match ops.last_mut() {
                Some(OrderOp::Insert { at, keys })
                    if u32::try_from(keys.len()).is_ok_and(|n| *at + n == pos) =>
                {
                    keys.push(next[j].clone());
                }
                _ => ops.push(OrderOp::Insert {
                    at: pos,
                    keys: vec![next[j].clone()],
                }),
            }
            j += 1;
            pos += 1;
        } else {
            match ops.last_mut() {
                Some(OrderOp::Remove { at, count }) if *at == pos => *count += 1,
                _ => ops.push(OrderOp::Remove { at: pos, count: 1 }),
            }
            i += 1;
        }
    }
    ops
}

/// order ops applied to the list they were made against.
///
/// # Errors
/// an op out of range.
pub fn apply_order(base: &[String], ops: &[OrderOp]) -> Result<Vec<String>, PatchError> {
    let mut next = base.to_vec();
    for op in ops {
        match op {
            OrderOp::Remove { at, count } => {
                let (from, to) = (*at as usize, *at as usize + *count as usize);
                if to > next.len() {
                    return Err(PatchError::Order {
                        at: *at,
                        length: next.len(),
                    });
                }
                next.drain(from..to);
            }
            OrderOp::Insert { at, keys } => {
                if *at as usize > next.len() {
                    return Err(PatchError::Order {
                        at: *at,
                        length: next.len(),
                    });
                }
                let tail = next.split_off(*at as usize);
                next.extend(keys.iter().cloned());
                next.extend(tail);
            }
        }
    }
    Ok(next)
}

/// a text's utf-16 length and fnv-1a 32 hash over its utf-16 code units,
/// built as deltas arrive (`docs/protocol.md`, section 8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextHash {
    pub length: u64,
    pub hash: u32,
}

impl Default for TextHash {
    fn default() -> Self {
        Self {
            length: 0,
            hash: 2_166_136_261,
        }
    }
}

impl TextHash {
    #[must_use]
    pub fn of(text: &str) -> Self {
        let mut hash = Self::default();
        hash.push(text);
        hash
    }

    pub fn push(&mut self, text: &str) {
        for unit in text.encode_utf16() {
            self.hash = (self.hash ^ u32::from(unit)).wrapping_mul(16_777_619);
            self.length += 1;
        }
    }

    #[must_use]
    pub fn text_of(self) -> TextOf {
        TextOf {
            length: self.length,
            hash: format!("{:08x}", self.hash),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::thread::{Activity, TailKind};

    fn item(id: &str) -> TailItem {
        TailItem {
            part_id: id.into(),
            message_id: "m".into(),
            kind: TailKind::Text,
            role: crate::wire::TailRole::Assistant,
            tool: None,
            state: None,
            text: id.into(),
            from: None,
        }
    }

    fn thread() -> Thread {
        serde_json::from_value(serde_json::json!({
            "key": "vm-a:ses_1", "agent": "vm-a", "id": "ses_1", "title": "t",
            "created": 1.0, "updated": 2.0, "activity": {"state": "idle"}, "queued": 0,
            "agents": 0, "processes": 0, "tail": [], "needs": [], "read": null
        }))
        .unwrap()
    }

    #[test]
    fn a_thread_patch_carries_only_what_changed_and_applies_back() {
        let a = thread();
        assert_eq!(super::thread(&a, &a), None);
        let mut b = a.clone();
        b.activity = Activity::Busy { since: Some(3.0) };
        b.updated = 3.0;
        b.cost = Some(0.5);
        b.tail = vec![item("p1")];
        let patch = super::thread(&a, &b).unwrap();
        assert_eq!(
            serde_json::to_string(&patch).unwrap(),
            r#"{"key":"vm-a:ses_1","set":{"updated":3.0,"activity":{"state":"busy","since":3.0},"cost":0.5},"tail":{"drop":0,"put":[[0,{"partID":"p1","messageID":"m","kind":"text","role":"assistant","text":"p1"}]]}}"#
        );
        assert_eq!(apply_thread(&a, &patch).unwrap(), b);
        // and back: cost goes absent
        let back = super::thread(&b, &a).unwrap();
        assert_eq!(back.unset, vec![ThreadField::Cost]);
        assert_eq!(apply_thread(&b, &back).unwrap(), a);
    }

    #[test]
    fn a_tail_that_scrolls_drops_from_the_front_and_appends() {
        let prev: Vec<_> = (0..12).map(|i| item(&format!("p{i}"))).collect();
        let mut next = prev[1..].to_vec();
        next.push(item("p12"));
        let patch = tail(&prev, &next).unwrap();
        assert_eq!((patch.drop, patch.put.len()), (1, 1));
        assert_eq!(patch.put[0].0, 11);
        assert_eq!(apply_tail(&prev, &patch).unwrap(), next);
        // the last item's text grew: one put, no drop
        let mut grown = prev.clone();
        grown[11].text = "longer".into();
        let patch = tail(&prev, &grown).unwrap();
        assert_eq!((patch.drop, patch.put.len()), (0, 1));
        assert_eq!(apply_tail(&prev, &patch).unwrap(), grown);
        // shorter at the end can only be a whole rewrite
        let shorter = prev[..3].to_vec();
        let patch = tail(&prev, &shorter).unwrap();
        assert_eq!(apply_tail(&prev, &patch).unwrap(), shorter);
    }

    #[test]
    fn a_tail_patch_that_does_not_fit_is_refused() {
        let base = vec![item("a")];
        let past = TailPatch {
            drop: 0,
            put: vec![(2, item("b"))],
        };
        assert!(matches!(
            apply_tail(&base, &past),
            Err(PatchError::TailIndex { .. })
        ));
        let long = TailPatch {
            drop: 0,
            put: (1..13).map(|i| (i, item("x"))).collect(),
        };
        assert_eq!(apply_tail(&base, &long), Err(PatchError::TailLength(13)));
    }

    fn keys(text: &str) -> Vec<String> {
        text.split(' ')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn a_key_moving_to_the_front_is_one_remove_and_one_insert() {
        let prev: Vec<String> = (0..40).map(|i| format!("vm-a:ses_{i}")).collect();
        let mut next = prev.clone();
        let moved = next.remove(17);
        next.insert(0, moved);
        let ops = order(&prev, &next).unwrap();
        assert_eq!(ops.len(), 2, "{ops:?}");
        assert_eq!(apply_order(&prev, &ops).unwrap(), next);
        assert_eq!(
            serde_json::to_string(&ops).unwrap(),
            r#"[["+",0,["vm-a:ses_17"]],["-",18,1]]"#
        );
    }

    #[test]
    fn every_order_diff_applies_back_and_a_rewrite_goes_whole() {
        let cases = [
            ("a b c d e", "d a b c e"),
            ("a b c", "a b c d"),
            ("a b c d", "b d"),
            ("", "a b"),
            ("a b", ""),
            ("a b c d e f", "f e d c b a"),
            ("a b c d e f g h", "a x b y c z d"),
        ];
        for (a, b) in cases {
            let (prev, next) = (keys(a), keys(b));
            let ops = order_ops(&prev, &next);
            assert_eq!(apply_order(&prev, &ops).unwrap(), next, "{a} -> {b}");
        }
        // a whole new list is smaller than its edits
        assert_eq!(order(&keys("a b c"), &keys("x y z")), None);
    }

    #[test]
    fn an_op_out_of_range_is_refused() {
        assert!(apply_order(&keys("a"), &[OrderOp::Remove { at: 0, count: 2 }]).is_err());
        assert!(
            apply_order(
                &keys("a"),
                &[OrderOp::Insert {
                    at: 2,
                    keys: keys("b")
                }]
            )
            .is_err()
        );
    }

    #[test]
    fn the_text_hash_is_fnv_1a_over_utf16_units_and_builds_by_parts() {
        // fnv-1a 32 of the empty input is the offset basis
        assert_eq!(TextHash::default().text_of().hash, "811c9dc5");
        // "a" is 0xe40c292c in fnv-1a 32
        assert_eq!(TextHash::of("a").text_of().hash, "e40c292c");
        let mut built = TextHash::of("hello, ");
        built.push("wörld 😀");
        assert_eq!(built, TextHash::of("hello, wörld 😀"));
        // the emoji is two utf-16 units
        assert_eq!(built.length, 15);
    }
}
