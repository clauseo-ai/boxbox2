//! subscriptions: one per device, in `push_devices`. a device is a browser
//! profile (or an installed pwa), identified by the id the app minted for
//! it; subscribing again replaces its endpoint and keys.

use base64ct::{Base64UrlUnpadded, Encoding};
use p256::PublicKey;
use reqwest::Url;
use rusqlite::params;

use super::notice::KindSet;
use crate::store::{Store, StoreError};

/// the push services boxbox will post to. the endpoint comes from a
/// browser, so it is checked before the server ever calls it: chrome and
/// edge (fcm, wns), safari on every apple device, firefox.
const PUSH_SERVICES: &[&str] = &[
    "fcm.googleapis.com",
    "push.apple.com",
    "push.services.mozilla.com",
    "notify.windows.com",
];

/// a subscribed device as the send path needs it.
#[derive(Debug, Clone)]
pub struct Device {
    /// the id the app minted for this browser profile.
    pub id: String,
    /// one of the telemetry dictionary's device classes.
    pub class: String,
    pub endpoint: Url,
    pub p256dh: PublicKey,
    pub auth: [u8; 16],
    pub kinds: KindSet,
    pub since: i64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Refused {
    #[error("device must be 1 to 64 letters, digits, dashes or underscores")]
    DeviceId,
    #[error("endpoint is not an https url")]
    Endpoint,
    #[error("endpoint is not a known push service ({0})")]
    UnknownService(String),
    #[error("keys.p256dh is not a p-256 public key in base64url")]
    P256dh,
    #[error("keys.auth is not 16 bytes in base64url")]
    Auth,
}

#[must_use]
pub fn is_device_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// checks a subscription as the browser handed it over.
///
/// # Errors
/// which part is not a subscription boxbox can push to.
pub fn parse(
    device: &str,
    device_class: &str,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    kinds: KindSet,
) -> Result<Device, Refused> {
    if !is_device_id(device) {
        return Err(Refused::DeviceId);
    }
    let endpoint = Url::parse(endpoint).map_err(|_| Refused::Endpoint)?;
    if endpoint.scheme() != "https" {
        return Err(Refused::Endpoint);
    }
    let host = endpoint.host_str().ok_or(Refused::Endpoint)?;
    let known = PUSH_SERVICES
        .iter()
        .any(|service| host == *service || host.ends_with(&format!(".{service}")));
    if !known {
        return Err(Refused::UnknownService(host.to_owned()));
    }
    let p256dh = Base64UrlUnpadded::decode_vec(p256dh.trim_end_matches('='))
        .ok()
        .and_then(|bytes| PublicKey::from_sec1_bytes(&bytes).ok())
        .ok_or(Refused::P256dh)?;
    let auth: [u8; 16] = Base64UrlUnpadded::decode_vec(auth.trim_end_matches('='))
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Refused::Auth)?;
    Ok(Device {
        id: device.to_owned(),
        class: device_class.to_owned(),
        endpoint,
        p256dh,
        auth,
        kinds,
        since: crate::now_ms(),
    })
}

/// every subscribed device, oldest first.
///
/// # Errors
/// the store failed.
pub async fn load(store: &Store) -> Result<Vec<Device>, StoreError> {
    store
        .call(|c| {
            let mut statement = c.prepare(
                "SELECT device, device_class, endpoint, p256dh, auth, kinds, created_at
                 FROM push_devices ORDER BY created_at",
            )?;
            let rows = statement.query_map([], |r| {
                let endpoint: String = r.get(2)?;
                let p256dh: Vec<u8> = r.get(3)?;
                let auth: Vec<u8> = r.get(4)?;
                // a row the schema took but this build cannot read is
                // skipped, not fatal: that device subscribes again at its
                // next launch
                let readable = (|| {
                    Some((
                        Url::parse(&endpoint).ok()?,
                        PublicKey::from_sec1_bytes(&p256dh).ok()?,
                        <[u8; 16]>::try_from(auth).ok()?,
                    ))
                })();
                Ok(match readable {
                    Some((endpoint, p256dh, auth)) => Some(Device {
                        id: r.get(0)?,
                        class: r.get(1)?,
                        endpoint,
                        p256dh,
                        auth,
                        kinds: KindSet::from_bits(r.get(5)?),
                        since: r.get(6)?,
                    }),
                    None => None,
                })
            })?;
            rows.filter_map(Result::transpose).collect()
        })
        .await
}

/// saves a device's subscription, replacing its old one and taking the
/// endpoint from any other device that held it (one browser profile that
/// minted a new device id keeps one subscription, not two).
///
/// # Errors
/// the store failed.
pub async fn save(store: &Store, device: &Device) -> Result<i64, StoreError> {
    let row = (
        device.id.clone(),
        device.class.clone(),
        device.endpoint.to_string(),
        device.p256dh.to_sec1_bytes().to_vec(),
        device.auth.to_vec(),
        device.kinds.bits(),
    );
    store
        .call(move |c| {
            let now = crate::now_ms();
            let transaction = c.transaction()?;
            transaction.execute(
                "DELETE FROM push_devices WHERE endpoint = ?1 AND device <> ?2",
                params![row.2, row.0],
            )?;
            transaction.execute(
                "INSERT INTO push_devices
                     (device, device_class, endpoint, p256dh, auth, kinds, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT (device) DO UPDATE SET
                     device_class = excluded.device_class, endpoint = excluded.endpoint,
                     p256dh = excluded.p256dh, auth = excluded.auth,
                     kinds = excluded.kinds, updated_at = excluded.updated_at",
                params![row.0, row.1, row.2, row.3, row.4, row.5, now],
            )?;
            let since: i64 = transaction.query_row(
                "SELECT created_at FROM push_devices WHERE device = ?1",
                [&row.0],
                |r| r.get(0),
            )?;
            transaction.commit()?;
            Ok(since)
        })
        .await
}

/// removes a device's subscription; true if it had one.
///
/// # Errors
/// the store failed.
pub async fn remove(store: &Store, device: &str) -> Result<bool, StoreError> {
    let device = device.to_owned();
    store
        .call(move |c| c.execute("DELETE FROM push_devices WHERE device = ?1", [device]))
        .await
        .map(|removed| removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// a real subscription's keys (rfc 8291, appendix a).
    const P256DH: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";

    fn subscribe(endpoint: &str) -> Result<Device, Refused> {
        parse("d1", "mac", endpoint, P256DH, AUTH, KindSet::ALL)
    }

    #[test]
    fn only_https_endpoints_at_known_push_services_are_taken() {
        assert!(subscribe("https://fcm.googleapis.com/fcm/send/abc").is_ok());
        assert!(subscribe("https://web.push.apple.com/QK2x").is_ok());
        assert!(subscribe("https://updates.push.services.mozilla.com/wpush/v2/x").is_ok());
        assert_eq!(
            subscribe("http://fcm.googleapis.com/x").unwrap_err(),
            Refused::Endpoint
        );
        assert_eq!(
            subscribe("https://evilfcm.googleapis.com.example/x").unwrap_err(),
            Refused::UnknownService("evilfcm.googleapis.com.example".into())
        );
        assert_eq!(
            subscribe("https://127.0.0.1:4870/x").unwrap_err(),
            Refused::UnknownService("127.0.0.1".into())
        );
    }

    #[test]
    fn keys_and_ids_are_checked() {
        let endpoint = "https://fcm.googleapis.com/fcm/send/abc";
        assert_eq!(
            parse("d1", "mac", endpoint, "AAAA", AUTH, KindSet::ALL).unwrap_err(),
            Refused::P256dh
        );
        assert_eq!(
            parse("d1", "mac", endpoint, P256DH, "AAAA", KindSet::ALL).unwrap_err(),
            Refused::Auth
        );
        assert_eq!(
            parse("d 1", "mac", endpoint, P256DH, AUTH, KindSet::ALL).unwrap_err(),
            Refused::DeviceId
        );
    }

    #[tokio::test]
    async fn a_device_holds_one_subscription_and_an_endpoint_one_device() {
        let (store, thread, dir) = crate::store::tests::scratch();
        let first = subscribe("https://fcm.googleapis.com/fcm/send/one").unwrap();
        save(&store, &first).await.unwrap();
        let mut moved = first.clone();
        moved.endpoint = Url::parse("https://fcm.googleapis.com/fcm/send/two").unwrap();
        save(&store, &moved).await.unwrap();
        let mut renamed = moved.clone();
        renamed.id = "d2".into();
        save(&store, &renamed).await.unwrap();
        let devices = load(&store).await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "d2");
        assert!(remove(&store, "d2").await.unwrap());
        assert!(!remove(&store, "d2").await.unwrap());
        drop(store);
        thread.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
