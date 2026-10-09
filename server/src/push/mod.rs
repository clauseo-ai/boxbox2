//! push: the watcher that never sleeps decides who gets buzzed and buzzes
//! them (decision 7: push is the product).
//!
//! one task owns everything push knows: the subscribed devices (mirrored
//! from `boxbox.db`), presence, the "done" notices waiting out their delay,
//! each device's rate bucket and hold, and the ids recently sent. the fleet
//! (m4) feeds it notices; the http routes feed it subscriptions and
//! presence. deliveries run as their own tasks and report back, so a slow
//! push service never holds up a decision. the design is `docs/push.md`.

pub mod decide;
mod deliver;
pub mod devices;
mod limit;
pub mod notice;
pub mod payload;
pub mod presence;
pub mod vapid;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tracing::{debug, info, warn};

use crate::store::{Store, StoreError};
use decide::{Decision, Reason, Stage};
use deliver::{Outcome, Report as DeliveryReport};
use devices::Device;
use limit::{Rates, Recent};
pub use notice::{About, AskKind, Kind, KindSet, Notice, Origin, Thread};
use payload::Payload;
use presence::{Looking, Presence, Report};
use vapid::Vapid;

/// commands waiting for the push task. the fleet sends without waiting;
/// if this ever fills, the push task is wedged and the notice is dropped
/// with a warning rather than stalling the fleet.
const QUEUE: usize = 1024;
/// with nothing else due, the task still wakes this often to drop stale
/// presence.
const SWEEP: Duration = Duration::from_secs(30);
/// a need served this long after its push still counts as the push acted on.
const ACTED_WITHIN: Duration = Duration::from_secs(12 * 60 * 60);

/// the handle every route and the fleet hold. cheap to clone.
#[derive(Debug, Clone)]
pub struct Push {
    commands: mpsc::Sender<Command>,
    store: Store,
    public_key: Arc<str>,
}

#[derive(Debug)]
enum Command {
    Notify(Notice),
    Continued(Thread),
    Served {
        id: String,
        by: String,
        how: &'static str,
    },
    Presence(Report),
    Subscribed(Box<Device>),
    Unsubscribed(String),
    Test {
        device: String,
        notice: Notice,
    },
}

impl Push {
    /// the vapid public key, base64url: the browser's `applicationServerKey`.
    #[must_use]
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// hands the push task a notice to judge. never waits.
    pub fn notify(&self, notice: Notice) {
        self.send(Command::Notify(notice));
    }

    /// the agent carried on in `thread`: a "done" still waiting is dropped.
    pub fn continued(&self, thread: Thread) {
        self.send(Command::Continued(thread));
    }

    /// a person served the need behind notice `id` (by is the device, or
    /// who the daemon named): if it was pushed, the push was acted on, and
    /// `push.acted` says how long the pocket took.
    pub fn served(&self, id: String, by: String, how: &'static str) {
        self.send(Command::Served { id, by, how });
    }

    pub fn presence(&self, report: Report) {
        self.send(Command::Presence(report));
    }

    /// sends `notice` to one device only, through the same decision, rate
    /// and dedupe as any other (the settings page's test, and the harness).
    pub fn test(&self, device: String, notice: Notice) {
        self.send(Command::Test { device, notice });
    }

    /// saves a subscription and starts pushing to it; returns when the
    /// device first subscribed.
    ///
    /// # Errors
    /// the store failed; nothing changed.
    pub async fn subscribe(&self, device: Device) -> Result<i64, StoreError> {
        let since = devices::save(&self.store, &device).await?;
        let device = Device { since, ..device };
        self.send(Command::Subscribed(Box::new(device)));
        Ok(since)
    }

    /// forgets a device's subscription; true if it had one.
    ///
    /// # Errors
    /// the store failed; nothing changed.
    pub async fn unsubscribe(&self, device: &str) -> Result<bool, StoreError> {
        let removed = devices::remove(&self.store, device).await?;
        self.send(Command::Unsubscribed(device.to_owned()));
        Ok(removed)
    }

    /// every subscribed device, as stored.
    ///
    /// # Errors
    /// the store failed.
    pub async fn devices(&self) -> Result<Vec<Device>, StoreError> {
        devices::load(&self.store).await
    }

    /// a handle whose task is gone: every command is dropped. for tests of
    /// what feeds push, which judge what they fed, not what push did.
    #[cfg(test)]
    #[must_use]
    pub fn detached() -> Self {
        let (commands, _) = mpsc::channel(1);
        Self {
            commands,
            store: Store::detached(),
            public_key: "".into(),
        }
    }

    fn send(&self, command: Command) {
        if let Err(error) = self.commands.try_send(command) {
            warn!(error = %error, "the push task is not keeping up; a push command was dropped");
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("the push key: {0}")]
    Vapid(#[from] vapid::VapidError),
    #[error("the push subscriptions: {0}")]
    Store(#[from] StoreError),
}

/// loads the key (minting it on first start) and the subscriptions, and
/// starts the push task. the task stops once every handle is dropped,
/// after the deliveries in flight finish.
///
/// # Errors
/// the store could not give up the key or the subscriptions.
pub async fn spawn(
    store: Store,
    client: reqwest::Client,
    telemetry: crate::telemetry::Sender,
    contact: String,
    looking: watch::Sender<Vec<Looking>>,
) -> Result<(Push, JoinHandle<()>), StartError> {
    let (vapid, minted) = Vapid::load_or_mint(&store, contact).await?;
    let loaded = devices::load(&store).await?;
    info!(
        public_key = vapid.public_key(),
        minted,
        devices = loaded.len(),
        "push ready"
    );
    let public_key: Arc<str> = vapid.public_key().into();
    let (commands, receiver) = mpsc::channel(QUEUE);
    let actor = Actor {
        client,
        vapid: Arc::new(vapid),
        store: store.clone(),
        telemetry,
        devices: loaded.into_iter().map(|d| (d.id.clone(), d)).collect(),
        presence: Presence::default(),
        waiting: HashMap::new(),
        rates: Rates::default(),
        recent: Recent::default(),
        pushed: HashMap::new(),
        looking,
        deliveries: JoinSet::new(),
    };
    let task = tokio::spawn(actor.run(receiver));
    Ok((
        Push {
            commands,
            store,
            public_key,
        },
        task,
    ))
}

/// one push to one device, waiting for a token or in flight.
#[derive(Debug)]
struct Queued {
    notice: Arc<Notice>,
    device: String,
    tag: String,
    body: Vec<u8>,
}

struct Actor {
    client: reqwest::Client,
    vapid: Arc<Vapid>,
    store: Store,
    telemetry: crate::telemetry::Sender,
    devices: HashMap<String, Device>,
    presence: Presence,
    /// "done" notices waiting out their delay, one per thread.
    waiting: HashMap<String, (Notice, Instant)>,
    rates: Rates<Queued>,
    recent: Recent,
    /// notices pushed lately, by id: what they were about and when they
    /// went, so a need served after its push writes `push.acted`. bounded
    /// like `recent`: entries past the window go at each tick.
    pushed: HashMap<String, (Arc<Notice>, Instant)>,
    /// who is looking, for the fleet (it marks a thread on stage seen).
    looking: watch::Sender<Vec<Looking>>,
    /// bounded by the rate buckets: at most a burst per device at once.
    deliveries: JoinSet<(Queued, DeliveryReport)>,
}

impl Actor {
    async fn run(mut self, mut commands: mpsc::Receiver<Command>) {
        loop {
            let wake = self.next_wake(Instant::now());
            tokio::select! {
                command = commands.recv() => match command {
                    Some(command) => self.handle(command),
                    None => break,
                },
                Some(joined) = self.deliveries.join_next() => match joined {
                    Ok((queued, report)) => self.delivered(&queued, &report),
                    Err(error) => warn!(%error, "a push delivery task failed"),
                },
                () = tokio::time::sleep_until(wake) => self.tick(Instant::now()),
            }
        }
        // the last handle is gone: finish what is in flight (the server's
        // drain bounds this), and drop what was still waiting
        while let Some(joined) = self.deliveries.join_next().await {
            if let Ok((queued, report)) = joined {
                self.delivered(&queued, &report);
            }
        }
        if !self.waiting.is_empty() {
            info!(
                waiting = self.waiting.len(),
                "push stopped with \"done\" notices still waiting"
            );
        }
        info!("push stopped");
    }

    fn handle(&mut self, command: Command) {
        let now = Instant::now();
        match command {
            Command::Notify(notice) => self.judge(notice, Stage::Fresh, None, now),
            Command::Test { device, notice } => {
                self.judge(notice, Stage::Fresh, Some(&device), now);
            }
            Command::Continued(thread) => {
                if let Some((notice, _)) = self.waiting.remove(thread.key()) {
                    self.decided(&notice, Reason::Continued, 0);
                }
            }
            Command::Served { id, by, how } => self.acted(&id, &by, how, now),
            Command::Presence(report) => {
                self.presence.report(report, now);
                self.publish_looking(now);
                // "cancelled if you look": a waiting done whose thread is now
                // watched is dropped at once, even if the look is brief
                let watched: Vec<String> = self
                    .waiting
                    .keys()
                    .filter(|thread| self.presence.watched(thread, now))
                    .cloned()
                    .collect();
                for thread in watched {
                    if let Some((notice, _)) = self.waiting.remove(&thread) {
                        self.decided(&notice, Reason::Watched, 0);
                    }
                }
            }
            Command::Subscribed(device) => {
                info!(device = %device.id, class = %device.class, kinds = ?device.kinds.kinds(), "push subscribed");
                self.devices.insert(device.id.clone(), *device);
            }
            Command::Unsubscribed(device) => {
                if self.devices.remove(&device).is_some() {
                    info!(%device, "push unsubscribed");
                }
                self.rates.forget(&device);
            }
        }
    }

    /// runs `decide` and acts on it. `only` narrows the devices to one.
    fn judge(&mut self, notice: Notice, stage: Stage, only: Option<&str>, now: Instant) {
        let watched = self.presence.watched(notice.thread.key(), now);
        let devices = self
            .devices
            .values()
            .filter(|d| only.is_none_or(|only| d.id == only))
            .map(|d| (d.id.as_str(), d.kinds));
        match decide::decide(&notice, stage, watched, devices) {
            Decision::Drop(reason) => self.decided(&notice, reason, 0),
            Decision::Wait(delay) => {
                let thread = notice.thread.key().to_owned();
                if let Some((older, _)) = self.waiting.insert(thread, (notice, now + delay)) {
                    // a newer "done" for the thread: the agent carried on
                    self.decided(&older, Reason::Continued, 0);
                }
            }
            Decision::Send(targets) => self.send(notice, &targets, now),
        }
    }

    fn send(&mut self, notice: Notice, targets: &[String], now: Instant) {
        let notice = Arc::new(notice);
        let sent_at = crate::now_ms();
        let tag = payload::tag(notice.thread.key());
        let mut queued = 0;
        for device in targets {
            if !self.recent.first_time(device, &notice.id, now) {
                debug!(%device, id = %notice.id, "already sent to this device; skipped");
                continue;
            }
            let class = self
                .devices
                .get(device)
                .map_or("desktop", |d| d.class.as_str());
            let Some(body) = Payload::new(&notice, device, class, sent_at).to_bytes() else {
                warn!(id = %notice.id, "a push payload did not fit 3 kb; not sent");
                continue;
            };
            queued += 1;
            self.enqueue(
                Queued {
                    notice: Arc::clone(&notice),
                    device: device.clone(),
                    tag: tag.clone(),
                    body,
                },
                now,
            );
        }
        let reason = if queued == 0 {
            Reason::Duplicate
        } else {
            self.pushed
                .insert(notice.id.clone(), (Arc::clone(&notice), now));
            Reason::Sent
        };
        self.decided(&notice, reason, queued);
    }

    /// through the device's hold, so a paced device keeps arrival order and
    /// the newest per thread.
    fn enqueue(&mut self, queued: Queued, now: Instant) {
        let device = queued.device.clone();
        let limits = self.rates.of(&device, now);
        if let Some(replaced) = limits.hold.put(&queued.tag.clone(), queued) {
            debug!(%device, id = %replaced.notice.id, "a waiting push was replaced by newer news or the hold's cap");
        }
        self.release(&device, now);
    }

    fn release(&mut self, device: &str, now: Instant) {
        let mut ready = Vec::new();
        let limits = self.rates.of(device, now);
        while !limits.hold.is_empty() && limits.bucket.take(now) {
            ready.extend(limits.hold.next());
        }
        for queued in ready {
            self.start(queued);
        }
    }

    fn start(&mut self, queued: Queued) {
        let Some(device) = self.devices.get(&queued.device).cloned() else {
            debug!(device = %queued.device, "unsubscribed before its push went out");
            return;
        };
        let client = self.client.clone();
        let vapid = Arc::clone(&self.vapid);
        self.deliveries.spawn(async move {
            let kind = queued.notice.about.kind();
            let report =
                deliver::deliver(&client, &vapid, &device, kind, &queued.tag, &queued.body).await;
            (queued, report)
        });
    }

    fn tick(&mut self, now: Instant) {
        let due: Vec<String> = self
            .waiting
            .iter()
            .filter(|(_, (_, at))| *at <= now)
            .map(|(thread, _)| thread.clone())
            .collect();
        for thread in due {
            if let Some((notice, _)) = self.waiting.remove(&thread) {
                self.judge(notice, Stage::Delayed, None, now);
            }
        }
        let held: Vec<String> = self.rates.iter_mut().map(|(d, _)| d.clone()).collect();
        for device in held {
            self.release(&device, now);
        }
        if self.presence.sweep(now) > 0 {
            self.publish_looking(now);
        }
        self.pushed
            .retain(|_, (_, at)| now.saturating_duration_since(*at) <= ACTED_WITHIN);
    }

    /// tells the fleet who is looking now; it only hears of a change.
    fn publish_looking(&self, now: Instant) {
        let devices = &self.devices;
        let looking = self.presence.looking(now, crate::now_ms(), |device| {
            devices
                .get(device)
                .map(|d| d.class.clone())
                .unwrap_or_default()
        });
        self.looking.send_if_modified(|held| {
            if *held == looking {
                return false;
            }
            *held = looking;
            true
        });
    }

    /// a need that was pushed was served by a person: one `push.acted` row.
    fn acted(&mut self, id: &str, by: &str, how: &str, now: Instant) {
        let Some((notice, at)) = self.pushed.remove(id) else {
            return;
        };
        let ms = u64::try_from(now.saturating_duration_since(at).as_millis()).unwrap_or(u64::MAX);
        info!(id, by, how, after_ms = ms, "a pushed need was served");
        self.telemetry.record(&json!({
            "kind": "push.acted",
            "host": notice.thread.host(),
            "session": notice.thread.key(),
            "ok": true,
            "ms": ms,
            "props": {
                "need": notice.about.need(),
                "tag": payload::tag(notice.thread.key()),
                "id": notice.id,
                "by": by,
                "how": how,
            },
        }));
    }

    fn next_wake(&self, now: Instant) -> Instant {
        let sweep = now + SWEEP;
        self.waiting
            .values()
            .map(|(_, at)| *at)
            .chain(self.rates.next_release(now))
            .fold(sweep, Instant::min)
    }

    fn delivered(&mut self, queued: &Queued, report: &DeliveryReport) {
        let notice = &queued.notice;
        let device = queued.device.as_str();
        let ms = u64::try_from(report.latency.as_millis()).unwrap_or(u64::MAX);
        let (ok, status) = match &report.outcome {
            Outcome::Accepted { status } => {
                info!(%device, id = %notice.id, need = notice.about.need(), status, attempts = report.attempts, latency_ms = ms, "push accepted by the push service");
                (true, Some(*status))
            }
            Outcome::Gone { status } => {
                warn!(%device, id = %notice.id, status, "the push service says this subscription is gone; forgetting the device");
                self.forget(device);
                (false, Some(*status))
            }
            Outcome::Failed { status, detail } => {
                warn!(%device, id = %notice.id, status = ?status, attempts = report.attempts, latency_ms = ms, detail = %detail, "push not delivered");
                (false, *status)
            }
        };
        self.telemetry.record(&json!({
            "kind": "push.sent",
            "host": notice.thread.host(),
            "session": notice.thread.key(),
            "ok": ok,
            "ms": ms,
            "props": {
                "need": notice.about.need(),
                "tag": queued.tag,
                "subs": 1,
                "target": device,
                "status": status,
                "attempts": report.attempts,
                "id": notice.id,
            },
        }));
    }

    fn forget(&mut self, device: &str) {
        self.devices.remove(device);
        self.rates.forget(device);
        let store = self.store.clone();
        let device = device.to_owned();
        tokio::spawn(async move {
            if let Err(error) = devices::remove(&store, &device).await {
                warn!(%device, %error, "a gone subscription could not be removed; it is retried at the next push");
            }
        });
    }

    fn decided(&self, notice: &Notice, reason: Reason, devices: usize) {
        info!(id = %notice.id, thread = notice.thread.key(), need = notice.about.need(), reason = reason.as_str(), devices, "push decided");
        self.telemetry.record(&json!({
            "kind": "push.decided",
            "host": notice.thread.host(),
            "session": notice.thread.key(),
            "props": {
                "reason": reason.as_str(),
                "need": notice.about.need(),
                "tag": payload::tag(notice.thread.key()),
                "devices": devices,
                "id": notice.id,
            },
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(id: &str, about: About, thread: &str, origin: Origin) -> Notice {
        Notice {
            id: id.into(),
            about,
            thread: Thread::parse(thread).unwrap(),
            title: "api is done".into(),
            body: "118 passed.".into(),
            origin,
            badge: None,
        }
    }

    const ARMED: Origin = Origin {
        armed: true,
        own_action: false,
        subagent: false,
        replayed: false,
    };

    /// the task end to end, minus a push service: presence mutes a watched
    /// thread, a "done" waits and is dropped when the agent carries on, a
    /// "done" that waits out its delay reaches the subscription check, and
    /// every decision lands in telemetry as a `push.decided` row.
    #[tokio::test(start_paused = true)]
    async fn every_decision_is_a_push_decided_row_in_order() {
        let (store, store_thread, dir) = crate::store::tests::scratch();
        let (telemetry, writer) = crate::telemetry::spawn(dir.join("telemetry")).unwrap();
        let (push, task) = spawn(
            store,
            reqwest::Client::new(),
            telemetry.clone(),
            "mailto:a@b.c".into(),
            watch::channel(Vec::new()).0,
        )
        .await
        .unwrap();

        push.presence(Report {
            device: "mac".into(),
            visible: true,
            focused: true,
            thread: Some("desk:s1".into()),
            windows_in_view: vec![],
        });
        let question = About::Ask {
            id: "q1".into(),
            kind: AskKind::Question,
        };
        push.notify(notice("ask:q1", question, "desk:s1", Origin::default()));
        push.notify(notice("done:m1", About::Done, "vm:s2", ARMED));
        push.continued(Thread::parse("vm:s2").unwrap());
        push.notify(notice("done:m2", About::Done, "vm:s3", ARMED));
        tokio::time::sleep(decide::DONE_DELAY + Duration::from_secs(1)).await;

        drop((push, telemetry));
        task.await.unwrap();
        writer.await.unwrap();
        store_thread.join().unwrap();

        let mut reasons = Vec::new();
        for entry in std::fs::read_dir(dir.join("telemetry")).unwrap() {
            let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
            for line in text.lines() {
                let row: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(row["kind"], "push.decided");
                assert_eq!(row["device_class"], "server");
                let props = &row["props"];
                reasons.push((
                    props["id"].as_str().unwrap().to_owned(),
                    props["reason"].as_str().unwrap().to_owned(),
                ));
            }
        }
        let expected = [
            ("ask:q1", "watched"),
            ("done:m1", "continued"),
            ("done:m2", "no-subscriptions"),
        ];
        let expected: Vec<(String, String)> = expected
            .iter()
            .map(|(id, reason)| ((*id).to_owned(), (*reason).to_owned()))
            .collect();
        assert_eq!(reasons, expected);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
