//! The setup tool's `open` request (`src/tui/app/use-ui-open-request.mjs`): the session store publishes `{ command, seq }`
//! when the model asks for a settings surface; each new `seq` runs that slash command exactly as if the user had typed it.

use serde_json::{Map, Value};

use super::dispatch::run_slash_command;
use super::host::{Opener, SlashHost, Tone};
use super::notices::{truthy, value_text};

/// A request older than this is history (a re-attached terminal replays the retained snapshot), not an instruction.
const STALE_AFTER_MS: f64 = 15_000.0;

/// The highest `seq` already acted on (`seenRef`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UiOpenGate {
    seen: f64,
}

/// `Number(value) || 0` of a request member.
fn number(value: Option<&Value>) -> f64 {
    let n = value.map_or(f64::NAN, mixdog_js::to_number);
    if n.is_nan() { 0.0 } else { n }
}

impl UiOpenGate {
    /// Acts on `request` (`{ command, seq, at }`) once per `seq`.
    pub fn run(&mut self, host: &mut dyn SlashHost, request: &Value) {
        let seq = number(request.get("seq"));
        let Some(command) = request.get("command").filter(|command| truthy(command)) else { return };
        if seq <= self.seen {
            return;
        }
        self.seen = seq;
        let at = number(request.get("at"));
        if at > 0.0 && host.now_ms() as f64 - at > STALE_AFTER_MS {
            return;
        }
        match value_text(command).as_str() {
            // The setup `open` targets that are settings sections without a slash command.
            "developer" => open_section(host, Opener::Developer),
            "voice" => open_section(host, Opener::Settings),
            "connection" => {
                host.push_notice("Web-app pairing lives in the Desktop app: Settings \u{2192} Connection.", Tone::Info);
            }
            other => {
                run_slash_command(host, other, "");
            }
        }
    }
}

fn open_section(host: &mut dyn SlashHost, opener: Opener) {
    if let Err(error) = host.open(opener, Value::Object(Map::new())) {
        host.push_notice(&format!("panel failed to open: {error}"), Tone::Error);
    }
}
