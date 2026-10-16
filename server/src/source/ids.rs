//! ids for foreign agents' threads, messages and parts, and agent keys
//! (`docs/agents.md`, section 3). pure functions: what is persisted lives
//! in `store/ids.rs`, and the cache in front of it in `thread_ids.rs`.
//!
//! read marks, needs, clears, adopted rows and push links are keyed by
//! these, so every function here is fixed forever: a change would orphan
//! them all. the vectors in the tests pin the output byte for byte.

use data_encoding::{BASE32_NOPAD, BASE64URL_NOPAD};
use sha2::{Digest, Sha256};

use crate::wire::Source;

/// what the thread hash starts with; a new scheme takes a new tag.
const THREAD_TAG: &[u8] = b"boxbox-thread-v1";
/// 15 bytes is 120 bits, exactly 24 base32 characters with no padding.
const THREAD_HASH_BYTES: usize = 15;
/// a longer foreign entry id would make a message id pass 128 characters:
/// `m` plus 128 characters of base64 for 96 bytes is 129.
pub const MAX_FOREIGN_ENTRY: usize = 95;
/// agent keys: `[a-z0-9-]{1,32}` (`push/notice.rs`).
pub const MAX_AGENT_KEY: usize = 32;
/// where a too long or empty-slug key is cut before its hash suffix:
/// 27 + `-` + 4 is 32.
const KEY_CUT: usize = 27;
const KEY_HASH_CHARS: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    /// a source bug: the message is dropped with a fault on its thread.
    #[error("a foreign entry id of {len} bytes is over {MAX_FOREIGN_ENTRY}")]
    TooLong { len: usize },
}

/// a foreign thread's id: `oc_` or `hm_` and 24 characters of lowercase
/// base32 of the first 15 bytes of `sha256("boxbox-thread-v1" 0 source 0
/// connection 0 foreign agent 0 session key)`. none for cmx2, whose ids
/// stay as the daemon wrote them.
///
/// a hash keeps session keys (which carry phone numbers) out of urls, push
/// payloads and logs, and being deterministic it re-derives the same id
/// after a lost database, so old push links still open their threads.
#[must_use]
pub fn thread_id(
    source: Source,
    connection: &str,
    foreign_agent: &str,
    session_key: &str,
) -> Option<String> {
    let prefix = match source {
        Source::Cmx2 => return None,
        Source::Openclaw => "oc_",
        Source::Hermes => "hm_",
    };
    let mut hasher = Sha256::new();
    hasher.update(THREAD_TAG);
    for part in [source.as_str(), connection, foreign_agent, session_key] {
        hasher.update([0u8]);
        hasher.update(part.as_bytes());
    }
    let digest = hasher.finalize();
    let encoded = BASE32_NOPAD
        .encode(&digest[..THREAD_HASH_BYTES])
        .to_ascii_lowercase();
    Some(format!("{prefix}{encoded}"))
}

/// a foreign message's id: `m` and the unpadded base64url of its entry id,
/// so it reverses without a table.
///
/// # Errors
/// the entry id is over 95 bytes, which would make the id pass 128.
pub fn message_id(foreign_entry: &str) -> Result<String, IdError> {
    if foreign_entry.len() > MAX_FOREIGN_ENTRY {
        return Err(IdError::TooLong {
            len: foreign_entry.len(),
        });
    }
    Ok(format!(
        "m{}",
        BASE64URL_NOPAD.encode(foreign_entry.as_bytes())
    ))
}

/// the foreign entry id a `message_id` was made from; none for anything
/// that is not one (no `m`, not canonical base64url, not utf-8).
#[must_use]
pub fn foreign_entry(message_id: &str) -> Option<String> {
    let encoded = message_id.strip_prefix('m')?;
    let bytes = BASE64URL_NOPAD.decode(encoded.as_bytes()).ok()?;
    if bytes.len() > MAX_FOREIGN_ENTRY {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// a foreign part's id: `<message id>_<index>`.
#[must_use]
pub fn part_id(message_id: &str, index: usize) -> String {
    format!("{message_id}_{index}")
}

/// the message id and index of a `part_id`. base64url uses `_` itself, so
/// the split is at the last one, and the tail must be all digits.
#[must_use]
pub fn part_of(part_id: &str) -> Option<(&str, usize)> {
    let (message, index) = part_id.rsplit_once('_')?;
    if message.is_empty() || index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((message, index.parse().ok()?))
}

/// one path segment and one push link part: `[A-Za-z0-9_-]{1,128}`.
#[must_use]
pub fn is_thread_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `[a-z0-9-]{1,32}`.
#[must_use]
pub fn is_agent_key(s: &str) -> bool {
    (1..=MAX_AGENT_KEY).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// the foreign agent id lowercased, every run of characters outside
/// `[a-z0-9]` made one dash, dashes trimmed from both ends. may be empty.
#[must_use]
pub fn slug(foreign_id: &str) -> String {
    let mut out = String::with_capacity(foreign_id.len());
    let mut dash = false;
    for c in foreign_id.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out
}

/// the key a foreign agent gets when its config pins none:
/// `<connection>-<slug>`. when that is longer than 32 or the slug is empty
/// it is cut to 27 characters (a trailing dash trimmed) and gets `-` and
/// four characters of hash: the first four of the lowercase base32 of the
/// first 3 bytes of `sha256(foreign id)`, so two long ids that share a
/// prefix still part. a connection name is at most 24 characters, so the
/// slug always keeps some room.
#[must_use]
pub fn derive_agent_key(connection: &str, foreign_id: &str) -> String {
    let slug = slug(foreign_id);
    let whole = format!("{connection}-{slug}");
    if !slug.is_empty() && whole.len() <= MAX_AGENT_KEY {
        return whole;
    }
    let cut: String = whole.chars().take(KEY_CUT).collect();
    let cut = cut.trim_end_matches('-');
    let digest = Sha256::digest(foreign_id.as_bytes());
    let mut hash = BASE32_NOPAD.encode(&digest[..3]).to_ascii_lowercase();
    hash.truncate(KEY_HASH_CHARS);
    format!("{cut}-{hash}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // the vectors below were computed outside this code: the sha256 with
    // `printf 'boxbox-thread-v1\x00openclaw\x00...' | shasum -a 256`, and
    // its first 15 bytes through python's `base64.b32encode`, lowercased.

    #[test]
    fn thread_ids_match_the_fixed_vectors() {
        let cases = [
            (
                Source::Openclaw,
                "vm-a",
                "main",
                "agent:main:main",
                "oc_s35pnqjj4ok2iaghaqt3sgmj",
            ),
            (
                Source::Openclaw,
                "vm-a",
                "main",
                "agent:main:whatsapp:direct:+15550000000",
                "oc_6swz7wpxv7ozmqpg2bqli6aa",
            ),
            (
                Source::Hermes,
                "vm-b",
                "default",
                "20260101_120000_abcdef",
                "hm_7k2ahux42amcsdntgougyzib",
            ),
        ];
        for (source, connection, agent, key, want) in cases {
            let id = thread_id(source, connection, agent, key).unwrap();
            assert_eq!(id, want);
            assert_eq!(id.len(), 27);
            assert!(is_thread_id(&id));
        }
    }

    #[test]
    fn cmx2_threads_keep_their_own_ids() {
        assert_eq!(thread_id(Source::Cmx2, "vm-a", "", "ses_1"), None);
    }

    #[test]
    fn each_part_of_the_hash_input_moves_the_id() {
        let base = thread_id(Source::Openclaw, "vm-a", "main", "k");
        assert_ne!(base, thread_id(Source::Openclaw, "vm-b", "main", "k"));
        assert_ne!(base, thread_id(Source::Openclaw, "vm-a", "other", "k"));
        assert_ne!(base, thread_id(Source::Openclaw, "vm-a", "main", "k2"));
        // the separators keep the parts apart
        assert_ne!(
            thread_id(Source::Openclaw, "vm-a", "ma", "ink"),
            thread_id(Source::Openclaw, "vm-a", "main", "k")
        );
    }

    #[test]
    fn message_ids_match_the_fixed_vectors_and_reverse() {
        // python: "m" + base64.urlsafe_b64encode(b).rstrip("=")
        assert_eq!(message_id("entry-1").unwrap(), "mZW50cnktMQ");
        assert_eq!(message_id("ab?>").unwrap(), "mYWI_Pg");
        assert_eq!(message_id("??>").unwrap(), "mPz8-");
        assert_eq!(message_id("").unwrap(), "m");
        for entry in ["entry-1", "ab?>", "??>", "", "ünïcødé 🚀"] {
            let id = message_id(entry).unwrap();
            assert!(is_thread_id(&id), "{id}");
            assert_eq!(foreign_entry(&id).as_deref(), Some(entry));
        }
    }

    #[test]
    fn a_foreign_entry_over_95_bytes_is_refused() {
        let at = "a".repeat(95);
        let id = message_id(&at).unwrap();
        assert_eq!(id.len(), 128);
        assert!(is_thread_id(&id));
        assert_eq!(foreign_entry(&id), Some(at));
        assert_eq!(
            message_id(&"a".repeat(96)),
            Err(IdError::TooLong { len: 96 })
        );
    }

    #[test]
    fn anything_not_a_message_id_has_no_foreign_entry() {
        assert_eq!(foreign_entry(""), None);
        assert_eq!(foreign_entry("ZW50cnktMQ"), None, "no m");
        assert_eq!(foreign_entry("mZW50cnktMQ=="), None, "padded");
        assert_eq!(foreign_entry("mZW50cnktMR"), None, "trailing bits set");
        assert_eq!(foreign_entry("m+/+/"), None, "standard alphabet");
        assert_eq!(foreign_entry("m__8"), None, "not utf-8");
        assert_eq!(foreign_entry("ses_abc"), None);
    }

    #[test]
    fn part_ids_split_at_the_last_underscore() {
        let message = message_id("ab?>").unwrap();
        assert!(message.contains('_'), "the case this guards: {message}");
        let part = part_id(&message, 12);
        assert_eq!(part, "mYWI_Pg_12");
        assert!(is_thread_id(&part));
        assert_eq!(part_of(&part), Some((message.as_str(), 12)));
        assert_eq!(part_of("mZW50cnktMQ_0"), Some(("mZW50cnktMQ", 0)));
        assert_eq!(part_of("mYWI_Pg"), None, "tail not digits");
        assert_eq!(part_of("mYWI_Pg_"), None, "empty tail");
        assert_eq!(part_of("_3"), None, "empty message");
        assert_eq!(part_of("m_+3"), None, "sign is not a digit");
        assert_eq!(part_of("nounderscore"), None);
        assert_eq!(part_of("m_99999999999999999999999"), None, "overflow");
    }

    #[test]
    fn the_id_shapes() {
        assert!(is_thread_id("ses_ABC-123"));
        assert!(is_thread_id(&"a".repeat(128)));
        assert!(!is_thread_id(&"a".repeat(129)));
        assert!(!is_thread_id(""));
        assert!(!is_thread_id("a.b"));
        assert!(!is_thread_id("a/b"));
        assert!(is_agent_key("vm-a-main"));
        assert!(is_agent_key(&"a".repeat(32)));
        assert!(!is_agent_key(&"a".repeat(33)));
        assert!(!is_agent_key(""));
        assert!(!is_agent_key("Vm-a"));
        assert!(!is_agent_key("vm_a"));
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("main"), "main");
        assert_eq!(slug("My Agent!!2"), "my-agent-2");
        assert_eq!(slug("--a__b--"), "a-b");
        assert_eq!(slug("___"), "");
        assert_eq!(slug("Ünï"), "n");
    }

    #[test]
    fn agent_keys_match_the_fixed_vectors() {
        // the hash suffix, outside this code: `printf '%s' "$id" |
        // shasum -a 256 | cut -c1-6`, then python's b32encode, lowercased,
        // first 4 characters
        let cases = [
            ("vm-a", "main", "vm-a-main"),
            ("vm-a", "My Agent", "vm-a-my-agent"),
            // empty slug
            ("vm-a", "___", "vm-a-xwrf"),
            // long: cut to 27
            (
                "vm-a",
                "A Very Long Agent Name With Many Words In It",
                "vm-a-a-very-long-agent-name-ea6i",
            ),
            // long: the 27th character is a dash, trimmed
            (
                "vm-a",
                "aaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbb",
                "vm-a-aaaaaaaaaaaaaaaaaaaaa-czrf",
            ),
        ];
        for (connection, foreign, want) in cases {
            let key = derive_agent_key(connection, foreign);
            assert_eq!(key, want);
            assert!(is_agent_key(&key), "{key}");
        }
    }

    #[test]
    fn a_key_of_exactly_32_is_kept_whole_and_every_long_name_fits() {
        let foreign = "b".repeat(27);
        assert_eq!(derive_agent_key("vm-a", &foreign).len(), 32);
        assert_eq!(
            derive_agent_key("vm-a", &foreign),
            format!("vm-a-{foreign}")
        );
        let connection = "c".repeat(24);
        for foreign in ["", "___", "x", &"y".repeat(200)] {
            let key = derive_agent_key(&connection, foreign);
            assert!(is_agent_key(&key), "{key}");
        }
    }
}
