// `--outline`: the raw outline dump rule authors validate a rule file with.
//
// It reports what the walk produced — items, their members and the call sites
// — per file as JSON lines plus a summary line, and it never writes files. The
// `--rules` flag compiles extra rules for this run only, ahead of the bundle.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::AstGrep;
use ast_grep_outline::extractor::SerializableOutlineRule;
use ast_grep_outline::model::SymbolType;
use serde::Serialize;

use super::extractors::{extractors_for, LangExtractors, WalkedItem};
use super::rules::{parse_rule_stream, rule_errors, DeclaredKind, RULES};
use super::symbols::map_items;
use crate::scan::{PositionJson, RangeJson};
use crate::scan_lang::ScanLang;

/// One member of an outline item (a method, a field, an interface signature).
#[derive(Serialize)]
pub struct OutlineMember {
    #[serde(rename = "symbolType")]
    pub symbol_type: SymbolType,
    pub name: String,
    #[serde(rename = "isPublic")]
    pub is_public: bool,
    /// The member's declaration node, in the same shape and with the same
    /// semantics as the item-level `range`: 0-based lines and columns plus the
    /// byte span. A member whose declaration HAS a body (a class/impl method)
    /// spans the body too; a genuinely bodiless one (an interface or trait
    /// method signature, an `extern` declaration) spans the declaration alone,
    /// because that is the whole declaration the language gives it.
    pub range: RangeJson,
}

/// One top-level item of a file's outline, ordered by position in the file.
#[derive(Serialize)]
pub struct OutlineItem {
    #[serde(rename = "symbolType")]
    pub symbol_type: SymbolType,
    pub name: String,
    pub range: RangeJson,
    #[serde(rename = "isImport")]
    pub is_import: bool,
    #[serde(rename = "isExported")]
    pub is_exported: bool,
    pub members: Vec<OutlineMember>,
}

/// What the outline walk produced for one file.
pub struct FileOutline {
    /// Project-relative path.
    pub file: String,
    /// The scan language id (`rust`, `typescript`, …).
    pub lang: &'static str,
    pub items: Vec<OutlineItem>,
    pub calls: Vec<crate::calls::CallInfo>,
    /// The read or parse failure that left `items` and `calls` empty.
    pub error: Option<String>,
}

/// The outline of a set of files: the same data `--outline` prints, one record per file whose
/// language has outline rules, plus the rule and file errors collected on the way.
pub struct OutlineReport {
    pub files: Vec<FileOutline>,
    pub item_count: usize,
    pub errors: Vec<String>,
}

#[derive(Serialize)]
struct FileJson<'a> {
    file: String,
    lang: &'static str,
    items: Vec<OutlineItem>,
    /// Call sites in the READABLE object form (`CallDebug`), not the
    /// positional wire tuple a FileRecord carries: `--outline` exists so rule
    /// authors can validate a rule against real sources, and a tuple hides
    /// which field is which.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    calls: Vec<crate::calls::CallDebug<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct OutlineSummaryBody {
    files: usize,
    items: usize,
    errors: Vec<String>,
}

#[derive(Serialize)]
struct OutlineSummaryLine {
    summary: OutlineSummaryBody,
}

const USAGE: &str = "usage: mixdog-graph <cwd> --outline [--rules <path|->] [--files <rel>...]";

struct OutlineArgs {
    rules: Option<String>,
    files: Vec<String>,
}

fn parse_args(args: &[String]) -> Result<OutlineArgs, String> {
    let mut rules = None;
    let mut files = Vec::new();
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--rules" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return Err(format!("--rules needs a path or `-`\n{USAGE}"));
                };
                rules = Some(value.clone());
                index += 1;
            }
            "--files" => {
                index += 1;
                while let Some(value) = args.get(index) {
                    if value.starts_with("--") {
                        break;
                    }
                    files.push(value.clone());
                    index += 1;
                }
            }
            other => return Err(format!("unknown outline argument `{other}`\n{USAGE}")),
        }
    }
    Ok(OutlineArgs { rules, files })
}

/// Compile the `--rules` file for this run: its parse errors are usage
/// errors, and the kind markers it declares join the bundle's for this run
/// only. No `--rules` means no extra rules, not an empty rule file.
fn load_extra_rules(
    spec: Option<&str>,
    extra_kinds: &mut HashMap<String, DeclaredKind>,
) -> Result<Vec<SerializableOutlineRule<ScanLang>>, crate::scan::ScanError> {
    use crate::scan::ScanError;

    let Some(spec) = spec else {
        return Ok(Vec::new());
    };
    let text = crate::scan::read_rule_text(spec).map_err(ScanError::Usage)?;
    let mut parsed = Vec::new();
    let mut parse_errors = Vec::new();
    parse_rule_stream(&text, spec, &mut parsed, extra_kinds, &mut parse_errors);
    if !parse_errors.is_empty() {
        return Err(ScanError::Usage(parse_errors.join("\n")));
    }
    Ok(parsed)
}

/// One file's outline: its JSON items, the call sites the same walk produced,
/// and the read or parse failure that leaves both empty.
fn outline_file(
    path: &Path,
    lang: ScanLang,
    graph_lang: &str,
    extractors: &LangExtractors,
) -> (Vec<OutlineItem>, Vec<crate::calls::CallInfo>, Option<String>) {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            return (
                Vec::new(),
                Vec::new(),
                Some(format!("read failed: {error}")),
            )
        }
    };
    let ast = match AstGrep::<StrDoc<ScanLang>>::try_new(&text, lang) {
        Ok(ast) => ast,
        Err(error) => {
            return (
                Vec::new(),
                Vec::new(),
                Some(format!("parse failed: {error}")),
            )
        }
    };
    let walked = extractors.extract(ast.root(), &text);
    let json = outline_json(&walked.items);
    let calls = map_items(walked, &text, graph_lang)
        .calls
        .unwrap_or_default();
    (json, calls, None)
}

/// The summary line every `--outline` run ends with, and the flush that makes
/// the whole dump readable by the caller.
fn write_summary(
    handle: &mut impl std::io::Write,
    file_count: usize,
    item_count: usize,
    errors: Vec<String>,
) -> Result<(), crate::scan::ScanError> {
    use crate::scan::ScanError;

    let summary = OutlineSummaryLine {
        summary: OutlineSummaryBody {
            files: file_count,
            items: item_count,
            errors,
        },
    };
    let line = serde_json::to_string(&summary)
        .map_err(|error| ScanError::Internal(format!("serialize failed: {error}")))?;
    writeln!(handle, "{line}")
        .map_err(|error| ScanError::Internal(format!("stdout write failed: {error}")))?;
    handle
        .flush()
        .map_err(|error| ScanError::Internal(format!("stdout flush failed: {error}")))
}

/// The outline of `rels` (project-relative paths; all scannable files under `root` when empty).
/// `rules` is an optional extra rule file (a path or `-`) compiled for this call only, ahead of
/// the bundle. Never writes files. This is what `--outline` prints, as records: the CLI
/// serialises exactly this report.
pub fn outline_files(
    root: &Path,
    rels: &[String],
    rules: Option<&str>,
) -> Result<OutlineReport, crate::scan::ScanError> {
    use crate::scan::ScanError;

    let mut errors: Vec<String> = rule_errors().to_vec();
    let mut extra_kinds = RULES.kinds.clone();
    let extra = load_extra_rules(rules, &mut extra_kinds)?;

    let files = if rels.is_empty() {
        crate::scan::collect_scan_files(root).map_err(ScanError::Internal)?
    } else {
        crate::scan::selected_scan_files(root, rels).map_err(ScanError::Internal)?
    };

    // Extra rules are compiled per run and take precedence over the bundle.
    let mut combined: Vec<SerializableOutlineRule<ScanLang>> = Vec::new();
    if !extra.is_empty() {
        combined.extend(extra.iter().cloned());
        combined.extend(RULES.rules.iter().cloned());
    }
    let mut per_lang: HashMap<ScanLang, Arc<LangExtractors>> = HashMap::new();

    let mut item_count = 0usize;
    let mut records: Vec<FileOutline> = Vec::new();
    for file in &files {
        let extractors = match per_lang.get(&file.lang) {
            Some(found) => Arc::clone(found),
            None => {
                let compiled = if combined.is_empty() {
                    extractors_for(file.lang)
                } else {
                    Arc::new(LangExtractors::compile(file.lang, &combined, &extra_kinds))
                };
                // Rules that parsed but cannot run are the rule author's
                // problem: report them once per language.
                errors.extend(compiled.errors.iter().cloned());
                per_lang.insert(file.lang, Arc::clone(&compiled));
                compiled
            }
        };
        if extractors.is_empty() {
            continue;
        }
        let graph_lang = file
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(crate::scan_lang::graph_lang_for_ext)
            .unwrap_or_default();
        let (items, calls, error) = outline_file(&file.path, file.lang, graph_lang, &extractors);
        if let Some(error) = &error {
            errors.push(format!("{}: {error}", file.rel));
        }
        item_count += items.len();
        records.push(FileOutline {
            file: file.rel.clone(),
            lang: file.lang.id(),
            items,
            calls,
            error,
        });
    }
    Ok(OutlineReport {
        files: records,
        item_count,
        errors,
    })
}

/// `--outline` entry point: dump the raw outline items per file so rule
/// authors can validate a rule file against real sources, including the
/// grammars the ast-grep CLI cannot load (objc/zig/r). Never writes files.
pub fn run(root: &Path, args: &[String]) -> Result<(), crate::scan::ScanError> {
    use crate::scan::ScanError;
    use std::io::Write;

    let args = parse_args(args).map_err(ScanError::Usage)?;
    let report = outline_files(root, &args.files, args.rules.as_deref())?;
    let stdout = std::io::stdout();
    let mut handle = std::io::BufWriter::new(stdout.lock());
    let file_count = report.files.len();
    for file in report.files {
        let record = FileJson {
            file: file.file,
            lang: file.lang,
            items: file.items,
            calls: file.calls.iter().map(Into::into).collect(),
            error: file.error,
        };
        let line = serde_json::to_string(&record)
            .map_err(|error| ScanError::Internal(format!("serialize failed: {error}")))?;
        writeln!(handle, "{line}")
            .map_err(|error| ScanError::Internal(format!("stdout write failed: {error}")))?;
    }
    write_summary(&mut handle, file_count, report.item_count, report.errors)
}

/// An item's and a member's range are the same thing — the span of the node
/// its rule matched — so one renderer serves both.
fn range_json(range: &ast_grep_outline::model::SourceRange) -> RangeJson {
    RangeJson {
        start: PositionJson {
            line: range.start.line,
            column: range.start.column,
        },
        end: PositionJson {
            line: range.end.line,
            column: range.end.column,
        },
        byte_offset: [range.byte_offset.start, range.byte_offset.end],
    }
}

fn outline_json(items: &[WalkedItem<'_>]) -> Vec<OutlineItem> {
    let mut out: Vec<OutlineItem> = items
        .iter()
        .map(|walked| {
            let item = &walked.item;
            let mut members: Vec<&ast_grep_outline::model::OutlineMember<'_>> =
                item.members.iter().collect();
            members.sort_by_key(|member| member.entry.range.byte_offset.start);
            OutlineItem {
                symbol_type: item.entry.symbol_type,
                name: item.entry.name.to_string(),
                range: range_json(&item.entry.range),
                is_import: item.is_import,
                is_exported: item.is_exported,
                members: members
                    .into_iter()
                    .map(|member| OutlineMember {
                        symbol_type: member.entry.symbol_type,
                        name: member.entry.name.to_string(),
                        is_public: member.is_public,
                        range: range_json(&member.entry.range),
                    })
                    .collect(),
            }
        })
        .collect();
    out.sort_by_key(|item| item.range.byte_offset[0]);
    out
}
