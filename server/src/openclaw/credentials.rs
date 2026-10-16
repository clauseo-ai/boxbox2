//! the credentials a connection presents (`docs/openclaw.md` 3.1, 3.2,
//! 3.4): the shared token from `token_file`, the device key (from
//! `device_key`, or kept in `source_secrets`), the device token the gateway
//! hands back once paired, and the stable instance id. every value here is
//! a secret: `Debug` shows none of them and nothing logs them.

use std::path::{Path, PathBuf};

use super::identity::{DeviceIdentity, IdentityError};
use crate::source::OpenclawConfig;
use crate::store::{Store, StoreError};

/// `source_secrets` names.
const DEVICE_KEY: &str = "device_key";
const DEVICE_TOKEN: &str = "device_token";
const INSTANCE_ID: &str = "instance_id";

/// a string that never prints.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    /// the config is wrong: refused until it changes.
    #[error("{0}")]
    Config(String),
    /// the store failed: retried.
    #[error("boxbox's database failed: {0}")]
    Store(#[from] StoreError),
}

/// what one connection presents, loaded once per run of its task.
pub struct Credentials {
    connection: String,
    store: Store,
    pub identity: DeviceIdentity,
    pub instance_id: String,
    pub device_token: Option<Secret>,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("connection", &self.connection)
            .field("identity", &self.identity)
            .field("device_token", &self.device_token)
            .finish_non_exhaustive()
    }
}

impl Credentials {
    /// loads the device key, instance id and device token, creating the
    /// key and the id on first start.
    ///
    /// # Errors
    /// `Config` for a `device_key` file that is missing, open to others or
    /// not a key; `Store` when the database fails.
    pub async fn load(config: &OpenclawConfig, store: &Store) -> Result<Self, CredentialError> {
        let name = config.name.as_str();
        let identity = match &config.device_key {
            Some(path) => {
                let path = path.clone();
                tokio::task::spawn_blocking(move || DeviceIdentity::from_pem_file(&path))
                    .await
                    .map_err(|e| {
                        CredentialError::Config(format!("reading the device key failed: {e}"))
                    })?
                    .map_err(|e| CredentialError::Config(e.to_string()))?
            }
            None => {
                if let Some(der) = store.secret(name, DEVICE_KEY).await? {
                    DeviceIdentity::from_pkcs8(&der).map_err(|e: IdentityError| {
                        CredentialError::Config(format!(
                            "the device key boxbox keeps for {name} is unreadable ({e}); forget the connection to pair afresh"
                        ))
                    })?
                } else {
                    let (identity, der) = DeviceIdentity::generate()
                        .map_err(|e| CredentialError::Config(e.to_string()))?;
                    store.put_secret(name, DEVICE_KEY, der).await?;
                    identity
                }
            }
        };
        let instance_id = match store.secret(name, INSTANCE_ID).await? {
            Some(bytes) if !bytes.is_empty() => String::from_utf8_lossy(&bytes).into_owned(),
            _ => {
                let id = new_instance_id();
                store
                    .put_secret(name, INSTANCE_ID, id.clone().into_bytes())
                    .await?;
                id
            }
        };
        let device_token = store
            .secret(name, DEVICE_TOKEN)
            .await?
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|t| !t.is_empty())
            .map(Secret);
        Ok(Self {
            connection: name.to_owned(),
            store: store.clone(),
            identity,
            instance_id,
            device_token,
        })
    }

    /// keeps a device token from `hello-ok.auth.deviceToken`; a new one
    /// replaces the old (3.4).
    ///
    /// # Errors
    /// the database failed; the token is still used for this run.
    pub async fn keep_device_token(&mut self, token: &str) -> Result<(), StoreError> {
        if self
            .device_token
            .as_ref()
            .is_some_and(|t| t.expose() == token)
        {
            return Ok(());
        }
        self.device_token = Some(Secret(token.to_owned()));
        self.store
            .put_secret(&self.connection, DEVICE_TOKEN, token.as_bytes().to_vec())
            .await
    }

    /// drops a device token the gateway no longer accepts, so the next
    /// connect uses the shared token (3.4, `AUTH_DEVICE_TOKEN_MISMATCH`).
    ///
    /// # Errors
    /// the database failed; the token is still dropped for this run.
    pub async fn drop_device_token(&mut self) -> Result<(), StoreError> {
        self.device_token = None;
        self.store
            .forget_secret(&self.connection, DEVICE_TOKEN)
            .await
    }
}

/// reads the shared token: one line, mode 0600 or refused (3.1).
///
/// # Errors
/// the file is missing, open to others, or empty; all config errors.
pub async fn read_token(path: &Path) -> Result<Secret, CredentialError> {
    let path: PathBuf = path.into();
    tokio::task::spawn_blocking(move || read_token_blocking(&path))
        .await
        .map_err(|e| CredentialError::Config(format!("reading the token failed: {e}")))?
}

fn read_token_blocking(path: &Path) -> Result<Secret, CredentialError> {
    let shown = path.display();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .map_err(|e| CredentialError::Config(format!("cannot read {shown}: {e}")))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(CredentialError::Config(format!(
                "{shown} is readable by others; chmod 600 it"
            )));
        }
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| CredentialError::Config(format!("cannot read {shown}: {e}")))?;
    let token = text.lines().next().unwrap_or("").trim();
    if token.is_empty() {
        return Err(CredentialError::Config(format!("{shown} is empty")));
    }
    Ok(Secret(token.to_owned()))
}

/// a random version 4 uuid, as openclaw's clients send `instanceId`.
fn new_instance_id() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = data_encoding::HEXLOWER.encode(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::OpenclawMode;

    fn config(name: &str) -> OpenclawConfig {
        OpenclawConfig {
            name: name.into(),
            url: "ws://127.0.0.1:4750".parse().expect("url"),
            token_file: "/nonexistent".into(),
            device_key: None,
            mode: OpenclawMode::Full,
            machine: None,
            agents: std::collections::BTreeMap::new(),
            origin: crate::config::Origin::Config,
        }
    }

    #[tokio::test]
    async fn the_device_key_and_instance_id_are_made_once_and_kept() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let first = Credentials::load(&config("vm-b"), &store)
            .await
            .expect("first load");
        let again = Credentials::load(&config("vm-b"), &store)
            .await
            .expect("second load");
        assert_eq!(first.identity.id(), again.identity.id());
        assert_eq!(first.instance_id, again.instance_id);
        assert_eq!(first.instance_id.len(), 36);
        let other = Credentials::load(&config("vm-c"), &store)
            .await
            .expect("another connection");
        assert_ne!(
            first.identity.id(),
            other.identity.id(),
            "one key per connection"
        );
        drop((first, again, other, store));
        thread.join().expect("store stops");
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[tokio::test]
    async fn a_device_token_is_kept_replaced_and_dropped() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let mut credentials = Credentials::load(&config("vm-b"), &store)
            .await
            .expect("load");
        assert!(credentials.device_token.is_none());
        credentials.keep_device_token("tok-1").await.expect("keep");
        credentials
            .keep_device_token("tok-2")
            .await
            .expect("replace");
        let reloaded = Credentials::load(&config("vm-b"), &store)
            .await
            .expect("reload");
        assert_eq!(
            reloaded.device_token.as_ref().map(Secret::expose),
            Some("tok-2")
        );
        assert_eq!(format!("{:?}", reloaded.device_token), "Some(Secret(..))");
        drop(reloaded);
        credentials.drop_device_token().await.expect("drop");
        let reloaded = Credentials::load(&config("vm-b"), &store)
            .await
            .expect("reload");
        assert!(reloaded.device_token.is_none());
        drop((credentials, reloaded, store));
        thread.join().expect("store stops");
        std::fs::remove_dir_all(dir).expect("cleanup");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_token_file_must_be_private_and_not_empty() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("boxbox-oc-token-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("token");
        std::fs::write(&path, "  shared-token \nsecond line\n").expect("write");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).expect("chmod");
        let refused = read_token(&path).await.expect_err("open to the group");
        assert!(
            refused
                .to_string()
                .ends_with("is readable by others; chmod 600 it")
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        assert_eq!(
            read_token(&path).await.expect("reads").expose(),
            "shared-token"
        );
        std::fs::write(&path, "\n").expect("write");
        assert!(read_token(&path).await.is_err());
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
