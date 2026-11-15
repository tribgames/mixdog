//! What the host writes: one JSON line per answer on stdout (`Emit-Json`: `ConvertTo-Json -Depth 20 -Compress`, then the
//! CRLF `Console.Out.WriteLine` ends a line with, no byte order mark) and the cleanup lines on stderr
//! (`MIXDOG_OFFICE_CLEANUP <text>`). Every line is flushed as soon as it is written: the transport reads them as they come.

use std::io::Write;

use crate::ps::Value;
use crate::ps::ObjectKind;
use crate::ps::convert;
use crate::ps::json;
use crate::ps::payload;
use crate::session::BACKEND;

/// The prefix of the line a failed cleanup is reported on.
pub const CLEANUP_PREFIX: &str = "MIXDOG_OFFICE_CLEANUP ";

/// The host's two output streams.
pub struct Emitter {
    out: Box<dyn Write>,
    err: Box<dyn Write>,
}

impl Emitter {
    pub fn new(out: Box<dyn Write>, err: Box<dyn Write>) -> Self {
        Self { out, err }
    }

    /// The process's stdout and stderr.
    pub fn stdio() -> Self {
        Self::new(Box::new(std::io::stdout()), Box::new(std::io::stderr()))
    }

    /// `Emit-Json $value`. A broken pipe is not an error of the host: the reader that closed it is gone, and the
    /// cleanup that follows still has to run.
    pub fn line(&mut self, value: &Value) {
        let _ = self.out.write_all(json::emit_json(value).as_bytes());
        let _ = self.out.flush();
    }

    /// `Write-OfficeCleanupFailure $cleanup`: nothing for a cleanup that succeeded, otherwise the failed cleanup as
    /// `ConvertTo-Json -Depth 8 -Compress` on stderr.
    pub fn cleanup_failure(&mut self, cleanup: &Value) {
        if !convert::to_bool(&payload::property(cleanup, "ok")) {
            self.cleanup_text(&json::cleanup_json(cleanup));
        }
    }

    /// `[Console]::Error.WriteLine("MIXDOG_OFFICE_CLEANUP <text>")`: a cleanup that threw, with the exception's text.
    pub fn cleanup_text(&mut self, text: &str) {
        let _ = self.err.write_all(format!("{CLEANUP_PREFIX}{text}\r\n").as_bytes());
        let _ = self.err.flush();
    }
}

/// `[ordered]@{ ok = $false; backend = 'microsoft-office-com'; error = <message> }`.
pub fn error_answer(message: &str) -> Value {
    Value::object(
        ObjectKind::Ordered,
        vec![("ok", Value::Bool(false)), ("backend", Value::string(BACKEND)), ("error", Value::string(message))],
    )
}

/// The text of a panic, for the error line that answers it.
pub fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "Office host failed unexpectedly".to_owned()
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use std::io::Write;
    use std::sync::Arc;
    use std::sync::Mutex;

    use super::Emitter;

    /// A writer whose bytes the test reads back.
    #[derive(Clone, Default)]
    pub struct Shared(pub Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap_or_else(|p| p.into_inner()).extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Shared {
        pub fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()).expect("utf-8")
        }
    }

    /// An emitter over two shared buffers: (emitter, stdout, stderr).
    pub fn emitter() -> (Emitter, Shared, Shared) {
        let (out, err) = (Shared::default(), Shared::default());
        (Emitter::new(Box::new(out.clone()), Box::new(err.clone())), out, err)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::emitter;
    use super::*;

    #[test]
    fn a_line_is_compact_json_then_crlf_with_no_byte_order_mark() {
        let (mut emitter, out, _) = emitter();
        emitter.line(&Value::object(ObjectKind::Ordered, vec![("ok", Value::Bool(true)), ("n", Value::Int(2))]));
        assert_eq!(out.text(), "{\"ok\":true,\"n\":2}\r\n");
        assert!(!out.text().starts_with('\u{feff}'));
    }

    #[test]
    fn a_cleanup_that_succeeded_writes_nothing_and_one_that_failed_writes_its_json() {
        let (mut emitter, _, err) = emitter();
        emitter.cleanup_failure(&Value::object(ObjectKind::Ordered, vec![("ok", Value::Bool(true))]));
        assert_eq!(err.text(), "");
        emitter.cleanup_failure(&Value::object(
            ObjectKind::Ordered,
            vec![("ok", Value::Bool(false)), ("errors", Value::Array(vec![Value::string("x")]))],
        ));
        assert_eq!(err.text(), "MIXDOG_OFFICE_CLEANUP {\"ok\":false,\"errors\":[\"x\"]}\r\n");
    }

    #[test]
    fn a_cleanup_that_threw_writes_the_exception_text() {
        let (mut emitter, _, err) = emitter();
        emitter.cleanup_text("boom");
        assert_eq!(err.text(), "MIXDOG_OFFICE_CLEANUP boom\r\n");
    }

    #[test]
    fn the_error_answer_has_the_hosts_three_keys_in_order() {
        let (mut emitter, out, _) = emitter();
        emitter.line(&error_answer("it \"broke\""));
        assert_eq!(out.text(), "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"it \\\"broke\\\"\"}\r\n");
    }

    #[test]
    fn a_panic_text_is_its_message() {
        let caught = std::panic::catch_unwind(|| panic!("bad {}", 7)).unwrap_err();
        assert_eq!(panic_text(&*caught), "bad 7");
        let caught = std::panic::catch_unwind(|| panic!("plain")).unwrap_err();
        assert_eq!(panic_text(&*caught), "plain");
    }
}
