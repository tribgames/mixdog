//! `code_graph` arguments as the model sends them: lists may arrive as arrays, comma/space
//! separated strings or JSON-encoded arrays; empty optional strings mean "absent".

use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub(super) struct Args {
    pub mode: String,
    pub file: Option<String>,
    pub files: Vec<String>,
    /// `files` arrived as a comma-separated string: too ambiguous to pick a project root.
    pub files_is_list_string: bool,
    pub symbols: Vec<String>,
    pub symbols_text: Option<String>,
    pub symbol: Option<String>,
    pub body: Option<bool>,
    pub limit: Option<f64>,
    pub depth: Option<f64>,
    pub page: Option<f64>,
    pub language: Option<String>,
    pub cwd: Option<String>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(v: &Value, key: &str) -> Option<f64> {
    match v.get(key)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// `["a","b"]` written as a string.
fn json_array_string(s: &str) -> Option<Vec<String>> {
    let t = s.trim();
    if !(t.starts_with('[') && t.ends_with(']')) {
        return None;
    }
    let parsed: Value = serde_json::from_str(t).ok()?;
    parsed.is_array().then(|| strings(&parsed))
}

fn dedupe(items: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

impl Args {
    pub fn parse(v: &Value) -> Args {
        let mut file = text(v, "file");
        let mut files: Vec<String> = Vec::new();
        let mut files_is_list_string = false;
        match v.get("files") {
            Some(Value::Array(_)) => files = strings(&v["files"]),
            Some(Value::String(s)) => match json_array_string(s) {
                Some(list) => files = list,
                None => {
                    files = s
                        .split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                        .collect();
                    files_is_list_string = s.contains(',');
                }
            },
            _ => {}
        }
        if let Some(list) = file.as_deref().and_then(json_array_string) {
            files = list.into_iter().chain(files).collect();
            file = None;
        }
        let (symbols, symbols_text) = match v.get("symbols") {
            Some(Value::Array(_)) => (strings(&v["symbols"]), None),
            Some(Value::String(s)) if !s.trim().is_empty() => (Vec::new(), Some(s.clone())),
            _ => (Vec::new(), None),
        };
        Args {
            mode: v.get("mode").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            file,
            files,
            files_is_list_string,
            symbols,
            symbols_text,
            symbol: text(v, "symbol"),
            body: v.get("body").and_then(Value::as_bool),
            limit: number(v, "limit"),
            depth: number(v, "depth"),
            page: number(v, "page"),
            language: text(v, "language"),
            cwd: text(v, "cwd"),
        }
    }

    /// Every symbol named by `symbols[]`, a `symbols` string or `symbol`, deduplicated.
    pub fn symbol_list(&self) -> Vec<String> {
        let split = |s: &str| {
            s.split(|c: char| c == ',' || c.is_whitespace())
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        dedupe(
            self.symbols
                .iter()
                .cloned()
                .chain(self.symbols_text.iter().flat_map(|s| split(s)))
                .chain(self.symbol.iter().flat_map(|s| split(s))),
        )
    }

    /// `file` plus `files`, deduplicated, `files` first.
    pub fn file_list(&self) -> Vec<String> {
        dedupe(self.files.iter().cloned().chain(self.file.iter().cloned()))
    }

    pub fn user_limit(&self) -> Option<usize> {
        self.limit
            .filter(|l| l.is_finite() && *l > 0.0)
            .map(|l| (l.floor() as usize).min(500))
    }

    pub fn with_file(&self, file: &str) -> Args {
        Args {
            file: Some(file.to_string()),
            files: Vec::new(),
            ..self.clone()
        }
    }

    pub fn with_symbol(&self, symbol: &str) -> Args {
        Args {
            symbol: Some(symbol.to_string()),
            symbols: Vec::new(),
            symbols_text: None,
            ..self.clone()
        }
    }
}
