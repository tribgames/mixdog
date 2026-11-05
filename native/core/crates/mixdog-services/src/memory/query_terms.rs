//! Query tokenisation for lexical search: cleaned text → normalised terms →
//! a Postgres `to_tsquery` prefix expression.

use mixdog_js::{JsRegex, js_trim, utf16_len};
use std::collections::HashSet;
use std::sync::LazyLock;



use crate::memory::clean::clean_memory_text;
use crate::memory::ko_morph::{light_ko_morph_stems, raw_tokens, strip_light_korean_particle};

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do", "does", "for", "from", "how", "i", "if", "in",
    "is", "it", "me", "my", "of", "on", "or", "our", "so", "that", "the", "their", "them", "they", "this", "to", "was",
    "we", "were", "what", "when", "who", "why", "you", "your", "unless", "with", "user", "assistant", "requested",
    "request", "asked", "ask", "stated", "state", "reported", "report", "mentioned", "mention", "clarified", "clarify",
    "explicitly", "currently", "asks", "question", "answer", "reply", "said", "explained", "huh",
];

/// From this many lexemes a prefix query is an OR: the conjunction of three or
/// more almost never matched a stored row, which silently reduced recall to
/// the dense leg; ts_rank_cd then orders by how many lexemes a row covers.
const FTS_OR_MIN_LEXEMES: usize = 3;

static WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[a-z][a-z0-9_-]+$", "i"));
static IDENTIFIER_PUNCT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[_./:-]", ""));
static HAS_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\p{N}", "u"));
static ALL_CAPS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Z][A-Z0-9_-]{1,}$", ""));
static HAS_HANGUL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\p{Script=Hangul}", "u"));
static DATE_TOKEN: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\d{4}-\d{2}-\d{2}(?:~\d{4}-\d{2}-\d{2})?$", ""));
static CLOCK_TOKEN: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\d{1,2}:\d{2}(?:~\d{1,2}:\d{2})?$", ""));
static SINGLE_DIGIT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\d$", ""));
static LEXEME_SYNTAX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"[&|!():*'"\\\s]+"#, "g"));

fn normalize_token(token: &str) -> String {
    let mut normalized = strip_light_korean_particle(&js_trim(token).to_lowercase());
    if normalized.is_empty() {
        return normalized;
    }
    if WORD.is_match(&normalized) {
        let len = utf16_len(&normalized);
        let cut = |n: usize, s: &mut String| {
            let keep = s.len() - n; // ASCII only here
            s.truncate(keep);
        };
        if len > 5 && normalized.ends_with("ing") {
            cut(3, &mut normalized);
        } else if len > 4 && (normalized.ends_with("ed") || normalized.ends_with("es")) {
            cut(2, &mut normalized);
        } else if len > 3 && normalized.ends_with('s') {
            cut(1, &mut normalized);
        }
    }
    normalized
}

fn is_identifier(token: &str) -> bool {
    IDENTIFIER_PUNCT.is_match(token) || HAS_NUMBER.is_match(token) || ALL_CAPS.is_match(token)
}

fn is_entity_concept(token: &str) -> bool {
    !HAS_HANGUL.is_match(token) || is_identifier(token)
}

pub fn is_structural_time_token(token: &str) -> bool {
    DATE_TOKEN.is_match(token) || CLOCK_TOKEN.is_match(token)
}

fn is_concept_compound(token: &str, concepts: &[String]) -> bool {
    let normalized = normalize_token(token);
    if normalized.is_empty() {
        return false;
    }
    let parts: Vec<String> = concepts.iter().map(|c| normalize_token(c)).filter(|c| !c.is_empty()).collect();
    for start in 0..parts.len() {
        let mut joined = String::new();
        for (index, part) in parts.iter().enumerate().skip(start) {
            joined.push_str(part);
            if joined == normalized {
                return index > start;
            }
            if !normalized.starts_with(&joined) {
                break;
            }
        }
    }
    false
}

/// Raw word tokens merged with concept tokens, normalised, de-duplicated and
/// capped at `limit` (1..=64).
pub fn merge_recall_concept_tokens(text: &str, concept_tokens: &[String], limit: usize) -> Vec<String> {
    let cap = limit.clamp(1, 64);
    let cleaned = clean_memory_text(text);
    let raw: Vec<&str> = raw_tokens(&cleaned);
    let concepts: Vec<String> =
        concept_tokens.iter().map(|t| js_trim(t).to_owned()).filter(|t| !t.is_empty()).collect();
    let entity_concepts: Vec<&String> = concepts.iter().filter(|t| is_entity_concept(t)).collect();
    let ranking_entity: Vec<&&String> = entity_concepts.iter().filter(|t| !is_structural_time_token(t)).collect();
    let use_entity = ranking_entity.iter().any(|t| is_identifier(t)) || ranking_entity.len() > 2;
    // Entity-heavy queries rank their entities first, but the Korean content
    // words stay: dropping them left a mixed query matching only on product
    // names that half the history shares.
    let ranking: Vec<&str> = if use_entity {
        entity_concepts
            .iter()
            .map(|t| t.as_str())
            .chain(concepts.iter().filter(|t| !is_entity_concept(t)).map(String::as_str))
            .collect()
    } else {
        concepts.iter().map(String::as_str).collect()
    };
    let source: Vec<&str> = if concepts.is_empty() {
        raw
    } else {
        raw.into_iter()
            .filter(|t| is_identifier(t) || is_concept_compound(t, &concepts))
            .chain(ranking)
            .collect()
    };
    let mut seen = HashSet::new();
    source
        .into_iter()
        .map(normalize_token)
        .filter(|t| utf16_len(t) >= 2 || SINGLE_DIGIT.is_match(t))
        .filter(|t| !STOPWORDS.contains(&t.as_str()))
        .filter(|t| seen.insert(t.clone()))
        .take(cap)
        .collect()
}

pub fn tokenize_recall_query(text: &str, limit: usize) -> Vec<String> {
    merge_recall_concept_tokens(text, &light_ko_morph_stems(text), limit)
}

fn fts_tokens(tokens: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    tokens
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .filter(|t| {
            let chars = utf16_len(t);
            chars >= 3 || (chars >= 2 && !t.is_ascii())
        })
        .collect()
}

/// Plain tokens for `websearch_to_tsquery`, space-joined; empty when nothing qualifies.
pub fn build_fts_query(text: &str) -> String {
    fts_tokens(tokenize_recall_query(text, 24))
        .iter()
        .map(|t| t.replace(['"', '\''], ""))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A `to_tsquery` expression: every lexeme a prefix match (`:*`), AND-joined
/// for short queries and OR-joined from three lexemes up. None when the text
/// has no searchable token.
pub fn build_fts_prefix_query(text: &str) -> Option<String> {
    let mut seen = HashSet::new();
    let lexemes: Vec<String> = fts_tokens(tokenize_recall_query(text, 24))
        .iter()
        .map(|t| LEXEME_SYNTAX.replace_all_with(t, |_| String::new()))
        .filter(|lex| !lex.is_empty() && seen.insert(lex.clone()))
        .collect();
    if lexemes.is_empty() {
        return None;
    }
    let joiner = if lexemes.len() >= FTS_OR_MIN_LEXEMES { " | " } else { " & " };
    Some(lexemes.iter().map(|l| format!("{l}:*")).collect::<Vec<_>>().join(joiner))
}
