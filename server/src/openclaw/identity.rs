//! the device identity boxbox presents to a gateway (`docs/openclaw.md`,
//! 3.2 and 3.3): an ed25519 key pair per connection, the device id derived
//! from it, and the v3 proof signed over the challenge.
//!
//! the private key never leaves this type: `Debug` prints the device id
//! only, and nothing here logs.

use std::path::Path;

use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64ct::{Base64, Base64UrlUnpadded, Encoding};
use sha2::{Digest, Sha256};

/// a device key pair and the names the gateway knows it by.
pub struct DeviceIdentity {
    key: Ed25519KeyPair,
    /// lowercase hex sha256 of the raw 32-byte public key
    /// (`src/infra/device-identity.ts:90-101`).
    id: String,
    /// base64url of the raw public key, unpadded.
    public_key: String,
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceIdentity")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("the device key could not be generated")]
    Generate,
    #[error("the device key is not an ed25519 pkcs#8 key")]
    NotAKey,
    #[error("{path} is readable by others (mode {mode:o}); chmod 600 it")]
    Exposed { path: String, mode: u32 },
    #[error("cannot read {path}: {source}")]
    Read {
        path: String,
        source: std::io::Error,
    },
    #[error("{path} holds no `PRIVATE KEY` pem block")]
    NotPem { path: String },
}

impl DeviceIdentity {
    /// a fresh key pair, with its pkcs#8 v2 der for `source_secrets`.
    ///
    /// # Errors
    /// the system random source failed.
    pub fn generate() -> Result<(Self, Vec<u8>), IdentityError> {
        let rng = aws_lc_rs::rand::SystemRandom::new();
        let der = Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| IdentityError::Generate)?;
        let der = der.as_ref().to_vec();
        Ok((Self::from_pkcs8(&der)?, der))
    }

    /// a key kept as pkcs#8 der (v1 or v2).
    ///
    /// # Errors
    /// the bytes are not an ed25519 pkcs#8 key.
    pub fn from_pkcs8(der: &[u8]) -> Result<Self, IdentityError> {
        let key = Ed25519KeyPair::from_pkcs8(der).map_err(|_| IdentityError::NotAKey)?;
        let raw = key.public_key().as_ref();
        let id = data_encoding::HEXLOWER.encode(&Sha256::digest(raw));
        let public_key = Base64UrlUnpadded::encode_string(raw);
        Ok(Self {
            key,
            id,
            public_key,
        })
    }

    /// the operator-provisioned key file `device_key` names: pkcs#8 pem,
    /// mode 0600 or refused, never written by boxbox (3.2). blocking: call
    /// it from `spawn_blocking`.
    ///
    /// # Errors
    /// the file is unreadable, open to others, or not an ed25519 pem key.
    pub fn from_pem_file(path: &Path) -> Result<Self, IdentityError> {
        let shown = path.display().to_string();
        refuse_exposed(path)?;
        let text = std::fs::read_to_string(path).map_err(|source| IdentityError::Read {
            path: shown.clone(),
            source,
        })?;
        let der = pem_private_key(&text).ok_or(IdentityError::NotPem { path: shown })?;
        Self::from_pkcs8(&der)
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// the signature over `proof`'s v3 payload, base64url unpadded
    /// (`src/infra/ed25519-signature.ts:152-170`).
    #[must_use]
    pub fn sign(&self, proof: &Proof<'_>) -> String {
        let payload = proof.payload(&self.id);
        Base64UrlUnpadded::encode_string(self.key.sign(payload.as_bytes()).as_ref())
    }
}

/// what the v3 device proof binds (`packages/gateway-client/src/device-auth.ts:40-60`).
#[derive(Debug, Clone, Copy)]
pub struct Proof<'a> {
    pub client_id: &'a str,
    pub client_mode: &'a str,
    pub role: &'a str,
    /// in the order they are sent; boxbox sends them sorted.
    pub scopes: &'a [&'a str],
    /// the challenge's `ts`, never boxbox's clock (3.3 step 3).
    pub signed_at: u64,
    /// `auth.token ?? auth.deviceToken ?? ""` of the same connect.
    pub token: &'a str,
    pub nonce: &'a str,
    pub platform: &'a str,
    pub device_family: &'a str,
}

impl Proof<'_> {
    /// `v3|<deviceId>|<clientId>|<mode>|<role>|<scopes>|<signedAt>|<token>|<nonce>|<platform>|<family>`,
    /// with platform and family trimmed and lowercased (`device-auth.ts:1-6`).
    #[must_use]
    pub fn payload(&self, device_id: &str) -> String {
        [
            "v3",
            device_id,
            self.client_id,
            self.client_mode,
            self.role,
            &self.scopes.join(","),
            &self.signed_at.to_string(),
            self.token,
            self.nonce,
            &self.platform.trim().to_lowercase(),
            &self.device_family.trim().to_lowercase(),
        ]
        .join("|")
    }
}

/// the der inside a `-----BEGIN PRIVATE KEY-----` block.
fn pem_private_key(text: &str) -> Option<Vec<u8>> {
    let begin = text.find("-----BEGIN PRIVATE KEY-----")?;
    let body = &text[begin + "-----BEGIN PRIVATE KEY-----".len()..];
    let end = body.find("-----END PRIVATE KEY-----")?;
    let base64: String = body[..end].split_whitespace().collect();
    Base64::decode_vec(&base64).ok()
}

#[cfg(unix)]
fn refuse_exposed(path: &Path) -> Result<(), IdentityError> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(path)
        .map_err(|source| IdentityError::Read {
            path: path.display().to_string(),
            source,
        })?
        .permissions()
        .mode()
        & 0o777;
    if mode.trailing_zeros() >= 6 {
        Ok(())
    } else {
        Err(IdentityError::Exposed {
            path: path.display().to_string(),
            mode,
        })
    }
}

#[cfg(not(unix))]
fn refuse_exposed(_: &Path) -> Result<(), IdentityError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a throwaway key from `openssl genpkey -algorithm ed25519` (pkcs#8 v1).
    const OPENSSL_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
        MC4CAQAwBQYDK2VwBCIEINF4hpL06phtE5UYawG1rkzBYEQOGa8lr8R+z/Sc+VKr\n\
        -----END PRIVATE KEY-----\n";

    const SCOPES: [&str; 5] = [
        "operator.admin",
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.write",
    ];

    fn proof() -> Proof<'static> {
        Proof {
            client_id: "gateway-client",
            client_mode: "backend",
            role: "operator",
            scopes: &SCOPES,
            signed_at: 1_792_054_850_397,
            token: "bench-token",
            nonce: "nonce-1",
            platform: " Darwin ",
            device_family: "",
        }
    }

    fn openssl_key() -> DeviceIdentity {
        let der = pem_private_key(OPENSSL_PEM).expect("the test pem decodes");
        DeviceIdentity::from_pkcs8(&der).expect("an openssl ed25519 key loads")
    }

    /// the expected values come from node's crypto over the same key and
    /// payload (`sign(null, payload, key)`, the bench client's own call), so
    /// boxbox's proof is byte for byte what the gateway's verifier expects.
    #[test]
    fn the_v3_proof_matches_nodes_signature_over_the_same_key() {
        let key = openssl_key();
        assert_eq!(
            key.id(),
            "880b2b2d6b786f2aa8c454901a4e915b40840b6ca1181b17f4de95b4e51efbb0"
        );
        assert_eq!(
            key.public_key(),
            "KV4Bsv6nxACJ0CnQJ_Xo-60An3Gq4RoRYZXSAa4U7Zw"
        );
        assert_eq!(
            proof().payload(key.id()),
            "v3|880b2b2d6b786f2aa8c454901a4e915b40840b6ca1181b17f4de95b4e51efbb0|gateway-client|backend|operator|operator.admin,operator.approvals,operator.questions,operator.read,operator.write|1792054850397|bench-token|nonce-1|darwin|"
        );
        assert_eq!(
            key.sign(&proof()),
            "w-MbLPdb9UtY956F2dA5rZ9JCp6o1O90sBehME_r-dC5mykDpm53OUMzMmG2l79TgS1DxtSCVcvRKAgDEExqDQ"
        );
    }

    #[test]
    fn a_generated_key_round_trips_through_its_der() {
        let (key, der) = DeviceIdentity::generate().expect("a key generates");
        let again = DeviceIdentity::from_pkcs8(&der).expect("its der loads");
        assert_eq!(key.id(), again.id());
        assert_eq!(key.id().len(), 64);
        assert_eq!(key.sign(&proof()), again.sign(&proof()));
    }

    #[test]
    fn debug_shows_the_device_id_and_never_the_key() {
        let key = openssl_key();
        let shown = format!("{key:?}");
        assert!(shown.contains(key.id()));
        assert!(!shown.contains("INF4hpL06"));
        assert!(!shown.contains("key:"));
    }

    #[test]
    fn rubbish_is_not_a_key() {
        assert!(matches!(
            DeviceIdentity::from_pkcs8(b"not a key"),
            Err(IdentityError::NotAKey)
        ));
        assert!(pem_private_key("no pem here").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_open_to_others_is_refused_and_a_private_one_loads() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("boxbox-oc-key-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("device.key");
        std::fs::write(&path, OPENSSL_PEM).expect("write key");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert!(matches!(
            DeviceIdentity::from_pem_file(&path),
            Err(IdentityError::Exposed { mode: 0o644, .. })
        ));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        let key = DeviceIdentity::from_pem_file(&path).expect("a 0600 key loads");
        assert_eq!(key.id(), openssl_key().id());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
