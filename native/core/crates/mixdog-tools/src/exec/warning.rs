//! The non-blocking destructive-command warning (`destructive-warning.mjs`), prepended to a shell
//! result as `⚠️ <warning>` lines. Hard blocks are the exec policy's job.

use std::collections::HashSet;
use std::sync::LazyLock;

use super::scan::JsRegex;
use super::scan::cs;
use super::scan::ci;
use super::scan::extract_heredoc_bodies;
use super::scan::extract_powershell_command_inner;
use super::scan::extract_shell_c_inner;
use super::scan::is_shell_name;
use super::scan::peel_wrappers;
use super::scan::split_segments;
use super::scan::strip_quoted_and_heredoc;
use super::scan::tokenize;
use crate::policy::exec::scan_targets;

fn removal_warning(recursive: bool, force: bool) -> Option<&'static str> {
    match (recursive, force) {
        (true, true) => Some("may recursively force-remove files"),
        (true, false) => Some("may recursively remove files"),
        (false, true) => Some("may force-remove files"),
        (false, false) => None,
    }
}

static SHORT_FLAGS: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^-[a-zA-Z]+$"));

fn classify_rm(args: &[String]) -> Option<&'static str> {
    let (mut r, mut f) = (false, false);
    for t in args {
        if t == "--" {
            break;
        }
        if t == "--recursive" || t == "-r" || t == "-R" {
            r = true;
        } else if t == "--force" || t == "-f" {
            f = true;
        } else if SHORT_FLAGS.is_match(&t) {
            r |= t.contains(['r', 'R']);
            f |= t.contains('f');
        } else if !t.starts_with('-') {
            break;
        }
    }
    removal_warning(r, f)
}

const PS_REMOVE_COMMANDS: [&str; 6] = ["remove-item", "ri", "del", "erase", "rd", "rmdir"];

fn classify_remove_item(args: &[String]) -> Option<&'static str> {
    static RECURSE: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^-r(?:ec(?:urse)?)?(?::\$true)?$"));
    static FORCE: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^-fo(?:rce)?(?::\$true)?$"));
    let (mut r, mut f) = (false, false);
    for t in args {
        if t == "--" {
            break;
        }
        let low = t.to_lowercase();
        if !low.starts_with('-') {
            break;
        }
        if RECURSE.is_match(&low) || low == "-recursive" {
            r = true;
        } else if FORCE.is_match(&low) {
            f = true;
        }
    }
    removal_warning(r, f)
}

fn classify_git(args: &[String]) -> Option<&'static str> {
    static OWN_VALUE: LazyLock<JsRegex> =
        LazyLock::new(|| cs(r"^--(?:git-dir|work-tree|namespace)(?:=|$)"));
    static PATHSPECS: LazyLock<JsRegex> =
        LazyLock::new(|| cs(r"^--(?:literal|glob|noglob|icase)-pathspecs$"));
    static EXEC_PATH: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^(?:--exec-path=|--list-cmds=)"));
    static PLUS_REF: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^\+[\w/.-]+"));
    static HAS_N: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^-[a-zA-Z]*n[a-zA-Z]*$"));
    static HAS_F: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^-[a-zA-Z]*f[a-zA-Z]*$"));
    let mut i = 0;
    while i < args.len() {
        let t = args[i].as_str();
        if t == "-C" || t == "-c" {
            i += 2;
        } else if OWN_VALUE.is_match(&t) {
            i += if t.contains('=') { 1 } else { 2 };
        } else if matches!(t, "--no-pager" | "--paginate" | "--bare" | "--exec-path")
            || PATHSPECS.is_match(&t)
            || EXEC_PATH.is_match(&t)
        {
            i += 1;
        } else {
            break;
        }
    }
    let sub = args.get(i)?.as_str();
    let rest = &args[i + 1..];
    let has = |flag: &str| rest.iter().any(|t| t == flag);
    match sub {
        "reset" if has("--hard") => return Some("may discard uncommitted changes"),
        "push"
            if rest.iter().any(|t| {
                t == "--force"
                    || t == "-f"
                    || t == "--force-with-lease"
                    || t.starts_with("--force-with-lease=")
                    || PLUS_REF.is_match(&t)
            }) =>
        {
            return Some("may overwrite remote history");
        }
        "clean" => {
            let dry = rest
                .iter()
                .any(|t| t == "-n" || t == "--dry-run" || HAS_N.is_match(&t));
            let force = rest
                .iter()
                .any(|t| t == "-f" || t == "--force" || HAS_F.is_match(&t));
            if !dry && force {
                return Some("may permanently delete untracked files");
            }
        }
        "checkout" | "restore" if has(".") => return Some("may discard all working tree changes"),
        "stash" if matches!(rest.first().map(String::as_str), Some("drop" | "clear")) => {
            return Some("may permanently remove stashed changes");
        }
        "branch" if has("-D") || (has("--delete") && has("--force")) => {
            return Some("may force-delete a branch");
        }
        _ => {}
    }
    if matches!(sub, "commit" | "push" | "merge") && has("--no-verify") {
        return Some("may skip safety hooks");
    }
    if sub == "commit" && has("--amend") {
        return Some("may rewrite the last commit");
    }
    None
}

const KUBECTL_VALUE_FLAGS: [&str; 19] = [
    "--context", "--cluster", "--namespace", "-n", "--user", "--kubeconfig", "--token", "--server",
    "--as", "--as-group", "--certificate-authority", "--client-certificate", "--client-key",
    "--request-timeout", "--cache-dir", "--v", "-v", "--profile", "--profile-output",
];

fn classify_kubectl(args: &[String]) -> Option<&'static str> {
    let mut i = 0;
    while i < args.len() {
        let t = args[i].as_str();
        if KUBECTL_VALUE_FLAGS.contains(&t) {
            i += 2;
        } else if t.starts_with('-') {
            i += 1;
        } else {
            break;
        }
    }
    (args.get(i).map(String::as_str) == Some("delete")).then_some("may delete Kubernetes resources")
}

fn classify_terraform(args: &[String]) -> Option<&'static str> {
    let mut i = 0;
    while i < args.len() {
        let t = args[i].as_str();
        if t.starts_with("-chdir=") || matches!(t, "-help" | "-version" | "-h") {
            i += 1;
        } else {
            break;
        }
    }
    (args.get(i).map(String::as_str) == Some("destroy")).then_some("may destroy Terraform infrastructure")
}

fn classify_dd(args: &[String]) -> Option<&'static str> {
    for t in args {
        if t.starts_with("if=/dev/") {
            return Some("may read from a raw device");
        }
        if t.starts_with("of=/dev/") {
            return Some("may write to a raw device");
        }
    }
    None
}

static DB_PATTERNS: LazyLock<[(JsRegex, &'static str); 2]> = LazyLock::new(|| {
    [
        (
            ci(r"\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b"),
            "may drop or truncate database objects",
        ),
        (
            ci(r#"\bDELETE\s+FROM\s+\w+[ \t]*(?:;|"|'|\n|$)"#),
            "may delete all rows from a database table",
        ),
    ]
});

fn classify_segment(tokens: &[String]) -> Option<&'static str> {
    let peeled = peel_wrappers(tokens);
    let (cmd, rest) = peeled.split_first()?;
    let low = cmd.to_lowercase();
    if cmd == "rm" {
        return classify_rm(rest);
    }
    if PS_REMOVE_COMMANDS.contains(&low.as_str()) {
        if let Some(warning) = classify_remove_item(rest) {
            return Some(warning);
        }
    }
    match cmd.as_str() {
        "git" => return classify_git(rest),
        "kubectl" => return classify_kubectl(rest),
        "terraform" => return classify_terraform(rest),
        "dd" => return classify_dd(rest),
        _ => {}
    }
    if cmd == "rmdir" || cmd == "rd" {
        static DRIVE_ROOT: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^[A-Za-z]:\\?$"));
        let has_s = rest.iter().any(|t| t.eq_ignore_ascii_case("/s"));
        let has_root = rest.iter().any(|t| DRIVE_ROOT.is_match(&t));
        if has_s && has_root {
            return Some("may recursively remove a drive root");
        }
    }
    None
}

/// The first warning a command earns, or `None`.
pub fn destructive_command_warning(command: &str) -> Option<&'static str> {
    let cleaned = strip_quoted_and_heredoc(command);
    for statement in cleaned.split([';', '&', '|', '\n']) {
        for (pattern, warning) in DB_PATTERNS.iter() {
            if pattern.is_match(&statement) {
                return Some(warning);
            }
        }
    }
    for segment in split_segments(&tokenize(command)) {
        let peeled = peel_wrappers(&segment);
        let Some(first) = peeled.first() else { continue };
        if is_shell_name(first) {
            for inner in extract_shell_c_inner(&segment.join(" ")) {
                if let Some(w) = destructive_command_warning(&inner) {
                    return Some(w);
                }
            }
            for body in extract_heredoc_bodies(command) {
                if let Some(w) = destructive_command_warning(&body) {
                    return Some(w);
                }
            }
            continue;
        }
        if let Some(w) = classify_segment(&segment) {
            return Some(w);
        }
    }
    for inner in extract_shell_c_inner(command)
        .into_iter()
        .chain(extract_powershell_command_inner(command))
    {
        if let Some(w) = destructive_command_warning(&inner) {
            return Some(w);
        }
    }
    None
}

/// Every distinct warning over the command's scan targets (`getDedupedDestructiveWarnings`).
pub fn deduped_warnings(command: &str) -> Vec<&'static str> {
    let mut seen = HashSet::new();
    scan_targets(command)
        .iter()
        .filter_map(|target| destructive_command_warning(target))
        .filter(|warning| seen.insert(*warning))
        .collect()
}

fn warning_block(command: &str) -> String {
    deduped_warnings(command)
        .iter()
        .map(|w| format!("⚠️ {w}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn prepend_warning(command: &str, text: String) -> String {
    let block = warning_block(command);
    if block.is_empty() {
        text
    } else {
        format!("{block}\n{text}")
    }
}

/// The warnings go on the line after the status line.
pub fn place_warnings_after_status(command: &str, text: String) -> String {
    let block = warning_block(command);
    if block.is_empty() {
        return text;
    }
    match text.find('\n') {
        None => format!("{text}\n{block}"),
        Some(at) => format!("{}\n{block}{}", &text[..at], &text[at..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cases are Node's own (`destructive-warning.test.mjs`).
    #[test]
    fn a_hash_inside_a_word_is_not_a_comment() {
        for command in ["a#b; rm -rf /", "echo http://x/#y && rm -rf ~", "echo $#; rm -rf /", "echo ${#v}; rm -rf /"] {
            assert_eq!(destructive_command_warning(command), Some("may recursively force-remove files"), "{command}");
        }
        assert_eq!(
            destructive_command_warning("a#b; DROP TABLE t"),
            Some("may drop or truncate database objects")
        );
    }

    #[test]
    fn a_real_comment_hides_its_text() {
        for command in [
            "echo hi # rm -rf /",
            "echo hi # a; rm -rf /",
            "echo hi;# rm -rf /",
            "echo it's # rm -rf /",
            "echo hi <# rm -rf / #>",
            "echo hi # DROP TABLE t",
        ] {
            assert_eq!(destructive_command_warning(command), None, "{command}");
        }
        assert_eq!(
            destructive_command_warning("echo x # c\nrm -rf /"),
            Some("may recursively force-remove files")
        );
        assert_eq!(
            destructive_command_warning("echo hi <# c #>; rm -rf ~"),
            Some("may recursively force-remove files")
        );
    }

    #[test]
    fn text_after_a_heredoc_opener_and_stray_quotes_stay_visible() {
        assert_eq!(
            destructive_command_warning("cat <<EOF | rm -rf /\nx\nEOF"),
            Some("may recursively force-remove files")
        );
        assert_eq!(
            destructive_command_warning("echo it's; rm -rf /"),
            Some("may recursively force-remove files")
        );
    }

    #[test]
    fn git_pathspec_options_are_skipped_only_as_whole_tokens() {
        for option in ["--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"] {
            assert_eq!(
                destructive_command_warning(&format!("git {option} reset --hard")),
                Some("may discard uncommitted changes"),
                "{option}"
            );
        }
        for token in ["--literal-pathspecs-x", "x--glob-pathspecs", "x--noglob-pathspecs-y", "x--icase-pathspecs"] {
            assert_eq!(destructive_command_warning(&format!("git {token} reset --hard")), None, "{token}");
        }
    }

    #[test]
    fn the_warning_goes_after_the_status_line_or_in_front() {
        assert_eq!(
            deduped_warnings("echo $(sudo env rm -rf build)"),
            vec!["may recursively force-remove files"]
        );
        assert_eq!(
            destructive_command_warning("kubectl --context x delete pod a"),
            Some("may delete Kubernetes resources")
        );
        assert_eq!(
            place_warnings_after_status("git reset --hard", "[exit code: 0]\n\nok\n".into()),
            "[exit code: 0]\n⚠️ may discard uncommitted changes\n\nok\n"
        );
        assert_eq!(
            prepend_warning("terraform destroy", "out".into()),
            "⚠️ may destroy Terraform infrastructure\nout"
        );
        assert_eq!(prepend_warning("echo hi", "out".into()), "out");
    }
}
