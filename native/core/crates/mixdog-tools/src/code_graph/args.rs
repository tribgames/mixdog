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
    /// `file` was a truthy value other than a string: Node resolves it as a path and throws Node's
    /// `ERR_INVALID_ARG_TYPE` text, this one.
    pub file_type_error: Option<String>,
}

/// JS `String(value || '')` of a `files` entry, as `_collectGraphFileList` reads it.
fn js_string_or_empty(v: &Value) -> String {
    let falsy = match v {
        Value::Null | Value::Bool(false) => true,
        Value::Number(n) => n.as_f64().is_none_or(|f| f == 0.0 || f.is_nan()),
        Value::String(s) => s.is_empty(),
        _ => false,
    };
    if falsy { String::new() } else { mixdog_js::value_to_string(v) }
}

/// Node's `ERR_INVALID_ARG_TYPE` for a truthy `file` that is not a string (`path.isAbsolute(file)`).
fn file_type_error(v: &Value) -> Option<String> {
    let received = match v {
        Value::Array(_) => "an instance of Array".to_owned(),
        Value::Object(_) => "an instance of Object".to_owned(),
        Value::Bool(true) => "type boolean (true)".to_owned(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or_default();
            if f == 0.0 || f.is_nan() {
                return None;
            }
            format!("type number ({})", mixdog_js::number_to_string(f))
        }
        _ => return None,
    };
    Some(format!("The \"path\" argument must be of type string. Received {received}"))
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
            Some(Value::Array(items)) => {
                files = items.iter().map(|f| mixdog_js::js_trim(&js_string_or_empty(f)).to_owned()).filter(|f| !f.is_empty()).collect();
            }
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
            file_type_error: v.get("file").and_then(file_type_error),
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
