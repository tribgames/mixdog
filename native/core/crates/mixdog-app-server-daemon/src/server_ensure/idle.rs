//! The inactivity limit on the attachment probe: Node's `daemonRequest` (`remote-install-daemon.ts`) gives the core
//! 1,500 ms without a byte before it treats the core as not answering. That is `http.request`'s `timeout`, a limit on an
//! idle socket, so a core that answers slowly but steadily is still answering.

use std::io::Read;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

pub const ANSWER_IDLE: Duration = Duration::from_millis(1500);

/// The clock the limit is measured on and the state of the exchange it watches. An exchange starts before the request
/// is sent, as Node's timeout runs from the socket's creation.
pub struct IdleWatch {
    state: Mutex<State>,
    changed: Condvar,
    clock: Clock,
}

enum Clock {
    Monotonic(Instant),
    #[cfg(test)]
    Manual,
}

#[derive(Default)]
struct State {
    /// Which exchange the reader thread reports to; one given up on stops counting.
    exchange: u64,
    #[cfg(test)]
    manual_now: Duration,
    last_activity: Duration,
    received: Vec<u8>,
    chunks: u64,
    ended: Option<std::io::Result<()>>,
}

/// An exchange begun on an [`IdleWatch`].
pub struct Exchange(u64);

impl IdleWatch {
    pub fn monotonic() -> Arc<Self> {
        Self::on(Clock::Monotonic(Instant::now()))
    }

    /// A clock that moves only by [`IdleWatch::advance`].
    #[cfg(test)]
    pub fn manual() -> Arc<Self> {
        Self::on(Clock::Manual)
    }

    fn on(clock: Clock) -> Arc<Self> {
        Arc::new(Self { state: Mutex::default(), changed: Condvar::new(), clock })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    #[cfg_attr(not(test), allow(unused_variables, reason = "only the manual clock of the tests reads the state"))]
    fn now(&self, state: &State) -> Duration {
        match self.clock {
            Clock::Monotonic(start) => start.elapsed(),
            #[cfg(test)]
            Clock::Manual => state.manual_now,
        }
    }

    pub fn begin(&self) -> Exchange {
        let mut state = self.lock();
        state.exchange += 1;
        state.last_activity = self.now(&state);
        state.received.clear();
        state.chunks = 0;
        state.ended = None;
        Exchange(state.exchange)
    }

    /// `stream` read to its end, or `None` once it has been silent for [`ANSWER_IDLE`]. A reader given up on stays
    /// blocked on its socket until the peer closes it or this one-shot program exits; it reports to nobody.
    pub fn read_to_end(self: &Arc<Self>, exchange: Exchange, mut stream: TcpStream) -> Option<std::io::Result<Vec<u8>>> {
        let watch = Arc::clone(self);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                let read = stream.read(&mut buffer);
                let mut state = watch.lock();
                if state.exchange != exchange.0 {
                    return;
                }
                match read {
                    Ok(0) => state.ended = Some(Ok(())),
                    Ok(n) => {
                        state.received.extend_from_slice(&buffer[..n]);
                        state.chunks += 1;
                        state.last_activity = watch.now(&state);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => state.ended = Some(Err(e)),
                }
                let ended = state.ended.is_some();
                watch.changed.notify_all();
                if ended {
                    return;
                }
            }
        });
        let mut state = self.lock();
        loop {
            if let Some(ended) = state.ended.take() {
                return Some(ended.map(|()| std::mem::take(&mut state.received)));
            }
            let now = self.now(&state);
            let deadline = state.last_activity + ANSWER_IDLE;
            if now >= deadline {
                state.exchange += 1;
                return None;
            }
            state = match self.clock {
                Clock::Monotonic(_) => {
                    self.changed.wait_timeout(state, deadline - now).unwrap_or_else(std::sync::PoisonError::into_inner).0
                }
                #[cfg(test)]
                Clock::Manual => self.changed.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner),
            };
        }
    }

    #[cfg(test)]
    pub fn advance(&self, by: Duration) {
        self.lock().manual_now += by;
        self.changed.notify_all();
    }

    /// Returns once the exchange has received `n` chunks.
    #[cfg(test)]
    pub fn wait_chunks(&self, n: u64) {
        let mut state = self.lock();
        while state.chunks < n {
            state = self.changed.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}
