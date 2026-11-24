use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

/// A point of a reply the stand-in holds at until the test opens it.
#[derive(Clone, Debug, Default)]
pub struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    /// Lets the reply go on.
    pub fn open(&self) {
        let (lock, wake) = &*self.0;
        *lock.lock().unwrap_or_else(PoisonError::into_inner) = true;
        wake.notify_all();
    }

    fn pass(&self) {
        let (lock, wake) = &*self.0;
        let mut open = lock.lock().unwrap_or_else(PoisonError::into_inner);
        while !*open {
            open = wake.wait(open).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// One scripted answer of the model.
#[derive(Clone, Debug, Default)]
pub struct Reply {
    /// The text deltas, in order.
    pub chunks: Vec<String>,
    /// Tool calls after the text: `(id, name, input)`.
    pub calls: Vec<(String, String, Value)>,
    /// The pause after each delta.
    pub pause: Duration,
    /// Gates the reply waits at: `(n, gate)` holds it after its first `n` text deltas (`n` equal to the number of deltas holds
    /// it before the message ends).
    pub holds: Vec<(usize, Gate)>,
}

impl Reply {
    pub fn text(text: &str) -> Self {
        Self { chunks: vec![text.to_owned()], ..Self::default() }
    }

    /// `text` split into deltas of `lines` lines each, with `pause` after each.
    pub fn streamed(text: &str, lines: usize, pause: Duration) -> Self {
        let rows: Vec<&str> = text.split_inclusive('\n').collect();
        Self { chunks: rows.chunks(lines.max(1)).map(|group| group.concat()).collect(), pause, ..Self::default() }
    }

    /// An answer that is only tool calls.
    pub fn calls(calls: Vec<(&str, &str, Value)>) -> Self {
        Self { calls: calls.into_iter().map(|(id, name, input)| (id.to_owned(), name.to_owned(), input)).collect(), ..Self::default() }
    }
}

/// The opening of the core's session-title prompt (`mixdog-core` `run_host::title_completion`). A session's title is asked of
/// the model beside its turns, at the first turn's first output: it is answered apart, so a script holds the turns' answers only.
const TITLE_PROMPT: &str = "Create a concise, natural session title";
const TITLE: &str = "Stand-in session";

/// Whether `body` is the core's title request: its system prompt asks for the session's title.
fn asks_for_a_title(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|request| request.get("system").map(Value::to_string))
        .is_some_and(|system| system.contains(TITLE_PROMPT))
}

/// One server-sent event.
fn event(kind: &str, data: &Value) -> String {
    format!("event: {kind}\ndata: {data}\n\n")
}

pub struct Provider {
    addr: SocketAddr,
    script: Arc<Mutex<VecDeque<Reply>>>,
    served: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
}

impl Provider {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let addr = listener.local_addr().expect("its address");
        let script = Arc::new(Mutex::new(VecDeque::new()));
        let served = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (shared, count, halt) = (Arc::clone(&script), Arc::clone(&served), Arc::clone(&stop));
        thread::Builder::new()
            .name("stand-in-provider".to_owned())
            .spawn(move || {
                for stream in listener.incoming() {
                    if halt.load(Ordering::Acquire) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    let (shared, count) = (Arc::clone(&shared), Arc::clone(&count));
                    let _ = thread::Builder::new().name("stand-in-connection".to_owned()).spawn(move || answer(stream, &shared, &count));
                }
            })
            .expect("the stand-in's thread");
        Self { addr, script, served, stop }
    }

    /// The provider's `baseURL`.
    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Replaces what is scripted: the next requests are answered with `replies`, in order.
    pub fn script(&self, replies: Vec<Reply>) {
        *self.script.lock().unwrap_or_else(PoisonError::into_inner) = replies.into();
    }

    /// How many messages requests of the turns (not the title's) have been answered.
    pub fn served(&self) -> usize {
        self.served.load(Ordering::Acquire)
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Wakes the accept loop so it sees the flag.
        let _ = TcpStream::connect(self.addr);
    }
}

/// Reads one request (the head and the body it announces) and returns its request line, lower-cased, and the body of a
/// request with a length (the core's model requests carry one); a chunked body is read but not returned.
fn read_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    stream.set_read_timeout(Some(Duration::from_secs(30))).ok()?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        raw.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).to_ascii_lowercase();
    let line = head.lines().next().unwrap_or_default().to_owned();
    let length = head.lines().find_map(|row| row.strip_prefix("content-length:")).and_then(|value| value.trim().parse::<usize>().ok());
    let chunked = head.lines().any(|row| row.starts_with("transfer-encoding:") && row.contains("chunked"));
    if let Some(length) = length {
        while raw.len() < head_end + length {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                return None;
            }
            raw.extend_from_slice(&chunk[..read]);
        }
        return Some((line, raw[head_end..head_end + length].to_vec()));
    } else if chunked {
        while !raw[head_end..].ends_with(b"0\r\n\r\n") {
            let read = stream.read(&mut chunk).ok()?;
            if read == 0 {
                return None;
            }
            raw.extend_from_slice(&chunk[..read]);
        }
    }
    Some((line, Vec::new()))
}

fn answer(mut stream: TcpStream, script: &Mutex<VecDeque<Reply>>, served: &AtomicUsize) {
    let Some((line, body)) = read_request(&mut stream) else { return };
    let messages =
        line.starts_with("post ") && line.split_whitespace().nth(1).is_some_and(|path| path.split('?').next().unwrap_or_default().ends_with("/v1/messages"));
    if !messages {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nno script");
        return;
    }
    if asks_for_a_title(&body) {
        let _ = stream_reply(&mut stream, &Reply::text(TITLE), &format!("msg_title_{}", served.load(Ordering::Acquire)));
        return;
    }
    let reply = script.lock().unwrap_or_else(PoisonError::into_inner).pop_front().unwrap_or_else(|| Reply::text("ok"));
    let index = served.fetch_add(1, Ordering::AcqRel);
    let _ = stream_reply(&mut stream, &reply, &format!("msg_{index}"));
}

fn send(stream: &mut TcpStream, kind: &str, data: &Value) -> std::io::Result<()> {
    stream.write_all(event(kind, data).as_bytes())?;
    stream.flush()
}

fn stream_reply(stream: &mut TcpStream, reply: &Reply, id: &str) -> std::io::Result<()> {
    stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-cache\r\nconnection: close\r\n\r\n")?;
    send(
        stream,
        "message_start",
        &json!({ "type": "message_start", "message": { "id": id, "type": "message", "role": "assistant", "model": "claude-sonnet-4-6", "content": [], "usage": { "input_tokens": 10, "output_tokens": 1 } } }),
    )?;
    let hold = |sent: usize| reply.holds.iter().filter(|(at, _)| *at == sent).for_each(|(_, gate)| gate.pass());
    let mut block = 0;
    if !reply.chunks.is_empty() {
        send(stream, "content_block_start", &json!({ "type": "content_block_start", "index": block, "content_block": { "type": "text", "text": "" } }))?;
        for (sent, chunk) in reply.chunks.iter().enumerate() {
            hold(sent);
            send(stream, "content_block_delta", &json!({ "type": "content_block_delta", "index": block, "delta": { "type": "text_delta", "text": chunk } }))?;
            if !reply.pause.is_zero() {
                thread::park_timeout(reply.pause);
            }
        }
        hold(reply.chunks.len());
        send(stream, "content_block_stop", &json!({ "type": "content_block_stop", "index": block }))?;
        block += 1;
    }
    for (id, name, input) in &reply.calls {
        send(
            stream,
            "content_block_start",
            &json!({ "type": "content_block_start", "index": block, "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} } }),
        )?;
        send(
            stream,
            "content_block_delta",
            &json!({ "type": "content_block_delta", "index": block, "delta": { "type": "input_json_delta", "partial_json": input.to_string() } }),
        )?;
        send(stream, "content_block_stop", &json!({ "type": "content_block_stop", "index": block }))?;
        block += 1;
    }
    let stop = if reply.calls.is_empty() { "end_turn" } else { "tool_use" };
    send(stream, "message_delta", &json!({ "type": "message_delta", "delta": { "stop_reason": stop }, "usage": { "output_tokens": 10 } }))?;
    send(stream, "message_stop", &json!({ "type": "message_stop" }))
}
