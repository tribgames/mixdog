//! Lossless folds of captured terminal output (`shell-lossless-compact.mjs`
//! `foldCarriageReturnFrames`, `foldConsecutiveDuplicateLines`), shared by the `shell` and
//! `terminal` tools.

/// A line redrawn with `\r` shows only its last non-empty frame; `None` when nothing is folded.
pub fn fold_carriage_return_frames(value: &str) -> Option<String> {
    let has_bare_cr = value
        .char_indices()
        .any(|(i, c)| c == '\r' && value[i + 1..].chars().next() != Some('\n'));
    if !has_bare_cr {
        return None;
    }
    let normalized = value.replace("\r\n", "\n");
    let mut omitted = 0usize;
    let out: Vec<String> = normalized
        .split('\n')
        .map(|line| {
            let frames: Vec<&str> = line.split('\r').collect();
            if frames.len() == 1 {
                return line.to_owned();
            }
            omitted += frames.len() - 1;
            frames
                .iter()
                .rev()
                .find(|f| !f.is_empty())
                .copied()
                .unwrap_or_default()
                .to_owned()
        })
        .collect();
    (omitted > 0).then(|| {
        format!("{}\n... [{omitted} overwritten progress frames omitted]", out.join("\n"))
    })
}

/// Runs of three or more identical non-empty lines collapse to the line and a repeat count, for
/// output of at least 20 lines; `None` when nothing is folded.
pub fn fold_consecutive_duplicate_lines(value: &str) -> Option<String> {
    let trailing = value.ends_with('\n');
    let mut lines: Vec<&str> = value
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    if trailing {
        lines.pop();
    }
    if lines.len() < 20 {
        return None;
    }
    let mut out = Vec::new();
    let mut folded = 0usize;
    let mut i = 0;
    while i < lines.len() {
        let mut end = i + 1;
        while end < lines.len() && lines[end] == lines[i] {
            end += 1;
        }
        let count = end - i;
        out.push(lines[i].to_owned());
        if count >= 3 && !lines[i].is_empty() {
            out.push(format!("... [previous line repeated {} more times]", count - 1));
            folded += count - 2;
        } else {
            out.extend(std::iter::repeat_n(lines[i].to_owned(), count - 1));
        }
        i = end;
    }
    (folded > 0).then(|| format!("{}{}", out.join("\n"), if trailing { "\n" } else { "" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redrawn_lines_keep_their_last_frame() {
        assert_eq!(fold_carriage_return_frames("plain\n"), None);
        assert_eq!(
            fold_carriage_return_frames("a\r\nb\n10%\r50%\r100%\ndone").as_deref(),
            Some("a\nb\n100%\ndone\n... [2 overwritten progress frames omitted]")
        );
    }

    #[test]
    fn long_runs_of_identical_lines_collapse() {
        let mut text = String::new();
        for _ in 0..25 {
            text.push_str("tick\n");
        }
        text.push_str("end\n");
        assert_eq!(
            fold_consecutive_duplicate_lines(&text).as_deref(),
            Some("tick\n... [previous line repeated 24 more times]\nend\n")
        );
        assert_eq!(fold_consecutive_duplicate_lines("a\na\na\n"), None);
    }
}
