//! `runtime/shared/skill-mentions.mjs`: inline `$name` skill mentions. A skill can be named anywhere in a prompt.
//!
//! A candidate is `$` at the start of the text or after white space or an opening bracket or quote, followed by a
//! skill-name token (lowercase letters, digits and hyphens, 64 characters at most). It selects a skill only when the token
//! is exactly a known skill name, so `$HOME`, `$300` and unknown names stay prose. The token ends where no ASCII
//! identifier character follows (`$pptx_env` and `$pptxUPPER` are not `pptx`); any other character, Korean particles
//! included (`$pptx로`), ends it.
//!
//! Offsets are UTF-16 code units of the original text, as in Node, so a surface that highlights the text lines up (and
//! never lands inside code).

use mixdog_js::is_js_space;

/// Common environment-variable names (compared case-insensitively) and numeric-only tokens are never inline mentions, even
/// when a skill has that name: `$path` or `$300` in prose means the variable or the amount. Choosing such a skill
/// explicitly (the `Skill:` header chip) still works.
const RESERVED_NAMES: [&str; 18] = [
    "path",
    "home",
    "user",
    "shell",
    "pwd",
    "tmpdir",
    "temp",
    "tmp",
    "lang",
    "term",
    "xdg_config_home",
    "userprofile",
    "appdata",
    "localappdata",
    "programfiles",
    "systemroot",
    "windir",
    "comspec",
];

/// `isReservedMentionName(name)`: true when `name` can never be an inline mention (an environment variable or a number).
pub fn is_reserved_mention_name(name: &str) -> bool {
    (!name.is_empty() && name.bytes().all(|b| b.is_ascii_digit())) || RESERVED_NAMES.contains(&mixdog_js::js_to_lowercase(name).as_str())
}

/// A `$name` mention: `start` is the `$`, `end` is after the name (UTF-16 offsets).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillMention {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

const TAB: u16 = 9;
const NEWLINE: u16 = 10;
const CARRIAGE_RETURN: u16 = 13;
const SPACE: u16 = 32;
const BACKTICK: u16 = 96;
const TILDE: u16 = 126;
const DOLLAR: u16 = 36;

fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

/// `[\s([{"'`]`: what may stand before a `$`.
fn is_mention_prefix(unit: u16) -> bool {
    is_space(unit) || [b'(', b'[', b'{', b'"', b'\'', b'`'].iter().any(|b| u16::from(*b) == unit)
}

fn is_name_start(unit: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&unit) || (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

fn is_name_part(unit: u16) -> bool {
    is_name_start(unit) || unit == u16::from(b'-')
}

/// `[A-Za-z0-9_-]`: a character that keeps a token going.
fn is_identifier_unit(unit: u16) -> bool {
    is_name_part(unit) || (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) || unit == u16::from(b'_')
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 10 | 13 | 0x2028 | 0x2029)
}

/// `FENCE_OPEN`/`FENCE_CLOSE` on a line: up to three spaces, then a run of three or more backticks or tildes. Returns the
/// fence character, the run length and the text after the run.
fn fence_run(line: &[u16]) -> Option<(u16, usize, &[u16])> {
    let indent = line.iter().take_while(|unit| **unit == SPACE).count();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let first = *rest.first()?;
    if first != BACKTICK && first != TILDE {
        return None;
    }
    let length = rest.iter().take_while(|unit| **unit == first).count();
    (length >= 3).then(|| (first, length, &rest[length..]))
}

/// Inline code spans of `source[from..to]`: a backtick run closed by the next run of exactly the same length; an unmatched
/// run is literal.
fn inline_code_ranges(source: &[u16], from: usize, to: usize, ranges: &mut Vec<(usize, usize)>) {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut at = from;
    while at < to.min(source.len()) {
        if source[at] != BACKTICK {
            at += 1;
            continue;
        }
        let mut end = at;
        while end < source.len() && source[end] == BACKTICK {
            end += 1;
        }
        runs.push((at, end.min(to)));
        at = end;
    }
    let mut index = 0;
    while index < runs.len() {
        let length = runs[index].1 - runs[index].0;
        if let Some(close) = (index + 1..runs.len()).find(|&at| runs[at].1 - runs[at].0 == length) {
            ranges.push((runs[index].0, runs[close].1));
            index = close;
        }
        index += 1;
    }
}

/// `[start, end)` offsets of Markdown code: fenced blocks (``` or ~~~, three or more, an optional info string, closed by a
/// fence of the same character at least as long, else running to the end) and inline code spans.
///
/// Deliberate difference from Codex, which scans raw bytes with no code handling.
fn code_ranges(source: &[u16]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    // The open fence: its character, its length and where it starts.
    let mut open: Option<(u16, usize, usize)> = None;
    let mut prose_start = 0;
    let mut at = 0;
    while at <= source.len() {
        let newline = source[at.min(source.len())..].iter().position(|unit| *unit == NEWLINE).map(|offset| at + offset);
        let end = newline.unwrap_or(source.len());
        let next = newline.map_or(source.len() + 1, |newline| newline + 1);
        let mut line = &source[at.min(source.len())..end];
        if line.last() == Some(&CARRIAGE_RETURN) {
            line = &line[..line.len() - 1];
        }
        match open {
            None => {
                if let Some((fence, length, rest)) = fence_run(line)
                    && !(fence == BACKTICK && rest.contains(&BACKTICK))
                    && !rest.iter().any(|unit| is_line_terminator(*unit))
                {
                    inline_code_ranges(source, prose_start, at, &mut ranges);
                    open = Some((fence, length, at));
                }
            }
            Some((char_, length, start)) => {
                if let Some((fence, run, rest)) = fence_run(line)
                    && fence == char_
                    && run >= length
                    && rest.iter().all(|unit| *unit == SPACE || *unit == TAB)
                {
                    ranges.push((start, next.min(source.len())));
                    prose_start = next.min(source.len());
                    open = None;
                }
            }
        }
        at = next;
    }
    match open {
        Some((_, _, start)) => ranges.push((start, source.len())),
        None => inline_code_ranges(source, prose_start, source.len(), &mut ranges),
    }
    ranges
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn has_code_marks(source: &[u16]) -> bool {
    source.contains(&BACKTICK) || source.windows(3).any(|w| w.iter().all(|unit| *unit == TILDE))
}

/// `isInMarkdownCode(text, offset)`: true when `offset` in `text` lies inside Markdown code (a fenced block or an inline
/// code span) by the rules mention recognition uses, so a composer can tell whether a `$` being typed can become a mention.
pub fn is_in_markdown_code(text: &str, offset: i64) -> bool {
    let source = units(text);
    if offset < 0 || !has_code_marks(&source) {
        return false;
    }
    let offset = offset as usize;
    code_ranges(&source).iter().any(|&(from, to)| offset >= from && offset < to)
}

/// `skillMentionCandidates(text)`: every syntactically valid `$name` in `text` outside Markdown code, in order.
pub fn skill_mention_candidates(text: &str) -> Vec<SkillMention> {
    let source = units(text);
    let code = if has_code_marks(&source) { code_ranges(&source) } else { Vec::new() };
    let mut found = Vec::new();
    let mut at = 0;
    while at < source.len() {
        // The `$` this search position can match: at the start of the text with no prefix, else after a prefix character.
        let dollar = if at == 0 && source[0] == DOLLAR {
            Some(0)
        } else if is_mention_prefix(source[at]) && source.get(at + 1) == Some(&DOLLAR) {
            Some(at + 1)
        } else {
            None
        };
        let Some(dollar) = dollar else {
            at += 1;
            continue;
        };
        let name_start = dollar + 1;
        if !source.get(name_start).is_some_and(|unit| is_name_start(*unit)) {
            at += 1;
            continue;
        }
        let mut name_end = name_start + 1;
        while name_end < source.len() && name_end - name_start < 64 && is_name_part(source[name_end]) {
            name_end += 1;
        }
        // A greedy name that a character of the token follows cannot end earlier: the shorter ends are followed by name
        // characters too.
        if source.get(name_end).is_some_and(|unit| is_identifier_unit(*unit)) {
            at += 1;
            continue;
        }
        let name = String::from_utf16_lossy(&source[name_start..name_end]);
        at = name_end;
        if is_reserved_mention_name(&name) || code.iter().any(|&(from, to)| dollar >= from && dollar < to) {
            continue;
        }
        found.push(SkillMention { name, start: dollar, end: name_end });
    }
    found
}

/// `skillMentions(text, isSkill)`: the candidates whose name `is_skill` accepts (all occurrences, in order).
pub fn skill_mentions(text: &str, is_skill: impl Fn(&str) -> bool) -> Vec<SkillMention> {
    skill_mention_candidates(text).into_iter().filter(|mention| is_skill(&mention.name)).collect()
}

/// `mentionedSkillNames(text, isSkill)`: the distinct mentioned skill names in first-mention order.
pub fn mentioned_skill_names(text: &str, is_skill: impl Fn(&str) -> bool) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for mention in skill_mentions(text, is_skill) {
        if !names.contains(&mention.name) {
            names.push(mention.name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(text: &str) -> Vec<String> {
        skill_mention_candidates(text).into_iter().map(|mention| mention.name).collect()
    }

    #[test]
    fn a_mention_follows_the_start_whitespace_or_an_opening_mark() {
        assert_eq!(names("$pptx now"), ["pptx"]);
        assert_eq!(names("use $pptx and $docx-fill"), ["pptx", "docx-fill"]);
        assert_eq!(names("(see $a1) [$b2] {$c3} \"$d4\" '$e5'"), ["a1", "b2", "c3", "d4", "e5"]);
        assert_eq!(names("a$pptx"), Vec::<String>::new());
        assert_eq!(names("x\n$pptx"), ["pptx"]);
    }

    #[test]
    fn the_token_ends_where_no_identifier_character_follows() {
        assert_eq!(names("$pptx_env"), Vec::<String>::new());
        assert_eq!(names("$pptxUPPER"), Vec::<String>::new());
        assert_eq!(names("$pptx."), ["pptx"]);
        assert_eq!(names("$pptx\u{b85c}"), ["pptx"]);
        let long = format!("${}", "a".repeat(65));
        assert_eq!(names(&long), Vec::<String>::new());
        let longest = format!("${}", "a".repeat(64));
        assert_eq!(names(&longest), ["a".repeat(64)]);
    }

    #[test]
    fn environment_variables_and_numbers_are_prose() {
        assert_eq!(names("$HOME $path $300 $tmp"), Vec::<String>::new());
        assert!(is_reserved_mention_name("PATH"));
        assert!(is_reserved_mention_name("0042"));
        assert!(!is_reserved_mention_name("pptx"));
        assert!(!is_reserved_mention_name(""));
    }

    #[test]
    fn offsets_are_utf16_units_of_the_original_text() {
        let mentions = skill_mention_candidates("\u{1f600} $abc");
        assert_eq!(mentions, [SkillMention { name: "abc".to_owned(), start: 3, end: 7 }]);
        assert_eq!(skill_mention_candidates("$ab"), [SkillMention { name: "ab".to_owned(), start: 0, end: 3 }]);
    }

    #[test]
    fn markdown_code_is_never_a_mention() {
        assert_eq!(names("`$pptx` and $docx"), ["docx"]);
        assert_eq!(names("``a $b ` c`` $d"), ["d"]);
        assert_eq!(names("```\n$fenced\n```\n$after"), ["after"]);
        assert_eq!(names("~~~sh\n$tilde\n~~~\n$next"), ["next"]);
        assert_eq!(names("```\n$unclosed"), Vec::<String>::new());
        assert_eq!(names("`unmatched $x"), ["x"]);
        assert_eq!(names("````\n```\n$inner\n```\n````\n$out"), ["out"]);
    }

    #[test]
    fn markdown_code_positions_are_reported() {
        let text = "a `b` c\n```\nx\n```\nd";
        assert!(is_in_markdown_code(text, 3));
        assert!(!is_in_markdown_code(text, 0));
        assert!(is_in_markdown_code(text, 10));
        assert!(!is_in_markdown_code(text, 19));
        assert!(!is_in_markdown_code("plain", 2));
        assert!(!is_in_markdown_code(text, -1));
    }

    #[test]
    fn only_known_skills_are_selected() {
        let known = |name: &str| name == "pptx" || name == "docx";
        assert_eq!(mentioned_skill_names("$pptx $nope $docx $pptx", known), ["pptx", "docx"]);
        assert_eq!(skill_mentions("$pptx $nope $pptx", known).len(), 2);
        assert!(mentioned_skill_names("nothing", known).is_empty());
    }
}
