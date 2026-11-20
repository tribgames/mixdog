//! The colours of the markdown renderer: chalk at truecolor (`new Chalk({ level: 3 })` of `format-token.mjs`), the
//! colourizers derived from the active theme's `md*` and `syntax*` keys, and the highlight.js class map built from
//! them. They are rebuilt when the theme version changes, so a theme switch shows on the next render.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_highlight::{HighlightTheme, SgrPair, SgrStyle};
use mixdog_tui_style::{Color, Key, current_palette, get_theme_version};

/// An SGR open code and its close code: the layers of a chalk chain.
type Layer = (u8, u8);

const BOLD: Layer = (1, 22);
const DIM: Layer = (2, 22);
const ITALIC: Layer = (3, 23);
const UNDERLINE: Layer = (4, 24);
const STRIKETHROUGH: Layer = (9, 29);

fn chain(layers: &[Layer]) -> SgrStyle {
    SgrStyle::from_layers(layers.iter().map(|(open, close)| SgrPair { open: format!("\u{1b}[{open}m"), close: format!("\u{1b}[{close}m") }).collect())
}

/// `chalk.bold(text)`.
pub fn bold(text: &str) -> String {
    chain(&[BOLD]).apply(text)
}

/// `chalk.dim(text)`.
pub fn dim(text: &str) -> String {
    chain(&[DIM]).apply(text)
}

/// `chalk.italic(text)`.
pub fn italic(text: &str) -> String {
    chain(&[ITALIC]).apply(text)
}

/// `chalk.strikethrough(text)`.
pub fn strikethrough(text: &str) -> String {
    chain(&[STRIKETHROUGH]).apply(text)
}

/// `chalk.bold.underline(text)`.
pub fn bold_underline(text: &str) -> String {
    chain(&[BOLD, UNDERLINE]).apply(text)
}

/// `chalk.bold.italic(text)`.
pub fn bold_italic(text: &str) -> String {
    chain(&[BOLD, ITALIC]).apply(text)
}

/// `chalk.dim.italic(text)`.
pub fn dim_italic(text: &str) -> String {
    chain(&[DIM, ITALIC]).apply(text)
}

/// `rgbColor(str)`: `chalk.rgb` of a palette colour, the identity for one that is not `rgb(r, g, b)`.
fn rgb_color(color: Color) -> SgrStyle {
    match color {
        Color::Rgb(r, g, b) => SgrStyle::foreground_rgb(r, g, b),
        Color::Transparent => SgrStyle::identity(),
    }
}

/// The colourizers of the block structure (`colorizers()`).
#[derive(Clone, Debug)]
pub struct Colorizers {
    /// Inline codespan.
    pub accent: SgrStyle,
    /// Fenced code block body.
    pub code_block: SgrStyle,
    pub heading_accent: SgrStyle,
    pub hr_line: SgrStyle,
    pub list_bullet: SgrStyle,
}

/// The colourizers of links, diffs and syntax classes (`extraColorizers()`).
#[derive(Clone, Debug)]
pub struct ExtraColorizers {
    pub fence_border: SgrStyle,
    pub link: SgrStyle,
    pub link_text: SgrStyle,
    pub diff_added: SgrStyle,
    pub diff_removed: SgrStyle,
    pub diff_hunk: SgrStyle,
    pub diff_header: SgrStyle,
    pub diff_context: SgrStyle,
    pub syn_comment: SgrStyle,
    pub syn_keyword: SgrStyle,
    pub syn_function: SgrStyle,
    pub syn_variable: SgrStyle,
    pub syn_string: SgrStyle,
    pub syn_number: SgrStyle,
    pub syn_type: SgrStyle,
    pub syn_operator: SgrStyle,
    pub syn_punct: SgrStyle,
    /// The plain code-block body colour.
    pub body: SgrStyle,
}

/// Everything derived from one palette.
#[derive(Debug)]
pub struct Styles {
    pub base: Colorizers,
    pub extra: ExtraColorizers,
    /// `buildCliHighlightTheme(extraColorizers())`.
    pub(super) highlight: HighlightTheme,
}

/// `buildCliHighlightTheme(c)`: highlight.js token classes to the styles of the active theme.
fn highlight_theme(c: &ExtraColorizers) -> HighlightTheme {
    let plain = &c.body;
    let entries: [(&str, &SgrStyle); 34] = [
        ("keyword", &c.syn_keyword),
        ("built_in", &c.syn_type),
        ("type", &c.syn_type),
        ("literal", &c.syn_keyword),
        ("number", &c.syn_number),
        ("regexp", &c.syn_string),
        ("string", &c.syn_string),
        ("subst", plain),
        ("symbol", plain),
        ("class", &c.syn_type),
        ("function", &c.syn_function),
        ("title", &c.syn_function),
        ("params", &c.syn_variable),
        ("comment", &c.syn_comment),
        ("doctag", &c.syn_comment),
        ("meta", &c.syn_comment),
        ("section", &c.syn_type),
        ("tag", &c.syn_punct),
        ("name", &c.syn_function),
        ("builtin", &c.syn_type),
        ("attr", &c.syn_type),
        ("attribute", &c.syn_type),
        ("variable", &c.syn_variable),
        ("selector", &c.syn_keyword),
        ("template", &c.syn_variable),
        ("bullet", plain),
        ("code", plain),
        ("emphasis", plain),
        ("strong", plain),
        ("formula", plain),
        ("link", plain),
        ("quote", plain),
        ("addition", &c.syn_string),
        ("deletion", &c.syn_string),
    ];
    HighlightTheme { classes: entries.into_iter().map(|(name, style)| (name.to_owned(), style.clone())).collect::<HashMap<_, _>>(), default: plain.clone() }
}

fn build_styles() -> Styles {
    let palette = current_palette();
    let color = |key: Key| rgb_color(palette[key]);
    let base = Colorizers {
        accent: color(Key::MdCode),
        code_block: color(Key::MdCodeBlock),
        heading_accent: color(Key::MdHeading),
        hr_line: color(Key::MdHr),
        list_bullet: color(Key::MdListBullet),
    };
    let extra = ExtraColorizers {
        fence_border: color(Key::MdCodeBlockBorder),
        link: color(Key::MdLink),
        link_text: color(Key::MdLinkText),
        diff_added: color(Key::MdDiffAdded),
        diff_removed: color(Key::MdDiffRemoved),
        diff_hunk: color(Key::MdDiffHunk),
        diff_header: color(Key::MdDiffHeader),
        diff_context: color(Key::MdDiffContext),
        syn_comment: color(Key::SyntaxComment),
        syn_keyword: color(Key::SyntaxKeyword),
        syn_function: color(Key::SyntaxFunction),
        syn_variable: color(Key::SyntaxVariable),
        syn_string: color(Key::SyntaxString),
        syn_number: color(Key::SyntaxNumber),
        syn_type: color(Key::SyntaxType),
        syn_operator: color(Key::SyntaxOperator),
        syn_punct: color(Key::SyntaxPunctuation),
        body: color(Key::MdCodeBlock),
    };
    let highlight = highlight_theme(&extra);
    Styles { base, extra, highlight }
}

static CACHE: Mutex<Option<(u64, Arc<Styles>)>> = Mutex::new(None);

/// The styles of the active theme, cached on the theme version.
pub fn styles() -> Arc<Styles> {
    let version = get_theme_version();
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((cached, styles)) = cache.as_ref()
        && *cached == version
    {
        return Arc::clone(styles);
    }
    let styles = Arc::new(build_styles());
    *cache = Some((version, Arc::clone(&styles)));
    styles
}
