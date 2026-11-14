//! The detail line of an aggregate card (`formatAggregateDetail` of `shared/tool-surface.mjs`): the per-call result summaries
//! merged into one line, exact repeats and same-kind counts folded, order preserved. It reads the update-summary parsers of
//! `results::summary`, so it is ported with them.

use mixdog_js::js_trim;
use mixdog_js::number_to_string;
use mixdog_js::string_to_number;

use crate::results::summary::LineDelta;
use crate::results::summary::UpdateSummary;
use crate::results::summary::format_line_delta;
use crate::results::summary::parse_update_summary;
use crate::tool_surface::STEP;

use std::sync::LazyLock;

use mixdog_js::JsRegex;

static READ_LINES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:Read\s+)?(\d+)\s+lines?$", "i"));
static READ_IMAGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:Read\s+)?image$", "i"));
static FOUND_COUNT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:Found\s+)?(\d+)\s+([a-z]+)$", "i"));
static UPDATED_DELTA: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:Updated(?:\s+-)?\s+)?\+(\d+)\s+-(\d+)$", "i"));
static SIBILANT_ES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:ch|sh|x|z|s)es$", ""));
static SIBILANT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:ch|sh|x|z|s)$", ""));

/// Normalises a plural noun to its singular so singular and plural variants of the same noun merge into one metric.
fn singular_noun(noun: &str) -> String {
    if let Some(stem) = noun.strip_suffix("ies") {
        return format!("{stem}y");
    }
    if SIBILANT_ES.is_match(noun) {
        return noun[..noun.len() - 2].to_owned();
    }
    noun.strip_suffix('s').unwrap_or(noun).to_owned()
}

fn plural_noun(singular: &str) -> String {
    if let Some(stem) = singular.strip_suffix('y') {
        return format!("{stem}ies");
    }
    if SIBILANT.is_match(singular) { format!("{singular}es") } else { format!("{singular}s") }
}

fn counted(count: f64, singular: &str, plural: &str) -> String {
    format!("{} {}", number_to_string(count), if count == 1.0 { singular } else { plural })
}

/// The files, counts and line deltas an update or check metric has folded in.
#[derive(Default)]
struct FileMetric {
    files: Vec<String>,
    file_count: f64,
    actions: Vec<String>,
    delta: LineDelta,
}

impl FileMetric {
    fn accumulate(&mut self, update: &UpdateSummary) {
        if !update.file.is_empty() && !self.files.contains(&update.file) {
            self.files.push(update.file.clone());
        }
        self.file_count += update.file_count;
        self.delta.added += update.added;
        self.delta.removed += update.removed;
        self.delta.seen = self.delta.seen || update.seen;
    }

    /// `mergedFileTarget`: one filename or a count.
    fn target(&self) -> String {
        let count = self.file_count + self.files.len() as f64;
        if count == 1.0 && self.file_count == 0.0 {
            return self.files[0].clone();
        }
        counted(count, "file", "files")
    }
}

enum Metric {
    ReadLines(f64),
    ReadImages(f64),
    Found { count: f64, singular: String, plural: String },
    Updated { added: f64, removed: f64 },
    CheckedFiles(FileMetric),
    UpdatedFiles(FileMetric),
}

enum Item {
    Metric(String),
    Extra(String),
}

/// `formatAggregateDetail`.
pub fn format_aggregate_detail(summaries: &[String]) -> String {
    format_aggregate_detail_steps(summaries, || {})
}

/// `formatAggregateDetailSteps`: the same pass, calling `yield_point` after every `STEP` summaries and every `STEP` rendered
/// parts.
pub fn format_aggregate_detail_steps(summaries: &[String], mut yield_point: impl FnMut()) -> String {
    if summaries.is_empty() {
        return String::new();
    }
    let mut metrics: Vec<(String, Metric)> = Vec::new();
    let mut order: Vec<Item> = Vec::new();
    let mut extras: Vec<String> = Vec::new();

    fn slot<'a>(metrics: &'a mut Vec<(String, Metric)>, order: &mut Vec<Item>, key: &str, initial: impl FnOnce() -> Metric) -> &'a mut Metric {
        let at = match metrics.iter().position(|(known, _)| known == key) {
            Some(at) => at,
            None => {
                metrics.push((key.to_owned(), initial()));
                order.push(Item::Metric(key.to_owned()));
                metrics.len() - 1
            }
        };
        &mut metrics[at].1
    }

    for (index, raw) in summaries.iter().enumerate() {
        if (index + 1) % STEP == 0 {
            yield_point();
        }
        let text = js_trim(raw);
        if text.is_empty() {
            continue;
        }
        if let Some(found) = READ_LINES.captures(text) {
            let n = string_to_number(found.get(1).unwrap_or_default());
            if let Metric::ReadLines(count) = slot(&mut metrics, &mut order, "read_lines", || Metric::ReadLines(0.0)) {
                *count += n;
            }
            continue;
        }
        if READ_IMAGE.is_match(text) {
            if let Metric::ReadImages(count) = slot(&mut metrics, &mut order, "read_images", || Metric::ReadImages(0.0)) {
                *count += 1.0;
            }
            continue;
        }
        if let Some(found) = FOUND_COUNT.captures(text) {
            // The canonical singular keys the metric, so "48 matches" and "1 match" merge into "49 matches".
            let singular = singular_noun(&mixdog_js::js_to_lowercase(found.get(2).unwrap_or_default()));
            let plural = plural_noun(&singular);
            let n = string_to_number(found.get(1).unwrap_or_default());
            let key = format!("found_{singular}");
            if let Metric::Found { count, .. } = slot(&mut metrics, &mut order, &key, || Metric::Found { count: 0.0, singular, plural }) {
                *count += n;
            }
            continue;
        }
        if let Some(found) = UPDATED_DELTA.captures(text) {
            let (a, r) = (string_to_number(found.get(1).unwrap_or_default()), string_to_number(found.get(2).unwrap_or_default()));
            if let Metric::Updated { added, removed } = slot(&mut metrics, &mut order, "updated", || Metric::Updated { added: 0.0, removed: 0.0 }) {
                *added += a;
                *removed += r;
            }
            continue;
        }
        let update = parse_update_summary(text);
        // Dry-run patch checks are validations, not edits: their line delta must NEVER be summed into the real edit total.
        // A delta-less "Checked ..." text (a task or memory summary) falls through to the extras unchanged.
        match &update {
            Some(update) if update.action == "Checked" => {
                if update.seen {
                    if let Metric::CheckedFiles(metric) = slot(&mut metrics, &mut order, "checked_files", || Metric::CheckedFiles(FileMetric::default())) {
                        metric.accumulate(update);
                    }
                    continue;
                }
            }
            Some(update) => {
                if let Metric::UpdatedFiles(metric) = slot(&mut metrics, &mut order, "updated_files", || Metric::UpdatedFiles(FileMetric::default())) {
                    if !metric.actions.contains(&update.action) {
                        metric.actions.push(update.action.clone());
                    }
                    metric.accumulate(update);
                }
                continue;
            }
            None => {}
        }
        if !text.is_empty() && !extras.iter().any(|known| known == text) {
            extras.push(text.to_owned());
            order.push(Item::Extra(text.to_owned()));
        }
    }

    let edit_delta = metrics
        .iter()
        .find_map(|(key, metric)| match metric {
            Metric::UpdatedFiles(files) if key == "updated_files" => Some(format_line_delta(&files.delta)),
            _ => None,
        })
        .unwrap_or_default();
    let render = |metric: &Metric| -> String {
        match metric {
            Metric::ReadLines(count) => counted(*count, "line", "lines"),
            Metric::ReadImages(count) => counted(*count, "image", "images"),
            Metric::Found { count, singular, plural } => counted(*count, singular, plural),
            Metric::Updated { added, removed } => format!("+{} -{}", number_to_string(*added), number_to_string(*removed)),
            Metric::CheckedFiles(files) => {
                let target = files.target();
                let delta = if edit_delta.is_empty() { format_line_delta(&files.delta) } else { String::new() };
                if delta.is_empty() { format!("Checked {target}") } else { format!("Checked {target} · {delta}") }
            }
            // The aggregate header already carries the action and file count, so the detail row shows only the merged line
            // delta; the action and target only when there is no delta to show (a pure create or delete).
            Metric::UpdatedFiles(files) => {
                let delta = format_line_delta(&files.delta);
                if !delta.is_empty() {
                    return delta;
                }
                let action = if files.actions.len() == 1 { files.actions[0].as_str() } else { "Updated" };
                format!("{action} {}", files.target())
            }
        }
    };
    let mut joined = String::new();
    for (index, item) in order.iter().enumerate() {
        if (index + 1) % STEP == 0 {
            yield_point();
        }
        let part = match item {
            Item::Metric(key) => metrics.iter().find(|(known, _)| known == key).map(|(_, metric)| render(metric)).unwrap_or_default(),
            Item::Extra(text) => text.clone(),
        };
        if !part.is_empty() {
            if !joined.is_empty() {
                joined.push_str(", ");
            }
            joined.push_str(&part);
        }
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(items: &[&str]) -> String {
        format_aggregate_detail(&items.iter().map(|item| (*item).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn counts_of_one_kind_merge() {
        assert_eq!(detail(&["3 lines", "Read 4 lines", "image", "1 match", "48 matches"]), "7 lines, 1 image, 49 matches");
        assert_eq!(detail(&["2 entries", "1 entry"]), "3 entries");
        assert_eq!(detail(&["Found 1 file", "2 files"]), "3 files");
    }

    #[test]
    fn edits_merge_and_checks_stay_apart() {
        assert_eq!(detail(&["+3 -1", "Updated +2 -0"]), "+5 -1");
        assert_eq!(detail(&["Updated a.rs · +3 -1", "Updated b.rs · +1 -0"]), "+4 lines · -1 line");
        assert_eq!(detail(&["Updated a.rs", "Created b.rs"]), "Updated 2 files");
        assert_eq!(detail(&["Deleted a.rs"]), "Deleted a.rs");
        assert_eq!(detail(&["Checked a.rs · +7 -5", "Updated b.rs · +1 -0"]), "Checked a.rs, +1 line");
        assert_eq!(detail(&["Checked a.rs · +7 -5"]), "Checked a.rs · +7 lines · -5 lines");
    }

    #[test]
    fn anything_else_is_kept_once_in_order() {
        assert_eq!(detail(&["Exit 1", "", "5 lines", "Exit 1", "other"]), "Exit 1, 5 lines, other");
        assert_eq!(detail(&[]), "");
    }

    #[test]
    fn stepped_passes_yield_per_step() {
        let many: Vec<String> = (0..40).map(|n| format!("extra {n}")).collect();
        let mut yields = 0;
        format_aggregate_detail_steps(&many, || yields += 1);
        assert_eq!(yields, 4);
    }
}
