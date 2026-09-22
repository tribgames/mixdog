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
use crate::scan_lang::ScanLang;

#[derive(Serialize)]
struct PositionJson {
    line: usize,
    column: usize,
}

#[derive(Serialize)]
struct RangeJson {
    start: PositionJson,
    end: PositionJson,
    #[serde(rename = "byteOffset")]
    byte_offset: [usize; 2],
}

#[derive(Serialize)]
struct MemberJson {
    #[serde(rename = "symbolType")]
    symbol_type: SymbolType,
    name: String,
    #[serde(rename = "isPublic")]
    is_public: bool,
    /// The member's declaration node, in the same shape and with the same
    /// semantics as the item-level `range`: 0-based lines and columns plus the
    /// byte span. A member whose declaration HAS a body (a class/impl method)
    /// spans the body too; a genuinely bodiless one (an interface or trait
    /// method signature, an `extern` declaration) spans the declaration alone,
    /// because that is the whole declaration the language gives it.
    range: RangeJson,
}

#[derive(Serialize)]
struct ItemJson {
    #[serde(rename = "symbolType")]
    symbol_type: SymbolType,
    name: String,
    range: RangeJson,
    #[serde(rename = "isImport")]
    is_import: bool,
    #[serde(rename = "isExported")]
    is_exported: bool,
    members: Vec<MemberJson>,
}

#[derive(Serialize)]
struct FileJson<'a> {
    file: String,
    lang: &'static str,
    items: Vec<ItemJson>,
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
) -> (Vec<ItemJson>, Vec<crate::calls::CallInfo>, Option<String>) {
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

/// `--outline` entry point: dump the raw outline items per file so rule
/// authors can validate a rule file against real sources, including the
/// grammars the ast-grep CLI cannot load (objc/zig/r). Never writes files.
pub fn run(root: &Path, args: &[String]) -> Result<(), crate::scan::ScanError> {
    use crate::scan::ScanError;
    use std::io::Write;

    let args = parse_args(args).map_err(ScanError::Usage)?;
    let mut errors: Vec<String> = rule_errors().to_vec();
    let mut extra_kinds = RULES.kinds.clone();
    let extra = load_extra_rules(args.rules.as_deref(), &mut extra_kinds)?;

    let files = if args.files.is_empty() {
        crate::scan::collect_scan_files(root).map_err(ScanError::Internal)?
    } else {
        crate::scan::selected_scan_files(root, &args.files).map_err(ScanError::Internal)?
    };

    // Extra rules are compiled per run and take precedence over the bundle.
    let mut combined: Vec<SerializableOutlineRule<ScanLang>> = Vec::new();
    if !extra.is_empty() {
        combined.extend(extra.iter().cloned());
        combined.extend(RULES.rules.iter().cloned());
    }
    let mut per_lang: HashMap<ScanLang, Arc<LangExtractors>> = HashMap::new();

    let stdout = std::io::stdout();
    let mut handle = std::io::BufWriter::new(stdout.lock());
    let mut item_count = 0usize;
    let mut file_count = 0usize;
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
                for error in &compiled.errors {
                    errors.push(error.clone());
                }
                per_lang.insert(file.lang, Arc::clone(&compiled));
                compiled
            }
        };
        if extractors.is_empty() {
            continue;
        }
        file_count += 1;
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
        let record = FileJson {
            file: file.rel.clone(),
            lang: file.lang.id(),
            items,
            calls: calls.iter().map(Into::into).collect(),
            error,
        };
        let line = serde_json::to_string(&record)
            .map_err(|error| ScanError::Internal(format!("serialize failed: {error}")))?;
        writeln!(handle, "{line}")
            .map_err(|error| ScanError::Internal(format!("stdout write failed: {error}")))?;
    }
    write_summary(&mut handle, file_count, item_count, errors)
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

fn outline_json(items: &[WalkedItem<'_>]) -> Vec<ItemJson> {
    let mut out: Vec<ItemJson> = items
        .iter()
        .map(|walked| {
            let item = &walked.item;
            let mut members: Vec<&ast_grep_outline::model::OutlineMember<'_>> =
                item.members.iter().collect();
            members.sort_by_key(|member| member.entry.range.byte_offset.start);
            ItemJson {
                symbol_type: item.entry.symbol_type,
                name: item.entry.name.to_string(),
                range: range_json(&item.entry.range),
                is_import: item.is_import,
                is_exported: item.is_exported,
                members: members
                    .into_iter()
                    .map(|member| MemberJson {
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
