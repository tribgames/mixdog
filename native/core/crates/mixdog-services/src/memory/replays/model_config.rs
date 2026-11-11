//! memory-embedding-model-config: memory/embed/config.rs (`EmbedEnv` for the MIXDOG_EMBED_MODEL /
//! MIXDOG_EMBED_DTYPE settings the daemon composes the embedder from, `known_dims`, `normalize_dtype`,
//! `graph_file`, `pooling`, `output_name`, `default_device`, `InputType::parse`, `prepare_input`).
//! A null model or text (JS `clean(null)`) has no Rust caller: reported per case, not replayed.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, int, opt, opt_str, same, string};
use crate::memory::embed::config::{
    EmbedEnv, InputType, Pooling, default_device, graph_file, known_dims, normalize_dtype, output_name, pooling,
    prepare_input,
};

const SET: &str = "memory-embedding-model-config";

fn pooling_name(model: &str) -> Exact {
    string(match pooling(model) {
        Pooling::Mean => "mean",
        Pooling::Cls => "cls",
    })
}

fn input_type_name(input_type: InputType) -> &'static str {
    match input_type {
        InputType::Query => "query",
        InputType::Document => "document",
    }
}

/// A per-model probe (dims, pooling, output name, device, every dtype). Returns false for a null model.
fn model_probe(case_name: &str, probe: &Exact) -> bool {
    let Ok(Some(model)) = opt_str(probe.get("model")) else { return false };
    let what = |part: &str| format!("{case_name}: {model:?} {part}");
    same(&what("dims"), probe.get("dims").get("result"), &opt(known_dims(model), |d| int(d as i64)));
    same(&what("pooling"), probe.get("pooling").get("result"), &pooling_name(model));
    same(&what("outputName"), probe.get("outputName").get("result"), &string(output_name(model)));
    same(&what("device"), probe.get("device").get("result"), &string(default_device(model)));
    for entry in probe.get("dtypes").as_array() {
        let dtype = opt_str(entry.get("dtype")).expect("dtype is a string, null or undefined");
        same(&what(&format!("dtype {dtype:?}")), entry.get("normalized").get("result"), &string(normalize_dtype(model, dtype)));
        same(&what(&format!("graph file {dtype:?}")), entry.get("graphFile").get("result"), &string(graph_file(model, dtype)));
    }
    true
}

/// Input probes; returns how many have a null text.
fn input_probes(case_name: &str, inputs: &Exact) -> usize {
    let mut null_text = 0;
    for probe in inputs.as_array() {
        let model = probe.get("model").as_str();
        let input_type = InputType::parse(opt_str(probe.get("inputType")).expect("input type"));
        let what = format!("{case_name}: {model} {:?} {:?}", probe.get("inputType"), probe.get("text"));
        same(&format!("{what} type"), probe.get("type").get("result"), &string(input_type_name(input_type)));
        let Some(text) = opt_str(probe.get("text")).expect("text") else {
            null_text += 1;
            continue;
        };
        same(&format!("{what} prepared"), probe.get("prepared").get("result"), &string(prepare_input(text, input_type, model)));
    }
    null_text
}

#[test]
fn the_recording_has_five_cases() {
    assert_case_count(&golden(SET), 5);
}

#[test]
fn multilingual_e5_small_is_the_fixed_production_default() {
    let name = "multilingual E5-small is the fixed production default";
    let golden = golden(SET);
    let case = case(&golden, 0, name);
    for probe in case.get("defaults").as_array() {
        let env = probe.get("env");
        let setting = |key: &str| env.try_get(key).map(|v| v.as_str().to_owned());
        let env = EmbedEnv { model: setting("MIXDOG_EMBED_MODEL"), dtype: setting("MIXDOG_EMBED_DTYPE") };
        let what = |part: &str| format!("{name}: {env:?} {part}");
        let model = env.model_id();
        same(&what("modelId"), probe.get("modelId").get("result"), &string(model.clone()));
        same(&what("dims"), probe.get("dims").get("result"), &opt(known_dims(&model), |d| int(d as i64)));
        same(&what("dtype"), probe.get("dtype").get("result"), &string(env.dtype(&model)));
        same(&what("device"), probe.get("device").get("result"), &string(default_device(&model)));
        same(&what("graphFile"), probe.get("graphFile").get("result"), &string(graph_file(&model, None)));
        same(&what("pooling"), probe.get("pooling").get("result"), &pooling_name(&model));
    }
    assert!(model_probe(name, case.get("e5")));
}

#[test]
fn multilingual_e5_small_applies_asymmetric_retrieval_prefixes() {
    let name = "multilingual E5-small applies asymmetric retrieval prefixes";
    let golden = golden(SET);
    let case = case(&golden, 1, name);
    assert_eq!(input_probes(name, case.get("inputs")), 9, "inputs with a null text");
    // The recorder's `prepareEmbeddingInput(TEXT)` and `(TEXT, 'query')` with the default model (no env setting);
    // TEXT is the first recorded input's text.
    let text = case.get("inputs").as_array()[0].get("text").as_str();
    let model = EmbedEnv::default().model_id();
    let [document, query] = case.get("defaultModelInput").as_array() else { panic!("two default inputs") };
    same(&format!("{name}: default input"), document.get("result"), &string(prepare_input(text, InputType::parse(Some("document")), &model)));
    same(&format!("{name}: default query"), query.get("result"), &string(prepare_input(text, InputType::parse(Some("query")), &model)));
}

#[test]
fn granite_fallback_keeps_its_official_cls_pooling_contract() {
    let name = "Granite fallback keeps its official CLS pooling contract";
    let golden = golden(SET);
    let case = case(&golden, 2, name);
    assert!(model_probe(name, case.get("granite")));
    assert_eq!(input_probes(name, case.get("inputs")), 9, "inputs with a null text");
}

#[test]
fn graph_file_names_follow_the_transformers_js_dtype_suffixes() {
    let name = "graph file names follow the transformers.js dtype suffixes";
    let golden = golden(SET);
    let case = case(&golden, 3, name);
    assert!(model_probe(name, case.get("bgeM3")));
    assert!(model_probe(name, case.get("custom")));
}

#[test]
fn every_other_model_and_dtype_shape() {
    let name = "every other model and dtype shape";
    let golden = golden(SET);
    let case = case(&golden, 4, name);
    let replayed: Vec<bool> = case.get("perModel").as_array().iter().map(|p| model_probe(name, p)).collect();
    assert_eq!(replayed, [true, true, false], "the null model is the JS-only probe");
    assert_eq!(input_probes(name, case.get("inputs")), 18, "inputs with a null text");
}
