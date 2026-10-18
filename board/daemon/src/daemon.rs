//! the main loop: one thread owns all state and sleeps on a bounded channel
//! until the next message or the next deadline. with no board there is no
//! deadline and nothing else running but the watcher, so it sleeps until
//! macos says the keypad arrived. nothing runs at 60 hz.

use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use boxbox_board_wire::{Act, Frame};
use serde_json::{Map, Value, json};

use crate::audio::{self, Meter};
use crate::config::Config;
use crate::controller::{
    After, Controller, Effect, KeyRecord, STOP_WAIT_MS, Settings, StopStep, stop_steps,
};
use crate::device::{self, Link};
use crate::log::Log;
use crate::net::{self, Auth, Job, Session, Setup};
use crate::paint::Painter;
use crate::protocol::{
    BoardMessage, Cells, DARK_FRAME, ModeReason, REPORT_LEN, Report, frame_report, hello_report,
    palette_report, parse_board_report,
};
use crate::render;
use crate::telemetry::{self, Event};
use crate::wake;

/// the main channel: reports, frames, answers and meter windows. a meter
/// window that finds it full is dropped; everything else waits.
pub const CHANNEL: usize = 256;
/// the board answers a hello within this, or the hello goes again.
pub const HELLO_WAIT_MS: u64 = 2_000;
/// a board that never answers is asked again at most this rarely.
pub const HELLO_RETRY_CAP_MS: u64 = 64_000;
pub const PERF_EVERY_MS: u64 = 60 * 60_000;

#[derive(Debug)]
pub enum Msg {
    Plugged {
        generation: u64,
        link: Link,
    },
    Report {
        generation: u64,
        report: [u8; REPORT_LEN],
    },
    Unplugged {
        generation: u64,
    },
    StreamConnecting {
        generation: u64,
    },
    /// another board stream took over this one: down until the next plug.
    StreamReplaced {
        generation: u64,
    },
    /// the daemon cannot do its job (no hid notifications): exit non-zero,
    /// so launchd brings it back under its throttle, rather than idle blind.
    Fatal {
        what: &'static str,
    },
    StreamUp {
        generation: u64,
    },
    StreamDown {
        generation: u64,
    },
    Frame {
        generation: u64,
        frame: Box<Frame>,
    },
    Answered {
        after: After,
        ok: bool,
        ms: u64,
    },
    TelemetryRefused(Vec<Event>),
    MeterWindow {
        talk: u64,
        rms: f64,
    },
    MeterUnavailable {
        talk: u64,
    },
    /// sigterm or sigint: launchd stopping the agent (an upgrade, uninstall).
    Stop {
        signal: i32,
    },
    /// the perf thread's sample: resident kib, cpu ms, footprint kib.
    Perf {
        rss_kib: u64,
        cpu_ms: u64,
        footprint_kib: Option<u64>,
        plugged: bool,
    },
}

#[derive(Debug)]
enum Hello {
    Waiting { deadline: u64, wait: u64 },
    Acked,
}

#[derive(Debug)]
struct Board {
    generation: u64,
    link: Link,
    hello: Hello,
    net: Option<Session>,
    cells: Cells,
    stream: &'static str,
}

#[derive(Debug)]
struct Perf {
    next: u64,
    wall: u64,
    cpu_ms: u64,
}

pub struct Daemon {
    cfg: Config,
    log: Log,
    epoch: Instant,
    tx: SyncSender<Msg>,
    rx: Receiver<Msg>,
    controller: Controller,
    painter: Painter,
    board: Option<Board>,
    telemetry: telemetry::Queue,
    auth: Arc<Auth>,
    device_id: String,
    meter_source: audio::Source,
    meter: Option<Meter>,
    talk: u64,
    reconnects: u64,
    /// the brightness for this hour, and when (wall ms) the hour ends.
    brightness: (u8, u64),
    /// a message arrived since the last frame was composed.
    dirty: bool,
    /// when the composed frame next changes without a message: a scene step,
    /// a blink, a crossing. the animation and keepalive wakes in between
    /// reuse the frame and only stream the palette.
    frame_due: u64,
    perf: Perf,
}

impl std::fmt::Debug for Daemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Daemon")
            .field("board", &self.board)
            .finish_non_exhaustive()
    }
}

/// the daemon stopped because it cannot do its job.
#[derive(Debug, thiserror::Error)]
#[error("cannot run: {0}")]
pub struct Fatal(pub &'static str);

#[must_use]
pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

impl Daemon {
    /// # Errors
    /// the watcher thread could not start.
    pub fn start(cfg: Config, log: Log) -> std::io::Result<Self> {
        let (tx, rx) = sync_channel(CHANNEL);
        device::watch(device::Source::from_env(), tx.clone(), log.clone())?;
        watch_signals(tx.clone())?;
        let device_id = device_id(&cfg, &log);
        let auth = Arc::new(Auth::new(
            cfg.origin.clone(),
            cfg.password_file.clone(),
            &cfg.state_dir,
            log.clone(),
        ));
        let controller = Controller::new(
            Settings {
                timings: cfg.timings.clone(),
                mic_meter: cfg.mic_meter,
            },
            log.clone(),
        );
        let cpu_ms = sample().map_or(0, |s| s.1);
        let daemon = Self {
            log,
            epoch: Instant::now(),
            tx,
            rx,
            controller,
            painter: Painter::new(),
            board: None,
            telemetry: telemetry::Queue::default(),
            auth,
            device_id,
            meter_source: audio::Source::from_env(),
            meter: None,
            talk: 0,
            reconnects: 0,
            brightness: (255, 0),
            dirty: true,
            frame_due: 0,
            perf: Perf {
                next: u64::MAX,
                wall: wall_ms(),
                cpu_ms,
            },
            cfg,
        };
        daemon.write_status();
        Ok(daemon)
    }

    fn now(&self) -> u64 {
        u64::try_from(self.epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// runs until the watcher's channel closes.
    /// # Errors
    /// a fatal message: the watcher could not watch.
    pub fn run(mut self) -> Result<(), Fatal> {
        self.log.info(
            "daemon.up",
            &format!(
                "version={} device={}",
                env!("CARGO_PKG_VERSION"),
                self.device_id
            ),
        );
        loop {
            let now = self.now();
            let got = match self.deadline() {
                None => self.rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                Some(at) => self
                    .rx
                    .recv_timeout(Duration::from_millis(at.saturating_sub(now))),
            };
            let mut stop = None;
            match got {
                Ok(Msg::Stop { signal }) => stop = Some(signal),
                Ok(Msg::Fatal { what }) => return Err(self.fatal(what)),
                Ok(msg) => self.handle(msg),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
            // drain what else is waiting before drawing once.
            while stop.is_none()
                && let Ok(msg) = self.rx.try_recv()
            {
                match msg {
                    Msg::Stop { signal } => stop = Some(signal),
                    Msg::Fatal { what } => return Err(self.fatal(what)),
                    msg => self.handle(msg),
                }
            }
            if let Some(signal) = stop {
                self.stop(signal);
                return Ok(());
            }
            self.step();
        }
    }

    fn deadline(&self) -> Option<u64> {
        let board = self.board.as_ref()?;
        let (hello, perf) = match board.hello {
            Hello::Waiting { deadline, .. } => (Some(deadline), None),
            Hello::Acked => (None, Some(self.perf.next)),
        };
        wake::next(&wake::Deadlines {
            plugged: true,
            has_net: board.net.is_some(),
            hello,
            perf,
            frame: self.frame_due,
            paint: self.painter.next_deadline(&board.cells),
            telemetry: self.telemetry.deadline(),
        })
    }

    fn fatal(&mut self, what: &'static str) -> Fatal {
        self.log.error("daemon.fatal", &format!("what={what}"));
        self.unplugged("fatal");
        Fatal(what)
    }

    fn handle(&mut self, msg: Msg) {
        let now = self.now();
        self.dirty = true;
        match msg {
            Msg::Plugged { generation, link } => self.plugged(generation, link, now),
            Msg::Report { generation, report } => {
                if self
                    .board
                    .as_ref()
                    .is_some_and(|b| b.generation == generation)
                {
                    self.report(&report, now);
                }
            }
            Msg::Unplugged { generation } => {
                if self
                    .board
                    .as_ref()
                    .is_some_and(|b| b.generation == generation)
                {
                    self.unplugged("unplugged");
                }
            }
            Msg::StreamReplaced { generation } => {
                if self.stream_state(generation, "replaced") {
                    self.controller.on_stream_down(wall_ms());
                }
            }
            Msg::StreamConnecting { generation } => {
                self.stream_state(generation, "connecting");
            }
            Msg::StreamUp { generation } => {
                if self.stream_state(generation, "up") {
                    self.controller.on_stream_up();
                }
            }
            Msg::StreamDown { generation } => {
                if self.stream_state(generation, "connecting") {
                    self.controller.on_stream_down(wall_ms());
                }
            }
            Msg::Frame { generation, frame } => {
                if self
                    .board
                    .as_ref()
                    .is_none_or(|b| b.generation != generation)
                {
                    return;
                }
                match *frame {
                    Frame::View(view) => self.controller.on_view(view, now, wall_ms()),
                    Frame::Pin {
                        key,
                        color,
                        expires_in_ms,
                    } => self.controller.on_pin(key, color, expires_in_ms, now),
                    Frame::Hello { .. } | Frame::Replaced => {}
                }
            }
            Msg::Answered { after, ok, ms } => self.answered(after, ok, ms),
            Msg::TelemetryRefused(events) => self.telemetry.restore(events, now),
            Msg::MeterWindow { talk, rms } => {
                if talk == self.talk && self.meter.is_some() {
                    self.controller.on_meter_window(rms, now);
                }
            }
            Msg::MeterUnavailable { talk } => {
                if talk == self.talk {
                    self.meter = None;
                    self.controller.on_meter_unavailable();
                }
            }
            Msg::Perf {
                rss_kib,
                cpu_ms,
                footprint_kib,
                plugged,
            } => self.perf_emit(rss_kib, cpu_ms, footprint_kib, plugged, now),
            // handled by the loop before it gets here.
            Msg::Stop { .. } | Msg::Fatal { .. } => {}
        }
    }

    /// a stop: the part of an unplug that fits in a moment, then return.
    fn stop(&mut self, signal: i32) {
        self.log
            .info("daemon.stopping", &format!("signal={signal}"));
        let now = self.now();
        let Some(mut board) = self.board.take() else {
            return;
        };
        let acked = matches!(board.hello, Hello::Acked);
        let mut net = board.net.take();
        for step in stop_steps(true, acked) {
            match step {
                StopStep::PostGone => {
                    if let Some(net) = &net {
                        let _ = net.post(Job::Act {
                            act: Act::Gone,
                            after: After::Nothing,
                            at: now,
                        });
                    }
                }
                StopStep::DarkFrame => {
                    if let Ok(report) = frame_report(&DARK_FRAME) {
                        let _ = board.link.write(&report);
                    }
                }
                StopStep::FlushTelemetry => {
                    let batch = self.telemetry.take();
                    if let Some(net) = &net
                        && !batch.is_empty()
                    {
                        let _ = net.post(Job::Telemetry(batch));
                    }
                }
                StopStep::Drain => {
                    if let Some(net) = net.take() {
                        net.finish(Duration::from_millis(STOP_WAIT_MS));
                    }
                }
            }
        }
        if let Some(net) = net {
            net.close();
        }
        self.write_status();
    }

    fn stream_state(&mut self, generation: u64, state: &'static str) -> bool {
        let Some(board) = self.board.as_mut().filter(|b| b.generation == generation) else {
            return false;
        };
        board.stream = state;
        self.write_status();
        true
    }

    fn plugged(&mut self, generation: u64, link: Link, now: u64) {
        if self.board.is_some() {
            self.unplugged("replaced");
        }
        self.log.info("board.plugged", "");
        self.painter.connected();
        let mut board = Board {
            generation,
            link,
            hello: Hello::Waiting {
                deadline: now + HELLO_WAIT_MS,
                wait: HELLO_WAIT_MS,
            },
            net: None,
            cells: DARK_FRAME,
            stream: "off",
        };
        if board.link.write(&hello_report()).is_err() {
            self.log.warn("board.hello_failed", "");
        }
        self.painter.wrote(now);
        self.board = Some(board);
        self.refresh_brightness();
        self.dirty = true;
        self.write_status();
    }

    fn report(&mut self, report: &[u8], now: u64) {
        match parse_board_report(report) {
            BoardMessage::Hello { fw, proto, mode } => self.acked(fw, proto, mode, now),
            BoardMessage::Key { wire, down } => {
                if self.acked_board() {
                    self.controller.on_key(wire, down, now);
                }
            }
            BoardMessage::Mode { mode, reason } => {
                self.log
                    .info("board.mode", &format!("mode={mode} reason={reason:?}"));
                if reason == ModeReason::Watchdog {
                    // the board decided the daemon was dead. a recurring trip
                    // is a keepalive bug, not noise.
                    self.log.error("board.watchdog_tripped", "");
                }
                if self.acked_board() {
                    self.controller.on_mode(mode);
                }
            }
            BoardMessage::Unknown { op } => {
                self.log.warn("board.unknown_op", &format!("op={op:?}"));
            }
        }
    }

    fn acked_board(&self) -> bool {
        self.board
            .as_ref()
            .is_some_and(|b| matches!(b.hello, Hello::Acked))
    }

    /// the hello came back: the palette, the liveries, the brightness, the
    /// stream, and the formation lap once the first view lands.
    fn acked(&mut self, fw: u8, proto: u8, mode: u8, now: u64) {
        let Some(board) = self.board.as_mut() else {
            return;
        };
        if matches!(board.hello, Hello::Acked) {
            // a second ack (a firmware reset): the board lost its palette.
            self.painter.connected();
        }
        board.hello = Hello::Acked;
        self.log.info(
            "board.connected",
            &format!("fw={fw} proto={proto} mode={mode}"),
        );
        let mut failed = false;
        for r in Painter::reserved_palette() {
            failed |= board.link.write(&r).is_err();
        }
        self.painter.wrote(now);
        if failed {
            self.unplugged("write_failed");
            return;
        }
        self.controller.on_hello(mode, now);
        self.refresh_brightness();
        if board_net_missing(self.board.as_ref()) {
            match Session::start(Setup {
                auth: self.auth.clone(),
                device: self.device_id.clone(),
                addrs: net::local_addrs(),
                generation: self.board.as_ref().map_or(0, |b| b.generation),
                tx: self.tx.clone(),
                log: self.log.clone(),
                epoch: self.epoch,
            }) {
                Ok(session) => {
                    if let Some(b) = self.board.as_mut() {
                        b.net = Some(session);
                    }
                }
                Err(e) => self.log.error("net.start_failed", &format!("error={e}")),
            }
        }
        let mut props = Map::new();
        props.insert("fw".into(), json!(fw));
        props.insert("proto".into(), json!(proto));
        props.insert("reconnects".into(), json!(self.reconnects));
        self.reconnects += 1;
        self.emit(Event::new("board.connect", wall_ms(), props), now);
        // what the daemon cost while the board was away.
        self.perf_sample(now, false);
        self.perf.next = now + PERF_EVERY_MS;
        self.write_status();
    }

    /// unplugged, or the link failed: tell the server, close the stream,
    /// stop the meter and clear what the board held.
    fn unplugged(&mut self, why: &str) {
        let Some(mut board) = self.board.take() else {
            return;
        };
        self.log.info("board.gone", &format!("why={why}"));
        self.perf.next = u64::MAX;
        if why == "write_failed" {
            // the keypad may still be plugged in: the watcher drops it and
            // looks again, backing off.
            board.link.failed();
        }
        let now = self.now();
        self.controller.on_unplug(wall_ms());
        let effects = self.controller.take_effects();
        for e in effects {
            if matches!(e, Effect::MeterStop) {
                self.meter = None;
                audio::note(&self.meter_source, "stop");
            }
        }
        if let Some(net) = board.net.take() {
            let _ = net.post(Job::Act {
                act: Act::Gone,
                after: After::Nothing,
                at: now,
            });
            let batch = self.telemetry.take();
            if !batch.is_empty() {
                let _ = net.post(Job::Telemetry(batch));
            }
            net.close();
        }
        self.write_status();
    }

    /// after every wake: the clock's deadlines, the effects, one frame.
    fn step(&mut self) {
        let now = self.now();
        let Some(board) = self.board.as_mut() else {
            return;
        };
        // a board that has not answered is asked again, backing off; it is
        // drawn all the same, as v1 did, so the first frame precedes the
        // palette.
        if let Hello::Waiting { deadline, wait } = board.hello
            && now >= deadline
        {
            let wait = (wait * 2).min(HELLO_RETRY_CAP_MS);
            board.hello = Hello::Waiting {
                deadline: now + wait,
                wait,
            };
            let _ = board.link.write(&hello_report());
            self.log
                .warn("board.hello_timeout", &format!("retry_ms={wait}"));
        }
        let mut reports: Vec<Report> = Vec::new();
        let cells = if self.dirty || now >= self.frame_due {
            self.dirty = false;
            self.controller.tick(now);
            let effects = self.controller.take_effects();
            for e in effects {
                self.effect(e, now, &mut reports);
            }
            if wall_ms() >= self.brightness.1 {
                self.refresh_brightness();
            }
            let cells = render::compose(&mut self.controller, now);
            let to_hour = self.brightness.1.saturating_sub(wall_ms()).max(1);
            self.frame_due = [
                self.controller.next_deadline(now),
                render::next_blink(&self.controller, now),
                Some(now + to_hour),
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(u64::MAX);
            cells
        } else {
            self.board.as_ref().map_or(DARK_FRAME, |b| b.cells)
        };
        reports.extend(self.painter.paint(&cells, now, self.brightness.0));
        let failed = match self.board.as_mut() {
            Some(board) => {
                board.cells = cells;
                reports.iter().any(|r| board.link.write(r).is_err())
            }
            None => false,
        };
        if failed {
            self.unplugged("write_failed");
            return;
        }
        if now >= self.perf.next {
            self.perf_sample(now, true);
            self.perf.next = now + PERF_EVERY_MS;
        }
        self.flush_telemetry(now);
    }

    fn effect(&mut self, effect: Effect, now: u64, reports: &mut Vec<Report>) {
        match effect {
            Effect::Act { act, after } => {
                let posted = self.board.as_ref().and_then(|b| b.net.as_ref()).map(|net| {
                    net.post(Job::Act {
                        act,
                        after,
                        at: now,
                    })
                });
                if let Some(Err(job)) = posted {
                    self.log.warn("net.queue_full", "");
                    if let Job::Act { after, .. } = *job {
                        self.answered(after, false, 0);
                    }
                }
            }
            Effect::Key { record, ok } => self.record_key(record, ok, 0),
            Effect::Say(words) => self.say(&words),
            Effect::MeterStart => {
                self.talk += 1;
                audio::note(&self.meter_source, "start");
                self.meter = audio::start(&self.meter_source, self.talk, &self.tx, &self.log);
                if self.meter.is_none() {
                    self.controller.on_meter_unavailable();
                }
            }
            Effect::MeterStop => {
                self.meter = None;
                audio::note(&self.meter_source, "stop");
            }
            Effect::Palette { slot, rgb } => reports.push(palette_report(slot, rgb)),
        }
    }

    fn answered(&mut self, after: After, ok: bool, ms: u64) {
        match after {
            After::Nothing => {}
            After::Key(record) => self.record_key(record, ok, ms),
            After::Bind { wire, key } => {
                self.log.info("pin.bound", &format!("wire={wire} ok={ok}"));
                let mut props = Map::new();
                props.insert("wire".into(), json!(wire));
                props.insert("agent".into(), json!(key));
                props.insert("bound".into(), json!(1));
                let event = Event::new("board.bind", wall_ms(), props)
                    .ok(ok)
                    .session(Some(key));
                let now = self.now();
                self.emit(event, now);
            }
        }
    }

    /// `board.key`, and for a press that serves a need the generic `verb`.
    fn record_key(&mut self, record: KeyRecord, ok: bool, ms: u64) {
        let now = self.now();
        let wall = wall_ms();
        let mut props = Map::new();
        props.insert("wire".into(), json!(record.wire));
        props.insert("verb".into(), json!(record.verb));
        props.insert("target".into(), json!(record.target));
        props.insert("bank".into(), json!(record.bank));
        self.emit(Event::new("board.key", wall, props).ok(ok).ms(ms), now);
        if let Some(name) = record.serving {
            let mut props = Map::new();
            props.insert("name".into(), Value::from(name));
            let event = Event::new("verb", wall, props)
                .ok(ok)
                .ms(ms)
                .session(record.session);
            self.emit(event, now);
        }
    }

    fn emit(&mut self, event: Event, now: u64) {
        if self.telemetry.push(event, now) {
            self.flush_now();
        }
    }

    fn flush_telemetry(&mut self, now: u64) {
        if self.telemetry.deadline().is_some_and(|d| now >= d) {
            self.flush_now();
        }
    }

    fn flush_now(&mut self) {
        let Some(net) = self.board.as_ref().and_then(|b| b.net.as_ref()) else {
            return;
        };
        let batch = self.telemetry.take();
        if let Err(job) = net.post(Job::Telemetry(batch))
            && let Job::Telemetry(batch) = *job
        {
            let now = self.now();
            self.telemetry.restore(batch, now);
        }
    }

    /// readback: `<say_command> [-v voice] <words>`, reaped by a short-lived
    /// thread when it finishes.
    fn say(&self, words: &str) {
        let mut cmd = Command::new(&self.cfg.say_command);
        if !self.cfg.voice.is_empty() {
            cmd.arg("-v").arg(&self.cfg.voice);
        }
        cmd.arg(words)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match cmd.spawn() {
            Ok(mut child) => {
                let _ = std::thread::Builder::new()
                    .name("board-say".into())
                    .spawn(move || {
                        let _ = child.wait();
                    });
            }
            Err(e) => self.log.warn("radio.say_failed", &format!("error={e}")),
        }
    }

    fn refresh_brightness(&mut self) {
        let (hour, next) = local_hour();
        self.brightness = (self.cfg.night_curve[usize::from(hour % 24)], next);
    }

    /// `perf.board`: sampled off the main loop (`ps` and `vmmap` take a
    /// moment), once an hour while plugged in and once at each plug.
    fn perf_sample(&mut self, _now: u64, plugged: bool) {
        let tx = self.tx.clone();
        let _ = std::thread::Builder::new()
            .name("board-perf".into())
            .spawn(move || {
                let Some((rss_kib, cpu_ms)) = sample() else {
                    return;
                };
                let _ = tx.try_send(Msg::Perf {
                    rss_kib,
                    cpu_ms,
                    footprint_kib: footprint_kib(),
                    plugged,
                });
            });
    }

    fn perf_emit(
        &mut self,
        rss_kib: u64,
        cpu_ms: u64,
        footprint_kib: Option<u64>,
        plugged: bool,
        now: u64,
    ) {
        let wall = wall_ms();
        let span = wall.saturating_sub(self.perf.wall).max(1);
        let used = cpu_ms.saturating_sub(self.perf.cpu_ms);
        // a percent of one core, to three decimals.
        #[allow(clippy::cast_precision_loss)]
        let cpu = (used as f64 / span as f64 * 100_000.0).round() / 1000.0;
        let mut props = Map::new();
        props.insert("rssKib".into(), json!(rss_kib));
        if let Some(footprint) = footprint_kib {
            props.insert("footprintKib".into(), json!(footprint));
        }
        props.insert("cpu".into(), json!(cpu));
        props.insert("spanMs".into(), json!(span));
        props.insert("board".into(), json!(u8::from(plugged)));
        self.perf.wall = wall;
        self.perf.cpu_ms = cpu_ms;
        self.emit(Event::new("perf.board", wall, props), now);
    }

    fn write_status(&self) {
        let status = json!({
            "pid": std::process::id(),
            "board": self.board.is_some(),
            "stream": self.board.as_ref().map_or("off", |b| b.stream),
            "since": wall_ms(),
        });
        let path = self.cfg.state_dir.join("status.json");
        if let Err(e) = net::write_private(&path, &status.to_string()) {
            self.log
                .warn("daemon.status_unsaved", &format!("error={e}"));
        }
    }
}

fn board_net_missing(board: Option<&Board>) -> bool {
    board.is_some_and(|b| b.net.is_none())
}

/// the local hour, and the wall ms when it ends.
fn local_hour() -> (u8, u64) {
    let now = jiff::Zoned::now();
    let hour = u8::try_from(now.hour()).unwrap_or(12);
    let into = u64::try_from(i64::from(now.minute()) * 60_000 + i64::from(now.second()) * 1000)
        .unwrap_or(0);
    (hour, wall_ms() + (3_600_000 - into.min(3_599_000)))
}

/// this process's resident kib and cpu ms, from `ps` (no libc: unsafe is
/// forbidden). spawned once an hour while plugged in, never idle.
#[must_use]
pub fn sample() -> Option<(u64, u64)> {
    let out = Command::new("ps")
        .args(["-o", "rss=,cputime=", "-p", &std::process::id().to_string()])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let rss = parts.next()?.parse().ok()?;
    let cpu = parse_cputime(parts.next()?)?;
    Some((rss, cpu))
}

/// this process's physical footprint in kib (what activity monitor shows as
/// memory), from `vmmap --summary`.
#[must_use]
pub fn footprint_kib() -> Option<u64> {
    let out = Command::new("vmmap")
        .args(["--summary", &std::process::id().to_string()])
        .stderr(Stdio::null())
        .output()
        .ok()?;
    parse_footprint(&String::from_utf8_lossy(&out.stdout))
}

/// `Physical footprint:  2912K` (or `1.5M`, `1G`) in kib.
#[must_use]
pub fn parse_footprint(text: &str) -> Option<u64> {
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with("Physical footprint:"))?;
    let value = line.split(':').nth(1)?.trim();
    let (num, unit) = value.split_at(value.len().checked_sub(1)?);
    let num: f64 = num.trim().parse().ok()?;
    let kib = match unit {
        "K" => num,
        "M" => num * 1024.0,
        "G" => num * 1024.0 * 1024.0,
        "B" => num / 1024.0,
        _ => return None,
    };
    // a footprint is far under 2^52 kib.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(kib.round() as u64)
}

/// sigterm and sigint become [`Msg::Stop`]; the thread blocks on
/// signal-hook's pipe, so it costs nothing until a signal comes.
fn watch_signals(tx: SyncSender<Msg>) -> std::io::Result<()> {
    use signal_hook::consts::{SIGINT, SIGTERM};
    let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT])?;
    std::thread::Builder::new()
        .name("board-signals".into())
        .spawn(move || {
            if let Some(signal) = signals.forever().next() {
                let _ = tx.send(Msg::Stop { signal });
            }
        })
        .map(|_| ())
}

/// `ps`'s cputime, `[[h:]m:]s.ff`, in ms.
#[must_use]
pub fn parse_cputime(text: &str) -> Option<u64> {
    let mut ms = 0u64;
    for part in text.split(':') {
        let (whole, frac) = part.split_once('.').unwrap_or((part, ""));
        ms = ms * 60 + whole.parse::<u64>().ok()? * 1000;
        if !frac.is_empty() {
            let frac: String = frac.chars().chain("000".chars()).take(3).collect();
            ms += frac.parse::<u64>().ok()?;
        }
    }
    Some(ms)
}

/// the daemon's device id, `board-<random>`, kept in the state dir.
fn device_id(cfg: &Config, log: &Log) -> String {
    let path = cfg.state_dir.join("device");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim();
        if !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return id.to_owned();
        }
    }
    let id = format!("board-{}", telemetry::nano(16));
    if let Err(e) = net::write_private(&path, &id) {
        log.warn("daemon.device_unsaved", &format!("error={e}"));
    }
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_footprint_parses() {
        let text =
            "Process: x\nPhysical footprint:         2912K\nPhysical footprint (peak):  3M\n";
        assert_eq!(parse_footprint(text), Some(2912));
        assert_eq!(parse_footprint("Physical footprint: 1.5M"), Some(1536));
        assert_eq!(parse_footprint("nothing"), None);
    }

    #[test]
    fn cputime_parses() {
        assert_eq!(parse_cputime("0:00.05"), Some(50));
        assert_eq!(parse_cputime("1:02.5"), Some(62_500));
        assert_eq!(parse_cputime("1:00:01.00"), Some(3_601_000));
    }
}
