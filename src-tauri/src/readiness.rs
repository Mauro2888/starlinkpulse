//! Live jitter and "ready for…" indicators (Phase 6). Thresholds are documented in
//! docs/diagnostics.md.

use std::collections::VecDeque;

use crate::models::{Readiness, ReadinessLevel};

/// Window of live samples used for jitter / averages.
pub const WINDOW_MS: i64 = 120_000;
/// Minimum samples before jitter (and readiness) are reported.
pub const MIN_SAMPLES: usize = 10;

/// Gaming: good below 50 ms latency, 10 ms jitter, 0.5 % loss; fair below 100 / 30 / 2 %.
pub const GAMING_GOOD: Limits = Limits {
    latency_ms: 50.0,
    jitter_ms: 10.0,
    drop: 0.005,
};
pub const GAMING_FAIR: Limits = Limits {
    latency_ms: 100.0,
    jitter_ms: 30.0,
    drop: 0.02,
};
/// Video calls: good below 100 ms, 30 ms jitter, 1 % loss; fair below 200 / 50 / 3 %.
pub const VIDEO_GOOD: Limits = Limits {
    latency_ms: 100.0,
    jitter_ms: 30.0,
    drop: 0.01,
};
pub const VIDEO_FAIR: Limits = Limits {
    latency_ms: 200.0,
    jitter_ms: 50.0,
    drop: 0.03,
};
/// Streaming is buffered: only loss matters (good below 2 %, fair below 5 %).
pub const STREAMING_GOOD_DROP: f64 = 0.02;
pub const STREAMING_FAIR_DROP: f64 = 0.05;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub latency_ms: f64,
    pub jitter_ms: f64,
    pub drop: f64,
}

impl Limits {
    fn ok(&self, lat: f64, jit: f64, drop: f64) -> bool {
        lat < self.latency_ms && jit < self.jitter_ms && drop < self.drop
    }
}

fn level(good: bool, fair: bool) -> ReadinessLevel {
    if good {
        ReadinessLevel::Good
    } else if fair {
        ReadinessLevel::Fair
    } else {
        ReadinessLevel::Poor
    }
}

fn cap_fair(l: ReadinessLevel) -> ReadinessLevel {
    if l == ReadinessLevel::Good {
        ReadinessLevel::Fair
    } else {
        l
    }
}

/// Recent live samples (latency is `None` during outages).
#[derive(Debug, Default)]
pub struct LiveWindow {
    samples: VecDeque<(i64, Option<f64>, f64)>,
}

impl LiveWindow {
    pub fn push(&mut self, now_ms: i64, latency_ms: Option<f64>, drop_rate: Option<f64>) {
        self.samples
            .push_back((now_ms, latency_ms, drop_rate.unwrap_or(0.0).clamp(0.0, 1.0)));
        while self
            .samples
            .front()
            .is_some_and(|(t, _, _)| now_ms - t > WINDOW_MS)
        {
            self.samples.pop_front();
        }
    }

    /// Mean |Δ latency| between consecutive samples with latency; `None` below
    /// [`MIN_SAMPLES`].
    pub fn jitter_ms(&self) -> Option<f64> {
        let lat: Vec<f64> = self.samples.iter().filter_map(|(_, l, _)| *l).collect();
        if lat.len() < MIN_SAMPLES {
            return None;
        }
        let sum: f64 = lat.windows(2).map(|w| (w[1] - w[0]).abs()).sum();
        Some(sum / (lat.len() - 1) as f64)
    }

    pub fn latency_avg_ms(&self) -> Option<f64> {
        let lat: Vec<f64> = self.samples.iter().filter_map(|(_, l, _)| *l).collect();
        (!lat.is_empty()).then(|| lat.iter().sum::<f64>() / lat.len() as f64)
    }

    pub fn drop_avg(&self) -> Option<f64> {
        (!self.samples.is_empty()).then(|| {
            self.samples.iter().map(|(_, _, d)| d).sum::<f64>() / self.samples.len() as f64
        })
    }
}

/// Readiness from window averages. `None` until jitter is known, except during an outage
/// (`in_outage`), which is always poor.
pub fn readiness(
    latency_avg_ms: Option<f64>,
    jitter_ms: Option<f64>,
    drop_avg: Option<f64>,
    currently_obstructed: bool,
    in_outage: bool,
) -> Option<Readiness> {
    if in_outage {
        return Some(Readiness {
            video_call: ReadinessLevel::Poor,
            gaming: ReadinessLevel::Poor,
            streaming: ReadinessLevel::Poor,
        });
    }
    let (lat, jit) = (latency_avg_ms?, jitter_ms?);
    let drop = drop_avg.unwrap_or(0.0);
    let mut r = Readiness {
        video_call: level(VIDEO_GOOD.ok(lat, jit, drop), VIDEO_FAIR.ok(lat, jit, drop)),
        gaming: level(
            GAMING_GOOD.ok(lat, jit, drop),
            GAMING_FAIR.ok(lat, jit, drop),
        ),
        streaming: level(drop < STREAMING_GOOD_DROP, drop < STREAMING_FAIR_DROP),
    };
    if currently_obstructed {
        // Obstructions cause short drop-outs: never "good" while obstructed.
        r.video_call = cap_fair(r.video_call);
        r.gaming = cap_fair(r.gaming);
        r.streaming = cap_fair(r.streaming);
    }
    Some(r)
}

/// Tray symbol for a level.
pub fn mark(l: ReadinessLevel) -> &'static str {
    match l {
        ReadinessLevel::Good => "✓",
        ReadinessLevel::Fair => "~",
        ReadinessLevel::Poor => "✗",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ReadinessLevel::*;

    #[test]
    fn jitter_needs_ten_samples_and_uses_window() {
        let mut w = LiveWindow::default();
        for i in 0..9 {
            w.push(
                i * 3000,
                Some(if i % 2 == 0 { 30.0 } else { 40.0 }),
                Some(0.0),
            );
        }
        assert_eq!(w.jitter_ms(), None);
        w.push(27_000, Some(40.0), Some(0.0));
        assert_eq!(w.jitter_ms(), Some(10.0));
        assert_eq!(w.latency_avg_ms(), Some(35.0));
        // Outage samples do not count as latency but keep the drop rate.
        w.push(30_000, None, Some(1.0));
        assert_eq!(w.jitter_ms(), Some(10.0));
        assert!((w.drop_avg().unwrap() - 1.0 / 11.0).abs() < 1e-12);
        // Old samples leave the 2-minute window.
        w.push(30_000 + WINDOW_MS + 1, Some(30.0), Some(0.0));
        assert_eq!(w.jitter_ms(), None);
    }

    #[test]
    fn readiness_levels_and_boundaries() {
        let r = readiness(Some(30.0), Some(5.0), Some(0.0), false, false).unwrap();
        assert_eq!((r.gaming, r.video_call, r.streaming), (Good, Good, Good));
        // Gaming boundary: 50 ms is not < 50.
        let r = readiness(Some(50.0), Some(5.0), Some(0.0), false, false).unwrap();
        assert_eq!((r.gaming, r.video_call), (Fair, Good));
        let r = readiness(Some(120.0), Some(35.0), Some(0.015), false, false).unwrap();
        assert_eq!((r.gaming, r.video_call, r.streaming), (Poor, Fair, Good));
        let r = readiness(Some(40.0), Some(5.0), Some(0.06), false, false).unwrap();
        assert_eq!((r.gaming, r.video_call, r.streaming), (Poor, Poor, Poor));
        // Obstructed: never good.
        let r = readiness(Some(30.0), Some(5.0), Some(0.0), true, false).unwrap();
        assert_eq!((r.gaming, r.video_call, r.streaming), (Fair, Fair, Fair));
        // Outage: poor; unknown jitter: none.
        assert_eq!(
            readiness(None, None, None, false, true).unwrap().gaming,
            Poor
        );
        assert_eq!(readiness(Some(30.0), None, Some(0.0), false, false), None);
        assert_eq!(mark(Good), "✓");
    }
}
