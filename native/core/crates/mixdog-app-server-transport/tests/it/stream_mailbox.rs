//! The phone's streaming mailbox: a text append that ends a quiet spell is sent at once and the appends after it leave as one
//! frame per batch window; anything else (a completion, a resync) is critical and goes at once; while a frame is unacknowledged
//! publications collapse to the newest and a critical one stays critical; a disconnect clears what was waiting.

use mixdog_app_server_transport::stream_mailbox::BATCH_MS;
use mixdog_app_server_transport::stream_mailbox::Frame;
use mixdog_app_server_transport::stream_mailbox::Mailbox;
use mixdog_app_server_transport::stream_mailbox::is_streaming_text_append;
use mixdog_app_server_transport::stream_mailbox::painted_text;
use serde_json::Value;
use serde_json::json;

fn live(text: &str) -> Value {
    json!({ "sessionId": "s", "frameSource": "live", "snapshot": { "busy": true, "items": [{ "id": "user", "kind": "user", "text": "input" }], "streamingTail": { "id": "tail", "kind": "assistant", "text": text } } })
}

fn finished(text: &str) -> Value {
    json!({ "sessionId": "s", "frameSource": "live", "snapshot": { "busy": false, "items": [{ "id": "tail", "kind": "assistant", "text": text }] } })
}

fn with_partial(tail: &str, partial_id: &str, partial: &str, from: usize) -> Value {
    let mut update = live(tail);
    update["snapshot"]["streamingPartial"] = json!({ "id": partial_id, "text": partial, "from": from });
    update
}

/// A mailbox whose socket acknowledges every frame at once, and the frames it sent with the time each left.
struct Acked {
    mailbox: Mailbox,
    now: u64,
    sent: Vec<(u64, Frame)>,
}

impl Acked {
    fn new() -> Self {
        Self { mailbox: Mailbox::default(), now: 0, sent: Vec::new() }
    }

    fn take(&mut self, frames: Vec<Frame>) {
        for frame in frames {
            let next = self.mailbox.acknowledge(frame.sequence);
            self.sent.push((self.now, frame));
            self.take(next);
        }
    }

    fn publish(&mut self, update: Value) {
        let frames = self.mailbox.publish(update, self.now);
        self.take(frames);
    }

    fn advance(&mut self, ms: u64) {
        self.now += ms;
        let frames = self.mailbox.fire(self.now);
        self.take(frames);
    }
}

#[test]
fn a_text_burst_sends_its_first_append_at_once_then_one_latest_snapshot_per_window() {
    let mut phone = Acked::new();
    phone.publish(live(""));
    assert_eq!(phone.sent.len(), 1);
    assert!(phone.sent[0].1.critical, "the first state is not an append");
    phone.publish(live("a"));
    assert_eq!(phone.sent.len(), 2, "the first append after a quiet spell goes at once");
    assert!(!phone.sent[1].1.critical);
    assert_eq!(phone.mailbox.due(), Some(BATCH_MS));

    phone.advance(10);
    phone.publish(live("ab"));
    phone.advance(10);
    phone.publish(live("abc"));
    assert_eq!(phone.sent.len(), 2, "appends inside the window are held");

    phone.advance(BATCH_MS - 20);
    assert_eq!(phone.sent.len(), 3, "the window ends with one frame");
    assert_eq!(painted_text(&phone.sent[2].1.value).as_deref(), Some("abc"), "the frame is the latest state, not each step");
    assert_eq!(phone.sent[2].0, BATCH_MS);

    phone.advance(BATCH_MS);
    assert_eq!(phone.sent.len(), 3, "an empty window sends nothing");
    assert_eq!(phone.mailbox.due(), None);
}

#[test]
fn a_hundred_appends_four_ms_apart_leave_one_frame_per_window_and_end_with_the_whole_text() {
    let mut phone = Acked::new();
    phone.publish(live(""));
    let mut text = String::new();
    for _ in 0..100 {
        text.push_str("응답 ");
        phone.publish(live(&text));
        phone.advance(4);
    }
    phone.advance(BATCH_MS);
    let times: Vec<u64> = phone.sent.iter().map(|(at, _)| *at).collect();
    // The first append leaves at once (0) and opens a 90 ms window; each later frame leaves at the first 4 ms tick at or after the
    // previous frame plus 90 ms (92, 184, 276, 368), and the tail published after 368 leaves in the last window.
    assert_eq!(times, vec![0, 0, 92, 184, 276, 368, 490]);
    assert_eq!(painted_text(&phone.sent.last().unwrap().1.value), Some(text));
}

#[test]
fn a_completion_goes_at_once_as_critical_and_drops_the_held_append() {
    let mut phone = Acked::new();
    phone.publish(live(""));
    phone.publish(live("a"));
    phone.publish(live("ab"));
    assert_eq!(phone.sent.len(), 2);
    phone.publish(finished("ab"));
    assert_eq!(phone.sent.len(), 3);
    assert!(phone.sent[2].1.critical);
    assert_eq!(phone.mailbox.due(), None, "the window is closed");
    phone.advance(BATCH_MS);
    assert_eq!(phone.sent.len(), 3, "the held append does not follow the completion");
}

#[test]
fn partial_line_growth_is_an_append_and_another_rows_partial_is_not() {
    let before = with_partial("hello ", "tail", "wor", 6);
    assert_eq!(painted_text(&before).as_deref(), Some("hello wor"));
    assert!(is_streaming_text_append(Some(&before), &with_partial("hello ", "tail", "world", 6)));
    assert!(is_streaming_text_append(Some(&before), &live("hello world")), "the partial settling into the tail is growth");

    let other_row = with_partial("hello ", "other", "wor", 6);
    assert_eq!(painted_text(&other_row).as_deref(), Some("hello "), "a partial of another row paints nothing");
    assert!(!is_streaming_text_append(Some(&live("hello ")), &other_row));
}

#[test]
fn only_growth_of_the_same_live_row_is_an_append() {
    let base = live("ab");
    assert!(is_streaming_text_append(Some(&base), &live("abc")));
    assert!(!is_streaming_text_append(None, &live("abc")), "nothing before it");
    assert!(!is_streaming_text_append(Some(&base), &live("ab")), "no growth");
    assert!(!is_streaming_text_append(Some(&base), &live("xyz")), "the text was rewritten, not extended");
    assert!(!is_streaming_text_append(Some(&base), &finished("abc")));
    let mut replay = live("abc");
    replay["frameSource"] = json!("replay");
    assert!(!is_streaming_text_append(Some(&base), &replay), "only live frames batch");
    let mut other_session = live("abc");
    other_session["sessionId"] = json!("t");
    assert!(!is_streaming_text_append(Some(&base), &other_session));
    let mut other_item = live("abc");
    other_item["snapshot"]["items"] = json!([]);
    assert!(!is_streaming_text_append(Some(&base), &other_item), "a changed item list is not just text growth");
    let mut lane_end = live("abc");
    lane_end["laneEnd"] = json!("done");
    assert!(!is_streaming_text_append(Some(&base), &lane_end));
}

#[test]
fn while_a_frame_is_unacknowledged_publications_collapse_and_a_critical_one_stays_critical() {
    let mut mailbox = Mailbox::default();
    let first = mailbox.publish(live(""), 0);
    assert_eq!(first.len(), 1);
    assert!(mailbox.publish(live("a"), 1).is_empty(), "one frame is in flight at a time");
    assert!(mailbox.publish(finished("a"), 2).is_empty());
    assert!(mailbox.publish(live("b"), 3).is_empty());
    let next = mailbox.acknowledge(first[0].sequence);
    assert_eq!(next.len(), 1, "what waited leaves as one frame");
    assert!(next[0].critical, "back-pressure never downgrades a critical state");
    assert_eq!(next[0].value, live("b"), "the newest state is the one that is sent");
    assert!(mailbox.acknowledge(first[0].sequence).is_empty(), "an acknowledgement of an old frame is ignored");
}

#[test]
fn a_disconnect_clears_what_was_waiting() {
    let mut mailbox = Mailbox::default();
    let first = mailbox.publish(live(""), 0);
    mailbox.publish(live("a"), 1);
    mailbox.publish(live("ab"), 2);
    assert_eq!(mailbox.due(), Some(1 + BATCH_MS), "the append at 1 ms opened a window");
    mailbox.clear();
    assert_eq!(mailbox.due(), None);
    assert!(mailbox.acknowledge(first[0].sequence).is_empty(), "the frame in flight went with the connection");
    assert!(mailbox.fire(10_000).is_empty());
    let after = mailbox.publish(live("fresh"), 20_000);
    assert_eq!(after.len(), 1);
    assert!(after[0].critical, "a new connection starts with a state, not an append");
}

#[test]
fn a_resync_goes_at_once_and_critical_even_while_a_frame_is_in_flight() {
    let mut mailbox = Mailbox::default();
    mailbox.publish(live(""), 0);
    let frames = mailbox.reset(live("whole text"));
    assert_eq!(frames.len(), 1);
    assert!(frames[0].critical);
    assert_eq!(frames[0].value, live("whole text"));
}
