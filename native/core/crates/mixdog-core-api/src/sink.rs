//! Connection writer API (P §6.5): implemented by `mixdog-app-server-transport`, used by the
//! server (control lane) and by every feed (subscription lanes).
//!
//! The connection's `queueBytes` is split into the ordered class's reserve (responses, errors,
//! server requests, `serverRequest/resolved` and the frames of ordered lanes; never dropped)
//! and one event budget shared by all lanes, with no per-lane minimum. One writer task per
//! connection writes pings first and every text frame in the order it was queued on the
//! connection (Lead decision 2026-11-11): nothing overtakes a frame queued earlier, except that
//! a lane's frames wait for the response that opens it and a lagged lane's recovery snapshot may
//! land after frames queued meanwhile. Bytes return to the budget when a frame is handed to the
//! socket. No method here waits: producers never wait on a socket; a full budget is answered
//! by lag (droppable feeds) or close (the ordered class).
//!
//! Ordering contract per lane: a lane opens gated; the writer drains none of its frames until
//! the response that carries its [`LaneRelease`] has been written on the control lane
//! ([`ConnectionSink::send_control_release`]). Inside a lane, the writer never sends past an
//! unfilled [`SnapshotSlot`]. So the wire order is always: response → replay frames or the
//! snapshot → live frames.

use std::sync::Arc;

use bytes::Bytes;

use crate::ids::ConnectionId;
use crate::ids::SubscriptionId;

/// The connection is closed; the frame was not queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SinkClosed;

/// The connection's event budget lacks the requested bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BudgetFull;

/// One connection's writer, as seen by the server and the feeds. Closing a connection is the
/// transport's own API (close codes are wire types); feeds never close connections.
pub trait ConnectionSink: Send + Sync {
    fn id(&self) -> ConnectionId;

    /// Queues a connection-scoped frame on the control lane. Exhausting the control reserve
    /// closes the connection with 4000 `slowConsumer` and answers [`SinkClosed`].
    fn send_control(&self, frame: Bytes) -> Result<(), SinkClosed>;

    /// [`Self::send_control`] for the response that opens a subscription: once `frame` is
    /// written, the lane named by `release` is ungated. Consuming the release is the only way
    /// to ungate a lane, so no lane frame can precede its response.
    fn send_control_release(&self, frame: Bytes, release: LaneRelease) -> Result<(), SinkClosed>;

    /// Opens a gated, empty lane for `sub` ([`crate::feed::subscribe`] is the only caller).
    /// `recovery` is called by the writer when this lane is the oldest lagged lane and the free
    /// event budget reaches `maxSnapshotBytes`.
    fn open_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed>;

    /// [`Self::open_lane`] for a feed whose events are never dropped (the ordered class): its
    /// frames hold the control reserve, and once anything of it was written a failed
    /// reservation closes the connection with 4000 `slowConsumer` instead of lagging. A sink
    /// without the class opens a plain lane.
    fn open_ordered_lane(
        &self,
        sub: SubscriptionId,
        recovery: Arc<dyn LaneRecovery>,
    ) -> Result<(Arc<dyn Lane>, LaneRelease), SinkClosed> {
        self.open_lane(sub, recovery)
    }
}

/// One subscription's ordered lane inside a connection.
pub trait Lane: Send + Sync {
    fn sub(&self) -> SubscriptionId;

    /// Reserves bytes for frames: from the connection's shared event budget, or for an ordered
    /// lane from the control reserve.
    fn try_reserve(&self, bytes: usize) -> Result<Reservation, BudgetFull>;

    /// Reserves bytes for a snapshot slot, always from the event budget.
    fn try_reserve_snapshot(&self, bytes: usize) -> Result<Reservation, BudgetFull> {
        self.try_reserve(bytes)
    }

    /// Appends `frame`, holding `reservation` (≥ `frame.len()`) until the frame is written.
    /// On a lagged or closed lane the frame is discarded and the bytes return at once.
    fn push(&self, reservation: Reservation, frame: Bytes);

    /// Appends a placeholder filled later, in order; the writer stops at it until it is
    /// filled. On a lagged lane this ends the lag (the recovery snapshot).
    fn push_slot(&self, reservation: Reservation) -> SnapshotSlot;

    /// Enters `Lagged`: releases every unwritten frame of this lane, including any snapshot
    /// slot, and queues the lane for writer-driven recovery (oldest lag first, one at a time
    /// per connection). Returns the released bytes. Other lanes keep their frames.
    fn lag(&self) -> usize;

    fn is_lagged(&self) -> bool;

    /// Removes the lane and releases its unwritten frames (unsubscribe, detach).
    fn close(&self);
}

/// Writer-driven lag recovery (SPEC §4.2, P §6.5 step 3), supplied by
/// [`crate::feed::subscribe`]: it re-enters the feed's attach with
/// [`crate::feed::AttachStart::Recover`]. Called on the writer task; never waits.
pub trait LaneRecovery: Send + Sync {
    /// `reservation` holds `maxSnapshotBytes` for the recovery snapshot.
    fn recover(&self, sub: SubscriptionId, reservation: Reservation);
}

/// Returns reserved bytes to a connection's event budget.
pub trait ByteBudget: Send + Sync {
    fn release(&self, bytes: usize);
}

/// Bytes taken from an event budget; dropping it returns the bytes.
#[must_use]
pub struct Reservation {
    bytes: usize,
    budget: Arc<dyn ByteBudget>,
}

impl Reservation {
    /// Created by the transport after taking `bytes` from `budget`.
    pub fn new(bytes: usize, budget: Arc<dyn ByteBudget>) -> Self {
        Self { bytes, budget }
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Splits off `bytes` into a new reservation; `None` if fewer are held.
    pub fn split(&mut self, bytes: usize) -> Option<Reservation> {
        if bytes > self.bytes {
            return None;
        }
        self.bytes -= bytes;
        Some(Reservation {
            bytes,
            budget: Arc::clone(&self.budget),
        })
    }

    /// Returns everything above `bytes` to the budget.
    pub fn shrink_to(&mut self, bytes: usize) {
        if bytes < self.bytes {
            self.budget.release(self.bytes - bytes);
            self.bytes = bytes;
        }
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.bytes > 0 {
            self.budget.release(self.bytes);
        }
    }
}

impl std::fmt::Debug for Reservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reservation")
            .field("bytes", &self.bytes)
            .finish()
    }
}

/// Transport side of a snapshot slot.
pub trait SlotFill: Send {
    /// Fills the slot and releases the reservation's excess. A frame larger than the slot's
    /// reservation lags the lane. Dropping an unfilled `SlotFill` lags the lane too.
    fn fill(self: Box<Self>, frame: Bytes);
}

/// A placeholder in a lane, filled with the encoded snapshot once it exists.
#[must_use]
pub struct SnapshotSlot {
    fill: Box<dyn SlotFill>,
}

impl SnapshotSlot {
    pub fn new(fill: Box<dyn SlotFill>) -> Self {
        Self { fill }
    }

    pub fn fill(self, frame: Bytes) {
        self.fill.fill(frame)
    }
}

/// Ungates one lane when the response carrying it is written. Created by
/// [`ConnectionSink::open_lane`], consumed by [`ConnectionSink::send_control_release`].
#[must_use]
#[derive(Debug, PartialEq, Eq)]
pub struct LaneRelease {
    connection: ConnectionId,
    sub: SubscriptionId,
}

impl LaneRelease {
    pub fn new(connection: ConnectionId, sub: SubscriptionId) -> Self {
        Self { connection, sub }
    }

    pub fn connection(&self) -> ConnectionId {
        self.connection
    }

    pub fn sub(&self) -> &SubscriptionId {
        &self.sub
    }
}
