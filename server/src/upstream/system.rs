//! what the host is and how it is doing (`GET /global/system`): its os,
//! the machine, the cpu and its load, memory, the disk the daemon lives
//! on, and how long the host has been up. sampled while its host is
//! connected: once as each connection opens, then every 30 s, so the
//! agents screen's meters move while it is open without the screen asking
//! the daemon itself. a daemon that answers 404 is an older cmx2 without
//! the route; it is not asked again on this connection, only on the next,
//! which is the one a restart or an upgrade makes. the sampler is its own
//! task, as the memory sampler is, so a slow answer never holds up the
//! event stream, and it stops with its watcher.

use std::sync::Arc;
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use utoipa::ToSchema;

use super::{Connection, HostStatus, get, plain};
use crate::config::HostConfig;

const ROUTE: &str = "/global/system";
const EVERY: Duration = Duration::from_secs(30);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
/// the answer is a few dozen short fields; nothing larger is read.
const BODY_CAP: usize = 8 * 1024;
/// a name or a model longer than this is cut, so a daemon cannot make every
/// `/api/hosts` read carry its essay.
const TEXT_CAP: usize = 80;

/// what the sampler knows about a host's system.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    /// the last sample, kept while the host is away so the screen can show
    /// what it last said, as it does the figures.
    pub system: Option<Box<System>>,
    /// whether the daemon answers the route; none until it was first asked.
    pub reports: Option<bool>,
}

/// one sample of the host's system, as the daemon said it, with the time
/// boxbox read it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = HostSystem)]
pub struct System {
    pub os: Os,
    pub machine: Machine,
    pub cpu: Cpu,
    pub memory: MemoryUse,
    /// the disk holding the daemon's data; none when the daemon could not
    /// read it.
    pub disk: Option<Disk>,
    /// how long the host has been up, in seconds.
    pub uptime: u64,
    pub daemon: Daemon,
    /// when the daemon took the sample, ms since the epoch, in its clock.
    pub at: i64,
    /// when boxbox read it, ms since the epoch, in the server's clock.
    pub sampled_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = HostSystemOs)]
pub struct Os {
    /// node's platform name: `darwin`, `linux`, `win32`, or another.
    pub platform: String,
    /// the os as a person names it: `macOS`, `Ubuntu`, `Debian`.
    pub name: String,
    pub version: String,
    pub kernel: String,
    /// `arm64`, `x64`.
    pub arch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = HostSystemMachine)]
pub struct Machine {
    /// what the hardware says it is: `Mac mini`, `Google Compute Engine`.
    pub model: Option<String>,
    /// the vendor's model code: `Mac16,11`.
    pub identifier: Option<String>,
    /// whether the host is a virtual machine.
    #[serde(rename = "virtual")]
    pub is_virtual: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[schema(as = HostSystemCpu)]
pub struct Cpu {
    pub model: String,
    pub cores: u32,
    /// the load averages over 1, 5 and 15 minutes.
    pub load: [f64; 3],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = HostSystemMemory)]
pub struct MemoryUse {
    /// bytes.
    pub total: u64,
    /// bytes a new process could have without the host swapping.
    pub available: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = HostSystemDisk)]
pub struct Disk {
    /// the mount the numbers are for.
    pub path: String,
    /// bytes.
    pub total: u64,
    /// bytes free for the daemon's user.
    pub available: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[schema(as = HostSystemDaemon)]
pub struct Daemon {
    /// the daemon's resident set size, in bytes.
    pub rss: u64,
    /// how long the daemon has been up, in seconds.
    pub uptime: u64,
}

pub(super) async fn sample(
    host: Arc<HostConfig>,
    client: reqwest::Client,
    mut status: watch::Receiver<HostStatus>,
    report: watch::Sender<Report>,
    stop: CancellationToken,
) {
    loop {
        let connected = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            seen = status.wait_for(|s| s.connection == Connection::Connected) => seen.is_ok(),
        };
        if !connected {
            return;
        }
        let mut reports = true;
        loop {
            if reports {
                match read(&client, &host).await {
                    Ok(Some(system)) => {
                        report.send_modify(|r| {
                            r.system = Some(Box::new(system));
                            r.reports = Some(true);
                        });
                    }
                    Ok(None) => {
                        debug!(host = %host.name, route = ROUTE, "the daemon does not report its system");
                        report.send_replace(Report {
                            system: None,
                            reports: Some(false),
                        });
                        reports = false;
                    }
                    Err(error) => {
                        debug!(host = %host.name, route = ROUTE, %error, "system sample failed; the last one stays");
                    }
                }
            }
            tokio::select! {
                biased;
                () = stop.cancelled() => return,
                left = status.wait_for(|s| s.connection != Connection::Connected) => {
                    if left.is_err() {
                        return;
                    }
                    break;
                }
                () = tokio::time::sleep(EVERY), if reports => {}
            }
        }
    }
}

/// one sample; `None` when the daemon has no such route.
async fn read(client: &reqwest::Client, host: &HostConfig) -> Result<Option<System>, String> {
    let mut response = tokio::time::timeout(ANSWER_TIMEOUT, get(client, host, ROUTE).send())
        .await
        .map_err(|_| format!("no answer within {}s", ANSWER_TIMEOUT.as_secs()))?
        .map_err(|e| plain(&e))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("answered {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| plain(&e))? {
        if body.len() + chunk.len() > BODY_CAP {
            return Err(format!("the answer passed {BODY_CAP} bytes"));
        }
        body.extend_from_slice(&chunk);
    }
    decode(&body, crate::now_ms()).map(Some)
}

/// the daemon's answer, decoded by the contract's generated type
/// (`SystemResponse`, from the vendored openapi document; fields cmx2 adds
/// later are ignored), as the wire carries it: text cut to its cap, byte
/// counts as whole numbers, and figures no meter could draw (a load below
/// zero or not a number, more free than there is) refused, so the last
/// sample stays rather than a wrong one.
fn decode(body: &[u8], sampled_at: i64) -> Result<System, String> {
    let answer: crate::cmx2::SystemResponse =
        serde_json::from_slice(body).map_err(|e| e.to_string())?;
    let load: [f64; 3] = answer
        .cpu
        .load
        .as_slice()
        .try_into()
        .map_err(|_| format!("{} load averages, not 3", answer.cpu.load.len()))?;
    if load.iter().any(|l| !l.is_finite() || *l < 0.0) {
        return Err("a load average is not a number of zero or more".to_owned());
    }
    let memory = MemoryUse {
        total: bytes(answer.memory.total, "memory.total")?,
        available: bytes(answer.memory.available, "memory.available")?,
    };
    if memory.available > memory.total {
        return Err("more memory available than there is".to_owned());
    }
    let disk = match answer.disk {
        Some(d) => {
            let disk = Disk {
                path: cut(d.path),
                total: bytes(d.total, "disk.total")?,
                available: bytes(d.available, "disk.available")?,
            };
            if disk.available > disk.total {
                return Err("more disk available than there is".to_owned());
            }
            Some(disk)
        }
        None => None,
    };
    let whole = |n: i64, what: &str| u64::try_from(n).map_err(|_| format!("{what} is below zero"));
    Ok(System {
        os: Os {
            platform: cut(answer.os.platform),
            name: cut(answer.os.name),
            version: cut(answer.os.version),
            kernel: cut(answer.os.kernel),
            arch: cut(answer.os.arch),
        },
        machine: Machine {
            model: answer.machine.model.map(cut),
            identifier: answer.machine.identifier.map(cut),
            is_virtual: answer.machine.virtual_,
        },
        cpu: Cpu {
            model: cut(answer.cpu.model),
            cores: u32::try_from(answer.cpu.cores)
                .ok()
                .filter(|c| *c > 0)
                .ok_or_else(|| format!("{} cores", answer.cpu.cores))?,
            load,
        },
        memory,
        disk,
        uptime: whole(answer.uptime, "uptime")?,
        daemon: Daemon {
            rss: bytes(answer.daemon.rss, "daemon.rss")?,
            uptime: whole(answer.daemon.uptime, "daemon.uptime")?,
        },
        #[allow(
            clippy::cast_possible_truncation,
            reason = "epoch ms fit an i64 for the next 290 million years"
        )]
        at: answer.at as i64,
        sampled_at,
    })
}

/// text cut to `TEXT_CAP` characters, on a character.
fn cut(text: String) -> String {
    match text.char_indices().nth(TEXT_CAP) {
        Some((at, _)) => text[..at].to_owned(),
        None => text,
    }
}

/// a byte count the contract types as a number, as a whole one.
fn bytes(n: f64, what: &str) -> Result<u64, String> {
    if !n.is_finite() || n < 0.0 || n > 2f64.powi(63) {
        return Err(format!("{what} is not a byte count"));
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked finite, at least zero and under 2^63 above"
    )]
    Ok(n.round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// the agreed shape, as a mac answers it.
    const MAC: &str = r#"{
        "os": { "platform": "darwin", "name": "macOS", "version": "26.1", "kernel": "25.1.0", "arch": "arm64" },
        "machine": { "model": "Mac mini", "identifier": "Mac16,11", "virtual": false },
        "cpu": { "model": "Apple M4 Pro", "cores": 14, "load": [2.41, 1.98, 1.7] },
        "memory": { "total": 68719476736, "available": 24696061952 },
        "disk": { "path": "/", "total": 994662584320, "available": 227633266688 },
        "uptime": 781200,
        "daemon": { "rss": 327155712, "uptime": 10800 },
        "at": 1792224000000
    }"#;

    #[test]
    fn what_a_real_mac_said_decodes() {
        // cmx2's own sample from a dev daemon (cmx2 a3e7e3f), the version emptied as the contract allows
        let body = r#"{"os":{"platform":"darwin","kernel":"27.0.0","arch":"arm64","name":"macOS","version":""},"machine":{"model":"MacBook Pro","identifier":"MacBookPro18,3","virtual":false},"cpu":{"model":"Apple M1 Pro","cores":8,"load":[17.302734375,12.3701171875,7.45751953125]},"memory":{"total":17179869184,"available":3910598656},"disk":{"path":"/System/Volumes/Data","total":494353338368,"available":55887507456},"uptime":152439,"daemon":{"rss":115179520,"uptime":7},"at":1792230495373}"#;
        let system = decode(body.as_bytes(), 0).unwrap();
        assert_eq!(system.os.version, "");
        assert_eq!(system.memory.available, 3_910_598_656);
        assert_eq!(system.at, 1_792_230_495_373);
    }

    #[test]
    fn a_mac_decodes_whole() {
        let system = decode(MAC.as_bytes(), 7).unwrap();
        assert_eq!(system.os.name, "macOS");
        assert_eq!(system.machine.model.as_deref(), Some("Mac mini"));
        assert!(!system.machine.is_virtual);
        assert_eq!(system.cpu.cores, 14);
        assert!((system.cpu.load[0] - 2.41).abs() < f64::EPSILON);
        assert_eq!(system.disk.as_ref().map(|d| d.path.as_str()), Some("/"));
        assert_eq!(system.daemon.rss, 327_155_712);
        assert_eq!(system.sampled_at, 7);
    }

    #[test]
    fn a_vm_without_a_disk_or_a_model_decodes() {
        let body = MAC
            .replace(r#""model": "Mac mini""#, r#""model": null"#)
            .replace(r#""identifier": "Mac16,11""#, r#""identifier": null"#)
            .replace(r#""virtual": false"#, r#""virtual": true"#)
            .replace(
                r#"{ "path": "/", "total": 994662584320, "available": 227633266688 }"#,
                "null",
            );
        let system = decode(body.as_bytes(), 0).unwrap();
        assert_eq!(system.machine.model, None);
        assert!(system.machine.is_virtual);
        assert_eq!(system.disk, None);
    }

    #[test]
    fn fields_the_daemon_adds_are_ignored() {
        let body = MAC.replacen('{', r#"{ "gpu": { "model": "a new field" },"#, 1);
        assert!(decode(body.as_bytes(), 0).is_ok());
    }

    #[test]
    fn numbers_no_meter_could_draw_are_refused() {
        let load = MAC.replace("[2.41, 1.98, 1.7]", "[-1, 1.98, 1.7]");
        assert!(decode(load.as_bytes(), 0).is_err());
        let memory = MAC.replace(
            r#""available": 24696061952"#,
            r#""available": 99999999999999"#,
        );
        assert!(decode(memory.as_bytes(), 0).is_err());
        let short = MAC.replace("[2.41, 1.98, 1.7]", "[2.41]");
        assert!(decode(short.as_bytes(), 0).is_err());
    }

    #[test]
    fn long_text_is_cut_on_a_character() {
        let long = "é".repeat(200);
        let body = MAC.replace("Apple M4 Pro", &long);
        let system = decode(body.as_bytes(), 0).unwrap();
        assert_eq!(system.cpu.model.chars().count(), TEXT_CAP);
    }

    #[test]
    fn the_wire_names_are_the_agreed_ones() {
        let system = decode(MAC.as_bytes(), 7).unwrap();
        let wire = serde_json::to_value(&system).unwrap();
        assert_eq!(wire["machine"]["virtual"], false);
        assert_eq!(wire["sampledAt"], 7);
        assert_eq!(wire["cpu"]["load"].as_array().map(Vec::len), Some(3));
    }
}
