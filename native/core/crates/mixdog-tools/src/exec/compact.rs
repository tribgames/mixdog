//! Lossless compaction of a successful foreground command's output
//! (`builtin/shell-lossless-compact.mjs`): JSON whitespace, a one-line test or build summary, or
//! folded progress frames and repeated lines — only when the savings are real and the full
//! capture is archived so it can be read back.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;

use super::fold::fold_carriage_return_frames;
use super::fold::fold_consecutive_duplicate_lines;

const MIN_RAW_BYTES: usize = 512;
const MIN_SAVED_BYTES: usize = 384;
const MIN_SAVED_RATIO: f64 = 0.2;

fn re(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| re($pattern, $flags));
        &*RE
    }};
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

/// `Number.prototype.toFixed(2)`: the exact binary value rounded half up.
fn to_fixed_2(x: f64) -> String {
    let wide = format!("{x:.40}");
    let (whole, frac) = wide.split_once('.').unwrap_or((&wide, ""));
    let digits = frac.as_bytes();
    let tie = digits.get(2) == Some(&b'5') && digits[3..].iter().all(|d| *d == b'0');
    if tie {
        let hundredths: f64 = format!("{whole}.{}", &frac[..2]).parse().unwrap_or(x);
        return format!("{:.2}", hundredths + 0.01);
    }
    format!("{x:.2}")
}

fn simple_pytest_command(command: &str) -> bool {
    let text = js_trim(command);
    if text.is_empty() || lazy_re!(r"[\r\n;&|<>`]|\$\(|\$\{|\$\(\(", "").is_match(text) {
        return false;
    }
    lazy_re!(r"^(?:(?:\S*[\\/])?(?:pytest|py\.test))(?:\.exe)?(?:\s|$)", "i").is_match(text)
        || lazy_re!(r"^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?\s+-m\s+pytest(?:\s|$)", "i").is_match(text)
}

fn pytest_success_summary(stdout: &str) -> Option<String> {
    if stdout.len() < MIN_RAW_BYTES
        || lazy_re!(r"\b(?:failed|errors?|warnings?|skipped|xfailed|xpassed|deselected|rerun)\b", "i")
            .is_match(stdout)
    {
        return None;
    }
    let trimmed = js_trim(stdout);
    for line in split_lines(trimmed).iter().rev() {
        let line = js_trim(line);
        let Some(m) = lazy_re!(r"^=*\s*(\d+)\s+passed(?:\s+in\s+([^=\r\n]+?))?\s*=*$", "").captures(line)
        else {
            continue;
        };
        let duration = m.get(2).map_or("", js_trim);
        let tail = if duration.is_empty() { String::new() } else { format!(" in {duration}") };
        return Some(format!("Pytest: {} passed{tail}", m.get(1).unwrap_or("")));
    }
    None
}

fn compact_json_whitespace(value: &str) -> Option<String> {
    let trimmed = js_trim(value);
    if !(trimmed.starts_with('{') || trimmed.starts_with('[')) {
        return None;
    }
    serde_json::from_str::<serde::de::IgnoredAny>(trimmed).ok()?;
    let (mut out, mut in_string, mut escaped) = (String::new(), false, false);
    for ch in trimmed.chars() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
        } else if !is_js_space(ch) {
            out.push(ch);
        }
    }
    Some(out)
}

fn compact_structured_json(stdout: &str) -> Option<String> {
    if let Some(whole) = compact_json_whitespace(stdout) {
        return Some(whole);
    }
    let mut lines = split_lines(stdout);
    let trailing_newline = stdout.ends_with('\n');
    if trailing_newline {
        lines.pop();
    }
    if lines.len() < 2 || lines.iter().any(|l| js_trim(l).is_empty()) {
        return None;
    }
    let compacted: Option<Vec<String>> = lines.iter().map(|l| compact_json_whitespace(l)).collect();
    Some(format!("{}{}", compacted?.join("\n"), if trailing_newline { "\n" } else { "" }))
}

/// A test summary states the run's verdict, so it may only replace output whose exit status
/// belongs to the runner itself.
fn status_owning_command(command: &str) -> bool {
    let stripped = lazy_re!(r"\d?>&\d", "g").replace_all_with(command, |_| " ".to_owned());
    let text = js_trim(&stripped);
    !text.is_empty() && !lazy_re!(r"[;&|<>`]|\$\(|\$\{", "").is_match(text)
}

fn test_like_command(command: &str) -> bool {
    let text = js_trim(command);
    status_owning_command(text)
        && (simple_pytest_command(text)
            || lazy_re!(r"^(?:node|bun)(?:\.exe)?\s+--test(?:\s|$)", "i").is_match(text)
            || lazy_re!(r"^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:[:.\w-]*)(?:\s|$)", "i").is_match(text)
            || lazy_re!(r"^(?:(?:npx|pnpx|bunx)\s+)?(?:jest|vitest)(?:\s|$)", "i").is_match(text)
            || lazy_re!(r"^(?:cargo|go|dotnet)\s+test(?:\s|$)", "i").is_match(text))
}

fn has_diagnostic_hazard(value: &str) -> bool {
    lazy_re!(r"\b(?:errors?|warnings?|failed|failure|panic|fatal|xpass|xfailed|cancelled|todo|skipped)\b", "i")
        .is_match(value)
}

fn tap_count(text: &str, name: &str) -> Option<u64> {
    let pattern = format!(r"^# {name} (\d+)\s*$");
    re(&pattern, "m").captures(text).and_then(|m| m.get(1)?.parse().ok())
}

fn node_tap_success_summary(text: &str) -> Option<String> {
    if !lazy_re!(r"^TAP version \d+", "m").is_match(text)
        || lazy_re!(r"(?:^|\n)\s*not ok\b", "i").is_match(text)
    {
        return None;
    }
    let diagnostics =
        lazy_re!(r"^# (?:cancelled|skipped|todo) 0[ \t]*\r?$", "gm").replace_all_with(text, |_| String::new());
    if has_diagnostic_hazard(&diagnostics) {
        return None;
    }
    let tests = tap_count(text, "tests");
    let passed = tap_count(text, "pass");
    if !(tests.is_some_and(|t| t > 0)) || passed != tests {
        return None;
    }
    for name in ["fail", "cancelled", "skipped", "todo"] {
        if tap_count(text, name).is_some_and(|v| v != 0) {
            return None;
        }
    }
    let duration = lazy_re!(r"^# duration_ms ([\d.]+)\s*$", "m")
        .captures(text)
        .and_then(|m| m.get(1).map(str::to_owned));
    let tail = duration.map_or(String::new(), |d| format!(" in {d}ms"));
    Some(format!("Node tests: {} passed{tail}", passed?))
}

fn jest_vitest_success_summary(text: &str) -> Option<String> {
    if lazy_re!(r"\b(?:failed|failure|errors?|warnings?|skipped|todo)\b", "i").is_match(text) {
        return None;
    }
    let jest_suites = lazy_re!(r"Test Suites:\s+(\d+)\s+passed,\s+(\d+)\s+total", "i").captures(text);
    let jest_tests = lazy_re!(r"Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total", "i").captures(text);
    if let (Some(s), Some(t)) = (&jest_suites, &jest_tests) {
        if s.get(1) == s.get(2) && t.get(1) == t.get(2) {
            return Some(format!("Jest: {} passed in {} suites", t.get(1)?, s.get(1)?));
        }
    }
    let files = lazy_re!(r"Test Files\s+(\d+)\s+passed\s+\((\d+)\)", "i").captures(text);
    let tests = lazy_re!(r"Tests\s+(\d+)\s+passed\s+\((\d+)\)", "i").captures(text);
    if let (Some(f), Some(t)) = (&files, &tests) {
        if f.get(1) == f.get(2) && t.get(1) == t.get(2) {
            return Some(format!("Vitest: {} passed in {} files", t.get(1)?, f.get(1)?));
        }
    }
    None
}

fn cargo_test_success_summary(text: &str) -> Option<String> {
    if lazy_re!(r"(?:^|\n)\s*(?:warning|error):|panicked at|^failures:", "im").is_match(text) {
        return None;
    }
    let result_lines: Vec<&str> = split_lines(text).into_iter().filter(|l| l.starts_with("test result:")).collect();
    if result_lines.is_empty() {
        return None;
    }
    let (mut passed, mut duration) = (0u64, 0f64);
    for line in &result_lines {
        let m = lazy_re!(
            r"^test result: ok\.\s+(\d+) passed;\s+0 failed;\s+0 ignored;\s+\d+ measured;\s+\d+ filtered out(?:;\s+finished in ([\d.]+)s)?",
            ""
        )
        .captures(line)?;
        passed += m.get(1)?.parse::<u64>().ok()?;
        duration += m.get(2).map_or(0.0, |d| d.parse().unwrap_or(f64::NAN));
    }
    let tail = if duration != 0.0 { format!(" ({}s)", to_fixed_2(duration)) } else { String::new() };
    Some(format!("Cargo test: {passed} passed in {} suites{tail}", result_lines.len()))
}

fn go_test_success_summary(text: &str) -> Option<String> {
    if lazy_re!(r"(?:^|\n)(?:FAIL\b|--- FAIL:)|\b(?:panic|warning):", "im").is_match(text)
        || lazy_re!(r"^TAP version \d+", "m").is_match(text)
        || lazy_re!(r"^1\.\.\d+\s*$", "m").is_match(text)
    {
        return None;
    }
    let packages = split_lines(text)
        .into_iter()
        .filter(|l| lazy_re!(r"^ok\s+\S+\s+(?:\(cached\)|[\d.]+m?s)\b", "").is_match(js_trim(l)))
        .count();
    (packages > 0).then(|| format!("Go test: {packages} packages passed"))
}

fn dotnet_test_success_summary(text: &str) -> Option<String> {
    if lazy_re!(r"Build FAILED|(?:^|\s)(?:warning|error)\s+[A-Z]+\d+", "i").is_match(text) {
        return None;
    }
    let pattern = lazy_re!(
        r"Passed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)",
        "gi"
    );
    let (mut passed, mut count) = (0u64, 0usize);
    for m in pattern.captures_iter(text) {
        let n = |i| m.get(i).and_then(|v| v.parse::<u64>().ok());
        if n(1)? != 0 || n(3)? != 0 || m.get(2) != m.get(4) {
            return None;
        }
        passed += n(2)?;
        count += 1;
    }
    (count > 0).then(|| format!(".NET test: {passed} passed in {count} projects"))
}

fn test_success_summary(command: &str, stdout: &str) -> Option<String> {
    if !test_like_command(command) {
        return None;
    }
    pytest_success_summary(stdout)
        .or_else(|| node_tap_success_summary(stdout))
        .or_else(|| jest_vitest_success_summary(stdout))
        .or_else(|| cargo_test_success_summary(stdout))
        .or_else(|| go_test_success_summary(stdout))
        .or_else(|| dotnet_test_success_summary(stdout))
}

fn build_success_summary(command: &str, text: &str) -> Option<String> {
    let cmd = js_trim(command);
    if lazy_re!(r"^cargo\s+(?:build|check)(?:\s|$)", "i").is_match(cmd) {
        if lazy_re!(r"(?:^|\n)\s*(?:warning|error):|\bfailed\b", "im").is_match(text) {
            return None;
        }
        if let Some(m) = lazy_re!(r"Finished\s+.+?\s+target\(s\)\s+in\s+([^\r\n]+)", "i").captures(text) {
            return Some(format!("Cargo build: succeeded in {}", js_trim(m.get(1)?)));
        }
    }
    if lazy_re!(r"^dotnet\s+build(?:\s|$)", "i").is_match(cmd) {
        if !lazy_re!(r"Build succeeded\.", "i").is_match(text)
            || !lazy_re!(r"0 Warning\(s\)", "i").is_match(text)
            || !lazy_re!(r"0 Error\(s\)", "i").is_match(text)
        {
            return None;
        }
        return Some(".NET build: succeeded with 0 warnings".to_owned());
    }
    None
}

fn worthwhile(raw_stdout: &str, raw_stderr: &str, stdout: &str, stderr: &str) -> bool {
    let before = raw_stdout.len() + raw_stderr.len();
    let after = stdout.len() + stderr.len();
    let saved = before.saturating_sub(after);
    before >= MIN_RAW_BYTES && saved >= MIN_SAVED_BYTES && (saved as f64 / before as f64) >= MIN_SAVED_RATIO
}

/// What compaction would publish instead of the streams.
pub struct Plan {
    pub kind: &'static str,
    pub stdout: String,
    pub stderr: String,
}

/// How a command ended, as far as compaction cares.
pub struct Outcome {
    pub exit_code: Option<i32>,
    pub signal: bool,
    pub timed_out: bool,
    /// The capture already has a log (it outgrew the inline cap).
    pub has_existing_recovery: bool,
}

/// `evaluateShellCompaction`: `stdout` and `stderr` are the ANSI-stripped streams.
pub fn plan(command: &str, stdout: &str, stderr: &str, outcome: &Outcome) -> Option<Plan> {
    if !super::env::env_flag("MIXDOG_SHELL_LOSSLESS_COMPACT", true)
        || outcome.timed_out
        || outcome.signal
        || outcome.exit_code != Some(0)
        || outcome.has_existing_recovery
        || lazy_re!(r#"[\r\n]|<<|@\s*['"]"#, "").is_match(command)
    {
        return None;
    }
    if js_trim(stderr).is_empty() {
        if let Some(json) = compact_structured_json(stdout) {
            if worthwhile(stdout, stderr, &json, "") {
                return Some(Plan { kind: "structured-json", stdout: json, stderr: String::new() });
            }
        }
        if let Some(summary) = test_success_summary(command, stdout).or_else(|| build_success_summary(command, stdout)) {
            if worthwhile(stdout, stderr, &summary, "") {
                return Some(Plan { kind: "command-success", stdout: summary, stderr: String::new() });
            }
        }
    }
    if has_diagnostic_hazard(&format!("{stdout}\n{stderr}")) {
        return None;
    }
    let fold = |text: &str| {
        fold_carriage_return_frames(text)
            .or_else(|| fold_consecutive_duplicate_lines(text))
            .unwrap_or_else(|| text.to_owned())
    };
    let (compact_out, compact_err) = (fold(stdout), fold(stderr));
    if (compact_out != stdout || compact_err != stderr) && worthwhile(stdout, stderr, &compact_out, &compact_err) {
        return Some(Plan { kind: "consecutive-duplicates", stdout: compact_out, stderr: compact_err });
    }
    None
}

/// One archived full capture.
pub struct Recovery {
    pub stream: &'static str,
    pub path: String,
    pub bytes: usize,
}

/// `renderLosslessRecoveryHint`.
pub fn recovery_hint(kind: &str, recovery: &[Recovery]) -> String {
    if recovery.is_empty() {
        return String::new();
    }
    let mut lines = vec![format!("[lossless compact: {kind}; full captured output preserved]")];
    for item in recovery {
        lines.push(format!("[full {}: {} ({} bytes) — use read to recover]", item.stream, item.path, item.bytes));
    }
    lines.join("\n")
}

/// `renderShellOutputBody` with the recovery hint.
pub fn body_with_hint(stdout: &str, stderr: &str, hint: &str) -> String {
    let body = super::delivery::render_shell_output_body(stdout, stderr);
    if hint.is_empty() { body } else { format!("{body}\n\n{hint}") }
}

/// The archive step's final gate: the published body, hint included, must still save enough.
pub fn still_worthwhile(stdout: &str, stderr: &str, plan: &Plan, hint: &str) -> bool {
    worthwhile(
        &body_with_hint(stdout, stderr, ""),
        "",
        &body_with_hint(&plan.stdout, &plan.stderr, hint),
        "",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> Outcome {
        Outcome { exit_code: Some(0), signal: false, timed_out: false, has_existing_recovery: false }
    }

    #[test]
    fn cargo_test_output_collapses_to_one_line() {
        let mut out = String::new();
        for i in 0..40 {
            out.push_str(&format!("test tests::case_{i} ... ok\n"));
        }
        out.push_str("\ntest result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.125s\n");
        let plan = plan("cargo test", &out, "", &ok()).unwrap();
        assert_eq!((plan.kind, plan.stdout.as_str()), ("command-success", "Cargo test: 40 passed in 1 suites (0.13s)"));
        // A pipeline hands back someone else's exit status.
        assert!(super::plan("cargo test | tail", &out, "", &ok()).is_none());
        assert!(super::plan("cargo test", &out, "", &Outcome { exit_code: Some(1), ..ok() }).is_none());
    }

    #[test]
    fn json_loses_only_its_whitespace_and_repeated_lines_fold() {
        let json = format!("{{\n  \"a\": [\n{}  ]\n}}\n", "    1,\n".repeat(120) + "    2\n");
        let plan = plan("curl x", &json, "", &ok()).unwrap();
        assert_eq!(plan.kind, "structured-json");
        assert!(plan.stdout.starts_with("{\"a\":[1,1,"));
        let repeated = "tick\n".repeat(200);
        let plan = super::plan("run", &repeated, "", &ok()).unwrap();
        assert_eq!(plan.kind, "consecutive-duplicates");
        assert!(plan.stdout.contains("[previous line repeated 199 more times]"));
        assert!(super::plan("run", "error: x\n".repeat(200).as_str(), "", &ok()).is_none());
    }

    #[test]
    fn the_hint_names_each_archived_stream() {
        let hint = recovery_hint(
            "command-success",
            &[Recovery { stream: "stdout", path: "/a/b.txt".into(), bytes: 7 }],
        );
        assert_eq!(
            hint,
            "[lossless compact: command-success; full captured output preserved]\n[full stdout: /a/b.txt (7 bytes) — use read to recover]"
        );
    }

    #[test]
    fn to_fixed_rounds_half_up_like_javascript() {
        assert_eq!(to_fixed_2(0.125), "0.13");
        assert_eq!(to_fixed_2(1.005), "1.00");
        assert_eq!(to_fixed_2(2.5), "2.50");
    }
}
