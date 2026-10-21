//! the board's projection: what rides a view and in what order (parity with
//! the app's home windows), the need mapping, `fresh` and activity, the
//! coalescing, the unchanged picture that is not sent, and that nothing
//! exists without a board stream.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use boxbox_board_wire::{Ask, AskKind, Binding, Need, View};
use serde_json::Value;

use super::*;
use crate::cmx2::decode_frame;
use crate::fleet::model::{Device, Model};
use crate::source::cmx2::translate;

const HOUR: i64 = 60 * 60 * 1000;
/// a clock far from zero, so "13 hours ago" is still a positive stamp.
const NOW: i64 = 1_000 * HOUR;

#[derive(Debug)]
struct Fixed(Vec<AgentLight>);

impl Roster for Fixed {
    fn agents(&self) -> Vec<AgentLight> {
        self.0.clone()
    }
}

/// the monotonic instant the tests' wall clock `NOW` stands for.
fn base() -> Instant {
    static BASE: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *BASE.get_or_init(Instant::now)
}

/// the monotonic instant for a wall time at or after `NOW`.
fn at(wall: i64) -> Instant {
    base() + Duration::from_millis(u64::try_from(wall - NOW).unwrap())
}

fn clock(wall: i64) -> Clock {
    Clock { at: at(wall), wall }
}

fn roster() -> Arc<dyn Roster> {
    Arc::new(Fixed(vec![
        AgentLight {
            key: "desk".into(),
            machine: "desk".into(),
            up: true,
        },
        AgentLight {
            key: "vm-main".into(),
            machine: "vm".into(),
            up: false,
        },
    ]))
}

fn wanted(bindings: Vec<Binding>) -> Wanted {
    Wanted {
        machines: None,
        bindings,
        roster: roster(),
    }
}

/// one cmx2 event payload, through the translation, into the model.
fn event(model: &mut Model, payload: &str) -> Vec<Change> {
    let decoded = decode_frame(&format!(r#"{{"payload":{payload}}}"#)).unwrap();
    let Some(event) = translate::event(
        "desk",
        decoded.directory.as_deref(),
        &decoded.event,
        &decoded.payload,
    )
    .unwrap() else {
        return Vec::new();
    };
    model.source("desk", None, event)
}

fn updated(model: &mut Model, id: &str, at: i64, parent: Option<&str>) {
    let parent = parent.map_or(String::new(), |p| format!(r#""parentID":"{p}","#));
    event(
        model,
        &format!(
            r#"{{"id":"e","type":"session.updated","properties":{{"sessionID":"{id}","info":{{"id":"{id}",{parent}"slug":"s","projectID":"/w","directory":"/w","title":"t {id}","version":"0","source":"cmx2","cost":0,"tokens":{{"input":0,"output":0,"reasoning":0,"cache":{{"read":0,"write":0}}}},"time":{{"created":1,"updated":{at}}}}}}}}}"#
        ),
    );
}

fn busy(model: &mut Model, id: &str) {
    event(
        model,
        &format!(
            r#"{{"id":"e","type":"session.status","properties":{{"sessionID":"{id}","status":{{"type":"busy","since":5}}}}}}"#
        ),
    );
}

fn idle(model: &mut Model, id: &str) {
    event(
        model,
        &format!(r#"{{"id":"e","type":"session.idle","properties":{{"sessionID":"{id}"}}}}"#),
    );
}

fn replied(model: &mut Model, id: &str, message: &str) {
    event(
        model,
        &format!(
            r#"{{"id":"e","type":"message.updated","properties":{{"sessionID":"{id}","info":{{"id":"{message}","sessionID":"{id}","role":"assistant","time":{{"created":100,"completed":200}},"finish":"stop"}}}}}}"#
        ),
    );
}

fn permission(model: &mut Model, id: &str, ask: &str) {
    event(
        model,
        &format!(
            r#"{{"id":"e","type":"permission.asked","properties":{{"id":"{ask}","sessionID":"{id}","permission":"shell","patterns":["make"],"metadata":{{}},"always":[]}}}}"#
        ),
    );
}

fn question(model: &mut Model, id: &str, ask: &str, questions: &[usize]) {
    let questions: Vec<String> = questions
        .iter()
        .map(|options| {
            let options: Vec<String> = (0..*options)
                .map(|n| format!(r#"{{"label":"option {n}","description":"d"}}"#))
                .collect();
            format!(
                r#"{{"question":"which?","header":"h","options":[{}]}}"#,
                options.join(",")
            )
        })
        .collect();
    event(
        model,
        &format!(
            r#"{{"id":"e","type":"question.asked","properties":{{"id":"{ask}","sessionID":"{id}","questions":[{}]}}}}"#,
            questions.join(",")
        ),
    );
}

fn delta(id: &str) -> Change {
    Change::Delta {
        key: format!("desk:{id}"),
        message_id: "msg_1".into(),
        part_id: "prt_1".into(),
        field: "text".into(),
        delta: "x".into(),
        offset: 0,
    }
}

fn view_of(receiver: &watch::Receiver<Bytes>) -> View {
    let frame = receiver.borrow().clone();
    let text = std::str::from_utf8(&frame).unwrap();
    let json = text.strip_prefix("data: ").unwrap().trim_end();
    let Frame::View(view) = serde_json::from_str(json).unwrap() else {
        panic!("not a view: {text}")
    };
    view
}

fn keys(view: &View) -> Vec<&str> {
    view.threads.iter().map(|t| t.key.as_str()).collect()
}

/// a fleet with a thread for every case the home windows rule decides.
fn fleet() -> Model {
    let mut model = Model::new();
    model.at(NOW);
    updated(&mut model, "recent", NOW - 1000, None);
    updated(&mut model, "old", NOW - 13 * HOUR, None);
    updated(&mut model, "old-busy", NOW - 13 * HOUR, None);
    busy(&mut model, "old-busy");
    updated(&mut model, "old-asking", NOW - 13 * HOUR, None);
    permission(&mut model, "old-asking", "per_1");
    updated(&mut model, "child", NOW - 1000, Some("old-busy"));
    busy(&mut model, "child");
    updated(&mut model, "cleared", NOW - 2000, None);
    let (_, answers) = model.clear(
        &["desk:cleared".into()],
        &Device {
            id: "phone".into(),
            class: "iphone".into(),
        },
    );
    assert!(answers[0].1.is_ok());
    updated(&mut model, "done", NOW - 3000, None);
    busy(&mut model, "done");
    replied(&mut model, "done", "msg_d");
    idle(&mut model, "done");
    model
}

/// `windowKeys` (`app/src/ui/home/membership.ts`) over the fleet as the
/// app receives it: in the order, not a subagent, not cleared, and active
/// (a status or an ask) or touched in the last 12 hours.
fn window_keys(snapshot: &Value, now: i64) -> Vec<String> {
    let asking: HashSet<&str> = snapshot["asks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["key"].as_str().unwrap())
        .collect();
    let mut keys = Vec::new();
    for key in snapshot["order"].as_array().unwrap() {
        let key = key.as_str().unwrap();
        let Some(thread) = snapshot["threads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == key)
        else {
            continue;
        };
        if !thread["parent"].is_null() || !thread["cleared"].is_null() {
            continue;
        }
        let active = thread["activity"]["state"] != "idle" || asking.contains(key);
        #[allow(clippy::cast_precision_loss)]
        let recent =
            (now as f64) - thread["updated"].as_f64().unwrap() < 12.0 * 60.0 * 60.0 * 1000.0;
        if active || recent {
            keys.push(key.to_owned());
        }
    }
    keys
}

/// the fields `windowKeys` reads, in the app's store shape (sessions and
/// asks by key), for the app's own test of the same cases. the app reads a
/// status only for whether it is null, so a thread that is not idle carries
/// its activity there.
fn app_fleet(snapshot: &Value) -> Value {
    let sessions: serde_json::Map<String, Value> = snapshot["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let mut info = serde_json::json!({ "time": { "updated": s["updated"] } });
            if !s["parent"].is_null() {
                info["parentID"] = s["parent"].clone();
            }
            let status = if s["activity"]["state"] == "idle" {
                Value::Null
            } else {
                s["activity"].clone()
            };
            let mut entry = serde_json::json!({ "info": info, "status": status });
            if !s["cleared"].is_null() {
                entry["cleared"] = s["cleared"].clone();
            }
            (s["key"].as_str().unwrap().to_owned(), entry)
        })
        .collect();
    let asks: serde_json::Map<String, Value> = snapshot["asks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                format!(
                    "{}:{}",
                    a["agent"].as_str().unwrap(),
                    a["id"].as_str().unwrap()
                ),
                serde_json::json!({ "key": a["key"] }),
            )
        })
        .collect();
    serde_json::json!({ "order": snapshot["order"], "sessions": sessions, "asks": asks })
}

const WINDOWS_FIXTURE: &str = "src/fleet/board/windows.json";

#[test]
fn the_board_sees_the_home_windows_the_app_sees_in_the_same_order() {
    let model = fleet();
    let snapshot = serde_json::to_value(model.snapshot()).unwrap();
    let windows = window_keys(&snapshot, NOW);
    let rows = model.board_rows(&HashSet::new());
    let board: Vec<&str> = rows
        .iter()
        .filter(|r| r.window)
        .map(|r| r.thread.key.as_str())
        .collect();
    assert_eq!(board, windows);
    assert_eq!(
        windows,
        [
            "desk:old-asking",
            "desk:done",
            "desk:old-busy",
            "desk:recent"
        ],
        "no subagent, no cleared thread, nothing quiet past 12 hours"
    );

    // the same cases, for the app's test of windowKeys (app/src/ui/home)
    let fixture =
        serde_json::json!({ "now": NOW, "fleet": app_fleet(&snapshot), "windows": windows });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(WINDOWS_FIXTURE);
    if std::env::var_os("BOXBOX_BLESS").is_some() {
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&fixture).unwrap() + "\n",
        )
        .unwrap();
    }
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        kept, fixture,
        "{WINDOWS_FIXTURE} drifted: BOXBOX_BLESS=1 cargo test rewrites it"
    );
}

#[test]
fn a_view_carries_the_windows_that_need_you_or_work_and_every_bound_thread() {
    let model = fleet();
    let bound = vec![Binding {
        wire: 4,
        key: "desk:old".into(),
        color: [1, 2, 3],
    }];
    let (_projection, receiver) = Projection::start(wanted(bound.clone()), &model, clock(NOW));
    let view = view_of(&receiver);
    assert_eq!(
        keys(&view),
        ["desk:old-asking", "desk:done", "desk:old-busy", "desk:old"],
        "the quiet recent window stays off; the bound quiet thread rides"
    );
    assert_eq!(view.bindings, bound);
    assert_eq!(
        view.machines
            .iter()
            .map(|m| (m.name.as_str(), m.up, m.activity))
            .collect::<Vec<_>>(),
        [("desk", true, 0), ("vm", false, 0)],
        "the roster's order, up when an agent is connected"
    );
}

#[test]
fn needs_map_to_the_boards_five_and_carry_their_age() {
    let mut model = Model::new();
    model.at(NOW - 5000);
    updated(&mut model, "perm", NOW, None);
    permission(&mut model, "perm", "per_1");
    updated(&mut model, "one", NOW, None);
    question(&mut model, "one", "que_1", &[3]);
    updated(&mut model, "ten", NOW, None);
    question(&mut model, "ten", "que_2", &[10]);
    updated(&mut model, "two", NOW, None);
    question(&mut model, "two", "que_3", &[2, 2]);
    updated(&mut model, "done", NOW, None);
    busy(&mut model, "done");
    replied(&mut model, "done", "msg_d");
    idle(&mut model, "done");
    model.at(NOW);
    let (_projection, receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    let view = view_of(&receiver);
    let thread = |key: &str| {
        view.threads
            .iter()
            .find(|t| t.key == format!("desk:{key}"))
            .unwrap()
    };
    assert_eq!(thread("perm").need, Some(Need::Permission));
    assert_eq!(
        thread("perm").ask,
        Some(Ask {
            id: "per_1".into(),
            kind: AskKind::Permission,
            options: Vec::new()
        })
    );
    assert_eq!(
        thread("perm").waiting_ms,
        Some(5000),
        "raised 5 s before the frame"
    );
    assert_eq!(thread("one").need, Some(Need::Question));
    assert_eq!(
        thread("one").ask.as_ref().unwrap().options,
        ["option 0", "option 1", "option 2"]
    );
    assert!(
        thread("ten").ask.as_ref().unwrap().options.is_empty(),
        "more options than digits: answered by voice or on the glass"
    );
    assert!(
        thread("two").ask.as_ref().unwrap().options.is_empty(),
        "several questions"
    );
    assert_eq!(thread("done").need, Some(Need::News));
    assert_eq!(thread("done").ask, None);
    assert_eq!(thread("done").title.as_deref(), Some("t done"));
}

/// plays deltas at `deltas` (ms after `NOW`) and the actor's clock, ms by
/// ms, from `from` to `until`: each due build runs at its due ms. the ms
/// each build that sent a view ran at.
fn play(
    projection: &mut Projection,
    model: &Model,
    deltas: &[i64],
    from: i64,
    until: i64,
) -> Vec<i64> {
    let mut sent = Vec::new();
    for ms in from..=until {
        if deltas.contains(&ms) {
            projection.saw(&delta("s1"), at(NOW + ms));
        }
        if projection.due().is_some_and(|due| due <= at(NOW + ms))
            && projection.tick(model, clock(NOW + ms)).is_some()
        {
            sent.push(ms);
        }
    }
    sent
}

fn streaming() -> (Model, Projection, watch::Receiver<Bytes>) {
    let mut model = Model::new();
    model.at(NOW);
    updated(&mut model, "s1", NOW, None);
    busy(&mut model, "s1");
    let (projection, receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    (model, projection, receiver)
}

#[test]
fn the_first_delta_lights_fresh_within_the_coalesce_not_the_second() {
    let (model, mut projection, receiver) = streaming();
    assert_eq!(projection.due(), None, "nothing moves: no timer");
    assert!(!view_of(&receiver).threads[0].fresh);
    projection.saw(&delta("s1"), at(NOW + 300));
    assert!(
        projection.due().is_some_and(|due| due <= at(NOW + 300)),
        "the rising edge is structural, and 250 ms since the last build have passed"
    );
    assert!(projection.tick(&model, clock(NOW + 300)).is_some());
    assert!(view_of(&receiver).threads[0].fresh);

    // a delta right after a build waits only the coalesce
    let (model, mut projection, receiver) = streaming();
    let sent = play(&mut projection, &model, &[100], 0, 400);
    assert_eq!(sent, [250]);
    assert!(view_of(&receiver).threads[0].fresh);
}

#[test]
fn fresh_dims_exactly_two_seconds_after_the_last_delta() {
    let (model, mut projection, receiver) = streaming();
    let sent = play(&mut projection, &model, &[100, 600], 0, 2599);
    assert!(
        view_of(&receiver).threads[0].fresh,
        "1999 ms after the last delta"
    );
    assert!(!sent.contains(&2600));
    let sent = play(&mut projection, &model, &[], 2600, 2600);
    assert_eq!(sent, [2600], "the dimming is one deadline, on the ms");
    assert!(!view_of(&receiver).threads[0].fresh);

    // a short turn: one delta, lit and dimmed, never missed
    let (model, mut projection, receiver) = streaming();
    let sent = play(&mut projection, &model, &[100], 0, 2100);
    assert_eq!(sent.first(), Some(&250));
    assert_eq!(sent.last(), Some(&2100));
    assert!(!view_of(&receiver).threads[0].fresh);
}

#[test]
fn a_thread_that_keeps_streaming_costs_no_build_for_fresh() {
    let (model, mut projection, receiver) = streaming();
    let deltas: Vec<i64> = (1..=50).map(|n| n * 100).collect();
    let builds_before = projection.builds;
    play(&mut projection, &model, &deltas, 0, 5000);
    assert!(view_of(&receiver).threads[0].fresh);
    // the rising edge at 250, then only activity's second: 1250, 2250, 3250, 4250
    assert_eq!(projection.builds - builds_before, 5);
}

#[test]
fn activity_fades_on_its_second_and_its_timer_stops() {
    let (model, mut projection, receiver) = streaming();
    play(&mut projection, &model, &[100, 101, 102, 103], 0, 250);
    // four deltas, 0.15 s of decay: 4 * 0.7^0.15 = 3.8, a column of 4
    assert_eq!(view_of(&receiver).machines[0].activity, 4);
    play(&mut projection, &model, &[], 251, 20_000);
    assert_eq!(view_of(&receiver).machines[0].activity, 0);
    assert!(!view_of(&receiver).threads[0].fresh);
    assert_eq!(
        projection.due(),
        None,
        "gone once 4 * 0.7^t < 0.05: no timer"
    );
}

#[test]
fn activity_is_capped_and_rounded_to_five() {
    assert_eq!(activity(0.49), 0);
    assert_eq!(activity(0.5), 1);
    assert_eq!(activity(4.4), 4);
    assert_eq!(activity(60.0), 5);
    let mut model = Model::new();
    model.at(NOW);
    updated(&mut model, "s1", NOW, None);
    let (mut projection, _receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    for _ in 0..500 {
        projection.saw(&delta("s1"), at(NOW));
    }
    let rate = projection.rates["desk"];
    assert!((rate.value - RATE_CAP).abs() < f64::EPSILON);
}

#[test]
fn structural_changes_coalesce_into_one_build_a_quarter_second() {
    let mut model = Model::new();
    model.at(NOW);
    updated(&mut model, "s1", NOW, None);
    let (mut projection, receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    assert!(keys(&view_of(&receiver)).is_empty());
    let sent = projection.sent;

    busy(&mut model, "s1");
    for change in [
        Change::Order { keys: Vec::new() },
        Change::AskSettled(crate::wire::AskSettled {
            agent: "desk".into(),
            id: "x".into(),
            outcome: crate::wire::Outcome::Unknown,
            option: None,
            reason: None,
            by: None,
            at: 0.0,
        }),
    ] {
        projection.saw(&change, at(NOW + 10));
    }
    assert_eq!(projection.due(), Some(at(NOW + 250)));
    assert!(
        projection.tick(&model, clock(NOW + 100)).is_none(),
        "not yet"
    );
    assert_eq!(projection.builds, 1);
    assert!(projection.tick(&model, clock(NOW + 250)).is_some());
    assert_eq!(projection.sent, sent + 1);
    assert_eq!(keys(&view_of(&receiver)), ["desk:s1"]);
}

#[test]
fn transcript_changes_never_mark_the_picture() {
    let model = Model::new();
    let (mut projection, _receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    let message: crate::wire::Message =
        serde_json::from_value(serde_json::json!({"id": "m", "role": "assistant", "created": 1.0}))
            .unwrap();
    projection.saw(
        &Change::Message {
            key: "desk:s1".into(),
            upstream: None,
            message,
        },
        at(NOW),
    );
    let part = crate::source::cmx2::translate::part(
        &serde_json::value::RawValue::from_string(
            r#"{"id":"p","messageID":"m","sessionID":"s1","type":"text","text":"hi"}"#.into(),
        )
        .unwrap(),
    );
    projection.saw(
        &Change::Part {
            key: "desk:s1".into(),
            upstream: None,
            part,
        },
        at(NOW),
    );
    projection.saw(
        &Change::MessageRemoved {
            key: "desk:s1".into(),
            upstream: None,
            message_id: "m".into(),
        },
        at(NOW),
    );
    assert_eq!(projection.due(), None);
}

#[test]
fn an_unchanged_picture_is_not_sent_even_as_a_need_ages() {
    let mut model = Model::new();
    model.at(NOW);
    updated(&mut model, "s1", NOW, None);
    permission(&mut model, "s1", "per_1");
    let (mut projection, mut receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    receiver.borrow_and_update();
    projection.saw(&Change::Order { keys: Vec::new() }, at(NOW + 1));
    assert!(projection.tick(&model, clock(NOW + 5000)).is_none());
    assert_eq!((projection.builds, projection.sent), (2, 1));
    assert!(!receiver.has_changed().unwrap(), "nothing was published");
}

#[test]
fn the_cap_never_drops_a_bound_thread() {
    let mut model = Model::new();
    model.at(NOW);
    for n in 0..40 {
        updated(&mut model, &format!("s{n:02}"), NOW - n, None);
        busy(&mut model, &format!("s{n:02}"));
    }
    updated(&mut model, "quiet", NOW - 20 * HOUR, None);
    let bound = vec![Binding {
        wire: 13,
        key: "desk:quiet".into(),
        color: [0, 0, 0],
    }];
    let (_projection, receiver) = Projection::start(wanted(bound), &model, clock(NOW));
    let view = view_of(&receiver);
    assert_eq!(view.threads.len(), MAX_THREADS);
    assert_eq!(keys(&view).last(), Some(&"desk:quiet"));
}

#[test]
fn configured_machines_keep_their_order_and_light_by_label() {
    let model = Model::new();
    let (projection, receiver) = Projection::start(
        Wanted {
            machines: Some(vec!["vm".into(), "laptop".into()]),
            bindings: Vec::new(),
            roster: roster(),
        },
        &model,
        clock(NOW),
    );
    assert_eq!(
        view_of(&receiver)
            .machines
            .iter()
            .map(|m| (m.name.as_str(), m.up))
            .collect::<Vec<_>>(),
        [("vm", false), ("laptop", false)]
    );
    drop(projection);
}

/// the fleet actor with no board: nothing of the board exists, whatever passes.
#[test]
fn with_no_board_stream_the_actor_holds_nothing_and_runs_no_timer() {
    use crate::fleet::{Actor, BoardCommand, Command, Outside};
    use crate::journal::Journal;
    use crate::push::Push;
    use tokio::sync::{mpsc, oneshot};

    let mut actor = Actor {
        model: Model::new(),
        journal: Journal::new("ep".into()),
        encoder: crate::fleet::encode::Encoder::new(),
        live: Vec::new(),
        board: None,
        keys: crate::fleet::StreamKeys::new(),
        build: "test".into(),
        tails: mpsc::channel(1).0,
        outside: Outside {
            push: Push::detached(),
            telemetry: crate::telemetry::Sender::detached(),
            persist: mpsc::channel(1).0,
            ack: None,
        },
        persist: crate::fleet::persist::Persist::detached(),
        cursors: std::collections::HashMap::new(),
        unasked: Vec::new(),
    };
    for n in 0..300 {
        let mut changes = Vec::new();
        updated(&mut actor.model, &format!("s{n}"), NOW, None);
        changes.push(delta(&format!("s{n}")));
        actor.publish_all(changes);
    }
    assert!(
        actor.board.is_none(),
        "no projection without a board stream"
    );

    // a stream subscribes, then goes: the projection goes with it
    let (reply, answer) = oneshot::channel();
    actor.command(Command::Board(BoardCommand::Subscribe {
        wanted: wanted(Vec::new()),
        reply,
    }));
    let receiver = answer.blocking_recv().unwrap();
    assert!(actor.board.is_some());
    assert_eq!(view_of(&receiver).threads.len(), 0);
    drop(receiver);
    actor.command(Command::Board(BoardCommand::Left));
    assert!(actor.board.is_none());
}

/// the budget (`docs/board.md`): a rebuild under 1 ms. a fleet at the window
/// order's cap, 300 threads with every kind of need, built and encoded
/// whole. the bound here is loose for debug builds; the release number is
/// in the lane's notes (`cargo test --release rebuild_of_300`).
#[test]
fn a_rebuild_of_300_threads_fits_the_budget() {
    let mut model = Model::new();
    model.at(NOW);
    for n in 0..300 {
        let id = format!("s{n:03}");
        updated(&mut model, &id, NOW - i64::from(n) * 1000, None);
        match n % 6 {
            0 | 1 => busy(&mut model, &id),
            2 => question(&mut model, &id, &format!("que_{n}"), &[4]),
            3 => permission(&mut model, &id, &format!("per_{n}")),
            4 => {
                busy(&mut model, &id);
                replied(&mut model, &id, &format!("msg_{n}"));
                idle(&mut model, &id);
            }
            _ => {}
        }
    }
    let (mut projection, receiver) = Projection::start(wanted(Vec::new()), &model, clock(NOW));
    let runs: u32 = 200;
    let started = Instant::now();
    let mut bytes = 0;
    for run in 0..runs {
        let built = projection
            .build(&model, clock(NOW + i64::from(run)), true)
            .unwrap();
        bytes = built.bytes;
    }
    let each = started.elapsed() / runs;
    let view = view_of(&receiver);
    assert_eq!(view.threads.len(), MAX_THREADS);
    println!("board view rebuild over 300 threads: {each:?} each, {bytes} bytes");
    assert!(each < Duration::from_millis(20), "{each:?}");
    assert!(bytes < 8 * 1024, "a view stays a few kilobytes: {bytes}");
}
