//! the conductor: keys and views in, acts, scenes and the radio out. the
//! four-verb grammar meets the fleet here, the pit stages and fires, the
//! seats are placed and paged, and every press is recorded. pure: it takes
//! time as an argument and hands its effects to the daemon, so the tests
//! drive it exactly.
//!
//! the destructive law (v1): a permission reject cascades to every pending
//! request in the session, so the reject key arms for `reject_arm_ms` and
//! fires only on its second press.

use boxbox_board_wire::{Act, Answer, Ask, AskKind, Binding, Need, Seat as WireSeat, Thread, View};

use crate::config::Timings;
use crate::livery::Liveries;
use crate::log::Log;
use crate::protocol::{Key, slot};
use crate::scenes::{
    DIGIT_WIRES, Livery, MACHINE_WIRES, TransientPlayer, arrival_pulse, briefing, formation_lap,
    red_flag, victory_lap,
};
use crate::state::{Away, Derived, Fleet};
use crate::verbs::{VerbEngine, VerbEvent, VerbTimings};
use crate::vu::Levels;

/// the first view gets this long after the hello ack before the formation lap
/// plays without it.
pub const FORMATION_WAIT_MS: u64 = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bank {
    Drive,
    Pit,
    Fleet,
}

impl Bank {
    #[must_use]
    pub fn word(self) -> &'static str {
        match self {
            Self::Drive => "drive",
            Self::Pit => "pit",
            Self::Fleet => "fleet",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PitStage {
    pub key: String,
    pub ask: Ask,
    pub reject_armed_until: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinArm {
    pub key: String,
    pub color: [u8; 3],
    pub until: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldSeat {
    pub key: String,
    pub wire: u8,
}

/// one press as telemetry records it (`board.key`), plus the generic verb a
/// press that serves a need also records (v1's rule: `board.key` alone
/// closes no need).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyRecord {
    pub wire: u8,
    pub verb: &'static str,
    pub target: &'static str,
    pub bank: &'static str,
    /// monotonic ms the verb resolved: `ms` runs from here to the answer.
    pub at: u64,
    pub serving: Option<&'static str>,
    pub session: Option<String>,
}

/// what the daemon does after an act is answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum After {
    Nothing,
    Key(KeyRecord),
    Bind { wire: u8, key: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// post it; `ok` in the record is the server's answer.
    Act {
        act: Act,
        after: After,
    },
    /// a press that called nothing.
    Key {
        record: KeyRecord,
        ok: bool,
    },
    Say(String),
    MeterStart,
    MeterStop,
    Palette {
        slot: u8,
        rgb: [u8; 3],
    },
}

/// where a row's thread draws: a need, a running turn, or nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Need,
    Live,
}

/// what a stop (launchd's sigterm, a sigint) does: the part of an unplug
/// that fits in a moment, in this order. the gone goes first so the app's
/// digits drop even if the exit outruns the rest; the dark frame lets the
/// firmware's watchdog hand the board back as a numpad, as v1 did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopStep {
    PostGone,
    DarkFrame,
    FlushTelemetry,
    /// wait for the poster, at most [`STOP_WAIT_MS`].
    Drain,
}

/// the longest a stop waits on the server before the process exits.
pub const STOP_WAIT_MS: u64 = 300;

/// the steps for a stop: `plugged` a board is on the link, `acked` its
/// hello came back (so a stream and a poster exist).
#[must_use]
pub fn stop_steps(plugged: bool, acked: bool) -> Vec<StopStep> {
    match (plugged, acked) {
        (true, true) => vec![
            StopStep::PostGone,
            StopStep::DarkFrame,
            StopStep::FlushTelemetry,
            StopStep::Drain,
        ],
        (true, false) => vec![StopStep::DarkFrame],
        (false, _) => vec![],
    }
}

#[derive(Debug)]
pub struct Settings {
    pub timings: Timings,
    pub mic_meter: bool,
}

#[derive(Debug)]
#[allow(clippy::struct_excessive_bools)]
pub struct Controller {
    pub settings: Settings,
    pub fleet: Fleet,
    pub bank: Bank,
    pub deep_work: bool,
    pub page: usize,
    pub calc_mode: bool,
    pub transients: TransientPlayer,
    pub verbs: VerbEngine,
    /// the seat held down: the queue view while the finger is on it, and
    /// what the ent chord flushes.
    pub held_seat: Option<HeldSeat>,
    /// the thread the board points at (a seat's double, the radio chord).
    pub pointed: Option<String>,
    /// wispr hands-free, by dead reckoning: a double on the radio opened the
    /// mic without a hold. the daemon never sees wispr, only the same presses.
    pub hands_free: bool,
    hands_free_since: u64,
    /// radio presses swallowed after a hands-free stop: wispr's triple tap
    /// dismisses a session, and its tail taps would read as a fresh double.
    radio_quiet_until: u64,
    pub pit: Option<PitStage>,
    pub pin: Option<PinArm>,
    pub liveries: Liveries,
    /// the mic meter while it is wanted (the radio held, a chord, hands-free).
    pub meter: Option<Levels>,
    /// no input device for this talk: the meter draws nothing until the stop.
    pub meter_unavailable: bool,
    /// the hello was acked: a board is driving.
    pub connected: bool,
    formation_due: Option<u64>,
    away: Away,
    /// the seat map the server last took; `None` re-posts on the next change.
    posted_seats: Option<Vec<WireSeat>>,
    stream_up: bool,
    effects: Vec<Effect>,
    log: Log,
}

impl Controller {
    #[must_use]
    pub fn new(settings: Settings, log: Log) -> Self {
        let verbs = VerbEngine::new(
            VerbTimings {
                hold_ms: settings.timings.hold_ms,
                double_ms: settings.timings.double_ms,
            },
            // pit keys answer on the first press: a decision key that waits
            // out a double window feels broken. v1 listed none.
            &[],
        );
        Self {
            settings,
            fleet: Fleet::new(),
            bank: Bank::Drive,
            deep_work: false,
            page: 0,
            calc_mode: false,
            transients: TransientPlayer::new(),
            verbs,
            held_seat: None,
            pointed: None,
            hands_free: false,
            hands_free_since: 0,
            radio_quiet_until: 0,
            pit: None,
            pin: None,
            liveries: Liveries::new(),
            meter: None,
            meter_unavailable: false,
            connected: false,
            formation_due: None,
            away: Away::default(),
            posted_seats: None,
            stream_up: false,
            effects: Vec::new(),
            log,
        }
    }

    /// what the daemon must do now, in order.
    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    // ——— lifecycle ———

    /// the hello was acked: sync the mode, push the liveries the board does
    /// not hold, and wait at most a second for the first view's formation lap.
    pub fn on_hello(&mut self, mode: u8, now: u64) {
        self.connected = true;
        self.on_mode(mode);
        self.liveries.connected();
        self.push_liveries();
        self.formation_due = Some(now + FORMATION_WAIT_MS);
        if self.fleet.has_view() {
            self.play_formation(now);
        }
    }

    fn play_formation(&mut self, now: u64) {
        self.formation_due = None;
        let bound: Vec<Livery> = self
            .bound_wires()
            .into_iter()
            .filter_map(|(wire, key)| {
                Some(Livery {
                    wire,
                    slot: self.liveries.slot(&key)?,
                })
            })
            .collect();
        self.log
            .info("board.formation", &format!("bound={}", bound.len()));
        self.transients.push(formation_lap(&bound), now);
    }

    /// the board's mode echo, or the ack's mode byte. a layer flip hides key
    /// events from the daemon (calc reports nothing), so every open press,
    /// hold or pending tap is now a lie: drop them all.
    pub fn on_mode(&mut self, mode: u8) {
        self.calc_mode = mode == 1;
        self.verbs.reset();
        self.held_seat = None;
        if self.hands_free {
            self.stop_hands_free("mode");
        }
    }

    /// a stream is open: the next view seeds silently and the seats post again.
    pub fn on_stream_up(&mut self) {
        self.stream_up = true;
        self.fleet.reconnect();
        self.posted_seats = None;
    }

    /// the stream dropped while plugged in: the gap counts toward the briefing.
    pub fn on_stream_down(&mut self, wall: u64) {
        self.stream_up = false;
        self.away.left(wall);
    }

    /// unplugged: the meter stops, and hands-free, the pit, a held seat, an
    /// armed pin, every open press and the page all clear (v1 kept them, so a
    /// replug came back mid-gesture).
    pub fn on_unplug(&mut self, wall: u64) {
        self.away.left(wall);
        self.connected = false;
        self.stream_up = false;
        self.formation_due = None;
        self.set_meter(false, 0);
        self.meter_unavailable = false;
        self.hands_free = false;
        self.radio_quiet_until = 0;
        self.pit = None;
        self.bank = Bank::Drive;
        self.held_seat = None;
        self.pointed = None;
        self.pin = None;
        self.verbs.reset();
        self.transients.clear();
        self.page = 0;
        self.calc_mode = false;
        self.posted_seats = None;
        self.fleet.forget();
    }

    // ——— the stream ———

    pub fn on_view(&mut self, view: View, now: u64, wall: u64) {
        let derived = self.fleet.apply(view, now);
        self.liveries.sync(&self.fleet.view().bindings);
        if self.connected {
            self.push_liveries();
        }
        if self.away.back(wall, self.settings.timings.away_ms) {
            self.log.info("board.briefing", "");
            self.transients.push(briefing(), now);
        }
        for d in derived {
            match d {
                Derived::Arrival { key, need } => {
                    let Some(wire) = self.wire_for_key(&key).and_then(Key::from_wire) else {
                        continue;
                    };
                    let scene = match need {
                        Need::Fault => red_flag(wire),
                        Need::Permission => arrival_pulse(wire, slot::PERM_HOT, true),
                        _ => arrival_pulse(wire, slot::NEEDS_HOT, false),
                    };
                    self.transients.push(scene, now);
                }
                Derived::Victory => {
                    self.transients.push(victory_lap(), now);
                }
            }
        }
        // the pit's truth is the view: its ask gone means it was answered.
        if let Some(pit) = &self.pit {
            let alive = self
                .fleet
                .thread(&pit.key)
                .and_then(|t| t.ask.as_ref())
                .is_some_and(|a| a.id == pit.ask.id);
            if !alive {
                self.log.info("pit.cleared", "");
                self.pit = None;
                self.bank = Bank::Drive;
            }
        }
        if self.connected && self.formation_due.is_some() {
            self.play_formation(now);
        }
        self.settle();
    }

    /// the app armed a pairing: the next key down binds this thread.
    pub fn on_pin(&mut self, key: String, color: [u8; 3], expires_in_ms: u32, now: u64) {
        self.log.info("pin.armed", "");
        self.pin = Some(PinArm {
            key,
            color,
            until: now + u64::from(expires_in_ms),
        });
    }

    // ——— the radio ———

    /// one meter window's rms.
    pub fn on_meter_window(&mut self, rms: f64, now: u64) {
        if let Some(levels) = &mut self.meter {
            levels.window(rms, now);
        }
    }

    /// the input could not open: no meter for the rest of this talk.
    pub fn on_meter_unavailable(&mut self) {
        if self.meter.is_some() {
            self.meter_unavailable = true;
        }
    }

    /// the meter draws: wanted and open.
    #[must_use]
    pub fn meter_active(&self) -> bool {
        self.meter.is_some() && !self.meter_unavailable
    }

    fn set_meter(&mut self, on: bool, now: u64) {
        match (on, self.meter.is_some()) {
            (true, false) if self.settings.mic_meter => {
                self.meter = Some(Levels::start(now));
                self.meter_unavailable = false;
                self.effects.push(Effect::MeterStart);
            }
            (false, true) => {
                if let Some(levels) = self.meter.take() {
                    self.log.info(
                        "radio.meter_stats",
                        &format!("windows={} silent={}", levels.windows, levels.silent),
                    );
                }
                self.meter_unavailable = false;
                self.effects.push(Effect::MeterStop);
            }
            _ => {}
        }
    }

    fn stop_hands_free(&mut self, reason: &str) {
        self.hands_free = false;
        self.set_meter(false, 0);
        self.log
            .info("radio.handsfree", &format!("on=false reason={reason}"));
    }

    // ——— keys ———

    pub fn on_key(&mut self, wire: u8, down: bool, at: u64) {
        // the pairing outranks the grammar: the next key down is the answer.
        if down && let Some(pin) = self.pin.take() {
            if DIGIT_WIRES.iter().any(|k| k.wire() == wire) {
                self.effects.push(Effect::Act {
                    act: Act::Bind(Binding {
                        wire,
                        key: pin.key.clone(),
                        color: pin.color,
                    }),
                    after: After::Bind { wire, key: pin.key },
                });
                // confirm in violet now; the livery settles when the binding
                // comes back in the view.
                if let Some(k) = Key::from_wire(wire) {
                    self.transients.push(arrival_pulse(k, slot::YOU, false), at);
                }
            } else {
                self.log.info("pin.refused", &format!("wire={wire}"));
            }
            self.settle();
            return;
        }
        if wire == Key::K0.wire() {
            // hands-free: this press is wispr's stop. shut the meter and get
            // out of the way: no verb, no readback over the pasted words.
            if self.hands_free && down {
                self.stop_hands_free("key");
                self.radio_quiet_until = at + self.settings.timings.double_ms * 2;
                let record = self.record(wire, "tap", "handsfree", at);
                self.effects.push(Effect::Key { record, ok: true });
                self.settle();
                return;
            }
            if at < self.radio_quiet_until {
                return;
            }
        }
        for verb in self.verbs.feed(wire, down, at) {
            self.act(verb);
        }
        // the meter follows the raw switch: push to talk needs proof of
        // hearing from the first millisecond. hands-free owns it otherwise.
        if wire == Key::K0.wire() && !self.hands_free {
            self.set_meter(down, at);
        }
        self.settle();
    }

    /// the clock reached a deadline: settle what it closes.
    pub fn tick(&mut self, now: u64) {
        for verb in self.verbs.tick(now) {
            self.act(verb);
        }
        if self.hands_free && self.settings.timings.hands_free_silence_ms > 0 {
            let quiet = match &self.meter {
                Some(levels) if !self.meter_unavailable => now.saturating_sub(levels.voice_at),
                _ => now.saturating_sub(self.hands_free_since),
            };
            if quiet >= self.settings.timings.hands_free_silence_ms {
                self.stop_hands_free("silence");
            }
        }
        if let Some(pit) = &mut self.pit
            && pit.reject_armed_until > 0
            && now >= pit.reject_armed_until
        {
            pit.reject_armed_until = 0;
        }
        if self.pin.as_ref().is_some_and(|p| now >= p.until) {
            self.log.info("pin.expired", "");
            self.pin = None;
        }
        if self.connected && self.formation_due.is_some_and(|due| now >= due) {
            self.play_formation(now);
        }
        self.settle();
    }

    /// the next time something here changes without an input.
    #[must_use]
    pub fn next_deadline(&self, now: u64) -> Option<u64> {
        let hands_free =
            (self.hands_free && self.settings.timings.hands_free_silence_ms > 0).then(|| {
                let from = match &self.meter {
                    Some(levels) if !self.meter_unavailable => levels.voice_at,
                    _ => self.hands_free_since,
                };
                from + self.settings.timings.hands_free_silence_ms
            });
        [
            self.verbs.next_deadline(),
            self.transients.next_deadline(),
            self.fleet.next_hot(now),
            hands_free,
            self.pit
                .as_ref()
                .map(|p| p.reject_armed_until)
                .filter(|&t| t > 0),
            self.pin.as_ref().map(|p| p.until),
            self.formation_due.filter(|_| self.connected),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    fn record(&self, wire: u8, verb: &'static str, target: &'static str, at: u64) -> KeyRecord {
        KeyRecord {
            wire,
            verb,
            target,
            bank: self.bank.word(),
            at,
            serving: None,
            session: None,
        }
    }

    fn done(&mut self, record: KeyRecord, ok: bool) {
        self.effects.push(Effect::Key { record, ok });
    }

    fn post(&mut self, act: Act, record: KeyRecord) {
        self.effects.push(Effect::Act {
            act,
            after: After::Key(record),
        });
    }

    fn act(&mut self, verb: VerbEvent) {
        let (wire, kind, at) = match verb {
            VerbEvent::Tap { wire, at } => (wire, "tap", at),
            VerbEvent::Double { wire, at } => (wire, "double", at),
            VerbEvent::HoldStart { wire, at } => (wire, "holdStart", at),
            VerbEvent::HoldEnd { wire, at, .. } => (wire, "holdEnd", at),
            VerbEvent::Chord { wires, at } => (wires[1], "chord", at),
            VerbEvent::ChordEnd { wires, at } => (wires[1], "chordEnd", at),
        };
        self.log.info(
            "verb",
            &format!("kind={kind} wire={wire} bank={}", self.bank.word()),
        );
        if self.bank == Bank::Pit && self.pit.is_some() {
            self.act_pit(&verb, wire, kind, at);
            return;
        }
        match self.bank {
            Bank::Fleet => {
                if matches!(verb, VerbEvent::Tap { wire, .. } if wire == Key::Nl.wire()) {
                    self.cycle_bank(wire, kind, at);
                } else {
                    let r = self.record(wire, kind, "fleet", at);
                    self.done(r, true);
                }
            }
            Bank::Drive | Bank::Pit => self.act_drive(&verb, wire, kind, at),
        }
    }

    #[allow(clippy::too_many_lines)]
    fn act_drive(&mut self, verb: &VerbEvent, wire: u8, kind: &'static str, at: u64) {
        let ent = Key::Ent.wire();
        let k0 = Key::K0.wire();
        let nl = Key::Nl.wire();
        let dot = Key::Dot.wire();
        match *verb {
            VerbEvent::Chord { wires: [a, b], .. } => {
                // hold a seat, press ent: flush that thread's queue. gated on
                // depth: with nothing queued it would be a bare interrupt.
                let partner = if a == ent {
                    Some(b)
                } else if b == ent {
                    Some(a)
                } else {
                    None
                };
                if let Some(partner) = partner {
                    let target = self
                        .resolve_wire(partner)
                        .filter(|(_, t)| t.is_some_and(|t| t.queued > 0))
                        .map(|(key, _)| key);
                    if let Some(key) = target {
                        self.log.info("queue.flush", "");
                        let mut r = self.record(wire, kind, "flush", at);
                        r.serving = Some("flushQueued");
                        r.session = Some(key.clone());
                        self.post(Act::Flush { key }, r);
                        return;
                    }
                    let r = self.record(wire, kind, "chord", at);
                    self.done(r, true);
                    return;
                }
                let seat = if a == k0 {
                    Some(b)
                } else if b == k0 {
                    Some(a)
                } else {
                    None
                };
                if let Some((key, _)) = seat.and_then(|w| self.resolve_wire(w)) {
                    self.log.info("radio.chord", "");
                    self.pointed = Some(key);
                    self.set_meter(true, at);
                }
                let r = self.record(wire, kind, "chord", at);
                self.done(r, true);
            }
            VerbEvent::ChordEnd { .. } => {
                self.held_seat = None;
                if !self.hands_free {
                    self.set_meter(false, at);
                }
                let r = self.record(wire, kind, "chord", at);
                self.done(r, true);
            }
            VerbEvent::Tap { wire, .. } => {
                if wire == nl {
                    return self.cycle_bank(wire, kind, at);
                }
                if wire == dot {
                    self.page = (self.page + 1) % self.page_count();
                    let r = self.record(wire, kind, "page", at);
                    return self.done(r, true);
                }
                if wire == k0 {
                    return self.readback(wire, kind, at);
                }
                if wire == ent {
                    // ent is a real enter key: the firmware types it. the
                    // daemon only witnesses it.
                    let r = self.record(wire, kind, "enter", at);
                    return self.done(r, true);
                }
                if let Some(i) = MACHINE_WIRES.iter().position(|k| k.wire() == wire) {
                    let machine = self.fleet.view().machines.get(i).map(|m| m.name.clone());
                    let Some(machine) = machine else {
                        let r = self.record(wire, kind, "empty", at);
                        return self.done(r, true);
                    };
                    let r = self.record(wire, kind, "compose", at);
                    return self.post(Act::Compose { machine }, r);
                }
                let Some((key, thread)) = self.resolve_wire(wire) else {
                    let r = self.record(wire, kind, "empty", at);
                    return self.done(r, true);
                };
                let ask = thread
                    .filter(|t| matches!(t.need, Some(Need::Permission | Need::Question)))
                    .and_then(|t| t.ask.clone());
                if let Some(ask) = ask {
                    self.log.info("pit.entered", "");
                    self.pit = Some(PitStage {
                        key,
                        ask,
                        reject_armed_until: 0,
                    });
                    self.bank = Bank::Pit;
                    let r = self.record(wire, kind, "pit", at);
                    return self.done(r, true);
                }
                self.pointed = Some(key.clone());
                let mut r = self.record(wire, kind, "focus", at);
                r.session = Some(key.clone());
                self.post(Act::Focus { key }, r);
            }
            VerbEvent::Double { wire, at } => {
                if wire == nl {
                    // calc is the firmware's verb; its flip arrives as a mode
                    // echo, never as a verb acted on here.
                    let r = self.record(wire, kind, "mode", at);
                    return self.done(r, true);
                }
                if wire == k0 {
                    // wispr locked into hands-free on the same two taps; keep
                    // the meter honest until the stop press.
                    self.hands_free = true;
                    self.hands_free_since = at;
                    self.set_meter(true, at);
                    self.log.info("radio.handsfree", "on=true");
                    let r = self.record(wire, kind, "handsfree", at);
                    return self.done(r, true);
                }
                let r = self.record(wire, kind, "dictate", at);
                if let Some((key, _)) = self.resolve_wire(wire) {
                    self.pointed = Some(key.clone());
                    self.log.info("dictation.armed", "");
                    self.post(Act::Focus { key }, r);
                } else {
                    self.done(r, false);
                }
            }
            VerbEvent::HoldStart { wire, at } => {
                if wire == nl {
                    // deep work fires at the threshold: a filter you are
                    // flicking answers under the finger.
                    self.deep_work = !self.deep_work;
                    self.log.info("deepwork", &format!("on={}", self.deep_work));
                    let r = self.record(wire, kind, "deepwork", at);
                    return self.done(r, true);
                }
                if wire == k0 {
                    let r = self.record(wire, kind, "talk", at);
                    return self.done(r, true);
                }
                if wire == dot {
                    // decision 79: a hold on dot marks the top call read.
                    let top = self.fleet.top_call().map(|t| t.key.clone());
                    let Some(key) = top else {
                        let r = self.record(wire, kind, "read", at);
                        return self.done(r, true);
                    };
                    self.fleet.marked_read(&key);
                    let mut r = self.record(wire, kind, "read", at);
                    r.serving = Some("markRead");
                    r.session = Some(key.clone());
                    return self.post(Act::Read { key }, r);
                }
                let Some((key, _)) = self.resolve_wire(wire) else {
                    let r = self.record(wire, kind, "empty", at);
                    return self.done(r, true);
                };
                self.held_seat = Some(HeldSeat { key, wire });
                let r = self.record(wire, kind, "queue", at);
                self.done(r, true);
            }
            VerbEvent::HoldEnd { wire, at, .. } => {
                self.held_seat = None;
                let target = if wire == k0 {
                    "talk"
                } else if wire == nl {
                    "deepwork"
                } else if wire == dot {
                    "read"
                } else {
                    "queue"
                };
                let r = self.record(wire, kind, target, at);
                self.done(r, true);
            }
        }
    }

    fn act_pit(&mut self, verb: &VerbEvent, wire: u8, kind: &'static str, at: u64) {
        let Some(stage) = self.pit.clone() else {
            return;
        };
        if !matches!(verb, VerbEvent::Tap { .. } | VerbEvent::Double { .. }) {
            let r = self.record(wire, kind, "pit", at);
            return self.done(r, true);
        }
        if wire == Key::Min.wire() {
            // skip: back to drive, the next need surfaces by rank. the key
            // event names the bank the skip left the board in, as v1's did
            // (permission-pit's trace: target skip, bank drive).
            self.pit = None;
            self.bank = Bank::Drive;
            let r = self.record(wire, kind, "skip", at);
            return self.done(r, true);
        }
        let mut r = self.record(wire, kind, "pit", at);
        r.session = Some(stage.key.clone());
        match stage.ask.kind {
            AskKind::Permission => {
                let answer = if wire == Key::K1.wire() {
                    Answer::Once
                } else if wire == Key::K2.wire() {
                    Answer::Always
                } else if wire == Key::K3.wire() {
                    Answer::Reject
                } else {
                    return self.done(r, true);
                };
                if answer == Answer::Reject
                    && (stage.reject_armed_until == 0 || at > stage.reject_armed_until)
                {
                    if let Some(pit) = &mut self.pit {
                        pit.reject_armed_until = at + self.settings.timings.reject_arm_ms;
                    }
                    r.target = "arm";
                    return self.done(r, true);
                }
                r.target = "permission";
                r.serving = Some("replyPermission");
                self.post(
                    Act::Reply {
                        key: stage.key,
                        ask: stage.ask.id,
                        answer,
                    },
                    r,
                );
            }
            AskKind::Question => {
                let idx = DIGIT_WIRES.iter().position(|k| k.wire() == wire);
                let Some(idx) = idx.filter(|&i| i < stage.ask.options.len()) else {
                    return self.done(r, true);
                };
                r.target = "question";
                r.serving = Some("answerQuestion");
                let index = u8::try_from(idx).unwrap_or(u8::MAX);
                self.post(
                    Act::Reply {
                        key: stage.key,
                        ask: stage.ask.id,
                        answer: Answer::Option { index },
                    },
                    r,
                );
            }
        }
    }

    fn cycle_bank(&mut self, wire: u8, kind: &'static str, at: u64) {
        self.bank = if self.bank == Bank::Drive {
            Bank::Fleet
        } else {
            Bank::Drive
        };
        self.log.info("bank", &format!("bank={}", self.bank.word()));
        let r = self.record(wire, kind, "bank", at);
        self.done(r, true);
    }

    fn readback(&mut self, wire: u8, kind: &'static str, at: u64) {
        let words = match self.fleet.top_call() {
            None => {
                let working = self.rows().iter().filter(|r| r.1 == RowKind::Live).count();
                match working {
                    0 => "all quiet".to_owned(),
                    1 => "all quiet, 1 thread working".to_owned(),
                    n => format!("all quiet, {n} threads working"),
                }
            }
            Some(call) => {
                let waited = self.fleet.waited(call, at);
                let minutes = (waited + 30_000) / 60_000;
                let what = match call.need {
                    Some(Need::Permission) => "wants permission",
                    Some(Need::Question) => "has a question",
                    Some(Need::Fault) => "hit a fault",
                    Some(Need::Review) => "wants review",
                    _ => "has news",
                };
                let title = call.title.as_deref().unwrap_or("a thread");
                let s = if minutes == 1 { "" } else { "s" };
                format!("{title} {what}, waiting {minutes} minute{s}")
            }
        };
        self.effects.push(Effect::Say(words));
        let r = self.record(wire, kind, "radio", at);
        self.done(r, true);
    }

    fn push_liveries(&mut self) {
        for (slot, rgb) in self.liveries.pending() {
            self.effects.push(Effect::Palette { slot, rgb });
        }
    }

    /// after every input: the page snaps home if the list shrank under it,
    /// and the seat map posts if it changed. never on a clock.
    fn settle(&mut self) {
        if self.page >= self.page_count() {
            self.page = 0;
        }
        if !(self.connected && self.stream_up && self.fleet.has_view()) {
            return;
        }
        let seats = self.seat_map();
        if self.posted_seats.as_ref() != Some(&seats) {
            self.posted_seats = Some(seats.clone());
            self.effects.push(Effect::Act {
                act: Act::Seats { seats },
                after: After::Nothing,
            });
        }
    }

    // ——— geometry: v1's placement, against the server's order ———

    /// the bound digit keys and their threads, in wire order.
    #[must_use]
    pub fn bound_wires(&self) -> Vec<(Key, String)> {
        let mut out: Vec<(Key, String)> = self
            .fleet
            .view()
            .bindings
            .iter()
            .filter_map(|b| Some((Key::from_wire(b.wire)?, b.key.clone())))
            .filter(|(k, _)| DIGIT_WIRES.contains(k))
            .collect();
        out.sort_by_key(|(k, _)| k.wire());
        out
    }

    fn is_bound(&self, key: &str) -> bool {
        self.fleet.view().bindings.iter().any(|b| b.key == key)
    }

    /// the digit keys the automatic queue may seat on: every one not held
    /// by a binding, in digit order (rank n is the key whose cap says n).
    #[must_use]
    pub fn seat_wires(&self) -> Vec<u8> {
        let bindings = &self.fleet.view().bindings;
        DIGIT_WIRES
            .iter()
            .map(|k| k.wire())
            .filter(|w| !bindings.iter().any(|b| b.wire == *w))
            .collect()
    }

    /// the queue: unbound threads with a need or a running turn, in the
    /// server's order. a quiet unbound thread is not the board's (the server
    /// never sends one).
    #[must_use]
    pub fn rows(&self) -> Vec<(&Thread, RowKind)> {
        self.fleet
            .view()
            .threads
            .iter()
            .filter(|t| !self.is_bound(&t.key))
            .filter_map(|t| {
                if t.need.is_some() {
                    Some((t, RowKind::Need))
                } else if t.working {
                    Some((t, RowKind::Live))
                } else {
                    None
                }
            })
            .collect()
    }

    #[must_use]
    pub fn page_count(&self) -> usize {
        let per = self.seat_wires().len();
        if per == 0 {
            return 1;
        }
        self.rows().len().div_ceil(per).max(1)
    }

    /// the wire that draws this thread now: its bound key, else its slot on
    /// the current page, else none (paged out).
    #[must_use]
    pub fn wire_for_key(&self, key: &str) -> Option<u8> {
        if let Some((k, _)) = self.bound_wires().into_iter().find(|(_, b)| b == key) {
            return Some(k.wire());
        }
        let wires = self.seat_wires();
        let idx = self.rows().iter().position(|(t, _)| t.key == key)?;
        let on_page = idx.checked_sub(self.page * wires.len())?;
        wires.get(on_page).copied()
    }

    /// what a wire addresses now: a thread key, with the thread when the view
    /// carries it.
    #[must_use]
    pub fn resolve_wire(&self, wire: u8) -> Option<(String, Option<&Thread>)> {
        if let Some((_, key)) = self
            .bound_wires()
            .into_iter()
            .find(|(k, _)| k.wire() == wire)
        {
            let thread = self.fleet.thread(&key);
            return Some((key, thread));
        }
        let wires = self.seat_wires();
        let slot = wires.iter().position(|w| *w == wire)?;
        let rows = self.rows();
        let (thread, _) = rows.get(self.page * wires.len() + slot)?;
        Some((thread.key.clone(), Some(*thread)))
    }

    /// the digits the board shows now, for the badges on its mac: bound keys
    /// on every page, and the current page's seats.
    #[must_use]
    pub fn seat_map(&self) -> Vec<WireSeat> {
        let digit = |wire: u8| {
            DIGIT_WIRES
                .iter()
                .position(|k| k.wire() == wire)
                .and_then(|i| u8::try_from(i + 1).ok())
        };
        let mut seats: Vec<WireSeat> = self
            .bound_wires()
            .into_iter()
            .filter_map(|(k, key)| {
                Some(WireSeat {
                    key,
                    digit: digit(k.wire())?,
                    bound: true,
                })
            })
            .collect();
        let wires = self.seat_wires();
        let rows = self.rows();
        let start = self.page * wires.len();
        for (i, wire) in wires.iter().enumerate() {
            let Some((thread, _)) = rows.get(start + i) else {
                break;
            };
            if let Some(d) = digit(*wire) {
                seats.push(WireSeat {
                    key: thread.key.clone(),
                    digit: d,
                    bound: false,
                });
            }
        }
        seats.sort_by_key(|s| s.digit);
        seats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_posts_gone_before_the_dark_frame_then_flushes_and_drains() {
        assert_eq!(
            stop_steps(true, true),
            vec![
                StopStep::PostGone,
                StopStep::DarkFrame,
                StopStep::FlushTelemetry,
                StopStep::Drain
            ]
        );
        assert_eq!(stop_steps(true, false), vec![StopStep::DarkFrame]);
        assert!(stop_steps(false, false).is_empty());
    }
}
