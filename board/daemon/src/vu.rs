//! the voice meter's math, v1's exactly: 25 ms windows of 8 khz audio, each
//! window's rms auto-gained against a slow-decaying peak, square-root
//! compressed to a bar of 0 to 5, and the last four bars scrolled across the
//! four column stacks. the source (coreaudio, or the harness's script) only
//! hands over each window's rms.

/// raw rms above this counts as voice for the hands-free silence clock. it is
/// absolute because the auto-gain lifts room tone into visible bars.
pub const VOICE_RMS: f64 = 0.004;

/// 8 khz, 25 ms: 200 samples a window.
pub const SAMPLE_RATE: u32 = 8_000;
pub const WINDOW_SAMPLES: usize = 200;

#[derive(Clone, Debug, PartialEq)]
pub struct Levels {
    /// the last four bars, newest last.
    pub bands: [u8; 4],
    peak: f64,
    /// monotonic ms of the last window loud enough to be voice; seeded at
    /// start so an opened mic gets the whole silence window.
    pub voice_at: u64,
    /// per talk, logged at the stop: windows=0 means no audio arrived,
    /// silent=windows means it was all zeros (a denied mic delivers silence).
    pub windows: u64,
    pub silent: u64,
}

impl Levels {
    #[must_use]
    pub fn start(now: u64) -> Self {
        Self {
            bands: [0; 4],
            peak: 0.02,
            voice_at: now,
            windows: 0,
            silent: 0,
        }
    }

    /// one window's rms, 0 to 1.
    pub fn window(&mut self, rms: f64, now: u64) {
        self.windows += 1;
        if rms == 0.0 {
            self.silent += 1;
        }
        if rms >= VOICE_RMS {
            self.voice_at = now;
        }
        self.peak = (self.peak * 0.9992).max(rms).max(0.008);
        let norm = (rms / self.peak).min(1.0).sqrt();
        let height = (norm * 5.0).round().clamp(0.0, 5.0);
        // height is 0..=5 by the clamp above.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let height = height as u8;
        self.bands = [self.bands[1], self.bands[2], self.bands[3], height];
    }
}

/// folds audio at any rate into 8 khz windows: each 8 khz sample is the mean
/// of the input samples in its period (a box filter, enough for a level),
/// and every 200 of them make one window's rms.
#[derive(Debug)]
pub struct Windower {
    input_rate: u32,
    acc: f64,
    acc_n: u32,
    /// in input-rate units: each input sample adds 8000, an output sample
    /// is due at the input rate. integer, so no drift.
    phase: u32,
    sum_sq: f64,
    count: usize,
}

impl Windower {
    #[must_use]
    pub fn new(input_rate: u32) -> Self {
        Self {
            input_rate: input_rate.max(1),
            acc: 0.0,
            acc_n: 0,
            phase: 0,
            sum_sq: 0.0,
            count: 0,
        }
    }

    /// feeds mono samples in -1..1; calls `out` with each finished window's rms.
    pub fn feed(&mut self, samples: impl Iterator<Item = f32>, mut out: impl FnMut(f64)) {
        for s in samples {
            self.acc += f64::from(s);
            self.acc_n += 1;
            self.phase += SAMPLE_RATE;
            if self.phase < self.input_rate {
                continue;
            }
            self.phase -= self.input_rate;
            let v = self.acc / f64::from(self.acc_n);
            self.acc = 0.0;
            self.acc_n = 0;
            self.sum_sq += v * v;
            self.count += 1;
            if self.count == WINDOW_SAMPLES {
                // count is 200: exact in f64.
                #[allow(clippy::cast_precision_loss)]
                let rms = (self.sum_sq / WINDOW_SAMPLES as f64).sqrt();
                out(rms);
                self.sum_sq = 0.0;
                self.count = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scripted_windows_draw_v1s_bars() {
        // the harness's microphone: these rms values, 150 ms apart.
        let mut l = Levels::start(0);
        let mut bars = Vec::new();
        for (i, rms) in [0.3, 0.15, 0.3, 0.08, 0.3, 0.15].into_iter().enumerate() {
            l.window(rms, (i as u64 + 1) * 150);
            bars.push(l.bands[3]);
        }
        // the first window sets the peak (0.3): a full bar; 0.15 is
        // sqrt(0.15 / 0.29976) * 5 = 3.54, so 4; 0.08 is 2.58, so 3.
        assert_eq!(bars, vec![5, 4, 5, 3, 5, 4]);
        assert_eq!(l.bands, [5, 3, 5, 4]);
        assert_eq!(l.voice_at, 900);
    }

    #[test]
    fn silence_is_counted_and_never_voice() {
        let mut l = Levels::start(5);
        l.window(0.0, 30);
        assert_eq!((l.windows, l.silent, l.voice_at), (1, 1, 5));
        assert_eq!(l.bands, [0; 4]);
    }

    #[test]
    fn a_48khz_square_wave_folds_into_8khz_windows_at_its_amplitude() {
        let mut w = Windower::new(48_000);
        let mut out = Vec::new();
        // a square wave at 4 khz is constant across each 6-sample period.
        let samples = (0..48_000 / 40).map(|i| if (i / 6) % 2 == 0 { 0.5 } else { -0.5 });
        w.feed(samples, |rms| out.push(rms));
        assert_eq!(out.len(), 1);
        assert!((out[0] - 0.5).abs() < 1e-9);
    }
}
