//! the mic meter's source: the default input through coreaudio, opened only
//! while the radio is held or hands-free is on and dropped at the stop, so
//! an idle daemon holds no audio object. a denied microphone delivers
//! silence (macos zeroes the samples), which the meter shows honestly; no
//! input device makes this talk's meter unavailable. the harness seam
//! (`BOXBOX_BOARD_METER=script:<path>`) plays scripted rms windows instead.

use std::path::PathBuf;
use std::sync::mpsc::{RecvTimeoutError, SyncSender, sync_channel};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Deserialize;

use crate::daemon::Msg;
use crate::log::Log;
use crate::vu::Windower;

pub const METER_ENV: &str = "BOXBOX_BOARD_METER";

#[derive(Clone, Debug)]
pub enum Source {
    Mic,
    Script(PathBuf),
}

impl Source {
    #[must_use]
    pub fn from_env() -> Self {
        match std::env::var(METER_ENV) {
            Ok(v) => match v.strip_prefix("script:") {
                Some(path) if !path.is_empty() => Self::Script(PathBuf::from(path)),
                _ => Self::Mic,
            },
            Err(_) => Self::Mic,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Script {
    window_ms: u64,
    levels: Vec<f64>,
}

/// an open meter; dropping it closes the input.
pub enum Meter {
    Mic(cpal::Stream),
    /// dropping the sender ends the script's thread.
    Script(SyncSender<()>),
}

impl std::fmt::Debug for Meter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Mic(_) => "Meter::Mic",
            Self::Script(_) => "Meter::Script",
        })
    }
}

/// opens the meter; windows arrive as [`Msg::MeterWindow`] tagged with
/// `talk`. `None` when there is no input to open.
#[must_use]
pub fn start(source: &Source, talk: u64, tx: &SyncSender<Msg>, log: &Log) -> Option<Meter> {
    match source {
        Source::Mic => mic(talk, tx, log),
        Source::Script(path) => script(path, talk, tx, log),
    }
}

/// the script seam's record of each start and stop, for the harness.
pub fn note(source: &Source, what: &str) {
    if let Source::Script(path) = source {
        let mut log = path.clone().into_os_string();
        log.push(".log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
        {
            use std::io::Write;
            let _ = writeln!(f, "{what}");
        }
    }
}

fn mic(talk: u64, tx: &SyncSender<Msg>, log: &Log) -> Option<Meter> {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        log.warn("radio.meter_unavailable", "why=no_input");
        return None;
    };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            log.warn("radio.meter_unavailable", &format!("error={e}"));
            return None;
        }
    };
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let channels = usize::from(config.channels.max(1));
    let rate = config.sample_rate;
    let err_tx = tx.clone();
    let on_error = move |_: cpal::Error| {
        let _ = err_tx.try_send(Msg::MeterUnavailable { talk });
    };
    let built = match format {
        cpal::SampleFormat::F32 => {
            let mut sink = Sink::new(talk, rate, channels, tx.clone());
            device.build_input_stream::<f32, _, _>(
                config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| sink.feed(data.iter().copied()),
                on_error,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut sink = Sink::new(talk, rate, channels, tx.clone());
            device.build_input_stream::<i16, _, _>(
                config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    sink.feed(data.iter().map(|&s| f32::from(s) / 32_768.0));
                },
                on_error,
                None,
            )
        }
        other => {
            log.warn("radio.meter_unavailable", &format!("format={other:?}"));
            return None;
        }
    };
    let stream = match built {
        Ok(s) => s,
        Err(e) => {
            log.warn("radio.meter_unavailable", &format!("error={e}"));
            return None;
        }
    };
    if let Err(e) = stream.play() {
        log.warn("radio.meter_unavailable", &format!("error={e}"));
        return None;
    }
    Some(Meter::Mic(stream))
}

/// runs on coreaudio's thread: folds frames to mono, then to 8 khz windows,
/// and hands each window's rms over without blocking (a full channel drops
/// a window, never stalls the audio thread).
struct Sink {
    talk: u64,
    channels: usize,
    windower: Windower,
    tx: SyncSender<Msg>,
    frame: Vec<f32>,
}

impl Sink {
    fn new(talk: u64, rate: u32, channels: usize, tx: SyncSender<Msg>) -> Self {
        Self {
            talk,
            channels,
            windower: Windower::new(rate),
            tx,
            frame: Vec::with_capacity(channels),
        }
    }

    fn feed(&mut self, samples: impl Iterator<Item = f32>) {
        let channels = self.channels;
        let frame = &mut self.frame;
        let mono = samples.filter_map(move |s| {
            frame.push(s);
            if frame.len() < channels {
                return None;
            }
            // at most a handful of channels: exact in f32.
            #[allow(clippy::cast_precision_loss)]
            let mean = frame.iter().sum::<f32>() / channels as f32;
            frame.clear();
            Some(mean)
        });
        let (tx, talk) = (&self.tx, self.talk);
        self.windower.feed(mono, |rms| {
            let _ = tx.try_send(Msg::MeterWindow { talk, rms });
        });
    }
}

fn script(path: &std::path::Path, talk: u64, tx: &SyncSender<Msg>, log: &Log) -> Option<Meter> {
    let script: Script = match std::fs::read_to_string(path)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
    {
        Ok(s) => s,
        Err(e) => {
            log.warn("radio.meter_unavailable", &format!("script={e}"));
            return None;
        }
    };
    let (stop, stopped) = sync_channel::<()>(1);
    let tx = tx.clone();
    let spawned = std::thread::Builder::new()
        .name("board-meter-script".into())
        .spawn(move || {
            for rms in script.levels {
                match stopped.recv_timeout(Duration::from_millis(script.window_ms)) {
                    Err(RecvTimeoutError::Timeout) => {}
                    Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                }
                if tx.try_send(Msg::MeterWindow { talk, rms }).is_err() {
                    return;
                }
            }
        });
    spawned.ok().map(|_| Meter::Script(stop))
}
