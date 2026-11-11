//! memory-light-ko-morph: `strip_light_korean_particle`, `normalize_light_korean_token`,
//! `light_ko_morph_stems` (memory/ko_morph.rs), `tokenize_recall_query` and `build_fts_prefix_query`
//! (memory/query_terms.rs), the prefix query recall/hybrid.rs sends.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, object, opt, same, string};
use crate::memory::ko_morph::{light_ko_morph_stems, normalize_light_korean_token, strip_light_korean_particle};
use crate::memory::query_terms::{build_fts_prefix_query, tokenize_recall_query};

const SET: &str = "memory-light-ko-morph";
/// Node's `tokenizeRecallQuery(text, limit = 24)` default, the limit the prefix query builder uses.
const QUERY_TOKEN_LIMIT: usize = 24;

fn strings(values: Vec<String>) -> Exact {
    Exact::Array(values.into_iter().map(Exact::String).collect())
}

fn token_probes(case_name: &str, tokens: &Exact) {
    for probe in tokens.as_array() {
        let token = probe.get("token").as_str();
        same(&format!("{case_name}: strip {token:?}"), probe.get("strip").get("result"), &string(strip_light_korean_particle(token)));
        same(
            &format!("{case_name}: normalize {token:?}"),
            probe.get("normalize").get("result"),
            &string(normalize_light_korean_token(token)),
        );
    }
}

fn phrase_probe(case_name: &str, phrase: &Exact) {
    let text = phrase.get("text").as_str();
    let what = |part: &str| format!("{case_name}: {part} of {text:?}");
    same(&what("stems"), phrase.get("stems").get("result"), &strings(light_ko_morph_stems(text)));
    same(&what("tokens"), phrase.get("tokens").get("result"), &strings(tokenize_recall_query(text, QUERY_TOKEN_LIMIT)));
    let fts = opt(build_fts_prefix_query(text), |query| object(vec![("query", string(query)), ("prefix", Exact::Bool(true))]));
    same(&what("fts"), phrase.get("fts").get("result"), &fts);
}

#[test]
fn the_recording_has_four_cases() {
    assert_case_count(&golden(SET), 4);
}

#[test]
fn light_korean_normalization_strips_particles_and_high_confidence_predicate_endings() {
    let name = "light Korean normalization strips particles and high-confidence predicate endings";
    let golden = golden(SET);
    let case = case(&golden, 0, name);
    token_probes(name, case.get("tokens"));
    phrase_probe(name, case.get("stems"));
}

#[test]
fn a_query_with_several_product_names_keeps_its_korean_content_words() {
    let name = "a query with several product names keeps its Korean content words";
    let golden = golden(SET);
    phrase_probe(name, case(&golden, 1, name).get("phrase"));
}

#[test]
fn production_recall_uses_light_stems_in_prefix_queries_by_default() {
    let name = "production recall uses light stems in prefix queries by default";
    let golden = golden(SET);
    for phrase in case(&golden, 2, name).get("phrases").as_array() {
        phrase_probe(name, phrase);
    }
}

#[test]
fn further_tokens_and_phrases_beyond_the_test_file() {
    let name = "further tokens and phrases (beyond the test file)";
    let golden = golden(SET);
    let case = case(&golden, 3, name);
    token_probes(name, case.get("tokens"));
    for phrase in case.get("phrases").as_array() {
        phrase_probe(name, phrase);
    }
}
