//! The prompt-settings notice (`session/manager/prompt-settings.mjs`): a conversation that meets other
//! prompt-shaping settings than its prompt presents keeps its cached prefix, is told once by a
//! `<system-reminder>` and folds the settings in at the next cold point.
//!
//! * [`stage_prompt_settings_notice`] compares a conversation's header with the sections as they stand
//!   now (`stagePromptSettingsNotice`) and stages the notice in `promptSettingsNotice`.
//! * [`snapshot_pending`] / [`acknowledge_pending`] are what the turn that carries the notice reads and what it
//!   writes once the provider accepted the turn.
//! * [`note_presented`] is what a rebuilt prompt records (`notePromptSettingsPresented`).
//!
//! The sections are the ones the prompt composition renders ([`OwnedSections`], built by
//! `compose_session_prompt` from the same texts that make the prompt's own record).

use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::settings::SECTIONS;
use super::settings::Sections;
use super::settings::hash_of;
use super::settings::prompt_settings_record;
use super::settings::skill_names;

const LABELS: [(&str, &str); 7] = [
    ("meta", "Profile Preferences and Output Style"),
    ("workflow", "Workflow"),
    ("orchestration", "Orchestration Mode"),
    ("skills", "Skills"),
    ("instructionFiles", "Instruction Files"),
    ("coreMemory", "Core Memory"),
    ("language", "Language"),
];

/// `NOTICE_MAX_BYTES`, `DIFF_MAX_BYTES`, `STYLE_BODY_MAX_BYTES`, `INSTRUCTION_LIST_MAX_BYTES`.
pub const NOTICE_MAX_BYTES: usize = 4096;
pub const DIFF_MAX_BYTES: usize = 2048;
const STYLE_BODY_MAX_BYTES: usize = 1536;
const INSTRUCTION_LIST_MAX_BYTES: usize = 1024;
const LATER: &str = "it applies from the next prompt rebuild.";
const NOTICE_OPEN: &str = "<system-reminder>\nSettings changed during this conversation; each section replaces the matching part of your system prompt.";
const NOTICE_CLOSE: &str = "</system-reminder>";

/// `promptSettingsSections(...)`: the section texts, the workflow's name, the instruction-files mode and the
/// response language.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OwnedSections {
    pub meta: String,
    pub workflow: String,
    pub workflow_name: Option<String>,
    pub orchestration: String,
    pub orchestration_mode: String,
    pub skills: String,
    pub instruction_files: String,
    pub core_memory: String,
    pub language: String,
    pub instruction_files_mode: String,
    /// `{ id, name }` or null.
    pub response_language: Value,
}

impl OwnedSections {
    pub fn borrowed(&self) -> Sections<'_> {
        Sections {
            meta: &self.meta,
            workflow: &self.workflow,
            orchestration: &self.orchestration,
            orchestration_mode: &self.orchestration_mode,
            skills: &self.skills,
            instruction_files: &self.instruction_files,
            core_memory: &self.core_memory,
            language: &self.language,
            instruction_files_mode: &self.instruction_files_mode,
        }
    }

    /// `promptSettingsRecord(sections)`.
    pub fn record(&self) -> Value {
        prompt_settings_record(&self.borrowed())
    }
}

// ---- section parsing ----------------------------------------------------------------------------

type Ordered = Vec<(String, String)>;

/// A `Map` set: a key set again keeps its place.
fn put(map: &mut Ordered, key: &str, value: String) {
    match map.iter_mut().find(|(existing, _)| existing == key) {
        Some(entry) => entry.1 = value,
        None => map.push((key.to_owned(), value)),
    }
}

fn get<'a>(map: &'a Ordered, key: &str) -> Option<&'a str> {
    map.iter().find(|(existing, _)| existing == key).map(|(_, value)| value.as_str())
}

/// `.`: anything but a line terminator.
fn plain(text: &str) -> bool {
    !text.contains(['\r', '\n', '\u{2028}', '\u{2029}'])
}

/// `headedBlocks(text)`: `# Heading` blocks of a rendered section, heading to body.
fn headed_blocks(text: &str) -> Ordered {
    let mut blocks = Ordered::new();
    let mut heading: Option<String> = None;
    let mut lines: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        match line.strip_prefix("# ").filter(|rest| !rest.is_empty() && plain(rest)) {
            Some(rest) => {
                if let Some(open) = &heading {
                    put(&mut blocks, open, js_trim(&lines.join("\n")).to_owned());
                }
                heading = Some(js_trim(rest).to_owned());
                lines.clear();
            }
            None if heading.is_some() => lines.push(line),
            None => {}
        }
    }
    if let Some(open) = &heading {
        put(&mut blocks, open, js_trim(&lines.join("\n")).to_owned());
    }
    blocks
}

/// `outputStyleOf(meta)`: `(name, body)`.
fn output_style_of(meta: &str) -> Option<(String, String)> {
    headed_blocks(meta)
        .into_iter()
        .find_map(|(heading, body)| heading.strip_prefix("Output Style: ").filter(|name| !name.is_empty() && plain(name)).map(|name| (js_trim(name).to_owned(), body)))
}

fn bullet_lines(text: &str) -> Vec<String> {
    text.split('\n').map(js_trim).filter(|line| line.starts_with("- ")).map(str::to_owned).collect()
}

fn profile_lines(meta: &str) -> Vec<String> {
    bullet_lines(get(&headed_blocks(meta), "Profile Preferences").unwrap_or_default())
}

/// `FILE_HEADING_RE`: only an absolute path opens a file.
fn file_heading(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("## ")?;
    let bytes = rest.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    (drive || rest.starts_with('/')).then_some(rest).filter(|rest| plain(rest))
}

/// `instructionFiles(text)`: `## <path>` to the content of a rendered `# Instruction Files` block.
fn instruction_files(text: &str) -> Ordered {
    let mut files = Ordered::new();
    let mut path: Option<String> = None;
    let mut lines: Vec<&str> = Vec::new();
    let flush = |files: &mut Ordered, path: &Option<String>, lines: &[&str]| {
        if let Some(path) = path.as_ref().filter(|path| !path.is_empty()) {
            put(files, path, js_trim(&lines.join("\n")).to_owned());
        }
    };
    for line in text.split('\n') {
        match file_heading(line) {
            Some(found) => {
                flush(&mut files, &path, &lines);
                path = Some(js_trim(found).to_owned());
                lines.clear();
            }
            None if path.is_some() => lines.push(line),
            None => {}
        }
    }
    flush(&mut files, &path, &lines);
    files
}

fn content_lines(text: &str) -> Vec<String> {
    text.split('\n').map(js_trim_end).filter(|line| !js_trim(line).is_empty()).map(str::to_owned).collect()
}

/// Whether the items both lists share run in a different order or count.
fn order_changed(was: &[String], now: &[String]) -> bool {
    let shared = |from: &[String], other: &[String]| from.iter().filter(|item| other.contains(item)).cloned().collect::<Vec<_>>().join("\n");
    shared(was, now) != shared(now, was)
}

/// `lines` kept while they fit `max` bytes, then a `(N more <what>)` tail.
fn capped(lines: &[String], max: usize, what: &str) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0;
    for line in lines {
        if used + line.len() + 1 > max {
            kept.push(format!("({} more {what})", lines.len() - kept.len()));
            break;
        }
        kept.push(line.clone());
        used += line.len() + 1;
    }
    kept
}

/// Added (+) and removed (-) lines, capped at `max` bytes; `""` when equal.
fn line_diff(before: &str, after: &str, max: usize) -> String {
    let was = content_lines(before);
    let now = content_lines(after);
    let mut changes: Vec<String> = was.iter().filter(|line| !now.contains(line)).map(|line| format!("- {line}")).collect();
    changes.extend(now.iter().filter(|line| !was.contains(line)).map(|line| format!("+ {line}")));
    let mut out = capped(&changes, max, "changed lines");
    if order_changed(&was, &now) {
        out.push("The line order changed; the lines now run in this order:".to_owned());
        let numbered: Vec<String> = now.iter().enumerate().map(|(index, line)| format!("{}. {line}", index + 1)).collect();
        out.extend(capped(&numbered, max, "lines"));
    }
    out.join("\n")
}

// ---- records ---------------------------------------------------------------------------------------

/// A section a record predates counts as unchanged.
fn changed_keys(from: &Value, to: &Value) -> Vec<String> {
    SECTIONS
        .iter()
        .filter(|key| from["hashes"].get(**key).is_some_and(|was| was != &Value::Null) && from["hashes"][**key] != to["hashes"][**key])
        .map(|key| (*key).to_owned())
        .collect()
}

fn texts_of(record: &Value) -> Map<String, Value> {
    record.get("texts").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn told_text<'a>(told: &'a Map<String, Value>, key: &str) -> &'a str {
    told.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn told_skills(told: &Map<String, Value>) -> Vec<String> {
    told.get("skills").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default()
}

// ---- the notice builder ------------------------------------------------------------------------------

fn language_section(sections: &OwnedSections) -> String {
    match sections.response_language.get("name").filter(|name| !name.is_null() && name.as_str() != Some("")) {
        Some(name) => format!("# Language\nRespond in {} from now on.", mixdog_js::value_to_string(name)),
        None => "# Language\nNo response language is set any more: reply in the language of the conversation.".to_owned(),
    }
}

fn meta_sections(before: &str, sections: &OwnedSections) -> Vec<String> {
    let mut out = Vec::new();
    let style = output_style_of(&sections.meta);
    let was = output_style_of(before);
    if style.as_ref().map(|s| (&s.0, &s.1)) != was.as_ref().map(|s| (&s.0, &s.1)) {
        match &style {
            None => out.push("# Output Style\nNo output style applies any more.".to_owned()),
            Some((name, body)) => {
                let body = if body.len() < STYLE_BODY_MAX_BYTES { format!("\n\n{body}") } else { "\nIt applies from the next prompt rebuild.".to_owned() };
                out.push(format!("# Output Style\nThe output style is now \"{name}\".{body}"));
            }
        }
    }
    let profile = line_diff(&profile_lines(before).join("\n"), &profile_lines(&sections.meta).join("\n"), DIFF_MAX_BYTES);
    if !profile.is_empty() {
        out.push(format!("# Profile\n{profile}"));
    }
    out
}

fn file_order_changed(was: &Ordered, now: &Ordered) -> bool {
    let keys = |files: &Ordered| files.iter().map(|(path, _)| path.clone()).collect::<Vec<_>>();
    order_changed(&keys(was), &keys(now))
}

fn unique_paths(was: &Ordered, now: &Ordered) -> Vec<String> {
    let mut paths: Vec<String> = was.iter().map(|(path, _)| path.clone()).collect();
    for (path, _) in now {
        if !paths.contains(path) {
            paths.push(path.clone());
        }
    }
    paths
}

fn instruction_files_section(told: &Map<String, Value>, sections: &OwnedSections) -> String {
    let mode = sections.instruction_files_mode.as_str();
    let told_mode = told_text(told, "instructionFilesMode");
    if !mode.is_empty() && !told_mode.is_empty() && mode != told_mode {
        return format!("# Instruction Files\nThe instruction files mode is now \"{mode}\"; the files apply from the next prompt rebuild.");
    }
    let was = instruction_files(told_text(told, "instructionFiles"));
    let now = instruction_files(&sections.instruction_files);
    let mut parts: Vec<String> = Vec::new();
    for path in unique_paths(&was, &now) {
        match get(&now, &path) {
            None => parts.push(format!("## {path}\nNo longer applies.")),
            Some(current) => {
                let diff = line_diff(get(&was, &path).unwrap_or_default(), current, DIFF_MAX_BYTES);
                if !diff.is_empty() {
                    parts.push(format!("## {path}\n{diff}\nRead {path} for the full file."));
                }
            }
        }
    }
    if file_order_changed(&was, &now) {
        parts.push(format!("The files now apply in this order:\n{}", now.iter().map(|(path, _)| path.as_str()).collect::<Vec<_>>().join("\n")));
    }
    if parts.is_empty() { String::new() } else { format!("# Instruction Files\n{}", parts.join("\n\n")) }
}

fn skills_section(told: &Map<String, Value>, sections: &OwnedSections) -> String {
    let was = told_skills(told);
    let now = skill_names(&sections.skills);
    let added: Vec<&String> = now.iter().filter(|name| !was.contains(name)).collect();
    let removed: Vec<&String> = was.iter().filter(|name| !now.contains(name)).collect();
    let join = |names: &[&String]| names.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ");
    let mut lines: Vec<String> = Vec::new();
    if !added.is_empty() {
        lines.push(format!("Added: {}", join(&added)));
    }
    if !removed.is_empty() {
        lines.push(format!("Removed: {}", join(&removed)));
    }
    if order_changed(&was, &now) {
        lines.push(format!("Order now: {}", now.join(", ")));
    }
    if lines.is_empty() { String::new() } else { format!("# Skills\n{}", lines.join("\n")) }
}

/// The paths of changed instruction files, with how each changed.
fn changed_instruction_files(told: &Map<String, Value>, sections: &OwnedSections) -> Vec<(Option<String>, String)> {
    let was = instruction_files(told_text(told, "instructionFiles"));
    let now = instruction_files(&sections.instruction_files);
    let mut out: Vec<(Option<String>, String)> = Vec::new();
    for path in unique_paths(&was, &now) {
        match (get(&was, &path), get(&now, &path)) {
            (_, None) => out.push((Some(path.clone()), format!("- no longer applies: {path}"))),
            (None, Some(_)) => out.push((Some(path.clone()), format!("- added: {path} (read it)"))),
            (Some(before), Some(after)) if before != after => out.push((Some(path.clone()), format!("- changed: {path} (read it)"))),
            _ => {}
        }
    }
    // No path of its own: acknowledged only with the whole item. Listed first, so even the minimal form carries it.
    if file_order_changed(&was, &now) {
        out.insert(0, (None, format!("- file order changed: {}", now.iter().map(|(path, _)| path.as_str()).collect::<Vec<_>>().join(", "))));
    }
    out
}

fn render_instruction_files(files: &Ordered) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut parts = vec!["# Instruction Files".to_owned()];
    parts.extend(files.iter().map(|(path, text)| format!("## {path}\n\n{text}")));
    parts.join("\n\n")
}

/// What the model knows of instruction files once `paths` were told.
fn instruction_files_after(told_text: &str, now_text: &str, paths: &[String]) -> String {
    let mut files = instruction_files(told_text);
    let now = instruction_files(now_text);
    for path in paths {
        match get(&now, path) {
            Some(text) => put(&mut files, path, text.to_owned()),
            None => files.retain(|(existing, _)| existing != path),
        }
    }
    render_instruction_files(&files)
}

struct Paths {
    full: Vec<String>,
    compact: Vec<String>,
    minimal: Vec<String>,
}

struct Item {
    key: String,
    full: String,
    compact: String,
    minimal: String,
    paths: Option<Paths>,
}

#[derive(Clone, Copy, PartialEq)]
enum Tier {
    Minimal,
    Compact,
    Full,
}

impl Item {
    fn text(&self, tier: Tier) -> &str {
        match tier {
            Tier::Minimal => &self.minimal,
            Tier::Compact => &self.compact,
            Tier::Full => &self.full,
        }
    }

    fn paths_of(&self, tier: Tier) -> Option<&Vec<String>> {
        self.paths.as_ref().map(|paths| match tier {
            Tier::Minimal => &paths.minimal,
            Tier::Compact => &paths.compact,
            Tier::Full => &paths.full,
        })
    }
}

fn instruction_files_item(full: String, told: &Map<String, Value>, sections: &OwnedSections) -> Item {
    let changed = changed_instruction_files(told, sections);
    let heading = "# Instruction Files";
    let all: Vec<String> = changed.iter().filter_map(|(path, _)| path.clone()).collect();
    let compact = std::iter::once(heading.to_owned()).chain(changed.iter().map(|(_, line)| line.clone())).collect::<Vec<_>>().join("\n");
    let mut listed: Vec<&(Option<String>, String)> = Vec::new();
    let mut size = heading.len();
    for entry in &changed {
        if !listed.is_empty() && size + entry.1.len() + 1 > INSTRUCTION_LIST_MAX_BYTES {
            break;
        }
        listed.push(entry);
        size += entry.1.len() + 1;
    }
    let rest = changed.len() - listed.len();
    let mut minimal = vec![heading.to_owned()];
    minimal.extend(listed.iter().map(|(_, line)| line.clone()));
    if rest > 0 {
        minimal.push(format!("({rest} more changed files follow in the next notice)"));
    }
    Item {
        key: "instructionFiles".to_owned(),
        full,
        compact,
        minimal: minimal.join("\n"),
        paths: Some(Paths { full: all.clone(), compact: all, minimal: listed.iter().filter_map(|(path, _)| path.clone()).collect() }),
    }
}

fn mode_name(mode: &str) -> String {
    let mode = if workflow_modes().contains(&mode) { mode } else { "balanced" };
    if mode == "none" {
        return "Solo".to_owned();
    }
    let mut chars = mode.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

fn workflow_modes() -> [&'static str; 4] {
    mixdog_core_config::workflow::ids::ORCHESTRATION_MODES
}

/// An item with no paths of its own; nothing for an empty full text.
fn add(items: &mut Vec<Item>, key: &str, full: String, compact: Option<String>, minimal: Option<String>) {
    if full.is_empty() {
        return;
    }
    let compact = compact.unwrap_or_else(|| full.clone());
    let minimal = minimal.unwrap_or_else(|| compact.clone());
    items.push(Item { key: key.to_owned(), full, compact, minimal, paths: None });
}

/// One changed item: its full text and the compact form it degrades to when the block has no room.
fn notice_items(keys: &[String], sections: &OwnedSections, told: &Map<String, Value>) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    for (key, _) in LABELS {
        if !keys.iter().any(|k| k == key) {
            continue;
        }
        match key {
            "meta" => {
                let style = output_style_of(&sections.meta);
                for part in meta_sections(told_text(told, "meta"), sections) {
                    if part.starts_with("# Output Style") {
                        let compact = style.as_ref().map(|(name, _)| format!("# Output Style\nThe output style is now \"{name}\"; {LATER}")).unwrap_or_else(|| part.clone());
                        add(&mut items, key, part, Some(compact), None);
                    } else {
                        let lines = part.split('\n').count() - 1;
                        add(&mut items, key, part, Some(format!("# Profile\n{lines} profile preference lines changed; {LATER}")), None);
                    }
                }
            }
            "workflow" => {
                let name = sections.workflow_name.as_deref().filter(|name| !name.is_empty()).map_or_else(|| "active".to_owned(), |name| format!("\"{name}\""));
                add(&mut items, key, format!("# Workflow\nThe {name} workflow pack changed; {LATER}"), None, None);
            }
            "orchestration" => {
                // The text of the active mode was edited. A switch to another mode is the mode-switch notice's, and a
                // record that predates the text has nothing to diff.
                let mode = sections.orchestration_mode.as_str();
                if !told.contains_key("orchestration") || mode.is_empty() || told_text(told, "orchestrationMode") != mode {
                    continue;
                }
                let diff = line_diff(told_text(told, "orchestration"), &sections.orchestration, DIFF_MAX_BYTES);
                if diff.is_empty() {
                    continue;
                }
                let head = format!("# Orchestration Mode\nThe {} orchestration mode instructions were edited", mode_name(mode));
                add(&mut items, key, format!("{head}:\n{diff}"), Some(format!("{head}; {LATER}")), None);
            }
            "skills" => {
                let full = skills_section(told, sections);
                let was = told_skills(told);
                let now = skill_names(&sections.skills);
                let added = now.iter().filter(|name| !was.contains(name)).count();
                let removed = was.iter().filter(|name| !now.contains(name)).count();
                let moved = if order_changed(&was, &now) { ", order changed" } else { "" };
                add(&mut items, key, full, Some(format!("# Skills\n{added} skills added, {removed} removed{moved}; {LATER}")), None);
            }
            "instructionFiles" => {
                let full = instruction_files_section(told, sections);
                if full.is_empty() {
                    continue;
                }
                if full.contains("instruction files mode is now") {
                    add(&mut items, key, full, None, None);
                } else {
                    items.push(instruction_files_item(full, told, sections));
                }
            }
            "coreMemory" => {
                let later = format!("# Core Memory\nCore memory was updated; {LATER}");
                let diff = if told.contains_key("coreMemory") { line_diff(told_text(told, "coreMemory"), &sections.core_memory, DIFF_MAX_BYTES) } else { String::new() };
                let full = if diff.is_empty() { later.clone() } else { format!("# Core Memory\nCore memory was updated:\n{diff}") };
                add(&mut items, key, full, Some(later), None);
            }
            "language" => add(&mut items, key, language_section(sections), None, None),
            _ => {}
        }
    }
    items
}

struct Built {
    content: String,
    emitted: Vec<String>,
    partial: Map<String, Value>,
}

/// `buildPromptSettingsNotice(keys, sections, told, { compact })`: one `#` section per changed item of `keys`, diffed
/// against `told`. Every item first takes its minimal form, smallest first; the budget left upgrades items to their
/// compact form and then their full text, smallest first. An item that does not fit even minimal is left out, named by
/// the overflow line and not acknowledged.
fn build_notice(keys: &[String], sections: &OwnedSections, told: &Map<String, Value>, compact_only: bool) -> Built {
    let items = notice_items(keys, sections, told);
    if items.is_empty() {
        return Built { content: String::new(), emitted: Vec::new(), partial: Map::new() };
    }
    let cost = |text: &str| text.len() as i64 + 2;
    let reserve = cost("99 more changes; see the setup tool.");
    let max = NOTICE_MAX_BYTES as i64;
    let mut used = (NOTICE_OPEN.len() + NOTICE_CLOSE.len()) as i64;
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|index| items[*index].minimal.len());
    let mut chosen: Vec<(usize, Tier)> = Vec::new();
    for index in order {
        if used + cost(&items[index].minimal) + reserve > max {
            continue;
        }
        chosen.push((index, Tier::Minimal));
        used += cost(&items[index].minimal);
    }
    let tiers: &[Tier] = if compact_only { &[Tier::Compact] } else { &[Tier::Compact, Tier::Full] };
    for tier in tiers {
        let mut by_size: Vec<usize> = chosen.iter().map(|(index, _)| *index).collect();
        by_size.sort_by_key(|index| items[*index].text(*tier).len());
        for index in by_size {
            let slot = chosen.iter().position(|(chosen_index, _)| *chosen_index == index).expect("chosen");
            let extra = cost(items[index].text(*tier)) - cost(items[index].text(chosen[slot].1));
            if extra > 0 && used + extra + reserve > max {
                continue;
            }
            chosen[slot].1 = *tier;
            used += extra;
        }
    }
    let left = items.len() - chosen.len();
    let mut parts: Vec<String> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        if let Some((_, tier)) = chosen.iter().find(|(chosen_index, _)| *chosen_index == index) {
            parts.push(item.text(*tier).to_owned());
        }
    }
    if left > 0 {
        parts.push(format!("{left} more changes; see the setup tool."));
    }
    // An item whose form names only some of its paths tells those alone.
    let mut partial = Map::new();
    for (index, tier) in &chosen {
        let item = &items[*index];
        if let (Some(paths), Some(all)) = (item.paths_of(*tier), item.paths.as_ref().map(|paths| &paths.full))
            && paths.len() < all.len()
        {
            partial.insert(item.key.clone(), json!(paths));
        }
    }
    let unsent = |key: &str| items.iter().enumerate().any(|(index, item)| item.key == key && !chosen.iter().any(|(chosen_index, _)| *chosen_index == index));
    let emitted = keys.iter().filter(|key| items.iter().any(|item| &item.key == *key) && !unsent(key) && !partial.contains_key(key.as_str())).cloned().collect();
    let content = if parts.is_empty() { String::new() } else { [NOTICE_OPEN.to_owned()].into_iter().chain(parts).chain([NOTICE_CLOSE.to_owned()]).collect::<Vec<_>>().join("\n\n") };
    Built { content, emitted, partial }
}

/// `promptSettingsNoticeContent(keys, sections, told)`: the notice text alone.
pub fn notice_content(keys: &[String], sections: &OwnedSections, told: &Map<String, Value>) -> String {
    build_notice(keys, sections, told, false).content
}

// ---- staging --------------------------------------------------------------------------------------------

/// What the model was last told: an acknowledged notice, else its prompt; a staged working-folder change tells its own
/// instruction files and core memory (workspace notice), so they count as told.
fn told_record(session: &Header, presented: &Value) -> Value {
    let told = session.get("promptSettingsTold").filter(|told| !told.is_null()).unwrap_or(presented).clone();
    let Some(target) = session.get("workspaceReroot").and_then(|reroot| reroot.get("target")).filter(|target| target.is_object()) else { return told };
    let mut hashes = told["hashes"].as_object().cloned().unwrap_or_default();
    let mut texts = texts_of(&told);
    for (field, key) in [("instructionFilesContext", "instructionFiles"), ("coreMemoryContext", "coreMemory")] {
        if let Some(value) = target.get(field) {
            let text = if crate_truthy(value) { mixdog_js::value_to_string(value) } else { String::new() };
            hashes.insert(key.to_owned(), Value::String(hash_of(&text)));
            texts.insert(key.to_owned(), Value::String(text));
        }
    }
    let mut next = told.as_object().cloned().unwrap_or_default();
    next.insert("hashes".into(), Value::Object(hashes));
    next.insert("texts".into(), Value::Object(texts));
    Value::Object(next)
}

fn crate_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `stagePromptSettingsNotice(session, sections)`: compare a conversation's settings with `sections` as they stand now.
/// Returns the keys that differ from the prompt (a later fold presents them), staging one notice for what differs from
/// what the model was last told: a setting moved back to the prompt's value is told too.
pub fn stage_prompt_settings_notice(session: &mut Header, sections: &OwnedSections, now_ms: i64) -> Vec<String> {
    session.insert("responseLanguage".into(), sections.response_language.clone());
    // After a compaction stripped what a worker was told: names and pointers only.
    let compact = session.get("promptSettingsRecheck").and_then(Value::as_str) == Some("compact");
    session.shift_remove("promptSettingsRecheck");
    let next = sections.record();
    // A prompt from before settings were recorded: what it presents is unknown.
    if !session.get("promptSettings").is_some_and(|presented| presented.get("hashes").is_some_and(Value::is_object)) {
        session.insert("promptSettings".into(), next);
        return Vec::new();
    }
    // Sections a record predates are adopted as presented.
    let mut presented = session["promptSettings"].clone();
    for key in SECTIONS {
        if presented["hashes"].get(key).is_none() {
            presented["hashes"][key] = next["hashes"][key].clone();
        }
    }
    session.insert("promptSettings".into(), presented.clone());
    let changed = changed_keys(&presented, &next);
    let told = told_record(session, &presented);
    let fresh = changed_keys(&told, &next);
    let built = if fresh.is_empty() { Built { content: String::new(), emitted: Vec::new(), partial: Map::new() } } else { build_notice(&fresh, sections, &texts_of(&told), compact) };
    if built.content.is_empty() {
        session.shift_remove("promptSettingsNotice");
        // Nothing to tell: the model's view is the prompt's, or what it was told.
        if changed.is_empty() {
            session.shift_remove("promptSettingsTold");
        } else if !fresh.is_empty() {
            session.insert("promptSettingsTold".into(), next);
        }
        return changed;
    }
    if let Some(pending) = session.get("promptSettingsNotice")
        && pending["record"]["revision"] == next["revision"]
        && pending["content"].as_str() == Some(built.content.as_str())
    {
        return changed;
    }
    // One notice per change: an unsent one is replaced by what is current.
    let previous = mixdog_js::to_number_of(session.get("promptSettingsNoticeRevision"));
    let revision = (if previous.is_nan() { 0.0 } else { previous }) + 1.0;
    session.insert("promptSettingsNoticeRevision".into(), mixdog_js::json_number(revision));
    session.insert(
        "promptSettingsNotice".into(),
        json!({ "revision": mixdog_js::json_number(revision), "record": next, "content": built.content, "emitted": built.emitted, "partial": built.partial, "fresh": fresh }),
    );
    session.insert("updatedAt".into(), json!(now_ms));
    changed
}

// What the model knows after a notice reached it: the record's sections it carried, the earlier told state for the rest.
fn texts_fields(key: &str) -> &'static [&'static str] {
    match key {
        "meta" => &["meta"],
        "orchestration" => &["orchestration", "orchestrationMode"],
        "instructionFiles" => &["instructionFiles", "instructionFilesMode"],
        "coreMemory" => &["coreMemory"],
        "skills" => &["skills"],
        _ => &[],
    }
}

fn revision_of(hashes: &Map<String, Value>) -> String {
    hash_of(&SECTIONS.iter().map(|key| hashes.get(*key).and_then(Value::as_str).unwrap_or_default().to_owned()).collect::<Vec<_>>().join("|"))
}

fn told_after(session: &Header, notice: &Value) -> Value {
    let Some(emitted) = notice.get("emitted").and_then(Value::as_array) else { return notice["record"].clone() };
    let base = session.get("promptSettingsTold").filter(|told| !told.is_null()).or_else(|| session.get("promptSettings").filter(|p| !p.is_null())).unwrap_or(&notice["record"]);
    let mut hashes = base["hashes"].as_object().cloned().unwrap_or_default();
    let mut texts = texts_of(base);
    let record_texts = texts_of(&notice["record"]);
    for key in emitted.iter().filter_map(Value::as_str) {
        hashes.insert(key.to_owned(), notice["record"]["hashes"][key].clone());
        for field in texts_fields(key) {
            match record_texts.get(*field) {
                Some(value) => {
                    texts.insert((*field).to_owned(), value.clone());
                }
                None => {
                    texts.shift_remove(*field);
                }
            }
        }
    }
    // Instruction files the notice named one by one: those paths alone.
    if let Some(paths) = notice.get("partial").and_then(|partial| partial.get("instructionFiles")).and_then(Value::as_array) {
        let paths: Vec<String> = paths.iter().filter_map(Value::as_str).map(str::to_owned).collect();
        let text = instruction_files_after(told_text(&texts, "instructionFiles"), told_text(&record_texts, "instructionFiles"), &paths);
        hashes.insert("instructionFiles".into(), Value::String(hash_of(&text)));
        texts.insert("instructionFiles".into(), Value::String(text));
    }
    json!({ "revision": revision_of(&hashes), "hashes": hashes, "texts": texts })
}

/// `snapshotPendingPromptSettingsNotice(session)`: the notice the next user turn carries, `(revision, content)`.
pub fn snapshot_pending(session: &Header) -> Option<(i64, String)> {
    let pending = session.get("promptSettingsNotice")?;
    let content = pending.get("content").and_then(Value::as_str).filter(|content| !content.is_empty())?;
    Some((pending.get("revision").and_then(Value::as_i64)?, content.to_owned()))
}

/// `acknowledgePendingPromptSettingsNotice(session, revision)`: the notice of `revision` reached the model.
pub fn acknowledge_pending(session: &mut Header, revision: i64) -> bool {
    let Some(pending) = session.get("promptSettingsNotice").cloned() else { return false };
    if pending.get("revision").and_then(Value::as_i64) != Some(revision) {
        return false;
    }
    // Only what the notice carried is told; an item the cap left out stays pending and is told by the next turn's reconcile.
    let told = told_after(session, &pending);
    session.insert("promptSettingsTold".into(), told);
    let emitted: Vec<&str> = pending.get("emitted").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if pending.get("fresh").and_then(Value::as_array).is_some_and(|fresh| fresh.iter().filter_map(Value::as_str).any(|key| !emitted.contains(&key))) {
        session.insert("promptSettingsRecheck".into(), Value::Bool(true));
    }
    session.shift_remove("promptSettingsNotice");
    true
}

/// [`acknowledge_pending`] as the header change it makes (`None`: nothing was acknowledged), for a turn's settle that
/// writes the session through change records.
pub fn acknowledge_change(header: &Header, revision: i64) -> Option<HeaderChange> {
    let mut after = header.clone();
    if !acknowledge_pending(&mut after, revision) {
        return None;
    }
    let set = after.iter().filter(|(key, value)| header.get(*key) != Some(*value)).map(|(key, value)| (key.clone(), value.clone())).collect();
    let unset = header.keys().filter(|key| !after.contains_key(*key)).cloned().collect();
    Some(HeaderChange { set, unset })
}

/// The user message that carries the turn's reminder block (`buildUserTurn`, `ask-turn-prepare.mjs:205-246`):
/// `withRuntimeUserContext(message, { suffix: suffixUserTurnReminders('', block) })` over the meta the reminders
/// leave on the message (`agentListing`: what the agent list reminder told; `promptSettingsNoticeRevision`: the
/// settings notice it carried, so a retry resubmits the message as it is). A turn with no reminder keeps its
/// message. `None` for content that is neither text nor blocks.
pub fn carry_reminders(message: &Value, block: &str, agent_listing: Option<&Value>, settings_revision: Option<i64>) -> Option<Value> {
    if block.is_empty() {
        return Some(message.clone());
    }
    let suffix = format!("\n\n{block}");
    let mut carried = message.clone();
    match carried.get_mut("content")? {
        Value::String(text) => text.push_str(&suffix),
        Value::Array(parts) => parts.push(json!({ "type": "text", "text": suffix })),
        _ => return None,
    }
    let object = carried.as_object_mut()?;
    let meta = object.entry("meta").or_insert_with(|| json!({})).as_object_mut()?;
    if let Some(listing) = agent_listing {
        meta.insert("agentListing".into(), listing.clone());
    }
    if let Some(revision) = settings_revision {
        meta.insert("promptSettingsNoticeRevision".into(), json!(revision));
    }
    meta.insert("runtimeUserContext".into(), json!({ "prefix": "", "suffix": suffix }));
    Some(carried)
}

/// `notePromptSettingsPresented(session, sections)`: the prompt now presents `sections`; nothing is pending any more.
pub fn note_presented(session: &mut Header, sections: &OwnedSections) {
    session.insert("responseLanguage".into(), sections.response_language.clone());
    session.insert("promptSettings".into(), sections.record());
    for key in ["promptSettingsNotice", "promptSettingsTold", "promptSettingsRecheck"] {
        session.shift_remove(key);
    }
}

#[cfg(test)]
mod tests;
