//! GGUF metadata parsing and the memory plan. Only metadata is parsed; tensor data and
//! unneeded token arrays stay outside the retained result, and all counts and prefix reads
//! have explicit bounds.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::context::{LOCAL_CONTEXT_DEFAULT_TOKENS, LOCAL_CONTEXT_MIN_TOKENS};

const GIB: i64 = 1024 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum GgufError {
    /// The inspected prefix ended inside the metadata; retry with a longer prefix.
    #[error("GGUF metadata exceeds the inspected prefix")]
    NeedMore,
    #[error("{0}")]
    Invalid(String),
}

fn bad<T>(message: impl Into<String>) -> Result<T, GgufError> {
    Err(GgufError::Invalid(message.into()))
}

#[derive(Debug, Clone, PartialEq)]
pub struct GgufHeader {
    pub version: u32,
    pub architecture: String,
    /// Retained numeric keys: `general.architecture` is `architecture`; the rest are numbers.
    pub metadata: HashMap<String, f64>,
}

fn width(kind: u32) -> Option<usize> {
    match kind {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn need(&self, n: usize) -> Result<(), GgufError> {
        if self.at.checked_add(n).is_none_or(|end| end > self.buf.len()) { Err(GgufError::NeedMore) } else { Ok(()) }
    }
    fn u32(&mut self) -> Result<u32, GgufError> {
        self.need(4)?;
        let v = u32::from_le_bytes(self.buf[self.at..self.at + 4].try_into().unwrap());
        self.at += 4;
        Ok(v)
    }
    fn u64(&mut self) -> Result<usize, GgufError> {
        self.need(8)?;
        let v = u64::from_le_bytes(self.buf[self.at..self.at + 8].try_into().unwrap());
        self.at += 8;
        if v > (1u64 << 53) - 1 {
            return bad("GGUF count exceeds safe integer range");
        }
        Ok(v as usize)
    }
    fn str(&mut self, retain: bool) -> Result<Option<String>, GgufError> {
        let len = self.u64()?;
        if len > 16 * 1024 * 1024 {
            return bad("GGUF string exceeds metadata limit");
        }
        self.need(len)?;
        let out = retain.then(|| String::from_utf8_lossy(&self.buf[self.at..self.at + len]).into_owned());
        self.at += len;
        Ok(out)
    }
    /// A numeric value, a string (as `Text`), or nothing for arrays and unretained values.
    fn value(&mut self, kind: u32, retain: bool, depth: u32) -> Result<Item, GgufError> {
        if depth > 1 {
            return bad("GGUF nested arrays are unsupported");
        }
        if kind == 8 {
            return Ok(self.str(retain)?.map_or(Item::None, Item::Text));
        }
        if kind == 9 {
            let element = self.u32()?;
            let count = self.u64()?;
            if count > 1_000_000 {
                return bad("GGUF array exceeds metadata limit");
            }
            if let Some(w) = width(element) {
                let bytes = count * w;
                self.need(bytes)?;
                self.at += bytes;
            } else {
                for _ in 0..count {
                    self.value(element, false, depth + 1)?;
                }
            }
            return Ok(Item::None);
        }
        let Some(w) = width(kind) else { return bad(format!("Unsupported GGUF metadata type {kind}")) };
        self.need(w)?;
        let b = &self.buf[self.at..self.at + w];
        let out = if !retain {
            Item::None
        } else {
            match kind {
                4 => Item::Number(u32::from_le_bytes(b.try_into().unwrap()) as f64),
                5 => Item::Number(i32::from_le_bytes(b.try_into().unwrap()) as f64),
                10 => Item::Number(u64::from_le_bytes(b.try_into().unwrap()) as f64),
                7 => Item::Number(f64::from(b[0] != 0)),
                6 => Item::Number(f64::from(f32::from_le_bytes(b.try_into().unwrap()))),
                _ => Item::None,
            }
        };
        self.at += w;
        Ok(out)
    }
}

enum Item {
    None,
    Number(f64),
    Text(String),
}

fn retained(key: &str) -> bool {
    key == "general.architecture"
        || ["context_length", "block_count", "embedding_length", "head_count", "head_count_kv", "key_length", "value_length"]
            .iter()
            .any(|s| key.strip_suffix(s).is_some_and(|rest| rest.ends_with('.')))
}

pub fn parse_gguf_header(buffer: &[u8]) -> Result<GgufHeader, GgufError> {
    let mut r = Reader { buf: buffer, at: 0 };
    r.need(4)?;
    if &buffer[..4] != b"GGUF" {
        return bad("Selected file is not GGUF");
    }
    r.at = 4;
    let version = r.u32()?;
    if version != 2 && version != 3 {
        return bad(format!("Unsupported GGUF version {version}"));
    }
    let tensor_count = r.u64()?;
    let count = r.u64()?;
    if tensor_count == 0 || count > 100_000 {
        return bad("Invalid GGUF model metadata counts");
    }
    let mut numbers = HashMap::new();
    let mut architecture = None;
    for _ in 0..count {
        let key = r.str(true)?.unwrap_or_default();
        if mixdog_js::utf16_len(&key) > 1024 {
            return bad("GGUF key exceeds metadata limit");
        }
        let keep = retained(&key);
        let kind = r.u32()?;
        match r.value(kind, keep, 0)? {
            Item::Number(n) if keep => {
                numbers.insert(key, n);
            }
            Item::Text(t) if keep && key == "general.architecture" => architecture = Some(t),
            _ => {}
        }
    }
    let Some(architecture) = architecture else { return unsupported() };
    let ok = ["context_length", "block_count", "embedding_length", "attention.head_count", "attention.head_count_kv"]
        .iter()
        .all(|name| numbers.get(&format!("{architecture}.{name}")).is_some_and(|n| n.is_finite()));
    if ok { Ok(GgufHeader { version, architecture, metadata: numbers }) } else { unsupported() }
}

fn unsupported<T>() -> Result<T, GgufError> {
    bad("This GGUF lacks the attention metadata needed for a supported memory estimate; auxiliary or unsupported architecture files cannot be registered.")
}

/// Memory plan for the requested context (a q8_0 K/V cache: 34 bytes per 32 values).
pub fn gguf_memory_plan(header: &GgufHeader, file_size: i64, requested: i64) -> Result<Value, GgufError> {
    if !(LOCAL_CONTEXT_MIN_TOKENS..=32768).contains(&requested) {
        return bad(format!("contextWindow must be between {LOCAL_CONTEXT_MIN_TOKENS} and 32768 tokens."));
    }
    let arch = &header.architecture;
    if arch.is_empty() || !arch.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return bad("Invalid GGUF architecture");
    }
    let positive = |name: &str| -> Result<i64, GgufError> {
        match header.metadata.get(&format!("{arch}.{name}")) {
            Some(v) if v.fract() == 0.0 && *v > 0.0 && *v < 9e15 => Ok(*v as i64),
            _ => bad(format!("GGUF {name} is not a positive integer")),
        }
    };
    let model_context = positive("context_length")?;
    if model_context < LOCAL_CONTEXT_MIN_TOKENS {
        return bad(format!("This model supports only {model_context} context tokens; agent work needs at least {LOCAL_CONTEXT_MIN_TOKENS}."));
    }
    let context_window = requested.min(model_context);
    let dimension = positive("embedding_length")? as f64 / positive("attention.head_count")? as f64;
    let dim = |name: &str| header.metadata.get(&format!("{arch}.attention.{name}")).copied().filter(|v| *v != 0.0).unwrap_or(dimension);
    let (key, val) = (dim("key_length"), dim("value_length"));
    if ![key, val].iter().all(|n| n.fract() == 0.0 && *n > 0.0) {
        return bad("Unsupported GGUF attention dimensions");
    }
    let kv = (context_window as f64 * positive("block_count")? as f64 * positive("attention.head_count_kv")? as f64 * (key + val) * 34.0 / 32.0).ceil();
    let estimated = file_size as f64 + kv + GIB as f64;
    if estimated >= 9e15 {
        return bad("GGUF memory estimate exceeds safe range");
    }
    let estimated = estimated as i64;
    Ok(json!({
        "architecture": arch,
        "contextWindow": context_window,
        "maxContextWindow": model_context,
        "estimatedVramBytes": estimated,
        "minimumVramBytes": estimated,
        "memoryEstimate": {
            "weightsBytes": file_size,
            "kvBytes": kv as i64,
            "runtimeReserveBytes": GIB,
            "basis": "weights + q8_0 attention KV + runtime reserve; estimate, not load verification",
        },
    }))
}

pub fn default_gguf_memory_plan(header: &GgufHeader, file_size: i64, max_gpu_memory: i64) -> Result<Value, GgufError> {
    let plan = gguf_memory_plan(header, file_size, LOCAL_CONTEXT_DEFAULT_TOKENS)?;
    if plan["contextWindow"].as_i64().unwrap_or(0) <= LOCAL_CONTEXT_MIN_TOKENS {
        return Ok(plan);
    }
    // Take the default window when the largest GPU holds it, else the agent minimum.
    if plan["estimatedVramBytes"].as_i64().unwrap_or(i64::MAX) <= max_gpu_memory {
        Ok(plan)
    } else {
        gguf_memory_plan(header, file_size, LOCAL_CONTEXT_MIN_TOKENS)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn kv_str(out: &mut Vec<u8>, key: &str, value: &str) {
        out.extend((key.len() as u64).to_le_bytes());
        out.extend(key.as_bytes());
        out.extend(8u32.to_le_bytes());
        out.extend((value.len() as u64).to_le_bytes());
        out.extend(value.as_bytes());
    }

    fn kv_u32(out: &mut Vec<u8>, key: &str, value: u32) {
        out.extend((key.len() as u64).to_le_bytes());
        out.extend(key.as_bytes());
        out.extend(4u32.to_le_bytes());
        out.extend(value.to_le_bytes());
    }

    pub(crate) fn sample(context: u32) -> Vec<u8> {
        let mut out = b"GGUF".to_vec();
        out.extend(3u32.to_le_bytes());
        out.extend(1u64.to_le_bytes());
        out.extend(8u64.to_le_bytes());
        kv_str(&mut out, "general.architecture", "llama");
        kv_u32(&mut out, "llama.context_length", context);
        kv_u32(&mut out, "llama.block_count", 32);
        kv_u32(&mut out, "llama.embedding_length", 4096);
        kv_u32(&mut out, "llama.attention.head_count", 32);
        kv_u32(&mut out, "llama.attention.head_count_kv", 8);
        // An unretained array is skipped without being kept.
        out.extend(("tokenizer.ggml.tokens".len() as u64).to_le_bytes());
        out.extend(b"tokenizer.ggml.tokens");
        out.extend(9u32.to_le_bytes());
        out.extend(4u32.to_le_bytes());
        out.extend(3u64.to_le_bytes());
        out.extend([0u8; 12]);
        kv_str(&mut out, "general.name", "x");
        out
    }

    #[test]
    fn metadata_is_parsed_and_a_short_prefix_asks_for_more() {
        let bytes = sample(131_072);
        let header = parse_gguf_header(&bytes).unwrap();
        assert_eq!((header.version, header.architecture.as_str()), (3, "llama"));
        assert_eq!(header.metadata["llama.attention.head_count_kv"], 8.0);
        assert_eq!(parse_gguf_header(&bytes[..bytes.len() - 5]), Err(GgufError::NeedMore));
        assert!(matches!(parse_gguf_header(b"NOPE...."), Err(GgufError::Invalid(_))));
    }

    #[test]
    fn memory_plan_is_weights_plus_q8_kv_plus_reserve() {
        let header = parse_gguf_header(&sample(131_072)).unwrap();
        let plan = gguf_memory_plan(&header, 1_000_000_000, 32_768).unwrap();
        // 32768 ctx * 32 layers * 8 kv heads * (128 + 128) * 34 / 32
        let kv = 32_768i64 * 32 * 8 * 256 * 34 / 32;
        assert_eq!(plan["memoryEstimate"]["kvBytes"], kv);
        assert_eq!(plan["estimatedVramBytes"], 1_000_000_000 + kv + GIB);
        assert_eq!((plan["contextWindow"].clone(), plan["maxContextWindow"].clone()), (json!(32_768), json!(131_072)));
        assert!(gguf_memory_plan(&header, 1, 1000).is_err());
        let small = parse_gguf_header(&sample(8192)).unwrap();
        assert!(gguf_memory_plan(&small, 1, 16_384).unwrap_err().to_string().contains("only 8192"));
    }

    #[test]
    fn the_default_plan_falls_back_to_the_agent_minimum_when_no_gpu_fits() {
        let header = parse_gguf_header(&sample(131_072)).unwrap();
        let full = default_gguf_memory_plan(&header, 1_000_000_000, i64::MAX).unwrap();
        let reduced = default_gguf_memory_plan(&header, 1_000_000_000, 0).unwrap();
        assert_eq!((full["contextWindow"].clone(), reduced["contextWindow"].clone()), (json!(32_768), json!(16_384)));
    }
}
