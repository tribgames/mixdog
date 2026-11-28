//! The one-shot host (`office-com-host.ps1`'s entry): the whole of stdin is one JSON request, the answer is exactly one JSON
//! line, the exit code is 0 for an answer and 1 after an error line, and the handler's `finally` always runs after the
//! line was written.

use super::emit::Emitter;
use super::emit::error_answer;
use super::handlers::OneShotHandler;
use crate::ps::Value;
use crate::ps::payload;

/// `throw 'Office host received an empty request'`.
pub const EMPTY_REQUEST: &str = "Office host received an empty request";

fn request(handler: &mut dyn OneShotHandler, out: &mut Emitter, text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err(EMPTY_REQUEST.to_owned());
    }
    let parsed = payload::parse_payload(text)?;
    handler.handle(out, &parsed)
}

/// Runs the request in `text` and answers the exit code; the handler's cleanup runs after the answer.
pub fn run(handler: &mut dyn OneShotHandler, out: &mut Emitter, text: &str) -> i32 {
    let code = match request(handler, out, text) {
        Ok(value) => {
            out.line(&value);
            0
        }
        Err(message) => {
            out.line(&error_answer(&message));
            1
        }
    };
    handler.finish(out);
    code
}

#[cfg(test)]
mod tests {
    use super::super::emit::testing::emitter;
    use super::*;
    use crate::ps::ObjectKind;

    #[derive(Default)]
    struct Scripted {
        finished: u32,
    }

    impl OneShotHandler for Scripted {
        fn handle(&mut self, _out: &mut Emitter, payload: &Value) -> Result<Value, String> {
            match crate::ps::convert::to_ps_string(&payload::property(payload, "action")).as_str() {
                "ok" => Ok(Value::object(ObjectKind::Ordered, vec![("ok", Value::Bool(true))])),
                other => Err(format!("Unsupported Office host action: {other}")),
            }
        }

        fn finish(&mut self, out: &mut Emitter) {
            self.finished += 1;
            out.cleanup_text("from finish");
        }
    }

    #[test]
    fn an_empty_request_is_refused_with_an_error_line_and_exit_one() {
        for text in ["", "  \r\n\t "] {
            let (mut out, stdout, _) = emitter();
            let mut handler = Scripted::default();
            assert_eq!(run(&mut handler, &mut out, text), 1);
            assert_eq!(stdout.text(), "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"Office host received an empty request\"}\r\n");
            assert_eq!(handler.finished, 1);
        }
    }

    #[test]
    fn an_answer_is_one_line_and_exit_zero_and_the_cleanup_runs_after_it() {
        let (mut out, stdout, stderr) = emitter();
        let mut handler = Scripted::default();
        assert_eq!(run(&mut handler, &mut out, "{\"action\":\"ok\"}"), 0);
        assert_eq!(stdout.text(), "{\"ok\":true}\r\n");
        assert_eq!(stderr.text(), "MIXDOG_OFFICE_CLEANUP from finish\r\n");
        assert_eq!(handler.finished, 1);
    }

    #[test]
    fn a_failure_is_an_error_line_and_exit_one_with_the_cleanup_run() {
        let (mut out, stdout, _) = emitter();
        let mut handler = Scripted::default();
        assert_eq!(run(&mut handler, &mut out, "{\"action\":\"nope\"}"), 1);
        assert_eq!(stdout.text(), "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"Unsupported Office host action: nope\"}\r\n");
        assert_eq!(handler.finished, 1);
    }

    #[test]
    fn a_request_that_is_not_json_is_the_parsers_error() {
        let (mut out, stdout, _) = emitter();
        let mut handler = Scripted::default();
        assert_eq!(run(&mut handler, &mut out, "{\"action\":"), 1);
        assert!(stdout.text().starts_with("{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":"));
        assert_eq!(handler.finished, 1);
    }
}
