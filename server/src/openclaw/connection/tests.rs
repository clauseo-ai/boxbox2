//! the connection's pure parts, and the live checks against the dev
//! gateway (`just openclaw`, `docs/openclaw.md` section 11).
//!
//! the live tests are `#[ignore]`d and need a running bench:
//!
//! ```text
//! just openclaw --port 4750
//! BOXBOX_OPENCLAW_BENCH=.openclaw/bench-4750 cargo test openclaw_live -- --ignored --nocapture --test-threads 1
//! ```
//!
//! the pairing test needs the lan bench as well (11.6): `just openclaw
//! --port 4753 --pairing manual`, `BOXBOX_OPENCLAW_LAN_BENCH` naming its
//! bench dir and `BOXBOX_OPENCLAW_LAN_URL` the machine's own lan address
//! (`ws://<lan ip>:4753`). it prints the pairing request id and waits for
//! `devices approve` to be run against that bench. they print what they
//! assert on (`--nocapture`).

use std::path::{Path, PathBuf};

use super::*;

#[test]
fn backoff_doubles_from_one_second_to_thirty_with_full_jitter() {
    let mut backoff = FullJitter::default();
    let ceilings: Vec<u64> = (0..8).map(|_| backoff.next_with(1.0).as_secs()).collect();
    assert_eq!(ceilings, [1, 2, 4, 8, 16, 30, 30, 30]);
    backoff.reset();
    assert_eq!(
        backoff.next_with(0.0),
        BACKOFF_FLOOR,
        "never under a second"
    );
    assert_eq!(backoff.next_with(0.5), Duration::from_secs(1));
    assert_eq!(backoff.next_with(0.5), Duration::from_secs(2));
}

#[test]
fn a_slow_consumer_close_reconnects_and_any_other_1008_waits_out_the_cap() {
    let slow = closed_after_hello("vm-b", Some(1008), "slow consumer", None, Duration::ZERO);
    assert!(
        matches!(&slow, Ended::Retry { floor: None, why, .. } if why.contains("slow consumer"))
    );
    let other = closed_after_hello(
        "vm-b",
        Some(1008),
        "gateway message handler loading",
        None,
        Duration::ZERO,
    );
    assert!(matches!(
        other,
        Ended::Retry {
            floor: Some(BACKOFF_CAP),
            ..
        }
    ));
    let restart = closed_after_hello(
        "vm-b",
        Some(1012),
        "service restart",
        Some(Duration::from_secs(3)),
        Duration::ZERO,
    );
    assert!(matches!(restart, Ended::Retry { floor: Some(f), .. } if f == Duration::from_secs(3)));
}

#[test]
fn a_gateway_error_keeps_its_detail_code_and_retry_floor() {
    let error = gateway_error(Some(serde_json::json!({
        "code": "NOT_PAIRED",
        "message": "device pairing required",
        "details": {"code": "PAIRING_REQUIRED", "requestId": "r-1"},
        "retryAfterMs": 1500
    })));
    assert_eq!(error.code, "NOT_PAIRED");
    assert_eq!(error.detail.as_deref(), Some("PAIRING_REQUIRED"));
    assert_eq!(error.retry_after, Some(Duration::from_millis(1500)));
    assert!(!error.retryable);
    let empty = gateway_error(None);
    assert_eq!(empty.code, "UNKNOWN");
}

fn test_config(name: &str, url: &str, token_file: PathBuf) -> OpenclawConfig {
    OpenclawConfig {
        name: name.into(),
        url: url.parse().expect("a url"),
        token_file,
        device_key: None,
        mode: crate::source::OpenclawMode::Full,
        machine: None,
        agents: std::collections::BTreeMap::new(),
        origin: crate::config::Origin::Config,
    }
}

#[tokio::test]
async fn a_restart_is_a_new_boot_id_or_with_none_an_uptime_that_went_back() {
    let (store, thread, dir) = crate::store::tests::scratch();
    let config = test_config("vm-b", "ws://127.0.0.1:1", "/nonexistent".into());
    let (_client, _events, mut connection) = open(config, store).expect("tls builds");
    assert!(
        !connection.restarted(Some("a"), 1_000),
        "the first hello is no restart"
    );
    connection.last_boot = Some("a".into());
    connection.last_uptime = Some((60_000, Instant::now()));
    assert!(!connection.restarted(Some("a"), 61_000));
    assert!(connection.restarted(Some("b"), 61_000));
    connection.last_boot = None;
    assert!(connection.restarted(None, 2_000), "uptime went backwards");
    assert!(!connection.restarted(None, 60_500));
    drop(connection);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "one table, one row per refusal")]
async fn the_connect_refusals_map_to_the_pairing_states() {
    let (store, thread, dir) = crate::store::tests::scratch();
    let config = test_config("vm-b", "ws://127.0.0.1:1", "/nonexistent".into());
    let (_client, _events, mut connection) =
        open(config.clone(), store.clone()).expect("tls builds");
    let mut credentials = Credentials::load(&config, &store)
        .await
        .expect("credentials");
    let error = |code: &str, detail: serde_json::Value| GatewayError {
        code: code.into(),
        message: "said".into(),
        detail: detail
            .get("code")
            .and_then(|c| c.as_str())
            .map(str::to_owned),
        details: Some(detail),
        retryable: false,
        retry_after: None,
    };
    let pairing = connection
        .connect_refused(
            &mut credentials,
            error(
                "NOT_PAIRED",
                serde_json::json!({"code": "PAIRING_REQUIRED", "requestId": "r-9"}),
            ),
        )
        .await;
    assert!(matches!(
        &pairing,
        Ended::Retry { phase: Phase::Pairing { request_id: Some(id) }, why, .. }
            if id == "r-9" && why == "openclaw devices approve r-9"
    ));
    credentials.keep_device_token("old").await.expect("keep");
    let mismatch = connection
        .connect_refused(
            &mut credentials,
            error(
                "INVALID_REQUEST",
                serde_json::json!({"code": "AUTH_DEVICE_TOKEN_MISMATCH"}),
            ),
        )
        .await;
    assert!(matches!(mismatch, Ended::Retry { .. }));
    assert!(
        credentials.device_token.is_none(),
        "the refused token is dropped"
    );
    assert!(
        store
            .secret("vm-b", "device_token")
            .await
            .expect("store")
            .is_none()
    );
    let protocol = connection
        .connect_refused(
            &mut credentials,
            error(
                "INVALID_REQUEST",
                serde_json::json!({"code": "PROTOCOL_MISMATCH", "expectedProtocol": 5}),
            ),
        )
        .await;
    assert!(matches!(
        protocol,
        Ended::Refused {
            refusal: Refusal::Protocol,
            protocol: Some(5),
            retry_in: Some(PROTOCOL_RETRY),
            ..
        }
    ));
    let auth = connection
        .connect_refused(
            &mut credentials,
            error(
                "INVALID_REQUEST",
                serde_json::json!({"code": "AUTH_TOKEN_MISMATCH"}),
            ),
        )
        .await;
    assert!(matches!(
        auth,
        Ended::Refused {
            refusal: Refusal::Auth,
            retry_in: None,
            ..
        }
    ));
    let limited = connection
        .connect_refused(
            &mut credentials,
            GatewayError {
                retry_after: Some(Duration::from_secs(7)),
                ..error(
                    "UNAVAILABLE",
                    serde_json::json!({"code": "AUTH_RATE_LIMITED"}),
                )
            },
        )
        .await;
    assert!(matches!(limited, Ended::Retry { floor: Some(f), .. } if f == Duration::from_secs(7)));
    drop((connection, credentials, store));
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

// ---- live, against the dev gateway ----

struct Bench {
    url: String,
    token_file: PathBuf,
    gateway_pid: Option<u64>,
}

fn bench_at(dir: &Path) -> Bench {
    let json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join("gateway.json")).expect("the bench wrote gateway.json"),
    )
    .expect("gateway.json is json");
    Bench {
        url: json["url"].as_str().expect("a url").to_owned(),
        token_file: dir.join("token"),
        gateway_pid: json["pids"]["gateway"].as_u64(),
    }
}

fn bench() -> Option<Bench> {
    let dir = std::env::var_os("BOXBOX_OPENCLAW_BENCH")?;
    Some(bench_at(Path::new(&dir)))
}

macro_rules! need_bench {
    () => {
        match bench() {
            Some(bench) => bench,
            None => {
                println!("skipped: BOXBOX_OPENCLAW_BENCH names no running bench");
                return;
            }
        }
    };
}

struct Running {
    client: Client,
    events: Events,
    shutdown: CancellationToken,
    task: JoinHandle<Exit>,
    tap: super::super::wire::Tap,
    kill: Arc<tokio::sync::Notify>,
}

fn start(config: OpenclawConfig, store: crate::store::Store, protocol: Option<u64>) -> Running {
    let (client, events, mut connection) = open(config, store).expect("tls builds");
    let tap: super::super::wire::Tap = Arc::default();
    let kill = Arc::new(tokio::sync::Notify::new());
    connection.test.tap = Some(Arc::clone(&tap));
    connection.test.protocol = protocol;
    connection.test.kill_socket = Some(Arc::clone(&kill));
    let shutdown = CancellationToken::new();
    let task = tokio::spawn({
        let shutdown = shutdown.clone();
        async move { connection.run(shutdown).await }
    });
    Running {
        client,
        events,
        shutdown,
        task,
        tap,
        kill,
    }
}

impl Running {
    async fn next_connected(&mut self, within: Duration) -> Arc<Hello> {
        tokio::time::timeout(within, async {
            loop {
                match self.events.recv().await.expect("the stream is open") {
                    Event::Connected(hello) => return hello,
                    Event::Disconnected { why } => println!("  disconnected: {why}"),
                    Event::Frame(_) => {}
                }
            }
        })
        .await
        .expect("connected in time")
    }

    async fn next_disconnected(&mut self, within: Duration) -> String {
        tokio::time::timeout(within, async {
            loop {
                if let Event::Disconnected { why } =
                    self.events.recv().await.expect("the stream is open")
                {
                    return why;
                }
            }
        })
        .await
        .expect("disconnected in time")
    }

    async fn wait_state(
        &self,
        within: Duration,
        done: impl Fn(&ConnectionState) -> bool,
    ) -> ConnectionState {
        let mut state = self.client.state();
        tokio::time::timeout(within, async {
            loop {
                let now = state.borrow_and_update().clone();
                if done(&now) {
                    return now;
                }
                state.changed().await.expect("the state is published");
            }
        })
        .await
        .expect("the state arrived in time")
    }

    async fn stop(self) -> Exit {
        self.shutdown.cancel();
        let exit = self.task.await.expect("the task joins");
        let taps = self.tap.lock().expect("tap").clone();
        for (method, _) in &taps {
            assert!(
                super::super::wire::METHODS.contains(&method.as_str()),
                "{method} was sent"
            );
        }
        exit
    }
}

fn agents_list_works(response: &Response) -> usize {
    let value: serde_json::Value = response.decode().expect("agents.list decodes");
    value["agents"].as_array().map_or(0, Vec::len)
}

#[tokio::test]
#[ignore = "needs the dev gateway (BOXBOX_OPENCLAW_BENCH)"]
async fn openclaw_live_loopback_connects_on_the_shared_token_with_no_device_token() {
    let bench = need_bench!();
    let (store, thread, dir) = crate::store::tests::scratch();
    let mut running = start(
        test_config("bench", &bench.url, bench.token_file.clone()),
        store.clone(),
        None,
    );
    let hello = running.next_connected(Duration::from_secs(20)).await;
    println!(
        "loopback hello: version {} protocol {} boot {:?} scopes {:?} device token {} untested {}",
        hello.hello.server.version,
        hello.hello.protocol,
        hello.hello.server.boot_id,
        hello.hello.auth.scopes,
        hello.got_device_token,
        hello.untested
    );
    assert!(
        hello.missing_scopes.is_empty(),
        "all five scopes on loopback"
    );
    assert!(
        !hello.got_device_token,
        "loopback hands out no device token"
    );
    assert!(!hello.untested);
    assert!(
        store
            .secret("bench", "device_token")
            .await
            .expect("store")
            .is_none()
    );
    let state = running
        .wait_state(Duration::from_secs(1), |s| s.phase == Phase::Connected)
        .await;
    println!("state: {state:?}");
    let agents = running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect("agents.list answers");
    println!("agents.list: {} agents", agents_list_works(&agents));
    assert!(agents_list_works(&agents) >= 2);
    // concurrent reads respect the limits and all answer
    let mut reads = Vec::new();
    for _ in 0..10 {
        let client = running.client.clone();
        reads.push(tokio::spawn(async move {
            client.request(Allowed::AgentsList).await
        }));
    }
    for read in reads {
        read.await.expect("joins").expect("each read answers");
    }
    let taps = running.tap.lock().expect("tap").clone();
    let connect = taps
        .iter()
        .find(|(m, _)| m == "connect")
        .expect("connect was tapped");
    println!("connect keys: {:?}", connect.1);
    assert!(connect.1.contains(&"device".to_owned()));
    let exit = running.stop().await;
    assert_eq!(exit, Exit::Stopped);
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[tokio::test]
#[ignore = "needs the dev gateway (BOXBOX_OPENCLAW_BENCH)"]
async fn openclaw_live_watch_mode_refuses_writes_and_reads_still_go() {
    let bench = need_bench!();
    let (store, thread, dir) = crate::store::tests::scratch();
    let mut config = test_config("bench", &bench.url, bench.token_file.clone());
    config.mode = crate::source::OpenclawMode::Watch;
    let mut running = start(config, store.clone(), None);
    running.next_connected(Duration::from_secs(20)).await;
    let send = Allowed::ChatSend(Box::new(super::super::wire::ChatSend {
        session_key: "agent:main:main".into(),
        agent_id: "main".into(),
        session_id: None,
        expected_leaf_entry_id: None,
        message: "never sent".into(),
        idempotency_key: "watch-1".into(),
        reply_to_id: None,
        attachments: Vec::new(),
    }));
    let refused = running
        .client
        .request(send)
        .await
        .expect_err("watch refuses");
    println!("watch: {refused}");
    assert!(matches!(
        refused,
        RequestError::Watch {
            method: "chat.send"
        }
    ));
    running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect("a read goes");
    let taps = running.tap.lock().expect("tap").clone();
    assert!(
        taps.iter().all(|(m, _)| m != "chat.send"),
        "nothing written: {taps:?}"
    );
    running.stop().await;
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[tokio::test]
#[ignore = "needs the dev gateway (BOXBOX_OPENCLAW_BENCH)"]
async fn openclaw_live_a_socket_dropped_mid_connection_recovers() {
    let bench = need_bench!();
    let (store, thread, dir) = crate::store::tests::scratch();
    let mut running = start(
        test_config("bench", &bench.url, bench.token_file.clone()),
        store.clone(),
        None,
    );
    let first = running.next_connected(Duration::from_secs(20)).await;
    running.kill.notify_one();
    let why = running.next_disconnected(Duration::from_secs(5)).await;
    println!("dropped: {why}");
    let started = Instant::now();
    let second = running.next_connected(Duration::from_secs(40)).await;
    println!(
        "reconnected after {} ms, boot {:?} -> {:?}, restarted {}",
        started.elapsed().as_millis(),
        first.hello.server.boot_id,
        second.hello.server.boot_id,
        second.restarted
    );
    assert!(!second.restarted, "the same gateway process");
    assert_eq!(second.previous_boot_id, first.hello.server.boot_id);
    running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect("requests work again");
    let state = running.client.state().borrow().clone();
    assert_eq!(state.connects, 2);
    running.stop().await;
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[tokio::test]
#[ignore = "needs the dev gateway (BOXBOX_OPENCLAW_BENCH); freezes its gateway"]
async fn openclaw_live_a_frozen_gateway_is_declared_dead_and_rejoined() {
    let bench = need_bench!();
    let pid = bench
        .gateway_pid
        .expect("gateway.json names the gateway pid")
        .to_string();
    let (store, thread, dir) = crate::store::tests::scratch();
    let mut running = start(
        test_config("bench", &bench.url, bench.token_file.clone()),
        store.clone(),
        None,
    );
    running.next_connected(Duration::from_secs(20)).await;
    // a stopped process keeps its socket open and says nothing: only the
    // ping and the tick silence can find it (3.7)
    let signal = |how: &str| {
        let status = std::process::Command::new("kill")
            .args([how, &pid])
            .status()
            .expect("kill runs");
        assert!(status.success(), "kill {how} {pid}");
    };
    signal("-STOP");
    let frozen = Instant::now();
    let why = tokio::time::timeout(
        Duration::from_secs(100),
        running.next_disconnected(Duration::from_secs(100)),
    )
    .await;
    signal("-CONT");
    let why = why.expect("declared dead in time");
    println!(
        "declared dead after {} s: {why}",
        frozen.elapsed().as_secs()
    );
    let hello = running.next_connected(Duration::from_secs(90)).await;
    println!("rejoined, restarted {}", hello.restarted);
    assert!(!hello.restarted, "the same gateway process");
    running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect("requests work again");
    running.stop().await;
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[tokio::test]
#[ignore = "needs the dev gateway (BOXBOX_OPENCLAW_BENCH); kills its gateway"]
async fn openclaw_live_a_gateway_restart_is_seen_by_its_boot_id() {
    let bench = need_bench!();
    let pid = bench
        .gateway_pid
        .expect("gateway.json names the gateway pid");
    let (store, thread, dir) = crate::store::tests::scratch();
    let mut running = start(
        test_config("bench", &bench.url, bench.token_file.clone()),
        store.clone(),
        None,
    );
    let first = running.next_connected(Duration::from_secs(20)).await;
    // a request in flight when the gateway dies answers lost, never failed
    let status = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill runs");
    assert!(status.success(), "kill -9 {pid}");
    println!("killed gateway pid {pid}");
    let why = running.next_disconnected(Duration::from_secs(70)).await;
    println!("disconnected: {why}");
    let second = running.next_connected(Duration::from_secs(120)).await;
    println!(
        "boot {:?} -> {:?}, restarted {}",
        first.hello.server.boot_id, second.hello.server.boot_id, second.restarted
    );
    assert!(second.restarted);
    assert_ne!(first.hello.server.boot_id, second.hello.server.boot_id);
    running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect("requests work again");
    running.stop().await;
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

#[tokio::test]
#[ignore = "needs the dev gateway (BOXBOX_OPENCLAW_BENCH)"]
async fn openclaw_live_a_protocol_mismatch_is_refused_cleanly() {
    let bench = need_bench!();
    let (store, thread, dir) = crate::store::tests::scratch();
    let running = start(
        test_config("bench", &bench.url, bench.token_file.clone()),
        store.clone(),
        Some(PROTOCOL + 1),
    );
    let state = running
        .wait_state(Duration::from_secs(20), |s| {
            matches!(s.phase, Phase::Refused(_))
        })
        .await;
    println!("state: {state:?}");
    assert_eq!(state.phase, Phase::Refused(Refusal::Protocol));
    assert_eq!(state.protocol, Some(4), "the protocol the gateway speaks");
    let refused = running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect_err("nothing goes");
    assert!(refused.never_sent());
    let taps = running.tap.lock().expect("tap").clone();
    println!(
        "sent: {:?}",
        taps.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>()
    );
    assert_eq!(taps.len(), 1, "only the connect was ever written");
    running.stop().await;
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(dir).expect("cleanup");
}

/// the remote path (3.4, 11.6): pairing required, approval on the gateway,
/// the device token kept, and a second boxbox run on the same database
/// connecting with it straight away.
#[tokio::test]
#[ignore = "needs the lan pairing bench (BOXBOX_OPENCLAW_LAN_BENCH, BOXBOX_OPENCLAW_LAN_URL)"]
async fn openclaw_live_lan_pairing_keeps_the_device_token_across_a_restart() {
    let (Some(dir), Some(url)) = (
        std::env::var_os("BOXBOX_OPENCLAW_LAN_BENCH"),
        std::env::var("BOXBOX_OPENCLAW_LAN_URL").ok(),
    ) else {
        println!("skipped: no lan bench");
        return;
    };
    let lan = bench_at(Path::new(&dir));
    let db_dir = std::env::temp_dir().join(format!("boxbox-oc-pairing-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&db_dir).expect("db dir");
    let db = db_dir.join("boxbox.db");
    let config = test_config("lan", &url, lan.token_file.clone());

    let (store, thread) = crate::store::Store::open(&db).expect("store");
    let mut running = start(config.clone(), store.clone(), None);
    let pairing = running
        .wait_state(Duration::from_secs(30), |s| {
            matches!(s.phase, Phase::Pairing { .. })
        })
        .await;
    let Phase::Pairing { request_id } = &pairing.phase else {
        unreachable!()
    };
    println!(
        "PAIRING REQUEST {}",
        request_id.as_deref().unwrap_or("none")
    );
    println!("pairing words: {:?}", pairing.last_error);
    assert!(request_id.is_some());
    let hello = running.next_connected(Duration::from_secs(300)).await;
    println!(
        "paired: scopes {:?}, device token {}",
        hello.hello.auth.scopes, hello.got_device_token
    );
    assert!(
        hello.got_device_token,
        "the remote path hands out a device token"
    );
    assert!(hello.missing_scopes.is_empty());
    running
        .client
        .request(Allowed::AgentsList)
        .await
        .expect("agents.list answers");
    running.stop().await;
    let kept = store
        .secret("lan", "device_token")
        .await
        .expect("store")
        .expect("the device token is kept");
    let device_key = store
        .secret("lan", "device_key")
        .await
        .expect("store")
        .expect("the device key is kept");
    println!(
        "kept a device token of {} bytes and a device key of {} bytes",
        kept.len(),
        device_key.len()
    );
    drop(store);
    thread.join().expect("store stops");

    // boxbox restarts: the same database, a fresh connection task
    let (store, thread) = crate::store::Store::open(&db).expect("store reopens");
    let mut running = start(config, store.clone(), None);
    let hello = running.next_connected(Duration::from_secs(30)).await;
    let taps = running.tap.lock().expect("tap").clone();
    let connect = taps
        .iter()
        .find(|(m, _)| m == "connect")
        .expect("connect tapped");
    println!(
        "after restart: connected with no pairing, scopes {:?}",
        hello.hello.auth.scopes
    );
    assert!(hello.missing_scopes.is_empty());
    assert!(connect.1.contains(&"auth".to_owned()));
    assert!(
        hello.used_device_token,
        "the reconnect presented the kept device token"
    );
    let states_seen = running.client.state().borrow().clone();
    assert_eq!(states_seen.connects, 1);
    running.stop().await;
    drop(store);
    thread.join().expect("store stops");
    std::fs::remove_dir_all(&db_dir).expect("cleanup");
}
