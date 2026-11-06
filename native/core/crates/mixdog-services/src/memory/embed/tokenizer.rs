//! Unigram tokenizer for the XLM-R family `tokenizer.json` files (multilingual
//! e5, bge-m3): the precompiled-charsmap normalizer stand-in, Metaspace,
//! Viterbi segmentation with its tie-breaking, unknown-piece fusing,
//! added-token splitting and the single-sequence template, then truncation to
//! the model window. Token ids must equal the ones every stored vector was
//! made from, so each step keeps the behaviour of the tokenizer that produced
//! them rather than the textbook algorithm.

use mixdog_js::{JsRegex};
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

fn precompiled_normalize(text: &str) -> String {
    static CONTROL: LazyLock<JsRegex> =
        LazyLock::new(|| JsRegex::new_static("[\u{1}-\u{8}\u{B}\u{E}-\u{1F}\u{7F}\u{8F}\u{9F}]", "g"));
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

impl UnigramTokenizer {
    /// Loads `tokenizer.json`; any other layout is an error.
    #[allow(clippy::disallowed_methods, reason = "a lane-job body: the model load runs it on the lane")]
    pub fn load(path: &Path, max_length: usize) -> Result<Self> {
        let json: Value = serde_json::from_slice(&std::fs::read(path)?)
            .map_err(|error| MemoryError::Runtime(format!("tokenizer.json: {error}")))?;
        let model = &json["model"];
        let pre = &json["pre_tokenizer"];
        let template = &json["post_processor"];
        if model["type"] != "Unigram" {
            return Err(unsupported(format!("model {}", model["type"])));
        }
        if pre["type"] != "Metaspace" {
            return Err(unsupported(format!("pre-tokenizer {}", pre["type"])));
        }
        if template["type"] != "TemplateProcessing" {
            return Err(unsupported(format!("post-processor {}", template["type"])));
        }
        let steps: Vec<&Value> = match &json["normalizer"] {
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
                    JsRegex::new(step["pattern"]["Regex"].as_str().unwrap_or_default(), "gu")
                        .map_err(|error| unsupported(format!("normalizer regex: {error}")))?,
                    content,
                ),
                Some("Replace") if step["pattern"]["String"].is_string() => {
                    Normalizer::ReplaceString(step["pattern"]["String"].as_str().unwrap_or_default().to_owned(), content)
                }
                other => return Err(unsupported(format!("normalizer {other:?}"))),
            });
        }

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
            // A duplicated piece resolves to its last id.
            index.insert(Box::<str>::from(piece), id as u32);
        }
        let unk_id = model["unk_id"].as_u64().ok_or_else(|| unsupported("unk_id".into()))? as u32;
        let unk_score = min_score - 10.0;
        scores[unk_id as usize] = unk_score;

        let mut tokenizer = Self {
            normalizers,
            index,
            scores,
            max_chars,
            unk_id,
            unk_score,
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
        for token in json["added_tokens"].as_array().into_iter().flatten() {
            let content = token["content"].as_str().unwrap_or_default().to_owned();
            let entry = AddedToken {
                id: token["id"].as_u64().unwrap_or_default() as u32,
                lstrip: token["lstrip"].as_bool().unwrap_or(false),
                rstrip: token["rstrip"].as_bool().unwrap_or(false),
            };
            tokenizer.added.insert(content.clone(), entry.clone());
            if token["normalized"].as_bool().unwrap_or(false) {
                let normalized = tokenizer.normalize(&content);
                tokenizer.normalized_added.push(normalized.clone());
                tokenizer.added.insert(normalized, entry);
            } else {
                tokenizer.raw_added.push(content);
            }
        }
        let special_ids = |entry: &Value| -> Vec<u32> {
            let name = entry["SpecialToken"]["id"].as_str().unwrap_or_default();
            template["special_tokens"][name]["ids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_u64().map(|id| id as u32))
                .collect()
        };
        let single = template["single"].as_array().ok_or_else(|| unsupported("template".into()))?;
        let at = single.iter().position(|entry| entry.get("Sequence").is_some()).ok_or_else(|| unsupported("template".into()))?;
        tokenizer.prefix = single[..at].iter().flat_map(special_ids).collect();
        tokenizer.suffix = single[at + 1..].iter().flat_map(special_ids).collect();
        Ok(tokenizer)
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
        let body = self
            .tokens(text)
            .into_iter()
            .map(|token| self.added.get(&token).map_or_else(|| self.piece_id_or_unk(&token), |t| t.id));
        let mut ids: Vec<i64> = self.prefix.iter().copied().chain(body).chain(self.suffix.iter().copied()).map(i64::from).collect();
        ids.truncate(self.max_length);
        ids
    }
}
