//! The watchdog of a joining phone's handshake (`awaitDesktopTurn`, `noteDesktopTurn` and `endHandshakeWatch` of
//! `lib/relay-legs.mjs`).
//!
//! A desktop leg can look open here while it no longer reads (a half-dead path, a wedged process), and a phone joining is when
//! that shows. Both ends give the encrypted handshake 10 s. A missed turn (the challenge after `client-open`, the ready after the
//! hello) costs the desktop at most [`DESKTOP_HANDSHAKE_STALL`] + [`DESKTOP_LIVENESS_PROBE`] = 6 s of that budget before its leg
//! is closed; the remaining 4 s are the redial: a new leg replays `client-open`, and the fresh challenge re-arms the phone's timer
//! on the socket it already has, so the phone never sees the outage.
//!
//! The relay never reads the handshake frames; it tracks the turns on the frames it routes: `challenge` and `ready` are owed by the
//! desktop, `hello` by the phone. Only a turn the DESKTOP owes runs the clock, so a slow phone is never blamed on its PC, and a
//! missed turn alone never closes the shared leg: one phone's handshake can be slow on a PC that is serving everyone else. Only a
//! leg that also stayed silent through the turn AND a ping is closed; the phone's own handshake timer handles a slow-but-live PC.

use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::TaskClass;
use mixdog_rt::time::{Instant, sleep_unrefed};
use tokio::task::AbortHandle;

use super::hub::{Hub, SocketRef};
use crate::close_codes::{DESKTOP_HANDSHAKE_STALLED, DESKTOP_HANDSHAKE_STALLED_REASON};
use crate::logline;

/// How long a turn the desktop owes may pass with the leg saying nothing at all.
pub const DESKTOP_HANDSHAKE_STALL: Duration = Duration::from_millis(4_000);
/// How long a leg that went silent during a missed turn gets to answer a ping before it is judged dead.
pub const DESKTOP_LIVENESS_PROBE: Duration = Duration::from_millis(2_000);

/// The handshake timing of a desktop entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandshakeTiming {
    pub stall: Duration,
    pub probe: Duration,
}

impl Default for HandshakeTiming {
    fn default() -> Self {
        Self { stall: DESKTOP_HANDSHAKE_STALL, probe: DESKTOP_LIVENESS_PROBE }
    }
}

/// Whose move it is in a phone's handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn {
    /// The desktop owes the challenge after `client-open`.
    Challenge,
    /// The phone owes its hello: no clock runs.
    Hello,
    /// The desktop owes the ready after the hello.
    Ready,
}

impl Turn {
    /// The name the log lines carry.
    pub fn name(self) -> &'static str {
        match self {
            Self::Challenge => "challenge",
            Self::Hello => "hello",
            Self::Ready => "ready",
        }
    }
}

/// The handshake state of one phone leg: the turn in progress and its timer.
#[derive(Default)]
pub struct Watch {
    turn: Option<Turn>,
    /// Bumped whenever the timer is replaced or cleared, so a timer already running cannot act for a turn that has moved on.
    epoch: u64,
    timer: Option<AbortHandle>,
}

impl Watch {
    /// The turn being awaited, if any.
    pub fn turn(&self) -> Option<Turn> {
        self.turn
    }

    fn stop_timer(&mut self) {
        self.epoch += 1;
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }

    /// `endHandshakeWatch`: no turn is owed any more.
    pub fn end(&mut self) {
        self.stop_timer();
        self.turn = None;
    }

    /// `noteDesktopTurn`: the desktop routed a frame to this phone, so its turn is taken. The challenge hands the move to the phone;
    /// the ready ends the handshake.
    pub fn note_desktop_turn(&mut self) {
        match self.turn {
            Some(Turn::Challenge) => {
                self.stop_timer();
                self.turn = Some(Turn::Hello);
            }
            Some(Turn::Ready) => self.end(),
            Some(Turn::Hello) | None => {}
        }
    }
}

/// Which phone on which desktop connection a timer watches.
#[derive(Debug, Clone)]
pub struct WatchTarget {
    pub device_id: String,
    pub client_id: String,
    /// The connection the turn is owed by: a redial ends the watch it had.
    pub generation: u64,
}

/// What a timer found when it fired.
enum Verdict {
    /// The turn moved on, the phone left or the connection was replaced: nothing to do.
    Moved,
    /// The leg spoke since the clock started; the turn is let go.
    Heard,
    /// The leg said nothing: the socket to ping or close.
    Silent(SocketRef),
}

/// `awaitDesktopTurn`: start the clock on a turn the desktop owes this phone. A phone that is not live (being rejected, closed or
/// detached) owes nobody anything and ends its watch.
pub fn await_desktop_turn(hub: &Arc<Hub>, target: WatchTarget, watch: &mut Watch, live: bool, timing: HandshakeTiming, turn: Turn) {
    watch.stop_timer();
    if !live {
        watch.turn = None;
        return;
    }
    watch.turn = Some(turn);
    let epoch = watch.epoch;
    let since = Instant::now();
    let hub = Arc::clone(hub);
    let task = mixdog_rt::spawn("relay-handshake-watch", TaskClass::Control, run(hub, target, epoch, turn, timing, since));
    watch.timer = Some(task.abort_handle());
}

async fn run(hub: Arc<Hub>, target: WatchTarget, epoch: u64, turn: Turn, timing: HandshakeTiming, since: Instant) {
    sleep_unrefed(timing.stall).await;
    let desktop = match verdict(&hub, &target, epoch, turn, since) {
        Verdict::Moved => return,
        Verdict::Heard => {
            logline::emit(&logline::slow_phone_handshake(turn.name(), logline::HEARD_LIVE));
            return;
        }
        Verdict::Silent(desktop) => desktop,
    };
    let probed_at = Instant::now();
    // Surfaced as a close when it fails.
    desktop.ping();
    sleep_unrefed(timing.probe).await;
    match verdict(&hub, &target, epoch, turn, probed_at) {
        Verdict::Moved => {}
        Verdict::Heard => logline::emit(&logline::slow_phone_handshake(turn.name(), logline::HEARD_PROBE_ANSWERED)),
        Verdict::Silent(desktop) => {
            logline::emit(&logline::desktop_leg_missed_handshake_turn(turn.name()));
            desktop.close(DESKTOP_HANDSHAKE_STALLED, DESKTOP_HANDSHAKE_STALLED_REASON.as_bytes());
        }
    }
}

/// A turn still owed is let go when the leg spoke since `since`; otherwise the leg is silent.
fn verdict(hub: &Hub, target: &WatchTarget, epoch: u64, turn: Turn, since: Instant) -> Verdict {
    let mut guard = hub.lock();
    let Some(entry) = guard.desktops.get_mut(&target.device_id) else { return Verdict::Moved };
    if entry.conn.generation != target.generation {
        return Verdict::Moved;
    }
    let heard = entry.conn.heard.is_some_and(|at| at > since);
    let Some(phone) = entry.clients.iter_mut().find(|phone| phone.id == target.client_id) else { return Verdict::Moved };
    if phone.watch.epoch != epoch || phone.watch.turn != Some(turn) || !phone.live() {
        return Verdict::Moved;
    }
    if heard {
        phone.watch.end();
        return Verdict::Heard;
    }
    Verdict::Silent(Arc::clone(&entry.conn.socket))
}
