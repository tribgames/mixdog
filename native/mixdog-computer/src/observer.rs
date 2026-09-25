//! Who is using the mouse and keyboard. A platform source records every input
//! event as this process's own or someone else's; the ledger counts the
//! foreign ones, and an action refuses to continue once that count moves.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

fn epoch() -> &'static Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now)
}

/// Milliseconds on this process's monotonic clock; never zero.
pub fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64 + 1
}

#[derive(Default)]
struct Ledger {
    foreign_sequence: i64,
    latest_tick: u64,
    last_own_tick: u64,
    latest_own: bool,
}

#[derive(Default)]
pub struct Shared {
    ledger: Mutex<Ledger>,
    ready: AtomicBool,
    /// Injected input this process sends is its own until this instant; a
    /// source that cannot tag events tells them apart by time.
    own_until: AtomicU64,
}

impl Shared {
    pub fn record(&self, own: bool) {
        let tick = now_ms();
        let mut ledger = self.ledger.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ledger.latest_tick = tick;
        ledger.latest_own = own;
        if own {
            ledger.last_own_tick = tick;
        } else {
            ledger.foreign_sequence += 1;
        }
    }
    /// For sources that only see when input happened: input inside the
    /// window this process marked as its own is attributed to it.
    pub fn record_untagged(&self, at_ms: u64) {
        let own = at_ms <= self.own_until.load(Ordering::SeqCst);
        self.record(own);
    }
    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }
    pub fn mark_own_input(&self, grace_ms: u64) {
        let until = now_ms() + grace_ms;
        self.own_until.fetch_max(until, Ordering::SeqCst);
        let mut ledger = self.ledger.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ledger.last_own_tick = now_ms();
    }
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub ready: bool,
    pub generation: String,
    pub sequence: i64,
    pub tick: u64,
    pub own_tick: u64,
}

pub struct Observer {
    pub shared: Arc<Shared>,
    pub generation: String,
}

impl Observer {
    pub fn new() -> Observer {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        Observer {
            shared: Arc::new(Shared::default()),
            generation: format!("{:016x}{:08x}", seed as u64, std::process::id()),
        }
    }

    pub fn read(&self) -> Snapshot {
        let ledger = self.shared.ledger.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        Snapshot {
            ready: self.shared.ready.load(Ordering::SeqCst),
            generation: self.generation.clone(),
            sequence: ledger.foreign_sequence,
            tick: ledger.latest_tick,
            own_tick: ledger.last_own_tick,
        }
    }

    /// Milliseconds since input that was not this process's own.
    pub fn foreign_idle_ms(&self) -> u64 {
        let ledger = self.shared.ledger.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if ledger.foreign_sequence == 0 {
            return u32::MAX as u64;
        }
        let last_foreign = if ledger.latest_own { 0 } else { ledger.latest_tick };
        if last_foreign == 0 {
            // The newest event was ours; the foreign one is at least that old.
            return now_ms().saturating_sub(ledger.last_own_tick);
        }
        now_ms().saturating_sub(last_foreign)
    }
}

/// One action's claim on the observation: begun at a sequence, it may
/// continue only while nobody else has touched the input.
#[derive(Default)]
pub struct Scope {
    sequence: Option<i64>,
    depth: u32,
}

impl Scope {
    pub fn begin(&mut self, observer: &Observer) -> Result<(), String> {
        if self.depth > 0 {
            self.assert_continue(observer)?;
            self.depth += 1;
            return Ok(());
        }
        let value = observer.read();
        if !value.ready {
            return Err("input_observation_unavailable: input origin cannot be observed".into());
        }
        self.sequence = Some(value.sequence);
        self.depth = 1;
        Ok(())
    }

    pub fn begin_expected(&mut self, observer: &Observer, generation: &str, sequence: i64) -> Result<(), String> {
        let value = observer.read();
        if !value.ready || value.generation != generation {
            return Err("input_observation_unavailable: original observation is unavailable".into());
        }
        if value.sequence != sequence {
            return Err("user_input_active: observation was superseded by external input".into());
        }
        self.sequence = Some(value.sequence);
        self.depth = 1;
        Ok(())
    }

    pub fn assert_continue(&self, observer: &Observer) -> Result<(), String> {
        let value = observer.read();
        if !value.ready {
            return Err("input_observation_unavailable: input observation lost".into());
        }
        if let Some(sequence) = self.sequence {
            if value.sequence != sequence {
                return Err("user_input_active: external input interrupted this action".into());
            }
        }
        Ok(())
    }

    pub fn end(&mut self) {
        self.depth = self.depth.saturating_sub(1);
        if self.depth == 0 {
            self.sequence = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreign_input_breaks_a_scope() {
        let observer = Observer::new();
        observer.shared.set_ready(true);
        let mut scope = Scope::default();
        scope.begin(&observer).unwrap();
        observer.shared.record(true);
        scope.assert_continue(&observer).unwrap();
        observer.shared.record(false);
        assert!(scope.assert_continue(&observer).unwrap_err().starts_with("user_input_active"));
        scope.end();
        observer.shared.record(false);
        scope.assert_continue(&observer).unwrap();
    }

    #[test]
    fn unready_observer_refuses_input() {
        let observer = Observer::new();
        let mut scope = Scope::default();
        assert!(scope.begin(&observer).unwrap_err().starts_with("input_observation_unavailable"));
    }

    #[test]
    fn untagged_events_inside_own_window_are_own() {
        let observer = Observer::new();
        observer.shared.set_ready(true);
        observer.shared.mark_own_input(10_000);
        observer.shared.record_untagged(now_ms());
        assert_eq!(observer.read().sequence, 0);
    }
}
