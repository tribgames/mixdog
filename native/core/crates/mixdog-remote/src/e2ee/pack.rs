//! Plaintext packing inside the authenticated envelope (shared/remote-e2ee-compression.ts):
//! `[0x01][deflate-raw]` when smaller, otherwise the raw bytes.

use std::io::{Read, Write};

use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;

use super::E2eeError;

const DEFLATED: u8 = 0x01;
const COMPRESS_MIN_BYTES: usize = 512;
/// Decoded JSON bound, independent of the encrypted frame (the relay's 64 MiB policy).
pub const MAX_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;

pub fn pack_plaintext(body: &[u8], compress: bool) -> Result<Vec<u8>, E2eeError> {
    if body.len() > MAX_PLAINTEXT_BYTES {
        return Err(E2eeError::TooLarge);
    }
    if !compress || body.len() < COMPRESS_MIN_BYTES {
        return Ok(body.to_vec());
    }
    let mut encoder = DeflateEncoder::new(Vec::with_capacity(body.len() / 2), Compression::default());
    let deflated = encoder
        .write_all(body)
        .and_then(|()| encoder.finish())
        .map_err(|_| E2eeError::Invalid("deflate failed"))?;
    if deflated.len() + 1 >= body.len() {
        return Ok(body.to_vec());
    }
    let mut framed = Vec::with_capacity(deflated.len() + 1);
    framed.push(DEFLATED);
    framed.extend_from_slice(&deflated);
    Ok(framed)
}

pub fn unpack_plaintext(bytes: &[u8], max_output: usize) -> Result<Vec<u8>, E2eeError> {
    if bytes.len() > max_output {
        return Err(E2eeError::TooLarge);
    }
    if bytes.first() != Some(&DEFLATED) {
        return Ok(bytes.to_vec());
    }
    let mut out = Vec::new();
    let read = DeflateDecoder::new(&bytes[1..])
        .take(max_output as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| E2eeError::Invalid("inflate failed"))?;
    if read > max_output {
        return Err(E2eeError::TooLarge);
    }
    Ok(out)
}
