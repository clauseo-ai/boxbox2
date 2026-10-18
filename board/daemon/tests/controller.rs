//! the board's controller, driven from outside the crate: keys, views and
//! clock in, the effects the daemon must carry out out. ported from v1's
//! controller tests, asserting v2: seats are the view's threads in order, the
//! seat map is posted as `Act::Seats`, focus is `Act::Focus`, plus is machine 4.

use boxbox_board::config::Timings;
use boxbox_board::controller::{After, Bank, Controller, Effect, KeyRecord, Settings};
use boxbox_board::log::Log;
use boxbox_board::protocol::Key;
use boxbox_board::scenes::DIGIT_WIRES;
use boxbox_board_wire::{Act, Answer, Ask, AskKind, Binding, Machine, Need, Seat, Thread, View};

const NOW: u64 = 1_000_000;
const WALL: u64 = 1_800_000_000_000;

fn controller() -> Controller {
    Controller::new(
        Settings {
            timings: Timings::default(),
            mic_meter: true,
        },
        Log::null(),
    )
}

// a connected board whose stream is up and whose first view has landed. the
// effects of that setup are drained, so a test reads only what it caused.
fn board(view: View) -> Controller {
    let mut c = controller();
    c.on_hello(0, NOW);
    c.on_stream_up();
    c.on_view(view, NOW, WALL);
    c.take_effects();
    c
}

fn thread(key: &str) -> Thread {
    Thread {
        key: key.into(),
        title: None,
        need: None,
        waiting_ms: None,
        working: true,
        fresh: false,
        queued: 0,
        ask: None,
    }
}

fn permission(key: &str, id: &str) -> Thread {
    Thread {
        need: Some(Need::Permission),
        working: false,
        ask: Some(Ask {
            id: id.into(),
            kind: AskKind::Permission,
            options: vec![],
        }),
        ..thread(key)
    }
}

fn question(key: &str, id: &str, options: &[&str]) -> Thread {
    Thread {
        need: Some(Need::Question),
        working: false,
        ask: Some(Ask {
            id: id.into(),
            kind: AskKind::Question,
            options: options.iter().copied().map(String::from).collect(),
        }),
        ..thread(key)
    }
}

// n working threads on h1, s00 first: the order the server sends.
fn busy(n: usize) -> View {
    view((0..n).map(|i| thread(&format!("h1:s{i:02}"))).collect())
}

fn view(threads: Vec<Thread>) -> View {
    View {
        machines: vec![],
        threads,
        bindings: vec![],
    }
}

fn with_machines(mut v: View, names: &[&str]) -> View {
    v.machines = names
        .iter()
        .map(|n| Machine {
            name: (*n).into(),
            up: true,
            activity: 0,
        })
        .collect();
    v
}

fn bind(k: Key, key: &str) -> Binding {
    Binding {
        wire: k.wire(),
        key: key.into(),
        color: [190, 0, 255],
    }
}

fn tap(c: &mut Controller, k: Key, at: u64) {
    c.on_key(k.wire(), true, at);
    c.on_key(k.wire(), false, at + 50);
    c.tick(at + 500); // past the double window
}

fn double_tap(c: &mut Controller, k: Key, at: u64) {
    c.on_key(k.wire(), true, at);
    c.on_key(k.wire(), false, at + 50);
    c.on_key(k.wire(), true, at + 150);
    c.on_key(k.wire(), false, at + 200);
}

fn seat(c: &Controller, k: Key) -> Option<String> {
    c.resolve_wire(k.wire()).map(|(key, _)| key)
}

fn posted(fx: &[Effect]) -> Vec<Act> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Act {
                act: Act::Seats { .. },
                ..
            } => None,
            Effect::Act { act, .. } => Some(act.clone()),
            _ => None,
        })
        .collect()
}

fn seat_posts(fx: &[Effect]) -> Vec<Vec<Seat>> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Act {
                act: Act::Seats { seats },
                ..
            } => Some(seats.clone()),
            _ => None,
        })
        .collect()
}

fn recorded(fx: &[Effect]) -> Vec<&KeyRecord> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Key { record, .. }
            | Effect::Act {
                after: After::Key(record),
                ..
            } => Some(record),
            _ => None,
        })
        .collect()
}

fn says(fx: &[Effect]) -> Vec<&str> {
    fx.iter()
        .filter_map(|e| match e {
            Effect::Say(words) => Some(words.as_str()),
            _ => None,
        })
        .collect()
}

fn last_meter(fx: &[Effect]) -> Option<&Effect> {
    fx.iter()
        .rev()
        .find(|e| matches!(e, Effect::MeterStart | Effect::MeterStop))
}

fn seat_entry(map: &[Seat], key: &str) -> Option<(u8, bool)> {
    map.iter()
        .find(|s| s.key == key)
        .map(|s| (s.digit, s.bound))
}

fn reply(key: &str, ask: &str, answer: Answer) -> Act {
    Act::Reply {
        key: key.into(),
        ask: ask.into(),
        answer,
    }
}

// ——— the 3×3 spill ———

#[test]
fn ten_workers_nine_seat_at_once_in_digit_order_and_the_tenth_pages() {
    let c = board(busy(10));
    assert_eq!(seat(&c, DIGIT_WIRES[0]).as_deref(), Some("h1:s00"));
    assert_eq!(seat(&c, DIGIT_WIRES[8]).as_deref(), Some("h1:s08"));
    assert_eq!(c.wire_for_key("h1:s09"), None); // paged out
    assert_eq!(c.page_count(), 2);
}

#[test]
fn a_bound_key_drops_out_of_the_flow_and_its_agent_renders_there() {
    let mut v = busy(3);
    v.bindings = vec![bind(DIGIT_WIRES[0], "h1:s01")];
    let c = board(v);
    assert_eq!(c.wire_for_key("h1:s01"), Some(DIGIT_WIRES[0].wire()));
    assert_eq!(seat(&c, DIGIT_WIRES[0]).as_deref(), Some("h1:s01"));
    // the queue flows around the livery
    assert_eq!(seat(&c, DIGIT_WIRES[1]).as_deref(), Some("h1:s00"));
    assert_eq!(seat(&c, DIGIT_WIRES[2]).as_deref(), Some("h1:s02"));
}

// ——— paging ———

#[test]
fn dot_wraps_past_the_last_page_and_comes_home() {
    let mut c = board(busy(10));
    tap(&mut c, Key::Dot, NOW);
    assert_eq!(c.page, 1);
    assert_eq!(seat(&c, DIGIT_WIRES[0]).as_deref(), Some("h1:s09"));
    tap(&mut c, Key::Dot, NOW + 2000);
    assert_eq!(c.page, 0); // the one-way trip is dead
    assert_eq!(seat(&c, DIGIT_WIRES[0]).as_deref(), Some("h1:s00"));
}

#[test]
fn the_page_snaps_home_when_the_list_shrinks_under_it() {
    let mut c = board(busy(10));
    tap(&mut c, Key::Dot, NOW);
    assert_eq!(c.page, 1);
    // nine threads finish; only s00 remains
    c.on_view(busy(1), NOW + 2000, WALL);
    assert_eq!(c.page, 0);
}

// ——— ent is a real enter key ———

#[test]
fn ent_is_only_witnessed_so_no_verb_resolves_and_nothing_fires_at_the_origin() {
    let mut c = board(busy(2));
    double_tap(&mut c, DIGIT_WIRES[0], NOW); // pointed, dictation armed
    c.take_effects();
    tap(&mut c, Key::Ent, NOW + 2000);
    // the keystroke is the firmware's; the daemon must not reach for the origin
    let fx = c.take_effects();
    assert!(posted(&fx).is_empty());
    assert!(recorded(&fx).iter().any(|r| r.target == "enter"));
}

// ——— the machines row starts threads ———

#[test]
fn tap_div_mul_min_composes_at_the_machine_at_that_index() {
    let mut c = board(with_machines(busy(1), &["h1", "h3", "h2"]));
    tap(&mut c, Key::Div, NOW);
    tap(&mut c, Key::Mul, NOW + 2000);
    tap(&mut c, Key::Min, NOW + 4000);
    assert_eq!(
        posted(&c.take_effects()),
        [
            Act::Compose {
                machine: "h1".into()
            },
            Act::Compose {
                machine: "h3".into()
            },
            Act::Compose {
                machine: "h2".into()
            },
        ]
    );
}

#[test]
fn plus_composes_on_machine_four() {
    let mut c = board(with_machines(busy(1), &["h1", "h3", "h2", "h4"]));
    tap(&mut c, Key::Plus, NOW);
    assert_eq!(
        posted(&c.take_effects()),
        [Act::Compose {
            machine: "h4".into()
        }]
    );
}

#[test]
fn a_machine_key_with_no_machine_at_its_index_records_empty_and_posts_nothing() {
    let mut c = board(with_machines(busy(1), &["h1"]));
    tap(&mut c, Key::Mul, NOW);
    let fx = c.take_effects();
    assert!(posted(&fx).is_empty());
    assert!(recorded(&fx).iter().any(|r| r.target == "empty"));
}

// ——— the pit ———

#[test]
fn a_seat_with_a_permission_enters_the_pit_and_skip_returns_to_drive() {
    let mut c = board(view(vec![permission("h1:s00", "perm1")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    assert_eq!(c.bank, Bank::Pit);
    assert!(
        recorded(&c.take_effects())
            .iter()
            .any(|r| r.target == "pit")
    );
    tap(&mut c, Key::Min, NOW + 2000);
    assert_eq!(c.bank, Bank::Drive);
    assert!(c.pit.is_none());
    let fx = c.take_effects();
    assert!(posted(&fx).is_empty());
    // the skip's key event names the bank it left the board in, as v1's did
    assert!(
        recorded(&fx)
            .iter()
            .any(|r| r.target == "skip" && r.bank == "drive")
    );
}

#[test]
fn the_pits_skip_key_still_outranks_the_machines_row() {
    let mut c = board(with_machines(
        view(vec![permission("h1:s00", "perm1")]),
        &["h1", "h3", "h2"],
    ));
    tap(&mut c, DIGIT_WIRES[0], NOW); // enter the pit on the seat
    assert_eq!(c.bank, Bank::Pit);
    c.take_effects();
    tap(&mut c, Key::Min, NOW + 2000); // skip, not compose
    assert_eq!(c.bank, Bank::Drive);
    assert!(posted(&c.take_effects()).is_empty());
}

#[test]
fn k1_replies_once_and_k2_always_to_a_permission() {
    let mut c = board(view(vec![permission("h1:s00", "perm1")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    c.take_effects();
    tap(&mut c, Key::K1, NOW + 2000);
    assert_eq!(
        posted(&c.take_effects()),
        [reply("h1:s00", "perm1", Answer::Once)]
    );
    tap(&mut c, Key::K2, NOW + 4000);
    assert_eq!(
        posted(&c.take_effects()),
        [reply("h1:s00", "perm1", Answer::Always)]
    );
}

#[test]
fn k3_arms_on_the_first_press_and_rejects_on_the_second() {
    let mut c = board(view(vec![permission("h1:s00", "perm1")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    c.take_effects();
    tap(&mut c, Key::K3, NOW + 2000);
    let fx = c.take_effects();
    assert!(posted(&fx).is_empty());
    assert!(recorded(&fx).iter().any(|r| r.target == "arm"));
    tap(&mut c, Key::K3, NOW + 3000);
    assert_eq!(
        posted(&c.take_effects()),
        [reply("h1:s00", "perm1", Answer::Reject)]
    );
}

#[test]
fn the_reject_arm_lapses_after_reject_arm_ms_so_the_next_k3_arms_again() {
    let mut c = board(view(vec![permission("h1:s00", "perm1")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    c.take_effects();
    tap(&mut c, Key::K3, NOW + 2000);
    c.take_effects();
    // five seconds and more after the arm
    tap(&mut c, Key::K3, NOW + 8000);
    let fx = c.take_effects();
    assert!(posted(&fx).is_empty());
    assert!(recorded(&fx).iter().any(|r| r.target == "arm"));
}

#[test]
fn a_question_answers_by_digit_only_under_its_option_count() {
    let mut c = board(view(vec![question(
        "h1:s00",
        "q1",
        &["red", "green", "blue"],
    )]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    c.take_effects();
    tap(&mut c, DIGIT_WIRES[1], NOW + 2000); // option index 1
    assert_eq!(
        posted(&c.take_effects()),
        [reply("h1:s00", "q1", Answer::Option { index: 1 })]
    );
    tap(&mut c, DIGIT_WIRES[8], NOW + 4000); // a ninth digit, three options
    assert!(posted(&c.take_effects()).is_empty());
}

#[test]
fn the_pit_clears_when_a_view_no_longer_carries_its_ask() {
    let mut c = board(view(vec![permission("h1:s00", "perm1")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    assert_eq!(c.bank, Bank::Pit);
    c.on_view(view(vec![thread("h1:s00")]), NOW + 1000, WALL);
    assert_eq!(c.bank, Bank::Drive);
    assert!(c.pit.is_none());

    // a different ask on the same thread is not this one
    let mut c = board(view(vec![permission("h1:s00", "perm1")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    c.on_view(view(vec![permission("h1:s00", "perm2")]), NOW + 1000, WALL);
    assert_eq!(c.bank, Bank::Drive);
}

// ——— the seat map (the board's key badges) ———

#[test]
fn digit_is_rank_s00_answers_to_1_s08_to_9_and_the_map_holds_only_the_page() {
    let c = board(busy(10));
    let map = c.seat_map();
    assert_eq!(map.len(), 9);
    assert_eq!(seat_entry(&map, "h1:s00"), Some((1, false)));
    assert_eq!(seat_entry(&map, "h1:s08"), Some((9, false)));
    assert_eq!(seat_entry(&map, "h1:s09"), None); // paged out: no badge
}

#[test]
fn paging_moves_the_map_to_the_next_page_and_digits_stay_rank() {
    let mut c = board(busy(10));
    tap(&mut c, Key::Dot, NOW);
    let map = c.seat_map();
    assert_eq!(map.len(), 1);
    assert_eq!(seat_entry(&map, "h1:s09"), Some((1, false)));
    assert_eq!(seat_entry(&map, "h1:s00"), None);
}

#[test]
fn a_bound_agent_keeps_her_key_digit_and_the_queue_flows_around_her() {
    let mut v = busy(3);
    v.bindings = vec![bind(DIGIT_WIRES[3], "h1:s01")];
    let c = board(v);
    let map = c.seat_map();
    assert_eq!(seat_entry(&map, "h1:s01"), Some((4, true)));
    assert_eq!(seat_entry(&map, "h1:s00"), Some((1, false)));
    assert_eq!(seat_entry(&map, "h1:s02"), Some((2, false)));
}

#[test]
fn a_bound_agent_keeps_her_badge_on_the_second_page_too() {
    let mut v = busy(10);
    v.bindings = vec![bind(DIGIT_WIRES[3], "h1:s01")];
    let mut c = board(v);
    tap(&mut c, Key::Dot, NOW);
    let map = c.seat_map();
    assert_eq!(seat_entry(&map, "h1:s01"), Some((4, true)));
    assert_eq!(seat_entry(&map, "h1:s09"), Some((1, false)));
}

#[test]
fn seats_post_once_per_change_and_not_again_for_an_unchanged_view() {
    let mut c = controller();
    c.on_hello(0, NOW);
    c.on_stream_up();
    c.on_view(busy(10), NOW, WALL);
    assert_eq!(seat_posts(&c.take_effects()).len(), 1);
    c.on_view(busy(10), NOW + 1000, WALL);
    assert!(seat_posts(&c.take_effects()).is_empty());
    tap(&mut c, Key::Dot, NOW + 2000);
    let posts = seat_posts(&c.take_effects());
    assert_eq!(posts.len(), 1);
    assert_eq!(
        posts[0],
        [Seat {
            key: "h1:s09".into(),
            digit: 1,
            bound: false,
        }]
    );
}

// ——— the radio is a wispr key ———

#[test]
fn double_tap_opens_hands_free_with_the_meter_held_through_the_release() {
    let mut c = board(busy(1));
    double_tap(&mut c, Key::K0, NOW);
    assert!(c.hands_free);
    // the last meter word must be start: the second release must not
    // silence a mic wispr is still listening through
    let fx = c.take_effects();
    assert_eq!(last_meter(&fx), Some(&Effect::MeterStart));
}

#[test]
fn one_press_while_hands_free_is_wisprs_stop_with_no_readback_or_verb() {
    let mut c = board(busy(1));
    double_tap(&mut c, Key::K0, NOW);
    c.take_effects();
    c.on_key(Key::K0.wire(), true, NOW + 5000);
    c.on_key(Key::K0.wire(), false, NOW + 5050);
    c.tick(NOW + 7000); // past every window: no tap may settle
    assert!(!c.hands_free);
    let fx = c.take_effects();
    assert_eq!(last_meter(&fx), Some(&Effect::MeterStop));
    assert!(says(&fx).is_empty()); // the voice stays out of the paste
    assert!(posted(&fx).is_empty());
    // exactly one stop record (verb tap); the start rode the double
    assert_eq!(
        recorded(&fx)
            .iter()
            .filter(|r| r.target == "handsfree" && r.verb == "tap")
            .count(),
        1
    );
}

#[test]
fn triple_tap_dismissal_cannot_re_arm_the_tail_presses_die_in_the_refractory() {
    let mut c = board(busy(1));
    double_tap(&mut c, Key::K0, NOW);
    // wisprs triple tap: press 1 stops, presses 2 and 3 land right behind it
    c.on_key(Key::K0.wire(), true, NOW + 5000);
    c.on_key(Key::K0.wire(), false, NOW + 5040);
    c.on_key(Key::K0.wire(), true, NOW + 5120);
    c.on_key(Key::K0.wire(), false, NOW + 5160);
    c.on_key(Key::K0.wire(), true, NOW + 5240);
    c.on_key(Key::K0.wire(), false, NOW + 5280);
    c.tick(NOW + 7000);
    assert!(!c.hands_free);
    // a deliberate double after the refractory arms again
    double_tap(&mut c, Key::K0, NOW + 8000);
    assert!(c.hands_free);
}

#[test]
fn silence_clears_hands_free_after_45_seconds_with_no_voice_on_the_meter() {
    let mut c = board(busy(1));
    double_tap(&mut c, Key::K0, NOW);
    c.on_meter_window(0.0, NOW + 20_000); // silent windows do not count as voice
    c.tick(NOW + 44_000);
    assert!(c.hands_free); // still inside the window
    c.tick(NOW + 45_300);
    assert!(!c.hands_free);
}

#[test]
fn voice_on_the_meter_keeps_hands_free_open_past_the_silence_window() {
    let mut c = board(busy(1));
    double_tap(&mut c, Key::K0, NOW);
    c.on_meter_window(0.5, NOW + 40_000);
    c.tick(NOW + 60_000);
    assert!(c.hands_free);
    c.tick(NOW + 86_000);
    assert!(!c.hands_free);
}

#[test]
fn a_lone_tap_reads_back_and_a_double_on_the_radio_focuses_nothing() {
    let mut c = board(busy(2));
    tap(&mut c, Key::K0, NOW);
    assert_eq!(says(&c.take_effects()), ["all quiet, 2 threads working"]);
    double_tap(&mut c, Key::K0, NOW + 3000);
    assert!(posted(&c.take_effects()).is_empty());
}

#[test]
fn readback_names_the_top_call_and_how_long_it_has_waited() {
    let mut t = permission("h1:s00", "perm1");
    t.title = Some("api fix".into());
    t.waiting_ms = Some(120_000);
    let mut c = board(view(vec![t]));
    tap(&mut c, Key::K0, NOW + 2000);
    assert_eq!(
        says(&c.take_effects()),
        ["api fix wants permission, waiting 2 minutes"]
    );
}

// ——— nl cycles two banks; the verb swap ———

#[test]
fn nl_cycles_drive_and_fleet() {
    let mut c = board(busy(1));
    tap(&mut c, Key::Nl, NOW);
    assert_eq!(c.bank, Bank::Fleet);
    tap(&mut c, Key::Nl, NOW + 2000);
    assert_eq!(c.bank, Bank::Drive);
}

#[test]
fn unplug_returns_the_bank_to_drive_from_fleet() {
    let mut c = board(busy(1));
    tap(&mut c, Key::Nl, NOW);
    assert_eq!(c.bank, Bank::Fleet);
    c.on_unplug(WALL + 1000);
    assert_eq!(c.bank, Bank::Drive);
}

#[test]
fn holding_nl_past_the_threshold_toggles_deep_work_under_the_finger() {
    let mut c = board(busy(1));
    c.on_key(Key::Nl.wire(), true, NOW);
    c.tick(NOW + 400); // past hold_ms: fires at the threshold
    assert!(c.deep_work);
    c.on_key(Key::Nl.wire(), false, NOW + 900);
    assert!(c.deep_work); // the release does not re-toggle
    c.on_key(Key::Nl.wire(), true, NOW + 2000);
    c.tick(NOW + 2400);
    c.on_key(Key::Nl.wire(), false, NOW + 2900);
    assert!(!c.deep_work);
}

#[test]
fn double_tap_nl_is_a_daemon_no_op_because_calc_is_the_firmwares_verb() {
    let mut c = board(busy(1));
    double_tap(&mut c, Key::Nl, NOW);
    assert!(!c.deep_work);
    assert_eq!(c.bank, Bank::Drive); // no bank flip either
    let fx = c.take_effects();
    assert!(posted(&fx).is_empty());
    assert!(
        recorded(&fx)
            .iter()
            .any(|r| r.verb == "double" && r.target == "mode")
    );
}

// ——— the seats: focus, the queue view, flush ———

#[test]
fn a_seat_tap_focuses_its_thread_and_a_seat_double_focuses_it_for_dictation() {
    let mut c = board(busy(2));
    tap(&mut c, DIGIT_WIRES[1], NOW);
    assert_eq!(
        posted(&c.take_effects()),
        [Act::Focus {
            key: "h1:s01".into()
        }]
    );
    double_tap(&mut c, DIGIT_WIRES[0], NOW + 3000);
    let fx = c.take_effects();
    assert_eq!(
        posted(&fx),
        [Act::Focus {
            key: "h1:s00".into()
        }]
    );
    assert!(
        recorded(&fx)
            .iter()
            .any(|r| r.verb == "double" && r.target == "dictate")
    );
}

#[test]
fn holding_a_seat_opens_the_queue_view_and_release_closes_it() {
    let mut c = board(busy(2));
    c.on_key(DIGIT_WIRES[0].wire(), true, NOW);
    c.tick(NOW + 400); // past hold_ms
    assert_eq!(c.held_seat.as_ref().map(|h| h.key.as_str()), Some("h1:s00"));
    c.on_key(DIGIT_WIRES[0].wire(), false, NOW + 900);
    assert!(c.held_seat.is_none());
}

#[test]
fn hold_a_seat_press_ent_and_the_flush_fires_when_orders_are_parked() {
    let mut v = busy(2);
    v.threads[0].queued = 2;
    let mut c = board(v);
    c.on_key(DIGIT_WIRES[0].wire(), true, NOW);
    c.tick(NOW + 400);
    c.on_key(Key::Ent.wire(), true, NOW + 500); // the chord fires on the down
    assert_eq!(
        posted(&c.take_effects()),
        [Act::Flush {
            key: "h1:s00".into()
        }]
    );
    c.on_key(Key::Ent.wire(), false, NOW + 600);
    assert!(c.held_seat.is_none()); // the chord's end closes the view
    c.on_key(DIGIT_WIRES[0].wire(), false, NOW + 700);
    assert!(posted(&c.take_effects()).is_empty());
}

#[test]
fn an_empty_queue_keeps_the_chord_inert_with_no_bare_interrupt() {
    let mut c = board(busy(2));
    c.on_key(DIGIT_WIRES[0].wire(), true, NOW);
    c.tick(NOW + 400);
    c.on_key(Key::Ent.wire(), true, NOW + 500);
    assert!(posted(&c.take_effects()).is_empty());
}

// ——— dot: a hold reads the top call, a tap pages ———

#[test]
fn a_hold_on_dot_posts_read_for_the_top_call_and_a_tap_on_dot_still_pages() {
    let mut v = busy(10);
    v.threads[7].need = Some(Need::News);
    let mut c = board(v);
    c.on_key(Key::Dot.wire(), true, NOW);
    c.tick(NOW + 400);
    assert_eq!(
        posted(&c.take_effects()),
        [Act::Read {
            key: "h1:s07".into()
        }]
    );
    c.on_key(Key::Dot.wire(), false, NOW + 900);
    c.take_effects();
    tap(&mut c, Key::Dot, NOW + 2000);
    assert_eq!(c.page, 1);
    assert_eq!(seat(&c, DIGIT_WIRES[0]).as_deref(), Some("h1:s09"));
}

// ——— telemetry labels tell the truth ———

#[test]
fn a_radio_hold_logs_talk_and_a_seat_hold_logs_queue_never_gauge() {
    let mut c = board(busy(2));
    c.on_key(Key::K0.wire(), true, NOW);
    c.tick(NOW + 400);
    c.on_key(Key::K0.wire(), false, NOW + 900);
    c.on_key(DIGIT_WIRES[0].wire(), true, NOW + 2000);
    c.tick(NOW + 2400);
    c.on_key(DIGIT_WIRES[0].wire(), false, NOW + 2900);
    let fx = c.take_effects();
    let targets: Vec<&str> = recorded(&fx).iter().map(|r| r.target).collect();
    assert!(targets.contains(&"talk"));
    assert!(targets.contains(&"queue"));
    assert!(!targets.contains(&"gauge"));
}

// ——— pins ———

#[test]
fn a_pin_then_a_digit_key_binds_the_thread_and_eats_the_press() {
    let mut c = board(busy(2));
    c.on_pin("h1:s01".into(), [1, 2, 3], 30_000, NOW);
    c.on_key(DIGIT_WIRES[0].wire(), true, NOW + 100);
    c.on_key(DIGIT_WIRES[0].wire(), false, NOW + 150);
    c.tick(NOW + 1000);
    let fx = c.take_effects();
    assert_eq!(
        posted(&fx),
        [Act::Bind(Binding {
            wire: DIGIT_WIRES[0].wire(),
            key: "h1:s01".into(),
            color: [1, 2, 3],
        })]
    );
    assert!(recorded(&fx).is_empty()); // the press called nothing
    assert!(c.pin.is_none());
}

#[test]
fn a_pin_expires_at_its_deadline_and_the_next_key_acts_normally() {
    let mut c = board(busy(2));
    c.on_pin("h1:s01".into(), [1, 2, 3], 30_000, NOW);
    c.tick(NOW + 29_999);
    assert!(c.pin.is_some());
    c.tick(NOW + 30_000);
    assert!(c.pin.is_none());
    tap(&mut c, DIGIT_WIRES[0], NOW + 31_000);
    assert_eq!(
        posted(&c.take_effects()),
        [Act::Focus {
            key: "h1:s00".into()
        }]
    );
}

// ——— unplug ———

#[test]
fn unplug_clears_the_pit() {
    let mut c = board(view(vec![permission("h1:s00", "perm1"), thread("h1:s01")]));
    tap(&mut c, DIGIT_WIRES[0], NOW);
    assert_eq!(c.bank, Bank::Pit);
    c.on_unplug(WALL + 1000);
    assert_eq!(c.bank, Bank::Drive);
    assert!(c.pit.is_none());
}

#[test]
fn unplug_clears_hands_free_the_meter_the_held_seat_the_pin_and_the_page() {
    let mut c = board(busy(10));
    tap(&mut c, Key::Dot, NOW); // page 1
    double_tap(&mut c, Key::K0, NOW + 3000); // hands-free, meter on
    c.on_key(DIGIT_WIRES[0].wire(), true, NOW + 6000); // seat on page 2
    c.tick(NOW + 6400);
    assert!(c.held_seat.is_some());
    c.on_pin("h1:s05".into(), [1, 2, 3], 30_000, NOW + 6500);
    c.take_effects();
    c.on_unplug(WALL + 1000);
    let fx = c.take_effects();
    assert!(!c.hands_free);
    assert!(!c.meter_active());
    assert!(c.held_seat.is_none());
    assert!(c.pin.is_none());
    assert_eq!(c.page, 0);
    assert_eq!(last_meter(&fx), Some(&Effect::MeterStop));
}
