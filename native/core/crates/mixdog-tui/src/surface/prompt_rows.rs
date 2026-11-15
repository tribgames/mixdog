//! The row counts the prompt box and the text-entry panel reserve (`app/text-layout.mjs` row reservation and
//! `app/use-prompt-layout-rows.mjs`).
//!
//! The wrap arithmetic itself (`wrappedTextRows`, `wrappedDetailRows`, `textEntryReservedRows`) is the widgets' own
//! (`mixdog_tui_widgets::text_layout`); this module adds the two reservations only the shell layout makes and keeps the
//! row counts in step with the draft.

use mixdog_termtext::policy::display_width;
use mixdog_termtext::wrap::{WrapOptions, wrap_ansi};
use mixdog_tui_widgets::text_layout::{text_entry_reserved_rows, wrapped_text_rows};

use super::signature::CORE_MULTILINE_TEXT_ENTRY_KINDS;

/// The rows a multiline text entry may take at most.
const TEXT_ENTRY_MAX_ROWS: usize = 8;
/// The label in front of a multiline text entry's value.
const TEXT_ENTRY_LABEL: &str = "Sentence > ";
/// The frame columns the text-entry panel's border and padding take.
const TEXT_ENTRY_FRAME_COLUMNS: usize = 4;

/// The last answer of [`prompt_content_rows`]: the layout asks for the same draft at the same width on every render.
#[derive(Clone, Debug, Default)]
pub struct PromptRowsCache {
    entry: Option<(String, usize, usize)>,
}

impl PromptRowsCache {
    /// `promptContentRows(value, contentColumns)`: the rows the prompt draft takes at `content_columns` columns. The editor
    /// appends a blank trailing cell when the caret is at the end of the input so the native cursor always has a cell; the
    /// layout does not own the caret offset, so it reserves for the worst common case. That can over-reserve one row at an
    /// exact wrap boundary but never under-reserves, which keeps transcript rows out of the prompt box.
    pub fn content_rows(&mut self, value: &str, content_columns: usize) -> usize {
        let width = content_columns.max(1);
        if let Some((text, cached_width, rows)) = &self.entry {
            if *cached_width == width && text == value {
                return *rows;
            }
        }
        let rows = wrapped_text_rows(&format!("{value} "), width);
        self.entry = Some((value.to_owned(), width, rows));
        rows
    }
}

/// `queuedBandRows(text, width)`: the rows one queued steering band takes when its full text renders wrapped at `width`
/// content columns (the same wrap call the renderer uses, so the reservation matches the rendered height).
pub fn queued_band_rows(text: &str, width: usize) -> usize {
    if text.is_empty() {
        return 1;
    }
    wrap_ansi(text, width.max(1), WrapOptions { hard: true, trim: false, word_wrap: true }).split('\n').count().max(1)
}

/// The row counts of the editable prompt and of a multiline text entry, and the draft they were computed from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptLayoutRows {
    value: String,
    prompt_rows: usize,
    text_entry_rows: usize,
}

impl Default for PromptLayoutRows {
    fn default() -> Self {
        Self { value: String::new(), prompt_rows: 1, text_entry_rows: 1 }
    }
}

impl PromptLayoutRows {
    pub fn new() -> Self {
        Self::default()
    }

    /// `promptLayoutValueRef.current`: the draft the shell layout reserves rows for.
    pub fn value(&self) -> &str {
        &self.value
    }

    /// The rows of the draft at the last width it was synced for.
    pub fn prompt_rows(&self) -> usize {
        self.prompt_rows
    }

    /// The rows a multiline text entry reserves.
    pub fn text_entry_rows(&self) -> usize {
        self.text_entry_rows
    }

    /// `syncPromptLayoutRows(value)`: records the draft and its wrapped height at `prompt_content_columns`. True when the row
    /// count changed (the layout has to run again).
    pub fn sync(&mut self, value: &str, prompt_content_columns: usize, cache: &mut PromptRowsCache) -> bool {
        self.value = value.to_owned();
        let rows = cache.content_rows(value, prompt_content_columns);
        let changed = rows != self.prompt_rows;
        self.prompt_rows = rows;
        changed
    }

    /// The effect that follows the content width: the same draft at the new width.
    pub fn resync(&mut self, prompt_content_columns: usize, cache: &mut PromptRowsCache) -> bool {
        let value = std::mem::take(&mut self.value);
        self.sync(&value, prompt_content_columns, cache)
    }

    /// The effect that follows the text-entry prompt: one row for every kind but the multiline core memory ones, which
    /// reserve their wrapped value up to eight rows. True when the count changed.
    pub fn sync_text_entry(&mut self, kind: &str, initial_value: &str, frame_columns: usize) -> bool {
        let rows = if CORE_MULTILINE_TEXT_ENTRY_KINDS.contains(&kind) {
            let columns = frame_columns.saturating_sub(TEXT_ENTRY_FRAME_COLUMNS + display_width(TEXT_ENTRY_LABEL)).max(1);
            text_entry_reserved_rows(initial_value, columns, TEXT_ENTRY_MAX_ROWS)
        } else {
            1
        };
        let changed = rows != self.text_entry_rows;
        self.text_entry_rows = rows;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_reserves_a_cell_for_the_caret_at_the_end() {
        let mut cache = PromptRowsCache::default();
        assert_eq!(cache.content_rows("", 10), 1);
        assert_eq!(cache.content_rows("abcdefghi", 10), 1);
        assert_eq!(cache.content_rows("abcdefghij", 10), 2, "a full row has no cell left for the caret");
        assert_eq!(cache.content_rows("a\nb\n", 10), 3);
        assert_eq!(cache.content_rows("abc", 0), 4, "a width below one is one");
    }

    #[test]
    fn a_wide_glyph_moves_whole_to_the_next_row() {
        let mut cache = PromptRowsCache::default();
        assert_eq!(cache.content_rows("가나다", 5), 2);
    }

    #[test]
    fn the_cache_answers_for_the_value_and_width_it_was_asked() {
        let mut cache = PromptRowsCache::default();
        assert_eq!(cache.content_rows("abcdefghij", 10), 2);
        assert_eq!(cache.content_rows("abcdefghij", 10), 2);
        assert_eq!(cache.content_rows("abcdefghij", 20), 1);
        assert_eq!(cache.content_rows("abcdefghi", 10), 1);
    }

    #[test]
    fn a_queued_band_takes_its_wrapped_height() {
        assert_eq!(queued_band_rows("", 10), 1);
        assert_eq!(queued_band_rows("short", 10), 1);
        assert_eq!(queued_band_rows("aaaaaaaaaaaaaaaaaaaaaaaaa", 10), 3);
        assert_eq!(queued_band_rows("one\ntwo\nthree", 10), 3);
        assert_eq!(queued_band_rows("abc", 0), 3);
    }

    #[test]
    fn syncing_records_the_draft_and_reports_a_changed_height() {
        let mut cache = PromptRowsCache::default();
        let mut rows = PromptLayoutRows::new();
        assert!(!rows.sync("hello", 20, &mut cache));
        assert_eq!(rows.value(), "hello");
        assert!(rows.sync(&"x".repeat(40), 20, &mut cache));
        assert_eq!(rows.prompt_rows(), 3);
        assert!(!rows.sync(&"y".repeat(40), 20, &mut cache));
    }

    #[test]
    fn a_new_width_resyncs_the_same_draft() {
        let mut cache = PromptRowsCache::default();
        let mut rows = PromptLayoutRows::new();
        rows.sync(&"x".repeat(40), 20, &mut cache);
        assert!(rows.resync(80, &mut cache));
        assert_eq!(rows.prompt_rows(), 1);
        assert_eq!(rows.value(), "x".repeat(40));
    }

    #[test]
    fn only_the_multiline_core_memory_entries_reserve_more_than_a_row() {
        let mut rows = PromptLayoutRows::new();
        assert!(!rows.sync_text_entry("oauth-code", &"w ".repeat(200), 40));
        assert_eq!(rows.text_entry_rows(), 1);
        assert!(rows.sync_text_entry("core-add", &"x".repeat(60), 40));
        assert_eq!(rows.text_entry_rows(), 3, "25 columns for the value: 61 cells");
        assert!(rows.sync_text_entry("core-edit", &"x".repeat(1000), 40));
        assert_eq!(rows.text_entry_rows(), 8, "capped");
        assert!(rows.sync_text_entry("project-new", "", 40));
        assert_eq!(rows.text_entry_rows(), 1);
    }

    #[test]
    fn a_narrow_frame_still_reserves_a_column() {
        let mut rows = PromptLayoutRows::new();
        rows.sync_text_entry("core-add", "abc", 10);
        assert_eq!(rows.text_entry_rows(), 4);
    }
}
