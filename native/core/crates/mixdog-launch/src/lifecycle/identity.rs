//! A process's identity as the markers record it (`processIdentity`): the pid alone may name another process once it is
//! reused, so a marker also keeps when its process started, and a later run compares the two before it calls the marker's
//! process gone. The values are the JSON `process-lifecycle.mjs` writes, so a marker of either runtime is read by both.

use serde_json::Value;
use serde_json::json;

/// The method of an estimate made from the clock when the OS has not answered yet (`method: 'uptime'`); a later attempt
/// replaces it with what the OS says.
pub(super) const UPTIME: &str = "uptime";

/// The method the OS query is recorded under: the names Node's writers use for the same fact.
#[cfg(windows)]
const OS_METHOD: &str = "powershell";
#[cfg(not(windows))]
const OS_METHOD: &str = "ps";

/// `{ kind: 'start-seconds', value, method }`.
pub fn start_seconds(seconds: i64, method: &str) -> Value {
    json!({ "kind": "start-seconds", "value": seconds, "method": method })
}

/// `{ kind: 'linux-start-ticks', value }`.
fn linux_start_ticks(ticks: &str) -> Value {
    json!({ "kind": "linux-start-ticks", "value": ticks })
}

/// The estimate `currentProcessIdentity` makes from the clock: when the process started if it has run for `uptime_ms`.
pub(super) fn uptime_estimate(now_ms: i64, uptime_ms: i64) -> Option<Value> {
    let seconds = (now_ms - uptime_ms).div_euclid(1000);
    (seconds > 0).then(|| start_seconds(seconds, UPTIME))
}

/// Whether this identity is an estimate from the clock.
pub(super) fn is_estimate(identity: Option<&Value>) -> bool {
    identity.and_then(|identity| identity.get("method")).and_then(Value::as_str) == Some(UPTIME)
}

/// The start time field of `/proc/<pid>/stat` (field 22, in clock ticks since boot), as `linuxProcessIdentity` reads it.
pub(super) fn linux_ticks_from_stat(stat: &str) -> Option<String> {
    let rest = &stat[stat.rfind(") ")? + 2..];
    let ticks = rest.split_whitespace().nth(19)?;
    (!ticks.is_empty() && ticks.bytes().all(|byte| byte.is_ascii_digit())).then(|| ticks.to_owned())
}

/// `processIdentityForPid`: the identity of the process `pid` names, from the OS. Linux keeps the start time in the clock
/// ticks `/proc` counts it in; elsewhere it is the start time in whole seconds since 1970.
pub(super) fn of_pid(pid: u32) -> Option<Value> {
    if cfg!(target_os = "linux") {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        return linux_ticks_from_stat(&stat).map(|ticks| linux_start_ticks(&ticks));
    }
    use crate::process::OsProcessTable;
    use crate::process::ProcessTable;
    let info = OsProcessTable.query(u64::from(pid)).ok()??;
    // 0: the OS denied the start time.
    let seconds = i64::try_from(info.identity.start_ms / 1000).ok().filter(|seconds| *seconds > 0)?;
    Some(start_seconds(seconds, OS_METHOD))
}

/// `Number.isSafeInteger(value) && value >= 1`.
fn safe_positive_integer(value: Option<&Value>) -> Option<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && (1.0..=MAX_SAFE).contains(&number)).then_some(number as i64)
}

/// `String(value)` when that is all decimal digits and not zero (`BigInt(value) >= 1`).
fn tick_digits(value: Option<&Value>) -> Option<String> {
    let text = match value? {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) && text.bytes().any(|byte| byte != b'0')).then_some(text)
}

/// `sameProcessIdentity`: whether two identities name one process; `None` when they cannot be compared (a kind that differs
/// or is not known, a value that is not a valid start time).
pub(super) fn same_identity(expected: Option<&Value>, observed: Option<&Value>) -> Option<bool> {
    let (expected, observed) = (expected?, observed?);
    let kind = expected.get("kind").and_then(Value::as_str)?;
    if observed.get("kind").and_then(Value::as_str) != Some(kind) {
        return None;
    }
    match kind {
        "linux-start-ticks" => Some(tick_digits(expected.get("value"))? == tick_digits(observed.get("value"))?),
        "start-seconds" => {
            let (a, b) = (safe_positive_integer(expected.get("value"))?, safe_positive_integer(observed.get("value"))?);
            let method = |identity: &Value| identity.get("method").and_then(Value::as_str).map(str::to_owned);
            let cross_method = method(expected).as_deref() == Some(UPTIME) || method(observed).as_deref() == Some(UPTIME);
            Some(if cross_method { (a - b).abs() <= 2 } else { a == b })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_are_read_after_the_command_name_whatever_it_holds() {
        let stat = "1234 (a) b (c) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615";
        assert_eq!(linux_ticks_from_stat(stat).as_deref(), Some("987654"));
        assert_eq!(linux_ticks_from_stat("no command name"), None);
        assert_eq!(linux_ticks_from_stat("1 (x) S 1"), None);
    }

    #[test]
    fn an_estimate_is_one_only_while_it_is_positive() {
        assert_eq!(uptime_estimate(10_500, 400), Some(start_seconds(10, UPTIME)));
        assert_eq!(uptime_estimate(500, 400), None);
        assert!(is_estimate(uptime_estimate(10_500, 400).as_ref()));
        assert!(!is_estimate(Some(&start_seconds(10, "ps"))));
        assert!(!is_estimate(None));
    }

    #[test]
    fn start_seconds_match_exactly_unless_one_is_an_estimate() {
        let same = |a: &Value, b: &Value| same_identity(Some(a), Some(b));
        assert_eq!(same(&start_seconds(100, "ps"), &start_seconds(100, "powershell")), Some(true));
        assert_eq!(same(&start_seconds(100, "ps"), &start_seconds(101, "ps")), Some(false));
        assert_eq!(same(&start_seconds(100, UPTIME), &start_seconds(102, "ps")), Some(true));
        assert_eq!(same(&start_seconds(100, UPTIME), &start_seconds(103, "ps")), Some(false));
        assert_eq!(same(&start_seconds(0, "ps"), &start_seconds(0, "ps")), None);
        assert_eq!(same(&json!({ "kind": "start-seconds", "value": "100" }), &start_seconds(100, "ps")), None);
    }

    #[test]
    fn ticks_match_as_text_and_other_kinds_are_not_compared() {
        let ticks = |value: Value| json!({ "kind": "linux-start-ticks", "value": value });
        assert_eq!(same_identity(Some(&ticks(json!("42"))), Some(&ticks(json!("42")))), Some(true));
        assert_eq!(same_identity(Some(&ticks(json!("42"))), Some(&ticks(json!("43")))), Some(false));
        assert_eq!(same_identity(Some(&ticks(json!("0"))), Some(&ticks(json!("0")))), None);
        assert_eq!(same_identity(Some(&ticks(json!("4x"))), Some(&ticks(json!("4x")))), None);
        assert_eq!(same_identity(Some(&ticks(json!("42"))), Some(&start_seconds(42, "ps"))), None);
        assert_eq!(same_identity(Some(&json!({ "kind": "other", "value": 1 })), Some(&json!({ "kind": "other", "value": 1 }))), None);
        assert_eq!(same_identity(None, Some(&start_seconds(5, "ps"))), None);
    }
}
