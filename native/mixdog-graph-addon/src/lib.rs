// In-process transport for the mixdog-graph resident search engine.
//
// The engine used to run only as a child process (`mixdog-graph
// --serve-search`), which Windows Task Manager lists as its own top-level row
// forever: it groups rows per executable image, so a separately named helper
// can never fold into the app's row no matter what its version resource says.
// Hosting the identical engine inside the caller removes the process — and the
// row — without forking the search code: this file is a transport only.
//
// The wire protocol is unchanged. Request lines go in through `send`, JSONL
// response lines come back through the constructor's callback, exactly the
// bytes that used to travel over the child's stdin/stdout pipes.
use std::io::{self, Write};
use std::sync::Mutex;

use mixdog_graph::serve_search::SearchServer as Engine;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;

/// Turns the engine's byte stream back into whole JSONL lines.
///
/// The response queue writes one line per flush, but a `BufWriter` sits in
/// between, so a single `write` may carry a partial line, a whole one, or
/// several. Only complete lines are handed to JavaScript; a trailing partial
/// stays buffered until its newline arrives.
struct LineWriter<F: Fn(String) + Send + 'static> {
    emit: F,
    pending: Vec<u8>,
}

impl<F: Fn(String) + Send + 'static> LineWriter<F> {
    fn new(emit: F) -> Self {
        Self {
            emit,
            pending: Vec::new(),
        }
    }
}

impl<F: Fn(String) + Send + 'static> Write for LineWriter<F> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        while let Some(index) = self.pending.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=index).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            // Responses are serde_json output, so they are valid UTF-8 by
            // construction; lossy decoding is the belt that keeps one damaged
            // byte from killing the writer thread.
            (self.emit)(String::from_utf8_lossy(&line).into_owned());
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// One resident search engine, hosted inside the calling Node process.
#[napi]
pub struct SearchServer {
    // `None` once shut down, so a late `send` reports the closure instead of
    // resurrecting an engine whose caches were already released.
    engine: Mutex<Option<Engine>>,
}

#[napi]
impl SearchServer {
    /// `on_line` receives one JSONL response line per call, from an engine
    /// thread. It is invoked on the JavaScript thread that constructed this
    /// server.
    #[napi(constructor)]
    pub fn new(on_line: Function<String, ()>) -> Result<Self> {
        let callback = on_line
            .build_threadsafe_function()
            // Weak: the engine must never be the reason the host's event loop
            // stays alive. The host keeps its own handles referenced while
            // requests are in flight, exactly as it did with the child process.
            .weak::<true>()
            // The callback takes the line itself, not (err, line).
            .callee_handled::<false>()
            .build()?;
        let engine = Engine::embedded(LineWriter::new(move |line: String| {
            // NonBlocking: an engine thread must never stall behind a busy
            // JavaScript thread. The queue ahead of this writer already applies
            // the backpressure that bounds memory.
            callback.call(line, ThreadsafeFunctionCallMode::NonBlocking);
        }));
        Ok(Self {
            engine: Mutex::new(Some(engine)),
        })
    }

    /// Queue one request line. Returns false once the server is shut down.
    /// Never blocks on search work.
    #[napi]
    pub fn send(&self, line: String) -> bool {
        let guard = self.engine.lock().unwrap_or_else(|error| error.into_inner());
        match guard.as_ref() {
            Some(engine) => engine.dispatch(&line),
            None => false,
        }
    }

    /// Stop the engine and release its caches. Idempotent: the host may call
    /// this on teardown and still let the object be collected afterwards.
    #[napi]
    pub fn shutdown(&self) {
        let mut guard = self.engine.lock().unwrap_or_else(|error| error.into_inner());
        // Dropping the engine runs its ordered shutdown: drain, persist, then
        // release the writer.
        guard.take();
    }
}
