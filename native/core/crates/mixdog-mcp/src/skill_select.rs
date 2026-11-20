//! Which skills a user prompt explicitly selects (`shared/skill-selection.mjs`,
//! `shared/skill-mentions.mjs`, `explicitSkillNames`): the leading `Skill: "name"` header, then
//! every inline `$name` outside Markdown code, each only when it names a skill that is enabled
//! and in scope. Offsets are UTF-16 units, as the desktop composer highlights them.

use std::collections::HashSet;

/// At most this many skills are prepared for one user turn; further selections stay prose.
pub const MAX_EXPLICIT_SKILLS: usize = 5;

/// One element of a prompt array.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PromptPart {
    /// A bare string.
    Str(String),
    /// `{type: "text", text, attachmentRef}`: `text` is `None` when it is not a string.
    Text { text: Option<String>, attachment_ref: Option<String> },
    /// Any other part (an image, a document, `null`).
    Other,
}

/// A prompt as the loop holds it: a string or a list of parts.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Prompt {
    Text(String),
    Parts(Vec<PromptPart>),
}

/// `isAttachmentReference`: `/^[a-f0-9]{64}$/` over the reference.
fn is_attachment_reference(part_ref: Option<&str>) -> bool {
    part_ref.is_some_and(|r| r.len() == 64 && r.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// `userPromptText`: the user's own typed text, never attachment references.
fn user_prompt_text(prompt: &Prompt) -> String {
    match prompt {
        Prompt::Text(text) => text.clone(),
        Prompt::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                PromptPart::Str(text) => text.as_str(),
                PromptPart::Text { text: Some(text), attachment_ref } if !is_attachment_reference(attachment_ref.as_deref()) => text.as_str(),
                _ => "",
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// `selectedSkillName`: the name in the complete leading `Skill: "name"` header of the first part.
pub fn selected_skill_name(prompt: &Prompt) -> Option<String> {
    let text = match prompt {
        Prompt::Text(text) => text.as_str(),
        Prompt::Parts(parts) => match parts.first() {
            Some(PromptPart::Str(text)) => text.as_str(),
            Some(PromptPart::Text { text: Some(text), .. }) => text.as_str(),
            _ => "",
        },
    };
    let rest = text.strip_prefix("Skill: \"")?;
    // `("(?:[^"\\\r\n]|\\.)*")`: an escape takes any character but a line terminator.
    let mut end = None;
    let mut chars = rest.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => {
                end = Some(at);
                break;
            }
            '\\' => match chars.next() {
                Some((_, e)) if !is_line_terminator(e) => {}
                _ => return None,
            },
            '\r' | '\n' => return None,
            _ => {}
        }
    }
    let end = end?;
    let after = &rest[end + 1..];
    let after = after.strip_prefix('\r').unwrap_or(after).strip_prefix('\n')?;
    after.strip_prefix('\r').unwrap_or(after).strip_prefix('\n')?;
    let quoted = &text["Skill: ".len()..="Skill: \"".len() + end];
    let name: String = serde_json::from_str(quoted).ok()?;
    let name = mixdog_js::js_trim(&name);
    (!name.is_empty()).then(|| name.to_owned())
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

const RESERVED_NAMES: [&str; 18] = [
    "path", "home", "user", "shell", "pwd", "tmpdir", "temp", "tmp", "lang", "term", "xdg_config_home", "userprofile", "appdata", "localappdata",
    "programfiles", "systemroot", "windir", "comspec",
];

/// `isReservedMentionName`: an environment-variable name or a number is never an inline mention.
fn is_reserved(name: &str) -> bool {
    name.bytes().all(|b| b.is_ascii_digit()) || RESERVED_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

/// A `$name` in a text; `start` is the `$`, `end` is past the name.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Mention {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

const BACKTICK: u16 = b'`' as u16;
const TILDE: u16 = b'~' as u16;
const SPACE: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const NEWLINE: u16 = b'\n' as u16;
const RETURN: u16 = b'\r' as u16;

/// `inlineCodeRanges`: a backtick run closed by the next run of exactly the same length.
fn inline_code_ranges(source: &[u16], from: usize, to: usize, ranges: &mut Vec<(usize, usize)>) {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut at = from;
    while at < source.len() {
        let Some(offset) = source[at..].iter().position(|&u| u == BACKTICK) else { break };
        let start = at + offset;
        if start >= to {
            break;
        }
        let length = source[start..].iter().take_while(|&&u| u == BACKTICK).count();
        runs.push((start, to.min(start + length)));
        at = start + length;
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

/// The fence a line opens or closes: its character, its length and the text after the run.
fn fence_of(line: &[u16]) -> Option<(u16, usize, &[u16])> {
    let spaces = line.iter().take_while(|&&u| u == SPACE).count();
    if spaces > 3 {
        return None;
    }
    let first = *line.get(spaces)?;
    if first != BACKTICK && first != TILDE {
        return None;
    }
    let length = line[spaces..].iter().take_while(|&&u| u == first).count();
    (length >= 3).then(|| (first, length, &line[spaces + length..]))
}

/// `codeRanges`: [start, end) offsets of Markdown code, fenced blocks and inline spans.
fn code_ranges(source: &[u16]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut open: Option<(u16, usize, usize)> = None;
    let mut prose_start = 0;
    let mut at = 0;
    while at <= source.len() {
        let newline = source[at.min(source.len())..].iter().position(|&u| u == NEWLINE).map(|p| p + at);
        let end = newline.unwrap_or(source.len());
        let next = newline.map_or(source.len() + 1, |n| n + 1);
        let mut line = &source[at.min(source.len())..end];
        if line.last() == Some(&RETURN) {
            line = &line[..line.len() - 1];
        }
        match open {
            None => {
                if let Some((char, length, rest)) = fence_of(line)
                    && !rest.iter().any(|&u| matches!(u, 0x0d | 0x2028 | 0x2029))
                    && !(char == BACKTICK && rest.contains(&BACKTICK))
                {
                    inline_code_ranges(source, prose_start, at, &mut ranges);
                    open = Some((char, length, at));
                }
            }
            Some((char, length, start)) => {
                if let Some((fence_char, fence_length, rest)) = fence_of(line)
                    && rest.iter().all(|&u| u == SPACE || u == TAB)
                    && fence_char == char
                    && fence_length >= length
                {
                    let stop = next.min(source.len());
                    ranges.push((start, stop));
                    prose_start = stop;
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

fn is_boundary(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(mixdog_js::is_js_space) || matches!(unit, 0x28 | 0x5b | 0x7b | 0x22 | 0x27 | 0x60)
}

fn is_name_start(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x61..=0x7a)
}

fn is_name_rest(unit: u16) -> bool {
    is_name_start(unit) || unit == u16::from(b'-')
}

/// `skillMentionCandidates`: every syntactically valid `$name` outside Markdown code, in order.
pub fn skill_mention_candidates(text: &str) -> Vec<Mention> {
    let source: Vec<u16> = text.encode_utf16().collect();
    let dollar = u16::from(b'$');
    let mut found = Vec::new();
    let mut code: Option<Vec<(usize, usize)>> = None;
    let mut search = 0;
    while search < source.len() {
        // The match starts at `^` (no boundary character) or at a boundary character.
        let mut matched = None;
        for from in search..source.len() {
            let start = if from == 0 && source[0] == dollar {
                0
            } else if is_boundary(source[from]) && source.get(from + 1) == Some(&dollar) {
                from + 1
            } else {
                continue;
            };
            let name_from = start + 1;
            if !source.get(name_from).copied().is_some_and(is_name_start) {
                continue;
            }
            let length = 1 + source[name_from + 1..].iter().take(63).take_while(|&&u| is_name_rest(u)).count();
            let name_end = name_from + length;
            let blocked = source.get(name_end).is_some_and(|&u| is_name_rest(u) || u == u16::from(b'_') || matches!(u, 0x41..=0x5a));
            if blocked {
                continue;
            }
            matched = Some((start, name_from, name_end));
            break;
        }
        let Some((start, name_from, name_end)) = matched else { break };
        search = name_end;
        let name = String::from_utf16_lossy(&source[name_from..name_end]);
        if is_reserved(&name) {
            continue;
        }
        if code.is_none() {
            code = Some(if source.contains(&BACKTICK) || source.windows(3).any(|w| w.iter().all(|&u| u == TILDE)) { code_ranges(&source) } else { Vec::new() });
        }
        if code.as_ref().is_some_and(|ranges| ranges.iter().any(|&(from, to)| start >= from && start < to)) {
            continue;
        }
        found.push(Mention { name, start, end: name_end });
    }
    found
}

/// What a prompt asks for before the catalog is consulted.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Selection {
    pub header: Option<String>,
    /// Every candidate `$name`, in order.
    pub mentions: Vec<String>,
}

impl Selection {
    pub fn is_empty(&self) -> bool {
        self.header.is_none() && self.mentions.is_empty()
    }

    /// `explicitSkillNames` past its early return: the header and the distinct mentions that name
    /// an available skill, in first-mention order, capped.
    pub fn resolve(&self, available: &HashSet<String>) -> Vec<String> {
        let mut names: Vec<String> = self.header.iter().filter(|h| available.contains(*h)).cloned().collect();
        for name in &self.mentions {
            if available.contains(name) && !names.contains(name) {
                names.push(name.clone());
            }
        }
        names.truncate(MAX_EXPLICIT_SKILLS);
        names
    }
}

/// The header and the candidate mentions of a prompt.
pub fn selection_of(prompt: &Prompt) -> Selection {
    Selection {
        header: selected_skill_name(prompt),
        mentions: skill_mention_candidates(&user_prompt_text(prompt)).into_iter().map(|m| m.name).collect(),
    }
}

/// The skills enabled and in scope for a directory (`collectPromptSkillsCached(cwd)`).
#[async_trait::async_trait]
pub trait SkillNames: Send + Sync {
    async fn names(&self, cwd: &std::path::Path) -> Result<HashSet<String>, String>;
}

#[async_trait::async_trait]
impl SkillNames for crate::skill_catalog::SkillCatalog {
    async fn names(&self, cwd: &std::path::Path) -> Result<HashSet<String>, String> {
        let visible = self.visible(cwd).await.map_err(|e| e.to_string())?;
        Ok(visible.into_iter().map(|skill| skill.name).collect())
    }
}

/// `explicitSkillNames` for the skills `available` to the session's directory.
pub fn explicit_skill_names(prompt: &Prompt, available: &HashSet<String>) -> Vec<String> {
    selection_of(prompt).resolve(available)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(prompt: &str) -> Prompt {
        Prompt::Text(prompt.to_owned())
    }

    fn names(prompt: &Prompt, available: &[&str]) -> Vec<String> {
        explicit_skill_names(prompt, &available.iter().map(|n| (*n).to_owned()).collect())
    }

    fn mentions(prompt: &str) -> Vec<(String, usize, usize)> {
        skill_mention_candidates(prompt).into_iter().map(|m| (m.name, m.start, m.end)).collect()
    }

    #[test]
    fn a_leading_skill_header_names_the_skill() {
        assert_eq!(selected_skill_name(&text("Skill: \"review\"\n\nplease")), Some("review".into()));
        assert_eq!(selected_skill_name(&text("Skill: \"  review \"\r\n\r\nplease")), Some("review".into()), "the name is trimmed, CRLF allowed");
        assert_eq!(selected_skill_name(&text("Skill: \"a\\\"b\"\n\nx")), Some("a\"b".into()), "a JSON string escape");
    }

    #[test]
    fn an_incomplete_or_misplaced_skill_header_selects_nothing() {
        for prompt in ["Skill: \"review\"\nno blank line", "Skill: \"review\"", "say Skill: \"review\"\n\nx", "Skill: \"\"\n\nx", "Skill: \"a\nb\"\n\nx", "Skill: review\n\nx"] {
            assert_eq!(selected_skill_name(&text(prompt)), None, "{prompt:?}");
        }
    }

    #[test]
    fn only_the_first_part_of_a_prompt_can_carry_the_header() {
        let first = Prompt::Parts(vec![PromptPart::Str("Skill: \"a\"\n\nx".into())]);
        assert_eq!(selected_skill_name(&first), Some("a".into()));
        let second = Prompt::Parts(vec![PromptPart::Other, PromptPart::Str("Skill: \"a\"\n\nx".into())]);
        assert_eq!(selected_skill_name(&second), None);
    }

    #[test]
    fn an_inline_mention_is_a_dollar_name_after_a_boundary() {
        assert_eq!(mentions("use $review now"), [("review".into(), 4, 11)]);
        assert_eq!(mentions("$a-1 and ($b) and \"$c\""), [("a-1".into(), 0, 4), ("b".into(), 10, 12), ("c".into(), 19, 21)]);
        assert!(mentions("cost$review").is_empty(), "no boundary before the dollar");
        assert!(mentions("$Review $re_view $review_").is_empty(), "upper case and underscore end a name unrecognised");
    }

    #[test]
    fn numbers_and_environment_variable_names_are_never_mentions() {
        assert!(mentions("$1 $42 $path $HOME $tmp $appdata").is_empty());
    }

    #[test]
    fn a_mention_inside_markdown_code_is_not_a_mention() {
        assert!(mentions("run `$review` now").is_empty());
        assert!(mentions("```\n$review\n```").is_empty());
        assert!(mentions("~~~sh\n$review\n~~~").is_empty());
        assert_eq!(mentions("```\n$a\n```\n$b"), [("b".into(), 11, 13)]);
        assert_eq!(mentions("`` `x` `` $c"), [("c".into(), 10, 12)]);
    }

    #[test]
    fn offsets_count_utf16_units() {
        // The emoji is two units, so the mention starts at 3, not 2.
        assert_eq!(mentions("😀 $go"), [("go".into(), 3, 6)]);
    }

    #[test]
    fn a_selected_skill_must_be_available_and_each_is_chosen_once_in_order() {
        let prompt = text("Skill: \"deploy\"\n\nthen $review and $missing and $review and $deploy");
        assert_eq!(names(&prompt, &["deploy", "review"]), ["deploy", "review"]);
        assert_eq!(names(&prompt, &["review"]), ["review"]);
        assert!(names(&text("nothing here"), &["review"]).is_empty());
    }

    #[test]
    fn at_most_five_skills_are_selected_for_one_turn() {
        let prompt = text("$a $b $c $d $e $f $g");
        let all = ["a", "b", "c", "d", "e", "f", "g"];
        assert_eq!(names(&prompt, &all), ["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn attachment_text_is_not_the_users_own_text() {
        let reference = "a".repeat(64);
        let prompt = Prompt::Parts(vec![
            PromptPart::Text { text: Some("$secret".into()), attachment_ref: Some(reference) },
            PromptPart::Text { text: Some("and $typed".into()), attachment_ref: None },
        ]);
        assert_eq!(names(&prompt, &["secret", "typed"]), ["typed"]);
    }


}


