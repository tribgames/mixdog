//! Pipe adapter for the desktop's one-action elevation supervisor. No input is
//! dispatched here: Windows owns the UAC process, receipts and cleanup.
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use serde_json::{json, Value};

pub const MAX_REQUEST: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct Cancellation {
    requested: AtomicBool,
    marker: Mutex<Option<PathBuf>>,
}
impl Cancellation {
    pub fn requested(&self) -> bool { self.requested.load(Ordering::SeqCst) }
    pub fn cancel(&self) {
        // Serialize arming and signalling: cancellation during a blocking UAC
        // prompt must already be visible when the elevated process starts.
        let marker = self.marker.lock().unwrap_or_else(|error| error.into_inner());
        self.requested.store(true, Ordering::SeqCst);
        if let Some(path) = marker.as_ref() { let _ = std::fs::write(path, b"cancel"); }
    }
    pub fn arm(&self, path: PathBuf) -> Result<(), String> {
        let mut marker = self.marker.lock().unwrap_or_else(|error| error.into_inner());
        if self.requested() { std::fs::write(&path, b"cancel").map_err(|error| error.to_string())?; }
        *marker = Some(path);
        Ok(())
    }
    pub fn disarm(&self) {
        // Wait out an in-flight writer before its staging directory is removed.
        *self.marker.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

pub fn read_line(reader: &mut impl BufRead, limit: usize) -> Result<Vec<u8>, String> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().map_err(|error| error.to_string())?;
        if bytes.is_empty() { return Ok(line); }
        let count = bytes.iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |at| at + 1);
        if line.len() + count > limit { return Err("computer_capacity_exhausted: worker request budget exceeded; input was not dispatched".into()); }
        let complete = bytes[count - 1] == b'\n';
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if complete { return Ok(line); }
    }
}

pub fn emit(value: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

pub fn run() -> i32 {
    let mut input = std::io::BufReader::new(std::io::stdin());
    let request = read_line(&mut input, MAX_REQUEST)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string()));
    let request = match request {
        Ok(Value::Object(value)) => Value::Object(value),
        _ => { emit(json!({"kind":"result", "stopped":true, "error":"privileged worker request is not an object"})); return 1; }
    };
    let cancelled = Arc::new(Cancellation::default());
    let signal = cancelled.clone();
    let controls = std::thread::spawn(move || {
        // The only control is cancellation. EOF also means the owning desktop
        // disappeared. Malformed/oversized control cannot keep input running.
        let _ = read_line(&mut input, 128);
        signal.cancel();
    });
    let code = crate::platform::elevated_launch(request, cancelled.clone());
    cancelled.disarm();
    // The adapter closes stdin after receiving the final receipt. Join the
    // control reader before exit; it cannot outlive this launch or its files.
    let _ = controls.join();
    code
}

pub fn process_start_ticks(arg: &str) -> i32 {
    let Some(pid) = arg.parse::<u32>().ok().filter(|pid| *pid > 0) else { return 2; };
    match crate::platform::process_start_ticks(pid) {
        Ok(Some(ticks)) => { println!("{ticks}"); 0 }
        Ok(None) => 0,
        Err(error) => { eprintln!("{error}"); 1 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_keeps_the_cancel_line_for_the_control_reader() {
        let mut input = std::io::Cursor::new(b"{\"id\":1}\n{\"cancel\":true}\n");
        assert_eq!(read_line(&mut input, 32).unwrap(), b"{\"id\":1}\n");
        assert_eq!(read_line(&mut input, 32).unwrap(), b"{\"cancel\":true}\n");
        assert!(read_line(&mut input, 32).unwrap().is_empty());
    }
    #[test]
    fn oversized_request_is_rejected_before_dispatch() {
        assert!(read_line(&mut std::io::Cursor::new(b"12345\n"), 5).unwrap_err().starts_with("computer_capacity_exhausted"));
    }
    #[test]
    fn cancellation_is_visible_during_a_blocked_launch_in_either_arming_order() {
        let root = std::env::temp_dir().join(format!("mixdog-cancel-unit-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&root).unwrap();
        for cancel_first in [false, true] {
            let signal = Cancellation::default();
            let path = root.join(if cancel_first { "before" } else { "during" });
            if cancel_first { signal.cancel(); }
            signal.arm(path.clone()).unwrap();
            if !cancel_first { signal.cancel(); }
            // No launch/wait loop ran: an elevated process starting now already sees cancellation.
            assert!(signal.requested());
            assert_eq!(std::fs::read(path).unwrap(), b"cancel");
            signal.disarm();
        }
        let signal = Cancellation::default();
        let path = root.join("completed");
        signal.arm(path.clone()).unwrap();
        signal.disarm();
        signal.cancel();
        assert!(!path.exists(), "a completed launch cannot receive a late marker write");
        std::fs::remove_dir_all(root).unwrap();
    }
}
