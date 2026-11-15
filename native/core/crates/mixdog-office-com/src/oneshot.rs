//! A call with no session: one PowerShell host process per call. The whole JSON payload goes to its stdin, the last
//! non-empty stdout line is the answer. A cancel or a timeout does not kill the host: it is sent EOF and given the
//! drain grace, and the answer says that the operation may have completed.

use std::time::Duration;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::OfficeReply;
use crate::cleanup;
use crate::session::Attach;
use crate::session::HostClient;

pub(crate) const CANCELLED: &str = "Microsoft Office operation was cancelled";

/// What a host that ran to its end answered, given its output and exit code (`None` when a signal ended it).
pub(crate) fn answer_from_exit(stdout: &str, stderr: &str, code: Option<i32>) -> Value {
    let last = cleanup::lines(stdout).map(str::trim).filter(|line| !line.is_empty()).last().unwrap_or_default();
    if let Ok(parsed) = serde_json::from_str::<Value>(last) {
        let cleanup_errors = cleanup::failure_lines(stderr);
        if cleanup_errors.is_empty() {
            return parsed;
        }
        // `null` has no `ok` to read: the answer is then read as unparseable, as the host's output cannot be trusted.
        if !parsed.is_null() {
            let completed = parsed.get("ok") == Some(&Value::Bool(true));
            let mut answer = match parsed {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            answer.insert("ok".to_owned(), Value::Bool(false));
            answer.insert("operationCompleted".to_owned(), Value::Bool(completed));
            answer.insert(
                "error".to_owned(),
                Value::String("Office operation finished but cleanup failed; do not replay the operation.".to_owned()),
            );
            answer.insert("cleanup".to_owned(), json!({"ok": false, "errors": cleanup_errors}));
            return Value::Object(answer);
        }
    }
    let error = if !stderr.trim().is_empty() {
        stderr.trim().to_owned()
    } else if !last.is_empty() {
        last.to_owned()
    } else {
        let code = code.map_or_else(|| "null".to_owned(), |code| code.to_string());
        format!("Microsoft Office host exited with code {code}")
    };
    json!({"ok": false, "error": error})
}

/// Runs one payload through a fresh host and answers.
pub(crate) async fn call_once(
    client: std::sync::Arc<HostClient>,
    payload: &Value,
    timeout: Duration,
    cancel: &CancellationToken,
) -> OfficeReply {
    if !cancel.is_cancelled() {
        let body = if payload.is_null() { json!({}) } else { payload.clone() };
        client.send(body.to_string());
    }
    client.end_stdin();
    let reason = tokio::select! {
        biased;
        () = cancel.cancelled() => Some((CANCELLED.to_owned(), true)),
        () = client.wait_closed() => None,
        () = mixdog_rt::time::sleep(timeout) => {
            Some((format!("Microsoft Office operation timed out after {}ms", timeout.as_millis()), false))
        }
    };
    let Some((error, cancelled)) = reason else {
        let value = answer_from_exit(&client.stdout(), &client.stderr(), client.exit_code());
        return OfficeReply { value, host_exit: None };
    };
    let cleanup = client.drain(&error).await;
    let value = json!({
        "ok": false,
        "cancelled": cancelled,
        "error": cleanup::cleanup_error(&error, Some(&cleanup)),
        "operationMayHaveCompleted": true,
        "cleanup": cleanup,
    });
    OfficeReply { value, host_exit: Some(client.host_exit()) }
}

/// The client of a one-shot host.
pub(crate) fn attach(running: crate::session::Running, grace: Duration, sweeper: crate::sweep::Sweeper) -> std::sync::Arc<HostClient> {
    HostClient::attach(
        running,
        Attach { session_id: String::new(), one_shot: true, sessions: std::sync::Weak::new(), grace, sweeper },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_non_empty_line_is_the_answer() {
        let answer = answer_from_exit("noise\r\n{\"ok\":true,\"value\":1}\r\n\r\n  \n", "", Some(0));
        assert_eq!(answer, json!({"ok": true, "value": 1}));
    }

    #[test]
    fn an_unparseable_answer_is_the_stderr_then_the_line_then_the_exit_code() {
        assert_eq!(answer_from_exit("not json", " boom \n", Some(1)), json!({"ok": false, "error": "boom"}));
        assert_eq!(answer_from_exit("not json\n", "", Some(1)), json!({"ok": false, "error": "not json"}));
        assert_eq!(
            answer_from_exit("", "", Some(3)),
            json!({"ok": false, "error": "Microsoft Office host exited with code 3"})
        );
        assert_eq!(
            answer_from_exit("", "", None),
            json!({"ok": false, "error": "Microsoft Office host exited with code null"})
        );
    }

    #[test]
    fn cleanup_lines_turn_a_finished_operation_into_a_failure_that_says_not_to_replay_it() {
        let stderr = "MIXDOG_OFFICE_CLEANUP {\"ok\":false}\r\n";
        let answer = answer_from_exit("{\"ok\":true,\"value\":7}", stderr, Some(0));
        assert_eq!(
            answer,
            json!({
                "ok": false,
                "value": 7,
                "operationCompleted": true,
                "error": "Office operation finished but cleanup failed; do not replay the operation.",
                "cleanup": {"ok": false, "errors": ["MIXDOG_OFFICE_CLEANUP {\"ok\":false}"]},
            })
        );
        let failed = answer_from_exit("{\"ok\":false,\"error\":\"x\"}", stderr, Some(0));
        assert_eq!(failed["operationCompleted"], json!(false));
    }
}
