//! the password gate: one password, exchanged for an http-only cookie
//! signed with a secret that lives in the data dir (architecture: auth).
//!
//! a token is `v2.<issued ms>.<hex hmac-sha256(secret, "v2.<issued ms>")>`.
//! it carries no user (there is one) and expires 180 days after issue.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue, header};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::config::{CookieConfig, Secret};

type HmacSha256 = Hmac<Sha256>;

pub const SESSION_MAX_AGE: Duration = Duration::from_secs(180 * 24 * 60 * 60);

/// every wrong password is answered this long after it arrived, however
/// wrong it was, so neither timing nor speed of guessing pays.
pub const FLAT_DELAY: Duration = Duration::from_millis(600);

/// a token stamped further than this in the future is forged or from a
/// clock that cannot be trusted.
const FUTURE_SKEW_MS: i64 = 60_000;

const TOKEN_VERSION: &str = "v2";

#[derive(Debug)]
pub struct Auth {
    secret: [u8; 32],
    /// the password's mac under `secret`; comparing macs in constant time
    /// hides the password's length and content from timing.
    password_mac: [u8; 32],
    cookie: CookieConfig,
}

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("cannot read the cookie secret at {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("cannot create the cookie secret at {path}: {source}")]
    Create {
        path: String,
        source: std::io::Error,
    },
    #[error(
        "the cookie secret at {path} is not 64 hex characters; delete it to mint a new one (every device signs in again)"
    )]
    Malformed { path: String },
}

impl Auth {
    #[must_use]
    pub fn new(secret: [u8; 32], password: &Secret, cookie: CookieConfig) -> Self {
        let password_mac = mac(&secret, password.expose().as_bytes());
        Self {
            secret,
            password_mac,
            cookie,
        }
    }

    /// reads `<data dir>/secret`, minting it (mode 0600) on first start.
    ///
    /// # Errors
    /// the file cannot be read or created, or is not a secret this server wrote.
    pub fn load_secret(data_dir: &Path) -> Result<[u8; 32], SecretError> {
        let path = data_dir.join("secret");
        let shown = path.display().to_string();
        match std::fs::read_to_string(&path) {
            Ok(text) => decode_hex(text.trim()).ok_or(SecretError::Malformed { path: shown }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let secret: [u8; 32] = rand::random();
                write_private(&path, encode_hex(&secret).as_bytes()).map_err(|source| {
                    SecretError::Create {
                        path: shown,
                        source,
                    }
                })?;
                Ok(secret)
            }
            Err(source) => Err(SecretError::Read {
                path: shown,
                source,
            }),
        }
    }

    #[must_use]
    pub fn password_matches(&self, candidate: &str) -> bool {
        mac(&self.secret, candidate.as_bytes())
            .ct_eq(&self.password_mac)
            .into()
    }

    #[must_use]
    pub fn issue(&self, now_ms: i64) -> String {
        let body = format!("{TOKEN_VERSION}.{now_ms}");
        let signature = encode_hex(&mac(&self.secret, body.as_bytes()));
        format!("{body}.{signature}")
    }

    #[must_use]
    pub fn verify(&self, token: &str, now_ms: i64) -> bool {
        let Some((body, signature)) = token.rsplit_once('.') else {
            return false;
        };
        let Some(issued) = body
            .strip_prefix(TOKEN_VERSION)
            .and_then(|r| r.strip_prefix('.'))
        else {
            return false;
        };
        let Ok(issued_ms) = issued.parse::<i64>() else {
            return false;
        };
        let Some(signature) = decode_hex(signature) else {
            return false;
        };
        let max_age_ms = i64::try_from(SESSION_MAX_AGE.as_millis()).unwrap_or(i64::MAX);
        let fresh = issued_ms <= now_ms + FUTURE_SKEW_MS && now_ms - issued_ms <= max_age_ms;
        let genuine: bool = mac(&self.secret, body.as_bytes()).ct_eq(&signature).into();
        fresh && genuine
    }

    /// the session token from the request's `Cookie` headers, if any.
    #[must_use]
    pub fn token_in<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find_map(|(name, value)| (name == self.cookie.name).then_some(value))
    }

    #[must_use]
    pub fn session_cookie(&self, token: &str) -> HeaderValue {
        self.cookie_header(token, SESSION_MAX_AGE.as_secs())
    }

    #[must_use]
    pub fn cleared_cookie(&self) -> HeaderValue {
        self.cookie_header("", 0)
    }

    fn cookie_header(&self, value: &str, max_age: u64) -> HeaderValue {
        let secure = if self.cookie.secure { "; Secure" } else { "" };
        let cookie = format!(
            "{}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}",
            self.cookie.name
        );
        // the name comes from validated config and the value is hex and
        // digits, so the header is always visible ascii
        HeaderValue::from_str(&cookie).unwrap_or_else(|_| HeaderValue::from_static(""))
    }
}

fn mac(key: &[u8; 32], message: &[u8]) -> [u8; 32] {
    // hmac zero-pads a key shorter than the hash's 64-byte block (rfc 2104),
    // so padding it here is the same mac, through the infallible constructor
    let mut block = [0u8; 64];
    block[..32].copy_from_slice(key);
    let mut mac = HmacSha256::new(&block.into());
    mac.update(message);
    mac.finalize().into_bytes().into()
}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

fn decode_hex(text: &str) -> Option<[u8; 32]> {
    let digits = text.as_bytes();
    if digits.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (slot, pair) in out.iter_mut().zip(digits.chunks_exact(2)) {
        let high = char::from(pair[0]).to_digit(16)?;
        let low = char::from(pair[1]).to_digit(16)?;
        *slot = u8::try_from(high << 4 | low).ok()?;
    }
    Some(out)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;

    fn auth(secure: bool) -> Auth {
        let password: Secret = serde_json::from_str("\"correct horse\"").unwrap();
        Auth::new(
            [7; 32],
            &password,
            CookieConfig {
                name: "bb_test".into(),
                secure,
            },
        )
    }

    #[test]
    fn accepts_only_the_configured_password() {
        let auth = auth(true);
        assert!(auth.password_matches("correct horse"));
        assert!(!auth.password_matches("correct hors"));
        assert!(!auth.password_matches(""));
    }

    #[test]
    fn an_issued_token_verifies_until_it_expires() {
        let auth = auth(true);
        let token = auth.issue(NOW);
        assert!(token.starts_with("v2."));
        assert!(auth.verify(&token, NOW));
        let max_age = i64::try_from(SESSION_MAX_AGE.as_millis()).unwrap();
        assert!(auth.verify(&token, NOW + max_age));
        assert!(!auth.verify(&token, NOW + max_age + 1));
        assert!(
            !auth.verify(&token, NOW - FUTURE_SKEW_MS - 1),
            "stamped in the future"
        );
    }

    #[test]
    fn a_tampered_or_foreign_token_fails() {
        let auth = auth(true);
        let token = auth.issue(NOW);
        let forged = token.replacen(&NOW.to_string(), &(NOW + 1).to_string(), 1);
        assert!(!auth.verify(&forged, NOW));
        let password: Secret = serde_json::from_str("\"correct horse\"").unwrap();
        let other = Auth::new([8; 32], &password, auth.cookie.clone());
        assert!(!other.verify(&token, NOW));
        for junk in ["", "v2", "v2.", "v1.1.00", "v2.x.00", "v2.1.zz"] {
            assert!(!auth.verify(junk, NOW), "{junk:?}");
        }
    }

    #[test]
    fn reads_its_own_cookie_among_others() {
        let auth = auth(true);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; bb_test=tok; b=2"),
        );
        assert_eq!(auth.token_in(&headers), Some("tok"));
        let mut other = HeaderMap::new();
        other.insert(header::COOKIE, HeaderValue::from_static("bb_test_x=1"));
        assert_eq!(auth.token_in(&other), None);
    }

    #[test]
    fn the_cookie_is_http_only_and_secure_when_configured() {
        let secure = auth(true).session_cookie("abc");
        assert_eq!(
            secure.to_str().unwrap(),
            "bb_test=abc; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax; Secure"
        );
        let dev = auth(false).cleared_cookie();
        assert_eq!(
            dev.to_str().unwrap(),
            "bb_test=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        );
    }

    #[test]
    fn hex_round_trips() {
        let bytes: [u8; 32] = std::array::from_fn(|i| u8::try_from(i * 7).unwrap());
        assert_eq!(decode_hex(&encode_hex(&bytes)), Some(bytes));
        assert_eq!(decode_hex("00"), None);
    }
}
