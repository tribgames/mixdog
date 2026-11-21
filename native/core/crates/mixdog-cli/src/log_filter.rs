//! What the core's stderr leaves out of the WebRTC stack's lines.
//!
//! The stack (`webrtc`, `rtc` and the `rtc-*` crates under it) logs through `log`, in its own words: socket and
//! peer addresses, candidate lines, and the reason text a TURN server sends. None of that belongs in the daemon
//! log, and no part of such a line can be kept safely: the bridge hands over the formatted text, not its
//! arguments. So the stack's records stay out, whatever their level, and the record of a direct attempt is the
//! `direct-closed` line `mixdog-remote` writes itself.
//!
//! One switch of Mixdog's own lets them through for a developer: [`SWITCH`] set to anything but nothing. `RUST_LOG`
//! then decides their levels as it does every other record's; by itself it never opens the stack, whatever it
//! says about the stack's crates.

use std::fmt::Debug;

use tracing::field::Field;
use tracing::field::Visit;
use tracing_log::NormalizeEvent;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// Set and not empty: the stack's records are logged. Named and read as `MIXDOG_DEBUG_SESSION_LOG` is.
pub(crate) const SWITCH: &str = "MIXDOG_DEBUG_WEBRTC_LOG";
const DRIVER: &str = "webrtc::peer_connection::driver";
const REFUSED_WRITE: &str = "Failed to write packet to ";

/// Whether a target (a module path) is inside the WebRTC stack: the crate is `webrtc`, `rtc` or an `rtc_*` one.
fn in_stack(target: &str) -> bool {
    let root = target.split("::").next().unwrap_or(target);
    root == "webrtc" || root == "rtc" || root.starts_with("rtc_")
}

/// The daemon's level filter and its gate on the stack, from the environment.
pub(crate) fn from_env() -> (EnvFilter, WebRtcStack) {
    let asked_for = std::env::var_os(SWITCH).is_some_and(|value| !value.is_empty());
    filters(&std::env::var("RUST_LOG").unwrap_or_default(), asked_for)
}

/// `directives` is the value of `RUST_LOG` (empty when unset), read as `EnvFilter::from_default_env` reads it.
fn filters(directives: &str, asked_for: bool) -> (EnvFilter, WebRtcStack) {
    (EnvFilter::new(directives), WebRtcStack { asked_for })
}

/// Keeps the stack's records out of the log. The stack logs through `log`, whose records the bridge turns into
/// events of target `log`: the record's own target is in the normalized metadata.
pub(crate) struct WebRtcStack {
    /// [`SWITCH`] is on: its records pass, except the driver's line for one datagram a socket
    /// refused. ICE checks every local interface against every candidate, and an interface that cannot reach one
    /// (a virtual adapter without a route out) has each check refused: one such line per packet for the life of
    /// an attempt.
    asked_for: bool,
}

impl<S: tracing::Subscriber> Layer<S> for WebRtcStack {
    fn event_enabled(&self, event: &tracing::Event<'_>, _: Context<'_, S>) -> bool {
        let normalized = event.normalized_metadata();
        let target = normalized.as_ref().map_or_else(|| event.metadata().target(), |metadata| metadata.target());
        if !in_stack(target) {
            return true;
        }
        if !self.asked_for {
            return false;
        }
        if target != DRIVER {
            return true;
        }
        let mut refused = RefusedWrite(false);
        event.record(&mut refused);
        !refused.0
    }
}

struct RefusedWrite(bool);

impl Visit for RefusedWrite {
    fn record_debug(&mut self, field: &Field, value: &dyn Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}").starts_with(REFUSED_WRITE);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use tracing_subscriber::layer::SubscriberExt;

    use super::*;

    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// What the log holds of the stack's and Mixdog's records under `RUST_LOG=directives` and the switch, through
    /// the layers `serve` installs.
    fn logged(directives: &str, asked_for: bool) -> String {
        let written = Arc::new(Mutex::new(Vec::new()));
        let sink = written.clone();
        let (levels, stack) = filters(directives, asked_for);
        let subscriber = tracing_subscriber::registry()
            .with(levels)
            .with(stack)
            .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(move || Capture(sink.clone())));
        tracing::subscriber::with_default(subscriber, || {
            log::error!(target: "webrtc::peer_connection::driver", "Failed to write packet to {:?} from {:?}: {}", "192.168.219.104:39995", "172.23.160.1:62767", "os error 10051");
            log::warn!(target: "webrtc::peer_connection::driver", "None tcp/udp socket, drop the packet to {:?} from {:?} for {:?}", "203.0.113.9:40000", "10.8.0.2:51000", "UDP");
            log::error!(target: "webrtc::peer_connection::transport::turn_relayer", "Failed to flush buffered relay packet to {} via {}: {}", "203.0.113.9:40000", "198.51.100.7:50000", "closed");
            log::error!(target: "webrtc::peer_connection::transport::turn_relayer", "TURN allocation failed from {} over {:?}: {}", "10.8.0.2:51000", "Tcp", "486 quota reached for alice-at-example");
            log::warn!(target: "rtc_ice::agent", "Discarded message, not a valid remote candidate from {}", "192.0.2.44:6000");
            log::error!(target: "rtc_turn::client", "allocation refused: {}", "401 realm-text-from-the-server");
            log::info!(target: "rtc::peer_connection::transport::ice", "Ignoring remote candidate with tcpType active: {}", "tcp4 host 192.0.2.45:9");
            log::debug!(target: "rtc_ice::agent", "ping STUN from {} to {}", "10.8.0.3:51000", "192.0.2.46:6000");
            log::error!(target: "mixdog_remote::transport::coordinator", "direct-closed reason=ice-failed local-relay=udp:0,tcp:1,tls:1 selected-at-open=none");
            log::error!(target: "rtcheck::probe", "a crate that only starts like the stack");
        });
        String::from_utf8(written.lock().unwrap().clone()).unwrap()
    }

    /// One mark of every record the stack wrote above.
    const FROM_THE_STACK: [&str; 8] =
        ["172.23.160.1", "None tcp/udp socket", "198.51.100.7", "alice-at-example", "192.0.2.44", "realm-text-from-the-server", "192.0.2.45", "192.0.2.46"];
    const MIXDOGS: [&str; 2] =
        ["direct-closed reason=ice-failed local-relay=udp:0,tcp:1,tls:1 selected-at-open=none", "a crate that only starts like the stack"];

    fn holds(text: &str, marks: &[&str], held: bool, case: &str) {
        for mark in marks {
            assert_eq!(text.contains(mark), held, "{case}: {mark} in {text}");
        }
    }

    #[test]
    fn the_stacks_records_reach_the_log_only_with_the_switch_whatever_rust_log_says() {
        // The stack's records reach the subscriber as the daemon's do: `log` through the bridge `serve` installs.
        tracing_log::LogTracer::init().expect("the bridge is this process's logger");

        // Without the switch, no directive opens the stack: not the default, not a wide level, not one that names
        // the stack to silence it, not one that does not parse.
        for directives in ["", "warn", "debug", "warn,webrtc=off", "warn,webrtc=typo", "error,rtc_ice=trace,webrtc=debug"] {
            let text = logged(directives, false);
            holds(&text, &FROM_THE_STACK, false, directives);
            holds(&text, &MIXDOGS, true, directives);
        }

        // With it, `RUST_LOG` decides the levels: here the driver and the relayer are silenced and the rest of the
        // stack is logged from `warn`.
        let text = logged("warn,webrtc=off", true);
        holds(&text, &["192.0.2.44", "realm-text-from-the-server"], true, "switch, webrtc off");
        holds(&text, &["172.23.160.1", "None tcp/udp socket", "198.51.100.7", "alice-at-example", "192.0.2.45", "192.0.2.46"], false, "switch, webrtc off");
        holds(&text, &MIXDOGS, true, "switch, webrtc off");

        let text = logged("warn", true);
        holds(&text, &["None tcp/udp socket", "198.51.100.7", "alice-at-example", "192.0.2.44", "realm-text-from-the-server"], true, "switch, warn");
        holds(&text, &["172.23.160.1", "192.0.2.45", "192.0.2.46"], false, "switch, warn: the refused write and what is under warn");
    }
}
