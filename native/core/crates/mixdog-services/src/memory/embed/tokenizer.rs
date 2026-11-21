//! Unigram tokenizer for the XLM-R family `tokenizer.json` files (multilingual
//! e5, bge-m3): the precompiled-charsmap normalizer stand-in, Metaspace,
//! Viterbi segmentation with its tie-breaking, unknown-piece fusing,
//! added-token splitting and the single-sequence template, then truncation to
//! the model window. Token ids must equal the ones every stored vector was
//! made from, so each step keeps the behaviour of the tokenizer that produced
//! them rather than the textbook algorithm.

use mixdog_js::JsRegex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::memory::error::{MemoryError, Result};

const META: &str = "\u{2581}";

#[derive(Debug, Clone)]
struct AddedToken {
    id: u32,
    lstrip: bool,
    rstrip: bool,
}

enum Normalizer {
    Precompiled,
    ReplaceRegex(JsRegex, String),
    ReplaceString(String, String),
}

pub struct UnigramTokenizer {
    normalizers: Vec<Normalizer>,
    index: HashMap<Box<str>, u32>,
    scores: Vec<f64>,
    max_chars: usize,
    unk_id: u32,
    unk_score: f64,
    added: HashMap<String, AddedToken>,
    raw_added: Vec<String>,
    normalized_added: Vec<String>,
    replacement: String,
    prepend_always: bool,
    prepend_first: bool,
    prefix: Vec<u32>,
    suffix: Vec<u32>,
    max_length: usize,
}

fn unsupported(what: String) -> MemoryError {
    MemoryError::Runtime(format!("unsupported tokenizer: {what}"))
}

/// Node's `UnsupportedTokenizerError` text (`unsupported model ${model?.type}`): a layout field as a JS
/// template literal prints it.
fn unsupported_layout(what: &str, field: Option<&Value>) -> MemoryError {
    let text = match field {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    };
    MemoryError::Embedding(format!("unsupported {what} {text}"))
}

fn precompiled_normalize(text: &str) -> String {
    static CONTROL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("[\u{1}-\u{8}\u{B}\u{E}-\u{1F}\u{7F}\u{8F}\u{9F}]", "g"));
    static SPACE: LazyLock<JsRegex> = LazyLock::new(|| {
        JsRegex::new_static("[\u{9}\u{A}\u{C}\u{D}\u{A0}\u{1680}\u{2000}-\u{200F}\u{2028}\u{2029}\u{202F}\u{205F}\u{2581}\u{3000}\u{FEFF}\u{FFFD}]", "g")
    });
    let stripped = CONTROL.replace_all_with(text, |_| String::new());
    let spaced = SPACE.replace_all_with(&stripped, |_| " ".into());
    if spaced.contains('\u{FF5E}') {
        spaced.split('\u{FF5E}').map(|part| part.nfkc().collect::<String>()).collect::<Vec<_>>().join("\u{FF5E}")
    } else {
        spaced.nfkc().collect()
    }
}

/// Longest dictionary word at each position.
fn split_on<'a>(words: &[String], text: &'a str) -> Vec<&'a str> {
    if words.is_empty() {
        return vec![text];
    }
    let mut out = Vec::new();
    let (mut start, mut i) = (0, 0);
    while i < text.len() {
        let mut matched: Option<&String> = None;
        for word in words {
            if text[i..].starts_with(word.as_str()) && matched.is_none_or(|m| word.len() > m.len()) {
                matched = Some(word);
            }
        }
        if let Some(word) = matched {
            if i > start {
                out.push(&text[start..i]);
            }
            out.push(&text[i..i + word.len()]);
            i += word.len();
            start = i;
        } else {
            i += text[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn parse_normalizers(spec: &Value) -> Result<Vec<Normalizer>> {
    let steps: Vec<&Value> = match spec {
        Value::Null => Vec::new(),
        spec if spec["type"] == "Sequence" => spec["normalizers"].as_array().map_or_else(Vec::new, |a| a.iter().collect()),
        spec => vec![spec],
    };
    let mut normalizers = Vec::new();
    for step in steps {
        let content = step["content"].as_str().unwrap_or_default().to_owned();
        normalizers.push(match step["type"].as_str() {
            Some("Precompiled") => Normalizer::Precompiled,
            Some("Replace") if step["pattern"]["Regex"].is_string() => Normalizer::ReplaceRegex(
                JsRegex::new(step["pattern"]["Regex"].as_str().unwrap_or_default(), "gu").map_err(|error| unsupported(format!("normalizer regex: {error}")))?,
                content,
            ),
            Some("Replace") if step["pattern"]["String"].is_string() => {
                Normalizer::ReplaceString(step["pattern"]["String"].as_str().unwrap_or_default().to_owned(), content)
            }
            _ => return Err(unsupported_layout("normalizer", step.get("type"))),
        });
    }
    Ok(normalizers)
}

struct UnigramVocab {
    index: HashMap<Box<str>, u32>,
    scores: Vec<f64>,
    max_chars: usize,
    unk_id: u32,
    unk_score: f64,
}

fn parse_unigram_vocab(model: &Value) -> Result<UnigramVocab> {
    let vocab = model["vocab"].as_array().ok_or_else(|| unsupported("vocab".into()))?;
    let mut index = HashMap::with_capacity(vocab.len());
    let mut scores = Vec::with_capacity(vocab.len());
    let (mut max_chars, mut min_score) = (1usize, f64::INFINITY);
    for (id, entry) in vocab.iter().enumerate() {
        let piece = entry[0].as_str().ok_or_else(|| unsupported("vocab piece".into()))?;
        let score = entry[1].as_f64().ok_or_else(|| unsupported("vocab score".into()))?;
        min_score = min_score.min(score);
        max_chars = max_chars.max(piece.chars().count());
        scores.push(score);
        index.insert(Box::<str>::from(piece), id as u32);
    }
    let unk_id = model["unk_id"].as_u64().ok_or_else(|| unsupported("unk_id".into()))? as u32;
    let unk_score = min_score - 10.0;
    scores[unk_id as usize] = unk_score;
    Ok(UnigramVocab { index, scores, max_chars, unk_id, unk_score })
}

/// The special-token ids of the template's `single` sequence before and after its `Sequence` slot.
fn template_special_ids(template: &Value) -> Result<(Vec<u32>, Vec<u32>)> {
    let special_ids = |entry: &Value| -> Vec<u32> {
        let name = entry["SpecialToken"]["id"].as_str().unwrap_or_default();
        template["special_tokens"][name]["ids"].as_array().into_iter().flatten().filter_map(|id| id.as_u64().map(|id| id as u32)).collect()
    };
    let single = template["single"].as_array().ok_or_else(|| unsupported("template".into()))?;
    let at = single.iter().position(|entry| entry.get("Sequence").is_some()).ok_or_else(|| unsupported("template".into()))?;
    Ok((single[..at].iter().flat_map(special_ids).collect(), single[at + 1..].iter().flat_map(special_ids).collect()))
}

impl UnigramTokenizer {
    /// Loads `tokenizer.json`; any other layout is an error.
    #[allow(clippy::disallowed_methods, reason = "a lane-job body: the model load runs it on the lane")]
    pub fn load(path: &Path, max_length: usize) -> Result<Self> {
        Self::from_json(&read_json(path)?, max_length)
    }

    fn from_json(json: &Value, max_length: usize) -> Result<Self> {
        let model = &json["model"];
        let pre = &json["pre_tokenizer"];
        let template = &json["post_processor"];
        if model["type"] != "Unigram" {
            return Err(unsupported_layout("model", model.get("type")));
        }
        if pre["type"] != "Metaspace" {
            return Err(unsupported_layout("pre-tokenizer", pre.get("type")));
        }
        if template["type"] != "TemplateProcessing" {
            return Err(unsupported_layout("post-processor", template.get("type")));
        }
        let normalizers = parse_normalizers(&json["normalizer"])?;
        let vocab = parse_unigram_vocab(model)?;

        let mut tokenizer = Self {
            normalizers,
            index: vocab.index,
            scores: vocab.scores,
            max_chars: vocab.max_chars,
            unk_id: vocab.unk_id,
            unk_score: vocab.unk_score,
            added: HashMap::new(),
            raw_added: Vec::new(),
            normalized_added: Vec::new(),
            replacement: pre["replacement"].as_str().unwrap_or(META).to_owned(),
            prepend_always: pre["prepend_scheme"].as_str().unwrap_or("always") == "always",
            prepend_first: pre["prepend_scheme"].as_str() == Some("first"),
            prefix: Vec::new(),
            suffix: Vec::new(),
            max_length,
        };
        tokenizer.register_added_tokens(&json["added_tokens"]);
        (tokenizer.prefix, tokenizer.suffix) = template_special_ids(template)?;
        Ok(tokenizer)
    }

    fn register_added_tokens(&mut self, added_tokens: &Value) {
        for token in added_tokens.as_array().into_iter().flatten() {
            let content = token["content"].as_str().unwrap_or_default().to_owned();
            let entry = AddedToken {
                id: token["id"].as_u64().unwrap_or_default() as u32,
                lstrip: token["lstrip"].as_bool().unwrap_or(false),
                rstrip: token["rstrip"].as_bool().unwrap_or(false),
            };
            self.added.insert(content.clone(), entry.clone());
            if token["normalized"].as_bool().unwrap_or(false) {
                let normalized = self.normalize(&content);
                self.normalized_added.push(normalized.clone());
                self.added.insert(normalized, entry);
            } else {
                self.raw_added.push(content);
            }
        }
    }

    fn normalize(&self, text: &str) -> String {
        self.normalizers.iter().fold(text.to_owned(), |acc, step| match step {
            Normalizer::Precompiled => precompiled_normalize(&acc),
            Normalizer::ReplaceRegex(re, content) => re.replace_all_with(&acc, |_| content.clone()),
            Normalizer::ReplaceString(from, content) => acc.replace(from.as_str(), content),
        })
    }

    fn piece_id_or_unk(&self, piece: &str) -> u32 {
        self.index.get(piece).copied().unwrap_or(self.unk_id)
    }

    fn strip_around(&self, sections: Vec<&str>) -> Vec<String> {
        let mut out: Vec<String> = sections.iter().map(|s| (*s).to_owned()).collect();
        // An earlier strip is visible to the later lookups, as the sections are edited in place.
        for i in 0..out.len() {
            let Some(token) = self.added.get(&out[i]) else { continue };
            if token.lstrip && i > 0 {
                out[i - 1] = mixdog_js::js_trim_end(&out[i - 1]).to_owned();
            }
            if token.rstrip && i + 1 < out.len() {
                out[i + 1] = mixdog_js::js_trim_start(&out[i + 1]).to_owned();
            }
        }
        out
    }

    fn viterbi(&self, sentence: &str) -> Vec<String> {
        let chars: Vec<(usize, char)> = sentence.char_indices().collect();
        let length = chars.len();
        let byte_at = |i: usize| chars.get(i).map_or(sentence.len(), |(b, _)| *b);
        // Node 0 starts the lattice, node 1 ends it.
        let mut pos = vec![0usize, length];
        let mut len = vec![0usize, 0];
        let mut score = vec![0.0f64, 0.0];
        let mut begins: Vec<Vec<usize>> = vec![Vec::new(); length + 1];
        let mut ends: Vec<Vec<usize>> = vec![Vec::new(); length + 1];
        begins[length].push(1);
        ends[0].push(0);
        let mut insert = |p: usize, l: usize, s: f64, begins: &mut Vec<Vec<usize>>, ends: &mut Vec<Vec<usize>>| {
            let k = pos.len();
            pos.push(p);
            len.push(l);
            score.push(s);
            begins[p].push(k);
            ends[p + l].push(k);
        };
        for b in 0..length {
            let mut single = false;
            let last = length.min(b + self.max_chars);
            for e in b + 1..=last {
                if let Some(&id) = self.index.get(&sentence[byte_at(b)..byte_at(e)]) {
                    insert(b, e - b, self.scores[id as usize], &mut begins, &mut ends);
                    if e - b == 1 {
                        single = true;
                    }
                }
            }
            if !single {
                insert(b, 1, self.unk_score, &mut begins, &mut ends);
            }
        }
        let mut best = vec![0.0f64; pos.len()];
        let mut prev = vec![-1i64; pos.len()];
        for p in 0..=length {
            for &r in &begins[p] {
                let mut from = -1i64;
                let mut top = 0.0f64;
                for &l in &ends[p] {
                    let s = best[l] + score[r];
                    if from == -1 || s > top {
                        from = l as i64;
                        top = s;
                    }
                }
                prev[r] = from;
                best[r] = top;
            }
        }
        let mut out = Vec::new();
        let mut k = prev[begins[length][0]];
        while k > 0 {
            let k_usize = k as usize;
            out.push(sentence[byte_at(pos[k_usize])..byte_at(pos[k_usize] + len[k_usize])].to_owned());
            k = prev[k_usize];
        }
        out.reverse();
        out
    }

    /// Adjacent unknown pieces merge into one. The merge continues only while
    /// the accumulated piece is itself a known piece, as the tokenizer that made
    /// the stored vectors did.
    fn fuse_unk(&self, tokens: Vec<String>) -> Vec<String> {
        let mut fused: Vec<String> = Vec::new();
        let mut i = 0;
        while i < tokens.len() {
            fused.push(tokens[i].clone());
            if self.piece_id_or_unk(&tokens[i]) != self.unk_id {
                i += 1;
                continue;
            }
            i += 1;
            while i < tokens.len() && self.piece_id_or_unk(&tokens[i]) == self.unk_id {
                let last = fused.len() - 1;
                if self.piece_id_or_unk(&fused[last]) != self.unk_id {
                    fused[last].push_str(&tokens[i]);
                }
                i += 1;
            }
        }
        fused
    }

    fn tokens(&self, text: &str) -> Vec<String> {
        let mut out = Vec::new();
        for (section_index, section) in self.strip_around(split_on(&self.raw_added, text)).into_iter().enumerate() {
            if section.is_empty() {
                continue;
            }
            if self.added.contains_key(&section) {
                out.push(section);
                continue;
            }
            let normalized = self.normalize(&section);
            if normalized.is_empty() {
                continue;
            }
            for sub in self.strip_around(split_on(&self.normalized_added, &normalized)) {
                if sub.is_empty() {
                    continue;
                }
                if self.added.contains_key(&sub) {
                    out.push(sub);
                    continue;
                }
                let mut piece = sub.replace(' ', &self.replacement);
                if !piece.starts_with(&self.replacement) && (self.prepend_always || (self.prepend_first && section_index == 0)) {
                    piece.insert_str(0, &self.replacement);
                }
                out.extend(self.fuse_unk(self.viterbi(&piece)));
            }
        }
        out
    }

    /// Token ids with the template's special tokens, cut to the model window.
    pub fn encode(&self, text: &str) -> Vec<i64> {
        let body = self.tokens(text).into_iter().map(|token| self.added.get(&token).map_or_else(|| self.piece_id_or_unk(&token), |t| t.id));
        let mut ids: Vec<i64> = self.prefix.iter().copied().chain(body).chain(self.suffix.iter().copied()).map(i64::from).collect();
        ids.truncate(self.max_length);
        ids
    }
}

#[allow(clippy::disallowed_methods, reason = "a lane-job body: the model load runs it on the lane")]
fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&std::fs::read(path)?).map_err(|error| MemoryError::Runtime(format!("tokenizer.json: {error}")))
}

/// The tokenizer a model's `tokenizer.json` describes: the Unigram one the stored vectors were made with, or a
/// byte-level BPE (the Granite profile, which Node read through the library's `AutoTokenizer`).
pub enum Tokenizer {
    Unigram(Box<UnigramTokenizer>),
    ByteLevelBpe(Box<ByteLevelBpe>),
}

impl Tokenizer {
    /// Loads `tokenizer.json`; a layout that is neither is an error.
    pub fn load(path: &Path, max_length: usize) -> Result<Self> {
        let json = read_json(path)?;
        if json["model"]["type"] == "BPE" {
            return Ok(Self::ByteLevelBpe(Box::new(ByteLevelBpe::from_json(&json, max_length)?)));
        }
        Ok(Self::Unigram(Box::new(UnigramTokenizer::from_json(&json, max_length)?)))
    }

    pub fn encode(&self, text: &str) -> Vec<i64> {
        match self {
            Self::Unigram(tokenizer) => tokenizer.encode(text),
            Self::ByteLevelBpe(tokenizer) => tokenizer.encode(text),
        }
    }
}

/// GPT-2's byte → printable character table, which a byte-level vocabulary is spelled in.
fn byte_chars() -> [char; 256] {
    let mut table = ['\0'; 256];
    let mut next = 256u32;
    for (byte, slot) in table.iter_mut().enumerate() {
        let b = byte as u32;
        *slot = if (33..=126).contains(&b) || (161..=172).contains(&b) || (174..=255).contains(&b) {
            char::from_u32(b).unwrap_or_default()
        } else {
            next += 1;
            char::from_u32(next - 1).unwrap_or_default()
        };
    }
    table
}

/// The `\s` of the pinned tokenizer is Unicode White_Space; the regex engine's JavaScript `\s` also holds U+FEFF. Written
/// out as its members, in a class or as one.
fn white_space_classes(pattern: &str) -> String {
    const MEMBERS: &str = "\\t-\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000";
    let mut out = String::new();
    let (mut in_class, mut chars) = (false, pattern.chars());
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('s') if in_class => out.push_str(MEMBERS),
                Some('s') => out.push_str(&format!("[{MEMBERS}]")),
                Some('S') if !in_class => out.push_str(&format!("[^{MEMBERS}]")),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            },
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            other => out.push(other),
        }
    }
    out
}

/// A `(?i:...)` group written out as character classes, which the regex engine's flag set has no group form for.
fn expand_case_groups(pattern: &str) -> String {
    let mut out = String::new();
    let mut rest = pattern;
    while let Some(at) = rest.find("(?i:") {
        out.push_str(&rest[..at]);
        let body = &rest[at + 4..];
        let end = body.find(')').unwrap_or(body.len());
        out.push_str("(?:");
        for c in body[..end].chars() {
            if c.is_ascii_alphabetic() {
                out.push_str(&format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase()));
            } else {
                out.push(c);
            }
        }
        rest = &body[end..];
    }
    out.push_str(rest);
    out
}

/// The regex `Split` and the `ByteLevel` step of the pre-tokenizer: the split pattern and `add_prefix_space`.
fn parse_byte_level_pre_tokenizer(pre: &Value, steps: Vec<&Value>) -> Result<(JsRegex, bool)> {
    let (mut split, mut add_prefix_space, mut byte_level) = (None, false, false);
    for step in steps {
        match step["type"].as_str() {
            Some("Split") if step["behavior"] == "Isolated" && step["invert"] != true && step["pattern"]["Regex"].is_string() => {
                let pattern = white_space_classes(&expand_case_groups(step["pattern"]["Regex"].as_str().unwrap_or_default()));
                split = Some(JsRegex::new(&pattern, "gu").map_err(|error| unsupported(format!("split regex: {error}")))?);
            }
            Some("ByteLevel") if step["use_regex"] != true => {
                byte_level = true;
                add_prefix_space = step["add_prefix_space"].as_bool().unwrap_or(false);
            }
            _ => return Err(unsupported_layout("pre-tokenizer", step.get("type"))),
        }
    }
    let (Some(split), true) = (split, byte_level) else {
        return Err(unsupported_layout("pre-tokenizer", pre.get("type")));
    };
    Ok((split, add_prefix_space))
}

fn parse_merges(merges: &Value, vocab: &HashMap<String, u32>) -> Result<HashMap<(u32, u32), (usize, u32)>> {
    let mut ranked = HashMap::new();
    for (rank, merge) in merges.as_array().ok_or_else(|| unsupported("merges".into()))?.iter().enumerate() {
        let pair = match merge {
            Value::String(joined) => joined.split_once(' ').map(|(a, b)| (a.to_owned(), b.to_owned())),
            Value::Array(parts) => match (parts.first().and_then(Value::as_str), parts.get(1).and_then(Value::as_str)) {
                (Some(a), Some(b)) => Some((a.to_owned(), b.to_owned())),
                _ => None,
            },
            _ => None,
        };
        let (a, b) = pair.ok_or_else(|| unsupported("merge".into()))?;
        if let (Some(&ia), Some(&ib), Some(&out)) = (vocab.get(&a), vocab.get(&b), vocab.get(&format!("{a}{b}"))) {
            ranked.entry((ia, ib)).or_insert((rank, out));
        }
    }
    Ok(ranked)
}

/// Byte-level BPE (`model.type` BPE, a regex `Split` then `ByteLevel`): a pre-token found whole in the vocabulary is one
/// token (`ignore_merges`), else the lowest-ranked adjacent pair merges until none is left.
pub struct ByteLevelBpe {
    vocab: HashMap<String, u32>,
    /// (left id, right id) → (rank, merged id), the lowest rank winning a duplicate pair.
    merges: HashMap<(u32, u32), (usize, u32)>,
    ignore_merges: bool,
    split: JsRegex,
    add_prefix_space: bool,
    byte_char: [char; 256],
    added: HashMap<String, u32>,
    added_words: Vec<String>,
    prefix: Vec<u32>,
    suffix: Vec<u32>,
    max_length: usize,
}

impl ByteLevelBpe {
    fn from_json(json: &Value, max_length: usize) -> Result<Self> {
        let model = &json["model"];
        let pre = &json["pre_tokenizer"];
        let template = &json["post_processor"];
        if template["type"] != "TemplateProcessing" {
            return Err(unsupported_layout("post-processor", template.get("type")));
        }
        let steps: Vec<&Value> =
            if pre["type"] == "Sequence" { pre["pretokenizers"].as_array().map_or_else(Vec::new, |a| a.iter().collect()) } else { vec![pre] };
        let (split, add_prefix_space) = parse_byte_level_pre_tokenizer(pre, steps)?;
        if json["normalizer"] != Value::Null {
            return Err(unsupported_layout("normalizer", json["normalizer"].get("type")));
        }

        let mut vocab = HashMap::new();
        for (piece, id) in model["vocab"].as_object().ok_or_else(|| unsupported("vocab".into()))? {
            vocab.insert(piece.clone(), id.as_u64().ok_or_else(|| unsupported("vocab id".into()))? as u32);
        }
        let merges = parse_merges(&model["merges"], &vocab)?;
        let mut added = HashMap::new();
        let mut added_words = Vec::new();
        for token in json["added_tokens"].as_array().into_iter().flatten() {
            let content = token["content"].as_str().unwrap_or_default().to_owned();
            added.insert(content.clone(), token["id"].as_u64().unwrap_or_default() as u32);
            added_words.push(content);
        }
        let (prefix, suffix) = template_special_ids(template)?;
        Ok(Self {
            vocab,
            merges,
            ignore_merges: model["ignore_merges"].as_bool().unwrap_or(false),
            split,
            add_prefix_space,
            byte_char: byte_chars(),
            added,
            added_words,
            prefix,
            suffix,
            max_length,
        })
    }

    /// The lowest-ranked adjacent pair merges first, the leftmost on a tie; each merge only offers the pairs it made.
    fn word_ids(&self, word: &str, out: &mut Vec<u32>) {
        if self.ignore_merges
            && let Some(&id) = self.vocab.get(word)
        {
            out.push(id);
            return;
        }
        let mut sym: Vec<u32> = Vec::new();
        let mut buffer = [0u8; 4];
        sym.extend(word.chars().filter_map(|c| self.vocab.get(&*c.encode_utf8(&mut buffer)).copied()));
        let n = sym.len();
        let mut next: Vec<i64> = (0..n as i64).map(|i| if i + 1 < n as i64 { i + 1 } else { -1 }).collect();
        let mut prev: Vec<i64> = (0..n as i64).map(|i| i - 1).collect();
        let mut alive = vec![true; n];
        let mut heap: std::collections::BinaryHeap<std::cmp::Reverse<(usize, usize)>> = std::collections::BinaryHeap::new();
        let offer = |heap: &mut std::collections::BinaryHeap<std::cmp::Reverse<(usize, usize)>>, sym: &[u32], next: &[i64], i: usize| {
            let j = next[i];
            if j >= 0
                && let Some((rank, _)) = self.merges.get(&(sym[i], sym[j as usize]))
            {
                heap.push(std::cmp::Reverse((*rank, i)));
            }
        };
        for i in 0..n.saturating_sub(1) {
            offer(&mut heap, &sym, &next, i);
        }
        while let Some(std::cmp::Reverse((rank, i))) = heap.pop() {
            let j = next[i];
            if !alive[i] || j < 0 {
                continue;
            }
            let j = j as usize;
            // A stale entry: a neighbour already merged away or changed.
            let Some(&(current, merged)) = self.merges.get(&(sym[i], sym[j])) else { continue };
            if current != rank {
                continue;
            }
            sym[i] = merged;
            alive[j] = false;
            next[i] = next[j];
            if next[j] >= 0 {
                prev[next[j] as usize] = i as i64;
            }
            if prev[i] >= 0 {
                offer(&mut heap, &sym, &next, prev[i] as usize);
            }
            offer(&mut heap, &sym, &next, i);
        }
        let mut at = 0i64;
        while at != -1 {
            out.push(sym[at as usize]);
            at = next[at as usize];
        }
    }

    fn section_ids(&self, section: &str, out: &mut Vec<u32>) {
        let spaced;
        let text = if self.add_prefix_space && !section.starts_with(' ') {
            spaced = format!(" {section}");
            spaced.as_str()
        } else {
            section
        };
        let mut piece = |raw: &str| {
            let spelled: String = raw.bytes().map(|b| self.byte_char[usize::from(b)]).collect();
            self.word_ids(&spelled, out);
        };
        let mut last = 0;
        for found in self.split.find_iter(text) {
            if found.start > last {
                piece(&text[last..found.start]);
            }
            piece(&text[found.clone()]);
            last = found.end;
        }
        if last < text.len() {
            piece(&text[last..]);
        }
    }

    /// Token ids with the template's special tokens, cut to the model window after the template is applied (as the
    /// pinned Transformers.js does, so a cut window can lose the closing token).
    pub fn encode(&self, text: &str) -> Vec<i64> {
        let mut body = Vec::new();
        for section in split_on(&self.added_words, text) {
            match self.added.get(section) {
                Some(&id) => body.push(id),
                None => self.section_ids(section, &mut body),
            }
        }
        let mut ids: Vec<i64> = self.prefix.iter().copied().chain(body).chain(self.suffix.iter().copied()).map(i64::from).collect();
        ids.truncate(self.max_length);
        ids
    }
}

#[cfg(test)]
mod bpe_tests {
    use super::*;

    /// A copy of the Granite tokenizer.json pruned to what these texts need (every byte, the merges that build the
    /// expected tokens, all added tokens), and the ids the pinned `@huggingface/tokenizers` 0.2.0 / Transformers.js 4.3.1
    /// (`new PreTrainedTokenizer(json, config)(text)`, truncation `true`) produced from the full file.
    fn golden() -> (Tokenizer, Value, std::path::PathBuf) {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/memory/embed/granite_fixture");
        let path = dir.join("tokenizer.json");
        let golden = serde_json::from_slice(&std::fs::read(dir.join("golden.json")).unwrap()).unwrap();
        (Tokenizer::load(&path, 32768).unwrap(), golden, path)
    }

    fn ids(value: &Value) -> Vec<i64> {
        value.as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect()
    }

    #[test]
    fn granite_ids_equal_the_pinned_library_ids() {
        let (tokenizer, golden, path) = golden();
        let text = |case: &str| match case {
            "bom" | "bomfull" => "A\u{feff}\u{feff}B",
            "window4" | "full3" => "one two three",
            // The pinned library splits an added token wherever it occurs and ignores `single_word`.
            "special" => "a<|reserved_200020|>b",
            "hello" => "Hello, world! \u{d55c}\u{ad6d}\u{c5b4} \u{30c6}\u{30b9}\u{30c8} 123456 it's\n\nok  x",
            "qa" => "passage: \u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{a0} x\u{2003}y",
            other => panic!("{other}"),
        };
        for case in ["bomfull", "full3", "special", "hello", "qa"] {
            assert_eq!(tokenizer.encode(text(case)), ids(&golden[case]), "{case}");
        }
        // U+FEFF is not White_Space: the body is `A`, two FEFF, `B` as the library has it.
        let body = tokenizer.encode(text("bom"));
        assert_eq!(&body[1..body.len() - 1], ids(&golden["bom"]).as_slice());
        // A four-id window is cut after the template, so it ends on the last body token.
        assert_eq!(Tokenizer::load(&path, 4).unwrap().encode(text("window4")), ids(&golden["window4"]));
    }
}

#[cfg(test)]
mod unigram_tests {
    use super::*;

    fn tokenizer() -> Tokenizer {
        let json = serde_json::json!({
            "model": {"type": "Unigram", "unk_id": 0, "vocab": [["<unk>", 0.0], ["\u{2581}a", -1.0], ["\u{2581}b", -1.5], ["a", -2.0], ["b", -2.0], ["\u{2581}", -3.0]]},
            "pre_tokenizer": {"type": "Metaspace", "replacement": "\u{2581}", "prepend_scheme": "always"},
            "normalizer": {"type": "Sequence", "normalizers": [{"type": "Replace", "pattern": {"String": "x"}, "content": "a"}]},
            "post_processor": {
                "type": "TemplateProcessing",
                "single": [{"SpecialToken": {"id": "<s>", "type_id": 0}}, {"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}}],
                "special_tokens": {"<s>": {"id": "<s>", "ids": [7], "tokens": ["<s>"]}, "</s>": {"id": "</s>", "ids": [8], "tokens": ["</s>"]}}
            },
            "added_tokens": [{"id": 9, "content": "<mask>", "lstrip": true, "rstrip": false, "normalized": false}]
        });
        let path = std::env::temp_dir().join(format!("unigram-{}.json", std::process::id()));
        std::fs::write(&path, serde_json::to_vec(&json).unwrap()).unwrap();
        let loaded = Tokenizer::load(&path, 5);
        std::fs::remove_file(&path).unwrap();
        loaded.unwrap()
    }

    #[test]
    fn encodes_with_the_template_normalizer_and_best_segmentation() {
        let tokenizer = tokenizer();
        assert_eq!(tokenizer.encode("a b"), vec![7, 1, 2, 8]);
        assert_eq!(tokenizer.encode("x"), vec![7, 1, 8]);
    }

    #[test]
    fn an_unknown_piece_is_the_unk_id_and_an_added_token_is_split_out() {
        let tokenizer = tokenizer();
        assert_eq!(tokenizer.encode("z"), vec![7, 5, 0, 8]);
        assert_eq!(tokenizer.encode("a<mask> b"), vec![7, 1, 9, 2, 8]);
    }

    #[test]
    fn the_window_cuts_after_the_template() {
        assert_eq!(tokenizer().encode("a b a b"), vec![7, 1, 2, 1, 2]);
    }

    #[test]
    fn a_layout_other_than_unigram_is_refused() {
        let json = serde_json::json!({"model": {"type": "WordPiece"}});
        assert!(matches!(UnigramTokenizer::from_json(&json, 8), Err(MemoryError::Embedding(text)) if text == "unsupported model WordPiece"));
    }
}
