// mixdog-token — persistent o200k BPE token-count server.
//
// Primary protocol: length-prefixed BINARY frames over stdio — large payloads
// skip JSON escaping/parsing entirely (that overhead dominated once the
// encoder went linear-time).
//   request  : u8 op (1=ping, 2=count) | u32le id | u32le len | len raw utf8
//   response : u8 op                   | u32le id | u64le count
// `count` is u64::MAX for an unknown op. A legacy JSON line (first byte `{`)
// is still answered in JSON, keyed off the first byte, so a stale client or
// manual debugging keeps working; the process exits when stdin closes.
//
// Encoder: github/rust-gems `bpe-openai` — linear-time o200k counting (no
// fancy-regex backtracking, no quadratic degenerate-word blowup, and count()
// never materializes token ids). Chunking is retained purely for rayon
// PARALLELISM on large texts: cuts snap back to the nearest whitespace, which
// o200k tokenizes identically to the unsliced text for prose/JSON; only
// whitespace-free runs fall back to a char-boundary hard cut (±1 token per
// boundary).
use std::io::{self, BufRead, Read, Write};

use rayon::prelude::*;
use serde::Deserialize;
use bpe_openai::Tokenizer;

// With a linear-time encoder the chunk size only balances rayon fan-out
// against boundary drift; 16 KiB keeps ~64 parallel units per MB.
const CHUNK_BYTES: usize = 16_384;
const BOUNDARY_SCAN_BYTES: usize = 512;
// Refuse absurd frames rather than allocating unbounded memory.
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

const OP_PING: u8 = 1;
const OP_COUNT: u8 = 2;

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: u64,
    op: String,
    #[serde(default)]
    text: Option<String>,
}

fn chunked_count(bpe: &Tokenizer, s: &str) -> usize {
    if s.len() <= CHUNK_BYTES {
        return bpe.count(s);
    }
    let bytes = s.as_bytes();
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(s.len() / CHUNK_BYTES + 1);
    let mut start = 0usize;
    while start < s.len() {
        let mut end = (start + CHUNK_BYTES).min(s.len());
        if end < s.len() {
            // Prefer cutting BEFORE a whitespace run: the next chunk then
            // starts with ` word`, which o200k merges exactly as mid-text.
            let floor = end.saturating_sub(BOUNDARY_SCAN_BYTES).max(start + 1);
            let mut cut = None;
            let mut j = end - 1;
            while j >= floor {
                match bytes[j] {
                    b' ' | b'\n' | b'\r' | b'\t' => {
                        cut = Some(j);
                        break;
                    }
                    _ => {}
                }
                if j == 0 {
                    break;
                }
                j -= 1;
            }
            match cut {
                // ASCII whitespace is always a char boundary.
                Some(ws) => end = ws,
                None => {
                    // Degenerate whitespace-free run — hard cut on the nearest
                    // char boundary at/after the target.
                    while end < s.len() && !s.is_char_boundary(end) {
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
        .map(|&(from, to)| bpe.count(&s[from..to]))
        .sum()
}

fn handle_json_line(bpe: &Tokenizer, line: &str, out: &mut impl Write) -> bool {
    if line.trim().is_empty() {
        return true;
    }
    let response = match serde_json::from_str::<Request>(line) {
        Ok(req) => match req.op.as_str() {
            "ping" => serde_json::json!({ "id": req.id, "pong": true }),
            "count" => {
                let text = req.text.unwrap_or_default();
                serde_json::json!({ "id": req.id, "count": chunked_count(bpe, &text) })
            }
            other => serde_json::json!({ "id": req.id, "error": format!("unknown op: {other}") }),
        },
        Err(err) => serde_json::json!({ "id": 0, "error": format!("bad request: {err}") }),
    };
    if writeln!(out, "{response}").is_err() {
        return false;
    }
    out.flush().is_ok()
}

fn main() {
    let bpe = bpe_openai::o200k_base();
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut first = [0u8; 1];
    loop {
        if input.read_exact(&mut first).is_err() {
            break; // stdin closed — parent is gone
        }
        match first[0] {
            b'\n' | b'\r' => continue,
            b'{' => {
                // Legacy JSON line: the leading `{` was already consumed.
                let mut rest = Vec::new();
                if input.read_until(b'\n', &mut rest).is_err() {
                    break;
                }
                let mut line = String::from("{");
                line.push_str(&String::from_utf8_lossy(&rest));
                if !handle_json_line(bpe, &line, &mut out) {
                    break;
                }
            }
            op => {
                let mut header = [0u8; 8];
                if input.read_exact(&mut header).is_err() {
                    break;
                }
                let id = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
                let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
                if len > MAX_FRAME_BYTES {
                    break; // corrupt stream — no way to resync
                }
                let mut payload = vec![0u8; len];
                if len > 0 && input.read_exact(&mut payload).is_err() {
                    break;
                }
                let count: u64 = match op {
                    OP_PING => 0,
                    OP_COUNT => match std::str::from_utf8(&payload) {
                        Ok(s) => chunked_count(bpe, s) as u64,
                        // Invalid UTF-8 cannot reach here from the JS client
                        // (Buffer.from(text,'utf8') is always valid); count the
                        // lossy projection rather than dropping the request.
                        Err(_) => chunked_count(bpe, &String::from_utf8_lossy(&payload)) as u64,
                    },
                    _ => u64::MAX,
                };
                let mut resp = [0u8; 13];
                resp[0] = op;
                resp[1..5].copy_from_slice(&id.to_le_bytes());
                resp[5..13].copy_from_slice(&count.to_le_bytes());
                if out.write_all(&resp).is_err() || out.flush().is_err() {
                    break;
                }
            }
        }
    }
}
