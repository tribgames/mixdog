//! Command parsing for the `git` tool: the direct-argv tokenizer, the shell-syntax guard,
//! global-flag skipping, the read-only classification and the `&&` chain split. Each function
//! is the Node tool's (`git-command-policy.mjs`, `shell-direct-exe.mjs`, the parsing half of
//! `git-command-tool.mjs`).

use std::path::Path;
use std::path::PathBuf;

use mixdog_protocol::JsonValue;
use regex::Regex;

const SHELL_OPERATOR_CHARS: &str = "|&;<>()";
const GUI_OPERATIONS: [&str; 5] = ["gui", "citool", "gitk", "difftool", "mergetool"];
const SERVER_OPERATIONS: [&str; 2] = ["daemon", "instaweb"];

const ALWAYS_READ: [&str; 36] = [
    "blame", "cat-file", "check-attr", "check-ignore", "check-ref-format", "cherry", "count-objects",
    "describe", "diff", "diff-files", "diff-index", "diff-tree", "for-each-ref", "fsck", "grep", "help",
    "log", "ls-files", "ls-remote", "ls-tree", "merge-base", "merge-tree", "name-rev", "range-diff",
    "rev-list", "rev-parse", "shortlog", "show", "show-branch", "show-ref", "status", "verify-commit",
    "verify-pack", "verify-tag", "version", "whatchanged",
];

const GLOBAL_VALUE_FLAGS: [&str; 5] = ["-c", "--config-env", "--git-dir", "--work-tree", "--namespace"];
const GLOBAL_BARE_FLAGS: [&str; 7] = [
    "--no-pager", "--paginate", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs",
    "--icase-pathspecs",
];

/// `git --version` / `-v` / `--help` / `-h` arrive in global-flag position.
fn operation_alias(raw: &str) -> &str {
    match raw {
        "--version" | "-v" => "version",
        "--help" | "-h" => "help",
        other => other,
    }
}

/// `path.resolve(base, rel)`: lexical, no filesystem access.
pub(super) fn resolve(base: &Path, rel: &str) -> PathBuf {
    let joined = if Path::new(rel).is_absolute() { PathBuf::from(rel) } else { base.join(rel) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub(super) fn is_git_program(token: &str) -> bool {
    let lower = token.to_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    stem.strip_suffix("git")
        .is_some_and(|head| head.is_empty() || head.ends_with('/') || head.ends_with('\\'))
}

/// Quote-aware argv split that keeps Windows backslashes literal (non-strict form).
pub(super) fn tokenize_direct_argv(command: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = command.chars().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match quote {
            Some('"') => {
                if ch == '\\' && chars.get(i + 1) == Some(&'"') {
                    current.push('"');
                    i += 2;
                    continue;
                }
                if ch == '"' {
                    if chars.get(i + 1) == Some(&'"') {
                        current.push('"');
                        i += 2;
                        continue;
                    }
                    quote = None;
                    i += 1;
                    continue;
                }
                current.push(ch);
            }
            Some(_) => {
                if ch == '\'' {
                    if chars.get(i + 1) == Some(&'\'') {
                        current.push('\'');
                        i += 2;
                        continue;
                    }
                    quote = None;
                    i += 1;
                    continue;
                }
                current.push(ch);
            }
            None => {
                if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                    started = true;
                } else if ch.is_whitespace() {
                    if started {
                        tokens.push(std::mem::take(&mut current));
                    }
                    started = false;
                } else {
                    current.push(ch);
                    started = true;
                }
            }
        }
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    if started {
        tokens.push(current);
    }
    Some(tokens)
}

fn at_token_boundary(ch: Option<char>) -> bool {
    ch.is_none_or(char::is_whitespace)
}

/// The tool never opens a shell, so an operator can only reach git as literal argument text;
/// the guard rejects commands written as shell pipelines.
pub(super) fn command_has_shell_syntax(command: &str) -> bool {
    let text: Vec<char> = command.chars().collect();
    let mut quote: Option<char> = None;
    let mut index = 0;
    while index < text.len() {
        let ch = text[index];
        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                }
            }
            Some(_) => {
                if ch == '\\' && text.get(index + 1) == Some(&'"') {
                    index += 1;
                } else if ch == '"' {
                    quote = None;
                } else if ch == '$' || ch == '`' {
                    return true;
                }
            }
            None => {
                if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                } else if ch == '$' || ch == '`' || ch == '\n' || ch == '\r' {
                    return true;
                } else if SHELL_OPERATOR_CHARS.contains(ch) {
                    let mut end = index;
                    while end + 1 < text.len() && SHELL_OPERATOR_CHARS.contains(text[end + 1]) {
                        end += 1;
                    }
                    let before = if index == 0 { None } else { Some(text[index - 1]) };
                    if at_token_boundary(before) && at_token_boundary(text.get(end + 1).copied()) {
                        return true;
                    }
                    index = end;
                }
            }
        }
        index += 1;
    }
    quote.is_some()
}

pub(super) enum GlobalFlag {
    Chdir(Option<String>),
    Value(String, Option<String>),
    Bare(String),
}

/// Steps over git's global flags; returns the subcommand index and what was skipped.
pub(super) fn skip_git_global_flags(tokens: &[String]) -> (usize, Vec<GlobalFlag>) {
    let mut events = Vec::new();
    let mut index = 1;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "-C" {
            events.push(GlobalFlag::Chdir(tokens.get(index + 1).cloned()));
            index += 2;
        } else if token.starts_with("-C") && token.len() > 2 {
            events.push(GlobalFlag::Chdir(Some(token[2..].to_owned())));
            index += 1;
        } else if GLOBAL_VALUE_FLAGS.contains(&token) {
            events.push(GlobalFlag::Value(token.to_owned(), tokens.get(index + 1).cloned()));
            index += 2;
        } else if ["--git-dir=", "--work-tree=", "--namespace=", "--config-env="]
            .iter()
            .any(|p| token.starts_with(p))
            || GLOBAL_BARE_FLAGS.contains(&token)
        {
            events.push(GlobalFlag::Bare(token.to_owned()));
            index += 1;
        } else {
            break;
        }
    }
    (index, events)
}

fn git_action_of<'a>(operation: &str, args: &'a [String]) -> &'a str {
    if let Some(first) = args.iter().find(|v| !v.is_empty() && !v.starts_with('-')) {
        return first;
    }
    match operation {
        "stash" => "push",
        "reflog" => "show",
        _ => "list",
    }
}

fn matches_re(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).is_ok_and(|re| re.is_match(value))
}

pub(super) fn plan_is_read_only(operation: &str, args: &[String]) -> bool {
    if args.iter().any(|v| v == "--output" || v.starts_with("--output=")) {
        return false;
    }
    if operation == "fsck" && args.iter().any(|v| v == "--lost-found") {
        return false;
    }
    if ALWAYS_READ.contains(&operation) {
        return true;
    }
    let action = git_action_of(operation, args);
    match operation {
        "reflog" => ["show", "list", "exists"].contains(&action),
        "stash" => ["list", "show"].contains(&action),
        "worktree" | "sparse-checkout" => action == "list",
        "remote" => ["list", "get-url", "show"].contains(&action),
        "clean" => args
            .iter()
            .any(|v| v == "-n" || v == "--dry-run" || matches_re(r"^-[^-]*n", v)),
        "bundle" => ["list-heads", "verify"].contains(&action),
        "notes" => ["", "list", "show"].contains(&action),
        "replace" => args.is_empty() || args.iter().any(|v| v == "--list"),
        "submodule" => ["", "status", "summary"].contains(&action),
        "symbolic-ref" => {
            if args.iter().any(|v| v == "-d" || v == "--delete") {
                return false;
            }
            args.iter().filter(|v| !v.starts_with('-')).count() <= 1
        }
        "hash-object" => !args.iter().any(|v| v == "-w" || v == "--stdin-paths"),
        "branch" | "tag" => {
            let writes = if operation == "tag" {
                r"^(?:-[adfsumFe]|--(?:annotate|delete|force|sign|local-user(?:=.*)?|message(?:=.*)?|file(?:=.*)?|edit))$"
            } else {
                r"^(?:-[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to(?:=.*)?|unset-upstream|edit-description|track|no-track|create-reflog))$"
            };
            if args.iter().any(|v| matches_re(writes, v)) {
                return false;
            }
            let list: &[&str] = if operation == "tag" {
                &["--list", "-l"]
            } else {
                &["--list", "-l", "-a", "--all", "-r", "--remotes"]
            };
            args.is_empty() || args.iter().any(|v| list.contains(&v.as_str()))
        }
        "config" => {
            const MUTATION: [&str; 7] = [
                "--add", "--edit", "--rename-section", "--remove-section", "--replace-all", "--unset", "--unset-all",
            ];
            if args.iter().any(|v| MUTATION.contains(&v.as_str())) {
                return false;
            }
            let read_flag = args.iter().any(|v| {
                matches_re(r"^--(?:get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$", v)
            });
            let positional: Vec<&String> = args.iter().filter(|v| !v.starts_with('-')).collect();
            let first = positional.first().map(|v| v.as_str());
            if ["set", "unset", "rename-section", "remove-section"].contains(&first.unwrap_or("\0")) {
                return false;
            }
            if ["get", "get-all", "get-regexp", "get-urlmatch", "list"].contains(&first.unwrap_or("\0")) {
                return true;
            }
            read_flag || positional.len() <= 1
        }
        _ => false,
    }
}

/// Whether a `git` tool call may change the repository (`gitCommandMutates`): anything but a
/// plain read-only command. The agent's result cache drops what such a call may have touched
/// (`ResultReuse::after_call`); an unparsable command counts as a mutation.
pub fn git_call_mutates(args: &JsonValue) -> bool {
    let args = match args {
        JsonValue::String(text) => {
            serde_json::from_str::<JsonValue>(text).unwrap_or_else(|_| serde_json::json!({ "command": text }))
        }
        other => other.clone(),
    };
    if args.get("action").is_some_and(|a| !a.is_null() && a.as_str() != Some("command")) {
        return true;
    }
    let command = match args.get("command") {
        Some(JsonValue::String(text)) => text.clone(),
        Some(JsonValue::Array(items)) => items.iter().map(|v| v.as_str().unwrap_or_default()).collect::<Vec<_>>().join(","),
        _ => return true,
    };
    if command_has_shell_syntax(&command) {
        return true;
    }
    let Some(tokens) = tokenize_direct_argv(&command).filter(|t| t.first().is_some_and(|f| is_git_program(f))) else {
        return true;
    };
    let (index, _) = skip_git_global_flags(&tokens);
    let raw = tokens.get(index).map(|t| t.to_lowercase()).unwrap_or_default();
    let operation = operation_alias(&raw);
    if operation.is_empty() {
        return true;
    }
    !plan_is_read_only(operation, &tokens[index + 1..])
}

#[derive(Clone, Debug)]
pub(super) struct Plan {
    pub command: String,
    pub cwd: PathBuf,
    pub global_args: Vec<String>,
    pub operation: String,
    pub args: Vec<String>,
}

impl Plan {
    pub fn read_only(&self) -> bool {
        plan_is_read_only(&self.operation, &self.args)
    }
}

/// One balanced quote layer around a whole command is dropped.
fn unwrap_quoted_command(command: &str) -> String {
    let text = command.trim();
    let mut chars = text.chars();
    let Some(quote) = chars.next() else { return command.to_owned() };
    if (quote != '"' && quote != '\'') || text.chars().count() < 2 || !text.ends_with(quote) {
        return command.to_owned();
    }
    let inner: String = text.chars().skip(1).take(text.chars().count() - 2).collect();
    if inner.contains(quote) { command.to_owned() } else { inner }
}

pub(super) fn parse_command(raw_command: &str, work_dir: &Path) -> Result<Plan, String> {
    let command = unwrap_quoted_command(raw_command);
    if command_has_shell_syntax(&command) {
        let unquoted = Regex::new(r#""(?:\\.|[^"\\])*"|'[^']*'"#)
            .map_or_else(|_| command.clone(), |re| re.replace_all(&command, "").into_owned());
        return Err(format!(
            "git command must not contain shell operators or substitution; multiple commands belong in the command array.{}",
            if unquoted.contains('|') { " For | head/tail use output_limit, for | grep use the grep tool" } else { "" }
        ));
    }
    let tokens = tokenize_direct_argv(&command).unwrap_or_default();
    if tokens.first().is_none_or(|t| !is_git_program(t)) {
        return Err("command must begin with git".to_owned());
    }
    let mut cwd = work_dir.to_path_buf();
    let mut global_args = Vec::new();
    let (index, events) = skip_git_global_flags(&tokens);
    for event in events {
        match event {
            GlobalFlag::Chdir(path) => match path.filter(|p| !p.is_empty()) {
                Some(path) => cwd = resolve(&cwd, &path),
                None => return Err("git -C requires a path".to_owned()),
            },
            GlobalFlag::Value(token, value) => match value.filter(|v| !v.is_empty()) {
                Some(value) => {
                    global_args.push(token);
                    global_args.push(value);
                }
                None => return Err(format!("{token} requires a value")),
            },
            GlobalFlag::Bare(token) => global_args.push(token),
        }
    }
    let raw_operation = tokens.get(index).map(|t| t.to_lowercase()).unwrap_or_default();
    let operation = operation_alias(&raw_operation).to_owned();
    if operation.is_empty() {
        return Err("git requires a subcommand".to_owned());
    }
    let args: Vec<String> = tokens.iter().skip(index + 1).cloned().collect();
    let help_arg = args.iter().any(|v| v == "--help")
        || (operation == "help" && args.iter().any(|v| !v.starts_with('-')))
        || (operation == "help" && args.iter().any(|v| ["-w", "--web", "-m", "--man", "-i", "--info"].contains(&v.as_str())));
    if help_arg {
        return Err("git manual help can open an external viewer; use the subcommand -h form for terminal usage".to_owned());
    }
    if GUI_OPERATIONS.contains(&operation.as_str()) {
        return Err(format!(
            "git {operation} opens an interactive GUI and would never return here; use its non-interactive form (diff, merge, add -p)"
        ));
    }
    if SERVER_OPERATIONS.contains(&operation.as_str()) {
        return Err(format!(
            "git {operation} is a long-running server; start it with the shell tool so it becomes a background task"
        ));
    }
    Ok(Plan { command, cwd, global_args, operation, args })
}

/// `git config` is held to the local repository.
pub(super) fn localize_config_plan(mut plan: Plan) -> Result<Plan, String> {
    if plan.operation != "config" {
        return Ok(plan);
    }
    let external = plan.args.iter().find(|v| {
        ["--global", "--system", "--file", "-f"].contains(&v.as_str())
            || v.starts_with("--file=")
            || (v.starts_with("-f") && v.len() > 2 && !v.starts_with("--"))
    });
    if let Some(external) = external {
        return Err(format!("git config {external} is outside the local repository scope"));
    }
    if plan.args.iter().any(|v| v == "--local" || v == "--worktree") {
        return Ok(plan);
    }
    const SUBCOMMANDS: [&str; 7] = ["get", "set", "unset", "list", "rename-section", "remove-section", "edit"];
    if plan.args.first().is_some_and(|a| SUBCOMMANDS.contains(&a.as_str())) {
        plan.args.insert(1, "--local".to_owned());
    } else {
        plan.args.insert(0, "--local".to_owned());
    }
    Ok(plan)
}

/// `git a && git b` written as one string runs as the command array; only top-level `&&`, `;`
/// and newlines split.
pub(super) fn split_chained_git_commands(command: &str) -> Option<Vec<String>> {
    let text: Vec<char> = command.chars().collect();
    let mut pieces: Vec<String> = Vec::new();
    let mut quote: Option<char> = None;
    let mut start = 0;
    let mut index = 0;
    while index < text.len() {
        let ch = text[index];
        if let Some(q) = quote {
            if ch == '\\' && q == '"' {
                index += 2;
                continue;
            }
            if ch == q {
                quote = None;
            }
            index += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            index += 1;
            continue;
        }
        let next = text.get(index + 1).copied();
        let width = if ch == '&' && next == Some('&') {
            2
        } else if ch == ';' || ch == '\n' {
            1
        } else if ch == '\r' && next == Some('\n') {
            2
        } else {
            0
        };
        if width == 0 {
            index += 1;
            continue;
        }
        pieces.push(text[start..index].iter().collect());
        index += width;
        start = index;
    }
    if quote.is_some() || pieces.is_empty() {
        return None;
    }
    pieces.push(text[start.min(text.len())..].iter().collect());
    let commands: Vec<String> = pieces.iter().map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()).collect();
    (commands.len() > 1).then_some(commands)
}

/// A whole command that omits the leading `git` gets it.
pub(super) fn with_git_prefix(command: &str) -> String {
    let text = unwrap_quoted_command(command).trim().to_owned();
    let first = if text.is_empty() { None } else { tokenize_direct_argv(&text).and_then(|t| t.into_iter().next()) };
    match first {
        Some(first) if !first.is_empty() && !is_git_program(&first) => format!("git {text}"),
        _ => command.to_owned(),
    }
}

/// A JSON-stringified string array (`'["git status","git log"]'`) for an array parameter.
pub(super) fn parse_stringified_array(value: &JsonValue) -> JsonValue {
    let JsonValue::String(raw) = value else { return value.clone() };
    let text = raw.trim();
    if !text.starts_with('[') || !text.ends_with(']') {
        return value.clone();
    }
    match serde_json::from_str::<JsonValue>(text) {
        Ok(JsonValue::Array(items)) if !items.is_empty() && items.iter().all(JsonValue::is_string) => {
            JsonValue::Array(items)
        }
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(command: &str) -> Result<Plan, String> {
        parse_command(command, Path::new("/w"))
    }

    #[test]
    fn shell_syntax_is_refused_but_literal_separators_pass() {
        assert!(plan("git log | head").unwrap_err().contains("For | head/tail"));
        assert!(plan("git status && git log").is_err());
        assert!(plan("git log --format=%h|%ad|%s").is_ok());
        assert!(plan("git log \"$(x)\"").is_err());
        assert_eq!(plan("status").unwrap_err(), "command must begin with git");
    }

    #[test]
    fn global_flags_and_aliases() {
        let p = plan("git -C sub -c a=b --no-pager -v").unwrap();
        assert_eq!(p.operation, "version");
        assert_eq!(p.global_args, ["-c", "a=b", "--no-pager"]);
        assert_eq!(p.cwd, Path::new("/w/sub"));
        assert_eq!(plan("git -C").unwrap_err(), "git -C requires a path");
        assert!(plan("git gui").unwrap_err().contains("interactive GUI"));
    }

    #[test]
    fn read_only_classification() {
        let ro = |c: &str| plan(c).unwrap().read_only();
        assert!(ro("git status") && ro("git branch -a") && ro("git config user.name"));
        assert!(!ro("git branch -a -D x") && !ro("git commit -m x") && !ro("git tag -a v1"));
        assert!(ro("git worktree list") && !ro("git worktree add x"));
    }

    #[test]
    fn mutation_classification_of_a_call() {
        let m = |v: JsonValue| git_call_mutates(&v);
        assert!(!m(serde_json::json!({"command": "git status"})));
        assert!(m(serde_json::json!({"command": "git commit -m x"})));
        assert!(m(serde_json::json!({"action": "stage", "diff_id": "d"})));
        assert!(m(serde_json::json!({"command": "git status && git add ."})));
        assert!(!m(JsonValue::String("{\"command\":\"git log\"}".into())));
        assert!(m(serde_json::json!({})));
    }

    #[test]
    fn config_is_localized() {
        let p = localize_config_plan(plan("git config user.name").unwrap()).unwrap();
        assert_eq!(p.args, ["--local", "user.name"]);
        let p = localize_config_plan(plan("git config get k").unwrap()).unwrap();
        assert_eq!(p.args, ["get", "--local", "k"]);
        assert!(localize_config_plan(plan("git config --global k v").unwrap()).is_err());
    }

    #[test]
    fn chains_prefix_and_stringified_arrays() {
        assert_eq!(
            split_chained_git_commands("git add a && git commit -m 'x && y'").unwrap(),
            ["git add a", "git commit -m 'x && y'"]
        );
        assert!(split_chained_git_commands("git status").is_none());
        assert_eq!(with_git_prefix("status --short"), "git status --short");
        assert_eq!(with_git_prefix("\"git diff\""), "\"git diff\"");
        let v = parse_stringified_array(&JsonValue::String("[\"git status\",\"git log\"]".into()));
        assert_eq!(v.as_array().map(Vec::len), Some(2));
    }
}
