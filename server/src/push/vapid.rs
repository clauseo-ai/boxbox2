//! the server's vapid identity (rfc 8292): one p-256 key, minted on first
//! start into `boxbox.db` and kept for good, since every subscription is
//! bound to its public half. losing it means every device subscribes again.

use base64ct::{Base64UrlUnpadded, Encoding};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use rusqlite::OptionalExtension;

use crate::store::{Store, StoreError};

/// a push service refuses a token that lives longer than a day; 12 hours
/// keeps well inside it and matches the ttl every push carries.
pub const TOKEN_LIFETIME_S: i64 = 12 * 60 * 60;

pub struct Vapid {
    key: SigningKey,
    /// the uncompressed public point, base64url: the browser's
    /// `applicationServerKey` and the `k=` of every authorization.
    public: String,
    contact: String,
}

impl std::fmt::Debug for Vapid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vapid")
            .field("public", &self.public)
            .field("contact", &self.contact)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum VapidError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("the vapid key in boxbox.db is not a p-256 private key")]
    Corrupt,
}

impl Vapid {
    /// reads the key from the store, minting and saving it the first time.
    ///
    /// # Errors
    /// the store failed, or holds bytes that are not a key.
    pub async fn load_or_mint(store: &Store, contact: String) -> Result<(Self, bool), VapidError> {
        let candidate = mint();
        let fresh = candidate.to_bytes().to_vec();
        let (bytes, minted) = store
            .call(move |c| {
                let saved: Option<Vec<u8>> = c
                    .query_row("SELECT private_key FROM push_vapid WHERE id = 1", [], |r| {
                        r.get(0)
                    })
                    .optional()?;
                if let Some(saved) = saved {
                    return Ok((saved, false));
                }
                c.execute(
                    "INSERT INTO push_vapid (id, private_key, created_at) VALUES (1, ?1, ?2)",
                    rusqlite::params![fresh, crate::now_ms()],
                )?;
                Ok((fresh, true))
            })
            .await?;
        let key = SigningKey::from_slice(&bytes).map_err(|_| VapidError::Corrupt)?;
        Ok((Self::new(key, contact), minted))
    }

    fn new(key: SigningKey, contact: String) -> Self {
        let point = key.verifying_key().to_encoded_point(false);
        Self {
            public: Base64UrlUnpadded::encode_string(point.as_bytes()),
            key,
            contact,
        }
    }

    #[must_use]
    pub fn public_key(&self) -> &str {
        &self.public
    }

    /// the `Authorization` header for a push to `endpoint`'s origin.
    #[must_use]
    pub fn authorization(&self, audience: &str, now_s: i64) -> String {
        let header = Base64UrlUnpadded::encode_string(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({
            "aud": audience,
            "exp": now_s + TOKEN_LIFETIME_S,
            "sub": self.contact,
        });
        let claims = Base64UrlUnpadded::encode_string(claims.to_string().as_bytes());
        let input = format!("{header}.{claims}");
        let signature: Signature = self.key.sign(input.as_bytes());
        let signature = Base64UrlUnpadded::encode_string(&signature.to_bytes());
        format!("vapid t={input}.{signature}, k={}", self.public)
    }
}

/// a fresh key from the os's randomness. almost every 32-byte string is a
/// valid scalar; the loop covers the 2^-128 that are not.
fn mint() -> SigningKey {
    loop {
        let bytes: [u8; 32] = rand::random();
        if let Ok(key) = SigningKey::from_slice(&bytes) {
            return key;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::VerifyingKey;
    use p256::ecdsa::signature::Verifier;

    #[test]
    fn the_authorization_is_an_es256_jwt_the_public_key_verifies() {
        let vapid = Vapid::new(mint(), "mailto:someone@example.com".into());
        let header = vapid.authorization("https://fcm.googleapis.com", 1_000);
        let (token, key) = header
            .strip_prefix("vapid t=")
            .and_then(|rest| rest.split_once(", k="))
            .unwrap();
        assert_eq!(key, vapid.public_key());
        let (input, signature) = token.rsplit_once('.').unwrap();
        let (_, claims) = input.split_once('.').unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&Base64UrlUnpadded::decode_vec(claims).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["exp"], 1_000 + TOKEN_LIFETIME_S);
        assert_eq!(claims["sub"], "mailto:someone@example.com");

        let point = Base64UrlUnpadded::decode_vec(key).unwrap();
        assert_eq!(point.len(), 65, "an uncompressed p-256 point");
        let verifying = VerifyingKey::from_sec1_bytes(&point).unwrap();
        let signature =
            Signature::from_slice(&Base64UrlUnpadded::decode_vec(signature).unwrap()).unwrap();
        verifying.verify(input.as_bytes(), &signature).unwrap();
    }

    #[tokio::test]
    async fn the_key_is_minted_once_and_read_back_after() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let (first, minted) = Vapid::load_or_mint(&store, "mailto:a@b.c".into())
            .await
            .unwrap();
        let (second, again) = Vapid::load_or_mint(&store, "mailto:a@b.c".into())
            .await
            .unwrap();
        assert!(minted && !again);
        assert_eq!(first.public_key(), second.public_key());
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
