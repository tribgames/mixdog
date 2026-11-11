//! The inactivity limit on every request to the core: Node's `daemonRequest` (`remote-install-daemon.ts`) gives the core
//! 1,500 ms without a byte (3,000 ms for `/stop`) before it treats the core as not answering. That is `http.request`'s
//! `timeout`, a limit on an idle socket, so a core that answers slowly but steadily is still answering.

use std::io::Read;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

/// `daemonRequest`'s default limit.
pub const ANSWER_IDLE: Duration = Duration::from_millis(1500);
/// The limit `stopDaemon` gives its `/stop` request.
pub const STOP_IDLE: Duration = Duration::from_millis(3000);

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
    /// The current exchange's inactivity limit.
    limit: Duration,
    received: Vec<u8>,
    chunks: u64,
    /// Reads that returned at their own timeout.
    #[cfg(test)]
    read_timeouts: u64,
    ended: Option<std::io::Result<()>>,
    /// Reader threads that have not finished.
    readers: u64,
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

    /// An exchange whose answer may be silent for `limit` before it is given up.
    pub fn begin(&self, limit: Duration) -> Exchange {
        let mut state = self.lock();
        state.exchange += 1;
        state.last_activity = self.now(&state);
        state.limit = limit;
        state.received.clear();
        state.chunks = 0;
        #[cfg(test)]
        {
            state.read_timeouts = 0;
        }
        state.ended = None;
        Exchange(state.exchange)
    }

    /// The longest a single read waits. It decides nothing (a read that times out is read again unless the exchange was
    /// given up); it only bounds the join of a reader whose read a shutdown did not wake. Under the manual clock it is
    /// short, so the tests meet reads that time out.
    fn read_bound(&self, limit: Duration) -> Duration {
        match self.clock {
            Clock::Monotonic(_) => limit,
            #[cfg(test)]
            Clock::Manual => Duration::from_millis(10),
        }
    }

    /// `stream` read to its end, or `None` once it has been silent for the exchange's limit. Either way the reader has
    /// finished and the connection is shut down when this returns: on the limit the socket is shut down, which ends
    /// the blocked read, and the reader is joined.
    pub fn read_to_end(self: &Arc<Self>, exchange: Exchange, mut stream: TcpStream) -> Option<std::io::Result<Vec<u8>>> {
        let closer = match stream.try_clone() {
            Ok(closer) => closer,
            Err(e) => return Some(Err(e)),
        };
        // The join below cannot outlast one read even where a shutdown would not wake a blocked read: no single read
        // waits longer than the limit itself, and a reader whose exchange was given up stops at its read's return.
        let limit = self.lock().limit;
        if let Err(e) = stream.set_read_timeout(Some(self.read_bound(limit))) {
            return Some(Err(e));
        }
        let watch = Arc::clone(self);
        self.lock().readers += 1;
        let reader = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                let read = stream.read(&mut buffer);
                let mut state = watch.lock();
                if state.exchange != exchange.0 {
                    state.readers -= 1;
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
                    // Only the watch's clock gives an exchange up; a read's own timeout is not an end.
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                        #[cfg(test)]
                        {
                            state.read_timeouts += 1;
                            watch.changed.notify_all();
                        }
                        continue;
                    }
                    Err(e) => state.ended = Some(Err(e)),
                }
                let ended = state.ended.is_some();
                if ended {
                    state.readers -= 1;
                }
                watch.changed.notify_all();
                if ended {
                    return;
                }
            }
        });
        let outcome = self.wait();
        if outcome.is_none() {
            // Ends the reader's blocked read; an error means the connection is already gone, so the read has ended too.
            let _ = closer.shutdown(std::net::Shutdown::Both);
        }
        // The reader ends on its read's return after the exchange is over, which the shutdown, the end of the answer or
        // the read bound brings.
        let _ = reader.join();
        outcome
    }

    /// The current exchange's answer, or `None` once it has been silent for its limit (the exchange is then given up:
    /// its reader reports to nobody).
    fn wait(&self) -> Option<std::io::Result<Vec<u8>>> {
        let mut state = self.lock();
        loop {
            if let Some(ended) = state.ended.take() {
                return Some(ended.map(|()| std::mem::take(&mut state.received)));
            }
            let now = self.now(&state);
            let deadline = state.last_activity + state.limit;
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

    /// Reader threads that have not finished.
    #[cfg(test)]
    pub fn readers(&self) -> u64 {
        self.lock().readers
    }

    /// Returns once the exchange has received `n` chunks.
    #[cfg(test)]
    pub fn wait_chunks(&self, n: u64) {
        let mut state = self.lock();
        while state.chunks < n {
            state = self.changed.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Returns once a read of the exchange has timed out after this call.
    #[cfg(test)]
    pub fn wait_a_read_timeout(&self) {
        let mut state = self.lock();
        let seen = state.read_timeouts;
        while state.read_timeouts == seen {
            state = self.changed.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }
}
