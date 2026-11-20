//! The aggregate tool-card classification (`shared/tool-work-units.mjs`): which category a tool call belongs to, and the work
//! unit (verb pair and counted noun) its header is built from. Arguments stay `serde_json::Value`s, so a unit's JSON is the
//! row Node builds. `mixdog_protocol::tool_units` keeps the three surfaced categories' counts for the active-tool summary
//! (the protocol crate cannot depend on this one); the rules here are the whole table.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::json_number;
use serde_json::Map;
use serde_json::Value;

use crate::tool_primitives::coalesce;
use crate::tool_primitives::code_graph_label;
use crate::tool_primitives::count_of;
use crate::tool_primitives::defined;
use crate::tool_primitives::field;
use crate::tool_primitives::is_external_mcp_tool_name;
use crate::tool_primitives::normalize_tool_name;
use crate::tool_primitives::number_of;
use crate::tool_primitives::parse_mcp_tool_name;
use crate::tool_primitives::parse_tool_args;
use crate::tool_primitives::patch_file_count;
use crate::tool_primitives::picked_lower;
use crate::tool_primitives::split_tool_search_selection;
use crate::tool_primitives::text_of;
use crate::tool_primitives::title_case_mcp_server;
use crate::tool_primitives::truthy;

/// The order categories read in when a header has no order of its own (`Visualize` is not in it: it reads after the rest).
pub const CATEGORY_ORDER: [&str; 21] = [
    "Read",
    "Search",
    "Load",
    "MCP",
    "Skill",
    "Web Research",
    "Memory",
    "Explore",
    "Patch",
    "Git",
    "Shell",
    "Agent",
    "Task",
    "Setup",
    "Browser",
    "Computer",
    "Terminal",
    "Office",
    "Media",
    "Tidy",
    "Other",
];

/// `classifyToolCategory`: the aggregate category of a tool name and arguments.
pub fn classify_tool_category(name: &str, args: &Value) -> String {
    if is_external_mcp_tool_name(name) {
        return "MCP".to_owned();
    }
    let normalized = normalize_tool_name(name);
    if normalized == "code_graph" {
        return code_graph_label(args).to_owned();
    }
    tool_category(&normalized).to_owned()
}

fn tool_category(normalized: &str) -> &'static str {
    match normalized {
        "read" | "view_image" | "read_mcp_resource" => "Read",
        "grep" | "find" | "glob" | "list" | "ls" => "Search",
        "load_tool" => "Load",
        "web_search" | "search_query" | "image_query" | "web_search_call" | "web_fetch" | "fetch" => "Web Research",
        "recall" | "recall_memory" | "search_memories" | "remember" | "save_memory" | "update_memory" | "memory" => "Memory",
        "explore" => "Explore",
        "apply_patch" | "edit" | "strreplace" | "str_replace" | "str_replace_editor" | "search_replace" => "Patch",
        "git" | "git_stage" | "github" => "Git",
        "bash" | "shell" | "shell_command" | "bash_session" | "job_wait" => "Shell",
        "task" => "Task",
        "agent" | "bridge" => "Agent",
        "browser" | "browser_devtools" => "Browser",
        "computer" => "Computer",
        "terminal" => "Terminal",
        "office" => "Office",
        "media" => "Media",
        "tidy" => "Tidy",
        "visualize" => "Visualize",
        "list_mcp_resources"
        | "list_mcp_resource_templates"
        | "cwd"
        | "session"
        | "setup"
        | "goal"
        | "request_user_input"
        | "ask_user"
        | "handoff_user"
        | "update_plan" => "Setup",
        "skill" | "skill_execute" | "skill_view" | "skills_list" | "use_skill" => "Skill",
        _ => "Other",
    }
}

/// The verbs and noun a category reads with (`CATEGORY_COPY`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CategoryCopy {
    pub active: &'static str,
    pub done: &'static str,
    pub noun: &'static str,
    pub plural_noun: Option<&'static str>,
}

const fn copy(active: &'static str, done: &'static str, noun: &'static str) -> CategoryCopy {
    CategoryCopy { active, done, noun, plural_noun: None }
}

/// `categoryCopy`: an unknown category reads as `Other`.
pub fn category_copy(category: &str) -> CategoryCopy {
    match category {
        "Read" => copy("Reading", "Read", "file"),
        "Search" => copy("Searching", "Searched", "file"),
        "Load" => copy("Loading", "Loaded", "tool"),
        "MCP" => copy("Using", "Used", "MCP tool"),
        "Skill" => copy("Loading", "Loaded", "skill"),
        "Web Research" => CategoryCopy { plural_noun: Some("queries"), ..copy("Researching", "Researched", "query") },
        "Memory" => copy("Checking", "Checked", "memory item"),
        "Explore" => CategoryCopy { plural_noun: Some("queries"), ..copy("Exploring", "Explored", "query") },
        "Patch" => copy("Editing", "Edited", "file"),
        "Git" => copy("Running", "Ran", "Git command"),
        "Shell" => copy("Running", "Ran", "command"),
        "Agent" => copy("Calling", "Called", "agent"),
        "Task" => copy("Checking", "Checked", "task"),
        "Setup" => copy("Setting up", "Set up", "item"),
        "Browser" => copy("Browsing", "Browsed", "action"),
        "Computer" => copy("Operating", "Operated", "action"),
        "Terminal" => copy("Reading", "Read", "terminal output"),
        "Office" => copy("Editing", "Edited", "document action"),
        "Media" => copy("Generating", "Generated", "media action"),
        "Tidy" => copy("Tidying", "Tidied", "cleanup pass"),
        "Visualize" => copy("Showing", "Showed", "artifact"),
        _ => copy("Calling", "Called", "tool"),
    }
}

/// One counted piece of work: the verbs and noun its header reads with.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkUnit {
    pub category: String,
    pub active: String,
    pub done: String,
    pub noun: String,
    pub plural_noun: String,
    pub count: f64,
    /// An effect unit changes state: a failed call must not claim its done verb.
    pub effect: bool,
}

impl WorkUnit {
    /// The row Node builds (`{ category, active, done, noun, pluralNoun, count, effect }`).
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("category".to_owned(), Value::from(self.category.clone()));
        map.insert("active".to_owned(), Value::from(self.active.clone()));
        map.insert("done".to_owned(), Value::from(self.done.clone()));
        map.insert("noun".to_owned(), Value::from(self.noun.clone()));
        map.insert("pluralNoun".to_owned(), Value::from(self.plural_noun.clone()));
        map.insert("count".to_owned(), json_number(self.count));
        map.insert("effect".to_owned(), Value::Bool(self.effect));
        Value::Object(map)
    }
}

/// What `unitDescriptor` is given beyond the category (an empty text counts as absent, like `||`; a count of 0 reads as 1).
#[derive(Clone, Debug, Default)]
pub struct UnitOverrides<'a> {
    pub active: &'a str,
    pub done: &'a str,
    pub noun: &'a str,
    pub plural_noun: &'a str,
    pub count: f64,
    pub effect: bool,
}

/// `unitDescriptor(category, overrides)`.
pub fn unit_descriptor(category: &str, overrides: &UnitOverrides) -> WorkUnit {
    let base = category_copy(category);
    let pick = |own: &str, fallback: &str| if own.is_empty() { fallback.to_owned() } else { own.to_owned() };
    let noun = pick(overrides.noun, base.noun);
    let plural_noun = if !overrides.plural_noun.is_empty() {
        overrides.plural_noun.to_owned()
    } else if let Some(plural) = base.plural_noun {
        plural.to_owned()
    } else {
        format!("{noun}s")
    };
    let count = if overrides.count.is_nan() || overrides.count == 0.0 { 1.0 } else { overrides.count.max(1.0) };
    WorkUnit {
        category: category.to_owned(),
        active: pick(overrides.active, base.active),
        done: pick(overrides.done, base.done),
        noun,
        plural_noun,
        count,
        effect: overrides.effect,
    }
}

/// `queryCount(args, ...keys) || 1`.
fn counted(args: &Value, keys: &[&str]) -> f64 {
    let count = count_of(args, keys);
    if count == 0 { 1.0 } else { count as f64 }
}

/// A one-count unit with its verbs and noun given.
fn unit(category: &str, active: &str, done: &str, noun: &str, effect: bool) -> WorkUnit {
    unit_descriptor(category, &UnitOverrides { active, done, noun, count: 1.0, effect, ..UnitOverrides::default() })
}

/// A unit counted from `keys` with the category's own verbs.
fn counted_unit(category: &str, args: &Value, keys: &[&str], noun: &str, plural_noun: &str) -> WorkUnit {
    unit_descriptor(category, &UnitOverrides { noun, plural_noun, count: counted(args, keys), ..UnitOverrides::default() })
}

fn lower_action(args: &Value) -> String {
    picked_lower(args, &["action"])
}

// ── Patches ─────────────────────────────────────────────────────────────────

static PATCH_FILE_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\*\*\*\s+(Update|Add|Delete) File:\s+.+\s*$", "i"));
static DIFF_GIT_START: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^diff --git ", "m"));
static UNIFIED_HEADER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^---\s+.+\n\+\+\+\s+.+$", "m"));
static NEW_FILE_MODE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^new file mode ", "m"));
static FROM_DEV_NULL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^---\s+/dev/null(?:\s|$)", "m"));
static DELETED_FILE_MODE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^deleted file mode ", "m"));
static TO_DEV_NULL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\+\+\+\s+/dev/null(?:\s|$)", "m"));

/// File counts per kind (`add`, `update`, `delete`) in the order the kinds were first seen (a JavaScript `Map`).
#[derive(Default)]
struct Profile(Vec<(String, f64)>);

impl Profile {
    fn add(&mut self, kind: &str, count: f64) {
        let step = if count.is_nan() || count == 0.0 { 1.0 } else { count.max(1.0) };
        match self.0.iter_mut().find(|(known, _)| known == kind) {
            Some(entry) => entry.1 += step,
            None => self.0.push((kind.to_owned(), step)),
        }
    }
}

/// The text of a patch split before every line that starts a `diff --git` section.
fn git_sections(text: &str) -> Vec<&str> {
    let starts: Vec<usize> = DIFF_GIT_START.find_iter(text).map(|range| range.start).collect();
    starts.iter().enumerate().map(|(index, start)| &text[*start..starts.get(index + 1).copied().unwrap_or(text.len())]).collect()
}

/// `patchOperationProfile`: the per-kind (add, update, delete) file counts read off a patch payload.
pub fn patch_operation_profile(args: &Value) -> Vec<(String, f64)> {
    let a = parse_tool_args(args);
    let patch_text = text_of(field(&a, "patch"));
    let mut profile = Profile::default();

    for line in patch_text.split('\n') {
        if let Some(found) = PATCH_FILE_LINE.captures(line) {
            profile.add(&js_to_lowercase(found.get(1).unwrap_or_default()), 1.0);
        }
    }
    if !profile.0.is_empty() {
        return profile.0;
    }

    let mut sections = git_sections(&patch_text);
    if sections.is_empty() && UNIFIED_HEADER.is_match(&patch_text) {
        sections = vec![patch_text.as_str()];
    }
    for section in sections {
        if NEW_FILE_MODE.is_match(section) || FROM_DEV_NULL.is_match(section) {
            profile.add("add", 1.0);
        } else if DELETED_FILE_MODE.is_match(section) || TO_DEV_NULL.is_match(section) {
            profile.add("delete", 1.0);
        } else {
            profile.add("update", 1.0);
        }
    }
    if !profile.0.is_empty() {
        return profile.0;
    }

    let old_string = field(&a, "old_string");
    let empty = |value: Option<&Value>| matches!(value, Some(Value::String(text)) if text.is_empty());
    if empty(old_string) {
        profile.add("add", 1.0);
    } else if empty(field(&a, "new_string")) && defined(old_string).is_some() {
        profile.add("delete", 1.0);
    } else {
        profile.add("update", patch_file_count(&a).max(1) as f64);
    }
    profile.0
}

/// `patchMutationUnits`: one unit per kind of change a patch makes (one checking unit for a dry run).
pub fn patch_mutation_units(args: &Value) -> Vec<WorkUnit> {
    let a = parse_tool_args(args);
    if matches!(field(&a, "dry_run"), Some(Value::Bool(true))) {
        return vec![unit_descriptor(
            "Patch",
            &UnitOverrides { active: "Checking", done: "Checked", noun: "file", count: patch_file_count(&a).max(1) as f64, ..UnitOverrides::default() },
        )];
    }
    patch_operation_profile(&a)
        .into_iter()
        .map(|(kind, count)| {
            let (active, done) = match kind.as_str() {
                "add" => ("Creating", "Created"),
                "delete" => ("Deleting", "Deleted"),
                _ => ("Editing", "Edited"),
            };
            unit_descriptor("Patch", &UnitOverrides { active, done, noun: "file", count, effect: true, ..UnitOverrides::default() })
        })
        .collect()
}

fn apply_patch_unit(a: &Value) -> WorkUnit {
    let mut units = patch_mutation_units(a);
    if units.len() == 1 {
        return units.remove(0);
    }
    let total: f64 = units.iter().map(|unit| unit.count).sum();
    unit_descriptor("Patch", &UnitOverrides { active: "Changing", done: "Changed", noun: "file", count: total, effect: true, ..UnitOverrides::default() })
}

// ── Per-tool work units ─────────────────────────────────────────────────────

fn list_unit(a: &Value) -> WorkUnit {
    unit_descriptor(
        "Search",
        &UnitOverrides {
            active: "Listing",
            done: "Listed",
            noun: "directory",
            plural_noun: "directories",
            count: counted(a, &["path", "paths", "dir", "dirs", "cwd"]),
            ..UnitOverrides::default()
        },
    )
}

fn load_tool_unit(a: &Value) -> WorkUnit {
    let selected = split_tool_search_selection(field(a, "names")).len() + split_tool_search_selection(field(a, "select")).len();
    if selected > 0 {
        return unit_descriptor("Load", &UnitOverrides { noun: "tool", count: selected as f64, effect: true, ..UnitOverrides::default() });
    }
    unit_descriptor(
        "Load",
        &UnitOverrides { noun: "query", plural_noun: "queries", count: counted(a, &["query", "q", "text"]), effect: true, ..UnitOverrides::default() },
    )
}

fn web_search_unit(a: &Value) -> WorkUnit {
    counted_unit("Web Research", a, &["query", "queries", "keywords"], "query", "queries")
}

fn media_unit(a: &Value) -> WorkUnit {
    match lower_action(a).as_str() {
        "generate" => {
            let noun = if matches!(field(a, "kind"), Some(Value::String(kind)) if kind == "video") { "video" } else { "image" };
            unit("Media", "Generating", "Generated", noun, true)
        }
        "cancel" => unit("Media", "Cancelling", "Cancelled", "media job", true),
        "list" => unit("Media", "Listing", "Listed", "media catalog", false),
        _ => unit("Media", "Checking", "Checked", "media job", false),
    }
}

fn tidy_unit(a: &Value) -> WorkUnit {
    let action = lower_action(a);
    match action.as_str() {
        "install" => unit("Tidy", "Installing", "Installed", "cleanup engine", true),
        // fix writes only with apply:true; otherwise it reports the change plan.
        "fix" if matches!(field(a, "apply"), Some(Value::Bool(true))) => unit("Tidy", "Tidying", "Tidied", "cleanup pass", true),
        "fix" => unit("Tidy", "Previewing", "Previewed", "cleanup pass", false),
        "scan" => unit("Tidy", "Scanning", "Scanned", "project", false),
        "rules" | "results" => unit("Tidy", "Reading", "Read", &format!("cleanup {action}"), false),
        _ => unit("Tidy", "Checking", "Checked", "cleanup action", false),
    }
}

/// Office actions that only observe or review a document.
const OFFICE_READ_ACTIONS: [&str; 11] = ["snapshot", "get", "query", "describe", "detect", "issues", "qa", "validate", "render", "diff", "transactions"];

fn office_verbs(action: &str) -> (&'static str, &'static str) {
    match action {
        "author" => ("Authoring", "Authored"),
        "batch" => ("Editing", "Edited"),
        "create" => ("Creating", "Created"),
        "attach" => ("Attaching", "Attached"),
        "open" => ("Opening", "Opened"),
        "secure" => ("Securing", "Secured"),
        "begin" => ("Starting", "Started"),
        "commit" => ("Committing", "Committed"),
        "rollback" => ("Rolling back", "Rolled back"),
        "recover" => ("Recovering", "Recovered"),
        "save" => ("Saving", "Saved"),
        "finalize" => ("Finalizing", "Finalized"),
        "close" => ("Closing", "Closed"),
        _ => ("Editing", "Edited"),
    }
}

fn office_unit(a: &Value) -> WorkUnit {
    let action = lower_action(a);
    if OFFICE_READ_ACTIONS.contains(&action.as_str()) {
        return unit("Office", "Reading", "Read", "document action", false);
    }
    let (active, done) = office_verbs(&action);
    unit("Office", active, done, "document action", true)
}

fn visualize_unit(a: &Value) -> WorkUnit {
    let (active, done, noun) = match lower_action(a).as_str() {
        "capture" => ("Capturing", "Captured", "screenshot"),
        "export" => ("Exporting", "Exported", "file"),
        "annotate" => ("Marking", "Marked", "annotation"),
        "check" => ("Checking", "Checked", "page"),
        "inspect" => ("Inspecting", "Inspected", "page"),
        "act" => ("Operating", "Operated", "page"),
        "close" => ("Closing", "Closed", "tab"),
        _ => ("Showing", "Showed", "artifact"),
    };
    unit("Visualize", active, done, noun, false)
}

fn terminal_unit(a: &Value) -> WorkUnit {
    if lower_action(a) == "list" {
        unit("Terminal", "Listing", "Listed", "terminal tab", false)
    } else {
        unit("Terminal", "Reading", "Read", "terminal output", false)
    }
}

/// The verbs of a GitHub action's verb (`None` for one the table does not know).
fn github_verbs(verb: &str) -> Option<(&'static str, &'static str)> {
    Some(match verb {
        "list" => ("Listing", "Listed"),
        "view" => ("Viewing", "Viewed"),
        "comments" | "logs" => ("Reading", "Read"),
        "create" => ("Creating", "Created"),
        "edit" => ("Editing", "Edited"),
        "close" => ("Closing", "Closed"),
        "reopen" => ("Reopening", "Reopened"),
        "comment" => ("Commenting on", "Commented on"),
        "merge" => ("Merging", "Merged"),
        "review" => ("Reviewing", "Reviewed"),
        "checkout" => ("Checking out", "Checked out"),
        "clone" => ("Cloning", "Cloned"),
        "fork" => ("Forking", "Forked"),
        "run" => ("Running", "Ran"),
        "rerun" => ("Rerunning", "Reran"),
        "cancel" => ("Cancelling", "Cancelled"),
        "read" => ("Marking read", "Marked read"),
        _ => return None,
    })
}

/// `githubActionParts`: `issue.create` as the noun `issue` and the verb `create`.
pub fn github_action_parts(action: Option<&Value>) -> (String, String) {
    let text = if truthy(action) { js_to_lowercase(&text_of(action)) } else { String::new() };
    let mut parts = text.split('.');
    let noun = parts.next().unwrap_or_default().to_owned();
    let verb = parts.next().unwrap_or_default().to_owned();
    (noun, verb)
}

fn github_unit(a: &Value) -> WorkUnit {
    let (noun, verb) = github_action_parts(field(a, "action"));
    let Some((active, done)) = github_verbs(&verb).filter(|_| !noun.is_empty()) else {
        return unit_descriptor("Git", &UnitOverrides { noun: "GitHub operation", count: 1.0, ..UnitOverrides::default() });
    };
    let label = if noun == "pr" { "PR" } else { noun.as_str() };
    unit("Git", active, done, label, !matches!(verb.as_str(), "list" | "view" | "comments" | "logs"))
}

fn goal_unit(a: &Value) -> WorkUnit {
    let action = lower_action(a);
    let (active, done) = match action.as_str() {
        "status" => ("Checking", "Checked"),
        "create" => ("Creating", "Created"),
        "complete" => ("Completing", "Completed"),
        "block" => ("Blocking", "Blocked"),
        _ => ("Updating", "Updated"),
    };
    unit("Setup", active, done, "goal", action != "status")
}

fn setup_unit(a: &Value) -> WorkUnit {
    let action = lower_action(a);
    let prefixed = |prefixes: &[&str]| prefixes.iter().any(|prefix| action.strip_prefix(prefix).is_some());
    let (active, done, effect) = if action == "status" {
        ("Checking", "Checked", false)
    } else if action == "open" {
        ("Opening", "Opened", false)
    } else if prefixed(&["search", "inspect", "local_model_details"]) {
        ("Inspecting", "Inspected", false)
    } else if prefixed(&["install_", "start_"]) {
        ("Installing", "Installed", true)
    } else if prefixed(&["add_", "register_", "save_"]) {
        ("Adding", "Added", true)
    } else if prefixed(&["remove_", "delete_", "forget_"]) {
        ("Removing", "Removed", true)
    } else if prefixed(&["cancel_"]) {
        ("Cancelling", "Cancelled", true)
    } else if prefixed(&["reconnect_", "enable_", "maintain_", "update_"]) {
        ("Updating", "Updated", true)
    } else {
        ("Changing", "Changed", true)
    };
    unit("Setup", active, done, "setting", effect)
}

fn fetch_unit(a: &Value) -> WorkUnit {
    let limit = number_of(coalesce(a, &["limit", "messages"]));
    let count = if limit.is_finite() && limit > 0.0 { limit.floor() } else { counted(a, &["messages"]) };
    unit_descriptor("Web Research", &UnitOverrides { active: "Fetching", done: "Fetched", noun: "message", count, ..UnitOverrides::default() })
}

fn memory_read_unit(a: &Value) -> WorkUnit {
    counted_unit("Memory", a, &["query", "queries", "text", "input", "id"], "memory item", "memory items")
}

fn memory_write_unit(a: &Value) -> WorkUnit {
    unit_descriptor(
        "Memory",
        &UnitOverrides {
            active: "Writing",
            done: "Wrote",
            noun: "memory item",
            count: counted(a, &["entries", "items", "memories", "query", "text", "value"]),
            effect: true,
            ..UnitOverrides::default()
        },
    )
}

fn memory_tool_unit(a: &Value) -> WorkUnit {
    let op = picked_lower(a, &["op", "action"]);
    if op == "delete" {
        return unit_descriptor(
            "Memory",
            &UnitOverrides {
                active: "Deleting",
                done: "Deleted",
                noun: "memory item",
                count: counted(a, &["id", "ids"]),
                effect: true,
                ..UnitOverrides::default()
            },
        );
    }
    if op == "add" || op == "edit" {
        return memory_write_unit(a);
    }
    let listing = op == "list";
    unit_descriptor(
        "Memory",
        &UnitOverrides {
            active: if listing { "Listing" } else { "Checking" },
            done: if listing { "Listed" } else { "Checked" },
            noun: "memory item",
            count: counted(a, &["entries", "items", "memories", "query", "text", "value"]),
            ..UnitOverrides::default()
        },
    )
}

fn shell_unit(a: &Value) -> WorkUnit {
    counted_unit("Shell", a, &["command", "commands", "cmd"], "command", "")
}

fn agent_unit(a: &Value) -> WorkUnit {
    let kind = picked_lower(a, &["type", "action"]);
    let status = picked_lower(a, &["status"]);
    let count = counted(a, &["agents", "roles", "role", "tag", "task_id", "sessionId"]);
    let agent = |active: &str, done: &str, effect: bool| {
        unit_descriptor("Agent", &UnitOverrides { active, done, noun: "agent", count, effect, ..UnitOverrides::default() })
    };
    if kind == "result" {
        return match status.as_str() {
            "failed" | "error" | "timeout" | "killed" | "denied" => agent("Finishing", "Failed", false),
            "cancelled" | "canceled" => agent("Finishing", "Cancelled", false),
            _ => agent("Finishing", "Completed", false),
        };
    }
    match kind.as_str() {
        // Checks (status/read/list) observe an agent; they are not calls to it.
        "status" | "read" | "list" => agent("Checking", "Checked", false),
        // Stopping an agent is not calling it, and ending a finished agent's session (close) is not cancelling its work.
        "cancel" => agent("Cancelling", "Cancelled", true),
        "close" => agent("Ending", "Ended", true),
        _ => agent("", "", false),
    }
}

fn task_unit(a: &Value) -> WorkUnit {
    let action = lower_action(a);
    let count = counted(a, &["task_id", "task_ids", "id", "ids"]);
    // Waiting on a task, enumerating tasks, and cancelling one are distinct work; only `read`/`status` falls through to the
    // neutral check verb.
    let (active, done) = match action.as_str() {
        "cancel" => ("Cancelling", "Cancelled"),
        "wait" => ("Waiting for", "Waited for"),
        "list" => ("Listing", "Listed"),
        _ => ("", ""),
    };
    unit_descriptor("Task", &UnitOverrides { active, done, noun: "task", count, ..UnitOverrides::default() })
}

fn skill_unit(a: &Value) -> WorkUnit {
    unit_descriptor(
        "Skill",
        &UnitOverrides { noun: "skill", count: counted(a, &["name", "skill", "skill_name", "query", "q"]), effect: true, ..UnitOverrides::default() },
    )
}

fn code_graph_unit(a: &Value) -> WorkUnit {
    let searching = code_graph_label(a) == "Search";
    unit_descriptor(
        if searching { "Search" } else { "Read" },
        &UnitOverrides {
            active: if searching { "Mapping" } else { "Reading" },
            done: if searching { "Mapped" } else { "Read" },
            // "code map", not "file": an overview/imports/impact pass reads structure, and sharing the plain read unit hid it
            // behind file reads.
            noun: if searching { "symbol" } else { "code map" },
            count: counted(a, &["symbols", "symbol", "query", "files", "file", "path"]),
            ..UnitOverrides::default()
        },
    )
}

fn browser_unit() -> WorkUnit {
    unit("Browser", "Browsing", "Browsed", "action", false)
}

fn git_stage_unit(a: &Value) -> WorkUnit {
    unit_descriptor(
        "Git",
        &UnitOverrides {
            active: "Staging",
            done: "Staged",
            noun: "change",
            count: counted(a, &["change_ids", "change_id"]),
            effect: true,
            ..UnitOverrides::default()
        },
    )
}

fn git_worktree_unit(a: &Value) -> WorkUnit {
    let listing = picked_lower(a, &["worktree_action"]) == "list";
    unit_descriptor("Git", &UnitOverrides { active: "Managing", done: "Managed", noun: "worktree", effect: !listing, ..UnitOverrides::default() })
}

fn setup_item(active: &str, done: &str, noun: &str, effect: bool) -> WorkUnit {
    unit_descriptor("Setup", &UnitOverrides { active, done, noun, effect, ..UnitOverrides::default() })
}

fn cwd_unit(a: &Value) -> WorkUnit {
    let action = picked_lower(a, &["action", "type"]);
    // A bare `path` selects that Project even when action is omitted.
    if action == "set" || action == "set-project" || (action.is_empty() && truthy(field(a, "path"))) {
        return setup_item("Selecting", "Selected", "project", true);
    }
    match action.as_str() {
        "list" | "list-projects" => setup_item("Listing", "Listed", "project", false),
        "rename" => setup_item("Renaming", "Renamed", "session", true),
        "compact" => setup_item("Scheduling", "Scheduled", "compaction", true),
        "fork" => setup_item("Forking", "Forked", "session", true),
        "favorite" | "archive" => {
            let off = matches!(field(a, "value"), Some(Value::Bool(false)));
            let (active, done) = match (action.as_str(), off) {
                ("favorite", true) => ("Unfavoriting", "Unfavorited"),
                ("favorite", false) => ("Favoriting", "Favorited"),
                (_, true) => ("Unarchiving", "Unarchived"),
                (_, false) => ("Archiving", "Archived"),
            };
            setup_item(active, done, "session", true)
        }
        "status" => setup_item("Checking", "Checked", "session", false),
        _ => unit_descriptor(
            "Setup",
            &UnitOverrides { active: "Checking", done: "Checked", noun: "working directory", plural_noun: "working directories", ..UnitOverrides::default() },
        ),
    }
}

/// The `session` tool: its session actions are about sessions, not the legacy `cwd` tool's working directory (which
/// `cwd_unit`'s fallback names).
fn session_unit(a: &Value) -> WorkUnit {
    match picked_lower(a, &["action", "type"]).as_str() {
        "create" => setup_item("Creating", "Created", "session", true),
        "send" => setup_item("Sending to", "Sent to", "session", true),
        "cancel" => setup_item("Cancelling", "Cancelled", "session", true),
        "delete" => setup_item("Deleting", "Deleted", "session", true),
        "list" | "bots" | "read" | "suggest" => setup_item("Checking", "Checked", "session", false),
        _ => cwd_unit(a),
    }
}

/// The unit a builtin tool's call is counted in; `None` for a name that has no rule of its own.
fn tool_unit(normalized: &str, a: &Value) -> Option<WorkUnit> {
    Some(match normalized {
        "read" => counted_unit("Read", a, &["path", "paths", "file_path", "file", "files"], "file", ""),
        "view_image" => counted_unit("Read", a, &["path", "file_path", "file"], "image", ""),
        "read_mcp_resource" => counted_unit("Read", a, &["uri", "uris"], "resource", ""),
        "apply_patch" => apply_patch_unit(a),
        "grep" => unit_descriptor(
            "Search",
            &UnitOverrides {
                active: "Searching",
                done: "Searched",
                noun: "pattern",
                count: counted(a, &["pattern", "patterns", "query"]),
                ..UnitOverrides::default()
            },
        ),
        "glob" => unit_descriptor(
            "Search",
            &UnitOverrides {
                active: "Finding",
                done: "Found",
                noun: "glob",
                count: counted(a, &["pattern", "patterns", "glob", "globs"]),
                ..UnitOverrides::default()
            },
        ),
        "find" => unit_descriptor(
            "Search",
            &UnitOverrides {
                active: "Finding",
                done: "Found",
                noun: "query",
                plural_noun: "queries",
                count: counted(a, &["query", "queries", "fuzzy"]),
                ..UnitOverrides::default()
            },
        ),
        "list" | "ls" => list_unit(a),
        "load_tool" => load_tool_unit(a),
        "search_query" | "image_query" | "web_search" | "web_search_call" => web_search_unit(a),
        "web_fetch" => unit_descriptor(
            "Web Research",
            &UnitOverrides {
                active: "Fetching",
                done: "Fetched",
                noun: "URL",
                plural_noun: "URLs",
                count: counted(a, &["url", "urls", "uri", "uris"]),
                ..UnitOverrides::default()
            },
        ),
        "explore" => unit_descriptor("Explore", &UnitOverrides { count: counted(a, &["query"]), ..UnitOverrides::default() }),
        "browser" | "browser_devtools" => browser_unit(),
        "computer" => unit("Computer", "Operating", "Operated", "action", false),
        "terminal" => terminal_unit(a),
        "office" => office_unit(a),
        "goal" => goal_unit(a),
        "setup" => setup_unit(a),
        "media" => media_unit(a),
        "tidy" => tidy_unit(a),
        "visualize" => visualize_unit(a),
        "fetch" => fetch_unit(a),
        "recall" | "recall_memory" | "search_memories" => memory_read_unit(a),
        "remember" | "save_memory" | "update_memory" => memory_write_unit(a),
        "memory" => memory_tool_unit(a),
        "shell" | "bash" | "bash_session" | "shell_command" | "job_wait" => shell_unit(a),
        "git" => match field(a, "action") {
            Some(Value::String(action)) if action == "stage" => git_stage_unit(a),
            Some(Value::String(action)) if action == "worktree" => git_worktree_unit(a),
            _ => counted_unit("Git", a, &["command", "commands"], "Git command", ""),
        },
        "github" => github_unit(a),
        // Preserve the staging work unit when rendering historical transcripts.
        "git_stage" => git_stage_unit(a),
        "agent" | "bridge" => agent_unit(a),
        "task" => task_unit(a),
        "skill" | "skill_execute" | "skill_view" | "skills_list" | "use_skill" => skill_unit(a),
        "code_graph" => code_graph_unit(a),
        "request_user_input" | "ask_user" | "handoff_user" => setup_item("Asking", "Asked", "user", false),
        "update_plan" => setup_item("Updating", "Updated", "plan", false),
        "list_mcp_resources" => setup_item("Listing", "Listed", "MCP resource", false),
        "list_mcp_resource_templates" => setup_item("Listing", "Listed", "MCP resource template", false),
        // legacy: old transcripts
        "cwd" => cwd_unit(a),
        "session" => session_unit(a),
        _ => return None,
    })
}

fn mcp_unit(name: &str, a: &Value) -> WorkUnit {
    let server = parse_mcp_tool_name(name).map(|mcp| mcp.server).unwrap_or_default();
    let noun = format!("{} tool", title_case_mcp_server(&server));
    counted_unit("MCP", a, &["query", "q", "text", "prompt", "path", "uri", "name", "id", "action"], &noun, "")
}

/// `toolWorkUnit(name, args, category)`: the work unit a call is counted in (`category` is the one already decided, else
/// empty).
pub fn tool_work_unit(name: &str, args: &Value, category: &str) -> WorkUnit {
    let a = parse_tool_args(args);
    if is_external_mcp_tool_name(name) {
        return mcp_unit(name, &a);
    }
    if let Some(found) = tool_unit(&normalize_tool_name(name), &a) {
        return found;
    }
    let category = if category.is_empty() { classify_tool_category(name, &a) } else { category.to_owned() };
    counted_unit(&category, &a, &["items", "targets", "query", "path", "name", "id", "action"], "", "")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn work(name: &str, args: Value) -> Value {
        tool_work_unit(name, &args, "").to_value()
    }

    #[test]
    fn categories_follow_the_table() {
        assert_eq!(classify_tool_category("read", &json!({})), "Read");
        assert_eq!(classify_tool_category("functions.bash", &json!({})), "Shell");
        assert_eq!(classify_tool_category("mcp__github__list", &json!({})), "MCP");
        assert_eq!(classify_tool_category("mcp__plugin_mixdog_mixdog__recall", &json!({})), "Memory");
        assert_eq!(classify_tool_category("code_graph", &json!({ "mode": "callers" })), "Search");
        assert_eq!(classify_tool_category("tool_search", &json!({})), "Load");
        assert_eq!(classify_tool_category("nonsense", &json!({})), "Other");
        assert_eq!(classify_tool_category("", &json!({})), "Other");
    }

    #[test]
    fn a_unit_takes_the_category_copy_where_it_names_nothing() {
        assert_eq!(
            work("read", json!({ "paths": ["a", "b"] })),
            json!({ "category": "Read", "active": "Reading", "done": "Read", "noun": "file", "pluralNoun": "files", "count": 2, "effect": false })
        );
        // The category's own plural stays when the unit names a noun of its own (Node's rule).
        assert_eq!(work("fetch", json!({ "limit": 3.7 }))["pluralNoun"], "queries");
        assert_eq!(work("fetch", json!({ "limit": 3.7 }))["count"], 3);
        assert_eq!(work("web_fetch", json!({ "urls": ["u", "v"] }))["pluralNoun"], "URLs");
        assert_eq!(work("mystery", json!({ "name": "x" }))["category"], "Other");
    }

    #[test]
    fn patches_count_per_kind() {
        let added = json!({ "patch": "*** Add File: a.txt\n+x\n*** Update File: b.txt\n@@\n*** Update File: c.txt" });
        let units = patch_mutation_units(&added);
        assert_eq!(units.iter().map(|u| (u.done.as_str(), u.count)).collect::<Vec<_>>(), vec![("Created", 1.0), ("Edited", 2.0)]);
        assert_eq!(work("apply_patch", added)["done"], "Changed");
        let git = json!({ "patch": "diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\ndiff --git a/y b/y\ndeleted file mode 100644" });
        assert_eq!(patch_operation_profile(&git), vec![("add".to_owned(), 1.0), ("delete".to_owned(), 1.0)]);
        assert_eq!(patch_operation_profile(&json!({ "old_string": "", "new_string": "x" })), vec![("add".to_owned(), 1.0)]);
        assert_eq!(patch_operation_profile(&json!({ "old_string": "x", "new_string": "" })), vec![("delete".to_owned(), 1.0)]);
        assert_eq!(work("apply_patch", json!({ "dry_run": true, "patch": "*** Add File: a" }))["done"], "Checked");
    }

    #[test]
    fn verbs_follow_the_action() {
        assert_eq!(work("task", json!({ "action": "wait", "task_id": "t" }))["done"], "Waited for");
        assert_eq!(work("agent", json!({ "type": "result", "status": "timeout" }))["done"], "Failed");
        assert_eq!(work("agent", json!({ "type": "close" }))["effect"], true);
        assert_eq!(work("github", json!({ "action": "pr.merge" }))["noun"], "PR");
        assert_eq!(work("github", json!({ "action": "nope" }))["noun"], "GitHub operation");
        assert_eq!(work("setup", json!({ "action": "install_model" }))["effect"], true);
        assert_eq!(work("session", json!({ "action": "favorite", "value": false }))["done"], "Unfavorited");
        assert_eq!(work("session", json!({ "path": "p" }))["noun"], "project");
        assert_eq!(work("tidy", json!({ "action": "fix", "apply": true }))["effect"], true);
        assert_eq!(work("office", json!({ "action": "rollback" }))["active"], "Rolling back");
        assert_eq!(work("mcp__playwright__click", json!({ "name": "go" }))["noun"], "Playwright tool");
    }
}
