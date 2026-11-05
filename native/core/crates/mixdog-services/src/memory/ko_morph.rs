//! Model-free Korean query normalisation for recall search. It handles only
//! high-confidence particles and common predicate endings; hybrid embedding
//! and substring retrieval cover expressions outside this small set.

use mixdog_js::{JsRegex, js_trim, utf16_len};
use std::sync::LazyLock;



const MIXED_SCRIPT_PARTICLES: &[&str] = &[
    "으로부터", "에게서", "한테서", "께서는", "에서는", "으로는", "에게는", "한테는", "께서", "에서", "으로", "에게", "한테",
    "처럼", "보다", "부터", "까지", "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "의", "도", "만",
];

const HADA_ENDINGS: &[&str] = &[
    "하셨었던", "하셨던", "하였던", "했었던", "했습니다", "하였다", "했는데", "했지만", "했으며", "했던", "해서", "하고",
    "하면", "하는", "했다", "했음",
];

/// Particles stripped whenever at least two syllables remain.
const UNCONDITIONAL_PARTICLES: &[&str] = &[
    "으로부터", "에게서", "한테서", "께서는", "에서는", "에게는", "한테는", "께서", "에서", "에게", "한테", "부터", "까지",
];

/// Particles whose form depends on the stem's final consonant (batchim).
type BatchimTest = fn(u32) -> bool;
const BATCHIM_PARTICLES: &[(&str, BatchimTest)] = &[
    ("으로", |jong| jong != 0 && jong != 8),
    ("은", |jong| jong != 0),
    ("는", |jong| jong == 0),
    ("이", |jong| jong != 0),
    ("가", |jong| jong == 0),
    ("을", |jong| jong != 0),
    ("를", |jong| jong == 0),
    ("과", |jong| jong != 0),
    ("와", |jong| jong == 0),
];

/// Past-attributive endings and the syllable that restores the stem.
const PAST_ATTRIBUTIVE_ENDINGS: &[(&str, &str)] = &[("되었던", ""), ("됐던", ""), ("왔던", "오"), ("겼던", "기")];

static MIXED: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^([a-z0-9_./:-]{2,})(\p{Script=Hangul}+)$", "iu"));
static HANGUL_ONLY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\p{Script=Hangul}+$", "u"));
static TOKEN: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"-{0,2}[\p{L}\p{N}_][\p{L}\p{N}_./:-]*", "gu"));

fn final_consonant_index(text: &str) -> Option<u32> {
    let point = text.chars().next_back()? as u32;
    (0xac00..=0xd7a3).contains(&point).then(|| (point - 0xac00) % 28)
}

fn char_len(text: &str) -> usize {
    utf16_len(text)
}

fn without_suffix<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    value.strip_suffix(suffix)
}

pub fn strip_light_korean_particle(token: &str) -> String {
    let value = js_trim(token);
    if value.is_empty() {
        return String::new();
    }
    if let Some(mixed) = MIXED.captures(value)
        && let (Some(stem), Some(particle)) = (mixed.get(1), mixed.get(2))
        && MIXED_SCRIPT_PARTICLES.contains(&particle) {
            return stem.to_owned();
        }
    if !HANGUL_ONLY.is_match(value) {
        return value.to_owned();
    }
    for suffix in UNCONDITIONAL_PARTICLES {
        if let Some(stem) = without_suffix(value, suffix).filter(|stem| char_len(stem) >= 2) {
            return stem.to_owned();
        }
    }
    for (suffix, accepts) in BATCHIM_PARTICLES {
        let Some(stem) = without_suffix(value, suffix).filter(|stem| char_len(stem) >= 2) else {
            continue;
        };
        if final_consonant_index(stem).is_some_and(accepts) {
            return stem.to_owned();
        }
    }
    value.to_owned()
}

pub fn normalize_light_korean_token(token: &str) -> String {
    let value = strip_light_korean_particle(&js_trim(token).to_lowercase());
    if !HANGUL_ONLY.is_match(&value) {
        return value;
    }
    for ending in HADA_ENDINGS {
        if let Some(stem) = without_suffix(&value, ending).filter(|stem| char_len(stem) >= 2) {
            return stem.to_owned();
        }
    }
    for (ending, restored) in PAST_ATTRIBUTIVE_ENDINGS {
        if let Some(stem) = without_suffix(&value, ending) {
            let restored_stem = format!("{stem}{restored}");
            if char_len(&restored_stem) >= 2 {
                return restored_stem;
            }
        }
    }
    value
}

/// The distinct normalised word tokens of `text`, in order of appearance.
pub fn light_ko_morph_stems(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    TOKEN
        .find_iter(text)
        .map(|range| normalize_light_korean_token(&text[range]))
        .filter(|stem| !stem.is_empty() && seen.insert(stem.clone()))
        .collect()
}

/// Word tokens of already-cleaned text, as the query tokenizer sees them.
pub fn raw_tokens(text: &str) -> Vec<&str> {
    TOKEN.find_iter(text).map(|range| &text[range]).collect()
}
