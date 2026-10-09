//! presence: which devices are looking at boxbox, and at what.
//!
//! a device is looking when its last report said the app was visible and
//! focused, and that report is under 90 s old. a window that exists, or
//! is visible behind another app, is not looking (decision 7, refined by
//! decision 23). a thread is watched when a looking device has it on stage
//! or its window in view; a watched thread buzzes nobody.
//!
//! clients report on every change and every 30 s while looking, so a
//! device that slept without saying goodbye stops counting within 90 s.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;
use tokio::time::Instant;
use utoipa::ToSchema;

/// a report older than this no longer counts.
pub const LOOKING_FOR: Duration = Duration::from_secs(90);
/// devices tracked at once. one person has a handful; past this the
/// stalest report is forgotten first.
const MAX_DEVICES: usize = 64;
/// windows one report may name; a rail shows a dozen at most.
pub const MAX_WINDOWS: usize = 64;

/// `POST /api/presence`: what one device is showing right now.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schema(as = PresenceReport)]
pub struct Report {
    /// the device id the app minted once for this browser profile.
    pub device: String,
    /// `document.visibilityState === "visible"`.
    pub visible: bool,
    /// `document.hasFocus()`: boxbox is the app in front, not behind another.
    pub focused: bool,
    /// the thread on stage, `host:session`, or null on home.
    pub thread: Option<String>,
    /// threads whose windows are in view, `host:session` each.
    #[serde(default)]
    pub windows_in_view: Vec<String>,
}

/// one device looking at boxbox, as the fleet is told (it marks a thread
/// on stage seen, and a turn that ends in front of someone raises no
/// need). `until` is when the report stops counting, ms since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Looking {
    pub device: String,
    /// the class the device subscribed with ("iphone", "mac"), or empty.
    pub class: String,
    pub thread: Option<String>,
    pub until: i64,
}

#[derive(Debug)]
struct Seen {
    at: Instant,
    looking: bool,
    thread: Option<String>,
    windows: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Presence {
    devices: HashMap<String, Seen>,
}

impl Presence {
    pub fn report(&mut self, report: Report, now: Instant) {
        if !self.devices.contains_key(&report.device) && self.devices.len() >= MAX_DEVICES {
            self.forget_stalest();
        }
        let mut windows = report.windows_in_view;
        windows.truncate(MAX_WINDOWS);
        self.devices.insert(
            report.device,
            Seen {
                at: now,
                looking: report.visible && report.focused,
                thread: report.thread,
                windows,
            },
        );
    }

    /// is any device looking at `thread`?
    #[must_use]
    pub fn watched(&self, thread: &str, now: Instant) -> bool {
        self.devices.values().any(|seen| {
            is_current(seen, now)
                && (seen.thread.as_deref() == Some(thread)
                    || seen.windows.iter().any(|w| w == thread))
        })
    }

    /// every device looking now, with when its report stops counting on
    /// the wall clock (`now_ms` is the wall clock at `now`).
    #[must_use]
    pub fn looking(
        &self,
        now: Instant,
        now_ms: i64,
        class: impl Fn(&str) -> String,
    ) -> Vec<Looking> {
        let mut looking: Vec<Looking> = self
            .devices
            .iter()
            .filter(|(_, seen)| is_current(seen, now))
            .map(|(device, seen)| {
                let left = LOOKING_FOR.saturating_sub(now.saturating_duration_since(seen.at));
                Looking {
                    device: device.clone(),
                    class: class(device),
                    thread: seen.thread.clone(),
                    until: now_ms + i64::try_from(left.as_millis()).unwrap_or(0),
                }
            })
            .collect();
        looking.sort_by(|a, b| a.device.cmp(&b.device));
        looking
    }

    /// drops every report too old to count; returns how many went.
    pub fn sweep(&mut self, now: Instant) -> usize {
        let before = self.devices.len();
        self.devices
            .retain(|_, seen| now.saturating_duration_since(seen.at) <= LOOKING_FOR);
        before - self.devices.len()
    }

    fn forget_stalest(&mut self) {
        if let Some(stalest) = self
            .devices
            .iter()
            .min_by_key(|(_, seen)| seen.at)
            .map(|(device, _)| device.clone())
        {
            self.devices.remove(&stalest);
        }
    }
}

fn is_current(seen: &Seen, now: Instant) -> bool {
    seen.looking && now.saturating_duration_since(seen.at) <= LOOKING_FOR
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(device: &str, visible: bool, focused: bool, thread: Option<&str>) -> Report {
        Report {
            device: device.into(),
            visible,
            focused,
            thread: thread.map(Into::into),
            windows_in_view: vec![],
        }
    }

    #[test]
    fn looking_means_visible_and_focused_never_just_a_window() {
        let now = Instant::now();
        let mut presence = Presence::default();
        presence.report(report("mac", true, false, Some("desk:s1")), now);
        presence.report(report("ipad", false, true, Some("desk:s1")), now);
        assert!(
            !presence.watched("desk:s1", now),
            "visible behind another app is not looking"
        );
        presence.report(report("phone", true, true, Some("desk:s1")), now);
        assert!(presence.watched("desk:s1", now));
    }

    #[test]
    fn a_report_counts_for_90_seconds_then_not_at_all() {
        let then = Instant::now();
        let mut presence = Presence::default();
        presence.report(report("mac", true, true, Some("desk:s1")), then);
        assert!(presence.watched("desk:s1", then + LOOKING_FOR));
        assert!(!presence.watched("desk:s1", then + LOOKING_FOR + Duration::from_millis(1)));
        assert_eq!(
            presence.sweep(then + LOOKING_FOR + Duration::from_secs(1)),
            1
        );
    }

    #[test]
    fn a_window_in_view_watches_its_thread_and_only_its_thread() {
        let now = Instant::now();
        let mut presence = Presence::default();
        let mut on_home = report("ipad", true, true, None);
        on_home.windows_in_view = vec!["desk:s1".into(), "vm:s2".into()];
        presence.report(on_home, now);
        assert!(presence.watched("vm:s2", now));
        assert!(!presence.watched("vm:s3", now));
    }

    #[test]
    fn going_hidden_stops_watching_at_once() {
        let now = Instant::now();
        let mut presence = Presence::default();
        presence.report(report("mac", true, true, Some("desk:s1")), now);
        presence.report(
            report("mac", false, false, Some("desk:s1")),
            now + Duration::from_secs(1),
        );
        assert!(!presence.watched("desk:s1", now + Duration::from_secs(1)));
    }

    #[test]
    fn past_the_cap_the_stalest_device_is_forgotten() {
        let start = Instant::now();
        let mut presence = Presence::default();
        for n in 0..=MAX_DEVICES {
            let at = start + Duration::from_millis(u64::try_from(n).unwrap());
            presence.report(report(&format!("d{n}"), true, true, None), at);
        }
        assert_eq!(presence.devices.len(), MAX_DEVICES);
        assert!(!presence.devices.contains_key("d0"));
    }
}
