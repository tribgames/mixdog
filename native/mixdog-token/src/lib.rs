use std::panic::{catch_unwind, AssertUnwindSafe};

use bpe_openai::Tokenizer;
use napi::{Error, Result, Status};
use napi_derive::napi;
use rayon::prelude::*;

const CHUNK_BYTES: usize = 16_384;
const BOUNDARY_SCAN_BYTES: usize = 512;

fn tokenizer() -> &'static Tokenizer {
    bpe_openai::o200k_base()
}

fn chunked_count(bpe: &Tokenizer, text: &str) -> usize {
    if text.len() <= CHUNK_BYTES {
        return bpe.count(text);
    }
    let bytes = text.as_bytes();
    let mut ranges = Vec::with_capacity(text.len() / CHUNK_BYTES + 1);
    let mut start = 0usize;
    while start < text.len() {
        let mut end = (start + CHUNK_BYTES).min(text.len());
        if end < text.len() {
            let floor = end.saturating_sub(BOUNDARY_SCAN_BYTES).max(start + 1);
            let mut cut = None;
            let mut cursor = end - 1;
            while cursor >= floor {
                if matches!(bytes[cursor], b' ' | b'\n' | b'\r' | b'\t') {
                    cut = Some(cursor);
                    break;
                }
                if cursor == 0 {
                    break;
                }
                cursor -= 1;
            }
            match cut {
                Some(whitespace) => end = whitespace,
                None => {
                    while end < text.len() && !text.is_char_boundary(end) {
                        end += 1;
                    }
                }
            }
        }
        ranges.push((start, end));
        start = end;
    }
    ranges
        .par_iter()
        .map(|&(from, to)| bpe.count(&text[from..to]))
        .sum()
}

fn count_text(text: &str) -> Result<u32> {
    let count = catch_unwind(AssertUnwindSafe(|| chunked_count(tokenizer(), text)))
        .map_err(|_| Error::new(Status::GenericFailure, "mixdog-token count panicked"))?;
    u32::try_from(count)
        .map_err(|_| Error::new(Status::InvalidArg, "mixdog-token count exceeds u32"))
}

#[napi]
pub fn count_tokens(text: String) -> Result<u32> {
    count_text(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_unicode_and_large_chunked_text() {
        assert!(count_text("hello 워커").expect("count") > 0);
        let text = "hello world ".repeat(10_000);
        assert_eq!(
            count_text(&text).expect("chunked count") as usize,
            tokenizer().count(&text),
        );
    }
}
