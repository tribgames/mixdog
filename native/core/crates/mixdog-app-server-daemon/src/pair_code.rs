//! The composition's `PairCodeEffects` (WP-REMOTE): `publish` hands the pair code to the remote
//! section's one publisher (WP-REMOTE owns the whole `remote` section, `pairCode` included),
//! `wake_at` registers with the core ticker, `send` writes to the open relay leg.

use std::time::Duration;
use std::time::Instant;
use std::time::UNIX_EPOCH;

use mixdog_remote::pair_code::PairCodeEffects;
use mixdog_remote::pair_code::PairCodeView;
use mixdog_rt::Ticker;
use mixdog_rt::TimerHandle;
use serde_json::Value;

/// Writes a frame to the open relay leg; false when there is none.
pub type LegSend = Box<dyn FnMut(Value) -> bool + Send>;
/// The remote section publisher's entry for the pair code: it republishes the whole section.
pub type PairCodeSink = Box<dyn FnMut(Option<&PairCodeView>) + Send>;
/// What the ticker runs at the deadline; it only wakes the remote actor, which then calls
/// `PairCode::on_tick` (ticker callbacks must not block).
pub type OnTick = std::sync::Arc<dyn Fn() + Send + Sync>;

pub struct ComposedPairCodeEffects {
    sink: PairCodeSink,
    ticker: Ticker,
    on_tick: OnTick,
    leg: LegSend,
    armed: Option<TimerHandle>,
}

impl ComposedPairCodeEffects {
    pub fn new(sink: PairCodeSink, ticker: Ticker, on_tick: OnTick, leg: LegSend) -> Self {
        Self { sink, ticker, on_tick, leg, armed: None }
    }
}

impl PairCodeEffects for ComposedPairCodeEffects {
    fn send(&mut self, envelope: Value) -> bool {
        (self.leg)(envelope)
    }

    fn publish(&mut self, code: Option<&PairCodeView>) {
        (self.sink)(code);
    }

    fn wake_at(&mut self, at_ms: u64) {
        if let Some(earlier) = self.armed.take() {
            let _ = earlier.cancel();
        }
        let now_ms = mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let at = Instant::now() + Duration::from_millis(at_ms.saturating_sub(now_ms));
        let on_tick = self.on_tick.clone();
        self.armed = Some(self.ticker.register(at, move || on_tick()));
    }
}
