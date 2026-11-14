//! `shared/korean-particles.mjs`: a Korean template writes the particle once, after the token: "{{company}}은",
//! "{{name}}이". Which form is right depends on the value that lands there (모아페이는, 한빛상사는, 서울은), so a
//! filled letter read "모아페이은". These are the literal rewrites fill_template runs before its plain token pass, on
//! both backends: the token with the particle as authored and the boundary after it, to the value with the particle
//! its last syllable takes. A value that does not end in a Hangul syllable (a figure, a Latin name) keeps the particle
//! as written.

use mixdog_js::{js_object_keys, js_trim, value_to_string};
use serde_json::Value;

const PAIRS: [(&str, &str); 8] =
    [("으로", "로"), ("이며", "며"), ("이고", "고"), ("은", "는"), ("이", "가"), ("을", "를"), ("과", "와"), ("아", "야")];
/// The particle ends the word only when a space or punctuation follows; "{{name}}이사" is a noun, not 이.
const BOUNDARIES: [&str; 7] = [" ", ",", ".", "\u{b7}", ")", "!", "?"];

/// One literal rewrite: `find` is replaced by `replace` wherever it occurs; `key` is the token it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    pub key: String,
    pub find: String,
    pub replace: String,
}

/// The index of the final consonant of the value's last code point (0 is none); `None` when it is not a Hangul
/// syllable (U+AC00 to U+D7A3).
fn final_consonant(value: &str) -> Option<u32> {
    let code = js_trim(value).chars().next_back()? as u32;
    (0xac00..=0xd7a3).contains(&code).then(|| (code - 0xac00) % 28)
}

/// The particle form after a word whose final consonant index is `jong` (0 = none). 으로 takes 로 after a vowel and
/// after ㄹ (final index 8): 서울로, 부산으로.
fn particle_after<'a>(jong: u32, with_final: &'a str, without_final: &'a str) -> &'a str {
    if with_final == "으로" {
        return if jong == 0 || jong == 8 { without_final } else { with_final };
    }
    if jong != 0 { with_final } else { without_final }
}

/// `koreanParticleReplacements(tokens)`: the rewrites for every token whose value ends in a Hangul syllable. `tokens`
/// that is not an object gives none; an array is read by its indexes, as `Object.entries` does.
pub fn korean_particle_replacements(tokens: &Value) -> Vec<Replacement> {
    let entries: Vec<(String, &Value)> = match tokens {
        Value::Object(map) => js_object_keys(map).into_iter().map(|key| (key.clone(), &map[key])).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(index, item)| (index.to_string(), item)).collect(),
        _ => Vec::new(),
    };
    let mut replacements = Vec::new();
    for (key, raw) in entries {
        let value = if raw.is_null() { String::new() } else { value_to_string(raw) };
        let Some(jong) = final_consonant(&value) else { continue };
        for (with_final, without_final) in PAIRS {
            let right = particle_after(jong, with_final, without_final);
            for authored in [with_final, without_final] {
                for boundary in BOUNDARIES {
                    replacements.push(Replacement {
                        key: key.clone(),
                        find: format!("{{{{{key}}}}}{authored}{boundary}"),
                        replace: format!("{value}{right}{boundary}"),
                    });
                }
            }
        }
    }
    replacements
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rewrite(text: &str, tokens: Value) -> String {
        korean_particle_replacements(&tokens).iter().fold(text.to_owned(), |text, r| text.replace(&r.find, &r.replace))
    }

    #[test]
    fn the_particle_follows_the_last_syllable() {
        assert_eq!(rewrite("{{c}}은 {{d}}은 {{e}}이 {{f}}을 ", json!({ "c": "모아페이", "d": "한빛상사", "e": "서울", "f": "부산" })), "모아페이는 한빛상사는 서울이 부산을 ");
        assert_eq!(rewrite("{{a}}으로 {{b}}으로 {{c}}로 ", json!({ "a": "서울", "b": "부산", "c": "대구" })), "서울로 부산으로 대구로 ");
        assert_eq!(rewrite("{{a}}과 {{b}}와,", json!({ "a": "사과", "b": "책" })), "사과와 책과,");
    }

    #[test]
    fn a_word_that_continues_after_the_particle_is_not_rewritten() {
        assert_eq!(rewrite("{{n}}이사", json!({ "n": "서울" })), "{{n}}이사");
    }

    #[test]
    fn values_without_a_hangul_ending_keep_the_authored_particle() {
        assert!(korean_particle_replacements(&json!({ "a": "ABC", "b": 12, "c": null, "d": "" })).is_empty());
        assert!(korean_particle_replacements(&json!("text")).is_empty());
    }

    #[test]
    fn every_pair_boundary_and_authored_form_is_listed() {
        let all = korean_particle_replacements(&json!({ "n": "한" }));
        assert_eq!(all.len(), PAIRS.len() * 2 * BOUNDARIES.len());
        assert_eq!(all[0], Replacement { key: "n".into(), find: "{{n}}으로 ".into(), replace: "한으로 ".into() });
    }
}
