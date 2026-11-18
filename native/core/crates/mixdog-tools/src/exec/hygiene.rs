//! The PowerShell hygiene preflight (`shell-analysis.mjs` `preflightPowerShellHygiene`), run
//! before a command reaches a PowerShell host: (1) a lossless rewrite of MSYS-style `/x/…` drive
//! paths to `X:\…`; (2) a block, with a PowerShell-native hint, for invalid PowerShell syntax —
//! `$PID` reassignment and `&&` on Windows PowerShell 5.1. POSIX shells are a strict no-op.

use std::sync::LazyLock;

use mixdog_js::JsRegex;

use super::bashism::code_mask;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

/// Every character that lives inside a quoted string, here-string or comment replaced by NUL,
/// 1:1, so match offsets stay aligned. The full tokenizer first; when it declines, a bare
/// quote-pair scan.
pub fn mask_quoted_regions(command: &str) -> String {
    let chars: Vec<char> = command.chars().collect();
    if let Some(mask) = code_mask(&chars) {
        return chars.iter().zip(mask).map(|(c, live)| if live { *c } else { '\0' }).collect();
    }
    let (mut out, mut quote, mut escaped) = (String::new(), None::<char>, false);
    for ch in chars {
        if escaped {
            out.push('\0');
            escaped = false;
        } else if let Some(q) = quote {
            if q == '"' && ch == '`' {
                out.push('\0');
                escaped = true;
            } else if ch == q {
                out.push(ch);
                quote = None;
            } else {
                out.push('\0');
            }
        } else {
            if ch == '\'' || ch == '"' {
                quote = Some(ch);
            }
            out.push(ch);
        }
    }
    out
}

/// `rewriteMsysDrivePaths`; the second value says whether anything changed.
fn rewrite_msys_drive_paths(src: &str) -> (String, bool) {
    let mask = mask_quoted_regions(src);
    let re = lazy_re!(r#"(^|[\s"'=,(])/([A-Za-z])/([^\s"'`|&;<>()]*)"#, "g");
    let src_chars: Vec<char> = src.chars().collect();
    let (mut out, mut last, mut changed) = (String::new(), 0usize, false);
    for m in re.captures_iter(&mask) {
        let whole = m.range();
        let (start, end) = (mask[..whole.start].chars().count(), mask[..whole.end].chars().count());
        out.extend(&src_chars[last..start]);
        let (pre, drive, rest) = (m.get(1).unwrap_or(""), m.get(2).unwrap_or(""), m.get(3).unwrap_or(""));
        out.push_str(&format!("{pre}{}:\\{}", drive.to_uppercase(), rest.replace('/', "\\")));
        last = end;
        changed = true;
    }
    out.extend(&src_chars[last..]);
    if changed { (out, true) } else { (src.to_owned(), false) }
}

/// `(command to run, block message)`. `shell_is_powershell`: the resolved shell's type;
/// `shell_name`: its program name (`powershell.exe`, `pwsh`), which tells Windows PowerShell 5.1
/// (no `&&`) from PowerShell 7.
pub fn preflight_powershell_hygiene(
    command: &str,
    shell_is_powershell: bool,
    shell_name: &str,
) -> (String, Option<String>) {
    if !shell_is_powershell || mixdog_js::js_trim(command).is_empty() {
        return (command.to_owned(), None);
    }
    let (rewritten, _) = rewrite_msys_drive_paths(command);
    let name = shell_name.to_lowercase();
    let legacy = name.contains("powershell") && !name.contains("pwsh");
    // Judged on a quote-masked copy so quoted literals are never mistaken for real syntax.
    let masked = mask_quoted_regions(&rewritten);
    let mut violations: Vec<&str> = Vec::new();
    if lazy_re!(r"\$PID\s*=(?!=)", "i").is_match(&masked) {
        violations.push("`$PID` is a reserved PowerShell automatic variable — do not reassign it (use a different name).");
    }
    if legacy && lazy_re!(r"(?:^|[^&])&&(?:[^&]|$)", "").is_match(&masked) {
        violations.push("`&&` is not supported in Windows PowerShell 5.1 — use `;` to sequence or issue separate calls.");
    }
    if violations.is_empty() {
        return (rewritten, None);
    }
    let block = format!(
        "PowerShell preflight blocked this command (invalid PowerShell syntax). Fix and retry:\n- {}",
        violations.join("\n- ")
    );
    (rewritten, Some(block))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "PowerShell preflight blocked this command (invalid PowerShell syntax). Fix and retry:\n";
    const PID_RULE: &str = "- `$PID` is a reserved PowerShell automatic variable — do not reassign it (use a different name).";
    const AND_RULE: &str = "- `&&` is not supported in Windows PowerShell 5.1 — use `;` to sequence or issue separate calls.";

    fn preflight(command: &str, name: &str) -> (String, Option<String>) {
        preflight_powershell_hygiene(command, true, name)
    }

    #[test]
    fn a_unix_style_drive_path_is_written_as_a_windows_path_outside_quotes_comments_and_here_strings() {
        for name in ["powershell.exe", "pwsh.exe"] {
            for (command, want) in [
                ("ls /c/Users/x/file.txt", "ls C:\\Users\\x\\file.txt"),
                ("Get-Content /c/a/b/c.txt; Get-Content /d/x", "Get-Content C:\\a\\b\\c.txt; Get-Content D:\\x"),
                ("ls (/c/a)", "ls (C:\\a)"),
                ("rm /c/Users/x/a b", "rm C:\\Users\\x\\a b"),
                ("# /c/comment\nls /c/real", "# /c/comment\nls C:\\real"),
                ("echo \"/c/Users/x\"", "echo \"/c/Users/x\""),
                ("echo '/c/Users/x'", "echo '/c/Users/x'"),
                ("@'\n/c/not/rewritten\n'@", "@'\n/c/not/rewritten\n'@"),
                ("ls /cc/not-a-drive", "ls /cc/not-a-drive"),
                ("   ", "   "),
            ] {
                assert_eq!(preflight(command, name), (want.to_owned(), None), "{command:?} {name}");
            }
        }
    }

    #[test]
    fn reassigning_the_reserved_pid_variable_is_blocked_but_reading_or_quoting_it_is_not() {
        for command in ["$PID = 5", "$pid=1"] {
            assert_eq!(preflight(command, "pwsh.exe"), (command.to_owned(), Some(format!("{HEAD}{PID_RULE}"))), "{command}");
        }
        for command in ["$PID == 3", "Write-Output '$PID=1'", "echo \"$PID=1\""] {
            assert_eq!(preflight(command, "pwsh.exe").1, None, "{command}");
        }
    }

    #[test]
    fn a_chained_and_is_blocked_only_for_windows_powershell_5() {
        for command in ["a && b", "a && b && c", "a &&", "&& a"] {
            assert_eq!(preflight(command, "powershell.exe").1, Some(format!("{HEAD}{AND_RULE}")), "{command}");
            assert_eq!(preflight(command, "pwsh.exe").1, None, "{command}");
        }
        for command in ["echo \"a && b\"", "a & b"] {
            assert_eq!(preflight(command, "powershell.exe").1, None, "{command}");
        }
        // A rewritten path is still reported with the rule it broke, and every broken rule is listed.
        assert_eq!(preflight("cd /d/work && ls", "powershell.exe"), ("cd D:\\work && ls".to_owned(), Some(format!("{HEAD}{AND_RULE}"))));
        assert_eq!(preflight("$PID = 1; a && b", "powershell.exe").1, Some(format!("{HEAD}{PID_RULE}\n{AND_RULE}")));
        assert_eq!(preflight("$PID = 1; a && b", "pwsh.exe").1, Some(format!("{HEAD}{PID_RULE}")));
    }
}


