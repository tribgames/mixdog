//! Project text codec (port of `decodeProjectText` / `encodeProjectText`).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

impl Encoding {
    pub fn name(self) -> &'static str {
        match self {
            Self::Utf8 => "utf8",
            Self::Utf8Bom => "utf8bom",
            Self::Utf16Le => "utf16le",
            Self::Utf16Be => "utf16be",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decoded {
    pub content: String,
    pub encoding: Encoding,
    pub binary: bool,
    pub has_bom: bool,
    /// False when decoding replaced bytes: view-only, never evidence for a write.
    pub lossless: bool,
}

fn utf16(bytes: &[u8], be: bool) -> (String, bool) {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|p| if be { u16::from_be_bytes([p[0], p[1]]) } else { u16::from_le_bytes([p[0], p[1]]) })
        .collect();
    let text: String = char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or('\u{fffd}'))
        .collect();
    let lossless = bytes.len() % 2 == 0 && String::from_utf16(&units).is_ok();
    (text, lossless)
}

fn payload(bytes: &[u8], encoding: Encoding, has_bom: bool, binary: bool) -> Decoded {
    let (content, lossless) = match encoding {
        Encoding::Utf16Le => utf16(bytes, false),
        Encoding::Utf16Be => utf16(bytes, true),
        _ => (String::from_utf8_lossy(bytes).into_owned(), std::str::from_utf8(bytes).is_ok()),
    };
    Decoded { content, encoding, binary, has_bom, lossless }
}

pub fn decode(bytes: &[u8]) -> Decoded {
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return payload(rest, Encoding::Utf8Bom, true, false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return payload(rest, Encoding::Utf16Le, true, false);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return payload(rest, Encoding::Utf16Be, true, false);
    }
    let sample = &bytes[..(bytes.len() - bytes.len() % 2).min(8192)];
    let (mut even, mut odd) = (0usize, 0usize);
    for p in sample.chunks_exact(2) {
        even += usize::from(p[0] == 0);
        odd += usize::from(p[1] == 0);
    }
    let pairs = (sample.len() / 2) as f64;
    let (even, odd) = (even as f64, odd as f64);
    if pairs >= 4.0 && odd / pairs > 0.6 && even / pairs < 0.1 {
        return payload(bytes, Encoding::Utf16Le, false, false);
    }
    if pairs >= 4.0 && even / pairs > 0.6 && odd / pairs < 0.1 {
        return payload(bytes, Encoding::Utf16Be, false, false);
    }
    payload(bytes, Encoding::Utf8, false, bytes[..bytes.len().min(8192)].contains(&0))
}

pub fn encode(content: &str, encoding: Encoding, has_bom: bool) -> Vec<u8> {
    match encoding {
        Encoding::Utf8 => content.as_bytes().to_vec(),
        Encoding::Utf8Bom => [&[0xef, 0xbb, 0xbf][..], content.as_bytes()].concat(),
        Encoding::Utf16Le | Encoding::Utf16Be => {
            let be = encoding == Encoding::Utf16Be;
            let mut out = Vec::new();
            if has_bom {
                out.extend(if be { [0xfe, 0xff] } else { [0xff, 0xfe] });
            }
            for u in content.encode_utf16() {
                out.extend(if be { u.to_be_bytes() } else { u.to_le_bytes() });
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixtures_round_trip() {
        let d = decode("héllo\n".as_bytes());
        assert_eq!((d.encoding, d.binary, d.lossless), (Encoding::Utf8, false, true));
        let d = decode(&[0xef, 0xbb, 0xbf, b'b', b'\n']);
        assert_eq!((d.content.as_str(), d.encoding), ("b\n", Encoding::Utf8Bom));
        let bytes = encode("hi\n", Encoding::Utf16Le, true);
        let d = decode(&bytes);
        assert_eq!((d.content.as_str(), d.encoding, d.has_bom), ("hi\n", Encoding::Utf16Le, true));
        assert_eq!(encode(&d.content, d.encoding, d.has_bom), bytes);
        assert!(decode(&[0, 1, 2]).binary);
        assert!(!decode(&[0xff, 0xff, b'a']).lossless);
    }
}
