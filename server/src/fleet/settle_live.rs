//! auto-clear and unclear against a real cmx2 daemon (`docs/verification.md`,
//! settle): the fleet actor and the cmx2 source as the server runs them, a
//! scratch store, and a real turn on the bench model. the sweep's hour is
//! crossed with `Fleet::sweep_at`, a test-only command that runs the sweep on
//! a clock the test picks, so no production knob exists for it.
//!
//! run it with the dev daemon up (`CMX2_PORT=4846 just cmx2`, or any port):
//!
//! ```text
//! BOXBOX_SETTLE_CONFIG=.cmx2/bench/boxbox.toml \
//!   cargo test --locked settle_live -- --ignored --nocapture
//! ```

use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use super::{
    Clears, Colours, Feed, Fleet, From, Live, Needs, Opening, Reads, TAIL_REQUESTS, Wiring,
    model::Device, persist, spawn,
};
use crate::config::{Config, HostConfig};
use crate::prefs::HomePrefs;
use crate::push::Push;
use crate::push::presence::Looking;

const HOUR: i64 = 60 * 60 * 1000;

async fn daemon(
    client: &reqwest::Client,
    host: &HostConfig,
    method: reqwest::Method,
    route: &str,
    body: Value,
) -> Value {
    let mut request = crate::upstream::request(client, host, method.clone(), route);
    if !body.is_null() {
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string());
    }
    let answer = request
        .send()
        .await
        .unwrap_or_else(|e| panic!("{method} {route}: {e}"));
    let status = answer.status();
    let text = answer.text().await.unwrap();
    assert!(status.is_success(), "{method} {route} -> {status} {text}");
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

/// the thread as the fleet holds it now, if it does.
async fn thread(fleet: &Fleet, key: &str) -> Option<Value> {
    let (body, _) = fleet.snapshot().await.unwrap();
    let fleet: Value = serde_json::from_slice(&body).unwrap();
    fleet["threads"]
        .as_array()?
        .iter()
        .find(|t| t["key"] == key)
        .cloned()
}

/// waits until the thread is idle with an open done need.
async fn finished(fleet: &Fleet, key: &str) -> Value {
    for _ in 0..200 {
        if let Some(t) = thread(fleet, key).await {
            let done = t["needs"]
                .as_array()
                .is_some_and(|needs| needs.iter().any(|n| n["kind"] == "done"));
            if t["activity"]["state"] == "idle" && done {
                return t;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "{key} did not finish with a done within 20 s: {:?}",
        thread(fleet, key).await
    );
}

/// the settle frames the stream has heard since the last call.
fn settle_frames(live: &mut Live) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(feed) = live.frames.try_recv() {
        let Feed::Frame(bytes) = feed else { continue };
        let text = std::str::from_utf8(&bytes).unwrap();
        for line in text.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if value["type"] == "away" || value["type"] == "autoCleared" {
                frames.push(value);
            }
        }
    }
    frames
}

/// marks the thread read through the daemon's newest message, as a phone would.
async fn read_through_newest(
    fleet: &Fleet,
    client: &reqwest::Client,
    host: &HostConfig,
    id: &str,
    key: &str,
) {
    let messages = daemon(
        client,
        host,
        reqwest::Method::GET,
        &format!("/session/{id}/message"),
        Value::Null,
    )
    .await;
    let newest = messages
        .as_array()
        .and_then(|m| m.last())
        .expect("the turn left messages");
    let info = &newest["info"];
    let device = Device {
        id: "settle-phone".into(),
        class: "iphone".into(),
    };
    fleet
        .mark_read(
            key.to_owned(),
            device,
            info["id"].as_str().unwrap().to_owned(),
            info["time"]["created"].as_f64().unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a cmx2 dev daemon: BOXBOX_SETTLE_CONFIG=<the bench boxbox.toml `just cmx2` writes>"]
#[allow(clippy::too_many_lines, reason = "one live scenario, step after step")]
async fn a_real_thread_auto_clears_comes_back_on_unclear_and_is_kept() {
    let config = Config::load(
        &std::env::var("BOXBOX_SETTLE_CONFIG")
            .expect("BOXBOX_SETTLE_CONFIG names the bench boxbox.toml"),
    )
    .unwrap();
    let host = config.hosts[0].clone();
    let client = reqwest::Client::new();
    let (store, store_thread, dir) = crate::store::tests::scratch();
    let shutdown = CancellationToken::new();
    let resumed = persist::resume(&store).await.unwrap();
    let (looking_tx, looking) = watch::channel(Vec::new());
    let (tails_tx, tails_rx) = mpsc::channel(TAIL_REQUESTS);
    let (fleet, fleet_task) = spawn(
        "settle-live".into(),
        Wiring {
            push: Push::detached(),
            telemetry: crate::telemetry::Sender::detached(),
            store: store.clone(),
            looking,
            needs: Needs::default(),
            reads: Reads::default(),
            clears: Clears::default(),
            adopted: Vec::new(),
            colours: Colours::default(),
            home: HomePrefs::default(),
            sweep: super::model::SweepPace::default(),
            tails: tails_tx,
            resumed,
        },
        shutdown.clone(),
    );
    let (_upstreams, supervisor) = crate::upstream::spawn(
        vec![host.clone()],
        &[],
        Vec::new(),
        crate::upstream::source::Shared::new(crate::media::Media::detached()),
        client.clone(),
        fleet.upstream(),
        tails_rx,
        &store,
        shutdown.clone(),
    );
    let opened = fleet
        .open(Opening {
            from: From::Start,
            interest: crate::wire::Interest::default(),
            since: std::collections::BTreeMap::new(),
            owner: [0; 32],
            log: 1,
        })
        .await
        .unwrap();
    let mut live = opened.live;

    // a real turn on the bench model, to its done
    let nonce = crate::now_ms();
    let session = daemon(
        &client,
        &host,
        reqwest::Method::POST,
        "/session",
        json!({ "title": format!("settle live {nonce}") }),
    )
    .await;
    let id = session["id"].as_str().unwrap().to_owned();
    let key = format!("{}:{id}", host.name);
    daemon(
        &client,
        &host,
        reqwest::Method::POST,
        &format!("/session/{id}/prompt"),
        json!({ "text": "[bench:words 6 5] a short answer" }),
    )
    .await;
    finished(&fleet, &key).await;
    read_through_newest(&fleet, &client, &host, &id, &key).await;
    let seen = crate::now_ms();
    let after = thread(&fleet, &key).await.unwrap();
    println!(
        "{key} finished and was read at {seen}: read {} needs {}",
        after["read"], after["needs"]
    );

    // seen1h: not before the hour, then cleared, with nobody looking
    let early = fleet.sweep_at(seen + HOUR - 60_000).await.unwrap();
    assert!(!early.cleared.contains(&key), "{early:?}");
    let swept = fleet.sweep_at(seen + HOUR + 1000).await.unwrap();
    println!("sweep an hour on: {swept:?}");
    assert!(swept.cleared.contains(&key), "{swept:?}");
    assert!(swept.away);
    let cleared = thread(&fleet, &key).await.unwrap();
    assert!(cleared["cleared"].is_number(), "{cleared}");
    assert!(
        !cleared["needs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "done"),
        "the done was served with the clear"
    );
    let frames = settle_frames(&mut live);
    println!("frames after the sweep: {frames:?}");
    let away = frames
        .iter()
        .rev()
        .find(|f| f["type"] == "away")
        .expect("an away frame");
    assert!(
        away["threads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["key"] == key)
    );
    assert!(
        !frames.iter().any(|f| f["type"] == "autoCleared"),
        "nobody was looking"
    );

    // the row: cause, away, times
    let mut row = None;
    for _ in 0..50 {
        let k = key.clone();
        row = store
            .call(move |c| {
                use rusqlite::OptionalExtension;
                c.query_row(
                    "SELECT cause, away, done_at, seen_at FROM clears WHERE session = ?1",
                    [k],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, Option<i64>>(2)?,
                            r.get::<_, Option<i64>>(3)?,
                        ))
                    },
                )
                .optional()
            })
            .await
            .unwrap();
        if row.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (cause, away_flag, done_at, seen_at) = row.expect("the clear was written");
    println!("clears row: cause={cause} away={away_flag} done_at={done_at:?} seen_at={seen_at:?}");
    assert_eq!((cause.as_str(), away_flag), ("auto", 1));
    assert!(done_at.is_some() && seen_at.is_some());
    assert!(done_at <= seen_at, "it finished before it was seen");

    // unclear: back on home, out of the away summary, kept from the next sweeps
    let answers = fleet.unclear(vec![key.clone()]).await.unwrap();
    assert_eq!(answers, [(key.clone(), Ok(()))]);
    assert!(thread(&fleet, &key).await.unwrap()["cleared"].is_null());
    let frames = settle_frames(&mut live);
    assert_eq!(
        frames.last().map(|f| f["threads"].clone()),
        Some(json!([])),
        "{frames:?}"
    );
    let kept = fleet.sweep_at(seen + 3 * HOUR).await.unwrap();
    assert!(!kept.cleared.contains(&key), "kept: {kept:?}");
    let again = fleet.unclear(vec![key.clone()]).await.unwrap();
    assert_eq!(
        again,
        [(key.clone(), Err(super::model::UnclearRefused::NotCleared))]
    );

    // a new turn spends the kept mark; with a device looking the sweep sends the undo, not the away line
    daemon(
        &client,
        &host,
        reqwest::Method::POST,
        &format!("/session/{id}/prompt"),
        json!({ "text": "[bench:words 6 5] another" }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    finished(&fleet, &key).await;
    read_through_newest(&fleet, &client, &host, &id, &key).await;
    let read_again = crate::now_ms();
    looking_tx
        .send(vec![Looking {
            device: "settle-mac".into(),
            class: "mac".into(),
            thread: None,
            until: i64::MAX,
        }])
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let watched = fleet.sweep_at(read_again + HOUR + 1000).await.unwrap();
    println!("sweep while looking: {watched:?}");
    assert!(watched.cleared.contains(&key), "{watched:?}");
    assert!(!watched.away);
    let frames = settle_frames(&mut live);
    println!("frames after the watched sweep: {frames:?}");
    assert!(frames.iter().any(|f| {
        f["type"] == "autoCleared"
            && f["keys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k == key.as_str())
    }));

    // tidy the daemon and stop
    let _ = crate::upstream::request(
        &client,
        &host,
        reqwest::Method::DELETE,
        &format!("/session/{id}"),
    )
    .send()
    .await;
    shutdown.cancel();
    let _ = supervisor.await;
    let _ = fleet_task.await;
    drop(fleet);
    drop(store);
    store_thread.join().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}
