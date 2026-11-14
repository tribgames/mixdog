//! The host's stdin, read on its own thread (MixWorkerInput,
//! MixForegroundLock.cs:445-499): a lease answer reaches the wait it answers
//! while a request is still running, and request lines queue for the request
//! loop, which reads them in order.

use super::lease;
use crate::protocol::FGLOCK_REPLY_MARKER;
use std::io::BufRead;
use std::sync::mpsc::{channel, Receiver, Sender};

pub(super) struct Router {
    requests: Receiver<String>,
}

impl Router {
    pub(super) fn stdin() -> Router {
        Router::new(std::io::BufReader::new(std::io::stdin()))
    }

    /// Routes lease answers to this process's lease channel.
    pub(super) fn new(input: impl BufRead + Send + 'static) -> Router {
        Router::routed(input, lease::receive, lease::input_ended)
    }

    /// Reads `input` on a thread of its own: `answer` gets each lease answer
    /// without its marker, and `ended` runs once nothing more can arrive,
    /// before the request lines end.
    fn routed(
        input: impl BufRead + Send + 'static,
        answer: impl Fn(&str) + Send + 'static,
        ended: impl FnOnce() + Send + 'static,
    ) -> Router {
        let (queue, requests) = channel();
        // A reader that cannot start drops the queue, which ends the request
        // lines as the end of the input does.
        let _ = std::thread::Builder::new()
            .name("mixdog-computer stdin".into())
            .spawn(move || {
                pump(input, &queue, answer);
                ended();
            });
        Router { requests }
    }
}

/// Reads until the input ends, a line cannot be read (a broken pipe, or bytes
/// that are not UTF-8), or the request loop has gone.
fn pump(input: impl BufRead, queue: &Sender<String>, answer: impl Fn(&str)) {
    for line in input.lines() {
        let Ok(line) = line else { break };
        if let Some(body) = line.strip_prefix(FGLOCK_REPLY_MARKER) {
            answer(body);
        } else if !line.trim().is_empty() && queue.send(line).is_err() {
            break;
        }
    }
}

impl Iterator for Router {
    type Item = String;

    /// The next request line, waiting for it; None once the input has ended
    /// and every line read before that was taken.
    fn next(&mut self) -> Option<String> {
        self.requests.recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::Router;
    use std::sync::{Arc, Mutex};

    /// The request lines of `input`, and what else the reader did with it in
    /// order: each lease answer, then "ended".
    fn route(input: &[u8]) -> (Vec<String>, Vec<String>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (answers, end) = (seen.clone(), seen.clone());
        let router = Router::routed(
            std::io::Cursor::new(input.to_vec()),
            move |body| answers.lock().unwrap().push(body.to_string()),
            move || end.lock().unwrap().push("ended".to_string()),
        );
        let requests: Vec<String> = router.collect();
        // The requests end only after the reader said the input ended.
        let seen = seen.lock().unwrap().clone();
        (requests, seen)
    }

    #[test]
    fn requests_skip_blank_lines_and_stop_at_unreadable_input() {
        let (requests, seen) = route(b"a\n\n  \nb\r\n\xff\nc\n");
        assert_eq!(requests, ["a", "b"]);
        assert_eq!(seen, ["ended"]);
    }

    #[test]
    fn lease_answers_are_diverted_and_requests_keep_their_order() {
        let (requests, seen) = route(
            concat!(
                "{\"id\":1}\n",
                "@@MIXDOG_FGLOCK_REPLY@@ack 7 2 5 locked 1.000\n",
                "{\"id\":7,\"action\":\"snapshot\"}\n",
                "@@MIXDOG_FGLOCK_REPLY@@\r\n",
                "@@MIXDOG_FGLOCK_REPLY@@released 7 1 12 released\n",
                " @@MIXDOG_FGLOCK_REPLY@@not at the line start\n",
                "{\"id\":8}",
            )
            .as_bytes(),
        );
        assert_eq!(
            requests,
            [
                "{\"id\":1}",
                "{\"id\":7,\"action\":\"snapshot\"}",
                " @@MIXDOG_FGLOCK_REPLY@@not at the line start",
                "{\"id\":8}",
            ]
        );
        assert_eq!(seen, ["ack 7 2 5 locked 1.000", "", "released 7 1 12 released", "ended"]);
    }

    #[test]
    fn an_empty_input_ends_at_once() {
        assert_eq!(route(b""), (Vec::new(), vec!["ended".to_string()]));
    }

    #[test]
    fn the_reader_stops_when_the_request_loop_has_gone() {
        let (told, ended) = std::sync::mpsc::channel();
        let router = Router::routed(
            std::io::Cursor::new(b"a\nb\nc\n".to_vec()),
            |_| {},
            move || told.send(()).unwrap(),
        );
        drop(router);
        assert_eq!(ended.recv_timeout(std::time::Duration::from_secs(5)), Ok(()));
    }
}
