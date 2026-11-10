//! `content-encoding` as `fetch` decodes it (`gzip`, `deflate` (zlib, else raw by the first byte), `br`), as a stream:
//! the compressed reads are queued, and the decoded body is handed on in steps of at most [`STEP`] bytes, each
//! inflated only when the one before it has been taken. What the decoder holds is bounded; the body's total is not,
//! as undici's is not (`fetch/index.js`, the decompression pipeline has no output limit). The stream is finalized at
//! the end of the body, so a truncated or corrupt one is an error, never a short success.

use std::io;
use std::io::BufRead;
use std::io::Read;

use brotli::BrotliDecompressStream;
use brotli::BrotliResult;
use brotli::BrotliState;
use brotli::HeapAlloc;
use brotli::HuffmanCode;

/// The most one step of the decoded body holds.
pub const STEP: usize = 64 << 10;

/// The compressed bytes received and not yet decoded. Empty and not ended, it answers `WouldBlock`, which the
/// `flate2` read decoders take as "no input yet" and leave their state as it was.
#[derive(Default)]
struct Pending {
    data: Vec<u8>,
    at: usize,
    ended: bool,
}

impl Pending {
    fn push(&mut self, bytes: &[u8]) {
        if self.at == self.data.len() {
            self.data.clear();
            self.at = 0;
        }
        self.data.extend_from_slice(bytes);
    }

    fn left(&self) -> &[u8] {
        &self.data[self.at..]
    }
}

impl Read for Pending {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = {
            let have = self.fill_buf()?;
            let n = have.len().min(out.len());
            out[..n].copy_from_slice(&have[..n]);
            n
        };
        self.consume(n);
        Ok(n)
    }
}

impl BufRead for Pending {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.at < self.data.len() || self.ended {
            Ok(&self.data[self.at..])
        } else {
            Err(io::ErrorKind::WouldBlock.into())
        }
    }

    fn consume(&mut self, n: usize) {
        self.at += n;
    }
}

/// A decoder of one body: [`Decoder::feed`] queues what the socket gave, [`Decoder::step`] hands on the next part of
/// the decoded body, [`Decoder::end`] says the body is over.
pub struct Decoder {
    kind: Kind,
    /// Whether any byte came: a body of no bytes is not a truncated stream.
    fed: bool,
}

enum Kind {
    Gzip(Box<flate2::bufread::GzDecoder<Pending>>),
    Zlib(Inflate),
    Raw(Inflate),
    Brotli(Box<Brotli>),
    /// `deflate`, not yet told apart; what came is kept until the first byte decides.
    Deflate(Pending),
}

impl Decoder {
    pub fn of(encoding: Option<&str>) -> Option<Self> {
        let kind = match encoding?.trim().to_ascii_lowercase().as_str() {
            "gzip" | "x-gzip" => Kind::Gzip(Box::new(flate2::bufread::GzDecoder::new(Pending::default()))),
            "deflate" => Kind::Deflate(Pending::default()),
            "br" => Kind::Brotli(Box::default()),
            _ => return None,
        };
        Some(Self { kind, fed: false })
    }

    /// Queues compressed bytes; nothing is decoded until [`Decoder::step`] asks.
    pub fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.fed = true;
        if let Kind::Deflate(pending) = &mut self.kind {
            pending.push(bytes);
            // The first byte tells zlib (CM = 8) from a raw stream (`fetch` does the same).
            let zlib = pending.left()[0] & 0x0f == 8;
            let mut inflate = Inflate::new(zlib);
            inflate.input = std::mem::take(pending);
            self.kind = if zlib { Kind::Zlib(inflate) } else { Kind::Raw(inflate) };
            return;
        }
        self.pending().push(bytes);
    }

    /// The body is over: [`Decoder::step`] drains what is queued, then the stream must have ended.
    pub fn end(&mut self) {
        self.pending().ended = true;
    }

    fn pending(&mut self) -> &mut Pending {
        match &mut self.kind {
            Kind::Gzip(d) => d.get_mut(),
            Kind::Zlib(d) | Kind::Raw(d) => &mut d.input,
            Kind::Brotli(d) => &mut d.input,
            Kind::Deflate(pending) => pending,
        }
    }

    /// The next part of the decoded body, at most [`STEP`] bytes; `None` when the queued input is used up (and, once
    /// the body has ended, when the stream ended whole). A truncated or corrupt stream is an error.
    pub fn step(&mut self) -> io::Result<Option<Vec<u8>>> {
        if !self.fed {
            return Ok(None);
        }
        let ended = self.pending().ended;
        let out = match &mut self.kind {
            Kind::Gzip(d) => {
                let mut out = vec![0u8; STEP];
                match d.read(&mut out) {
                    Ok(n) => {
                        out.truncate(n);
                        out
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => Vec::new(),
                    Err(e) => return Err(e),
                }
            }
            Kind::Zlib(d) | Kind::Raw(d) => d.step()?,
            Kind::Brotli(d) => d.step()?,
            Kind::Deflate(_) => Vec::new(),
        };
        if !out.is_empty() {
            return Ok(Some(out));
        }
        if ended {
            let whole = match &self.kind {
                Kind::Gzip(_) => true, // the gzip reader checked the trailer before it gave its end
                Kind::Zlib(d) | Kind::Raw(d) => d.ended,
                Kind::Brotli(d) => d.ended,
                Kind::Deflate(_) => true,
            };
            if !whole {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the compressed body ends before its stream does"));
            }
        }
        Ok(None)
    }
}

/// A zlib or raw deflate stream, driven directly so that its end is known: `flate2`'s read decoders take the end of
/// the input for the end of the stream.
pub struct Inflate {
    inner: flate2::Decompress,
    input: Pending,
    ended: bool,
}

impl Inflate {
    fn new(zlib: bool) -> Self {
        Self { inner: flate2::Decompress::new(zlib), input: Pending::default(), ended: false }
    }

    fn step(&mut self) -> io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(STEP);
        while !self.ended && out.len() < STEP {
            let input = self.input.left();
            if input.is_empty() {
                break;
            }
            let (before_in, before_out) = (self.inner.total_in(), out.len());
            let status = self
                .inner
                .decompress_vec(input, &mut out, flate2::FlushDecompress::None)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            self.input.consume((self.inner.total_in() - before_in) as usize);
            self.ended = status == flate2::Status::StreamEnd;
            if self.inner.total_in() == before_in && out.len() == before_out {
                break;
            }
        }
        Ok(out)
    }
}

/// A brotli stream (`BrotliDecompressStream`, the decoder's own streaming call), so that each step asks for at most
/// [`STEP`] bytes of output.
pub struct Brotli {
    state: BrotliState<HeapAlloc<u8>, HeapAlloc<u32>, HeapAlloc<HuffmanCode>>,
    input: Pending,
    ended: bool,
}

impl Default for Brotli {
    fn default() -> Self {
        let state = BrotliState::new(HeapAlloc::<u8>::new(0), HeapAlloc::<u32>::new(0), HeapAlloc::<HuffmanCode>::new(HuffmanCode::default()));
        Self { state, input: Pending::default(), ended: false }
    }
}

impl Brotli {
    fn step(&mut self) -> io::Result<Vec<u8>> {
        if self.ended {
            return Ok(Vec::new());
        }
        let mut out = vec![0u8; STEP];
        let input = self.input.left();
        let (mut available_in, mut input_offset) = (input.len(), 0usize);
        let (mut available_out, mut output_offset, mut total_out) = (STEP, 0usize, 0usize);
        let result = BrotliDecompressStream(
            &mut available_in,
            &mut input_offset,
            input,
            &mut available_out,
            &mut output_offset,
            &mut out,
            &mut total_out,
            &mut self.state,
        );
        self.input.consume(input_offset);
        match result {
            BrotliResult::ResultFailure => return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid brotli stream")),
            BrotliResult::ResultSuccess => self.ended = true,
            BrotliResult::NeedsMoreInput | BrotliResult::NeedsMoreOutput => {}
        }
        out.truncate(output_offset);
        Ok(out)
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

    /// Feeds `reads` as the socket's reads, taking every step after each; the steps, in order.
    fn steps(encoding: &str, reads: &[&[u8]]) -> io::Result<Vec<Vec<u8>>> {
        let mut decoder = Decoder::of(Some(encoding)).unwrap();
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

    #[test]
    fn a_truncated_stream_is_an_error_at_the_end_of_the_body() {
        let whole = gzip(&b"truncated body ".repeat(200));
        assert!(decode("gzip", &whole[..whole.len() - 6]).is_err(), "gzip cut short");
        let whole = zlib(&b"truncated body ".repeat(200));
        assert!(decode("deflate", &whole[..whole.len() - 3]).is_err(), "zlib cut short");
        let whole = br(&b"truncated body ".repeat(200));
        assert!(decode("br", &whole[..whole.len() - 3]).is_err(), "brotli cut short");
    }

    // A single small read that inflates far past 16 MiB (the size of a body's compressed tail on one socket read) is
    // delivered whole, as undici delivers it, in steps the decoder never holds more than one of.
    #[test]
    fn a_small_read_that_inflates_past_16_mib_is_delivered_whole_in_steps() {
        let body = vec![b'a'; 20 << 20];
        for (encoding, wire) in [("gzip", gzip(&body)), ("deflate", zlib(&body)), ("deflate", raw(&body)), ("br", br(&body))] {
            assert!(wire.len() < 64 << 10, "{encoding}: one read's worth ({} bytes)", wire.len());
            let steps = steps(encoding, &[&wire]).unwrap_or_else(|e| panic!("{encoding}: {e}"));
            assert!(steps.iter().all(|s| !s.is_empty() && s.len() <= STEP), "{encoding}: every step within {STEP} bytes");
            assert_eq!(steps.concat(), body, "{encoding}: the whole body");
        }
    }
}
