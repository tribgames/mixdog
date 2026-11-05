//! Function-length summary for a check/fix run. Spans come from the code-graph engine's outline
//! records (the rows `code_graph mode:"symbols"` prints as `kind name (Lstart-end)`), so the counts
//! match what the graph reports. Reading the graph is behind [`OutlineSource`].

use std::collections::HashMap;
use std::path::Path;

use async_trait::async_trait;
use serde_json::{Value, json};

const FILE_BATCH: usize = 200;
const LONGEST_COUNT: usize = 5;

#[async_trait]
pub trait OutlineSource: Send + Sync {
    /// Outline records (`{rel, lang, symbols:[{kind,name,startLine,endLine}]}`) for the files.
    async fn outline(&self, cwd: &Path, rels: &[String]) -> Result<Vec<Value>, String>;
}

fn has_span(symbol: &Value) -> bool {
    ["startLine", "endLine"].iter().all(|k| symbol.get(*k).is_some_and(|v| v.as_f64().is_some()))
}

fn extension(rel: &str) -> String {
    Path::new(rel).extension().map_or_else(|| "unknown".to_owned(), |e| format!(".{}", e.to_string_lossy()))
}

/// Counts functions over 50/100/150 lines in `files` (project-relative). Files whose language
/// emits no spans are listed under `notMeasured`, never counted as short.
pub async fn summarize_function_lengths(source: &dyn OutlineSource, cwd: &Path, files: &[String]) -> Value {
    let mut functions: Vec<(String, String, i64)> = Vec::new();
    let mut spanned = std::collections::HashSet::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    for chunk in files.chunks(FILE_BATCH) {
        let records = match source.outline(cwd, chunk).await {
            Ok(r) => r,
            Err(e) => return json!({"measured": false, "note": format!("function lengths not measured: {e}")}),
        };
        for record in records {
            let rel = record["rel"].as_str().unwrap_or("").replace('\\', "/");
            let language = record["lang"].as_str().filter(|l| !l.is_empty()).map_or_else(|| extension(&rel), str::to_owned);
            seen.insert(rel.clone(), language.clone());
            let symbols = record["symbols"].as_array().cloned().unwrap_or_default();
            if symbols.iter().any(has_span) {
                spanned.insert(language);
            }
            for s in symbols.iter().filter(|s| matches!(s["kind"].as_str(), Some("function" | "method" | "constructor")) && has_span(s)) {
                functions.push((rel.clone(), s["name"].as_str().unwrap_or("").to_owned(), s["endLine"].as_f64().unwrap_or(0.0) as i64 - s["startLine"].as_f64().unwrap_or(0.0) as i64 + 1));
            }
        }
    }
    for file in files {
        let rel = file.replace('\\', "/");
        seen.entry(rel.clone()).or_insert_with(|| extension(&rel));
    }
    let mut not_measured: Vec<String> = seen.values().filter(|l| !spanned.contains(*l)).cloned().collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    not_measured.sort();
    let over = |limit: i64| functions.iter().filter(|f| f.2 > limit).count();
    let total = functions.len();
    let (o50, o100, o150) = (over(50), over(100), over(150));
    functions.sort_by(|a, b| b.2.cmp(&a.2));
    let mut out = json!({
        "measured": true, "functions": total, "over50": o50, "over100": o100, "over150": o150,
        "longest": functions.iter().take(LONGEST_COUNT).map(|f| json!({"path": f.0, "name": f.1, "lines": f.2})).collect::<Vec<_>>(),
    });
    if !not_measured.is_empty() {
        out["notMeasured"] = json!(not_measured);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Result<Vec<Value>, String>);
    #[async_trait]
    impl OutlineSource for Fixed {
        async fn outline(&self, _: &Path, _: &[String]) -> Result<Vec<Value>, String> {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn long_functions_are_counted_and_spanless_languages_are_not_called_short() {
        let sym = |name: &str, start: i64, end: i64| json!({"kind": "function", "name": name, "startLine": start, "endLine": end});
        let records = vec![
            json!({"rel": "a.ts", "lang": "typescript", "symbols": [sym("big", 1, 160), sym("mid", 1, 60), sym("tiny", 1, 3), {"kind": "class", "name": "C", "startLine": 1, "endLine": 999}]}),
            json!({"rel": "b.sol", "lang": "solidity", "symbols": [{"kind": "function", "name": "f"}]}),
        ];
        let out = summarize_function_lengths(&Fixed(Ok(records)), Path::new("/r"), &["a.ts".into(), "b.sol".into(), "c.txt".into()]).await;
        assert_eq!((out["functions"].clone(), out["over50"].clone(), out["over100"].clone(), out["over150"].clone()), (json!(3), json!(2), json!(1), json!(1)));
        assert_eq!(out["longest"][0], json!({"path": "a.ts", "name": "big", "lines": 160}));
        assert_eq!(out["notMeasured"], json!([".txt", "solidity"]));
    }

    #[tokio::test]
    async fn a_failing_graph_is_reported_not_thrown() {
        let out = summarize_function_lengths(&Fixed(Err("no graph".into())), Path::new("/r"), &["a.ts".into()]).await;
        assert_eq!(out, json!({"measured": false, "note": "function lengths not measured: no graph"}));
    }
}
