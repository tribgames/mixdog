//! `test-suite/scripts/inventory.mjs`: a read-only inventory of a project's test files across JS/TS, Python, Go
//! and Rust (lane, area, risk markers and skip records), printed as Markdown or, with `--json`, as JSON. It never
//! writes files, never follows links and never runs anything.
//!
//! The walk is bounded (depth, directories, files, bytes read per file, entries listed) exactly as the script is.
//! Directory entries are visited in the order the file system lists them, as Node's `readdirSync` returns them:
//! sorted by name where libuv sorts (everywhere but Windows), in the volume's own order on Windows.

use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;

use mixdog_fsio::DirEntry;
use mixdog_fsio::ReadProof;
use mixdog_js::Caps;
use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::json_stringify_indent;
use mixdog_js::locale_compare;
use mixdog_js::nodepath;
use serde_json::Map;
use serde_json::Value;

use crate::Outcome;
use crate::node_fs_message;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "out",
    "build",
    "target",
    "vendor",
    "third_party",
    "venv",
    ".venv",
    "site-packages",
    "__pycache__",
    ".tox",
    ".nox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".runtime",
    "coverage",
    ".gradle",
];
pub const MAX_FILES: usize = 20_000;
pub const MAX_DIRS: usize = 50_000;
pub const MAX_DEPTH: usize = 40;
pub const MAX_BYTES: u64 = 1 << 20;
pub const LIST_LIMIT: usize = 200;

const JS_EXT: &str = r"(?:m?[jt]s|c[jt]s|[jt]sx)";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Js,
    Python,
    Go,
    Rust,
}

impl Lang {
    fn name(self) -> &'static str {
        match self {
            Lang::Js => "js",
            Lang::Python => "python",
            Lang::Go => "go",
            Lang::Rust => "rust",
        }
    }
}

struct Markers {
    comment: &'static str,
    fake: JsRegex,
    markers: Vec<(&'static str, JsRegex)>,
}

struct Patterns {
    js_test: JsRegex,
    js_file: JsRegex,
    types_file: JsRegex,
    rust_test: JsRegex,
    js_skip_reason: JsRegex,
    js_skip_bare: JsRegex,
    js_skip_if: JsRegex,
    py_skip: JsRegex,
    go_skip: JsRegex,
    rust_ignore: JsRegex,
    rust_cfg_ignore: JsRegex,
    capability: JsRegex,
    tracked: JsRegex,
    until: JsRegex,
    lane: JsRegex,
    py_file: JsRegex,
    comment_line: JsRegex,
    slash_comment_line: JsRegex,
    py_keyword: JsRegex,
    py_positional_conditional: JsRegex,
    py_positional: JsRegex,
    quoted: JsRegex,
    langs: [Markers; 4],
}

fn re(pattern: &str, flags: &str) -> JsRegex {
    JsRegex::new_static(pattern, flags)
}

static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    js_test: re(&format!(r"(?:\.(?:test|spec)\.{JS_EXT}|-test\.m?js)$"), ""),
    js_file: re(&format!(r"\.{JS_EXT}$"), ""),
    types_file: re(r"\.d\.[cm]?ts$", ""),
    rust_test: re(r"#\[\s*(?:cfg\(\s*test\s*\)|test|tokio::test|rstest)\b", ""),
    // `skip: cond && 'reason'` keeps the reason after the last `&&`.
    js_skip_reason: re(r##"\bskip\s*(?::|\()\s*(?:[^\n]*?&&\s*)?(['"`])((?:(?!\1).)*)\1"##, "g"),
    js_skip_bare: re(r"\b(?:(?:it|test|describe)\.skip|x(?:it|test|describe))\b|\.skip\s*\(\s*\)|\bskip\s*:\s*true\b", ""),
    js_skip_if: re(r"\.skipIf\s*\(", ""),
    py_skip: re(r"\b(?:pytest\.mark\.(skipif|skip|xfail)|unittest\.(skipIf|skipUnless|skip|expectedFailure)|pytest\.(importorskip|skip))\b", ""),
    go_skip: re(r"\.Skip(?:f|Now)?\s*\(", ""),
    rust_ignore: re(r##"#\[\s*ignore\s*(?:=\s*(['"])((?:(?!\1).)*)\1)?\s*(?:\(.*?\))?\s*\]"##, ""),
    rust_cfg_ignore: re(r"#\[\s*cfg_attr\([^\]]*\bignore\b", ""),
    // A reason naming a missing capability of the host (platform, privilege, tool, build) is a capability skip;
    // anything else reads as a defect skip.
    capability: re(
        r"\bonly\b|unavailable|unsupported|not (available|permitted|enforced|built|supported|configured|granted|installed)|requires?\b|needs?\b|missing|denied|refused|does not (support|grant|allow)|insensitive|not found|has no|not run on|\bno local\b|\bno display\b|\bposix\b|\bno [\w ]+ (available|configured|is configured|installed)|\bnot on (the )?path\b|\bno [\w-]+ on this (host|machine|platform|runner)|\(\s*(?:e\.g\.|i\.e\.),?\s*running as (?:root|administrator|an? \w+ user)\s*\)|\bskip(?:ped)? (?:when|if|as|under) running as (?:root|administrator|an? \w+ user)\b|\b(?:is|are) an? (?:windows|posix|linux|macos|unix)[- ](?:behaviou?r|feature|semantics)\b",
        "i",
    ),
    tracked: re(r"#\d+", ""),
    until: re(r"until (\d{4}-\d{2}-\d{2})", ""),
    lane: re(r"\.(slow|live|electron|e2e|integration)\.(?:test|spec)\.", ""),
    py_file: re(r"^test_.+\.py$|_test\.py$", ""),
    comment_line: re(r"^\s*#", ""),
    slash_comment_line: re(r"^\s*//", ""),
    py_keyword: re(r##"\breason\s*=\s*(['"])((?:(?!\1).)*)\1"##, ""),
    py_positional_conditional: re(r##",\s*(['"])((?:(?!\1).)*)\1\s*\)?\s*$"##, ""),
    py_positional: re(r##"\(\s*(['"])((?:(?!\1).)*)\1"##, ""),
    quoted: re(r##"(['"`])((?:(?!\1).)*)\1"##, ""),
    langs: [
        Markers {
            comment: "//",
            fake: re(r"mock\.timers\.enable|useFakeTimers|installFakeClock|vi\.setSystemTime|jest\.setSystemTime", ""),
            markers: vec![
                ("timer", re(r"\b(setTimeout|setInterval|sleep|delay)\s*\(", "")),
                ("spawn", re(r"\b(spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(", "")),
                ("port", re(r"\.listen\(\s*[1-9]\d{2,4}\b", "")),
                ("clock", re(r"Date\.now\(\)|new Date\(\s*\)", "")),
                ("source-text", re(r##"readFile(Sync)?\([^)]*\.(m?js|tsx?|jsx)['"`]"##, "")),
            ],
        },
        Markers {
            comment: "#",
            fake: re(r"freezegun|freeze_time|time_machine|time-machine|monkeypatch\.setattr\([^)]*time|mock\.patch\([^)]*time", ""),
            markers: vec![
                ("timer", re(r"\b(?:time|asyncio)\.sleep\(|\bsleep\(", "")),
                ("spawn", re(r"\bsubprocess\.(?:run|Popen|call|check_output|check_call)\(|\bos\.(?:system|popen)\(|\bmultiprocessing\.Process\(", "")),
                ("port", re(r"\.bind\(\s*\([^)]*,\s*[1-9]\d{2,4}\s*\)|\bport\s*=\s*[1-9]\d{3,4}\b", "")),
                ("clock", re(r"\bdatetime\.(?:now|utcnow)\(|\bdate\.today\(|\btime\.time\(\)", "")),
                ("source-text", re(r##"inspect\.getsource\(|(?:open|Path)\(\s*['"][^'"]*\.(?:py|js|ts)['"]"##, "")),
            ],
        },
        Markers {
            comment: "//",
            fake: re(r"clockwork|benbjohnson/clock|synctest", ""),
            markers: vec![
                ("timer", re(r"\btime\.(?:Sleep|After|NewTimer|NewTicker|Tick)\(", "")),
                ("spawn", re(r"\bexec\.Command(?:Context)?\(", "")),
                ("port", re(r##"(?:net\.Listen|ListenAndServe)\(\s*(?:"tcp[46]?"\s*,\s*)?"[^"]*:[1-9]\d{2,4}""##, "")),
                ("clock", re(r"\btime\.Now\(\)", "")),
                ("source-text", re(r##"os\.ReadFile\(\s*"[^"]*\.go"|parser\.ParseFile\("##, "")),
            ],
        },
        Markers {
            comment: "//",
            fake: re(r"tokio::time::pause|start_paused", ""),
            markers: vec![
                ("timer", re(r"\bsleep\(", "")),
                ("spawn", re(r"\b(?:std::)?process::Command\b|\bCommand::new\(", "")),
                ("port", re(r##"\bbind\(\s*"[^"]*:[1-9]\d{2,4}""##, "")),
                ("clock", re(r"\b(?:SystemTime|Instant|Utc|Local)::now\(\)", "")),
                ("source-text", re(r##"include_str!\([^)]*\.rs"|read_to_string\([^)]*\.rs""##, "")),
            ],
        },
    ],
});

fn markers_of(lang: Lang) -> &'static Markers {
    &PATTERNS.langs[match lang {
        Lang::Js => 0,
        Lang::Python => 1,
        Lang::Go => 2,
        Lang::Rust => 3,
    }]
}

/// The lane a test file runs in: the tag in `name.<tag>.test.ext`, otherwise `fast`.
pub fn lane_of(file: &str) -> String {
    PATTERNS.lane.captures(file).and_then(|caps| caps.get(1)).unwrap_or("fast").to_owned()
}

/// The area of a file: its first two folders (below `src/` when it starts there), `.` for none.
pub fn area_of(rel: &str) -> String {
    let mut dirs: Vec<&str> = rel.split('/').collect();
    dirs.pop();
    if dirs.first() == Some(&"src") {
        dirs.remove(0);
    }
    let area = dirs.iter().take(2).copied().collect::<Vec<_>>().join("/");
    if area.is_empty() { ".".to_owned() } else { area }
}

/// What a `.rs` file is until its text decides.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Found {
    Lang(Lang),
    RustText,
}

fn lang_of(rel: &str, name: &str) -> Option<Found> {
    let p = &*PATTERNS;
    if p.js_file.is_match(name) && !p.types_file.is_match(name) && (p.js_test.is_match(name) || format!("/{rel}").contains("/__tests__/")) {
        return Some(Found::Lang(Lang::Js));
    }
    if p.py_file.is_match(name) {
        return Some(Found::Lang(Lang::Python));
    }
    if name.ends_with("_test.go") {
        return Some(Found::Lang(Lang::Go));
    }
    if name.ends_with(".rs") {
        return Some(if format!("/{rel}").contains("/tests/") { Found::Lang(Lang::Rust) } else { Found::RustText });
    }
    None
}

struct SkipSite {
    index: usize,
    reason: String,
    conditional: bool,
}

/// The call's text from `from` to its closing parenthesis, across up to 6 lines.
fn call_text(lines: &[&str], index: usize, from: usize) -> String {
    let mut text = lines[index][from..].to_owned();
    let mut next = index + 1;
    while next < lines.len().min(index + 6) {
        let open = text.matches('(').count();
        if open > 0 && text.matches(')').count() >= open {
            break;
        }
        text.push(' ');
        text.push_str(js_trim(lines[next]));
        next += 1;
    }
    text
}

fn group_text<'a>(caps: &Caps<'a>, group: usize) -> &'a str {
    caps.get(group).unwrap_or_default()
}

fn skip_sites(lines: &[&str], lang: Lang) -> Vec<SkipSite> {
    let p = &*PATTERNS;
    let mut sites = Vec::new();
    for (index, line) in lines.iter().copied().enumerate() {
        let mut add = |reason: &str, conditional: bool| sites.push(SkipSite { index, reason: reason.to_owned(), conditional });
        match lang {
            Lang::Js => {
                let mut any = false;
                for caps in p.js_skip_reason.captures_iter(line) {
                    any = true;
                    add(group_text(&caps, 2), false);
                }
                if !any {
                    if p.js_skip_if.is_match(line) {
                        add("", true);
                    } else if p.js_skip_bare.is_match(line) {
                        add("", false);
                    }
                }
            }
            Lang::Python => {
                let Some(found) = p.py_skip.captures(line) else { continue };
                if p.comment_line.is_match(line) {
                    continue;
                }
                let name = (1..=3).map(|group| group_text(&found, group)).find(|text| !text.is_empty()).unwrap_or_default();
                let conditional = matches!(name, "skipif" | "skipIf" | "skipUnless" | "importorskip");
                let call = call_text(lines, index, found.range().start);
                let keyword = p.py_keyword.captures(&call);
                let positional = if conditional { p.py_positional_conditional.captures(&call) } else { p.py_positional.captures(&call) };
                let reason = keyword.or(positional).map(|caps| group_text(&caps, 2).to_owned()).unwrap_or_default();
                add(&reason, conditional);
            }
            Lang::Go => {
                let found = p.go_skip.find(line).filter(|_| !p.slash_comment_line.is_match(line));
                if let Some(found) = found {
                    let reason = p.quoted.captures(&line[found.start..]).map(|caps| group_text(&caps, 2).to_owned());
                    add(&reason.unwrap_or_default(), false);
                }
            }
            Lang::Rust => {
                if let Some(found) = p.rust_ignore.captures(line) {
                    add(group_text(&found, 2), false);
                } else if p.rust_cfg_ignore.is_match(line) {
                    add("", true);
                }
            }
        }
    }
    sites
}

fn comment_of(line: &str, token: &str) -> String {
    line.find(token).map_or_else(String::new, |at| js_trim(&line[at + token.len()..]).to_owned())
}

fn classify(reason: &str, today: &str, conditional: bool) -> &'static str {
    let p = &*PATTERNS;
    let until = p.until.captures(reason).and_then(|caps| caps.get(1)).unwrap_or_default();
    if !until.is_empty() && until < today {
        return "expired";
    }
    if p.tracked.is_match(reason) {
        return "tracked";
    }
    if js_trim(reason).is_empty() {
        return if conditional { "capability" } else { "untracked" };
    }
    if p.capability.is_match(reason) { "capability" } else { "untracked" }
}

/// One skip record of a test file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skip {
    pub line: usize,
    pub reason: String,
    pub kind: &'static str,
}

/// The risk markers and skip records of a file's text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scan {
    pub markers: Vec<&'static str>,
    pub skips: Vec<Skip>,
}

/// `scanText(text, today, lang)`.
pub fn scan_text(text: &str, today: &str, lang: Lang) -> Scan {
    let spec = markers_of(lang);
    let fake_clock = spec.fake.is_match(text);
    let markers = spec
        .markers
        .iter()
        .filter(|(name, pattern)| pattern.is_match(text) && !(fake_clock && matches!(*name, "timer" | "clock")))
        .map(|(name, _)| *name)
        .collect();
    let lines: Vec<&str> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    let skips = skip_sites(&lines, lang)
        .into_iter()
        .map(|SkipSite { index, reason, conditional }| {
            let before =
                if index > 0 && js_trim(lines[index - 1]).starts_with(spec.comment) { comment_of(lines[index - 1], spec.comment) } else { String::new() };
            let note = [comment_of(lines[index], spec.comment), before].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
            let full = [reason.clone(), note.clone()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
            Skip { line: index + 1, reason: if reason.is_empty() { note } else { reason }, kind: classify(&full, today, conditional) }
        })
        .collect();
    Scan { markers, skips }
}

struct Candidate {
    path: std::path::PathBuf,
    rel: String,
    found: Found,
}

enum EntryKind {
    Dir,
    File,
    Other,
}

/// Whether the entry is a directory, a file or neither: a link of any kind is neither (the walk never follows one).
fn entry_kind<P: ReadProof>(proof: &P, entry: &DirEntry) -> EntryKind {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        match entry.metadata(proof) {
            Ok(meta) if meta.file_attributes() & REPARSE_POINT != 0 => return EntryKind::Other,
            Ok(_) => {}
            Err(_) => return EntryKind::Other,
        }
    }
    match entry.file_type(proof) {
        Ok(kind) if kind.is_dir() => EntryKind::Dir,
        Ok(kind) if kind.is_file() => EntryKind::File,
        _ => EntryKind::Other,
    }
}

/// `path.join(root, rel)`, for a message.
fn joined(root: &str, rel: &str) -> String {
    if rel.is_empty() { nodepath::normalize_host(root) } else { nodepath::normalize_host(&format!("{root}/{rel}")) }
}

struct Walk<'a, P: ReadProof> {
    proof: &'a P,
    root: &'a str,
    dirs: usize,
    found: Vec<Candidate>,
}

impl<P: ReadProof> Walk<'_, P> {
    fn visit(&mut self, dir: &Path, rel: &str, depth: usize) -> Result<(), String> {
        let root = self.root;
        if depth > MAX_DEPTH {
            return Err(format!("directories nested deeper than {MAX_DEPTH} under {root}; narrow the root"));
        }
        self.dirs += 1;
        if self.dirs > MAX_DIRS {
            return Err(format!("more than {MAX_DIRS} directories under {root}; narrow the root"));
        }
        let shown = joined(root, rel);
        let listing = mixdog_fsio::read_dir(self.proof, dir).map_err(|error| node_fs_message(&error, "scandir", &shown))?;
        let mut entries = listing.collect::<Result<Vec<_>, _>>().map_err(|error| node_fs_message(&error, "scandir", &shown))?;
        if cfg!(not(windows)) {
            entries.sort_by_key(DirEntry::file_name);
        }
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            match entry_kind(self.proof, &entry) {
                EntryKind::Dir => {
                    if !SKIP_DIRS.contains(&name.as_str()) {
                        self.visit(&entry.path(), &child_rel, depth + 1)?;
                    }
                }
                EntryKind::File => {
                    let Some(found) = lang_of(&child_rel, &name) else { continue };
                    self.found.push(Candidate { path: entry.path(), rel: child_rel, found });
                    if self.found.len() > MAX_FILES {
                        return Err(format!("more than {MAX_FILES} test files under {root}; narrow the root"));
                    }
                }
                EntryKind::Other => {}
            }
        }
        Ok(())
    }
}

/// The first megabyte of a file, as text.
fn read_head<P: ReadProof>(proof: &P, path: &Path, shown: &str) -> Result<String, String> {
    let file = mixdog_fsio::File::open(proof, path).map_err(|error| node_fs_message(&error, "open", shown))?;
    let size = file.metadata(proof).map_err(|error| node_fs_message(&error, "stat", shown))?.len();
    let mut bytes = Vec::new();
    file.take(size.min(MAX_BYTES)).read_to_end(&mut bytes).map_err(|error| node_fs_message(&error, "read", shown))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn bump(counts: &mut Vec<(String, u64)>, key: &str) {
    match counts.iter_mut().find(|(name, _)| name == key) {
        Some(slot) => slot.1 += 1,
        None => counts.push((key.to_owned(), 1)),
    }
}

/// One row of the per-area table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AreaRow {
    pub area: String,
    pub files: u64,
    pub fast: u64,
    pub slow: u64,
    pub other: u64,
    pub langs: Vec<(String, u64)>,
    pub markers: Vec<(String, u64)>,
    pub skips: Vec<(String, u64)>,
}

/// A skip that needs action.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attention {
    pub file: String,
    pub line: usize,
    pub reason: String,
    pub kind: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub root: String,
    pub today: String,
    pub files: usize,
    pub areas: Vec<AreaRow>,
    pub attention_total: usize,
    pub attention: Vec<Attention>,
    pub fast_risk_total: usize,
    pub fast_risk: Vec<String>,
}

struct FileEntry {
    file: String,
    lang: Lang,
    lane: String,
    area: String,
    scan: Scan,
}

/// `inventory(root, { today })`; the error is the message of the `Error` the script throws.
pub fn inventory<P: ReadProof>(proof: &P, root: &str, today: &str) -> Result<Report, String> {
    if !mixdog_fsio::metadata(proof, Path::new(root)).is_ok_and(|meta| meta.is_dir()) {
        return Err(format!("not a directory: {root}"));
    }
    let mut walk = Walk { proof, root, dirs: 0, found: Vec::new() };
    walk.visit(Path::new(root), "", 0)?;
    let mut files: Vec<FileEntry> = Vec::new();
    for Candidate { path, rel, found } in walk.found {
        let text = read_head(proof, &path, &joined(root, &rel))?;
        let lang = match found {
            Found::RustText if !PATTERNS.rust_test.is_match(&text) => continue,
            Found::RustText => Lang::Rust,
            Found::Lang(lang) => lang,
        };
        let (lane, area) = (lane_of(&rel), area_of(&rel));
        files.push(FileEntry { scan: scan_text(&text, today, lang), file: rel, lang, lane, area });
    }
    let mut areas: Vec<AreaRow> = Vec::new();
    for entry in &files {
        let at = match areas.iter().position(|row| row.area == entry.area) {
            Some(at) => at,
            None => {
                areas.push(AreaRow {
                    area: entry.area.clone(),
                    files: 0,
                    fast: 0,
                    slow: 0,
                    other: 0,
                    langs: Vec::new(),
                    markers: Vec::new(),
                    skips: Vec::new(),
                });
                areas.len() - 1
            }
        };
        let row = &mut areas[at];
        row.files += 1;
        match entry.lane.as_str() {
            "fast" => row.fast += 1,
            "slow" => row.slow += 1,
            _ => row.other += 1,
        }
        bump(&mut row.langs, entry.lang.name());
        for marker in &entry.scan.markers {
            bump(&mut row.markers, marker);
        }
        for skip in &entry.scan.skips {
            bump(&mut row.skips, skip.kind);
        }
    }
    areas.sort_by(|a, b| b.files.cmp(&a.files).then_with(|| locale_compare(&a.area, &b.area)));
    let attention: Vec<Attention> = files
        .iter()
        .flat_map(|entry| {
            entry.scan.skips.iter().filter(|skip| skip.kind != "capability").map(|skip| Attention {
                file: entry.file.clone(),
                line: skip.line,
                reason: skip.reason.clone(),
                kind: skip.kind,
            })
        })
        .collect();
    let fast_risk: Vec<&FileEntry> =
        files.iter().filter(|entry| entry.lane == "fast" && entry.scan.markers.contains(&"timer") && entry.scan.markers.contains(&"spawn")).collect();
    Ok(Report {
        root: root.to_owned(),
        today: today.to_owned(),
        files: files.len(),
        areas,
        attention_total: attention.len(),
        attention: attention.into_iter().take(LIST_LIMIT).collect(),
        fast_risk_total: fast_risk.len(),
        fast_risk: fast_risk.iter().take(LIST_LIMIT).map(|entry| entry.file.clone()).collect(),
    })
}

fn counts_json(counts: &[(String, u64)]) -> Value {
    Value::Object(counts.iter().map(|(key, count)| (key.clone(), Value::from(*count))).collect::<Map<String, Value>>())
}

impl Report {
    /// `JSON.stringify(report, null, 2)`.
    pub fn to_json(&self) -> String {
        let mut root = Map::new();
        root.insert("root".to_owned(), Value::from(self.root.as_str()));
        root.insert("today".to_owned(), Value::from(self.today.as_str()));
        root.insert("files".to_owned(), Value::from(self.files));
        let areas = self.areas.iter().map(|row| {
            let mut object = Map::new();
            object.insert("area".to_owned(), Value::from(row.area.as_str()));
            object.insert("files".to_owned(), Value::from(row.files));
            object.insert("fast".to_owned(), Value::from(row.fast));
            object.insert("slow".to_owned(), Value::from(row.slow));
            object.insert("other".to_owned(), Value::from(row.other));
            object.insert("langs".to_owned(), counts_json(&row.langs));
            object.insert("markers".to_owned(), counts_json(&row.markers));
            object.insert("skips".to_owned(), counts_json(&row.skips));
            Value::Object(object)
        });
        root.insert("areas".to_owned(), Value::Array(areas.collect()));
        root.insert("attentionTotal".to_owned(), Value::from(self.attention_total));
        let attention = self.attention.iter().map(|item| {
            let mut object = Map::new();
            object.insert("file".to_owned(), Value::from(item.file.as_str()));
            object.insert("line".to_owned(), Value::from(item.line));
            object.insert("reason".to_owned(), Value::from(item.reason.as_str()));
            object.insert("kind".to_owned(), Value::from(item.kind));
            Value::Object(object)
        });
        root.insert("attention".to_owned(), Value::Array(attention.collect()));
        root.insert("fastRiskTotal".to_owned(), Value::from(self.fast_risk_total));
        root.insert("fastRisk".to_owned(), Value::Array(self.fast_risk.iter().map(|file| Value::from(file.as_str())).collect()));
        json_stringify_indent(&Value::Object(root), 2)
    }

    /// The Markdown report (without the final line end `console.log` adds).
    pub fn to_markdown(&self) -> String {
        let cell = |counts: &[(String, u64)]| {
            if counts.is_empty() { "-".to_owned() } else { counts.iter().map(|(key, count)| format!("{key} {count}")).collect::<Vec<_>>().join(", ") }
        };
        let more = |total: usize, shown: usize| (total > shown).then(|| format!("- \u{2026} {} more (use --json)", total - shown));
        let mut out = vec![
            format!("# Test inventory: {}", self.root),
            String::new(),
            format!("{} test files, {}.", self.files, self.today),
            String::new(),
            "| Area | Files | Fast | Slow | Other | Languages | Markers | Skips |".to_owned(),
            "|---|---|---|---|---|---|---|---|".to_owned(),
        ];
        for row in &self.areas {
            out.push(format!(
                "| {} | {} | {} | {} | {} | {} | {} | {} |",
                row.area,
                row.files,
                row.fast,
                row.slow,
                row.other,
                cell(&row.langs),
                cell(&row.markers),
                cell(&row.skips)
            ));
        }
        out.push(String::new());
        out.push(format!("## Skips needing action ({})", self.attention_total));
        out.push(String::new());
        for item in &self.attention {
            let reason = if item.reason.is_empty() { "(no reason)" } else { item.reason.as_str() };
            out.push(format!("- {}: `{}:{}` \u{2014} {reason}", item.kind, item.file, item.line));
        }
        out.extend(more(self.attention_total, self.attention.len()));
        out.push(String::new());
        out.push(format!("## Fast-lane files with timers and real processes ({})", self.fast_risk_total));
        out.push(String::new());
        for file in &self.fast_risk {
            out.push(format!("- `{file}`"));
        }
        out.extend(more(self.fast_risk_total, self.fast_risk.len()));
        out.join("\n")
    }
}

/// `new Date().toISOString().slice(0, 10)`: today's UTC date.
pub fn utc_today() -> String {
    let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs());
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    // Civil date from days since 1970-01-01 (proleptic Gregorian).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_shifted + 2) / 5 + 1;
    let month = if month_shifted < 10 { month_shifted + 3 } else { month_shifted - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The command line: `<project-root> [--json]`.
pub fn run_inventory<P: ReadProof>(proof: &P, args: &[String], today: &str) -> Outcome {
    let json = args.iter().any(|arg| arg == "--json");
    let unknown = args.iter().find(|arg| arg.starts_with("--") && *arg != "--json");
    let root = args.iter().find(|arg| !arg.starts_with("--")).filter(|arg| !arg.is_empty());
    let mut outcome = Outcome::default();
    let (Some(root), None) = (root, unknown) else {
        let prefix = unknown.map_or_else(String::new, |arg| format!("unknown option {arg}; "));
        outcome.eprint(&format!("{prefix}usage: inventory.mjs <project-root> [--json]"));
        outcome.code = 2;
        return outcome;
    };
    match inventory(proof, root, today) {
        Ok(report) => outcome.print(&if json { report.to_json() } else { report.to_markdown() }),
        Err(message) => {
            outcome.eprint(&format!("inventory: {message}"));
            outcome.code = 1;
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use mixdog_fsio::Unlaned;

    use super::*;

    const TODAY: &str = "2026-10-29";

    fn kinds(text: &str, lang: Lang) -> Vec<(usize, &'static str)> {
        scan_text(text, TODAY, lang).skips.iter().map(|skip| (skip.line, skip.kind)).collect()
    }

    fn sorted(mut markers: Vec<&'static str>) -> Vec<&'static str> {
        markers.sort_unstable();
        markers
    }

    #[test]
    fn js_markers_flag_timers_spawns_and_fixed_ports_and_a_fake_clock_clears_timer_and_clock() {
        let risky = scan_text("setTimeout(done, 50); spawn('git'); server.listen(4173); Date.now();", TODAY, Lang::Js);
        assert_eq!(sorted(risky.markers), ["clock", "port", "spawn", "timer"]);
        let faked = scan_text("vi.useFakeTimers(); setTimeout(done, 50); Date.now(); server.listen(0);", TODAY, Lang::Js);
        assert!(faked.markers.is_empty());
    }

    #[test]
    fn python_go_and_rust_markers_are_language_specific() {
        let py = "import time, subprocess\ntime.sleep(1)\nsubprocess.run([\"x\"])\ns.bind((\"0.0.0.0\", 8080))\ndatetime.now()";
        assert_eq!(sorted(scan_text(py, TODAY, Lang::Python).markers), ["clock", "port", "spawn", "timer"]);
        assert!(scan_text("@freeze_time(\"2026-01-01\")\ntime.sleep(1)\ndatetime.now()", TODAY, Lang::Python).markers.is_empty());
        let go = "time.Sleep(time.Second)\nexec.Command(\"ls\")\nnet.Listen(\"tcp\", \"127.0.0.1:9000\")\ntime.Now()\nnet.Listen(\"tcp\", \":0\")";
        assert_eq!(sorted(scan_text(go, TODAY, Lang::Go).markers), ["clock", "port", "spawn", "timer"]);
        let rust = "thread::sleep(d);\nCommand::new(\"ls\");\nTcpListener::bind(\"127.0.0.1:7000\");\nInstant::now();";
        assert_eq!(sorted(scan_text(rust, TODAY, Lang::Rust).markers), ["clock", "port", "spawn", "timer"]);
        assert!(scan_text("tokio::time::pause(); sleep(d); Instant::now();", TODAY, Lang::Rust).markers.is_empty());
        assert_eq!(scan_text("open(\"a.py\"); inspect.getsource(f)", TODAY, Lang::Python).markers, ["source-text"]);
    }

    #[test]
    fn js_skips_are_classified_as_capability_tracked_untracked_or_expired() {
        let text = [
            "const w = { skip: process.platform !== 'win32' && 'Windows only' };",
            "test('a', { skip: '#271 until 2026-11-30: port race' }, () => {});",
            "test('b', { skip: '#90 until 2026-01-01: old race' }, () => {});",
            "test('c', { skip: 'fails sometimes' }, () => {});",
            "it.skip('d', () => {}); // #12 until 2027-01-01",
            "xit('e', () => {});",
            "it.skipIf(isWindows)('f', () => {});",
        ]
        .join("\n");
        assert_eq!(
            kinds(&text, Lang::Js),
            [(1, "capability"), (2, "tracked"), (3, "expired"), (4, "untracked"), (5, "tracked"), (6, "untracked"), (7, "capability")]
        );
    }

    #[test]
    fn a_reason_naming_a_missing_platform_tool_build_or_privilege_is_a_capability_skip() {
        let capability = [
            "no bash on this host",
            "dotnet SDK is not on PATH",
            "mandatory file locks are a Windows behavior",
            "the file is still readable here (e.g. running as root)",
            "a mixdog-graph build with the --langs/--scan modes is not available on this machine",
        ];
        let defects = ["fixture skip", "fails when the disk is busy", "Windows behavior is broken", "crashes when running as root", "flaky on Windows"];
        let text: Vec<String> = capability.iter().chain(defects.iter()).map(|reason| format!("t.skip('{reason}');")).collect();
        let got: Vec<&str> = kinds(&text.join("\n"), Lang::Js).into_iter().map(|(_, kind)| kind).collect();
        let want: Vec<&str> = capability.iter().map(|_| "capability").chain(defects.iter().map(|_| "untracked")).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn python_skips_cover_pytest_and_unittest_forms_including_multi_line_decorators() {
        let text = [
            "@pytest.mark.skip(reason=\"#5 until 2027-02-02: race\")",
            "@pytest.mark.skipif(sys.platform == \"win32\", reason=\"requires posix\")",
            "@pytest.mark.skip(reason=\"flaky\")",
            "@pytest.mark.xfail",
            "@unittest.skipIf(IS_CI, \"needs a display\")",
            "@pytest.mark.skipif(",
            "    sys.platform == \"win32\",",
            "    reason=\"#8 until 2020-01-01: old\",",
            ")",
            "    # @pytest.mark.skip commented out",
        ]
        .join("\n");
        assert_eq!(kinds(&text, Lang::Python), [(1, "tracked"), (2, "capability"), (3, "untracked"), (4, "untracked"), (5, "capability"), (6, "expired")]);
    }

    #[test]
    fn go_and_rust_skips_are_classified() {
        let go =
            ["if runtime.GOOS == \"windows\" { t.Skip(\"windows only\") }", "t.Skipf(\"#3 until 2027-05-05: %s\", why)", "t.Skip(\"flaky\")", "t.SkipNow()"]
                .join("\n");
        assert_eq!(kinds(&go, Lang::Go), [(1, "capability"), (2, "tracked"), (3, "untracked"), (4, "untracked")]);
        let rust = ["#[ignore = \"requires docker\"]", "#[ignore = \"#4 until 2020-01-01: race\"]", "#[ignore]", "#[cfg_attr(windows, ignore)]"].join("\n");
        assert_eq!(kinds(&rust, Lang::Rust), [(1, "capability"), (2, "expired"), (3, "untracked"), (4, "capability")]);
    }

    #[test]
    fn lane_and_area_derive_from_the_path() {
        assert_eq!(lane_of("a/b.slow.test.mjs"), "slow");
        assert_eq!(lane_of("a/b.e2e.spec.ts"), "e2e");
        assert_eq!(lane_of("a/test_x.py"), "fast");
        assert_eq!(area_of("src/runtime/shell/a.test.mjs"), "runtime/shell");
        assert_eq!(area_of("pkg/sub/deep/x_test.go"), "pkg/sub");
        assert_eq!(area_of("x.test.js"), ".");
    }

    fn tree(files: &[(&str, &str)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("temp dir");
        for (rel, body) in files {
            let path = root.path().join(rel);
            mixdog_testkit::create_dir_all(path.parent().expect("parent"));
            mixdog_testkit::write(&path, body);
        }
        root
    }

    #[test]
    fn inventory_discovers_js_python_go_and_rust_tests_and_skips_vendored_folders() {
        let root = tree(&[
            ("web/src/a.test.ts", "setTimeout(f, 1); spawn('x'); test('t', { skip: '#7 race' }, () => {});"),
            ("web/src/b.slow.spec.js", "test('x', { skip: 'flaky' }, () => {});"),
            ("web/src/__tests__/c.js", "plain"),
            ("web/src/helper.ts", "not a test"),
            ("web/node_modules/dep/ignored.test.js", "ignored"),
            ("py/tests/test_a.py", "@pytest.mark.skip\ndef test_a(): pass"),
            ("py/tests/helper.py", "not a test"),
            ("py/.venv/lib/test_dep.py", "ignored"),
            ("go/pkg/x_test.go", "t.Skip(\"windows only\")"),
            ("go/vendor/y_test.go", "ignored"),
            ("rs/tests/it.rs", "#[ignore]"),
            ("rs/src/lib.rs", "#[cfg(test)]\nmod tests { #[test] fn t() {} }"),
            ("rs/src/plain.rs", "pub fn x() {}"),
            ("rs/target/debug/z.rs", "#[test]"),
        ]);
        let report = inventory(&Unlaned, &root.path().display().to_string(), TODAY).expect("inventory");
        assert_eq!(report.files, 7);
        let mut attention: Vec<(String, &str)> = report.attention.iter().map(|item| (item.file.clone(), item.kind)).collect();
        attention.sort();
        let want =
            [("py/tests/test_a.py", "untracked"), ("rs/tests/it.rs", "untracked"), ("web/src/a.test.ts", "tracked"), ("web/src/b.slow.spec.js", "untracked")];
        assert_eq!(attention, want.iter().map(|(file, kind)| ((*file).to_owned(), *kind)).collect::<Vec<_>>());
        assert_eq!(report.fast_risk, ["web/src/a.test.ts"]);
        let web = report.areas.iter().find(|row| row.area == "web/src").expect("web area");
        assert_eq!((web.files, web.fast, web.slow), (3, 2, 1));
        assert_eq!(report.areas[0].area, "web/src");
    }

    #[test]
    fn the_command_line_prints_markdown_or_json_and_rejects_bad_input() {
        let root = tree(&[("pkg/a_test.go", "t.Skip(\"flaky\")")]);
        let dir = root.path().display().to_string();
        let args = |list: &[&str]| list.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
        let markdown = run_inventory(&Unlaned, &args(&[&dir]), TODAY);
        assert_eq!(markdown.code, 0);
        assert!(markdown.stdout.contains("| pkg | 1 |"));
        assert!(markdown.stdout.contains("untracked: `pkg/a_test.go:1`"));
        let json = run_inventory(&Unlaned, &args(&[&dir, "--json"]), TODAY);
        assert!(json.stdout.starts_with("{\n  \"root\": "));
        assert!(json.stdout.contains("\"files\": 1,"));
        assert_eq!(run_inventory(&Unlaned, &[], TODAY).code, 2);
        let bogus = run_inventory(&Unlaned, &args(&[&dir, "--bogus"]), TODAY);
        assert_eq!((bogus.code, bogus.stderr.as_str()), (2, "unknown option --bogus; usage: inventory.mjs <project-root> [--json]\n"));
        let missing = run_inventory(&Unlaned, &args(&[&root.path().join("missing").display().to_string()]), TODAY);
        assert_eq!(missing.code, 1);
        assert!(missing.stderr.contains("not a directory"));
    }

    #[test]
    fn only_the_first_two_hundred_entries_of_a_list_are_shown() {
        let owned: Vec<(String, String)> = (0..201).map(|n| (format!("t/a{n:03}.test.js"), "it.skip('x');".to_owned())).collect();
        let files: Vec<(&str, &str)> = owned.iter().map(|(rel, body)| (rel.as_str(), body.as_str())).collect();
        let root = tree(&files);
        let report = inventory(&Unlaned, &root.path().display().to_string(), TODAY).expect("inventory");
        assert_eq!((report.attention_total, report.attention.len()), (201, LIST_LIMIT));
        assert!(report.to_markdown().contains("- \u{2026} 1 more (use --json)"));
    }

    #[test]
    fn a_tree_nested_too_deep_is_refused_with_the_scripts_message() {
        let deep = vec!["d"; MAX_DEPTH + 1].join("/");
        let root = tree(&[(&format!("{deep}/x.test.js"), "")]);
        let dir = root.path().display().to_string();
        assert_eq!(inventory(&Unlaned, &dir, TODAY).expect_err("too deep"), format!("directories nested deeper than {MAX_DEPTH} under {dir}; narrow the root"));
    }

    #[test]
    fn a_file_is_read_up_to_one_megabyte() {
        let mut text = " ".repeat(usize::try_from(MAX_BYTES).expect("fits"));
        text.push_str("\nit.skip('x');");
        let root = tree(&[("a.test.js", &text)]);
        let report = inventory(&Unlaned, &root.path().display().to_string(), TODAY).expect("inventory");
        assert_eq!(report.attention_total, 0);
    }

    #[test]
    fn today_is_a_utc_date() {
        let today = utc_today();
        assert_eq!(today.len(), 10);
        assert!(today.starts_with("20"));
    }
}
