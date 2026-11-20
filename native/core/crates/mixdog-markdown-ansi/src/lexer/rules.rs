//! marked 14.1.4's grammar: the rule regexes of its gfm block and inline grammars, copied from its `Lexer.rules`, and the regress engine behind them. regress takes the source as ECMAScript reads it, so `\s`, `\b`, the `u`
//! flag's `\p{P}\p{S}` classes and look-arounds behave as in V8. A `g` flag is kept in the table for the record and is
//! ignored by the engine: a search from an offset is [`Re::exec_from`].

use std::sync::LazyLock;

/// A compiled rule.
pub(crate) struct Re(regress::Regex);

/// One match with its groups: byte offsets into the text searched.
pub(crate) struct Caps<'t> {
    text: &'t str,
    found: regress::Match,
}

impl Re {
    pub(crate) fn new(source: &str, flags: &str) -> Self {
        match regress::Regex::with_flags(source, flags) {
            Ok(regex) => Self(regex),
            Err(error) => panic!("marked rule /{source}/{flags}: {error}"),
        }
    }

    /// `rule.exec(text)` of a rule without the `g` flag.
    pub(crate) fn exec<'t>(&self, text: &'t str) -> Option<Caps<'t>> {
        self.exec_from(text, 0)
    }

    /// `rule.exec(text)` of a `g` rule whose `lastIndex` is `start`.
    pub(crate) fn exec_from<'t>(&self, text: &'t str, start: usize) -> Option<Caps<'t>> {
        self.0.find_from(text, start).next().map(|found| Caps { text, found })
    }

    /// `rule.test(text)`.
    pub(crate) fn test(&self, text: &str) -> bool {
        self.0.find(text).is_some()
    }

    /// `text.replace(rule, replacer)` of a `g` rule.
    pub(crate) fn replace_all(&self, text: &str, with: impl Fn(&Caps<'_>) -> String) -> String {
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for found in self.0.find_iter(text) {
            let caps = Caps { text, found };
            let (start, end) = (caps.start(), caps.end());
            out.push_str(&text[last..start]);
            out.push_str(&with(&caps));
            last = end;
        }
        out.push_str(&text[last..]);
        out
    }
}

impl<'t> Caps<'t> {
    /// `cap[i]`; `None` is `undefined` (the group did not take part).
    pub(crate) fn get(&self, group: usize) -> Option<&'t str> {
        self.found.group(group).map(|range| &self.text[range])
    }

    /// `cap[0]`.
    pub(crate) fn whole(&self) -> &'t str {
        &self.text[self.found.range()]
    }

    /// `cap.index`.
    pub(crate) fn start(&self) -> usize {
        self.found.start()
    }

    /// `rule.lastIndex` after a `g` match.
    pub(crate) fn end(&self) -> usize {
        self.found.end()
    }
}

/// Rules of marked 14.1.4's block grammar (gfm), as its `Lexer.rules.block.gfm` holds them: (name, source, flags).
pub const BLOCK: &[(&str, &str, &str)] = &[
    ("newline", r##"^(?:[ \t]*(?:\n|$))+"##, ""),
    ("code", r##"^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+"##, ""),
    ("fences", r##"^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)"##, ""),
    ("heading", r##"^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)"##, ""),
    ("hr", r##"^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)"##, ""),
    (
        "blockquote",
        r##"^( {0,3}> ?(([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)| +\n)[^\n]+)*)|[^\n]*)(?:\n|$))+"##,
        "",
    ),
    ("list", r##"^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]+?)?(?:\n|$)"##, ""),
    (
        "html",
        r##"^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n+|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>\n*|$)|<![A-Z][\s\S]*?(?:>\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<(?!script|pre|style|textarea)([a-z][\w-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$)|<\/(?!script|pre|style|textarea)[a-z][\w-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ \t]*)+\n|$))"##,
        "i",
    ),
    (
        "def",
        r##"^ {0,3}\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))))? *(?:\n+|$)"##,
        "",
    ),
    (
        "table",
        r##"^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)).*(?:\n|$))*)\n*|$)"##,
        "",
    ),
    (
        "lheading",
        r##"^(?!(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}| {0,3}<[^\n>]+>\n)((?:.|\n(?!\s*?\n|(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}| {0,3}<[^\n>]+>\n))+?)\n {0,3}(=+|-+) *(?:\n+|$)"##,
        "",
    ),
    (
        "paragraph",
        r##"^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*\n)|~{3,})[^\n]*\n| {0,3}(?:[*+-]|1[.)]) |<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:script|pre|style|textarea|!--)).*(?:\n|$))*)\n*|$)| +\n)[^\n]+)*)"##,
        "",
    ),
    ("text", r##"^[^\n]+"##, ""),
];

/// Rules of marked 14.1.4's inline grammar (gfm), as its `Lexer.rules.inline.gfm` holds them: (name, source, flags).
pub const INLINE: &[(&str, &str, &str)] = &[
    ("escape", r##"^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~~|])"##, ""),
    (
        "tag",
        r##"^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][\w:-]*\s*>|^<[a-zA-Z][\w-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>"##,
        "",
    ),
    (
        "link",
        r##"^!?\[((?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?)\]\(\s*(<(?:\\.|[^\n<>\\])+>|[^\s\x00-\x1f]*)(?:\s+("(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)))?\s*\)"##,
        "",
    ),
    ("reflink", r##"^!?\[((?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]"##, ""),
    ("nolink", r##"^!?\[((?!\s*\])(?:\\.|[^\[\]\\])+)\](?:\[\])?"##, ""),
    (
        "reflinkSearch",
        r##"!?\[((?:\[(?:\\.|[^\[\]\\])*\]|\\.|`[^`]*`|[^\[\]\\`])*?)\]\[((?!\s*\])(?:\\.|[^\[\]\\])+)\]|!?\[((?!\s*\])(?:\\.|[^\[\]\\])+)\](?:\[\])?(?!\()"##,
        "g",
    ),
    ("emStrongLDelim", r##"^(?:\*+(?:((?!\*)[\p{P}\p{S}])|[^\s*]))|^_+(?:((?!_)[\p{P}\p{S}])|([^\s_]))"##, "u"),
    (
        "emStrongRDelimAst",
        r##"^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)[\p{P}\p{S}](\*+)(?=[\s]|$)|[^\p{P}\p{S}\s](\*+)(?!\*)(?=[\p{P}\p{S}\s]|$)|(?!\*)[\p{P}\p{S}\s](\*+)(?=[^\p{P}\p{S}\s])|[\s](\*+)(?!\*)(?=[\p{P}\p{S}])|(?!\*)[\p{P}\p{S}](\*+)(?!\*)(?=[\p{P}\p{S}])|[^\p{P}\p{S}\s](\*+)(?=[^\p{P}\p{S}\s])"##,
        "gu",
    ),
    (
        "emStrongRDelimUnd",
        r##"^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\p{P}\p{S}\s](_+)(?!_)(?=[\p{P}\p{S}\s]|$)|(?!_)[\p{P}\p{S}\s](_+)(?=[^\p{P}\p{S}\s])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])"##,
        "gu",
    ),
    ("code", r##"^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)"##, ""),
    ("br", r##"^( {2,}|\\)\n(?!\s*$)"##, ""),
    (
        "autolink",
        r##"^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>"##,
        "",
    ),
    ("url", r##"^((?:ftp|https?):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])"##, "i"),
    ("_backpedal", r##"(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+"##, ""),
    (
        "text",
        r##"^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|https?:\/\/|ftp:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))"##,
        "",
    ),
    ("punctuation", r##"^((?![*_])[\s\p{P}\p{S}])"##, "u"),
    ("blockSkip", r##"\[[^[\]]*?\]\((?:\\.|[^\\\(\)]|\((?:\\.|[^\\\(\)])*\))*\)|`[^`]*?`|<[^<>]*?>"##, "g"),
    ("anyPunctuation", r##"\\([\p{P}\p{S}])"##, "gu"),
];

fn compile(table: &[(&str, &str, &str)], name: &str) -> Re {
    match table.iter().find(|entry| entry.0 == name) {
        Some(&(_, source, flags)) => Re::new(source, flags),
        None => panic!("marked rule {name} is not in the table"),
    }
}

/// The block rules the tokenizer runs.
pub(crate) struct BlockRules {
    pub(crate) newline: Re,
    pub(crate) code: Re,
    pub(crate) fences: Re,
    pub(crate) heading: Re,
    pub(crate) hr: Re,
    pub(crate) blockquote: Re,
    pub(crate) list: Re,
    pub(crate) html: Re,
    pub(crate) def: Re,
    pub(crate) table: Re,
    pub(crate) lheading: Re,
    pub(crate) paragraph: Re,
    pub(crate) text: Re,
}

/// The inline rules the tokenizer runs.
pub(crate) struct InlineRules {
    pub(crate) escape: Re,
    pub(crate) tag: Re,
    pub(crate) link: Re,
    pub(crate) reflink: Re,
    pub(crate) nolink: Re,
    pub(crate) reflink_search: Re,
    pub(crate) em_strong_l_delim: Re,
    pub(crate) em_strong_r_delim_ast: Re,
    pub(crate) em_strong_r_delim_und: Re,
    pub(crate) code: Re,
    pub(crate) br: Re,
    pub(crate) autolink: Re,
    pub(crate) url: Re,
    pub(crate) backpedal: Re,
    pub(crate) text: Re,
    pub(crate) punctuation: Re,
    pub(crate) block_skip: Re,
    pub(crate) any_punctuation: Re,
}

pub(crate) struct Rules {
    pub(crate) block: BlockRules,
    pub(crate) inline: InlineRules,
}

pub(crate) static RULES: LazyLock<Rules> = LazyLock::new(|| Rules {
    block: BlockRules {
        newline: compile(BLOCK, "newline"),
        code: compile(BLOCK, "code"),
        fences: compile(BLOCK, "fences"),
        heading: compile(BLOCK, "heading"),
        hr: compile(BLOCK, "hr"),
        blockquote: compile(BLOCK, "blockquote"),
        list: compile(BLOCK, "list"),
        html: compile(BLOCK, "html"),
        def: compile(BLOCK, "def"),
        table: compile(BLOCK, "table"),
        lheading: compile(BLOCK, "lheading"),
        paragraph: compile(BLOCK, "paragraph"),
        text: compile(BLOCK, "text"),
    },
    inline: InlineRules {
        escape: compile(INLINE, "escape"),
        tag: compile(INLINE, "tag"),
        link: compile(INLINE, "link"),
        reflink: compile(INLINE, "reflink"),
        nolink: compile(INLINE, "nolink"),
        reflink_search: compile(INLINE, "reflinkSearch"),
        em_strong_l_delim: compile(INLINE, "emStrongLDelim"),
        em_strong_r_delim_ast: compile(INLINE, "emStrongRDelimAst"),
        em_strong_r_delim_und: compile(INLINE, "emStrongRDelimUnd"),
        code: compile(INLINE, "code"),
        br: compile(INLINE, "br"),
        autolink: compile(INLINE, "autolink"),
        url: compile(INLINE, "url"),
        backpedal: compile(INLINE, "_backpedal"),
        text: compile(INLINE, "text"),
        punctuation: compile(INLINE, "punctuation"),
        block_skip: compile(INLINE, "blockSkip"),
        any_punctuation: compile(INLINE, "anyPunctuation"),
    },
});

/// The regexes `list` builds from the indentation of the item it is reading (`Math.min(3, indent - 1)`, so 0 to 3).
pub(crate) struct ListLookahead {
    pub(crate) next_bullet: Re,
    pub(crate) hr: Re,
    pub(crate) fences_begin: Re,
    pub(crate) heading_begin: Re,
    pub(crate) html_begin: Re,
}

impl ListLookahead {
    fn new(width: usize) -> Self {
        Self {
            next_bullet: Re::new(&format!(r"^ {{0,{width}}}(?:[*+-]|\d{{1,9}}[.)])((?:[ \t][^\n]*)?(?:\n|$))"), ""),
            hr: Re::new(&format!(r"^ {{0,{width}}}((?:- *){{3,}}|(?:_ *){{3,}}|(?:\* *){{3,}})(?:\n+|$)"), ""),
            fences_begin: Re::new(&format!(r"^ {{0,{width}}}(?:```|~~~)"), ""),
            heading_begin: Re::new(&format!(r"^ {{0,{width}}}#"), ""),
            html_begin: Re::new(&format!(r"^ {{0,{width}}}<(?:[a-z].*>|!--)"), "i"),
        }
    }
}

static LIST_LOOKAHEAD: LazyLock<[ListLookahead; 4]> = LazyLock::new(|| [0, 1, 2, 3].map(ListLookahead::new));

/// The lookahead regexes of an item whose content is indented by `indent`.
pub(crate) fn list_lookahead(indent: usize) -> &'static ListLookahead {
    &LIST_LOOKAHEAD[indent.saturating_sub(1).min(3)]
}

/// The regex that reads the next item of a list whose first bullet is `bull` (`-`, `*`, `+`, or digits and `.` or `)`).
/// It depends on the bullet's last character and on whether digits come before it, so each of the few is compiled once.
pub(crate) fn item_rule(bull: &str) -> &'static Re {
    static RULES: LazyLock<std::sync::Mutex<std::collections::HashMap<(bool, char), &'static Re>>> = LazyLock::new(Default::default);
    let mut chars = bull.chars();
    let last = chars.next_back().unwrap_or('-');
    let ordered = bull.chars().count() > 1;
    let mut rules = RULES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *rules.entry((ordered, last)).or_insert_with(|| {
        let pattern = if ordered { format!(r"\d{{1,9}}\{last}") } else { format!(r"\{last}") };
        Box::leak(Box::new(Re::new(&format!("^( {{0,3}}{pattern})((?:[\t ][^\n]*)?(?:\n|$))"), "")))
    })
}
