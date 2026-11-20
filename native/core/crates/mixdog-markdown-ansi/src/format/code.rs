//! Fenced code blocks of `format-token.mjs`: a gutter-indented, highlighted body with no background band and no fence
//! lines, unified-diff colouring, and the highlight.js language resolution shared with the tool-output renderer.

use std::sync::{LazyLock, Mutex, PoisonError};

use mixdog_highlight::{SgrStyle, highlight_ansi, supports_language};
use mixdog_js::{is_js_space, js_trim};
use mixdog_termtext::display_width_with;
use mixdog_termtext::wrap::hard_wrap_ansi_lines_with;
use mixdog_tui_style::get_theme_version;

use super::colors::{ExtraColorizers, styles};
use super::text::decode_entities;
use crate::lexer::Token;
use crate::lexer::rules::Re;
use crate::lru::Lru;

/// Fixed tab size of fenced-code rendering. No raw tab may survive into the rendered string: the width math counts a
/// tab as zero cells while the terminal expands it, which would let a code line bleed past the viewport clip.
const CODE_TAB_SIZE: usize = 2;

/// The left gutter that keeps code visually distinct from prose.
const CODE_GUTTER: &str = "  ";

const HIGHLIGHT_CACHE_MAX: usize = 300;

/// `DIFF_STAT_FILE_RE`: a `git diff --stat` row, `<path> | <count> <+/-/ graph>` (the count may be `Bin`).
static DIFF_STAT_FILE: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\s*)(.+?)(\s+\|\s+)(Bin\b.*|\d+\s*[+-]*)\s*$", ""));
/// `DIFF_STAT_SUMMARY_RE`: `N file(s) changed[, M insertion...][, K deletion...]`.
static DIFF_STAT_SUMMARY: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*\d+\s+files?\s+changed\b", ""));
static DIFF_STAT_COUNT: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(\d+)(\s*)([+-]*)\s*$", ""));
static DIFF_INSERTIONS: LazyLock<Re> = LazyLock::new(|| Re::new(r"(\d+)(\s+insertions?\(\+\))", ""));
static DIFF_DELETIONS: LazyLock<Re> = LazyLock::new(|| Re::new(r"(\d+)(\s+deletions?\(-\))", ""));

/// The highlighted output by `lang|themeVersion|source`.
static HIGHLIGHT_CACHE: LazyLock<Mutex<Lru<String, String>>> = LazyLock::new(|| Mutex::new(Lru::new(HIGHLIGHT_CACHE_MAX)));

/// `LANG_FAMILY[name]`: the internal family of a fenced-code language name or alias.
pub fn lang_family(name: &str) -> Option<&'static str> {
    Some(match name {
        "js" | "javascript" | "mjs" | "cjs" => "js",
        "ts" | "typescript" => "ts",
        "jsx" => "jsx",
        "tsx" => "tsx",
        "json" | "json5" => "json",
        "bash" | "sh" | "shell" | "zsh" => "sh",
        "python" | "py" => "py",
        "css" | "scss" | "less" => "css",
        "html" | "xml" => "html",
        "md" | "markdown" => "md",
        "go" | "golang" => "go",
        "rust" | "rs" => "rust",
        "java" => "java",
        "c" | "cpp" | "c++" | "cc" | "h" | "hpp" => "c",
        "ruby" | "rb" => "ruby",
        "sql" => "sql",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "kotlin" | "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "php" => "php",
        "csharp" | "cs" | "c#" => "csharp",
        "dockerfile" | "docker" => "dockerfile",
        "graphql" | "gql" => "graphql",
        "protobuf" | "proto" => "protobuf",
        "scala" => "scala",
        "dart" => "dart",
        "lua" => "lua",
        "perl" | "pl" => "perl",
        "r" | "rl" => "r",
        "objc" | "objective-c" | "obj-c" => "objc",
        "powershell" | "ps1" | "ps" | "pwsh" => "powershell",
        "makefile" | "make" => "makefile",
        "nginx" => "nginx",
        "ini" => "ini",
        "vim" => "vim",
        "haskell" | "hs" => "haskell",
        "elixir" | "ex" | "exs" => "elixir",
        "clojure" | "clj" => "clojure",
        _ => return None,
    })
}

/// `FAMILY_TO_HLJS[family]`: the highlight.js language id of a family, when the alias alone is not enough.
fn family_to_hljs(family: &str) -> Option<&'static str> {
    Some(match family {
        "js" => "javascript",
        "ts" => "typescript",
        "tsx" => "tsx",
        "jsx" => "jsx",
        "json" => "json",
        "sh" => "bash",
        "py" => "python",
        "css" => "css",
        "html" => "xml",
        "go" => "go",
        "rust" => "rust",
        "java" => "java",
        "c" => "cpp",
        "ruby" => "ruby",
        "sql" => "sql",
        "yaml" => "yaml",
        "toml" => "ini",
        "kotlin" => "kotlin",
        "swift" => "swift",
        "php" => "php",
        "csharp" => "csharp",
        "dockerfile" => "dockerfile",
        "protobuf" => "protobuf",
        "scala" => "scala",
        "dart" => "dart",
        "lua" => "lua",
        "perl" => "perl",
        "r" => "r",
        "objc" => "objectivec",
        "powershell" => "powershell",
        "makefile" => "makefile",
        "nginx" => "nginx",
        "ini" => "ini",
        "vim" => "vim",
        "haskell" => "haskell",
        "elixir" => "elixir",
        "clojure" => "clojure",
        _ => return None,
    })
}

/// `hljsLanguageFromFamily(family)`.
fn hljs_language_from_family(family: Option<&str>) -> Option<String> {
    let family = family.filter(|family| !family.is_empty() && *family != "md")?;
    if let Some(mapped) = family_to_hljs(family)
        && supports_language(mapped)
    {
        return Some(mapped.to_owned());
    }
    supports_language(family).then(|| family.to_owned())
}

/// `normalizeLang(lang)`: a fenced info-string as a bare lowercase language token.
fn normalize_lang(lang: Option<&str>) -> String {
    let trimmed = js_trim(lang.unwrap_or(""));
    trimmed.split(is_js_space).next().unwrap_or("").to_lowercase()
}

/// `resolveHljsLanguage(lang)`: a fenced info-string as a highlight.js language id.
fn resolve_hljs_language(lang: &str) -> Option<String> {
    let normalized = normalize_lang(Some(lang));
    if normalized.is_empty() {
        return None;
    }
    if let Some(via_family) = hljs_language_from_family(lang_family(&normalized)) {
        return Some(via_family);
    }
    supports_language(&normalized).then_some(normalized)
}

/// `highlightCodeText(text, hljsLang)`: the highlighted source, none when the language is unsupported, the source has
/// nothing to colour or highlighting fails (the caller falls back to the flat body colour).
fn highlight_code_text(text: &str, hljs_lang: &str) -> Option<String> {
    if hljs_lang.is_empty() || !supports_language(hljs_lang) {
        return None;
    }
    if js_trim(text).is_empty() || !text.bytes().any(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let key = format!("{hljs_lang}|{}|{text}", get_theme_version());
    let hit = HIGHLIGHT_CACHE.lock().unwrap_or_else(PoisonError::into_inner).get(&key).cloned();
    if hit.is_some() {
        return hit;
    }
    let highlighted = highlight_ansi(text, hljs_lang, &styles().highlight, true).ok()?;
    HIGHLIGHT_CACHE.lock().unwrap_or_else(PoisonError::into_inner).touch(key, highlighted.clone());
    Some(highlighted)
}

/// `c.body(line)` of a line: the empty line stays empty.
fn flat_line(line: &str, c: &ExtraColorizers) -> String {
    if line.is_empty() { String::new() } else { c.body.apply(line) }
}

/// `highlightCodeLine(line, family, c)`: one line (tool expanded output) with the same theme map.
pub fn highlight_code_line(line: &str, family: Option<&str>, c: &ExtraColorizers) -> String {
    hljs_language_from_family(family).and_then(|lang| highlight_code_text(line, &lang)).unwrap_or_else(|| flat_line(line, c))
}

/// `highlightCodeBlockToLines(text, family, c)`: a multi-line block in one highlight call, one ANSI string per line; on
/// a miss each line is flat-coloured with the body colour.
pub fn highlight_code_block_to_lines(text: &str, family: Option<&str>, c: &ExtraColorizers) -> Vec<String> {
    match hljs_language_from_family(family).and_then(|lang| highlight_code_text(text, &lang)) {
        Some(highlighted) => highlighted.split('\n').map(str::to_owned).collect(),
        None => text.split('\n').map(|line| flat_line(line, c)).collect(),
    }
}

/// `normalizeCodeText(text)`: CRLF and lone CR become LF; a tab becomes spaces to the next tab stop; any other C0
/// control or DEL except LF becomes one space, so no control byte can move the terminal cursor.
fn normalize_code_text(text: &str, wide: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(unified.len());
    let mut column = 0;
    for ch in unified.chars() {
        match ch {
            '\n' => {
                out.push('\n');
                column = 0;
            }
            '\t' => {
                let advance = CODE_TAB_SIZE - (column % CODE_TAB_SIZE);
                out.extend(std::iter::repeat_n(' ', advance));
                column += advance;
            }
            '\u{0}'..='\u{1f}' | '\u{7f}' => {
                out.push(' ');
                column += 1;
            }
            _ => {
                out.push(ch);
                column += display_width_with(ch.encode_utf8(&mut [0; 4]), wide);
            }
        }
    }
    out
}

/// `normalizeCodePlain(text)`: the streaming open fence's normalize, without the per-character width loop (tab stops
/// are cosmetic and return when the block settles and renders in full).
fn normalize_code_plain(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n").replace('\t', "  ");
    unified.chars().map(|ch| if matches!(ch, '\u{0}'..='\u{9}' | '\u{b}'..='\u{1f}' | '\u{7f}') { ' ' } else { ch }).collect()
}

/// `wrapCodeLine(ansiContent, maxLineWidth)`.
fn wrap_code_line(ansi_content: &str, max_line_width: usize, wide: bool) -> Vec<String> {
    hard_wrap_ansi_lines_with(ansi_content, max_line_width.max(1), wide)
}

/// `index [0-9a-f]`: the `index ` prefix of a git diff header with a hex digit after it.
fn is_index_header(line: &str) -> bool {
    line.strip_prefix("index ").is_some_and(|rest| rest.starts_with(|ch: char| matches!(ch, '0'..='9' | 'a'..='f')))
}

/// `looksLikeUnifiedDiff(text)`: at least one `+`/`-` body line and a hunk or file header, or a `git diff --stat` row, so
/// ordinary code with a leading `+`/`-` is not taken for a diff.
pub fn looks_like_unified_diff(text: &str) -> bool {
    let mut has_hunk = false;
    let mut has_file_header = false;
    let mut has_sign = false;
    let mut has_stat = false;
    for line in text.split('\n') {
        has_hunk |= line.starts_with("@@ ");
        has_file_header |= line.starts_with("+++ ") || line.starts_with("--- ") || line.starts_with("diff --git ") || is_index_header(line);
        let mut chars = line.chars();
        has_sign |= matches!(chars.next(), Some('+' | '-')) && !matches!(chars.next(), Some('+' | '-'));
        has_stat |= DIFF_STAT_FILE.test(line) || DIFF_STAT_SUMMARY.test(line);
    }
    ((has_hunk || has_file_header) && has_sign) || has_stat
}

/// `colorizeDiffStatLine(line, c)`: a `git diff --stat` file row, dim path and separator, green `+`, red `-`.
fn colorize_diff_stat_line(line: &str, c: &ExtraColorizers) -> String {
    let Some(row) = DIFF_STAT_FILE.exec(line) else {
        return c.diff_context.apply(line);
    };
    let (indent, path, separator, tail) = (row.get(1).unwrap_or(""), row.get(2).unwrap_or(""), row.get(3).unwrap_or(""), row.get(4).unwrap_or(""));
    // The tail is either `Bin ...` or `<count> <graph>` where the graph is `+` and `-`.
    let colored_tail = match DIFF_STAT_COUNT.exec(tail) {
        Some(count) => {
            let bars = count.get(3).unwrap_or("");
            let pluses = c.diff_added.apply(&"+".repeat(bars.matches('+').count()));
            let minuses = c.diff_removed.apply(&"-".repeat(bars.matches('-').count()));
            format!("{}{}{pluses}{minuses}", c.diff_context.apply(count.get(1).unwrap_or("")), count.get(2).unwrap_or(""))
        }
        None => c.diff_context.apply(tail),
    };
    format!("{indent}{}{}{colored_tail}", c.diff_context.apply(path), c.diff_context.apply(separator))
}

/// `colorizeDiffStatTrailer(line, c)`: the `N files changed, M insertions(+), K deletions(-)` trailer.
fn colorize_diff_stat_trailer(line: &str, c: &ExtraColorizers) -> String {
    let added = DIFF_INSERTIONS
        .replace_all(line, |caps| format!("{}{}", c.diff_added.apply(caps.get(1).unwrap_or("")), c.diff_context.apply(caps.get(2).unwrap_or(""))));
    DIFF_DELETIONS.replace_all(&added, |caps| format!("{}{}", c.diff_removed.apply(caps.get(1).unwrap_or("")), c.diff_context.apply(caps.get(2).unwrap_or(""))))
}

/// `colorizeDiffLine(line, c)`: classifies and colours one unified-diff line.
pub fn colorize_diff_line(line: &str, c: &ExtraColorizers) -> String {
    // File and section headers first, so `+++` and `---` are never taken for an addition or a removal.
    for marker in ["+++", "---"] {
        if let Some(rest) = line.strip_prefix(marker)
            && rest.chars().next().is_none_or(is_js_space)
        {
            return c.diff_header.apply(line);
        }
    }
    let header = ["diff --git ", "new file", "deleted file", "rename ", "similarity ", "old mode", "new mode"].iter().any(|prefix| line.starts_with(prefix))
        || is_index_header(line);
    if header {
        return c.diff_header.apply(line);
    }
    if line.starts_with("@@") {
        return c.diff_hunk.apply(line);
    }
    if line.starts_with('+') {
        return c.diff_added.apply(line);
    }
    if line.starts_with('-') {
        return c.diff_removed.apply(line);
    }
    if line.starts_with("\\ No newline") {
        return c.diff_context.apply(line);
    }
    // `git diff --stat` summary trailer and per-file rows.
    if DIFF_STAT_SUMMARY.test(line) {
        return colorize_diff_stat_trailer(line, c);
    }
    if DIFF_STAT_FILE.test(line) {
        return colorize_diff_stat_line(line, c);
    }
    c.diff_context.apply(line)
}

fn collect_diff_body_lines(text: &str, c: &ExtraColorizers, band_width: usize, wide: bool) -> Vec<String> {
    text.split('\n').flat_map(|line| wrap_code_line(&colorize_diff_line(line, c), band_width, wide)).collect()
}

fn collect_flat_body_lines(text: &str, code_block: &SgrStyle, band_width: usize, wide: bool) -> Vec<String> {
    text.split('\n').flat_map(|line| wrap_code_line(&code_block.apply(line), band_width, wide)).collect()
}

/// `collectPlainBodyLines`: the flat body of the streaming open block. Only a line that overflows is wrapped (the common
/// code line fits, so no wrap call), which keeps the per-frame pass close to linear.
fn collect_plain_body_lines(text: &str, code_block: &SgrStyle, band_width: usize, wide: bool) -> Vec<String> {
    let max = band_width.max(1);
    let mut lines = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            lines.push(String::new());
        } else if line.encode_utf16().count() <= max && display_width_with(line, wide) <= max {
            lines.push(code_block.apply(line));
        } else {
            lines.extend(wrap_code_line(&code_block.apply(line), max, wide));
        }
    }
    lines
}

fn collect_highlighted_body_lines(text: &str, hljs_lang: &str, code_block: &SgrStyle, band_width: usize, wide: bool) -> Vec<String> {
    let source = highlight_code_text(text, hljs_lang).unwrap_or_else(|| text.split('\n').map(|line| code_block.apply(line)).collect::<Vec<_>>().join("\n"));
    source.split('\n').flat_map(|line| wrap_code_line(line, band_width, wide)).collect()
}

/// `renderCodeBlock(token, width)`: an optional subtle language label row, then the wrapped, highlighted body, every row
/// indented by the 2-column gutter. No background band, no full-width padding, no visible fence lines.
pub(super) fn render_code_block(token: &Token, width: usize, wide: bool) -> String {
    let styles = styles();
    let code_block = &styles.base.code_block;
    let c = &styles.extra;
    let lang = normalize_lang(token.lang.as_deref());
    let render_width = (if width == 0 { 80 } else { width }).max(8);
    // Content is wrapped to the render width minus the gutter, so `gutter + content` never overruns it.
    let content_width = render_width.saturating_sub(CODE_GUTTER.len()).max(1);
    let source = token.text.as_deref().unwrap_or("");

    let body_lines = if token.plain == Some(true) {
        // Streaming open fence: a flat body, no lexing and no highlighting; the settled block renders in full.
        collect_plain_body_lines(&normalize_code_plain(&decode_entities(source)), code_block, content_width, wide)
    } else {
        let text = normalize_code_text(&decode_entities(source), wide);
        let is_diff_lang = matches!(lang.as_str(), "diff" | "patch" | "udiff" | "git-diff" | "gitdiff");
        if is_diff_lang || (lang.is_empty() && looks_like_unified_diff(&text)) {
            collect_diff_body_lines(&text, c, content_width, wide)
        } else {
            match resolve_hljs_language(&lang) {
                Some(hljs_lang) if lang_family(&lang) != Some("md") => collect_highlighted_body_lines(&text, &hljs_lang, code_block, content_width, wide),
                _ => collect_flat_body_lines(&text, code_block, content_width, wide),
            }
        }
    };
    let mut rows: Vec<String> = Vec::with_capacity(body_lines.len() + 1);
    if !lang.is_empty() {
        rows.push(format!("{CODE_GUTTER}{}", c.syn_comment.apply(&lang)));
    }
    rows.extend(body_lines.iter().map(|line| format!("{CODE_GUTTER}{line}")));
    let rows = rows.join("\n");
    if rows.is_empty() { rows } else { format!("{rows}\n") }
}
