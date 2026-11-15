//! The Core Memory picker and its add, edit and delete flow (`core-memory-picker.mjs` and `core-memory-picker/{core-rows,
//! entry-prompts,list-panels}.mjs`).
//!
//! The Esc-return target is per entry: the Settings row passes `returnTo`, the standalone `/memory` command passes none, and
//! Esc either reopens the caller or simply closes the picker. Nested reopens (entry actions, after an add, edit or delete) pass
//! nothing and inherit the entry context.

use mixdog_js::value_to_string;
use serde_json::{Map, Value, json};

use super::Extensions;
use super::panel::{Action, CoreEntry, ExtItem, ExtPanel, ExtensionsHost, Handler, claim, close_now};
use crate::slash::host::{Opener, PromptSurface, TextPrompt, Tone};
use crate::slash::notices::{truthy, value_text};
use crate::slash::parsers::parse_memory_core_rows;

/// The `returnTo` option of `openMemoryCorePicker`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReturnTo {
    /// The key is absent: the earlier entry's target stays.
    Inherit,
    /// `returnTo: null`: Esc just closes.
    Close,
    /// Esc reopens this opener.
    Opener(Opener),
}

/// A row `parseMemoryCoreRows` built, as a picker row.
fn core_item(row: &Value) -> ExtItem {
    let text = |key: &str| row.get(key).map(value_text).unwrap_or_default();
    let action = if row.get("_action").and_then(Value::as_str) == Some("core-entry") {
        Action::CoreEntry(Box::new(CoreEntry {
            id: row.get("_id").cloned().unwrap_or(Value::Null),
            index_revision: row.get("_indexRevision").cloned(),
            project_id: row.get("_projectId").cloned().unwrap_or(Value::Null),
            element: text("_element"),
            summary: text("_summary"),
            orig_element: text("_origElement"),
            orig_summary: text("_origSummary"),
        }))
    } else if row.get("_line").is_some_and(truthy) {
        Action::Line(text("_line"))
    } else {
        Action::Noop
    };
    let mut item = ExtItem::new(&text("value"), &text("label"), &text("description"), action);
    item.meta = text("meta");
    item
}

/// `loadCoreRows`: the one core-memory read both panels issue (`project_id: '*'` is the cross-project listing; `silent` keeps
/// the read out of the transcript). A store without `memoryControl` gives `None`: the loading frame simply stays.
fn load_core_rows(host: &mut dyn ExtensionsHost) -> Option<Result<Vec<ExtItem>, String>> {
    if !host.has_store_method("memoryControl") {
        return None;
    }
    let result = host.store_call("memoryControl", json!([{"action": "core", "op": "list", "project_id": "*"}, {"silent": true}]));
    Some(result.map(|result| {
        let text = if result.is_null() { String::new() } else { value_text(&result) };
        parse_memory_core_rows(&text).iter().map(core_item).collect()
    }))
}

/// The two rows of the Memory root panel: add, and the list with its count.
fn root_rows(rows: Vec<ExtItem>) -> Vec<ExtItem> {
    let empty = rows.is_empty();
    let mut list = ExtItem::new(
        "core-list",
        "Memory List",
        if empty { "no stored memories" } else { "open stored memories for edit/delete" },
        Action::CoreList(rows.clone()),
    );
    if !empty {
        list.meta = rows.len().to_string();
    }
    vec![ExtItem::new("core-add", "Add Memory", "store a new curated memory sentence", Action::AddCore), list]
}

/// A Memory panel's chrome: the sentence of the highlighted entry as footer, a narrow label column.
fn memory_panel(title: &str, description: &str, items: Vec<ExtItem>, handler: Handler) -> ExtPanel {
    ExtPanel { label_width: Some(12), entry_footer: true, ..ExtPanel::new(title, description, items, handler) }
}

fn entry_prompt(kind: &str, label: String, hint: &str, entry: Option<&CoreEntry>) -> TextPrompt {
    let mut prompt = TextPrompt::new(kind);
    prompt.label = label;
    prompt.hint = hint.to_owned();
    if let Some(entry) = entry {
        let mut fields = Map::new();
        fields.insert("_id".to_owned(), entry.id.clone());
        if let Some(revision) = &entry.index_revision {
            fields.insert("_indexRevision".to_owned(), revision.clone());
        }
        fields.insert("_projectId".to_owned(), entry.project_id.clone());
        prompt.fields = fields;
    }
    prompt
}

/// `beginAddCoreMemory()`: the keypress that opens the prompt owns the surface it clears.
pub fn begin_add(host: &mut dyn ExtensionsHost) {
    close_now(host);
    host.set_prompt(
        PromptSurface::Settings,
        Some(entry_prompt("core-add", "Add memory".to_owned(), "Type the memory sentence to store as a core memory.", None)),
    );
}

/// `beginEditCoreMemory(entry)`.
pub fn begin_edit(host: &mut dyn ExtensionsHost, entry: &CoreEntry) {
    close_now(host);
    let mut prompt = entry_prompt("core-edit", format!("Memory \u{b7} Edit #{}", value_to_string(&entry.id)), "Edit the memory sentence.", Some(entry));
    prompt.initial_value = Some(entry.sentence().to_owned());
    // Only rewrite `element` on edit when the row was already a single-sentence entry (element === summary at load time).
    // Otherwise element carries distinct legacy meaning and must survive untouched.
    prompt.fields.insert("_singleSentence".to_owned(), Value::Bool(entry.orig_element == entry.orig_summary));
    host.set_prompt(PromptSurface::Settings, Some(prompt));
}

/// `beginDeleteCoreMemory(entry)`.
pub fn begin_delete(host: &mut dyn ExtensionsHost, entry: &CoreEntry) {
    close_now(host);
    host.set_prompt(
        PromptSurface::Settings,
        Some(entry_prompt(
            "core-delete-confirm",
            format!("Memory \u{b7} Delete #{}?", value_to_string(&entry.id)),
            "Type \"y\" to delete this entry, or anything else to cancel.",
            Some(entry),
        )),
    );
}

impl Extensions {
    /// Esc on the Memory root: back to the caller, or just close.
    pub(super) fn close_memory_core(&mut self, host: &mut dyn ExtensionsHost) {
        match self.memory_escape {
            // Opening the caller can fail (an opener the application cannot serve): there is nothing to report to.
            Some(opener) => {
                let _ = host.open(opener, json!({}));
            }
            // Esc on the panel: this keypress owns the surface it clears.
            None => close_now(host),
        }
    }

    /// `openMemoryCorePicker(options)`: the loading frame first, then the root.
    pub fn open_memory_core(&mut self, host: &mut dyn ExtensionsHost, return_to: ReturnTo) {
        match return_to {
            ReturnTo::Inherit => {}
            ReturnTo::Close => self.memory_escape = None,
            ReturnTo::Opener(opener) => self.memory_escape = Some(opener),
        }
        // Every paint re-validates and re-arms the claim, so the loading frame can take the surface while a list (or failure
        // close) landing after Esc cannot touch it.
        let mut own = claim(host);
        host.paint(&mut own, Some(ExtPanel::loading("Memory", "Loading memories\u{2026}", Handler::MemoryRoot)));
        match load_core_rows(host) {
            None => {}
            Some(Ok(rows)) => {
                // Summary-first layout: entry rows carry the sentence in `description`, so the label column stays minimal and
                // the footer shows the full untruncated sentence of the highlighted row.
                let panel = memory_panel("Memory", "User-curated core memories across projects.", root_rows(rows), Handler::MemoryRoot);
                host.paint(&mut own, Some(panel));
            }
            Some(Err(error)) => {
                host.close_claim(&mut own);
                host.push_notice(&format!("core memory failed: {error}"), Tone::Error);
            }
        }
    }

    /// `openCoreMemoryListPicker(rows)`: the stored-memory list, from the rows the root already fetched or from its own read.
    pub(super) fn open_core_list(&mut self, host: &mut dyn ExtensionsHost, rows: Option<Vec<ExtItem>>) {
        let mut own = claim(host);
        let rows = match rows {
            Some(rows) => rows,
            None => {
                host.paint(&mut own, Some(ExtPanel::loading("Memory \u{b7} List", "Loading memories\u{2026}", Handler::MemoryList)));
                match load_core_rows(host) {
                    None => return,
                    Some(Ok(rows)) => rows,
                    Some(Err(error)) => {
                        host.close_claim(&mut own);
                        host.push_notice(&format!("core memory failed: {error}"), Tone::Error);
                        return;
                    }
                }
            }
        };
        let (description, items) = if rows.is_empty() {
            ("No stored memories yet.", vec![ExtItem::new("empty", "Memory", "empty", Action::Noop)])
        } else {
            ("Select a memory to edit or delete.", rows)
        };
        host.paint(&mut own, Some(memory_panel("Memory \u{b7} List", description, items, Handler::MemoryList)));
    }

    /// `openCoreEntryActionsPicker(entry)`: a synchronous panel for an Enter on a list row.
    pub(super) fn open_core_entry_actions(&mut self, host: &mut dyn ExtensionsHost, entry: &CoreEntry) {
        let mut own = claim(host);
        let items = vec![
            ExtItem::new("delete", "Delete", "remove this entry (confirm)", Action::Delete),
            ExtItem::new("edit", "Edit", "rewrite this memory sentence", Action::Edit),
        ];
        let title = format!("Memory \u{b7} #{}", value_to_string(&entry.id));
        host.paint(&mut own, Some(ExtPanel::new(&title, entry.sentence(), items, Handler::MemoryEntry(Box::new(entry.clone())))));
    }
}
