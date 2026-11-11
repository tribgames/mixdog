//! A thread's text appends coalesced on the writer, for a peer that announced `feedRanges` (Node's phone mailbox,
//! `remote-streaming-mailbox.ts` over `createLatestStateMailbox`, `REMOTE_STREAM_BATCH_MS` = 90; [`crate::stream_mailbox`] is its
//! state machine on Node's snapshots, replayed against the recording). The writer has no snapshot: it classifies by frame kind and
//! item id. An append is an `item/agentMessage/delta` frame; the run of consecutive appends of one item on one lane is one
//! append. The first append after a quiet spell is written at once and opens a window of [`BATCH_MS`]; the appends of that item
//! within the window are held and leave as one frame when the window ends (`feed.from..=feed.seq`, the deltas joined), which
//! opens the next window. Any other frame (a different item's append, a completion, an approval, a frame of no feed) is critical:
//! the held appends leave first, then it, and the window closes. The writer writes one frame at a time and waits for the socket
//! to take it (back-pressure); a lane that lags or goes, and the connection's close, drop what is held (clear on disconnect).

use bytes::Bytes;
use serde_json::Value;
use tokio::time::Duration;
use tokio::time::Instant;

/// `REMOTE_STREAM_BATCH_MS`.
pub const BATCH_MS: u64 = 90;

const DELTA: &str = "item/agentMessage/delta";

/// A frame for the socket and what it holds until the socket has taken it.
pub(crate) type Out<T> = (Bytes, Vec<T>);

struct Window {
    lane: u64,
    item: String,
    due: Instant,
}

struct Held<T> {
    frame: Value,
    from: u64,
    seq: u64,
    delta: String,
    holds: Vec<T>,
}

pub(crate) struct Appends<T> {
    window: Option<Window>,
    held: Option<Held<T>>,
}

impl<T> Default for Appends<T> {
    fn default() -> Self {
        Self { window: None, held: None }
    }
}

/// An append's item, position, delta and parsed frame; `None` for any other frame.
fn append_of(frame: &[u8]) -> Option<(String, u64, String, Value)> {
    // Only a frame that names the method is parsed.
    if !frame.windows(DELTA.len()).any(|window| window == DELTA.as_bytes()) {
        return None;
    }
    let value: Value = serde_json::from_slice(frame).ok()?;
    if value.get("method").and_then(Value::as_str) != Some(DELTA) || value.get("id").is_some() {
        return None;
    }
    let params = value.get("params")?;
    let item = params.get("itemId")?.as_str()?.to_owned();
    let delta = params.get("delta")?.as_str()?.to_owned();
    let feed = value.get("feed")?;
    if feed.get("from").is_some() {
        return None;
    }
    let seq = feed.get("seq")?.as_u64()?;
    Some((item, seq, delta, value))
}

impl<T> Appends<T> {
    /// When the window ends.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.window.as_ref().map(|window| window.due)
    }

    /// The window ended by `now`: its held appends leave as one frame and open the next window; with none held it closes.
    pub(crate) fn fire(&mut self, now: Instant) -> Option<Out<T>> {
        let window = self.window.as_mut()?;
        if window.due > now {
            return None;
        }
        match self.held.take() {
            Some(held) => {
                window.due = now + Duration::from_millis(BATCH_MS);
                Some(merged(held))
            }
            None => {
                self.window = None;
                None
            }
        }
    }

    /// `frame` of `lane` (none for a connection frame) is next in write order at `now`: what leaves, in order (nothing while it is
    /// held). The caller has fired the window first.
    pub(crate) fn admit(&mut self, lane: Option<u64>, frame: Bytes, hold: T, now: Instant) -> Vec<Out<T>> {
        let append = lane.and_then(|lane| append_of(&frame).map(|append| (lane, append)));
        if let Some((lane, (item, seq, delta, value))) = append {
            let window = self.window.as_ref().filter(|window| window.lane == lane && window.item == item);
            if window.is_some() {
                match self.held.as_mut() {
                    Some(held) if held.seq + 1 == seq => {
                        held.seq = seq;
                        held.delta.push_str(&delta);
                        held.holds.push(hold);
                        return Vec::new();
                    }
                    Some(_) => {}
                    None => {
                        self.held = Some(Held { frame: value, from: seq, seq, delta, holds: vec![hold] });
                        return Vec::new();
                    }
                }
            }
            // A quiet spell's first append (or another item's, or one after a gap): the held appends leave, it goes at once
            // and opens a window.
            let mut out: Vec<Out<T>> = self.held.take().map(merged).into_iter().collect();
            out.push((frame, vec![hold]));
            self.window = Some(Window { lane, item, due: now + Duration::from_millis(BATCH_MS) });
            return out;
        }
        let mut out: Vec<Out<T>> = self.held.take().map(merged).into_iter().collect();
        out.push((frame, vec![hold]));
        self.window = None;
        out
    }

    /// `lane` lagged or went: what it holds is dropped (its recovery snapshot replaces it).
    pub(crate) fn drop_lane(&mut self, lane: u64) {
        if self.window.as_ref().is_some_and(|window| window.lane == lane) {
            self.window = None;
            self.held = None;
        }
    }

    /// The connection went: nothing held survives it.
    pub(crate) fn clear(&mut self) {
        self.window = None;
        self.held = None;
    }
}

/// The held appends as one frame: the first one's frame with every delta joined, standing for `from..=seq`.
fn merged<T>(held: Held<T>) -> Out<T> {
    let Held { mut frame, from, seq, delta, holds } = held;
    if from == seq {
        // One append held: it leaves as it came.
        return (Bytes::from(serde_json::to_vec(&frame).expect("a frame serializes")), holds);
    }
    frame["params"]["delta"] = Value::String(delta);
    frame["feed"]["seq"] = Value::from(seq);
    frame["feed"]["from"] = Value::from(from);
    (Bytes::from(serde_json::to_vec(&frame).expect("a frame serializes")), holds)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn delta(item: &str, seq: u64, text: &str) -> Bytes {
        Bytes::from(json!({ "method": DELTA, "params": { "threadId": "t", "turnId": "u", "itemId": item, "delta": text }, "feed": { "id": "thread:t", "epoch": "e", "seq": seq } }).to_string())
    }

    fn other(seq: u64) -> Bytes {
        Bytes::from(json!({ "method": "thread/frame", "params": { "threadId": "t", "structureChanged": false }, "feed": { "id": "thread:t", "epoch": "e", "seq": seq } }).to_string())
    }

    fn json_of(out: &[Out<u64>]) -> Vec<Value> {
        out.iter().map(|(frame, _)| serde_json::from_slice(frame).unwrap()).collect()
    }

    #[tokio::test(start_paused = true)]
    async fn the_first_append_goes_at_once_and_the_window_leaves_as_one_ranged_frame() {
        let t = Instant::now();
        let mut appends = Appends::<u64>::default();
        assert_eq!(appends.admit(Some(1), delta("a", 1, "x"), 1, t).len(), 1, "the first append is written at once");
        assert!(appends.admit(Some(1), delta("a", 2, "y"), 2, t + Duration::from_millis(4)).is_empty());
        assert!(appends.admit(Some(1), delta("a", 3, "z"), 3, t + Duration::from_millis(8)).is_empty());
        assert!(appends.fire(t + Duration::from_millis(89)).is_none(), "the window is still open");
        let out = appends.fire(t + Duration::from_millis(90)).expect("the window's appends");
        let value: Value = serde_json::from_slice(&out.0).unwrap();
        assert_eq!(value["params"]["delta"], "yz");
        assert_eq!(value["feed"], json!({ "id": "thread:t", "epoch": "e", "seq": 3, "from": 2 }));
        assert_eq!(out.1, vec![2, 3], "the merged frame holds what its appends held");
        assert_eq!(appends.due(), Some(t + Duration::from_millis(180)), "a window that sent opens the next one");
        assert!(appends.fire(t + Duration::from_millis(180)).is_none());
        assert_eq!(appends.due(), None, "a window with nothing held closes");
    }

    #[tokio::test(start_paused = true)]
    async fn any_other_frame_flushes_the_held_appends_before_it_and_closes_the_window() {
        let t = Instant::now();
        let mut appends = Appends::<u64>::default();
        appends.admit(Some(1), delta("a", 1, "x"), 1, t);
        appends.admit(Some(1), delta("a", 2, "y"), 2, t);
        let out = json_of(&appends.admit(Some(1), other(3), 3, t));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["feed"]["seq"], 2, "one held append leaves as it came");
        assert!(out[0]["feed"].get("from").is_none());
        assert_eq!(out[1]["method"], "thread/frame");
        assert_eq!(appends.due(), None);
        // Another item's append is not part of the run.
        appends.admit(Some(1), delta("a", 4, "x"), 4, t);
        let out = appends.admit(Some(1), delta("b", 5, "y"), 5, t);
        assert_eq!(out.len(), 1, "another item's append is written at once and opens its own window");
    }

    #[tokio::test(start_paused = true)]
    async fn a_lagged_lane_and_a_closed_connection_drop_what_is_held() {
        let t = Instant::now();
        let mut appends = Appends::<u64>::default();
        appends.admit(Some(1), delta("a", 1, "x"), 1, t);
        appends.admit(Some(1), delta("a", 2, "y"), 2, t);
        appends.drop_lane(2);
        assert!(appends.due().is_some(), "another lane's lag leaves the window");
        appends.drop_lane(1);
        assert!(appends.due().is_none() && appends.fire(t + Duration::from_secs(1)).is_none());
        appends.admit(Some(1), delta("a", 3, "x"), 3, t);
        appends.admit(Some(1), delta("a", 4, "y"), 4, t);
        appends.clear();
        assert!(appends.fire(t + Duration::from_secs(1)).is_none());
    }
}
