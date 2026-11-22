//! Which palette the prompt draft opens: the slash commands, or `$name` skill completion
//! (`src/tui/app/slash-palette.mjs`, `skill-mention-palette.mjs`, and the derivation of `use-slash-palette.mjs`).

use mixdog_js::{is_js_space, js_to_lowercase, locale_compare_en, utf16_len};
use mixdog_view_model::display::skill_mentions::{is_in_markdown_code, is_reserved_mention_name};
use serde_json::{Value, json};

use super::commands::{SLASH_COMMANDS, SlashCommand, compare_slash_commands, slash_command_matches, slash_query};
use super::host::SlashHost;

/// A mention being typed just before the caret: `$` plus a partial name. `start` is the `$`, `end` the caret, both UTF-16
/// offsets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillMentionQuery {
    pub query: String,
    pub start: usize,
    pub end: usize,
}

fn is_mention_boundary(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(|c| is_js_space(c) || matches!(c, '(' | '[' | '{' | '"' | '\'' | '`'))
}

fn is_name_unit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x61..=0x7a | 0x2d)
}

/// `skillMentionQuery(value, caret)`: the mention being typed before `caret` (default: the end of `value`), or `None`.
/// `$` at the start of the draft or after white space, an opening bracket or a quote opens one; `$` inside Markdown code
/// never does.
pub fn skill_mention_query(value: &str, caret: Option<i64>) -> Option<SkillMentionQuery> {
    let units: Vec<u16> = value.encode_utf16().collect();
    let end = match caret {
        Some(caret) => caret.clamp(0, units.len() as i64) as usize,
        None => units.len(),
    };
    let head = &units[..end];
    // Only the last `$` can start the match: a name holds no `$`.
    let start = head.iter().rposition(|unit| *unit == 0x24)?;
    let name = &head[start + 1..];
    if name.len() > 64 || !name.iter().all(|unit| is_name_unit(*unit)) || name.first() == Some(&0x2d) {
        return None;
    }
    if start > 0 && !is_mention_boundary(head[start - 1]) {
        return None;
    }
    if is_in_markdown_code(value, start as i64) {
        return None;
    }
    Some(SkillMentionQuery { query: String::from_utf16_lossy(name), start, end })
}

/// One palette row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaletteItem {
    Command(&'static SlashCommand),
    /// A `$name` skill row.
    Skill {
        name: String,
        label: String,
        description: String,
    },
}

impl PaletteItem {
    /// The `name` of the row.
    pub fn name(&self) -> &str {
        match self {
            PaletteItem::Command(command) => command.name,
            PaletteItem::Skill { name, .. } => name,
        }
    }
}

fn skill_str<'a>(skill: &'a Value, key: &str) -> Option<&'a str> {
    skill.get(key).and_then(Value::as_str)
}

/// `skillMentionItems(skills, query)`: the skills that can run in this session (the scoped status row's `state` is `inUse`:
/// of a name only the source's skill in use here) and not built-in, whose name starts with the query, then those that merely
/// contain it, each alphabetical.
pub fn skill_mention_items(skills: &[Value], query: &str) -> Vec<PaletteItem> {
    let needle = js_to_lowercase(query);
    let usable: Vec<&Value> = skills
        .iter()
        .filter(|skill| {
            skill_str(skill, "name").is_some_and(|name| {
                !name.is_empty()
                    && skill_str(skill, "state") == Some("inUse")
                    && skill_str(skill, "source") != Some("builtin")
                    && !is_reserved_mention_name(name)
            })
        })
        .collect();
    let name_of = |skill: &Value| skill_str(skill, "name").unwrap_or_default().to_owned();
    let by_name = |a: &&Value, b: &&Value| locale_compare_en(&name_of(a), &name_of(b));
    let mut prefix: Vec<&Value> = usable.iter().copied().filter(|skill| name_of(skill).starts_with(&needle)).collect();
    prefix.sort_by(by_name);
    let mut contains: Vec<&Value> = if needle.is_empty() {
        Vec::new()
    } else {
        usable
            .iter()
            .copied()
            .filter(|skill| {
                let name = name_of(skill);
                !name.starts_with(&needle) && name.contains(&needle)
            })
            .collect()
    };
    contains.sort_by(by_name);
    prefix
        .into_iter()
        .chain(contains)
        .map(|skill| {
            let name = name_of(skill);
            PaletteItem::Skill { label: format!("${name}"), description: skill_str(skill, "description").unwrap_or_default().to_owned(), name }
        })
        .collect()
}

/// The draft after a mention completion: the new value and the caret (UTF-16).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionCompletion {
    pub value: String,
    pub cursor: usize,
}

/// `completeSkillMention(value, name, caret)`: the draft with the `$fragment` before `caret` replaced by `$name `; the text
/// after the caret is kept and the caret lands after the insertion.
pub fn complete_skill_mention(value: &str, name: &str, caret: Option<i64>) -> Option<MentionCompletion> {
    let mention = skill_mention_query(value, caret)?;
    if name.is_empty() {
        return None;
    }
    let units: Vec<u16> = value.encode_utf16().collect();
    let head = format!("{}${name} ", String::from_utf16_lossy(&units[..mention.start]));
    let tail = String::from_utf16_lossy(&units[mention.end..]);
    let cursor = utf16_len(&head);
    Some(MentionCompletion { value: format!("{head}{tail}"), cursor })
}

/// The surfaces that suppress the palette and the draft it reads (`deriveSlashPalette`'s argument).
#[derive(Clone, Copy, Debug, Default)]
pub struct PaletteInputs<'a> {
    pub provider_prompt: bool,
    pub settings_prompt: bool,
    pub tool_approval: bool,
    pub context_panel: bool,
    pub usage_panel: bool,
    pub picker: bool,
    pub exiting: bool,
    pub command_busy: bool,
    pub prompt_draft: &'a str,
    pub slash_dismissed_for: &'a str,
    pub skills: &'a [Value],
    pub prompt_caret: Option<i64>,
}

/// Which list the palette shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaletteKind {
    Commands,
    Skills,
}

/// The palette of one render.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashPalette {
    pub active_slash_query: Option<String>,
    pub slash_commands: Vec<PaletteItem>,
    pub slash_palette_open: bool,
    pub palette_kind: PaletteKind,
}

/// Whether a `$name` mention is being typed (the skill list is fetched each time one starts).
pub fn mention_active(prompt_draft: &str, prompt_caret: Option<i64>) -> bool {
    skill_mention_query(prompt_draft, prompt_caret).is_some()
}

/// `useSkillMentionSkills(store, active)`: the skill list for the `$name` palette, fetched each time a mention starts, as the
/// session asking about itself (`scoped`), so a skill its project scope keeps out of this session's folder is not in use.
/// `None` keeps the list the caller already holds (no mention is being typed, or the fetch failed).
pub fn fetch_mention_skills(host: &mut dyn SlashHost, active: bool) -> Option<Vec<Value>> {
    if !active {
        return None;
    }
    let status = host.store_call("skillsStatus", json!([{"scoped": true}])).ok()?;
    Some(status.get("skills").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// `deriveSlashPalette(...)`: which palette, if any, the prompt draft opens.
pub fn derive_slash_palette(inputs: &PaletteInputs<'_>) -> SlashPalette {
    let active_slash_query = if inputs.provider_prompt || inputs.settings_prompt || inputs.tool_approval || inputs.context_panel || inputs.usage_panel {
        None
    } else {
        slash_query(inputs.prompt_draft)
    };
    let surface_free = !inputs.picker && !inputs.tool_approval && !inputs.context_panel && !inputs.usage_panel && !inputs.exiting && !inputs.command_busy;
    // The palette stays open for the whole slash session, 0-match frames included, so its layout never remounts per key.
    let slash_mode_live = active_slash_query.is_some() && surface_free;
    if !slash_mode_live {
        // `$name` completion shares the palette but opens only while a skill matches: `$HOME` or `$300` in prose raises none.
        let mention = if surface_free && !inputs.provider_prompt && !inputs.settings_prompt {
            skill_mention_query(inputs.prompt_draft, inputs.prompt_caret)
        } else {
            None
        };
        let slash_commands = mention.as_ref().map_or_else(Vec::new, |mention| skill_mention_items(inputs.skills, &mention.query));
        return SlashPalette {
            active_slash_query: mention.as_ref().map(|mention| mention.query.clone()),
            slash_palette_open: !slash_commands.is_empty() && inputs.slash_dismissed_for != inputs.prompt_draft,
            palette_kind: if mention.is_some() { PaletteKind::Skills } else { PaletteKind::Commands },
            slash_commands,
        };
    }
    let query = active_slash_query.unwrap_or_default();
    let mut matches: Vec<&'static SlashCommand> = SLASH_COMMANDS.iter().filter(|command| slash_command_matches(command, &query)).collect();
    matches.sort_by(|a, b| compare_slash_commands(a, b));
    SlashPalette {
        slash_palette_open: inputs.slash_dismissed_for != inputs.prompt_draft,
        slash_commands: matches.into_iter().map(PaletteItem::Command).collect(),
        active_slash_query: Some(query),
        palette_kind: PaletteKind::Commands,
    }
}

/// The selection index after a draft or list change: kept inside the list (`use-slash-palette.mjs`'s clamp).
pub fn clamp_slash_index(index: usize, count: usize) -> usize {
    index.min(count.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn skills() -> Vec<Value> {
        vec![
            json!({"name": "pdf-tools", "description": "PDF work", "source": "global", "state": "inUse"}),
            json!({"name": "deploy", "description": "Ship it", "source": "global", "state": "inUse"}),
            json!({"name": "report-pdf", "description": "Reports", "source": "plugin", "state": "inUse"}),
            json!({"name": "pdf-off", "description": "Disabled", "source": "global", "state": "off"}),
            json!({"name": "pdf", "description": "Built-in", "source": "builtin", "state": "inUse"}),
        ]
    }

    fn query(value: &str, caret: Option<i64>) -> Option<(String, usize, usize)> {
        skill_mention_query(value, caret).map(|m| (m.query, m.start, m.end))
    }

    fn names(items: &[PaletteItem]) -> Vec<String> {
        items.iter().map(|item| item.name().to_owned()).collect()
    }

    fn palette(draft: &str, caret: Option<i64>, dismissed: &str, picker: bool, skills: &[Value]) -> SlashPalette {
        derive_slash_palette(&PaletteInputs {
            prompt_draft: draft,
            slash_dismissed_for: dismissed,
            skills,
            prompt_caret: caret,
            picker,
            ..PaletteInputs::default()
        })
    }

    #[test]
    fn a_dollar_mention_is_the_token_typed_before_the_caret_after_a_boundary() {
        assert_eq!(query("$", None), Some((String::new(), 0, 1)));
        assert_eq!(query("use $pd", None), Some(("pd".into(), 4, 7)));
        assert_eq!(query("see (\"$dep", None), Some(("dep".into(), 6, 10)));
        for draft in ["", "plain", "a$pd", "me@$pd", "$pd ", "$Pd", "$-x", "cost $5 now"] {
            assert_eq!(query(draft, None), None, "{draft}");
        }
    }

    #[test]
    fn the_mention_follows_the_caret_mid_text_and_across_lines() {
        let draft = "fix $pd then ship";
        assert_eq!(query(draft, Some(7)), Some(("pd".into(), 4, 7)));
        assert_eq!(query(draft, Some(5)), Some((String::new(), 4, 5)));
        assert_eq!(query(draft, Some(6)), Some(("p".into(), 4, 6)));
        assert_eq!(query(draft, Some(4)), None);
        assert_eq!(query(draft, None), None);
        let lines = "first line\n$dep\nlast line";
        assert_eq!(query(lines, Some(15)), Some(("dep".into(), 11, 15)));
        assert_eq!(query(lines, Some(10)), None);
        assert_eq!(query("echo $HOME and more", Some(10)), None);
        assert_eq!(query("pay $300 today", Some(8)).map(|m| m.0), Some("300".into()));
    }

    #[test]
    fn rows_list_enabled_custom_skills_prefix_matches_before_contains_matches() {
        let all = skills();
        let labels = |items: Vec<PaletteItem>| {
            items.into_iter().map(|item| if let PaletteItem::Skill { label, .. } = item { label } else { String::new() }).collect::<Vec<_>>()
        };
        assert_eq!(labels(skill_mention_items(&all, "pdf")), ["$pdf-tools", "$report-pdf"]);
        assert_eq!(names(&skill_mention_items(&all, "")), ["deploy", "pdf-tools", "report-pdf"]);
        assert!(skill_mention_items(&all, "zzz").is_empty());
        let dep = skill_mention_items(&all, "dep");
        let PaletteItem::Skill { description, .. } = &dep[0] else { panic!("a skill row") };
        assert_eq!(description, "Ship it");
    }

    #[test]
    fn rows_drop_skills_outside_this_project_and_reserved_names() {
        let mut all = skills();
        all.push(json!({"name": "pdf-elsewhere", "source": "plugin", "state": "off", "offBy": "scope"}));
        all.push(json!({"name": "pdf-elsewhere", "source": "global", "state": "inUse"}));
        all.push(json!({"name": "pdf-here", "source": "plugin", "state": "inUse"}));
        all.push(json!({"name": "path", "source": "global", "state": "inUse"}));
        all.push(json!({"name": "300", "source": "global", "state": "inUse"}));
        assert_eq!(names(&skill_mention_items(&all, "pdf")), ["pdf-elsewhere", "pdf-here", "pdf-tools", "report-pdf"]);
        assert!(skill_mention_items(&all, "pa").is_empty());
        assert!(skill_mention_items(&all, "3").is_empty());
    }

    /// Of a name several sources ship, only the source's skill in use can run: the hidden row is not offered, though its
    /// switch is on.
    #[test]
    fn a_name_in_several_sources_offers_only_the_skill_in_use() {
        let all = vec![
            json!({"name": "review", "description": "Mine", "source": "global", "state": "inUse", "enabled": true}),
            json!({"name": "review", "description": "Theirs", "source": "plugin", "state": "hidden", "enabled": true}),
        ];
        let rows = skill_mention_items(&all, "rev");
        assert_eq!(rows.len(), 1);
        let PaletteItem::Skill { description, .. } = &rows[0] else { panic!("a skill row") };
        assert_eq!(description, "Mine");
    }

    #[test]
    fn completion_replaces_only_the_fragment_before_the_caret() {
        let done = |value: &str, name: &str, caret| complete_skill_mention(value, name, caret).map(|c| (c.value, c.cursor));
        assert_eq!(done("please use $pd", "pdf-tools", None), Some(("please use $pdf-tools ".into(), 22)));
        assert_eq!(done("$", "deploy", None), Some(("$deploy ".into(), 8)));
        assert_eq!(done("no mention", "deploy", None), None);
        assert_eq!(done("fix $pd then ship", "pdf-tools", Some(7)), Some(("fix $pdf-tools  then ship".into(), 15)));
        assert_eq!(done("fix $pdzz", "pdf-tools", Some(7)), Some(("fix $pdf-tools zz".into(), 15)));
        assert_eq!(done("a\n$de\nb", "deploy", Some(5)), Some(("a\n$deploy \nb".into(), 10)));
        assert_eq!(done("fix $pd then ship", "pdf-tools", Some(3)), None);
    }

    #[test]
    fn the_palette_opens_in_skill_mode_only_while_a_skill_matches_and_slash_commands_keep_precedence() {
        let all = skills();
        let open = palette("fix it with $pd", None, "", false, &all);
        assert_eq!(open.palette_kind, PaletteKind::Skills);
        assert!(open.slash_palette_open);
        assert_eq!(open.active_slash_query.as_deref(), Some("pd"));
        assert_eq!(names(&open.slash_commands), ["pdf-tools", "report-pdf"]);
        for draft in ["echo $HOME", "pay $300", "try $zzz"] {
            assert!(!palette(draft, None, "", false, &all).slash_palette_open, "{draft}");
        }
        assert!(!palette("fix it with $pd", None, "fix it with $pd", false, &all).slash_palette_open);
        assert!(!palette("fix it with $pd", None, "", true, &all).slash_palette_open);
        let slash = palette("/sk", None, "", false, &all);
        assert_eq!(slash.palette_kind, PaletteKind::Commands);
        assert_eq!(names(&slash.slash_commands), ["skills"]);
        assert!(!palette("plain text", None, "", false, &all).slash_palette_open);
    }

    #[test]
    fn the_skill_palette_stays_closed_while_the_caret_is_inside_code() {
        let all = skills();
        let at = |draft: &str| {
            let caret = draft.find('|').map(|byte| utf16_len(&draft[..byte]) as i64);
            palette(&draft.replace('|', ""), caret, "", false, &all)
        };
        for draft in ["run `echo $pd|` here", "`$pd|`", "`` a ` $pd| ``", "```\n$pd|\n```", "```sh\nfoo $pd|", "~~~\nuse $pd|\n~~~ after", "```\r\n$pd|\r\n```"]
        {
            assert!(!at(draft).slash_palette_open, "{draft:?}");
        }
        for draft in ["`code` then $pd|", "```\nx\n```\nnow $pd|", "a lone ` tick $pd|", "`` x ` y $pd|", "~~~\nx\n~~~\n$pd| more"] {
            let shown = at(draft);
            assert!(shown.slash_palette_open, "{draft:?}");
            assert_eq!(shown.palette_kind, PaletteKind::Skills);
        }
    }

    #[test]
    fn the_skill_palette_opens_and_filters_at_a_mid_text_caret() {
        let all = skills();
        let draft = "fix $pd then ship";
        let mid = palette(draft, Some(7), "", false, &all);
        assert_eq!(mid.palette_kind, PaletteKind::Skills);
        assert_eq!(names(&mid.slash_commands), ["pdf-tools", "report-pdf"]);
        assert_eq!(names(&palette(draft, Some(5), "", false, &all).slash_commands), ["deploy", "pdf-tools", "report-pdf"]);
        assert!(!palette(draft, None, "", false, &all).slash_palette_open);
        assert!(!palette(draft, Some(4), "", false, &all).slash_palette_open);
        let lines = palette("first\n$rep\nlast", Some(10), "", false, &all);
        assert_eq!(names(&lines.slash_commands), ["report-pdf"]);
        assert!(!palette(draft, Some(7), draft, false, &all).slash_palette_open);
        assert_eq!(names(&palette("/sk", Some(1), "", false, &all).slash_commands), ["skills"]);
    }

    #[test]
    fn the_slash_palette_stays_open_with_no_match_and_is_suppressed_by_other_surfaces() {
        let none = palette("/zzz", None, "", false, &[]);
        assert!(none.slash_palette_open);
        assert!(none.slash_commands.is_empty());
        let busy = derive_slash_palette(&PaletteInputs { prompt_draft: "/m", command_busy: true, ..PaletteInputs::default() });
        assert!(!busy.slash_palette_open);
        let prompt = derive_slash_palette(&PaletteInputs { prompt_draft: "/m", provider_prompt: true, ..PaletteInputs::default() });
        assert_eq!(prompt.active_slash_query, None);
        assert_eq!(clamp_slash_index(5, 3), 2);
        assert_eq!(clamp_slash_index(5, 0), 0);
    }
}
