//! `content-encoding` as `fetch` decodes it (`gzip`, `deflate` (zlib, else raw by the first byte), `br`), as a stream:
//! the output of one read is bounded while it is inflated, and the stream is finalized at the end of the body, so a
//! truncated or corrupt one is an error, never a short success.

use std::io;
use std::io::Write;

/// The most one read of the body may inflate to. A body is fed in the reads of the socket (16 KiB), so this is a
/// bound on the expansion of one read; a larger one is a bomb.
pub const MAX_PER_READ: usize = 16 << 20;

/// A sink that refuses to grow past its limit, so the decoder stops while it inflates and not after.
pub struct Capped {
    out: Vec<u8>,
    limit: usize,
}

impl Capped {
    fn new(limit: usize) -> Self {
        Self { out: Vec::new(), limit }
    }
}

impl Write for Capped {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.out.len() + buf.len() > self.limit {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the decoded body exceeds its bound"));
        }
        self.out.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A decoder and whether it was fed: a body of no bytes is not a truncated stream.
pub struct Decoder {
    kind: Kind,
    fed: bool,
    limit: usize,
}

enum Kind {
    Gzip(flate2::write::GzDecoder<Capped>),
    Zlib(Inflate),
    Raw(Inflate),
    Brotli(Box<brotli::DecompressorWriter<Capped>>),
    /// `deflate`, not yet told apart.
    Deflate,
}

impl Decoder {
    pub fn of(encoding: Option<&str>) -> Option<Self> {
        Self::with_limit(encoding, MAX_PER_READ)
    }

    fn with_limit(encoding: Option<&str>, limit: usize) -> Option<Self> {
        let kind = match encoding?.trim().to_ascii_lowercase().as_str() {
            "gzip" | "x-gzip" => Kind::Gzip(flate2::write::GzDecoder::new(Capped::new(limit))),
            "deflate" => Kind::Deflate,
            "br" => Kind::Brotli(Box::new(brotli::DecompressorWriter::new(Capped::new(limit), 4096))),
            _ => return None,
        };
        Some(Self { kind, fed: false, limit })
    }

    pub fn feed(&mut self, bytes: &[u8]) -> io::Result<Vec<u8>> {
        if bytes.is_empty() {
            return Ok(Vec::new());
        }
        self.fed = true;
        if matches!(self.kind, Kind::Deflate) {
            // The first byte tells zlib (CM = 8) from a raw stream (`fetch` does the same).
            self.kind = if bytes[0] & 0x0f == 8 {
                Kind::Zlib(Inflate::new(true, self.limit))
            } else {
                Kind::Raw(Inflate::new(false, self.limit))
            };
        }
        match &mut self.kind {
            Kind::Gzip(d) => push(d, bytes),
            Kind::Zlib(d) | Kind::Raw(d) => d.feed(bytes),
            Kind::Brotli(d) => push(&mut **d, bytes),
            Kind::Deflate => Ok(Vec::new()),
        }
    }

    /// The body is over: what the decoder still holds, or the error of a stream that did not end.
    pub fn finish(self) -> io::Result<Vec<u8>> {
        if !self.fed {
            return Ok(Vec::new());
        }
        match self.kind {
            Kind::Gzip(d) => Ok(d.finish()?.out),
            Kind::Zlib(d) | Kind::Raw(d) => d.finish(),
            Kind::Brotli(mut d) => {
                d.close()?;
                Ok(std::mem::take(&mut d.get_mut().out))
            }
            Kind::Deflate => Ok(Vec::new()),
        }
    }
}
/// A zlib or raw deflate stream, driven directly so that its end is known: `flate2`''s write decoders cannot say
/// whether the stream ended.
pub struct Inflate {
    inner: flate2::Decompress,
    limit: usize,
    ended: bool,
}

impl Inflate {
    fn new(zlib: bool, limit: usize) -> Self {
        Self { inner: flate2::Decompress::new(zlib), limit, ended: false }
    }

    fn feed(&mut self, bytes: &[u8]) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        let mut input = bytes;
        while !input.is_empty() && !self.ended {
            let (before_in, before_out) = (self.inner.total_in(), out.len());
            out.reserve(16 << 10);
            let status = self
                .inner
                .decompress_vec(input, &mut out, flate2::FlushDecompress::None)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            input = &input[(self.inner.total_in() - before_in) as usize..];
            self.ended = status == flate2::Status::StreamEnd;
            if out.len() > self.limit {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "the decoded body exceeds its bound"));
            }
            if self.inner.total_in() == before_in && out.len() == before_out && !self.ended {
                break;
            }
        }
        Ok(out)
    }

    fn finish(self) -> io::Result<Vec<u8>> {
        if self.ended {
            Ok(Vec::new())
        } else {
            Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the compressed body ends before its stream does"))
        }
    }
}

/// Writes `bytes` into `decoder` and takes what came out.
fn push<D: Write + SinkOf>(decoder: &mut D, bytes: &[u8]) -> io::Result<Vec<u8>> {
    decoder.write_all(bytes)?;
    decoder.flush()?;
    Ok(std::mem::take(&mut decoder.sink().out))
}

/// The output buffer behind a decoder.
trait SinkOf {
    fn sink(&mut self) -> &mut Capped;
}

macro_rules! sink_of {
    ($($decoder:ty),*) => {$(
        impl SinkOf for $decoder {
            fn sink(&mut self) -> &mut Capped {
                self.get_mut()
            }
        }
    )*};
}

sink_of!(
    flate2::write::GzDecoder<Capped>,
    brotli::DecompressorWriter<Capped>
);

#[cfg(test)]
mod tests {
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

    fn decode(encoding: &str, wire: &[u8]) -> io::Result<Vec<u8>> {
        let mut decoder = Decoder::of(Some(encoding)).unwrap();
        let mut out = decoder.feed(wire)?;
        out.extend(decoder.finish()?);
        Ok(out)
    }

    #[test]
    fn a_whole_stream_decodes_and_finishes() {
        assert_eq!(decode("gzip", &gzip(b"hello")).unwrap(), b"hello");
        assert_eq!(decode("deflate", &zlib(b"hello")).unwrap(), b"hello");
    }

    #[test]
    fn a_truncated_stream_is_an_error_at_the_end_of_the_body() {
        let whole = gzip(&b"truncated body ".repeat(200));
        assert!(decode("gzip", &whole[..whole.len() - 6]).is_err(), "gzip cut short");
        let whole = zlib(&b"truncated body ".repeat(200));
        assert!(decode("deflate", &whole[..whole.len() - 3]).is_err(), "zlib cut short");
    }

    #[test]
    fn inflating_stops_at_the_bound_not_after_it() {
        let bomb = gzip(&vec![0u8; 1 << 20]);
        let mut decoder = Decoder::with_limit(Some("gzip"), 64 << 10).unwrap();
        assert!(decoder.feed(&bomb).is_err());
    }
}
