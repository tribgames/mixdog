//! Compact-summary schema machinery: required-section anchors, heading
//! matching, validation, deterministic repair, the minimal scaffold and
//! section-aware truncation.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Role;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::JsRegex;

use super::text_utils::extract_text;
use super::text_utils::truncate_middle;
use crate::message::AgentMessage;
use crate::project::is_injected_skill_body;
use crate::project::is_protected_context_user;

const REQUIRED_SECTIONS: [&str; 7] = [
    "## Goal",
    "## Constraints",
    "## Progress",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
    "## Relevant Files",
];

struct Layout {
    heading: &'static str,
    anchor: &'static str,
    sub: &'static [&'static str],
}

const LAYOUT: [Layout; 7] = [
    Layout { heading: "## Goal", anchor: "## Goal", sub: &[] },
    Layout { heading: "## Constraints & Preferences", anchor: "## Constraints", sub: &[] },
    Layout { heading: "## Progress", anchor: "## Progress", sub: &["### Done", "### In Progress", "### Blocked"] },
    Layout { heading: "## Key Decisions", anchor: "## Key Decisions", sub: &[] },
    Layout { heading: "## Next Steps", anchor: "## Next Steps", sub: &[] },
    Layout { heading: "## Critical Context", anchor: "## Critical Context", sub: &[] },
    Layout { heading: "## Relevant Files", anchor: "## Relevant Files", sub: &[] },
];

static FILE_RE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[A-Za-z0-9_$.-]+[\\/])?[A-Za-z0-9_$.-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|md|rs|go|py|java|kt|cs|cpp|c|h|hpp|css|html|yml|yaml|toml|lock|sh|ps1)\b",
        "i",
    )
});

fn is_fence(line: &str) -> bool {
    line.starts_with("```") || line.starts_with("~~~")
}

/// `^#{n}\s+` on a trimmed line.
fn heading_prefix(line: &str, hashes: &str) -> bool {
    line.strip_prefix(hashes).and_then(|rest| rest.chars().next()).is_some_and(is_js_space)
}

fn is_h2(trimmed: &str) -> bool {
    heading_prefix(trimmed, "##") && !heading_prefix(trimmed, "###")
}

/// Top-level (`## `, not `### `) heading lines outside code fences.
fn heading_lines(summary: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for raw in summary.split('\n') {
        let line = js_trim(raw);
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // `^##\s+\S`: a heading with a title.
        if heading_prefix(line, "##") && !heading_prefix(line, "###") && !js_trim(&line[2..]).is_empty() {
            out.push(line.to_owned());
        }
    }
    out
}

fn title_of(heading: &str) -> String {
    let rest = heading.strip_prefix("##").map_or(heading, |r| r.trim_start_matches(is_js_space));
    js_trim(rest).to_lowercase()
}

/// A heading title equals the anchor title or extends it at a boundary, so
/// `## Constraints & Preferences` satisfies `## Constraints` but
/// `## Goalkeeper` does not satisfy `## Goal`.
fn heading_matches_anchor(heading: &str, anchor: &str) -> bool {
    let anchor_title = title_of(anchor);
    let heading_title = title_of(heading);
    if heading_title == anchor_title {
        return true;
    }
    let Some(rest) = heading_title.strip_prefix(&anchor_title) else {
        return false;
    };
    rest.chars().next().is_some_and(|c| is_js_space(c) || matches!(c, '&' | ':' | '(' | '-'))
}

fn schema_score(summary: &str) -> usize {
    let headings = heading_lines(summary);
    REQUIRED_SECTIONS
        .iter()
        .filter(|anchor| headings.iter().any(|h| heading_matches_anchor(h, anchor)))
        .count()
}

type Sections = Vec<(String, Vec<String>)>;

/// `## ` heading → body lines, in first-seen order.
fn parse_sections(text: &str) -> Sections {
    let mut map: Sections = Vec::new();
    let mut current: Option<usize> = None;
    let mut in_fence = false;
    for raw in text.split('\n') {
        let trimmed = js_trim(raw);
        let line = js_trim_end(raw);
        if is_fence(trimmed) {
            in_fence = !in_fence;
            if let Some(i) = current {
                map[i].1.push(line.to_owned());
            }
            continue;
        }
        if !in_fence && is_h2(trimmed) {
            let at = map.iter().position(|(h, _)| h == trimmed).unwrap_or_else(|| {
                map.push((trimmed.to_owned(), Vec::new()));
                map.len() - 1
            });
            current = Some(at);
            continue;
        }
        if let Some(i) = current {
            map[i].1.push(line.to_owned());
        }
    }
    map
}

fn section_recognized(heading: &str) -> bool {
    LAYOUT.iter().any(|s| heading_matches_anchor(heading, s.anchor))
}

fn has_unrecognized_headings(summary: &str) -> bool {
    parse_sections(summary).iter().any(|(h, _)| !section_recognized(h))
}

/// Valid only when every required anchor is a real heading and no heading is
/// foreign to the layout.
pub fn summary_is_schema_valid(summary: &str) -> bool {
    schema_score(summary) == REQUIRED_SECTIONS.len() && !has_unrecognized_headings(summary)
}

fn relevant_files_bullets(head: &[AgentMessage]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for m in head {
        let text = extract_text(m);
        if text.is_empty() {
            continue;
        }
        for found in FILE_RE.find_iter(&text) {
            if out.len() >= 8 {
                break;
            }
            let file = &text[found];
            let key = file.to_lowercase();
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            out.push(format!("- {file}"));
        }
        if out.len() >= 8 {
            break;
        }
    }
    out
}

fn current_request(messages: &[AgentMessage]) -> String {
    for m in messages.iter().rev() {
        if m.role() == Role::User && !is_protected_context_user(m) && !is_injected_skill_body(m) {
            let text = truncate_middle(js_trim(&extract_text(m)), 400);
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn lines_to_bullets(text: &str) -> Vec<String> {
    text.split('\n')
        .map(js_trim)
        .filter(|l| !l.is_empty())
        .map(|l| if l.starts_with('-') { l.to_owned() } else { format!("- {l}") })
        .collect()
}

fn unrecognized_section_text(present: &Sections) -> String {
    let chunks: Vec<String> = present
        .iter()
        .filter(|(h, _)| !section_recognized(h))
        .map(|(heading, body)| {
            let mut lines = vec![heading.clone()];
            lines.extend(body.iter().filter(|l| !js_trim(l).is_empty()).cloned());
            lines.join("\n")
        })
        .collect();
    js_trim(&chunks.join("\n\n")).to_owned()
}

/// Every body line of the sections whose heading matches `anchor`.
fn section_body_for(sections: &Sections, anchor: &str) -> Option<Vec<String>> {
    let mut found: Option<Vec<String>> = None;
    for (heading, body) in sections {
        if heading_matches_anchor(heading, anchor) {
            found.get_or_insert_with(Vec::new).extend(body.iter().cloned());
        }
    }
    found
}

fn placeholder_body(section: &Layout) -> Vec<String> {
    if section.sub.is_empty() {
        vec!["- (none)".to_owned()]
    } else {
        section.sub.iter().flat_map(|s| [(*s).to_owned(), "- (none)".to_owned()]).collect()
    }
}

/// The offset where the first `## ` heading line starts (`(^|\n)\s*##\s+`).
fn first_heading_offset(raw: &str) -> Option<usize> {
    let starts = std::iter::once(0).chain(raw.match_indices('\n').map(|(i, _)| i));
    for start in starts {
        let rest = &raw[start..];
        let after_newline = if start > 0 { &rest[1..] } else { rest };
        let body = after_newline.trim_start_matches(is_js_space);
        if heading_prefix(body, "##") {
            return Some(start);
        }
    }
    None
}

/// Deterministic schema repair for a non-empty but malformed summary: keep
/// every section the model supplied, scaffold the missing ones, route text
/// outside any recognized section into Critical Context, and backfill Goal and
/// Relevant Files from the transcript.
pub fn repair_compact_summary(summary: &str, head: &[AgentMessage], tail: &[AgentMessage]) -> String {
    let raw = js_trim(summary);
    let present = parse_sections(raw);
    let preamble = if raw.is_empty() {
        String::new()
    } else {
        match first_heading_offset(raw) {
            None => js_trim(raw).to_owned(),
            Some(at) => js_trim(&raw[..at]).to_owned(),
        }
    };
    let orphan = unrecognized_section_text(&present);
    let extra: Vec<String> = [preamble, orphan].into_iter().filter(|s| !s.is_empty()).collect();
    let extra_context = js_trim(&extra.join("\n\n")).to_owned();
    let bulletize = |lines: Option<Vec<String>>| {
        let cleaned: Vec<String> =
            lines.unwrap_or_default().iter().map(|l| js_trim(l).to_owned()).filter(|l| !l.is_empty()).collect();
        (!cleaned.is_empty()).then_some(cleaned)
    };
    let goal = {
        let from_tail = current_request(tail);
        if from_tail.is_empty() { current_request(head) } else { from_tail }
    };
    let files = relevant_files_bullets(head);
    let mut out: Vec<String> = Vec::new();
    for section in &LAYOUT {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(section.heading.to_owned());
        let body = bulletize(section_body_for(&present, section.anchor));
        if !section.sub.is_empty() {
            out.extend(body.unwrap_or_else(|| placeholder_body(section)));
            continue;
        }
        if section.anchor == "## Critical Context" {
            let mut lines: Vec<String> = body.unwrap_or_default();
            for line in lines_to_bullets(&extra_context) {
                if !lines.iter().any(|e| js_trim(e) == js_trim(&line)) {
                    lines.push(line);
                }
            }
            if lines.iter().any(|l| js_trim(l) != "- (none)") {
                let without: Vec<String> = lines.iter().filter(|l| js_trim(l) != "- (none)").cloned().collect();
                out.extend(if without.is_empty() { lines } else { without });
            } else {
                out.extend(if lines.is_empty() { vec!["- (none)".to_owned()] } else { lines });
            }
            continue;
        }
        if let Some(body) = body {
            out.extend(body);
            continue;
        }
        match section.anchor {
            "## Goal" => out.push(if goal.is_empty() { "- (none)".to_owned() } else { format!("- {goal}") }),
            "## Relevant Files" => {
                out.extend(if files.is_empty() { vec!["- (none)".to_owned()] } else { files.clone() })
            }
            _ => out.push("- (none)".to_owned()),
        }
    }
    out.join("\n")
}

/// Headings only, with `- (none)` bodies: the smallest schema-valid summary.
pub fn minimal_schema_summary() -> String {
    let mut out: Vec<String> = Vec::new();
    for section in &LAYOUT {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(section.heading.to_owned());
        out.extend(placeholder_body(section));
    }
    out.join("\n")
}

/// Keeps every heading intact and trims only section bodies to
/// `per_section_chars`, so the result stays schema-valid at any budget.
pub fn truncate_summary_by_sections(summary: &str, per_section_chars: usize) -> String {
    let sections = parse_sections(summary);
    let mut out: Vec<String> = Vec::new();
    for section in &LAYOUT {
        if !out.is_empty() {
            out.push(String::new());
        }
        out.push(section.heading.to_owned());
        let body = section_body_for(&sections, section.anchor)
            .unwrap_or_default()
            .iter()
            .map(|l| js_trim(l).to_owned())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let trimmed = if body.is_empty() || per_section_chars == 0 { String::new() } else { truncate_middle(&body, per_section_chars) };
        if trimmed.is_empty() {
            out.extend(placeholder_body(section));
        } else {
            out.push(trimmed);
        }
    }
    out.join("\n")
}
