//! Values the desktop host owns and hands over at launch, so both sides read
//! one definition instead of keeping copies in step.

use std::collections::HashSet;

pub struct Config {
    /// Actions that read state and never send input.
    pub read_actions: HashSet<String>,
    /// Actions after which the session's element refs stay valid.
    pub retain_ref_actions: HashSet<String>,
    pub sequence_settle_ms: u64,
    pub max_foreground_text: usize,
    pub input_marker: i64,
}

fn list(name: &str) -> HashSet<String> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn number(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(fallback)
}

pub fn input_marker() -> i64 {
    std::env::var("MIXDOG_COMPUTER_INPUT_MARKER")
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0 && *value <= i32::MAX as i64)
        .unwrap_or_else(|| {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos() as i64)
                .unwrap_or(1);
            ((seed ^ (std::process::id() as i64)) & 0x7fff_ffff).max(1)
        })
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            read_actions: list("MIXDOG_COMPUTER_READ_ACTIONS"),
            retain_ref_actions: list("MIXDOG_COMPUTER_RETAIN_REF_ACTIONS"),
            sequence_settle_ms: number("MIXDOG_COMPUTER_SEQUENCE_SETTLE_MS", 350),
            max_foreground_text: number("MIXDOG_COMPUTER_MAX_FOREGROUND_TEXT", 4000) as usize,
            input_marker: input_marker(),
        }
    }
    pub fn is_read(&self, action: &str) -> bool {
        self.read_actions.contains(action)
    }
}
