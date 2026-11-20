use mixdog_services::local_provider::catalog::{exact_file, file_has_data};
use mixdog_services::local_provider::context::{LOCAL_CONTEXT_DEFAULT_TOKENS, LOCAL_CONTEXT_MIN_TOKENS};
use mixdog_services::local_provider::gguf::{GgufError, GgufHeader, gguf_memory_plan, parse_gguf_header};
use serde_json::json;

const GIB: i64 = 1024 * 1024 * 1024;

/// One metadata entry: its key, value type and the value's bytes.
fn entry(key: &str, kind: u32, value: &[u8]) -> Vec<u8> {
    let mut out = (key.len() as u64).to_le_bytes().to_vec();
    out.extend(key.as_bytes());
    out.extend(kind.to_le_bytes());
    out.extend(value);
    out
}

fn text(key: &str, value: &str) -> Vec<u8> {
    let mut bytes = (value.len() as u64).to_le_bytes().to_vec();
    bytes.extend(value.as_bytes());
    entry(key, 8, &bytes)
}

fn number(key: &str, value: u32) -> Vec<u8> {
    entry(key, 4, &value.to_le_bytes())
}

fn file(version: u32, tensors: u64, entries: &[Vec<u8>]) -> Vec<u8> {
    let mut out = b"GGUF".to_vec();
    out.extend(version.to_le_bytes());
    out.extend(tensors.to_le_bytes());
    out.extend((entries.len() as u64).to_le_bytes());
    for e in entries {
        out.extend(e);
    }
    out
}

/// A model with the attention metadata a memory estimate needs.
fn llama(context: u32, extra: &[Vec<u8>]) -> Vec<u8> {
    let mut entries = vec![
        text("general.architecture", "llama"),
        number("llama.context_length", context),
        number("llama.block_count", 32),
        number("llama.embedding_length", 4096),
        number("llama.attention.head_count", 32),
        number("llama.attention.head_count_kv", 8),
    ];
    entries.extend_from_slice(extra);
    file(3, 291, &entries)
}

fn header(context: u32, extra: &[Vec<u8>]) -> GgufHeader {
    parse_gguf_header(&llama(context, extra)).unwrap()
}

fn invalid(bytes: &[u8]) -> String {
    match parse_gguf_header(bytes) {
        Err(GgufError::Invalid(message)) => message,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_file_that_is_not_a_supported_gguf_is_refused_with_the_reason() {
    assert_eq!(invalid(b"GGML\0\0\0\0\0\0\0\0"), "Selected file is not GGUF");
    assert_eq!(invalid(&file(1, 1, &[])), "Unsupported GGUF version 1");
    assert_eq!(invalid(&file(4, 1, &[])), "Unsupported GGUF version 4");
    assert_eq!(invalid(&file(3, 0, &[])), "Invalid GGUF model metadata counts");
    assert_eq!(invalid(&file(3, 1, &[entry("x.flag", 99, &[0])])), "Unsupported GGUF metadata type 99");
}

#[test]
fn a_gguf_without_the_attention_metadata_cannot_be_planned() {
    let auxiliary = file(3, 5, &[text("general.architecture", "clip"), number("clip.context_length", 77)]);
    assert!(invalid(&auxiliary).starts_with("This GGUF lacks the attention metadata needed for a supported memory estimate"));
    let no_architecture = file(3, 5, &[number("llama.context_length", 8192)]);
    assert!(invalid(&no_architecture).starts_with("This GGUF lacks the attention metadata"));
    // A text where the layer count belongs is no number.
    let mut entries = vec![text("general.architecture", "llama"), text("llama.block_count", "many")];
    entries.extend([
        number("llama.context_length", 8192),
        number("llama.embedding_length", 64),
        number("llama.attention.head_count", 2),
        number("llama.attention.head_count_kv", 1),
    ]);
    assert!(invalid(&file(3, 5, &entries)).starts_with("This GGUF lacks the attention metadata"));
}

#[test]
fn a_truncated_prefix_asks_for_more_wherever_it_ends() {
    let bytes = llama(131_072, &[text("general.name", "a model with a name")]);
    for cut in [0, 3, 5, 12, 30, bytes.len() / 2, bytes.len() - 1] {
        assert_eq!(parse_gguf_header(&bytes[..cut]), Err(GgufError::NeedMore), "cut at {cut}");
    }
    assert!(parse_gguf_header(&bytes).is_ok());
}

#[test]
fn values_that_are_not_metadata_numbers_are_skipped_without_losing_the_rest() {
    // An array of strings (kind 9 of kind 8) sits between the entries the plan needs.
    let mut tokens = 8u32.to_le_bytes().to_vec();
    tokens.extend(2u64.to_le_bytes());
    for token in ["a", "bc"] {
        tokens.extend((token.len() as u64).to_le_bytes());
        tokens.extend(token.as_bytes());
    }
    let parsed = header(8192, &[entry("tokenizer.ggml.tokens", 9, &tokens), number("other.thing", 5)]);
    assert_eq!((parsed.version, parsed.architecture.as_str()), (3, "llama"));
    assert_eq!(parsed.metadata["llama.attention.head_count"], 32.0);
    assert!(!parsed.metadata.contains_key("other.thing"), "only the keys a plan reads are kept");
}

#[test]
fn the_memory_plan_sizes_the_cache_from_the_head_geometry() {
    // Heads of 4096 / 32 = 128 unless the file states the key and value lengths.
    let default_heads = gguf_memory_plan(&header(131_072, &[]), 1_000_000_000, 32_768).unwrap();
    let kv = 32_768i64 * 32 * 8 * (128 + 128) * 34 / 32;
    assert_eq!(default_heads["memoryEstimate"]["kvBytes"], kv);
    assert_eq!(default_heads["estimatedVramBytes"], 1_000_000_000 + kv + GIB);
    assert_eq!(default_heads["minimumVramBytes"], default_heads["estimatedVramBytes"]);

    let stated =
        gguf_memory_plan(&header(131_072, &[number("llama.attention.key_length", 64), number("llama.attention.value_length", 192)]), 1_000_000_000, 32_768)
            .unwrap();
    assert_eq!(stated["memoryEstimate"]["kvBytes"], 32_768i64 * 32 * 8 * (64 + 192) * 34 / 32);
}

#[test]
fn the_window_is_the_request_limited_by_what_the_model_supports() {
    let plan = |context, requested| gguf_memory_plan(&header(context, &[]), 1, requested).unwrap();
    let small_model = plan(20_000, 32_768);
    assert_eq!((&small_model["contextWindow"], &small_model["maxContextWindow"]), (&json!(20_000), &json!(20_000)));
    assert_eq!(plan(131_072, LOCAL_CONTEXT_MIN_TOKENS)["contextWindow"], LOCAL_CONTEXT_MIN_TOKENS);
    assert_eq!(plan(131_072, 32_768)["contextWindow"], 32_768);
    assert_eq!(LOCAL_CONTEXT_DEFAULT_TOKENS, 32_768);
}

#[test]
fn a_requested_window_outside_the_supported_range_is_refused() {
    let parsed = header(131_072, &[]);
    let expected = format!("contextWindow must be between {LOCAL_CONTEXT_MIN_TOKENS} and 32768 tokens.");
    for requested in [LOCAL_CONTEXT_MIN_TOKENS - 1, 32_769, 0, -5] {
        assert_eq!(gguf_memory_plan(&parsed, 1, requested).unwrap_err().to_string(), expected, "{requested}");
    }
}

#[test]
fn a_model_whose_own_window_is_too_small_for_agent_work_is_refused() {
    let message = gguf_memory_plan(&header(8192, &[]), 1, LOCAL_CONTEXT_MIN_TOKENS).unwrap_err().to_string();
    assert_eq!(message, format!("This model supports only 8192 context tokens; agent work needs at least {LOCAL_CONTEXT_MIN_TOKENS}."));
}

// ---- a downloaded file that holds data ----

#[test]
fn a_file_is_data_only_when_its_first_block_is_not_all_zeros() {
    let dir = tempfile::tempdir().unwrap();
    let write = |name: &str, bytes: &[u8]| {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    };
    assert!(!file_has_data(&dir.path().join("missing")));
    assert!(!file_has_data(&write("empty", b"")));
    assert!(!file_has_data(&write("zeros", &[0u8; 10_000])), "a preallocated file is not data");
    assert!(file_has_data(&write("data", b"GGUF")));
    let mut late = vec![0u8; 4096];
    late.push(1);
    assert!(!file_has_data(&write("late", &late)), "only the first 4096 bytes are looked at");
    let mut early = vec![0u8; 4095];
    early.push(1);
    assert!(file_has_data(&write("early", &early)));
}

#[test]
fn an_exact_file_has_the_announced_size_and_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("model.gguf");
    std::fs::write(&path, b"GGUFdata").unwrap();
    assert!(exact_file(&path, 8));
    assert!(!exact_file(&path, 9));
    assert!(!exact_file(&dir.path().join("missing"), 0));
    std::fs::write(&path, [0u8; 8]).unwrap();
    assert!(!exact_file(&path, 8), "the right size but no data");
    assert!(!exact_file(dir.path(), 0), "a folder is no file");
}
