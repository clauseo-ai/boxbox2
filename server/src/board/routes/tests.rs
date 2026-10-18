//! the board's routes over the real router and a real fleet actor, with a
//! scripted assistant behind contract 2 (`source/testing.rs`). the server
//! sees every client as loopback here, so `X-Forwarded-For` stands in for
//! the mac each request comes from (`board/addr.rs`).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio_util::sync::CancellationToken;

use crate::board::Board;
use crate::config::BoardConfig;
use crate::fleet::{self, Fleet};
use crate::http::tests::{serve_board, serve_state, sign_in};
use crate::source::AgentSource;
use crate::source::testing::ScriptedSource;
use crate::upstream::Upstreams;
use crate::wire::Capabilities;

const MAC: &str = "100.64.0.7";
const OTHER: &str = "100.64.0.8";

struct World {
    addr: SocketAddr,
    cookie: String,
    source: Arc<ScriptedSource>,
    store: crate::store::Store,
    _shutdown: CancellationToken,
    _looking: watch::Sender<Vec<crate::push::presence::Looking>>,
}

fn real_fleet(
    store: &crate::store::Store,
    shutdown: &CancellationToken,
) -> (Fleet, watch::Sender<Vec<crate::push::presence::Looking>>) {
    let (looking_tx, looking) = watch::channel(Vec::new());
    let (fleet, _task) = fleet::spawn(
        "test".into(),
        fleet::Wiring {
            push: crate::push::Push::detached(),
            telemetry: crate::telemetry::Sender::detached(),
            store: store.clone(),
            looking,
            needs: fleet::needs::Needs::default(),
            reads: fleet::read::Reads::default(),
            clears: fleet::clears::Clears::default(),
            adopted: Vec::new(),
            tails: mpsc::channel(fleet::TAIL_REQUESTS).0,
        },
        shutdown.clone(),
    );
    (fleet, looking_tx)
}

/// the fleet holds `assistant:<id>`, as a source's thread event puts it there.
async fn hold_thread(fleet: &Fleet, id: &str) {
    let info = serde_json::value::RawValue::from_string(format!(
        r#"{{"id":"{id}","slug":"s","projectID":"/w","directory":"/w","title":"t","version":"0","source":"cmx2","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{{"created":1,"updated":2}}}}"#
    ))
    .unwrap();
    let thread = crate::source::cmx2::translate::thread_from_json(info).unwrap();
    fleet
        .upstream()
        .send(fleet::Upstream::Source {
            connection: Arc::from("assistant"),
            agent: Arc::from("assistant"),
            seq: None,
            event: crate::source::SourceEvent::Thread {
                thread: Box::new(thread),
                born: true,
            },
            raw: None,
        })
        .await
        .unwrap();
}

impl World {
    async fn new() -> Self {
        let source = ScriptedSource::new(
            "assistant",
            Capabilities {
                queue: true,
                approvals: true,
                questions: true,
                ..Capabilities::default()
            },
        );
        let (store, _thread, _dir) = crate::store::tests::scratch();
        store
            .call(|c| crate::board::store::ensure(c))
            .await
            .unwrap();
        let shutdown = CancellationToken::new();
        let (fleet, looking) = real_fleet(&store, &shutdown);
        hold_thread(&fleet, "oc_1").await;
        let others: Vec<Arc<dyn AgentSource>> = vec![source.clone()];
        let addr = serve_board(
            Duration::from_secs(1),
            Upstreams::fixed(Vec::new(), others, Vec::new()),
            crate::source::sends::Sends::new(mpsc::channel(1).0),
            crate::media::Media::detached(),
            store.clone(),
            fleet,
            Some(Board::new(BoardConfig {
                machines: Some(vec!["desk".into(), "vm".into()]),
            })),
        )
        .await;
        let cookie = sign_in(addr).await;
        Self {
            addr,
            cookie,
            source,
            store,
            _shutdown: shutdown,
            _looking: looking,
        }
    }

    fn get(&self, path: &str, from: &str) -> reqwest::RequestBuilder {
        reqwest::Client::new()
            .get(format!("http://{}{path}", self.addr))
            .header("cookie", &self.cookie)
            .header("x-forwarded-for", from)
    }

    async fn act(&self, act: serde_json::Value, from: &str) -> (u16, serde_json::Value) {
        post(self.addr, &self.cookie, "/api/board/act", act, from).await
    }
}

async fn post(
    addr: SocketAddr,
    cookie: &str,
    path: &str,
    body: serde_json::Value,
    from: &str,
) -> (u16, serde_json::Value) {
    let answer = reqwest::Client::new()
        .post(format!("http://{addr}{path}"))
        .header("cookie", cookie)
        .header("x-forwarded-for", from)
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .unwrap();
    let status = answer.status().as_u16();
    let text = answer.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(json!(null)))
}

/// reads an sse body until `needle` arrives; everything read so far.
async fn until(response: &mut reqwest::Response, read: &mut String, needle: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !read.contains(needle) {
            let Some(chunk) = response.chunk().await.unwrap() else {
                panic!("the stream ended before {needle}: {read}")
            };
            read.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {needle} in {read}"));
}

async fn board_stream(world: &World, device: &str) -> (reqwest::Response, String) {
    let mut response = world
        .get(
            &format!("/api/board/stream?protocol=1&device={device}&addrs={MAC},fd7a::7"),
            MAC,
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let mut read = String::new();
    until(&mut response, &mut read, r#""type":"view""#).await;
    (response, read)
}

#[tokio::test]
async fn without_a_board_every_board_route_is_404_and_the_flag_is_ignored() {
    let addr = serve_state(
        Duration::from_secs(1),
        Upstreams::fixed(Vec::new(), Vec::new(), Vec::new()),
        crate::source::sends::Sends::new(mpsc::channel(1).0),
        crate::media::Media::detached(),
        crate::store::Store::detached(),
        Fleet::detached(),
    )
    .await;
    let cookie = sign_in(addr).await;
    let stream = reqwest::Client::new()
        .get(format!(
            "http://{addr}/api/board/stream?protocol=1&device=b"
        ))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status(), 404);
    let (status, body) = post(
        addr,
        &cookie,
        "/api/board/act",
        json!({"verb": "gone"}),
        MAC,
    )
    .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (404, Some("not-found"))
    );
    let (status, _) = post(
        addr,
        &cookie,
        "/api/board/pin",
        json!({"key": "desk:s1", "color": [1, 2, 3]}),
        MAC,
    )
    .await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_board_stream_says_hello_then_its_view() {
    let world = World::new().await;
    let (_stream, read) = board_stream(&world, "board-1").await;
    assert!(
        read.starts_with(r#"data: {"type":"hello","protocol":1,"#),
        "{read}"
    );
    assert!(
        read.contains(r#""machines":[{"name":"desk","up":false,"activity":0},{"name":"vm","up":false,"activity":0}]"#),
        "{read}"
    );
    assert!(!read.contains("id:"), "board frames carry no id");
}

#[tokio::test]
async fn a_board_stream_on_another_protocol_or_with_a_bad_device_is_refused() {
    let world = World::new().await;
    let other = world
        .get("/api/board/stream?protocol=2&device=b", MAC)
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), 409);
    let body: serde_json::Value = serde_json::from_str(&other.text().await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "board-protocol");
    let bad = world
        .get("/api/board/stream?protocol=1&device=no%20spaces", MAC)
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
    let addrs = world
        .get(
            "/api/board/stream?protocol=1&device=b&addrs=desk.local",
            MAC,
        )
        .send()
        .await
        .unwrap();
    assert_eq!(addrs.status(), 400);
}

#[tokio::test]
async fn a_second_board_stream_replaces_the_first() {
    let world = World::new().await;
    let (mut first, mut read) = board_stream(&world, "board-1").await;
    let (_second, _) = board_stream(&world, "board-1").await;
    until(&mut first, &mut read, r#"{"type":"replaced"}"#).await;
    assert!(
        first.chunk().await.unwrap().is_none(),
        "the old stream ends"
    );
}

#[tokio::test]
async fn focus_reaches_a_window_on_the_boards_mac_and_never_one_elsewhere() {
    let world = World::new().await;
    let focus = json!({"verb": "focus", "key": "assistant:oc_1"});
    let (status, body) = world.act(focus.clone(), MAC).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("no-board"))
    );

    let (_board, _) = board_stream(&world, "board-1").await;
    let (status, body) = world.act(focus.clone(), MAC).await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("no-board-window")),
        "no window open: the daemon's ok is false"
    );
    let (status, body) = world
        .act(json!({"verb": "focus", "key": "assistant:oc_gone"}), MAC)
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (404, Some("no-such-session")),
        "a thread the fleet does not hold"
    );
    let (status, body) = world
        .act(json!({"verb": "compose", "machine": "laptop"}), MAC)
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (404, Some("no-such-machine")),
        "a machine the board shows no light for"
    );
    let (status, body) = world
        .act(json!({"verb": "compose", "machine": "desk"}), MAC)
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("no-board-window"))
    );

    let mut here = world.get("/api/stream?board=1", MAC).send().await.unwrap();
    let mut here_read = String::new();
    until(
        &mut here,
        &mut here_read,
        r#"{"type":"board.here","seats":[]}"#,
    )
    .await;
    let mut phone = world.get("/api/stream", MAC).send().await.unwrap();
    let mut phone_read = String::new();
    until(&mut phone, &mut phone_read, r#""type":"reset""#).await;
    let mut elsewhere = world
        .get("/api/stream?board=1", OTHER)
        .send()
        .await
        .unwrap();
    let mut elsewhere_read = String::new();
    until(&mut elsewhere, &mut elsewhere_read, r#""type":"reset""#).await;

    let (status, _) = world
        .act(
            json!({"verb": "seats", "seats": [{"key": "assistant:oc_1", "digit": 1, "bound": true}]}),
            MAC,
        )
        .await;
    assert_eq!(status, 204);
    until(
        &mut here,
        &mut here_read,
        r#"{"type":"board.here","seats":[{"key":"assistant:oc_1","digit":1,"bound":true}]}"#,
    )
    .await;
    let (status, _) = world.act(focus, MAC).await;
    assert_eq!(status, 204);
    until(
        &mut here,
        &mut here_read,
        r#"data: {"type":"board.focus","key":"assistant:oc_1"}"#,
    )
    .await;
    assert!(
        here_read.contains("\n\ndata: {\"type\":\"board.focus\""),
        "a board frame has no id line: {here_read}"
    );

    // a heartbeat-free moment for the others: they got nothing of the board
    tokio::time::sleep(Duration::from_millis(100)).await;
    for (stream, read) in [
        (&mut phone, &mut phone_read),
        (&mut elsewhere, &mut elsewhere_read),
    ] {
        while let Ok(Ok(Some(chunk))) =
            tokio::time::timeout(Duration::from_millis(50), stream.chunk()).await
        {
            read.push_str(std::str::from_utf8(&chunk).unwrap());
        }
        assert!(!read.contains("board."), "{read}");
    }
}

#[tokio::test]
async fn gone_drops_the_digits_at_once() {
    let world = World::new().await;
    let (mut board, _) = board_stream(&world, "board-1").await;
    let mut here = world.get("/api/stream?board=1", MAC).send().await.unwrap();
    let mut read = String::new();
    until(&mut here, &mut read, r#""type":"board.here""#).await;
    let (status, _) = world.act(json!({"verb": "gone"}), MAC).await;
    assert_eq!(status, 204);
    until(&mut here, &mut read, r#"{"type":"board.gone"}"#).await;
    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        while board.chunk().await.unwrap().is_some() {}
    })
    .await;
    assert!(ended.is_ok(), "the board's stream ends with its presence");
    let (status, _) = world
        .act(json!({"verb": "compose", "machine": "desk"}), MAC)
        .await;
    assert_eq!(status, 409);
}

#[tokio::test]
async fn bind_keeps_a_digit_pairing_and_refuses_any_other_key() {
    let world = World::new().await;
    let (mut board, mut read) = board_stream(&world, "board-1").await;
    for wire in [0_u8, 7, 14, 16] {
        let (status, body) = world
            .act(
                json!({"verb": "bind", "wire": wire, "key": "assistant:oc_1", "color": [1, 2, 3]}),
                MAC,
            )
            .await;
        assert_eq!(status, 400, "wire {wire}");
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("not a digit key")
        );
    }
    let (status, _) = world
        .act(
            json!({"verb": "bind", "wire": 4, "key": "assistant:oc_1", "color": [1, 2, 3]}),
            MAC,
        )
        .await;
    assert_eq!(status, 204);
    until(
        &mut board,
        &mut read,
        r#""bindings":[{"wire":4,"key":"assistant:oc_1","color":[1,2,3]}]"#,
    )
    .await;
    let kept = world
        .store
        .call(|c| crate::board::store::load(c))
        .await
        .unwrap();
    assert_eq!(kept.len(), 1);
    let (status, _) = world.act(json!({"verb": "unbind", "wire": 4}), MAC).await;
    assert_eq!(status, 204);
    until(&mut board, &mut read, r#""bindings":[]"#).await;
    let (status, _) = world.act(json!({"verb": "unbind", "wire": 3}), MAC).await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn every_verb_needs_a_board_here() {
    let world = World::new().await;
    for act in [
        json!({"verb": "flush", "key": "assistant:oc_1"}),
        json!({"verb": "bind", "wire": 4, "key": "assistant:oc_1", "color": [1, 2, 3]}),
        json!({"verb": "unbind", "wire": 4}),
        json!({"verb": "gone"}),
        json!({"verb": "read", "key": "assistant:oc_1"}),
        json!({"verb": "seats", "seats": []}),
    ] {
        let (status, body) = world.act(act.clone(), MAC).await;
        assert_eq!(
            (status, body["error"]["code"].as_str()),
            (409, Some("no-board")),
            "{act}"
        );
    }
    assert!(world.source.calls().is_empty());
}

#[tokio::test]
async fn flush_stops_the_turn_then_runs_the_queue() {
    let world = World::new().await;
    let (_board, _) = board_stream(&world, "board-1").await;
    let (status, _) = world
        .act(json!({"verb": "flush", "key": "assistant:oc_1"}), MAC)
        .await;
    assert_eq!(status, 204);
    assert_eq!(
        world.source.calls(),
        ["abort assistant:oc_1", "run_now assistant:oc_1"]
    );
}

#[tokio::test]
async fn a_pin_reaches_the_board_and_needs_one_here() {
    let world = World::new().await;
    let pin = json!({"key": "assistant:oc_1", "color": [9, 8, 7]});
    let (status, body) = post(
        world.addr,
        &world.cookie,
        "/api/board/pin",
        pin.clone(),
        OTHER,
    )
    .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (409, Some("no-board"))
    );
    let (mut board, mut read) = board_stream(&world, "board-1").await;
    let (status, _) = post(world.addr, &world.cookie, "/api/board/pin", pin, OTHER).await;
    assert_eq!(status, 204);
    until(
        &mut board,
        &mut read,
        r#"{"type":"pin","key":"assistant:oc_1","color":[9,8,7],"expiresInMs":30000}"#,
    )
    .await;
}

#[tokio::test]
async fn a_reply_to_an_ask_the_fleet_does_not_hold_is_gone() {
    let world = World::new().await;
    let (_board, _) = board_stream(&world, "board-1").await;
    let (status, body) = world
        .act(
            json!({"verb": "reply", "key": "assistant:oc_1", "ask": "que_1", "answer": {"kind": "option", "index": 0}}),
            MAC,
        )
        .await;
    assert_eq!(
        (status, body["error"]["code"].as_str()),
        (404, Some("gone"))
    );
    assert!(world.source.calls().is_empty(), "nothing reached the agent");
}

#[tokio::test]
async fn the_board_routes_are_behind_the_gate() {
    let world = World::new().await;
    let answer = reqwest::Client::new()
        .post(format!("http://{}/api/board/act", world.addr))
        .header("content-type", "application/json")
        .body(json!({"verb": "gone"}).to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), 401);
}
