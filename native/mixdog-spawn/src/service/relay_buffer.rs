//! The output of a terminal tab as Node's relay push lane sent it to a phone (`remote-relay-push-lanes.ts`, a `TerminalDataBufferer` with
//! `{ delayMs: 16, leadingEdge: true }` and the default 256 KiB high watermark, every frame acknowledged as it is sent): the first output
//! after 16 ms of quiet goes at once, output within 16 ms of the last frame waits until 16 ms after it and goes as one frame, and a frame
//! carries at most 256 Ki UTF-16 units (more is sent as several frames at once). Nothing else flushes it: neither the exit nor a dispose
//! (the relay lane never `release`s a tab, terminal-data-buffer.ts), so an exit line waits for its 16 ms like any output.
//!
//! The window's own terminal IPC (`ipc-terminal.ts`, 5 ms, flow control by the renderer's acknowledgements) sits in the desktop's main
//! process over the raw `process:<tab>` feed and is unchanged; this is the relay's rule, on the feed only a phone reads.
//!
//! A pure state machine: time is what the caller passes, so a test moves it explicitly.

use std::time::Duration;

use tokio::time::Instant;

/// Node's relay delay (`delayMs: 16`).
pub(crate) const RELAY_DELAY: Duration = Duration::from_millis(16);
/// Node's default high watermark (`256 * 1024` characters, UTF-16 units): the most one frame carries.
pub(crate) const RELAY_FRAME_UNITS: usize = 256 * 1024;

#[derive(Default)]
pub(crate) struct RelayBuffer {
    pending: Vec<u8>,
    last: Option<Instant>,
    due: Option<Instant>,
}

impl RelayBuffer {
    /// Output arrived at `now`: the frames to send at once (none while it waits).
    pub(crate) fn push(&mut self, bytes: &[u8], now: Instant) -> Vec<RelayFrame> {
        if bytes.is_empty() {
            return Vec::new();
        }
        if !self.pending.is_empty() {
            self.pending.extend_from_slice(bytes);
            return Vec::new();
        }
        self.pending.extend_from_slice(bytes);
        let wait = self.last.map_or(Duration::ZERO, |last| RELAY_DELAY.saturating_sub(now.saturating_duration_since(last)));
        if wait.is_zero() {
            return self.flush(now);
        }
        self.due = Some(now + wait);
        Vec::new()
    }

    /// When the waiting output is due; `None` while nothing waits.
    pub(crate) fn due(&self) -> Option<Instant> {
        self.due
    }

    /// Sends what waits, at `now`.
    pub(crate) fn flush(&mut self, now: Instant) -> Vec<RelayFrame> {
        self.due = None;
        if self.pending.is_empty() {
            return Vec::new();
        }
        self.last = Some(now);
        split_units(&std::mem::take(&mut self.pending), RELAY_FRAME_UNITS)
    }
}

/// One relay frame: its bytes, and the lone UTF-16 units Node's frame had at its edges when its cut fell inside a non-BMP character
/// (`joined.slice(0, available)`, terminal-data-buffer.ts:75). UTF-8 bytes cannot hold half a character, so the high surrogate that ends
/// such a frame travels as `tail` and the low one that starts the next as `lead`, as the replay window's `replayLeadUnit` does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RelayFrame {
    pub(crate) lead: Option<u16>,
    pub(crate) bytes: Vec<u8>,
    pub(crate) tail: Option<u16>,
}

/// `bytes` in frames of exactly `limit` UTF-16 units of their text but the last (an invalid sequence counts as the one U+FFFD a decoder
/// makes of it): Node's cut, inside a surrogate pair where it falls there.
fn split_units(bytes: &[u8], limit: usize) -> Vec<RelayFrame> {
    let mut frames = Vec::new();
    let mut frame = RelayFrame::default();
    let mut units = 0usize;
    let mut at = 0usize;
    let mut start = 0usize;
    let mut cut = |frame: &mut RelayFrame, end: usize, start: &mut usize, tail: Option<u16>, lead: Option<u16>| {
        frame.bytes = bytes[*start..end].to_vec();
        frame.tail = tail;
        frames.push(std::mem::replace(frame, RelayFrame { lead, ..RelayFrame::default() }));
    };
    for chunk in bytes.utf8_chunks() {
        let units_of = chunk.valid().chars().map(|c| (c.len_utf16(), c.len_utf8(), Some(c))).chain((!chunk.invalid().is_empty()).then_some((1, chunk.invalid().len(), None)));
        for (width, len, c) in units_of {
            if units + width > limit && units > 0 {
                if width == 2 && units + 1 == limit {
                    // Node's slice ends with the high surrogate; the low one starts the next frame.
                    let mut pair = [0u16; 2];
                    c.expect("a two-unit character").encode_utf16(&mut pair);
                    cut(&mut frame, at, &mut start, Some(pair[0]), Some(pair[1]));
                    at += len;
                    start = at;
                    units = 1;
                    continue;
                }
                cut(&mut frame, at, &mut start, None, None);
                start = at;
                units = 0;
            }
            units += width;
            at += len;
        }
    }
    if at > start || frame.lead.is_some() {
        frame.bytes = bytes[start..at].to_vec();
        frames.push(frame);
    }
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's relay rule at its edges (terminal-data-buffer.ts with `{ delayMs: 16, leadingEdge: true }`): the first output goes at once,
    /// output within 16 ms of a frame waits until 16 ms after it and joins whatever else arrives meanwhile, and output after 16 ms of quiet
    /// goes at once again. Time moves only as the test says.
    #[test]
    fn output_goes_at_once_after_quiet_and_joins_within_sixteen_ms() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let plain = |text: &[u8]| vec![RelayFrame { bytes: text.to_vec(), ..RelayFrame::default() }];
        let mut buffer = RelayBuffer::default();
        assert_eq!(buffer.push(b"echo", at(0)), plain(b"echo"), "the first output goes at once");
        assert_eq!(buffer.push(b"out", at(5)), Vec::new(), "within 16 ms of a frame it waits");
        assert_eq!(buffer.due(), Some(at(16)), "until 16 ms after the frame");
        assert_eq!(buffer.push(b"put", at(10)), Vec::new());
        assert_eq!(buffer.due(), Some(at(16)), "more output keeps the time it is due");
        assert_eq!(buffer.flush(at(16)), plain(b"output"), "as one frame");
        assert_eq!(buffer.due(), None);
        assert_eq!(buffer.push(b"x", at(31)), Vec::new(), "15 ms after the last frame it waits");
        assert_eq!(buffer.due(), Some(at(32)));
        assert_eq!(buffer.flush(at(32)), plain(b"x"));
        assert_eq!(buffer.push(b"y", at(48)), plain(b"y"), "16 ms after the last frame it goes at once");
    }

    /// The frames of Node's relay lane for a scripted sequence of chunks on a virtual clock (apps/mobile/fixtures/relay-framing, recorded
    /// by benchmarks/rust-core/recorders/record-relay-framing.mjs): the same steps through the relay buffer, driven as the feed pump
    /// drives it (a due buffer is flushed when due; an exit flushes what waits when due), give the same frames at the same times, each
    /// as a phone decodes it (the bytes through one streaming UTF-8 decoder per tab, the lone units at its edges around them).
    #[test]
    fn the_frames_are_nodes_for_the_recorded_script() {
        use std::collections::BTreeMap;

        use serde_json::Value;
        use serde_json::json;
        let golden: Value = serde_json::from_str(include_str!("../../../../apps/mobile/fixtures/relay-framing/golden.json")).unwrap();
        let start = Instant::now();
        let ms = |at: &Value| start + Duration::from_millis(at.as_u64().unwrap());
        let bytes_of = |segments: &Value| -> Vec<u8> {
            let mut out = Vec::new();
            for segment in segments.as_array().unwrap() {
                if let Some(hex) = segment["hex"].as_str() {
                    out.extend((0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()));
                } else {
                    out.extend(segment["text"].as_str().unwrap().repeat(segment["times"].as_u64().unwrap_or(1) as usize).into_bytes());
                }
            }
            out
        };
        // Per tab: its buffer, its decoder's carried partial character, and the frames a phone got.
        let mut tabs: BTreeMap<String, (RelayBuffer, Vec<u8>, Vec<Value>)> = BTreeMap::new();
        let send = |frames: Vec<RelayFrame>, at: Instant, carry: &mut Vec<u8>, got: &mut Vec<Value>| {
            for frame in frames {
                carry.extend_from_slice(&frame.bytes);
                let valid = match std::str::from_utf8(carry) {
                    Ok(text) => text.len(),
                    Err(error) if error.error_len().is_none() => error.valid_up_to(),
                    Err(error) => panic!("invalid output in the script: {error}"),
                };
                let text = String::from_utf8(carry.drain(..valid).collect()).unwrap();
                let mut runs: Vec<(char, u64)> = Vec::new();
                for c in text.chars() {
                    match runs.last_mut() {
                        Some((last, count)) if *last == c => *count += 1,
                        _ => runs.push((c, 1)),
                    }
                }
                if text.is_empty() && frame.lead.is_none() && frame.tail.is_none() {
                    continue;
                }
                let runs: Vec<Value> = runs.into_iter().map(|(c, n)| json!([c.to_string(), n])).collect();
                got.push(json!({ "at": (at - start).as_millis() as u64, "lead": frame.lead, "runs": runs, "tail": frame.tail }));
            }
        };
        // What is due before `until` on every tab is sent when due (the pump's timer), in the order of the times.
        let run_due = |tabs: &mut BTreeMap<String, (RelayBuffer, Vec<u8>, Vec<Value>)>, until: Instant| {
            for (buffer, carry, got) in tabs.values_mut() {
                if let Some(due) = buffer.due().filter(|due| *due <= until) {
                    let frames = buffer.flush(due);
                    send(frames, due, carry, got);
                }
            }
        };
        for step in golden["steps"].as_array().unwrap() {
            let at = ms(&step["at"]);
            run_due(&mut tabs, at);
            let Some(segments) = step.get("bytes") else { continue };
            let (buffer, carry, got) = tabs.entry(step["tab"].as_str().unwrap().to_owned()).or_default();
            let frames = buffer.push(&bytes_of(segments), at);
            send(frames, at, carry, got);
        }
        run_due(&mut tabs, start + Duration::from_secs(3600));
        let mut node: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for frame in golden["frames"].as_array().unwrap() {
            let mut frame = frame.clone();
            let tab = frame.as_object_mut().unwrap().remove("tab").unwrap().as_str().unwrap().to_owned();
            node.entry(tab).or_default().push(frame);
        }
        let got: BTreeMap<String, Vec<Value>> = tabs.into_iter().map(|(tab, (_, _, got))| (tab, got)).collect();
        assert_eq!(got, node);
    }
}
