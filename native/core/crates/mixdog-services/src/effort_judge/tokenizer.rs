//! Byte-pair encoder for the effort judge's `tokenizer.json` (a `' '`→`'▁'`
//! normalizer, a single `' '` split that never fires after it, BPE with byte
//! fallback). Only what encoding needs is kept: single-character ids, the
//! byte-fallback ids and the merge table. Ids must equal the ones the model
//! was trained on, so ties and added-token handling follow the reference
//! encoder exactly.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::Path;

use serde::Deserialize;

use crate::effort_judge::error::JudgeError;

const SPACE: char = '\u{2581}';

#[derive(Deserialize)]
#[serde(untagged)]
enum Merge {
    Pair(String, String),
    Joined(String),
}

#[derive(Deserialize)]
struct Model {
    r#type: String,
    vocab: HashMap<String, u32>,
    merges: Vec<Merge>,
    unk_token: Option<String>,
    continuing_subword_prefix: Option<String>,
    end_of_word_suffix: Option<String>,
}

#[derive(Deserialize)]
struct Normalizer {
    r#type: String,
    pattern: Option<StringPattern>,
    content: Option<String>,
}

#[derive(Deserialize)]
struct StringPattern {
    #[serde(rename = "String")]
    string: Option<String>,
}

#[derive(Deserialize)]
struct PreTokenizer {
    r#type: String,
    pattern: Option<StringPattern>,
    split: Option<bool>,
    prepend_scheme: Option<String>,
}

#[derive(Deserialize)]
struct Added {
    content: String,
    id: u32,
    #[serde(default)]
    lstrip: bool,
    #[serde(default)]
    rstrip: bool,
}

#[derive(Deserialize)]
struct Special {
    ids: Vec<u32>,
}

#[derive(Deserialize)]
struct PostProcessor {
    single: Vec<serde_json::Value>,
    special_tokens: HashMap<String, Special>,
}

#[derive(Deserialize)]
struct File {
    model: Model,
    normalizer: Option<Normalizer>,
    pre_tokenizer: Option<PreTokenizer>,
    post_processor: Option<PostProcessor>,
    #[serde(default)]
    added_tokens: Vec<Added>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Split {
    /// A piece starts at every `▁`.
    Metaspace,
    /// The whole segment is one piece.
    Whole,
}

struct AddedToken {
    content: String,
    id: u32,
    lstrip: bool,
    rstrip: bool,
}

pub struct BpeTokenizer {
    char_id: HashMap<char, u32>,
    byte_id: [i64; 256],
    /// (left, right) → (rank, merged id), lowest rank winning duplicates.
    merges: HashMap<(u32, u32), (u32, u32)>,
    unk: i64,
    split: Split,
    prepend: bool,
    /// Added tokens, longest first; `by_first` indexes them by first character.
    added: Vec<AddedToken>,
    by_first: HashMap<char, Vec<usize>>,
    pub prefix: Vec<u32>,
    pub suffix: Vec<u32>,
}

fn unsupported(what: &str) -> JudgeError {
    JudgeError::Load(format!("unsupported tokenizer.json layout for the effort judge: {what}"))
}

impl BpeTokenizer {
    #[allow(clippy::disallowed_methods, reason = "a lane-job body: the model load runs it on the lane")]
    pub fn load(path: &Path) -> Result<Self, JudgeError> {
        let bytes = std::fs::read(path).map_err(|e| JudgeError::Load(format!("tokenizer.json: {e}")))?;
        let file: File = serde_json::from_slice(&bytes).map_err(|e| JudgeError::Load(format!("tokenizer.json: {e}")))?;
        drop(bytes);
        let space_to_meta = file.normalizer.as_ref().is_some_and(|n| {
            n.r#type == "Replace"
                && n.pattern.as_ref().and_then(|p| p.string.as_deref()) == Some(" ")
                && n.content.as_deref() == Some("\u{2581}")
        });
        let pre = file.pre_tokenizer.as_ref();
        let split = match pre {
            Some(p) if p.r#type == "Metaspace" && p.split != Some(false) => Some(Split::Metaspace),
            Some(p)
                if p.r#type == "Split" && p.pattern.as_ref().and_then(|x| x.string.as_deref()) == Some(" ") && space_to_meta =>
            {
                Some(Split::Whole)
            }
            _ => None,
        };
        let model = &file.model;
        let split = match split {
            Some(split) if model.r#type == "BPE" && space_to_meta && model.continuing_subword_prefix.is_none() && model.end_of_word_suffix.is_none() => split,
            _ => return Err(unsupported("model/normalizer/pre-tokenizer")),
        };
        let prepend = split == Split::Metaspace && pre.and_then(|p| p.prepend_scheme.as_deref()).unwrap_or("always") != "never";

        let mut char_id = HashMap::new();
        for (token, id) in &model.vocab {
            let mut chars = token.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                char_id.insert(c, *id);
            }
        }
        let mut byte_id = [-1i64; 256];
        for (b, slot) in byte_id.iter_mut().enumerate() {
            if let Some(id) = model.vocab.get(&format!("<0x{b:02X}>")) {
                *slot = i64::from(*id);
            }
        }
        let mut merges: HashMap<(u32, u32), (u32, u32)> = HashMap::with_capacity(model.merges.len());
        let mut rank = 0u32;
        for merge in &model.merges {
            let (a, b) = match merge {
                Merge::Pair(a, b) => (a.as_str(), b.as_str()),
                Merge::Joined(joined) => {
                    let mut parts = joined.split(' ');
                    (parts.next().unwrap_or_default(), parts.next().unwrap_or_default())
                }
            };
            let (Some(ida), Some(idb), Some(out)) =
                (model.vocab.get(a), model.vocab.get(b), model.vocab.get(&format!("{a}{b}")))
            else {
                continue;
            };
            merges.entry((*ida, *idb)).or_insert((rank, *out));
            rank += 1;
        }
        let unk = model.unk_token.as_ref().and_then(|t| model.vocab.get(t)).map_or(-1, |id| i64::from(*id));

        let mut added: Vec<AddedToken> = file
            .added_tokens
            .iter()
            .map(|t| AddedToken { content: t.content.clone(), id: t.id, lstrip: t.lstrip, rstrip: t.rstrip })
            .collect();
        // Longest (in UTF-16 units) first; equal lengths keep file order.
        added.sort_by_key(|t| Reverse(t.content.encode_utf16().count()));
        let mut by_first: HashMap<char, Vec<usize>> = HashMap::new();
        for (index, token) in added.iter().enumerate() {
            if let Some(first) = token.content.chars().next() {
                by_first.entry(first).or_default().push(index);
            }
        }

        let post = file.post_processor.as_ref().ok_or_else(|| unsupported("post-processor"))?;
        let at = post.single.iter().position(|e| e.get("Sequence").is_some()).ok_or_else(|| unsupported("template"))?;
        let ids_of = |entry: &serde_json::Value| -> Vec<u32> {
            let name = entry["SpecialToken"]["id"].as_str().unwrap_or_default();
            post.special_tokens.get(name).map(|s| s.ids.clone()).unwrap_or_default()
        };
        let prefix = post.single[..at].iter().flat_map(ids_of).collect();
        let suffix = post.single[at + 1..].iter().flat_map(ids_of).collect();

        Ok(Self { char_id, byte_id, merges, unk, split, prepend, added, by_first, prefix, suffix })
    }

    /// Merges the symbols of one piece, lowest rank first and leftmost on ties.
    fn merge_all(&self, ids: Vec<u32>) -> Vec<u32> {
        let n = ids.len();
        let mut sym = ids;
        let mut next: Vec<i64> = (0..n as i64).map(|i| if i + 1 < n as i64 { i + 1 } else { -1 }).collect();
        let mut prev: Vec<i64> = (0..n as i64).map(|i| i - 1).collect();
        let mut alive = vec![true; n];
        let mut heap: BinaryHeap<Reverse<(u32, usize)>> = BinaryHeap::new();
        let offer = |heap: &mut BinaryHeap<Reverse<(u32, usize)>>, sym: &[u32], next: &[i64], i: usize| {
            let j = next[i];
            if j < 0 {
                return;
            }
            if let Some((rank, _)) = self.merges.get(&(sym[i], sym[j as usize])) {
                heap.push(Reverse((*rank, i)));
            }
        };
        for i in 0..n.saturating_sub(1) {
            offer(&mut heap, &sym, &next, i);
        }
        while let Some(Reverse((rank, i))) = heap.pop() {
            let j = next[i];
            if !alive[i] || j < 0 {
                continue;
            }
            let j = j as usize;
            // A stale entry: a neighbour already merged away or changed.
            let Some((current_rank, merged)) = self.merges.get(&(sym[i], sym[j])).copied() else { continue };
            if current_rank != rank {
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
        let mut out = Vec::new();
        let mut i = 0i64;
        while i != -1 {
            out.push(sym[i as usize]);
            i = next[i as usize];
        }
        out
    }

    fn bpe(&self, word: &str, out: &mut Vec<u32>) {
        let mut ids: Vec<u32> = Vec::new();
        for ch in word.chars() {
            match self.char_id.get(&ch) {
                Some(id) => ids.push(*id),
                None => {
                    let mut buffer = [0u8; 4];
                    for byte in ch.encode_utf8(&mut buffer).bytes() {
                        let id = self.byte_id[byte as usize];
                        ids.push(if id >= 0 { id as u32 } else { self.unk as u32 });
                    }
                }
            }
        }
        if ids.len() > 1 {
            out.extend(self.merge_all(ids));
        } else {
            out.extend(ids);
        }
    }

    fn encode_segment(&self, text: &str, out: &mut Vec<u32>) {
        let mut t = text.replace(' ', "\u{2581}");
        if self.prepend && !t.starts_with(SPACE) {
            t.insert(0, SPACE);
        }
        if self.split == Split::Whole {
            self.bpe(&t, out);
            return;
        }
        let mut start = 0;
        for (i, c) in t.char_indices().skip(1) {
            if c == SPACE {
                self.bpe(&t[start..i], out);
                start = i;
            }
        }
        if start < t.len() {
            self.bpe(&t[start..], out);
        }
    }

    /// The earliest added token in `rest` (the longest at that position).
    fn find_added(&self, rest: &str) -> Option<(usize, &AddedToken)> {
        for (pos, c) in rest.char_indices() {
            if let Some(candidates) = self.by_first.get(&c) {
                for index in candidates {
                    let token = &self.added[*index];
                    if rest[pos..].starts_with(token.content.as_str()) {
                        return Some((pos, token));
                    }
                }
            }
        }
        None
    }

    /// Token ids without the template's special tokens.
    pub fn encode(&self, text: &str) -> Vec<u32> {
        let mut out = Vec::new();
        let mut rest = text;
        while !rest.is_empty() {
            let Some((pos, hit)) = self.find_added(rest) else {
                self.encode_segment(rest, &mut out);
                break;
            };
            let mut before = &rest[..pos];
            let mut after = &rest[pos + hit.content.len()..];
            if hit.lstrip {
                before = mixdog_js::js_trim_end(before);
            }
            if hit.rstrip {
                after = mixdog_js::js_trim_start(after);
            }
            if !before.is_empty() {
                self.encode_segment(before, &mut out);
            }
            out.push(hit.id);
            rest = after;
        }
        out
    }
}
