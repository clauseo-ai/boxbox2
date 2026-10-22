//! contract 2's routes, against a scripted assistant (`source/testing.rs`)
//! and a cmx2 host at an address that answers nothing: how a verb is
//! routed, what is refused before a source is called, and that a send runs
//! at most once whatever the client retries. what a real agent does with a
//! verb is the real loop's (`docs/agents.md`, verification).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::fleet::Upstream;
use crate::http::tests::{serve_state, sign_in};
use crate::source::sends::Sends;
use crate::source::testing::{Scripted, ScriptedSource};
use crate::source::{AgentSource, SendOutcome, SourceEvent};
use crate::upstream::{Reserved, Upstreams};
use crate::wire::{Attachments, Capabilities, MAX_BTW_TEXT, SendStateKind, Voice};

/// an openclaw assistant's capabilities (`agents.md`, section 5).
fn assistant() -> Capabilities {
    Capabilities {
        queue: true,
        model: true,
        approvals: true,
        questions: true,
        attachments: Some(Attachments {
            kinds: vec!["image/*".into(), "audio/*".into()],
            max_bytes: 1024 * 1024,
            max_count: 2,
        }),
        voice: Voice {
            notes: true,
            replies: true,
        },
        quotes: true,
        reactions: true,
        threads: true,
        archive: true,
        fork: true,
        history: true,
        subagents: true,
        origins: true,
        ..Capabilities::default()
    }
}

struct World {
    addr: SocketAddr,
    cookie: String,
    source: Arc<ScriptedSource>,
    events: mpsc::Receiver<Upstream>,
    sends: Sends,
    media: crate::media::Media,
    store: crate::store::Store,
    _dir: Option<std::path::PathBuf>,
}

impl World {
    async fn new(capabilities: Capabilities) -> Self {
        Self::with(capabilities, Duration::from_secs(10), Vec::new(), false).await
    }

    async fn with(
        capabilities: Capabilities,
        answer_within: Duration,
        reserved: Vec<Reserved>,
        stored: bool,
    ) -> Self {
        let source = ScriptedSource::new("assistant", capabilities);
        let (fleet, events) = mpsc::channel(64);
        let sends = Sends::with_timing(fleet, crate::source::sends::RECONCILE, answer_within);
        let (media, store, dir) = if stored {
            let (store, _thread, dir) = crate::store::tests::scratch();
            let (media, _task) = crate::media::Media::open(
                &dir,
                store.clone(),
                crate::media::DEFAULT_MAX_BYTES,
                crate::telemetry::Sender::detached(),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap();
            (media, store, Some(dir))
        } else {
            (
                crate::media::Media::detached(),
                crate::store::Store::detached(),
                None,
            )
        };
        let upstreams = Upstreams::fixed(
            vec![incapable_host()],
            vec![Arc::clone(&source) as Arc<dyn AgentSource>],
            reserved,
        );
        let addr = serve_state(
            Duration::from_secs(1),
            upstreams,
            sends.clone(),
            media.clone(),
            store.clone(),
            crate::fleet::Fleet::listening(),
        )
        .await;
        let cookie = sign_in(addr).await;
        Self {
            addr,
            cookie,
            source,
            events,
            sends,
            media,
            store,
            _dir: dir,
        }
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let mut request = reqwest::Client::new()
            .request(
                method.parse().unwrap(),
                format!("http://{}{path}", self.addr),
            )
            .header("cookie", &self.cookie)
            .header("origin", format!("http://{}", self.addr));
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let answer = request.send().await.unwrap();
        let status = answer.status().as_u16();
        let bytes = answer.bytes().await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn sends_seen(&mut self) -> Vec<(String, SendOutcome)> {
        let mut seen = Vec::new();
        while let Ok(event) = self.events.try_recv() {
            if let Upstream::Source {
                event:
                    SourceEvent::Send {
                        client_id, state, ..
                    },
                ..
            } = event
            {
                seen.push((client_id, state));
            }
        }
        seen
    }
}

/// a cmx2 host whose daemon is not there, beside the assistant.
fn incapable_host() -> crate::upstream::HostView {
    crate::upstream::HostView::detached(
        crate::config::HostConfig {
            name: "desk".into(),
            url: reqwest::Url::parse("http://127.0.0.1:9/").unwrap(),
            credential: None,
            origin: crate::config::Origin::Config,
        },
        Capabilities::cmx2(),
    )
}

fn device() -> Value {
    json!({"device": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "deviceClass": "iphone"})
}

fn with(extra: &Value) -> Value {
    let mut body = device();
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    body
}

fn send(id: &str) -> Value {
    with(&json!({"clientID": id, "text": "hello"}))
}

fn verb() -> Value {
    with(&json!({"clientID": "v-1"}))
}

const T: &str = "/api/agents/assistant/threads/oc_aaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
#[allow(clippy::too_many_lines, reason = "the route table is one list")]
async fn every_cmx2_only_route_answers_422_for_the_assistant_and_nothing_reaches_it() {
    let world = World::new(assistant()).await;
    let routes: Vec<(&str, String, Option<Value>, &str)> = vec![
        ("POST", format!("{T}/steer"), Some(send("s-1")), "steer"),
        ("POST", format!("{T}/compact"), Some(verb()), "compact"),
        (
            "POST",
            format!("{T}/shell"),
            Some(with(&json!({"clientID": "x", "command": "ls"}))),
            "shell",
        ),
        (
            "POST",
            format!("{T}/command"),
            Some(with(&json!({"clientID": "x", "command": "init"}))),
            "commands",
        ),
        (
            "GET",
            "/api/agents/assistant/commands?directory=/w".into(),
            None,
            "commands",
        ),
        (
            "GET",
            "/api/agents/assistant/projects".into(),
            None,
            "places",
        ),
        (
            "GET",
            "/api/agents/assistant/folders?path=/w".into(),
            None,
            "places",
        ),
        (
            "GET",
            "/api/agents/assistant/repo-icon?root=/w/app".into(),
            None,
            "places",
        ),
        (
            "GET",
            "/api/agents/assistant/find/file?query=a".into(),
            None,
            "files",
        ),
        ("GET", format!("{T}/review"), None, "review"),
        (
            "POST",
            format!("{T}/review/merge"),
            Some(json!({})),
            "review",
        ),
        (
            "POST",
            format!("{T}/review/discard"),
            Some(json!({})),
            "review",
        ),
        ("POST", "/api/agents/assistant/reload".into(), None, "admin"),
        (
            "POST",
            "/api/agents/assistant/restart".into(),
            None,
            "admin",
        ),
        ("GET", "/api/agents/assistant/pty".into(), None, "terminal"),
        (
            "GET",
            "/api/agents/assistant/pty/shells".into(),
            None,
            "terminal",
        ),
        (
            "GET",
            "/api/agents/assistant/pty/pty_1".into(),
            None,
            "terminal",
        ),
        (
            "POST",
            "/api/agents/assistant/threads".into(),
            Some(with(
                &json!({"clientID": "b-1", "text": "hi", "place": "/w/app"}),
            )),
            "places",
        ),
    ];
    for (method, path, body, capability) in routes {
        let (status, answer) = world.call(method, &path, body).await;
        assert_eq!(status, 422, "{method} {path}: {answer}");
        assert_eq!(answer["error"], "unsupported", "{method} {path}: {answer}");
        assert_eq!(
            answer["capability"], capability,
            "{method} {path}: {answer}"
        );
        assert!(
            answer["message"]
                .as_str()
                .unwrap()
                .starts_with("assistant · openclaw · vm-b has no "),
            "{answer}"
        );
    }
    assert_eq!(world.source.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn an_agent_with_none_of_the_gated_capabilities_refuses_every_gated_verb_first() {
    let world = World::new(Capabilities::default()).await;
    let quoted = with(&json!({"clientID": "q", "text": "yes", "quote": "mZW50cnktMQ"}));
    let attached =
        with(&json!({"clientID": "a", "text": "see", "attachments": [{"media": "a".repeat(64)}]}));
    let routes: Vec<(&str, String, Option<Value>, &str)> = vec![
        ("POST", format!("{T}/prompt"), Some(quoted), "quotes"),
        ("POST", format!("{T}/prompt"), Some(attached), "attachments"),
        ("POST", format!("{T}/queue"), Some(send("q-1")), "queue"),
        ("POST", format!("{T}/run-now"), Some(verb()), "queue"),
        ("DELETE", format!("{T}/messages/mZW50cnktMQ"), None, "queue"),
        (
            "PUT",
            format!("{T}/messages/mZW50cnktMQ/reactions"),
            Some(with(&json!({"clientID": "r", "emoji": "👍", "on": true}))),
            "reactions",
        ),
        ("POST", format!("{T}/archive"), Some(verb()), "archive"),
        ("POST", format!("{T}/fork"), Some(verb()), "fork"),
        ("POST", format!("{T}/adopt"), Some(verb()), "history"),
        ("GET", "/api/agents/assistant/models".into(), None, "model"),
        (
            "POST",
            "/api/agents/assistant/asks/per_1".into(),
            Some(with(&json!({"clientID": "k", "option": "once"}))),
            "approvals",
        ),
        (
            "POST",
            "/api/agents/assistant/asks/que_1".into(),
            Some(with(&json!({"clientID": "k", "answers": [["yes"]]}))),
            "questions",
        ),
        (
            "POST",
            "/api/agents/assistant/threads".into(),
            Some(send("b-1")),
            "threads",
        ),
        (
            "POST",
            format!("{T}/btw"),
            Some(with(&json!({"clientID": "w", "question": "why"}))),
            "btw",
        ),
        ("GET", format!("{T}/btw"), None, "btw"),
        (
            "POST",
            format!("{T}/btw/btw_1/dismiss"),
            Some(device()),
            "btw",
        ),
        (
            "POST",
            format!("{T}/btw/btw_1/promote"),
            Some(device()),
            "btw",
        ),
    ];
    for (method, path, body, capability) in routes {
        let (status, answer) = world.call(method, &path, body).await;
        assert_eq!(status, 422, "{method} {path}: {answer}");
        assert_eq!(
            answer["capability"], capability,
            "{method} {path}: {answer}"
        );
    }
    assert_eq!(world.source.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn the_btw_verbs_reach_the_source_through_the_trait_and_a_bad_question_never_does() {
    let world = World::new(Capabilities {
        btw: true,
        ..assistant()
    })
    .await;
    let (status, asked) = world
        .call(
            "POST",
            &format!("{T}/btw"),
            Some(with(
                &json!({"clientID": "w-1", "question": "why this way?"}),
            )),
        )
        .await;
    assert_eq!(status, 200, "{asked}");
    assert_eq!(asked["question"], "why this way?");
    assert_eq!(asked["status"], "running");
    assert!(
        asked.get("dismissed").is_none(),
        "absent fields are omitted: {asked}"
    );
    let (status, listed) = world.call("GET", &format!("{T}/btw"), None).await;
    assert_eq!(status, 200);
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    let (status, dismissed) = world
        .call("POST", &format!("{T}/btw/btw_1/dismiss"), Some(device()))
        .await;
    assert_eq!(status, 200);
    assert_eq!(dismissed["dismissed"], 2.0);
    let (status, promoted) = world
        .call("POST", &format!("{T}/btw/btw_1/promote"), Some(device()))
        .await;
    assert_eq!(status, 200);
    assert_eq!(promoted, json!({"messageID": "msg_promoted"}));
    // refused before the source: empty, too long, a body with a stray field, a bad btw id
    let refused: Vec<(String, Value)> = vec![
        (
            format!("{T}/btw"),
            with(&json!({"clientID": "w-2", "question": "  "})),
        ),
        (
            format!("{T}/btw"),
            with(&json!({"clientID": "w-3", "question": "x".repeat(MAX_BTW_TEXT + 1)})),
        ),
        (format!("{T}/btw/btw_1/dismiss"), verb()),
        (format!("{T}/btw/no.such/promote"), device()),
    ];
    for (path, body) in refused {
        let (status, answer) = world.call("POST", &path, Some(body)).await;
        assert!(status == 400 || status == 422, "{path}: {status} {answer}");
    }
    let key = "assistant:oc_aaaaaaaaaaaaaaaaaaaaaaaa";
    assert_eq!(
        world.source.calls(),
        vec![
            format!("btw_ask {key} w-1"),
            format!("btws {key}"),
            format!("btw_dismiss {key} btw_1"),
            format!("btw_promote {key} btw_1"),
        ]
    );
}

#[tokio::test]
async fn the_assistants_verbs_reach_its_source_through_the_trait() {
    let world = World::new(assistant()).await;
    let checks: Vec<(&str, String, Option<Value>, u16)> = vec![
        ("POST", format!("{T}/prompt"), Some(send("p-1")), 202),
        ("POST", format!("{T}/queue"), Some(send("q-1")), 202),
        ("POST", format!("{T}/abort"), Some(verb()), 204),
        ("POST", format!("{T}/run-now"), Some(verb()), 204),
        ("DELETE", format!("{T}/messages/mZW50cnktMQ"), None, 204),
        (
            "PUT",
            format!("{T}/messages/mZW50cnktMQ/reactions"),
            Some(with(&json!({"clientID": "r", "emoji": "👍", "on": true}))),
            204,
        ),
        ("POST", format!("{T}/archive"), Some(verb()), 200),
        ("GET", "/api/agents/assistant/models".into(), None, 200),
        (
            "POST",
            "/api/agents/assistant/asks/per_1".into(),
            Some(with(&json!({"clientID": "k", "option": "once"}))),
            204,
        ),
        (
            "POST",
            "/api/agents/assistant/asks/que_1".into(),
            Some(with(&json!({"clientID": "k2", "reject": true}))),
            204,
        ),
        (
            "POST",
            "/api/agents/assistant/threads".into(),
            Some(send("born-1")),
            201,
        ),
    ];
    for (method, path, body, expected) in checks {
        let (status, answer) = world.call(method, &path, body).await;
        assert_eq!(status, expected, "{method} {path}: {answer}");
    }
    let key = "assistant:oc_aaaaaaaaaaaaaaaaaaaaaaaa";
    assert_eq!(
        world.source.calls(),
        vec![
            format!("prompt {key}"),
            format!("queue {key}"),
            format!("abort {key}"),
            format!("run_now {key}"),
            format!("unsend {key} mZW50cnktMQ"),
            format!("react {key} mZW50cnktMQ 👍 true"),
            format!("archive {key}"),
            "catalog assistant".to_owned(),
            "answer assistant:per_1".to_owned(),
            "answer assistant:que_1".to_owned(),
            "start assistant".to_owned(),
        ]
    );
    // the agents screen lists both agents with their identity
    let (status, agents) = world.call("GET", "/api/agents", None).await;
    assert_eq!(status, 200);
    let keys: Vec<&str> = agents
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["desk", "assistant"]);
    assert_eq!(agents[0]["mark"], "square");
    assert_eq!(agents[0]["palette"], Value::Null);
    assert_eq!(agents[1]["mark"], "round");
    assert_eq!(agents[1]["label"]["name"], "assistant");
    assert!(agents[1]["palette"].is_string());
    assert_eq!(agents[1]["connection"]["name"], "vm-b");
}

#[tokio::test]
async fn a_fork_reaches_the_source_whole_or_cut_and_answers_the_new_thread() {
    let world = World::new(assistant()).await;
    let (status, whole) = world.call("POST", &format!("{T}/fork"), Some(verb())).await;
    assert_eq!(status, 201, "{whole}");
    assert_eq!(whole["key"], "assistant:oc_forked");
    assert_eq!(whole["thread"], "oc_forked");
    let cut = with(&json!({"clientID": "f-2", "before": "mZW50cnktMQ"}));
    let (status, _) = world.call("POST", &format!("{T}/fork"), Some(cut)).await;
    assert_eq!(status, 201);
    // a turn the agent no longer has is said as one, not as a thread that is gone
    let gone = with(&json!({"clientID": "f-3", "before": "mGONE"}));
    let (status, answer) = world.call("POST", &format!("{T}/fork"), Some(gone)).await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (404, Some("no-such-turn"))
    );
    // history the agent keeps to read only is 409 browse-only, never 422 (that is a missing capability)
    let imported = with(&json!({"clientID": "f-6", "before": "mIMPORTED"}));
    let (status, answer) = world
        .call("POST", &format!("{T}/fork"), Some(imported))
        .await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (409, Some("browse-only")),
        "{answer}"
    );
    // a fork taken and not answered may exist: 502 agent-uncertain, which says a retry is safe
    let slow = with(&json!({"clientID": "f-7", "before": "mSLOW"}));
    let (status, answer) = world.call("POST", &format!("{T}/fork"), Some(slow)).await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (502, Some("agent-uncertain")),
        "{answer}"
    );
    // the route's client id reaches the source, for the agent's once rule
    let key = "assistant:oc_aaaaaaaaaaaaaaaaaaaaaaaa";
    assert_eq!(
        world.source.calls(),
        vec![
            format!("fork {key} whole v-1"),
            format!("fork {key} mZW50cnktMQ f-2"),
            format!("fork {key} mGONE f-3"),
            format!("fork {key} mIMPORTED f-6"),
            format!("fork {key} mSLOW f-7"),
        ]
    );
    // a cut that is not a message id, or a field no fork takes, is refused before the source hears it
    for body in [
        json!({"clientID": "f-4", "before": "../x"}),
        json!({"clientID": "f-5", "at": 3}),
    ] {
        let (status, answer) = world
            .call("POST", &format!("{T}/fork"), Some(with(&body)))
            .await;
        assert!(status == 400 || status == 422, "{status} {answer}");
    }
    assert_eq!(world.source.calls().len(), 5);
}

#[tokio::test]
async fn an_unknown_agent_is_404_and_a_bad_body_is_400_before_any_call() {
    let world = World::new(assistant()).await;
    let (status, answer) = world
        .call(
            "POST",
            "/api/agents/nobody/threads/oc_a/prompt",
            Some(send("p-1")),
        )
        .await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (404, Some("no-such-agent"))
    );
    let (status, _) = world
        .call(
            "POST",
            &format!("{T}/prompt"),
            Some(with(&json!({"clientID": "e", "text": "  "}))),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = world
        .call(
            "POST",
            "/api/agents/assistant/threads/a.b/prompt",
            Some(send("p-2")),
        )
        .await;
    assert_eq!(status, 400);
    assert!(world.source.calls().is_empty());
}

#[tokio::test]
async fn an_accepted_send_retried_with_its_client_id_is_answered_and_never_sent_twice() {
    let world = World::new(assistant()).await;
    for _ in 0..3 {
        let (status, answer) = world
            .call("POST", &format!("{T}/prompt"), Some(send("once-1")))
            .await;
        assert_eq!(
            (status, answer["state"].as_str()),
            (202, Some("accepted")),
            "{answer}"
        );
    }
    assert_eq!(world.source.calls().len(), 1);
}

#[tokio::test]
async fn two_requests_with_one_client_id_at_once_make_one_call_and_share_its_answer() {
    let world = World::new(assistant()).await;
    world.source.script([Scripted::Slow(
        Duration::from_millis(300),
        Box::new(Scripted::Accept),
    )]);
    let path = format!("{T}/prompt");
    let (first, second) = tokio::join!(
        world.call("POST", &path, Some(send("twin"))),
        world.call("POST", &path, Some(send("twin")))
    );
    assert_eq!(first.0, 202);
    assert_eq!(second.0, 202);
    assert_eq!(first.1, second.1);
    assert_eq!(world.source.calls().len(), 1);
}

#[tokio::test]
async fn a_lost_acknowledgement_answers_checking_and_ends_not_confirmed_never_twice() {
    let mut world = World::new(assistant()).await;
    world.source.script([Scripted::LostAck]);
    let path = format!("{T}/prompt");
    let (status, answer) = world.call("POST", &path, Some(send("lost-1"))).await;
    assert_eq!((status, answer["state"].as_str()), (202, Some("checking")));
    // the outbox retries: still checking, nothing sent again
    let (status, answer) = world.call("POST", &path, Some(send("lost-1"))).await;
    assert_eq!((status, answer["state"].as_str()), (202, Some("checking")));
    // the source reads no receipt: uncertain. a retry is refused, never resent
    world.sends.resolve(
        &Arc::from("assistant"),
        "lost-1",
        SendOutcome::Pending(SendStateKind::Uncertain),
    );
    let (status, answer) = world.call("POST", &path, Some(send("lost-1"))).await;
    assert_eq!(status, 409, "{answer}");
    assert_eq!(answer["error"]["code"], "not-confirmed");
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("not confirmed: assistant may not have this"),
        "{answer}"
    );
    assert_eq!(world.source.calls().len(), 1);
    // sending again is the person's call, with a new client id
    let (status, _) = world.call("POST", &path, Some(send("lost-2"))).await;
    assert_eq!(status, 202);
    assert_eq!(world.source.calls().len(), 2);
    assert!(
        world.sends_seen().is_empty(),
        "the source owns these events"
    );
}

#[tokio::test]
async fn a_send_with_no_answer_in_time_answers_checking_and_a_lost_one_ends_uncertain() {
    let mut world = World::with(assistant(), Duration::from_millis(150), Vec::new(), false).await;
    world.source.script([Scripted::Slow(
        Duration::from_millis(500),
        Box::new(Scripted::Unreachable),
    )]);
    let path = format!("{T}/prompt");
    let (status, answer) = world.call("POST", &path, Some(send("slow-1"))).await;
    assert_eq!((status, answer["state"].as_str()), (202, Some("checking")));
    let (status, answer) = world.call("POST", &path, Some(send("slow-1"))).await;
    assert_eq!((status, answer["state"].as_str()), (202, Some("checking")));
    tokio::time::sleep(Duration::from_millis(600)).await;
    let (status, answer) = world.call("POST", &path, Some(send("slow-1"))).await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (409, Some("not-confirmed"))
    );
    assert_eq!(world.source.calls().len(), 1, "never sent twice");
    assert_eq!(
        world.sends_seen(),
        vec![
            (
                "slow-1".to_owned(),
                SendOutcome::Pending(SendStateKind::Checking)
            ),
            (
                "slow-1".to_owned(),
                SendOutcome::Pending(SendStateKind::Uncertain)
            ),
        ]
    );
    // a slow answer that does land is accepted for every retry after it
    world.source.script([Scripted::Slow(
        Duration::from_millis(300),
        Box::new(Scripted::Accept),
    )]);
    let (_, answer) = world.call("POST", &path, Some(send("slow-2"))).await;
    assert_eq!(answer["state"], "checking");
    tokio::time::sleep(Duration::from_millis(400)).await;
    let (status, answer) = world.call("POST", &path, Some(send("slow-2"))).await;
    assert_eq!((status, answer["state"].as_str()), (202, Some("accepted")));
    assert_eq!(world.source.calls().len(), 2);
}

#[tokio::test]
async fn a_refusal_reaches_nothing_so_the_retry_is_sent() {
    let world = World::new(assistant()).await;
    world.source.script([Scripted::Refuse]);
    let path = format!("{T}/prompt");
    let (status, answer) = world.call("POST", &path, Some(send("r-1"))).await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (422, Some("host-said"))
    );
    let (status, _) = world.call("POST", &path, Some(send("r-1"))).await;
    assert_eq!(status, 202);
    assert_eq!(world.source.calls().len(), 2);
}

#[tokio::test]
async fn a_stale_generation_is_409_with_the_agents_name() {
    let world = World::new(assistant()).await;
    let body = with(&json!({"clientID": "g-1", "text": "hi", "generation": "g0"}));
    let (status, answer) = world.call("POST", &format!("{T}/prompt"), Some(body)).await;
    assert_eq!(status, 409);
    assert_eq!(answer["error"]["code"], "generation-changed");
    assert_eq!(
        answer["error"]["message"],
        "the conversation on assistant changed; review and send again"
    );
    // the generation it is at goes through
    let body = with(&json!({"clientID": "g-2", "text": "hi", "generation": "g1"}));
    let (status, _) = world.call("POST", &format!("{T}/prompt"), Some(body)).await;
    assert_eq!(status, 202);
}

#[tokio::test]
async fn a_new_thread_retried_answers_the_first_thread_and_starts_one() {
    let world = World::new(assistant()).await;
    let (status, first) = world
        .call(
            "POST",
            "/api/agents/assistant/threads",
            Some(send("birth-1")),
        )
        .await;
    assert_eq!(status, 201, "{first}");
    let (status, again) = world
        .call(
            "POST",
            "/api/agents/assistant/threads",
            Some(send("birth-1")),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(first, again);
    assert_eq!(world.source.calls(), vec!["start assistant".to_owned()]);
}

#[tokio::test]
async fn attachments_are_checked_against_the_capability_and_a_transcript_is_kept() {
    let world = World::with(assistant(), Duration::from_secs(10), Vec::new(), true).await;
    let upload = |bytes: Vec<u8>, mime: &'static str| {
        let media = world.media.clone();
        async move {
            let body = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                bytes::Bytes::from(bytes),
            )]);
            media
                .upload(
                    body,
                    crate::media::Declared {
                        mime: mime.into(),
                        ..crate::media::Declared::default()
                    },
                )
                .await
                .unwrap()
                .object
                .id
        }
    };
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.resize(2048, 7);
    let image = upload(png, "image/png").await;
    let pdf = upload(b"%PDF-1.4\n%%EOF\n".to_vec(), "application/pdf").await;
    let mut ogg = b"OggS".to_vec();
    ogg.resize(512, 1);
    let note = upload(ogg, "audio/ogg").await;
    let path = format!("{T}/prompt");
    let attach =
        |id: &str, list: Value| with(&json!({"clientID": id, "text": "", "attachments": list}));
    let (status, answer) = world
        .call("POST", &path, Some(attach("k-1", json!([{"media": pdf}]))))
        .await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (415, Some("attachment-kind")),
        "{answer}"
    );
    let three = json!([{"media": image}, {"media": image}, {"media": image}]);
    let (status, answer) = world.call("POST", &path, Some(attach("k-2", three))).await;
    assert_eq!(
        (status, answer["error"]["code"].as_str()),
        (413, Some("attachment-too-large"))
    );
    let (status, _) = world
        .call(
            "POST",
            &path,
            Some(attach(
                "k-3",
                json!([{"media": image, "transcript": {"text": "no"}}]),
            )),
        )
        .await;
    assert_eq!(status, 400, "a transcript belongs to audio");
    assert!(world.source.calls().is_empty());
    let voice = json!([{"media": note, "transcript": {"text": "call me back", "lang": "en"}}]);
    let (status, answer) = world.call("POST", &path, Some(attach("k-4", voice))).await;
    assert_eq!(status, 202, "{answer}");
    let kept = world
        .media
        .sidecars(
            std::slice::from_ref(&note),
            "assistant:oc_aaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await
        .unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].transcript, "call me back");
    assert_eq!(world.source.calls().len(), 1);
}

#[tokio::test]
async fn pairing_refuses_a_name_a_configured_assistant_connection_holds() {
    let reserved = crate::upstream::reserved(&[crate::source::ConnectionConfig::Openclaw(
        crate::source::OpenclawConfig {
            name: "vm-b".into(),
            url: reqwest::Url::parse("ws://127.0.0.1:9").unwrap(),
            token_file: "/tmp/t".into(),
            device_key: None,
            mode: crate::source::OpenclawMode::Full,
            machine: None,
            agents: [(
                "main".to_owned(),
                crate::source::AgentOverride {
                    key: Some("helper".into()),
                    ..Default::default()
                },
            )]
            .into_iter()
            .collect(),
            origin: crate::config::Origin::Config,
        },
    )]);
    let world = World::with(assistant(), Duration::from_secs(10), reserved, true).await;
    for (name, holder) in [
        ("vm-b", "[[openclaw]] \"vm-b\""),
        (
            "helper",
            "the key of agent \"main\" on [[openclaw]] \"vm-b\"",
        ),
    ] {
        let body = json!({"url": "http://127.0.0.1:19", "token": "t0k3n", "name": name});
        let (status, answer) = world.call("POST", "/api/hosts/pair", Some(body)).await;
        assert_eq!(status, 409, "{answer}");
        assert_eq!(answer["error"]["code"], "name-reserved");
        assert_eq!(
            answer["error"]["message"],
            format!("{name} is already {holder}; pick another name")
        );
    }
    // a key an agent already holds is refused too, through contract 2's pairing
    world
        .store
        .claim_agent_key("vm-b", "main", "vm-b-main")
        .await
        .unwrap();
    let body = json!({"source": "cmx2", "url": "http://127.0.0.1:19", "token": "t0k3n", "name": "vm-b-main"});
    let (status, answer) = world
        .call("POST", "/api/connections/pair", Some(body))
        .await;
    assert_eq!(status, 409, "{answer}");
    assert_eq!(
        answer["error"]["message"],
        "vm-b-main is already the key of an agent on vm-b; pick another name or pin that agent's key"
    );
    // other runtimes pair their own way
    let body =
        json!({"source": "openclaw", "url": "ws://127.0.0.1:9", "token": "t", "name": "vm-c"});
    let (status, _) = world
        .call("POST", "/api/connections/pair", Some(body))
        .await;
    assert_eq!(status, 501);
}
