//! which files go when a write would pass the cap (`agents.md`, media, the
//! store). pure: the index hands over the files that may go, least recently
//! used first, already past their pin and the 24 hour floor, and this says
//! which of them to drop, or that the write cannot fit.

/// a file eviction may take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub size: u64,
}

/// eviction stops once the store, the new file included, is at or under
/// this share of the cap, so the next few writes do not each evict.
#[must_use]
pub fn target(cap: u64) -> u64 {
    cap / 10 * 9
}

/// the files to drop so `incoming` bytes fit beside the `total` already
/// kept, taken in the order given until the store would sit under 90% of
/// `cap`. `None` when even every candidate gone leaves it over the cap: then
/// nothing is evicted and the write is refused, rather than emptying the
/// store for a file it still could not hold.
#[must_use]
pub fn plan(
    total: u64,
    incoming: u64,
    cap: u64,
    candidates: impl IntoIterator<Item = Candidate>,
) -> Option<Vec<Candidate>> {
    let mut after = total.saturating_add(incoming);
    if after <= cap {
        return Some(Vec::new());
    }
    let goal = target(cap);
    let mut victims = Vec::new();
    for candidate in candidates {
        if after <= goal {
            break;
        }
        after = after.saturating_sub(candidate.size);
        victims.push(candidate);
    }
    (after <= cap).then_some(victims)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(sizes: &[(&str, u64)]) -> Vec<Candidate> {
        sizes
            .iter()
            .map(|(id, size)| Candidate {
                id: (*id).to_owned(),
                size: *size,
            })
            .collect()
    }

    fn ids(victims: &[Candidate]) -> Vec<&str> {
        victims.iter().map(|c| c.id.as_str()).collect()
    }

    #[test]
    fn a_write_under_the_cap_evicts_nothing() {
        assert_eq!(plan(50, 50, 100, files(&[("a", 10)])), Some(Vec::new()));
    }

    #[test]
    fn a_write_past_the_cap_takes_the_least_recently_used_until_the_store_is_under_ninety_percent()
    {
        // 90 kept + 20 new = 110 over a cap of 100: down to 90 or less, oldest first
        let victims = plan(
            90,
            20,
            100,
            files(&[("old", 10), ("older", 15), ("new", 30)]),
        )
        .unwrap();
        assert_eq!(ids(&victims), ["old", "older"]);
    }

    #[test]
    fn when_the_candidates_cannot_make_room_nothing_is_evicted_and_the_write_is_refused() {
        // only 5 bytes may go (the rest are pinned or under a day old), and 20 more do not fit
        assert_eq!(plan(95, 20, 100, files(&[("a", 5)])), None);
        // and a file bigger than the whole cap never fits
        assert_eq!(plan(0, 101, 100, Vec::new()), None);
    }

    #[test]
    fn under_the_cap_but_not_under_ninety_percent_still_writes() {
        // 95 + 10 = 105: the only candidate frees 8, leaving 97, which fits the cap
        let victims = plan(95, 10, 100, files(&[("a", 8)])).unwrap();
        assert_eq!(ids(&victims), ["a"]);
    }
}
