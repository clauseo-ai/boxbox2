//! the `range` header, as the media route answers it (`agents.md`, media,
//! the route): one range is 206, several are the whole file, a range that
//! starts past the end is 416, and anything malformed is ignored (the
//! whole file, as rfc 9110 allows).

/// what to send of a file of `size` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// the whole file, 200.
    Whole,
    /// bytes `start..=end`, 206.
    Part { start: u64, end: u64 },
    /// nothing satisfiable, 416.
    Unsatisfiable,
}

/// reads `header` (the `range` value, if any) against a file of `size`.
#[must_use]
pub fn answer(header: Option<&str>, size: u64) -> Answer {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Answer::Whole;
    };
    if spec.contains(',') {
        return Answer::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Answer::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    match (first.is_empty(), last.is_empty()) {
        // `bytes=-n`: the last n bytes
        (true, false) => {
            let Ok(suffix) = last.parse::<u64>() else {
                return Answer::Whole;
            };
            if suffix == 0 || size == 0 {
                return Answer::Unsatisfiable;
            }
            Answer::Part {
                start: size.saturating_sub(suffix),
                end: size - 1,
            }
        }
        (false, _) => {
            let Ok(start) = first.parse::<u64>() else {
                return Answer::Whole;
            };
            let end = if last.is_empty() {
                None
            } else {
                match last.parse::<u64>() {
                    Ok(end) if end >= start => Some(end),
                    _ => return Answer::Whole,
                }
            };
            if start >= size {
                return Answer::Unsatisfiable;
            }
            Answer::Part {
                start,
                end: end.map_or(size - 1, |end| end.min(size - 1)),
            }
        }
        (true, true) => Answer::Whole,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_range_is_a_part_clamped_to_the_file() {
        assert_eq!(
            answer(Some("bytes=0-99"), 1000),
            Answer::Part { start: 0, end: 99 }
        );
        assert_eq!(
            answer(Some("bytes=900-"), 1000),
            Answer::Part {
                start: 900,
                end: 999
            }
        );
        assert_eq!(
            answer(Some("bytes=900-5000"), 1000),
            Answer::Part {
                start: 900,
                end: 999
            }
        );
        assert_eq!(
            answer(Some("bytes=-100"), 1000),
            Answer::Part {
                start: 900,
                end: 999
            }
        );
        assert_eq!(
            answer(Some("bytes=-5000"), 1000),
            Answer::Part { start: 0, end: 999 }
        );
    }

    #[test]
    fn several_ranges_or_none_are_the_whole_file() {
        assert_eq!(answer(None, 1000), Answer::Whole);
        assert_eq!(answer(Some("bytes=0-1,5-9"), 1000), Answer::Whole);
    }

    #[test]
    fn a_range_past_the_end_is_unsatisfiable() {
        assert_eq!(answer(Some("bytes=1000-"), 1000), Answer::Unsatisfiable);
        assert_eq!(answer(Some("bytes=-0"), 1000), Answer::Unsatisfiable);
    }

    #[test]
    fn a_malformed_range_is_ignored() {
        for bad in ["items=0-1", "bytes=a-b", "bytes=9-1", "bytes=-", "bytes=5"] {
            assert_eq!(answer(Some(bad), 1000), Answer::Whole, "{bad}");
        }
    }
}
