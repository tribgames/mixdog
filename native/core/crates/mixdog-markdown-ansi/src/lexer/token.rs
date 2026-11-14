//! The tokens of marked 14.1.4, serialised as marked's own JSON writes them (members that are `undefined` or `null` are
//! absent; `align` arrays keep their nulls).

use serde::{Serialize, Serializer};

/// `token.type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Space,
    Code,
    Heading,
    Hr,
    Blockquote,
    List,
    ListItem,
    Html,
    Table,
    Paragraph,
    Text,
    Escape,
    Link,
    Image,
    Strong,
    Em,
    Codespan,
    Br,
    Del,
}

/// `list.start`: the number the first item of an ordered list carries, the empty string for a bullet list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListStart {
    None,
    Number(u64),
}

impl Serialize for ListStart {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::None => serializer.serialize_str(""),
            Self::Number(n) => serializer.serialize_u64(*n),
        }
    }
}

/// A column's alignment (`:--`, `:-:`, `--:`); a column with none is `None` in [`Token::align`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Center,
    Right,
}

/// A cell of a table (`header` and `rows` of a table token).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TableCell {
    pub text: String,
    pub tokens: Vec<Token>,
    pub header: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    /// The entry of the lexer's inline queue that fills `tokens` when the block pass is done.
    #[serde(skip)]
    pub(crate) queued: Option<usize>,
}

/// One token. A member a kind of token does not carry stays `None`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Token {
    #[serde(rename = "type")]
    pub kind: TokenKind,
    pub raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Vec<Token>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<Token>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordered: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<ListStart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loose: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    #[serde(rename = "codeBlockStyle", skip_serializing_if = "Option::is_none")]
    pub code_block_style: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<Vec<TableCell>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<Vec<Option<Align>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<Vec<TableCell>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<bool>,
    #[serde(rename = "inLink", skip_serializing_if = "Option::is_none")]
    pub in_link: Option<bool>,
    #[serde(rename = "inRawBlock", skip_serializing_if = "Option::is_none")]
    pub in_raw_block: Option<bool>,
    /// An open fenced block the streaming renderer built without the lexer (it renders flat until the fence closes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<bool>,
    /// The entry of the lexer's inline queue that fills `tokens` when the block pass is done.
    #[serde(skip)]
    pub(crate) queued: Option<usize>,
}

impl Token {
    pub fn new(kind: TokenKind, raw: impl Into<String>) -> Self {
        Self {
            kind,
            raw: raw.into(),
            text: None,
            tokens: None,
            items: None,
            ordered: None,
            start: None,
            loose: None,
            task: None,
            checked: None,
            depth: None,
            lang: None,
            code_block_style: None,
            href: None,
            title: None,
            header: None,
            align: None,
            rows: None,
            pre: None,
            block: None,
            in_link: None,
            in_raw_block: None,
            plain: None,
            queued: None,
        }
    }

    /// A token with `raw` and `text` (`text`, `escape`, `codespan` and the like).
    pub(crate) fn with_text(kind: TokenKind, raw: impl Into<String>, text: impl Into<String>) -> Self {
        let mut token = Self::new(kind, raw);
        token.text = Some(text.into());
        token
    }

    /// `token.text` as marked reads it where it is always set.
    pub fn text_str(&self) -> &str {
        self.text.as_deref().unwrap_or("")
    }

    /// The child tokens (`token.tokens`), none when the kind has none.
    pub fn children(&self) -> &[Token] {
        self.tokens.as_deref().unwrap_or(&[])
    }
}

/// A reference definition (`[tag]: href "title"`) the lexer collected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Link {
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
