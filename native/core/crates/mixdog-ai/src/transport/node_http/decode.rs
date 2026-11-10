//! `content-encoding` as the product's `fetch` decodes it (undici's `onHeaders`, `lib/web/fetch/index.js`, recorded in
//! `parity/fixtures/node-decode.json` under the desktop runtime):
//! - the header is lower-cased and split on `,`; more than five codings fail the fetch; the codings are undone last
//!   first, and one that is not `gzip`, `x-gzip`, `deflate`, `br` or `zstd` (after trimming; `identity` and an empty
//!   one included) leaves the whole body as it came;
//! - each coding is Node's zlib stream with undici's settings: `Z_SYNC_FLUSH` and `BROTLI_OPERATION_FLUSH` at the end,
//!   so a stream cut short yields what it decoded and ends; a zstd frame cut short is an error;
//! - what follows a stream's end is Node's rule for that stream: gunzip starts another member unless the next byte is
//!   0 (then it stops), zstd starts another frame when a frame's magic follows, and otherwise the rest is dropped;
//!   nothing after a stream that has stopped is kept;
//! - the output of one read is handed on once the read is decoded, so an error in it ends the body with none of it
//!   (Node's body stream is errored before the read's output reaches the reader), unless it outgrows [`HOLD`].
//!
//! The decoded body is handed on in steps of at most [`STEP`] bytes, each stage decoding only as its output is taken.
//! What the decoder holds is bounded; the body's total is not, as undici's is not.

use std::collections::VecDeque;
use std::io;

use brotli::BrotliDecompressStream;
use brotli::BrotliResult;
use brotli::BrotliState;
use brotli::HeapAlloc;
use brotli::HuffmanCode;
use zstd::stream::raw::InBuffer;
use zstd::stream::raw::Operation;
use zstd::stream::raw::OutBuffer;

/// The most one step of the decoded body holds.
pub const STEP: usize = 64 << 10;

/// The most of one read's output held back until the read is decoded; past it the steps go on at once.
pub const HOLD: usize = 16 << 20;

/// undici's `maxContentEncodings`.
const MAX_CODINGS: usize = 5;

/// The compressed bytes one stage has received and not yet decoded.
#[derive(Default)]
struct Input {
    data: Vec<u8>,
    at: usize,
}

impl Input {
    fn push(&mut self, bytes: &[u8]) {
        if self.at == self.data.len() {
            self.data.clear();
            self.at = 0;
        } else if self.at > 0 {
            // What was decoded is let go of before more comes, so only the undecoded rest is ever kept.
            self.data.drain(..self.at);
            self.at = 0;
        }
        self.data.extend_from_slice(bytes);
    }

    fn left(&self) -> &[u8] {
        &self.data[self.at..]
    }

    fn consume(&mut self, n: usize) {
        self.at += n;
    }

    fn clear(&mut self) {
        self.data = Vec::new();
        self.at = 0;
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn zlib_error(e: &flate2::DecompressError) -> io::Error {
    invalid(e.message().unwrap_or("invalid compressed data"))
}

type BrotliDecoder = BrotliState<HeapAlloc<u8>, HeapAlloc<u32>, HeapAlloc<HuffmanCode>>;

enum Codec {
    /// `createGunzip`. `between`: a member ended and the next byte decides what follows.
    Gzip { inner: flate2::Decompress, between: bool },
    /// `createInflate` (undici's): zlib or raw by the first byte, `None` until it came.
    Deflate(Option<flate2::Decompress>),
    Brotli(Box<BrotliDecoder>),
    /// `createZstdDecompress` (window log at most 23). `in_frame`: a frame has begun and not ended; `between`: one ended.
    Zstd { inner: Box<zstd::stream::raw::Decoder<'static>>, in_frame: bool, between: bool },
}

/// One coding of the body, undone as Node's zlib stream for it undoes it.
struct Stage {
    input: Input,
    codec: Codec,
    /// The stream ended for good: what still comes is dropped.
    stopped: bool,
}

impl Stage {
    fn of(coding: &str) -> Option<Self> {
        let codec = match coding {
            "gzip" | "x-gzip" => Codec::Gzip { inner: flate2::Decompress::new_gzip(15), between: false },
            "deflate" => Codec::Deflate(None),
            "br" => Codec::Brotli(Box::new(BrotliState::new(HeapAlloc::<u8>::new(0), HeapAlloc::<u32>::new(0), HeapAlloc::<HuffmanCode>::new(HuffmanCode::default())))),
            "zstd" => {
                let mut inner = zstd::stream::raw::Decoder::new().ok()?;
                inner.set_parameter(zstd::stream::raw::DParameter::WindowLogMax(23)).ok()?;
                Codec::Zstd { inner: Box::new(inner), in_frame: false, between: false }
            }
            _ => return None,
        };
        Some(Self { input: Input::default(), codec, stopped: false })
    }

    fn push(&mut self, bytes: &[u8]) {
        if !self.stopped && !bytes.is_empty() {
            self.input.push(bytes);
        }
    }

    fn stop(&mut self) {
        self.stopped = true;
        self.input.clear();
    }

    /// Up to [`STEP`] bytes of output; empty when it needs more input or has stopped.
    fn step(&mut self) -> io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(STEP);
        let mut stopping = false;
        while !self.stopped && !stopping && out.len() < STEP {
            let input = self.input.left();
            match &mut self.codec {
                Codec::Gzip { inner, between } => {
                    if *between {
                        // zlib.cc: another member follows unless the next byte is 0, which ends the stream.
                        match input.first() {
                            None => break,
                            Some(0) => {
                                stopping = true;
                                break;
                            }
                            Some(_) => {
                                *inner = flate2::Decompress::new_gzip(15);
                                *between = false;
                            }
                        }
                        continue;
                    }
                    // Called with no input too: the inflater may still hold output a full step left behind.
                    let (before_in, before_out) = (inner.total_in(), out.len());
                    let status = inner.decompress_vec(input, &mut out, flate2::FlushDecompress::Sync).map_err(|e| zlib_error(&e))?;
                    let used = (inner.total_in() - before_in) as usize;
                    *between = status == flate2::Status::StreamEnd;
                    self.input.consume(used);
                    if used == 0 && out.len() == before_out && !*between {
                        break;
                    }
                }
                Codec::Deflate(inner) => {
                    if inner.is_none() {
                        let Some(first) = input.first() else { break };
                        // The first byte tells zlib (CM = 8) from a raw stream (`createInflate`).
                        *inner = Some(flate2::Decompress::new(first & 0x0f == 8));
                    }
                    let Some(inner) = inner.as_mut() else { break };
                    let (before_in, before_out) = (inner.total_in(), out.len());
                    let status = inner.decompress_vec(input, &mut out, flate2::FlushDecompress::Sync).map_err(|e| zlib_error(&e))?;
                    let used = (inner.total_in() - before_in) as usize;
                    self.input.consume(used);
                    if status == flate2::Status::StreamEnd {
                        stopping = true;
                        break;
                    }
                    if used == 0 && out.len() == before_out {
                        break;
                    }
                }
                Codec::Brotli(state) => {
                    let start = out.len();
                    out.resize(STEP, 0);
                    let (mut available_in, mut input_offset) = (input.len(), 0usize);
                    let (mut available_out, mut output_offset, mut total_out) = (STEP - start, start, 0usize);
                    let result = BrotliDecompressStream(
                        &mut available_in,
                        &mut input_offset,
                        input,
                        &mut available_out,
                        &mut output_offset,
                        &mut out,
                        &mut total_out,
                        &mut **state,
                    );
                    out.truncate(output_offset);
                    self.input.consume(input_offset);
                    match result {
                        BrotliResult::ResultFailure => return Err(invalid("Decompression failed")),
                        BrotliResult::ResultSuccess => {
                            stopping = true;
                            break;
                        }
                        BrotliResult::NeedsMoreInput => break,
                        // Output still held: the next call drains it, input or not.
                        BrotliResult::NeedsMoreOutput => {}
                    }
                }
                Codec::Zstd { inner, in_frame, between } => {
                    if *between {
                        // Another frame follows when its magic (or a skippable frame's) does; anything else ends it.
                        if input.len() < 4 {
                            break;
                        }
                        let frame = input[..4] == [0x28, 0xb5, 0x2f, 0xfd] || (input[0] & 0xf0 == 0x50 && input[1..4] == [0x2a, 0x4d, 0x18]);
                        if !frame {
                            stopping = true;
                            break;
                        }
                        *between = false;
                    }
                    if input.is_empty() && !*in_frame {
                        break;
                    }
                    let start = out.len();
                    out.resize(STEP, 0);
                    let mut src = InBuffer::around(input);
                    let mut dst = OutBuffer::around_pos(&mut out[..], start);
                    let hint = inner.run(&mut src, &mut dst).map_err(|e| invalid(e.to_string()))?;
                    let (used, written) = (src.pos(), dst.pos());
                    out.truncate(written);
                    self.input.consume(used);
                    if used > 0 {
                        *in_frame = true;
                    }
                    if hint == 0 {
                        *in_frame = false;
                        *between = true;
                        continue;
                    }
                    if used == 0 && written == start {
                        break;
                    }
                }
            }
        }
        if stopping {
            self.stop();
        }
        Ok(out)
    }

    /// The body is over and everything queued was decoded: a zstd frame left open is Node's `unexpected end of file`;
    /// the zlib and brotli streams end where they are (undici's `finishFlush`).
    fn finish(&self) -> io::Result<()> {
        match &self.codec {
            Codec::Zstd { in_frame: true, .. } if !self.stopped => Err(invalid("unexpected end of file")),
            _ => Ok(()),
        }
    }
}

/// What `content-encoding` asks of the body.
pub enum Codings {
    /// The body as it came.
    Plain,
    Decode(Decoder),
    /// The fetch fails: `too many content-encodings in response: N, maximum allowed is 5`.
    TooMany(String),
}

impl Codings {
    /// undici reads the header joined from every `content-encoding` line, as `fetch`'s header list does.
    pub fn of(header: Option<&str>) -> Self {
        let Some(header) = header.filter(|h| !h.is_empty()) else { return Self::Plain };
        let lower = header.to_lowercase();
        let codings: Vec<&str> = lower.split(',').collect();
        if codings.len() > MAX_CODINGS {
            return Self::TooMany(format!("too many content-encodings in response: {}, maximum allowed is {MAX_CODINGS}", codings.len()));
        }
        let stages: Option<Vec<Stage>> = codings.iter().rev().map(|c| Stage::of(c.trim())).collect();
        match stages {
            Some(stages) if !stages.is_empty() => Self::Decode(Decoder { stages, held: VecDeque::new(), held_len: 0, releasing: false, more: false, ended: false, finished: false }),
            _ => Self::Plain,
        }
    }
}

/// A decoder of one body: [`Decoder::feed`] queues what the socket gave, [`Decoder::step`] hands on the next part of
/// the decoded body, [`Decoder::end`] says the body is over. `stages[0]` undoes the last coding.
pub struct Decoder {
    stages: Vec<Stage>,
    /// The output of the read being decoded, held until it is all decoded (or past [`HOLD`]).
    held: VecDeque<Vec<u8>>,
    held_len: usize,
    releasing: bool,
    /// The last fill stopped at [`HOLD`] with input still to decode.
    more: bool,
    ended: bool,
    finished: bool,
}

impl Decoder {
    /// Queues one read's compressed bytes; nothing is decoded until [`Decoder::step`] asks.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.stages[0].push(bytes);
    }

    /// The body is over: [`Decoder::step`] drains what is queued, then the streams are finished.
    pub fn end(&mut self) {
        self.ended = true;
    }

    /// The next output of stage `k`, decoding upstream as it needs input; empty when every stage up to `k` needs more.
    /// A stage that stopped still drains what comes to it, so an error upstream is still one.
    fn pull(&mut self, k: usize) -> io::Result<Vec<u8>> {
        loop {
            let out = self.stages[k].step()?;
            if !out.is_empty() {
                return Ok(out);
            }
            if k == 0 {
                return Ok(Vec::new());
            }
            let up = self.pull(k - 1)?;
            if up.is_empty() {
                return Ok(Vec::new());
            }
            self.stages[k].push(&up);
        }
    }

    /// The next part of the decoded body, at most [`STEP`] bytes; `None` when the queued input is used up (and, once
    /// the body has ended, when it ended whole). A corrupt stream is an error, and the held output of its read is dropped.
    pub fn step(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            if !self.releasing {
                let last = self.stages.len() - 1;
                self.more = false;
                loop {
                    let out = match self.pull(last) {
                        Ok(out) => out,
                        Err(e) => {
                            self.held.clear();
                            return Err(e);
                        }
                    };
                    if out.is_empty() {
                        break;
                    }
                    self.held_len += out.len();
                    self.held.push_back(out);
                    if self.held_len > HOLD {
                        self.more = true;
                        break;
                    }
                }
                if self.ended && !self.finished && !self.more {
                    self.finished = true;
                    if let Some(e) = self.stages.iter().find_map(|s| s.finish().err()) {
                        self.held.clear();
                        return Err(e);
                    }
                }
                self.releasing = true;
            }
            if let Some(out) = self.held.pop_front() {
                return Ok(Some(out));
            }
            self.releasing = false;
            self.held_len = 0;
            if !self.more {
                return Ok(None);
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn raw(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn br(data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut e = brotli::CompressorWriter::new(&mut out, 4096, 5, 22);
            e.write_all(data).unwrap();
        }
        out
    }

    fn decoder(encoding: &str) -> Decoder {
        match Codings::of(Some(encoding)) {
            Codings::Decode(decoder) => decoder,
            _ => panic!("{encoding} decodes"),
        }
    }

    /// Feeds `reads` as the socket's reads, taking every step after each; the steps, in order.
    fn steps(encoding: &str, reads: &[&[u8]]) -> io::Result<Vec<Vec<u8>>> {
        let mut decoder = decoder(encoding);
        let mut out = Vec::new();
        for read in reads {
            decoder.feed(read);
            while let Some(step) = decoder.step()? {
                out.push(step);
            }
        }
        decoder.end();
        while let Some(step) = decoder.step()? {
            out.push(step);
        }
        Ok(out)
    }

    fn decode(encoding: &str, wire: &[u8]) -> io::Result<Vec<u8>> {
        Ok(steps(encoding, &[wire])?.concat())
    }

    #[test]
    fn a_whole_stream_decodes_and_finishes() {
        assert_eq!(decode("gzip", &gzip(b"hello")).unwrap(), b"hello");
        assert_eq!(decode("deflate", &zlib(b"hello")).unwrap(), b"hello");
        assert_eq!(decode("deflate", &raw(b"hello")).unwrap(), b"hello");
        assert_eq!(decode("br", &br(b"hello")).unwrap(), b"hello");
        // Byte by byte, as reads may split it anywhere, the header included.
        let wire = gzip(b"split everywhere");
        let reads: Vec<&[u8]> = wire.chunks(1).collect();
        assert_eq!(steps("gzip", &reads).unwrap().concat(), b"split everywhere");
    }

    // P2 (recheck): what follows the end of a stream is never kept. A whole stream then a long suffix, read by read:
    // the decoder's queued input stays empty however much comes, for every coding whose stream stops at its end
    // (gzip after a 0 byte, deflate, br, zstd before bytes that are no frame).
    #[test]
    fn what_follows_a_streams_end_is_never_kept() {
        let body = b"the stream itself ".repeat(100);
        let zstd = zstd::bulk::compress(&body, 3).unwrap();
        for (encoding, wire, suffix) in [("gzip", gzip(&body), 0u8), ("deflate", zlib(&body), b'x'), ("deflate", raw(&body), b'x'), ("br", br(&body), b'x'), ("zstd", zstd, b'x')] {
            let mut decoder = decoder(encoding);
            decoder.feed(&wire);
            let mut out = Vec::new();
            while let Some(step) = decoder.step().unwrap() {
                out.extend(step);
            }
            let read = vec![suffix; 16 << 10];
            for _ in 0..256 {
                decoder.feed(&read);
                assert_eq!(decoder.step().unwrap(), None, "{encoding}: nothing comes of the suffix");
                assert!(decoder.stages[0].input.data.capacity() <= 16 << 10, "{encoding}: the suffix is not kept ({} bytes)", decoder.stages[0].input.data.capacity());
            }
            decoder.end();
            assert_eq!(decoder.step().unwrap(), None);
            assert_eq!(out, body, "{encoding}");
        }
    }

    // A single small read that inflates far past 16 MiB (the size of a body's compressed tail on one socket read) is
    // delivered whole, as undici delivers it, in steps the decoder never holds more than one of.
    #[test]
    fn a_small_read_that_inflates_past_16_mib_is_delivered_whole_in_steps() {
        let body = vec![b'a'; 20 << 20];
        let zstd = zstd::bulk::compress(&body, 3).unwrap();
        for (encoding, wire) in [("gzip", gzip(&body)), ("deflate", zlib(&body)), ("deflate", raw(&body)), ("br", br(&body)), ("zstd", zstd)] {
            assert!(wire.len() < 64 << 10, "{encoding}: one read's worth ({} bytes)", wire.len());
            let steps = steps(encoding, &[&wire]).unwrap_or_else(|e| panic!("{encoding}: {e}"));
            assert!(steps.iter().all(|s| !s.is_empty() && s.len() <= STEP), "{encoding}: every step within {STEP} bytes");
            let whole = steps.concat();
            assert!(whole == body, "{encoding}: the whole body ({} of {} bytes)", whole.len(), body.len());
        }
    }
}
