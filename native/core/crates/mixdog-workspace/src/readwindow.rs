//! A text read answered a window at a time. A connection carries at most 512 KiB per answer, a file up to 10 MiB, so the reader asks for
//! the text in windows (`projectFs/readText` with `maxChars`) and joins them. Node answered a read from one authorized handle, in one
//! piece: every window of one read therefore comes from the one read of the file made when the first window was asked, with the
//! metadata (`mtimeMs`, `encoding`, ...) of that read; a file replaced between two windows changes nothing the reader sees.
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;
use serde_json::json;

use crate::error::Reason;
use crate::error::WsError;
use crate::error::WsResult;

/// Reads held open at once. A read that is never finished (its phone went away) is dropped by the newer ones.
const MAX_OPEN_READS: usize = 16;

struct Held {
    id: String,
    owner: String,
    /// The one read's answer without its text.
    meta: Value,
    content: String,
    total: usize,
    /// Where the window that follows the last one served starts: code point, and its byte offset in `content`.
    cursor: (usize, usize),
}

#[derive(Default)]
pub struct ReadWindows {
    held: Mutex<VecDeque<Held>>,
    /// The owners with a first window still being read, and whether the owner closed meanwhile. A first window finishes after its
    /// connection closed (running requests are let finish), and would register a whole file for an owner nobody will ask again.
    /// Lock order: `reading`, then `held`.
    reading: Mutex<HashMap<String, Reading>>,
}

#[derive(Default)]
struct Reading {
    count: usize,
    closed: bool,
}

/// A first window under way for an owner: taken before the file is read, handed to [`ReadWindows::begin`] after.
pub struct FirstWindow<'a> {
    windows: &'a ReadWindows,
    owner: String,
}

impl Drop for FirstWindow<'_> {
    fn drop(&mut self) {
        let mut reading = self.windows.reading.lock().expect("read windows");
        if let Some(state) = reading.get_mut(&self.owner) {
            state.count -= 1;
            if state.count == 0 {
                reading.remove(&self.owner);
            }
        }
    }
}

/// The `max` code points of `content` from byte `start_byte`, and the byte where the next window starts.
fn window(content: &str, start_byte: usize, max: usize) -> (&str, usize) {
    let rest = &content[start_byte..];
    let end = rest.char_indices().nth(max).map_or(rest.len(), |(at, _)| at);
    (&rest[..end], start_byte + end)
}

impl ReadWindows {
    /// The first window of a read: `answer` is the file's whole reply, read once. When text remains, the read is held and the answer
    /// carries `readId` with `nextChar`.
    pub fn begin(&self, first: &FirstWindow<'_>, mut answer: Value, max: usize) -> Value {
        // Held to the push: a close cannot come between the check and the registration.
        let reading = self.reading.lock().expect("read windows");
        let closed = reading.get(&first.owner).is_some_and(|state| state.closed);
        let content = answer["content"].as_str().unwrap_or_default().to_owned();
        let total = content.chars().count();
        let (piece, next_byte) = window(&content, 0, max);
        let piece = piece.to_owned();
        answer["content"] = json!(piece);
        if total <= max || closed {
            return answer;
        }
        let id = uuid::Uuid::new_v4().to_string();
        answer["nextChar"] = json!(max);
        answer["readId"] = json!(id);
        let mut meta = answer.clone();
        meta.as_object_mut().expect("a file's reply is an object").retain(|key, _| key != "nextChar" && key != "readId" && key != "content");
        let mut held = self.held.lock().expect("read windows");
        held.push_back(Held { id, owner: first.owner.clone(), meta, content, total, cursor: (max, next_byte) });
        while held.len() > MAX_OPEN_READS {
            held.pop_front();
        }
        answer
    }

    /// The reads `owner` left unfinished go with its connection: each holds a whole file's text, and nothing else frees them
    /// short of sixteen newer reads.
    pub fn release_owner(&self, owner: &str) {
        let mut reading = self.reading.lock().expect("read windows");
        if let Some(state) = reading.get_mut(owner) {
            state.closed = true;
        }
        self.held.lock().expect("read windows").retain(|read| read.owner != owner);
    }

    /// Marks a first window of `owner` as under way, before its file is read.
    pub fn first_window(&self, owner: &str) -> FirstWindow<'_> {
        self.reading.lock().expect("read windows").entry(owner.to_owned()).or_default().count += 1;
        FirstWindow { windows: self, owner: owner.to_owned() }
    }

    /// The window of a held read from code point `from`; the read is released with its last window.
    pub fn next(&self, owner: &str, id: &str, from: usize, max: usize) -> WsResult<Value> {
        let mut held = self.held.lock().expect("read windows");
        let at = held
            .iter()
            .position(|read| read.id == id && read.owner == owner)
            .ok_or_else(|| WsError::new(Reason::Expired, "This read is no longer available."))?;
        let read = &mut held[at];
        if from > read.total {
            return Err(WsError::invalid("fromChar is past the end of the text."));
        }
        let start_byte = if from == read.cursor.0 { read.cursor.1 } else { read.content.char_indices().nth(from).map_or(read.content.len(), |(byte, _)| byte) };
        let (piece, next_byte) = window(&read.content, start_byte, max);
        let mut answer = read.meta.clone();
        answer["content"] = json!(piece);
        let next = from + max;
        if next < read.total {
            answer["nextChar"] = json!(next);
            answer["readId"] = json!(read.id);
            read.cursor = (next, next_byte);
        } else {
            held.remove(at);
        }
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(text: &str, mtime: f64) -> Value {
        json!({ "content": text, "mtimeMs": mtime, "binary": false, "tooLarge": false, "encoding": "utf8" })
    }

    fn drain(windows: &ReadWindows, first: Value, max: usize) -> (String, Vec<Value>) {
        let mut text = first["content"].as_str().unwrap().to_owned();
        let mut answers = vec![first.clone()];
        let mut at = first;
        while let Some(next) = at.get("nextChar").and_then(Value::as_u64) {
            let id = at["readId"].as_str().unwrap().to_owned();
            at = windows.next("c1", &id, next as usize, max).unwrap();
            text.push_str(at["content"].as_str().unwrap());
            answers.push(at.clone());
        }
        (text, answers)
    }

    #[test]
    fn windows_join_to_the_text_and_carry_the_one_reads_metadata() {
        let windows = ReadWindows::default();
        let text = "가나다라마바사 abc\u{1F600}def";
        let first = windows.begin(&windows.first_window("c1"), reply(text, 7.0), 5);
        let (joined, answers) = drain(&windows, first, 5);
        assert_eq!(joined, text);
        assert!(answers.iter().all(|a| a["mtimeMs"] == 7.0 && a["encoding"] == "utf8"));
        assert!(answers.last().unwrap().get("nextChar").is_none() && answers.last().unwrap().get("readId").is_none());
        assert!(windows.held.lock().unwrap().is_empty(), "the last window releases the read");
    }

    #[test]
    fn a_text_that_fits_one_window_holds_nothing() {
        let windows = ReadWindows::default();
        let answer = windows.begin(&windows.first_window("c1"), reply("short", 1.0), 60_000);
        assert_eq!(answer, reply("short", 1.0));
        assert!(windows.held.lock().unwrap().is_empty());
    }

    #[test]
    fn a_read_belongs_to_its_connection_and_an_unknown_read_is_refused() {
        let windows = ReadWindows::default();
        let first = windows.begin(&windows.first_window("c1"), reply("0123456789", 1.0), 4);
        let id = first["readId"].as_str().unwrap();
        assert_eq!(windows.next("c2", id, 4, 4).unwrap_err().reason, Reason::Expired);
        assert_eq!(windows.next("c1", "nope", 4, 4).unwrap_err().reason, Reason::Expired);
    }

    #[test]
    fn a_first_window_finishing_after_its_owner_closed_holds_nothing() {
        let windows = ReadWindows::default();
        let (dead, alive) = (windows.first_window("c1"), windows.first_window("c2"));
        windows.release_owner("c1");
        let answer = windows.begin(&dead, reply("0123456789", 1.0), 4);
        assert!(answer.get("readId").is_none());
        let kept = windows.begin(&alive, reply("0123456789", 1.0), 4);
        assert_eq!(windows.held.lock().unwrap().len(), 1);
        assert!(windows.next("c2", kept["readId"].as_str().unwrap(), 4, 4).is_ok());
        drop((dead, alive));
        assert!(windows.reading.lock().unwrap().is_empty(), "no owner is remembered once its reads are done");
    }
    #[test]
    fn the_oldest_unfinished_read_makes_room_for_a_newer_one() {
        let windows = ReadWindows::default();
        let first = windows.begin(&windows.first_window("c1"), reply("0123456789", 1.0), 4);
        let id = first["readId"].as_str().unwrap().to_owned();
        for _ in 0..MAX_OPEN_READS {
            windows.begin(&windows.first_window("c1"), reply("0123456789", 1.0), 4);
        }
        assert_eq!(windows.next("c1", &id, 4, 4).unwrap_err().reason, Reason::Expired);
    }
}
