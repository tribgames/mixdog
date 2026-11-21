//! What the core's stderr leaves out of the `webrtc` driver's lines.

use std::fmt::Debug;

use tracing::field::Field;
use tracing::field::Visit;
use tracing_log::NormalizeEvent;
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

const DRIVER: &str = "webrtc::peer_connection::driver";
const REFUSED_WRITE: &str = "Failed to write packet to ";

/// Drops the driver's line for one datagram a socket refused. ICE checks every local interface
/// against every candidate, and an interface that cannot reach one (a virtual adapter without a
/// route out) has each check refused: one such line per packet for the life of an attempt. Every
/// other line of the driver stays, its relay-gathering errors included. The driver logs through
/// `log`, whose records the bridge turns into events of target `log`: the driver's own target is
/// in the normalized metadata.
pub(crate) struct RefusedWrites;

impl<S: tracing::Subscriber> Layer<S> for RefusedWrites {
    fn event_enabled(&self, event: &tracing::Event<'_>, _: Context<'_, S>) -> bool {
        let from_driver = match event.normalized_metadata() {
            Some(metadata) => metadata.target() == DRIVER,
            None => event.metadata().target() == DRIVER,
        };
        if !from_driver {
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

    #[test]
    fn only_the_drivers_refused_write_line_is_left_out() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let sink = written.clone();
        let subscriber = tracing_subscriber::registry()
            .with(RefusedWrites)
            .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(move || Capture(sink.clone())));
        // The driver's records reach the subscriber as the daemon's do: `log` through the bridge `serve` installs.
        tracing_log::LogTracer::init().expect("the bridge is this process's logger");
        tracing::subscriber::with_default(subscriber, || {
            log::error!(target: "webrtc::peer_connection::driver", "Failed to write packet to {:?} from {:?}: {}", "192.168.219.104:39995", "172.23.160.1:62767", "os error 10051");
            log::error!(target: "webrtc::peer_connection::driver", "Failed to gather relay candidates: {}", "allocation timed out");
            log::error!(target: "webrtc::peer_connection::transport::turn_relayer", "TURN transaction timed out: {:?}", [1u8]);
            log::error!(target: "mixdog_remote::elsewhere", "Failed to write packet to the relay");
        });
        let text = String::from_utf8(written.lock().unwrap().clone()).unwrap();
        assert!(!text.contains("172.23.160.1"), "{text}");
        for kept in ["Failed to gather relay candidates", "TURN transaction timed out", "Failed to write packet to the relay"] {
            assert!(text.contains(kept), "{kept} is kept: {text}");
        }
    }
}
