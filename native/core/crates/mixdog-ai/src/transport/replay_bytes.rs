//! A replay's barrier on the model's bytes (feature `replay-bytes`, development builds only; off until
//! `MIXDOG_REPLAY_BYTES=127.0.0.1:<port>` names the replay's listener). Bytes arriving on a socket are outside the core's clock
//! until the core admits them, so a replay that advances the clock after writing a scripted response first waits for this
//! announcement: after each response chunk the core has handled (its reader asked for the next chunk, or the body ended),
//! one line `bytes <total>` with the total of response bytes handled since the process began.

use async_trait::async_trait;
use bytes::Bytes;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;
use std::sync::OnceLock;

use super::link::BodyStream;
use mixdog_core_api::domain::provider::TransportFault;

/// The replay's listener address.
pub const ENV: &str = "MIXDOG_REPLAY_BYTES";

struct Announcer {
    stream: TcpStream,
    total: u64,
}

fn announcer() -> Option<&'static Mutex<Announcer>> {
    static ANNOUNCER: OnceLock<Option<Mutex<Announcer>>> = OnceLock::new();
    ANNOUNCER
        .get_or_init(|| {
            let address = std::env::var(ENV).ok()?;
            // A core started under a replay's barrier must not run without it.
            let stream = TcpStream::connect(&address).unwrap_or_else(|error| panic!("the replay's byte barrier at {address}: {error}"));
            let _ = stream.set_nodelay(true);
            Some(Mutex::new(Announcer { stream, total: 0 }))
        })
        .as_ref()
}

/// A response body whose chunks are announced as handled when its reader asks for the next (or the body ends).
pub(crate) struct Counted {
    inner: Box<dyn BodyStream>,
    held: usize,
}

/// `body`, counted for the replay's barrier.
pub(crate) fn counted(body: Box<dyn BodyStream>) -> Box<dyn BodyStream> {
    Box::new(Counted { inner: body, held: 0 })
}

#[async_trait]
impl BodyStream for Counted {
    fn hold_connection(&mut self) {
        self.inner.hold_connection();
    }

    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        handled(std::mem::take(&mut self.held));
        let item = self.inner.next().await;
        match &item {
            Some(Ok(bytes)) => self.held = bytes.len(),
            None => handled(std::mem::take(&mut self.held)),
            Some(Err(_)) => {}
        }
        item
    }
}

/// `bytes` more of a response were handled.
fn handled(bytes: usize) {
    if bytes == 0 {
        return;
    }
    let Some(announcer) = announcer() else { return };
    let mut announcer = announcer.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    announcer.total += bytes as u64;
    let line = format!("bytes {}\n", announcer.total);
    announcer.stream.write_all(line.as_bytes()).expect("the replay's byte barrier");
}
