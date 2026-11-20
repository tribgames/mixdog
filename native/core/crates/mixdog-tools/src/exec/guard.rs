//! Guards against shell-tool misuse (`bash-tool/misuse-guard.mjs`, `worktree-add-guard.mjs`), run
//! before policy, hooks and execution:
//!   1. a leading whole-second sleep of 2 s or more is rejected (a wait belongs to background +
//!      task wait);
//!   2. a plain leading `cd <dir>` moves into the `cwd` argument, silently (a `cd` that cannot be
//!      moved without changing the command's meaning is left in the command);
//!   3. the hint rule — a hint is printed only when it is true and names an invocation the
//!      offered replacement tool accepts and that preserves what the command asked for: the only
//!      hint is the refusal of [guard_call], issued when `cover::covering_tool_calls` proves the
//!      whole command (every statement, flag and pipeline stage) is covered and the session offers
//!      the named tool; it names the tool and its arguments. A command with a part no tool covers
//!      runs without a note (Node's generic "use the read / grep / list tools" note and its
//!      "Moved `cd …` into cwd." note are deliberately gone);
//!   4. a command mentioning `git … worktree add` is rejected (worktrees go through the git
//!      tool; a textual check, so mentions as data are too).

use std::sync::LazyLock;

use mixdog_core_api::domain::tool::ToolContext;
use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;

use super::scan::decode_base64_lenient;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

const LEADING_SLEEP_MIN_SECONDS: f64 = 2.0;

/// Whole seconds of the sleep the command starts with.
fn leading_sleep_seconds(command: &str, powershell: bool) -> Option<f64> {
    let m = if powershell {
        lazy_re!(
            r"^\s*(?:start-sleep|sleep)[ \t]+(?:-s(?:e(?:c(?:o(?:n(?:d(?:s)?)?)?)?)?)?[ \t:]+)?(\d+)(?=\s*(?:$|;|&&|\r?\n))",
            "i"
        )
        .captures(command)
    } else {
        lazy_re!(r"^\s*sleep[ \t]+(\d+)(?=\s*(?:$|;|&&|\r?\n))", "").captures(command)
    }?;
    Some(mixdog_js::string_to_number(m.get(1)?))
}

fn leading_sleep_failure(command: &str, powershell: bool) -> Option<String> {
    let seconds = leading_sleep_seconds(command, powershell)?;
    if seconds < LEADING_SLEEP_MIN_SECONDS {
        return None;
    }
    let shown = mixdog_js::number_to_string(seconds);
    Some(super::shell::tool_failure(&format!(
        "Blocked: the leading sleep of {shown} s was not run. For a long-running command use background:true; its completion arrives automatically. To wait for a specific task when the result is needed now, use task wait — do not poll in a sleep loop. A deliberate delay under {} seconds is allowed.",
        LEADING_SLEEP_MIN_SECONDS as u32
    )))
}

/// `(dir, rest)` for a command that starts with a plain `cd <dir>` and more.
fn split_leading_cd(command: &str, powershell: bool) -> Option<(String, String)> {
    let m = lazy_re!(
        r#"^\s*(?:cd|set-location)\s+(?:-path\s+)?(?:"([^"$`]+)"|'([^'$`]+)'|([^\s;&|<>"'`$(){}*?[,@%#!]+))\s*(?:;|&&)\s*(\S[\s\S]*)$"#,
        "i"
    )
    .captures(command)?;
    let dir = m.get(1).or(m.get(2)).or(m.get(3))?;
    let rest = m.get(4)?;
    if lazy_re!(r"^(?:cd|set-location|pushd|popd)(?:\s|;|&|$)", "i").is_match(rest) {
        return None;
    }
    if js_trim(dir).is_empty() || dir.starts_with('-') {
        return None;
    }
    if powershell && lazy_re!(r"[*?[]", "").is_match(dir) {
        return None;
    }
    // `~user` is another account's home; a quoted `~` is a literal directory name.
    if dir.starts_with('~') && (m.get(3).is_none() || !lazy_re!(r"^~(?:[\\/]|$)", "").is_match(dir)) {
        return None;
    }
    // A POSIX backslash escapes; only single quotes keep it literal.
    if !powershell && m.get(2).is_none() && dir.contains('\\') {
        return None;
    }
    Some((dir.to_owned(), rest.to_owned()))
}

// ---- worktree-add-guard.mjs ----

fn normalize_worktree(text: &str, joiner: &str) -> String {
    let continued = lazy_re!(r"[\\`]\r?\n", "g").replace_all_with(text, |_| joiner.to_owned());
    let hex = lazy_re!(r"\\x([0-9a-fA-F]{2})", "g").replace_all_with(&continued, |m| {
        u8::from_str_radix(m.get(1).unwrap_or("0"), 16).map_or(String::new(), |b| char::from(b).to_string())
    });
    let dollar = lazy_re!(r#"\$(?=['"])"#, "g").replace_all_with(&hex, |_| String::new());
    let escapes = lazy_re!(r"[`^]", "g").replace_all_with(&dollar, |_| String::new());
    let quotes = lazy_re!("['\"\u{2018}\u{2019}\u{201a}\u{201b}\u{201c}\u{201d}\u{201e}]", "g")
        .replace_all_with(&escapes, |_| String::new());
    lazy_re!(r"\s+", "g").replace_all_with(&quotes, |_| " ".to_owned())
}

/// `text.split(/[\s,]+/)`.
fn split_tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut in_sep) = (0, false);
    for (i, c) in text.char_indices() {
        let sep = c == ',' || is_js_space(c);
        if sep && !in_sep {
            out.push(&text[start..i]);
            in_sep = true;
        } else if !sep && in_sep {
            start = i;
            in_sep = false;
        }
    }
    out.push(if in_sep { "" } else { &text[start..] });
    out
}

/// Some `git` word comes before a `worktree … add`; options between them are skipped.
fn git_then_worktree_add(text: &str) -> bool {
    let tokens = split_tokens(text);
    let mut git_seen = false;
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        if !git_seen {
            git_seen = lazy_re!(r"\bgit\b", "i").is_match(token);
            i += 1;
            continue;
        }
        if token.starts_with('-') || !lazy_re!(r"(?:^|[^\w-])worktree$", "i").is_match(token) {
            i += 1;
            continue;
        }
        let mut next = i + 1;
        while next < tokens.len() && tokens[next].starts_with('-') {
            next += 1;
        }
        if next < tokens.len() && lazy_re!(r"^add\b", "i").is_match(tokens[next]) {
            return true;
        }
        i = next;
    }
    false
}

/// `addsUnmanagedWorktree`: the command would (or might) run `git … worktree add`.
pub fn adds_unmanaged_worktree(command: &str) -> bool {
    let mut texts = vec![command.to_owned()];
    for m in lazy_re!(r#"(?:^|[\s'"])[-/]e(?:c|n[a-z]*)?\s+['"]?([A-Za-z0-9+/]{4,}={0,2})"#, "gi")
        .captures_iter(command)
    {
        let bytes = decode_base64_lenient(m.get(1).unwrap_or("").as_bytes());
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        texts.push(String::from_utf16_lossy(&units));
    }
    texts.iter().any(|text| {
        ["", " "].iter().any(|joiner| {
            let normalized = normalize_worktree(text, joiner);
            // A backslash is a POSIX escape (`a\dd` is `add`) or a Windows path separator.
            let dropped = lazy_re!(r"\\(?=[A-Za-z])", "g").replace_all_with(&normalized, |_| String::new());
            git_then_worktree_add(&dropped) || git_then_worktree_add(&normalized.replace('\\', "/"))
        })
    })
}

const SHELL_WORKTREE_ADD_BLOCK: &str = "Blocked: this shell command mentions `git … worktree add`, which does not run from the shell; Mixdog manages worktrees so they are cleaned up. To create one, use the git tool: command \"git worktree add --detach <path> [<commit>]\" makes a read-only snapshot (removed when the turn ends; delegated workers too), and the Lead uses \"git worktree add -b <branch> <path>\" or action:\"worktree\" for a branch worktree. The check is textual: to search for that text use the grep tool, and keep the phrase out of shell commands (echo, commit messages, heredocs).";

/// What the guards decided for one call.
#[derive(Debug, PartialEq, Eq)]
pub enum Guarded {
    /// The call is refused; the text is the whole result.
    Refused(String),
    /// The call runs with this command and cwd (a leading `cd` moved into `cwd`) and these
    /// lines added to its result. No guard adds a line any more; the field stays for the shell tool's result framing.
    Run { command: String, cwd: Option<String>, notes: Vec<String> },
}

/// Applies the guards to a shell call.
pub fn guard_shell_call(command: &str, cwd: Option<&str>, background: bool, powershell: bool) -> Guarded {
    let (mut command, mut cwd) = (command.to_owned(), cwd.map(str::to_owned));
    if cwd.is_none() && let Some((dir, rest)) = split_leading_cd(&command, powershell) {
        command = rest;
        cwd = Some(dir);
    }
    if !background && let Some(failure) = leading_sleep_failure(&command, powershell) {
        return Guarded::Refused(failure);
    }
    if adds_unmanaged_worktree(&command) {
        return Guarded::Refused(super::shell::tool_failure(SHELL_WORKTREE_ADD_BLOCK));
    }
    Guarded::Run { command, cwd, notes: Vec::new() }
}

/// [guard_shell_call] with the session's tool surface (guardShellCall with offers): a command the built-in tools cover whole
/// is refused, naming the call that replaces it, when the session offers every tool that call names. A call that runs elsewhere
/// than the session directory (its own cwd, a leading cd) is never covered, since the tools resolve paths in the session's.
pub(crate) async fn guard_call(ctx: &ToolContext, command: &str, cwd: Option<&str>, background: bool, powershell: bool) -> Guarded {
    let guarded = guard_shell_call(command, cwd, background, powershell);
    let Guarded::Run { command, cwd: None, .. } = &guarded else { return guarded };
    let Some(offered) = &ctx.options.offered_tools else { return guarded };
    match super::cover::covering_tool_calls(ctx, command, powershell).await {
        Some(calls) if calls.iter().all(|call| offered.iter().any(|name| name == call.tool)) => {
            Guarded::Refused(super::shell::tool_failure(&super::cover::blocked_text(&calls)))
        }
        _ => guarded,
    }
}



#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods, reason = "tests write their fixture tree on the test thread")]

    use std::sync::Arc;

    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::mock::MockProcessManager;
    use mixdog_core_api::domain::mock::MockProgress;
    use mixdog_core_api::domain::tool::SurfaceKind;
    use mixdog_core_api::domain::tool::Tool;
    use mixdog_core_api::domain::tool::ToolIo;
    use mixdog_core_api::domain::tool::ToolPart;
    use mixdog_protocol::JsonValue;
    use mixdog_protocol::ThreadId;
    use mixdog_protocol::ToolCallId;
    use mixdog_protocol::TurnId;
    use tokio_util::sync::CancellationToken;

    use super::*;

    /// A call's context over a fixture tree (the session directory), offering `offers` (`None`: no session information).
    fn session(offers: Option<&[&str]>) -> (tempfile::TempDir, ToolContext) {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in [
            ("small.txt", "alpha\nFoo bar\nomega foo\n"),
            ("other.txt", "beta\n"),
            ("d/one.txt", "1\n"),
            ("d/.hidden", "h\n"),
            ("d/inner/deep.txt", "deep\n"),
            ("my dir/small.txt", "quoted\n"),
        ] {
            let path = dir.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let mut ctx = ToolContext {
            call_id: ToolCallId::from("c"),
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            tool: "shell".into(),
            cwd: AbsPath::new(dir.path()).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(mixdog_workspace::localfs::LocalFileService::new()),
            processes: Arc::new(MockProcessManager::default()),
            options: Default::default(),
            review: None,
        };
        ctx.options.offered_tools = offers.map(|tools| Arc::new(tools.iter().map(|t| (*t).to_owned()).collect()));
        (dir, ctx)
    }

    const ALL: Option<&[&str]> = Some(&["read", "grep", "list"]);

    fn runs_unchanged(guarded: Guarded, command: &str) {
        assert_eq!(guarded, Guarded::Run { command: command.to_owned(), cwd: None, notes: Vec::new() }, "{command}");
    }

    /// The published spec of `tool`, applied by hand: only its properties, of their types and ranges, and its required ones.
    fn assert_in_spec(tool: &str, args: &JsonValue) {
        let def = match tool {
            "read" => include_str!("../fs/specs/read.json"),
            "grep" => include_str!("../fs/specs/grep.json"),
            "list" => include_str!("../fs/specs/list.json"),
            other => panic!("{other} is not a replacement tool"),
        };
        let schema = serde_json::from_str::<JsonValue>(def).unwrap()["inputSchema"].clone();
        fn fits(value: &JsonValue, schema: &JsonValue) -> bool {
            if let Some(options) = schema["anyOf"].as_array() {
                return options.iter().any(|o| fits(value, o));
            }
            match schema["type"].as_str() {
                Some("string") => value.is_string(),
                Some("boolean") => value.is_boolean(),
                Some("integer") => value.as_i64().is_some_and(|n| {
                    schema["minimum"].as_i64().is_none_or(|min| n >= min) && schema["maximum"].as_i64().is_none_or(|max| n <= max)
                }),
                _ => true,
            }
        }
        for (key, value) in args.as_object().unwrap() {
            let property = schema["properties"].get(key).unwrap_or_else(|| panic!("{tool} has no argument {key}"));
            assert!(fits(value, property), "{tool} {key}: {value}");
        }
        for key in schema["required"].as_array().into_iter().flatten() {
            assert!(args.get(key.as_str().unwrap()).is_some(), "{tool} needs {key}");
        }
    }

    async fn answer(tool: &str, ctx: &ToolContext, args: JsonValue) -> String {
        let outcome = match tool {
            "read" => crate::fs::ReadTool::new(None, None).call(ctx, args).await,
            "grep" => crate::fs::GrepTool::new().call(ctx, args).await,
            "list" => crate::fs::ListTool::new().call(ctx, args).await,
            other => panic!("{other} is not a replacement tool"),
        };
        match outcome {
            Ok(out) => match &out.parts[0] {
                ToolPart::Text(text) => text.clone(),
                _ => panic!("not text"),
            },
            Err(e) => panic!("{}", e.message_for_model),
        }
    }

    /// Every command the table covers is refused with the call that replaces it; the named call is inside the tool's spec and,
    /// run on the fixture tree, shows what the shell command printed (`shows`) and nothing it did not (`hides`).
    #[tokio::test]
    async fn a_covered_command_names_a_call_that_is_in_the_spec_and_returns_what_the_command_printed() {
        let (_dir, ctx) = session(ALL);
        let cases: [(&str, bool, &str, &[&str], &[&str]); 8] = [
            ("cat small.txt", false, "read", &["alpha", "Foo bar", "omega foo"], &[]),
            ("head -n 2 small.txt", false, "read", &["alpha", "Foo bar"], &["omega foo"]),
            ("tail -n 1 small.txt", false, "read", &["omega foo"], &["alpha"]),
            ("grep -i foo small.txt", false, "grep", &["Foo bar", "omega foo"], &["alpha"]),
            ("ls d", false, "list", &["one.txt", "inner"], &[".hidden", "deep.txt"]),
            ("Get-Content small.txt -TotalCount 1", true, "read", &["alpha"], &["Foo bar"]),
            ("Select-String foo small.txt", true, "grep", &["Foo bar", "omega foo"], &["alpha"]),
            ("cat small.txt | head -n 2", false, "read", &["alpha", "Foo bar"], &["omega foo"]),
        ];
        for (command, powershell, tool, shows, hides) in cases {
            let calls = super::super::cover::covering_tool_calls(&ctx, command, powershell).await.unwrap_or_else(|| panic!("{command} is covered"));
            assert_eq!(calls.len(), 1, "{command}");
            assert_eq!(calls[0].tool, tool, "{command}");
            assert_in_spec(tool, &calls[0].args);
            let refusal = guard_call(&ctx, command, None, false, powershell).await;
            let want = super::super::shell::tool_failure(&super::super::cover::blocked_text(&calls));
            assert_eq!(refusal, Guarded::Refused(want), "{command}");
            let text = answer(tool, &ctx, calls[0].args.clone()).await;
            for line in shows {
                assert!(text.contains(line), "{command}: {line} missing from {text}");
            }
            for line in hides {
                assert!(!text.contains(line), "{command}: {line} in {text}");
            }
        }
    }

    /// Commands with a part no tool covers run with no note and no suggestion: a recursive listing (with a size column), a
    /// flag that changes the output, a sort / filter pipeline, several statements.
    #[tokio::test]
    async fn a_command_with_a_part_no_tool_covers_runs_without_a_note() {
        let (_dir, ctx) = session(ALL);
        for (command, powershell) in [
            ("ls -lR d | sort -k5 -n", false),
            ("ls -lR d", false),
            ("ls -l d", false),
            ("ls -a d", false),
            ("find d -type f -size +0 | sort", false),
            ("du -a d | sort -n", false),
            ("Get-ChildItem d -Recurse | Sort-Object Length", true),
            ("Get-ChildItem d", true),
            ("ls d", true),
            ("grep -c foo small.txt", false),
            ("cat small.txt | sort", false),
            ("cat small.txt | sort | head -n 2", false),
            ("grep foo small.txt | wc -l", false),
            ("Get-Content small.txt | Sort-Object", true),
            ("cat small.txt; cat other.txt", false),
            ("cat small.txt && ls d", false),
            ("cat small.txt\ncat other.txt", false),
            ("Get-Content small.txt; Get-Content other.txt", true),
        ] {
            runs_unchanged(guard_call(&ctx, command, None, false, powershell).await, command);
        }
    }

    /// A tool the session does not offer is never named: the same covered commands run when the replacement is missing or
    /// the session says nothing about its tools.
    #[tokio::test]
    async fn a_replacement_the_session_does_not_offer_is_not_suggested() {
        for (offers, command, powershell) in [
            (Some(&["grep", "list"][..]), "cat small.txt", false),
            (Some(&["read", "list"][..]), "grep foo small.txt", false),
            (Some(&["read", "grep"][..]), "ls d", false),
            (Some(&[][..]), "cat small.txt", false),
            (Some(&["grep", "list"][..]), "Get-Content small.txt", true),
            (None, "cat small.txt", false),
            (None, "ls d", false),
        ] {
            let (_dir, ctx) = session(offers);
            assert!(super::super::cover::covering_tool_calls(&ctx, command, powershell).await.is_some(), "{command} is covered");
            runs_unchanged(guard_call(&ctx, command, None, false, powershell).await, command);
        }
    }

    /// A leading `cd` moves into `cwd` without a word; with an explicit `cwd` it stays in the command; a command that ran
    /// elsewhere than the session directory is never covered; a quoted directory moves, one the shell would expand does not.
    #[tokio::test]
    async fn a_leading_cd_is_moved_silently_and_left_alone_when_it_cannot_be_moved() {
        let (_dir, ctx) = session(ALL);
        let moved = |command: &str, cwd: Option<&str>, powershell| guard_shell_call(command, cwd, false, powershell);
        let run = |command: &str, cwd: Option<&str>| Guarded::Run { command: command.to_owned(), cwd: cwd.map(str::to_owned), notes: Vec::new() };

        assert_eq!(moved("cd /tmp && ls", None, false), run("ls", Some("/tmp")));
        assert_eq!(moved("Set-Location src; Get-ChildItem", None, true), run("Get-ChildItem", Some("src")));
        // quoted
        assert_eq!(moved(r#"cd "my dir" && cat small.txt"#, None, false), run("cat small.txt", Some("my dir")));
        assert_eq!(moved("cd 'my dir' && cat small.txt", None, false), run("cat small.txt", Some("my dir")));
        for command in [r#"cd "$HOME/x" && ls"#, "cd '~' && ls", "cd ~root && ls", "cd -- x && ls", "cd a && cd b && ls"] {
            assert_eq!(moved(command, None, false), run(command, None), "{command}");
        }
        // an explicit cwd: the cd is the command's own
        assert_eq!(moved("cd d && cat small.txt", Some("my dir"), false), run("cd d && cat small.txt", Some("my dir")));
        assert_eq!(guard_call(&ctx, "cd d && cat small.txt", Some("my dir"), false, false).await, run("cd d && cat small.txt", Some("my dir")));
        // `small.txt` is not in `d`: covering the moved command in the session directory would name the wrong file
        assert_eq!(guard_call(&ctx, "cd d && cat small.txt", None, false, false).await, run("cat small.txt", Some("d")));
        assert_eq!(guard_call(&ctx, r#"cd "my dir" && cat small.txt"#, None, false, false).await, run("cat small.txt", Some("my dir")));
        assert_eq!(guard_call(&ctx, "cat small.txt", Some("d"), false, false).await, run("cat small.txt", Some("d")));
    }


    fn guarded(command: &str, cwd: Option<&str>, background: bool, powershell: bool) -> Guarded {
        guard_shell_call(command, cwd, background, powershell)
    }

    fn refusal_text(guarded: Guarded) -> String {
        match guarded {
            Guarded::Refused(text) => text,
            Guarded::Run { command, .. } => panic!("expected a refusal, {command:?} runs"),
        }
    }

    #[test]
    fn a_leading_sleep_of_two_seconds_or_more_is_refused_in_a_foreground_command() {
        for (command, seconds) in [("sleep 5", "5"), ("sleep 2; echo done", "2"), ("sleep 3 && ls", "3"), ("  sleep 3\nls", "3")] {
            let want = format!("Error: [shell-tool-failed] Blocked: the leading sleep of {seconds} s was not run. For a long-running command use background:true; its completion arrives automatically. To wait for a specific task when the result is needed now, use task wait — do not poll in a sleep loop. A deliberate delay under 2 seconds is allowed.");
            assert_eq!(refusal_text(guarded(command, None, false, false)), want, "{command:?}");
        }
    }

    #[test]
    fn a_short_or_background_or_later_sleep_is_not_refused() {
        for (command, background) in [("sleep 1", false), ("sleep 2.5", false), ("sleep 10", true), ("sleep 3 | cat", false), ("echo a; sleep 9", false), ("Start-Sleep 5", false)] {
            assert!(matches!(guarded(command, None, background, false), Guarded::Run { .. }), "{command:?}");
        }
    }

    #[test]
    fn a_managed_worktree_creation_is_refused_in_any_spelling_and_other_worktree_commands_run() {
        for command in ["git worktree add ../x", "git -C d worktree add -b b p", "echo \"git worktree add\"", "g\\\nit worktree add p", "echo $'\\x67it' worktree add"] {
            let text = refusal_text(guarded(command, None, false, false));
            assert!(text.starts_with("Error: [shell-tool-failed] Blocked: this shell command mentions `git … worktree add`, which does not run from the shell;"), "{command:?}: {text}");
            assert!(text.contains("The check is textual: to search for that text use the grep tool"), "{text}");
        }
        for command in ["git status", "git worktree list"] {
            assert!(matches!(guarded(command, None, false, false), Guarded::Run { .. }), "{command:?}");
        }
    }

    #[test]
    fn a_file_reading_command_runs_unchanged_and_without_a_note() {
        for command in ["cat file.txt", "cat a b | head -5", "head -n 5 file", "tail -n +5 file", "grep foo file", "grep -e foo file", "ls src", "ls src | wc -l", "find . -name \"*.rs\"", "rg foo src", "cat a > /dev/null"] {
            let Guarded::Run { command: run, notes, .. } = guarded(command, None, false, false) else { panic!("{command:?} was refused") };
            assert_eq!((run.as_str(), notes), (command, Vec::new()), "{command:?}");
        }
        for command in ["cat", "grep foo", "ls", "ls src | xargs rm", "find . -name x -delete", "find . -type f", "cat a > b", "Get-Content a.txt"] {
            let Guarded::Run { notes, .. } = guarded(command, None, false, false) else { panic!("{command:?} was refused") };
            assert!(notes.is_empty(), "{command:?}: {notes:?}");
        }
    }

    #[test]
    fn a_leading_cd_moves_into_the_working_folder_only_when_it_is_one_plain_literal_directory() {
        for powershell in [false, true] {
            for (command, want_command, cwd) in [("cd /tmp && ls", "ls", "/tmp"), ("cd /tmp; ls", "ls", "/tmp"), ("cd \"/my dir\" && ls", "ls", "/my dir"), ("cd ~ && ls", "ls", "~"), ("cd 'a\\b' && ls", "ls", "a\\b")] {
                let Guarded::Run { command: run, cwd: got, .. } = guarded(command, None, false, powershell) else { panic!("{command:?} was refused") };
                assert_eq!((run.as_str(), got.as_deref()), (want_command, Some(cwd)), "{command:?}");
            }
            for command in ["cd $HOME && ls", "cd ~user && ls", "cd - && ls", "cd /tmp && cd /var && ls", "cd /tmp", "cd src/*; ls", "pushd x; ls"] {
                let Guarded::Run { command: run, cwd: got, .. } = guarded(command, None, false, powershell) else { panic!("{command:?} was refused") };
                assert_eq!((run.as_str(), got), (command, None), "{command:?}");
            }
            // An unquoted backslash escapes in a POSIX shell, so the directory is not the literal text; PowerShell takes it as is.
            for (command, want_command, cwd) in [("cd a\\b && ls", "ls", "a\\b"), ("Set-Location -Path C:\\x; Get-ChildItem", "Get-ChildItem", "C:\\x")] {
                let Guarded::Run { command: run, cwd: got, .. } = guarded(command, None, false, powershell) else { panic!("{command:?} was refused") };
                let want = if powershell { (want_command, Some(cwd)) } else { (command, None) };
                assert_eq!((run.as_str(), got.as_deref()), want, "{command:?} powershell={powershell}");
            }
            let Guarded::Run { command: run, cwd: got, .. } = guarded("cd /tmp && ls", Some("/x"), false, powershell) else { panic!("refused") };
            assert_eq!((run.as_str(), got.as_deref()), ("cd /tmp && ls", Some("/x")), "an explicit working folder keeps the cd as the command's own");
        }
    }

}
