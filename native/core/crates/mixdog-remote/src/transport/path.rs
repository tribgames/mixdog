//! Path health (`RemoteTransportPathMonitor`): RFC 9002 RTT estimation, PTO, idle timeout, and
//! stall detection. Demotion is decided on PROGRESS, never on a record's age. Pure: time is
//! passed in.

use super::consts::{
    GRANULARITY_MS, INITIAL_RTT_MS, MAX_ACK_DELAY_MS, MAX_IDLE_TIMEOUT_MS, TIME_THRESHOLD_DEN, TIME_THRESHOLD_NUM,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stall {
    /// No authenticated inbound for the idle timeout.
    Silent,
    /// Records outstanding, and neither the ack advanced nor the queue drained within the
    /// application-progress bound.
    NoProgress,
}

/// What loss recovery needs from a carrier's RTT state.
pub trait RttEstimate {
    /// kTimeThreshold × max(smoothed_rtt, latest_rtt), at least kGranularity (§6.1.2).
    fn loss_delay_ms(&self) -> f64;
    /// smoothed_rtt + max(4 × rttvar, kGranularity) + max_ack_delay (§6.2.1).
    fn pto_ms(&self) -> f64;
}

pub struct PathMonitor {
    last_inbound: u64,
    last_ack_advance: u64,
    last_drain: u64,
    last_buffered: usize,
    outstanding_since: Option<u64>,
    sampled: bool,
    smoothed_rtt: f64,
    rttvar: f64,
    latest_rtt: f64,
    min_rtt: f64,
}

impl PathMonitor {
    pub fn new(now: u64) -> Self {
        Self {
            last_inbound: now,
            last_ack_advance: now,
            last_drain: now,
            last_buffered: 0,
            outstanding_since: None,
            sampled: false,
            smoothed_rtt: INITIAL_RTT_MS,
            rttvar: INITIAL_RTT_MS / 2.0,
            latest_rtt: 0.0,
            min_rtt: f64::INFINITY,
        }
    }

    /// A new carrier (promotion, demotion, ICE restart): forget everything.
    pub fn reset(&mut self, now: u64) {
        *self = Self::new(now);
    }

    /// The sender's outstanding bytes after every push and ack: the no-progress interval starts
    /// the moment work becomes outstanding, never at an older ack or drain.
    pub fn outstanding(&mut self, bytes: usize, now: u64) {
        if bytes == 0 {
            self.outstanding_since = None;
        } else {
            self.outstanding_since.get_or_insert(now);
        }
    }

    /// Authenticated traffic arrived on this carrier.
    pub fn inbound(&mut self, now: u64) {
        self.last_inbound = now;
    }

    /// An ack released records.
    pub fn ack_advanced(&mut self, now: u64) {
        self.last_ack_advance = now;
    }

    /// A `bufferedAmount` sample of this carrier's channel. Only an actual decrease is drain
    /// progress.
    pub fn buffered(&mut self, amount: usize, now: u64) {
        if amount < self.last_buffered {
            self.last_drain = now;
        }
        self.last_buffered = amount;
    }

    /// One ping/pong round trip, estimated as RFC 9002 §5.3 says (a pong is sent at once, so
    /// its ack_delay is 0).
    pub fn rtt_sample(&mut self, latest_rtt: f64) {
        self.latest_rtt = latest_rtt;
        if !self.sampled {
            self.sampled = true;
            self.min_rtt = latest_rtt;
            self.smoothed_rtt = latest_rtt;
            self.rttvar = latest_rtt / 2.0;
            return;
        }
        self.min_rtt = self.min_rtt.min(latest_rtt);
        let adjusted_rtt = latest_rtt;
        self.rttvar = (3.0 / 4.0) * self.rttvar + (1.0 / 4.0) * (self.smoothed_rtt - adjusted_rtt).abs();
        self.smoothed_rtt = (7.0 / 8.0) * self.smoothed_rtt + (1.0 / 8.0) * adjusted_rtt;
    }

    pub fn smoothed_rtt_ms(&self) -> f64 {
        self.smoothed_rtt
    }

    /// RFC 9000 §10.1: at least three times the current PTO.
    pub fn idle_timeout_ms(&self) -> f64 {
        MAX_IDLE_TIMEOUT_MS.max(3.0 * self.pto_ms())
    }

    pub fn stalled(&mut self, now: u64, outstanding_bytes: usize) -> Option<Stall> {
        self.outstanding(outstanding_bytes, now);
        if now.saturating_sub(self.last_inbound) as f64 >= self.idle_timeout_ms() {
            return Some(Stall::Silent);
        }
        let since = self.outstanding_since?;
        let progress = since.max(self.last_ack_advance).max(self.last_drain);
        (now.saturating_sub(progress) as f64 >= MAX_IDLE_TIMEOUT_MS).then_some(Stall::NoProgress)
    }
}

impl RttEstimate for PathMonitor {
    fn loss_delay_ms(&self) -> f64 {
        (TIME_THRESHOLD_NUM * self.smoothed_rtt.max(self.latest_rtt) / TIME_THRESHOLD_DEN).max(GRANULARITY_MS)
    }

    fn pto_ms(&self) -> f64 {
        self.smoothed_rtt + (4.0 * self.rttvar).max(GRANULARITY_MS) + MAX_ACK_DELAY_MS as f64
    }
}
