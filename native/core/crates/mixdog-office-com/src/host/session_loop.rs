//! The session host (`office-com-session-host.ps1`'s main loop and `finally`): one request per line on stdin, one answer
//! per request on stdout echoing the request's `requestId`, and, when stdin ends or the loop ends, the cleanup of the
//! session that is still open.

use std::panic::AssertUnwindSafe;
use std::panic::catch_unwind;

use super::apartment::Inbox;
use super::apartment::Input;
use super::emit::Emitter;
use super::emit::error_answer;
use super::emit::panic_text;
use super::handlers::SessionHandler;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

pub const ALREADY_OPEN: &str = "Office session is already open in this host";
pub const NO_DOCUMENT: &str = "Office session host has no open document";
pub const WRONG_SESSION: &str = "Office session id does not match this host";

/// How one request ended.
struct Handled {
    answer: Result<Value, String>,
    close_after_response: bool,
}

/// `$payload.<name> -eq <text>`: the comparison of strings in PowerShell ignores case.
fn is(value: &Value, text: &str) -> bool {
    payload::names_equal(&convert::to_ps_string(value), text) && !value.is_null()
}

fn step(handler: &mut dyn SessionHandler, out: &mut Emitter, line: &str, request_id: &mut String) -> Handled {
    let mut close_after_response = false;
    let answer = (|| -> Result<Value, String> {
        let request = payload::parse_payload(line)?;
        *request_id = convert::to_ps_string(&payload::property(&request, "requestId"));
        let action = payload::property(&request, "action");
        if is(&action, "open_session") {
            if handler.session_id().is_some() {
                return Err(ALREADY_OPEN.to_owned());
            }
            return handler.open(out, &request);
        }
        let Some(id) = handler.session_id() else {
            return Err(NO_DOCUMENT.to_owned());
        };
        if !payload::names_equal(&convert::to_ps_string(&payload::property(&request, "session")), &id) {
            return Err(WRONG_SESSION.to_owned());
        }
        handler.record_foreground();
        if is(&action, "close_session") {
            let closed = handler.close(out, &request)?;
            close_after_response = closed.closed;
            return Ok(closed.result);
        }
        handler.action(out, &request)
    })();
    Handled { answer, close_after_response }
}

/// A request that failed: the error answer, with the session and the application's pid when a state exists (a reopen may
/// have changed the application before a later step failed).
fn failure(handler: &dyn SessionHandler, message: &str) -> Value {
    let mut answer = error_answer(message);
    if let (Value::Object(object), Some(id)) = (&mut answer, handler.session_id()) {
        object.set("session", Value::String(id));
        object.set("appPid", handler.app_pid());
    }
    answer
}

/// Serves requests until stdin ends or a successful `close_session` was answered, then runs the cleanup of a session that
/// is still open. Answers the exit code, always 0: a failed cleanup is reported on stderr, not by the exit code.
pub fn run(handler: &mut dyn SessionHandler, out: &mut Emitter, inbox: &Inbox) -> i32 {
    while let Some(Input::Line(line)) = inbox.recv() {
        if line.trim().is_empty() {
            continue;
        }
        let mut request_id = String::new();
        let stepped = catch_unwind(AssertUnwindSafe(|| step(handler, out, &line, &mut request_id)));
        let handled = stepped.unwrap_or_else(|panic| Handled { answer: Err(panic_text(&*panic)), close_after_response: false });
        let mut result = match handled.answer {
            Ok(value) => value,
            Err(message) => failure(handler, &message),
        };
        if !request_id.is_empty() {
            if let Value::Object(object) = &mut result {
                object.set("requestId", Value::String(request_id));
            }
        }
        out.line(&result);
        if handled.close_after_response {
            break;
        }
    }
    if handler.session_id().is_some() {
        match catch_unwind(AssertUnwindSafe(|| handler.end())) {
            Ok(Ok(cleanup)) => out.cleanup_failure(&cleanup),
            Ok(Err(message)) => out.cleanup_text(&message),
            Err(panic) => out.cleanup_text(&panic_text(&*panic)),
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::super::apartment::channel;
    use super::super::emit::testing::emitter;
    use super::super::handlers::Closed;
    use super::*;
    use crate::ps::ObjectKind;

    /// A session whose behaviour the request names in `action`.
    #[derive(Default)]
    struct Scripted {
        id: Option<String>,
        foreground: u32,
        cleanup_fails: bool,
        closes_failing: bool,
        ended: u32,
    }

    fn object(pairs: Vec<(&str, Value)>) -> Value {
        Value::object(ObjectKind::Ordered, pairs)
    }

    impl SessionHandler for Scripted {
        fn session_id(&self) -> Option<String> {
            self.id.clone()
        }

        fn app_pid(&self) -> Value {
            Value::Int(4242)
        }

        fn open(&mut self, out: &mut Emitter, payload: &Value) -> Result<Value, String> {
            let id = convert::to_ps_string(&payload::property(payload, "session"));
            out.line(&object(vec![("session", Value::string(&id)), ("lifecycle", Value::string("initializing"))]));
            if convert::to_ps_string(&payload::property(payload, "path")) == "fail" {
                return Err("open failed".to_owned());
            }
            self.id = Some(id.clone());
            Ok(object(vec![("ok", Value::Bool(true)), ("opened", Value::Bool(true)), ("session", Value::String(id))]))
        }

        fn record_foreground(&mut self) {
            self.foreground += 1;
        }

        fn action(&mut self, _out: &mut Emitter, payload: &Value) -> Result<Value, String> {
            match convert::to_ps_string(&payload::property(payload, "action")).as_str() {
                "panic" => panic!("action bug"),
                "echo" => Ok(object(vec![("ok", Value::Bool(true)), ("requestId", Value::string("handler-set"))])),
                other => Err(format!("Unsupported Office host action: {other}")),
            }
        }

        fn close(&mut self, _out: &mut Emitter, _payload: &Value) -> Result<Closed, String> {
            let ok = !self.closes_failing;
            if ok {
                self.id = None;
            }
            Ok(Closed { result: object(vec![("ok", Value::Bool(ok)), ("closed", Value::Bool(ok))]), closed: ok })
        }

        fn end(&mut self) -> Result<Value, String> {
            self.ended += 1;
            if self.cleanup_fails {
                Ok(object(vec![("ok", Value::Bool(false)), ("errors", Value::Array(vec![Value::string("left open")]))]))
            } else {
                Ok(object(vec![("ok", Value::Bool(true))]))
            }
        }
    }

    fn serve(handler: &mut Scripted, lines: &[&str]) -> (String, String) {
        let (sender, inbox) = channel().expect("channel");
        for line in lines {
            sender.send(Input::Line((*line).to_owned()));
        }
        drop(sender);
        let (mut out, stdout, stderr) = emitter();
        assert_eq!(run(handler, &mut out, &inbox), 0);
        (stdout.text(), stderr.text())
    }

    const OPEN: &str = "{\"action\":\"open_session\",\"session\":\"s1\",\"requestId\":\"r1\"}";

    #[test]
    fn requests_are_answered_one_line_each_with_their_request_id_and_blank_lines_are_skipped() {
        let mut handler = Scripted::default();
        let (stdout, stderr) = serve(
            &mut handler,
            &[
                OPEN,
                "",
                "   ",
                "{\"action\":\"echo\",\"session\":\"s1\",\"requestId\":\"r2\"}",
                "{\"action\":\"close_session\",\"session\":\"s1\",\"requestId\":\"r3\"}",
            ],
        );
        let lines: Vec<&str> = stdout.split("\r\n").collect();
        assert_eq!(lines[0], "{\"session\":\"s1\",\"lifecycle\":\"initializing\"}", "the identity line has no requestId");
        assert_eq!(lines[1], "{\"ok\":true,\"opened\":true,\"session\":\"s1\",\"requestId\":\"r1\"}");
        assert_eq!(lines[2], "{\"ok\":true,\"requestId\":\"r2\"}", "the request's id replaces the handler's");
        assert_eq!(lines[3], "{\"ok\":true,\"closed\":true,\"requestId\":\"r3\"}");
        assert_eq!(lines[4], "");
        assert_eq!(lines.len(), 5);
        assert_eq!(stderr, "");
        assert_eq!(handler.foreground, 2, "recorded before every action, close included, not before the open");
        assert_eq!(handler.ended, 0, "a closed session has no cleanup left");
    }

    #[test]
    fn the_loop_ends_after_a_successful_close_and_ignores_what_follows() {
        let mut handler = Scripted::default();
        let (stdout, _) = serve(&mut handler, &[OPEN, "{\"action\":\"close_session\",\"session\":\"s1\"}", "{\"action\":\"echo\",\"session\":\"s1\"}"]);
        assert_eq!(stdout.matches("\r\n").count(), 3, "identity, open, close");
    }

    #[test]
    fn a_failed_close_keeps_the_loop_and_the_state() {
        let mut handler = Scripted { closes_failing: true, ..Scripted::default() };
        let (stdout, stderr) = serve(
            &mut handler,
            &[OPEN, "{\"action\":\"close_session\",\"session\":\"s1\",\"requestId\":\"c\"}", "{\"action\":\"echo\",\"session\":\"s1\",\"requestId\":\"e\"}"],
        );
        assert!(stdout.contains("{\"ok\":false,\"closed\":false,\"requestId\":\"c\"}"));
        assert!(stdout.contains("{\"ok\":true,\"requestId\":\"e\"}"), "the loop went on");
        assert_eq!(handler.ended, 1, "and the cleanup ran at the end");
        assert_eq!(stderr, "");
    }

    #[test]
    fn the_three_refusals() {
        let mut handler = Scripted::default();
        let (stdout, _) = serve(
            &mut handler,
            &[
                "{\"action\":\"echo\",\"session\":\"s1\",\"requestId\":\"a\"}",
                OPEN,
                "{\"action\":\"open_session\",\"session\":\"s2\",\"requestId\":\"b\"}",
                "{\"action\":\"echo\",\"session\":\"other\",\"requestId\":\"c\"}",
            ],
        );
        let lines: Vec<&str> = stdout.split("\r\n").collect();
        assert_eq!(lines[0], "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"Office session host has no open document\",\"requestId\":\"a\"}");
        assert_eq!(
            lines[3],
            "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"Office session is already open in this host\",\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"b\"}"
        );
        assert_eq!(
            lines[4],
            "{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"Office session id does not match this host\",\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"c\"}"
        );
    }

    #[test]
    fn the_session_id_is_compared_without_regard_to_case() {
        let mut handler = Scripted::default();
        let (stdout, _) = serve(&mut handler, &[OPEN, "{\"action\":\"echo\",\"session\":\"S1\",\"requestId\":\"e\"}"]);
        assert!(stdout.contains("{\"ok\":true,\"requestId\":\"e\"}"));
    }

    #[test]
    fn a_line_that_is_not_json_is_an_error_answer_without_a_request_id() {
        let mut handler = Scripted::default();
        let (stdout, _) = serve(&mut handler, &["{\"action\":"]);
        assert!(stdout.starts_with("{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":"));
        assert!(!stdout.contains("requestId"));
    }

    #[test]
    fn a_failed_open_leaves_no_state_and_so_no_session_in_its_error() {
        let mut handler = Scripted::default();
        let (stdout, _) = serve(&mut handler, &["{\"action\":\"open_session\",\"session\":\"s1\",\"path\":\"fail\",\"requestId\":\"o\"}"]);
        assert!(stdout.ends_with("{\"ok\":false,\"backend\":\"microsoft-office-com\",\"error\":\"open failed\",\"requestId\":\"o\"}\r\n"));
        assert_eq!(handler.ended, 0);
    }

    #[test]
    fn a_session_still_open_at_the_end_is_cleaned_up_and_a_failed_cleanup_is_written() {
        let mut handler = Scripted { cleanup_fails: true, ..Scripted::default() };
        let (_, stderr) = serve(&mut handler, &[OPEN]);
        assert_eq!(handler.ended, 1);
        assert_eq!(stderr, "MIXDOG_OFFICE_CLEANUP {\"ok\":false,\"errors\":[\"left open\"]}\r\n");
        let mut clean = Scripted::default();
        let (_, stderr) = serve(&mut clean, &[OPEN]);
        assert_eq!((clean.ended, stderr.as_str()), (1, ""));
    }

    #[test]
    fn a_panic_is_an_error_answer_and_the_state_is_kept_for_the_cleanup_at_the_end() {
        let mut handler = Scripted::default();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let (stdout, _) = serve(&mut handler, &[OPEN, "{\"action\":\"panic\",\"session\":\"s1\",\"requestId\":\"p\"}"]);
        std::panic::set_hook(previous);
        assert!(stdout.contains("\"error\":\"action bug\",\"session\":\"s1\",\"appPid\":4242,\"requestId\":\"p\"}"));
        assert_eq!(handler.ended, 1);
    }
}
