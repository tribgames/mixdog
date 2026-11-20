//! Helpers of the reading tests: documents assembled byte by byte, with a correct cross-reference table.

use mixdog_pdf::document::{Document, OpenOptions};

/// A file of the numbered objects (`(number, body)`), the catalog being object 1; `trailer` is added to the trailer.
pub fn build_with_trailer(objects: &[(u32, Vec<u8>)], trailer: &str) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (number, body) in objects {
        offsets.push((*number, pdf.len()));
        pdf.extend_from_slice(format!("{number} 0 obj\n").as_bytes());
        pdf.extend_from_slice(body);
        pdf.extend_from_slice(b"\nendobj\n");
    }
    let start = pdf.len();
    let size = objects.iter().map(|(n, _)| *n).max().unwrap_or(0) + 1;
    pdf.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
    for number in 1..size {
        match offsets.iter().find(|(n, _)| *n == number) {
            Some((_, at)) => pdf.extend_from_slice(format!("{at:010} 00000 n \n").as_bytes()),
            None => pdf.extend_from_slice(b"0000000000 65535 f \n"),
        }
    }
    pdf.extend_from_slice(format!("trailer\n<< /Size {size} /Root 1 0 R {trailer} >>\nstartxref\n{start}\n%%EOF\n").as_bytes());
    pdf
}

pub fn build(objects: &[(u32, Vec<u8>)]) -> Vec<u8> {
    build_with_trailer(objects, "")
}

/// A stream object body: `dict` entries, the length, the bytes.
pub fn stream(dict: &str, content: &[u8]) -> Vec<u8> {
    let mut body = format!("<< {dict} /Length {} >>\nstream\n", content.len()).into_bytes();
    body.extend_from_slice(content);
    body.extend_from_slice(b"\nendstream");
    body
}

pub const HELVETICA: &str = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/// A one-page 200 x 200 document: Helvetica as object 5 (`/F1`), `content` as the page's stream (object 4), `extra`
/// objects from 6 on; `resources` is the page's `/Resources` value.
pub fn one_page(content: &str, resources: &str, extra: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut objects: Vec<(u32, Vec<u8>)> = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources {resources} >>").into_bytes()),
        (4, stream("", content.as_bytes())),
        (5, HELVETICA.as_bytes().to_vec()),
    ];
    objects.extend(extra.iter().cloned());
    build(&objects)
}

pub const FONT_RESOURCES: &str = "<< /Font << /F1 5 0 R >> >>";

/// A document with one page per entry of `contents`, each page with Helvetica as `/F1`.
pub fn pages_of(contents: &[&str]) -> Vec<u8> {
    let kids: String = (0..contents.len()).map(|i| format!("{} 0 R ", 10 + 2 * i)).collect();
    let mut objects: Vec<(u32, Vec<u8>)> = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", contents.len()).into_bytes()),
        (5, HELVETICA.as_bytes().to_vec()),
    ];
    for (i, content) in contents.iter().enumerate() {
        let page = 10 + 2 * i as u32;
        objects.push((
            page,
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents {} 0 R /Resources {FONT_RESOURCES} >>", page + 1).into_bytes(),
        ));
        objects.push((page + 1, stream("", content.as_bytes())));
    }
    build(&objects)
}

pub fn open(bytes: Vec<u8>) -> Document {
    Document::open(bytes, &OpenOptions::default()).expect("the document opens")
}

/// The bytes of a string of `0` and `1` (white space ignored), the last byte padded with zero bits.
pub fn pack_bits(bits: &str) -> Vec<u8> {
    let digits: Vec<u8> = bits.bytes().filter(|b| *b == b'0' || *b == b'1').map(|b| b - b'0').collect();
    digits.chunks(8).map(|chunk| (0..8).fold(0u8, |acc, i| (acc << 1) | chunk.get(i).copied().unwrap_or(0))).collect()
}

/// The MQ arithmetic encoder of ITU-T T.88 Annex E / T.800 Annex C (the same coder serves JBIG2 and JPEG 2000),
/// written from the flow charts of the standards. Contexts start in state 0 with MPS 0 unless `preset`.
pub struct MqEncoder {
    a: u32,
    c: u32,
    ct: u32,
    /// The byte before the first output byte is the one the standard's `BP` points at first.
    out: Vec<u8>,
    states: Vec<(usize, u8)>,
}

/// Table E.1 / C.2: `Qe`, next state after an MPS, after an LPS, and whether an LPS switches the MPS.
const QE: [(u32, usize, usize, bool); 47] = [
    (0x5601, 1, 1, true),
    (0x3401, 2, 6, false),
    (0x1801, 3, 9, false),
    (0x0AC1, 4, 12, false),
    (0x0521, 5, 29, false),
    (0x0221, 38, 33, false),
    (0x5601, 7, 6, true),
    (0x5401, 8, 14, false),
    (0x4801, 9, 14, false),
    (0x3801, 10, 14, false),
    (0x3001, 11, 17, false),
    (0x2401, 12, 18, false),
    (0x1C01, 13, 20, false),
    (0x1601, 29, 21, false),
    (0x5601, 15, 14, true),
    (0x5401, 16, 14, false),
    (0x5101, 17, 15, false),
    (0x4801, 18, 16, false),
    (0x3801, 19, 17, false),
    (0x3401, 20, 18, false),
    (0x3001, 21, 19, false),
    (0x2801, 22, 19, false),
    (0x2401, 23, 20, false),
    (0x2201, 24, 21, false),
    (0x1C01, 25, 22, false),
    (0x1801, 26, 23, false),
    (0x1601, 27, 24, false),
    (0x1401, 28, 25, false),
    (0x1201, 29, 26, false),
    (0x1101, 30, 27, false),
    (0x0AC1, 31, 28, false),
    (0x09C1, 32, 29, false),
    (0x08A1, 33, 30, false),
    (0x0521, 34, 31, false),
    (0x0441, 35, 32, false),
    (0x02A1, 36, 33, false),
    (0x0221, 37, 34, false),
    (0x0141, 38, 35, false),
    (0x0111, 39, 36, false),
    (0x0085, 40, 37, false),
    (0x0049, 41, 38, false),
    (0x0025, 42, 39, false),
    (0x0015, 43, 40, false),
    (0x0009, 44, 41, false),
    (0x0005, 45, 42, false),
    (0x0001, 45, 43, false),
    (0x5601, 46, 46, false),
];

impl MqEncoder {
    /// `contexts` coding contexts; `preset` lists `(context, state index)` for the ones that do not start in state 0.
    pub fn new(contexts: usize, preset: &[(usize, usize)]) -> Self {
        let mut states = vec![(0usize, 0u8); contexts];
        for &(cx, index) in preset {
            states[cx].0 = index;
        }
        MqEncoder { a: 0x8000, c: 0, ct: 12, out: vec![0], states }
    }

    pub fn encode(&mut self, cx: usize, bit: u8) {
        let (index, mps) = self.states[cx];
        let (qe, nmps, nlps, switch) = QE[index];
        self.a -= qe;
        if bit == mps {
            if self.a & 0x8000 == 0 {
                if self.a < qe {
                    self.a = qe;
                } else {
                    self.c += qe;
                }
                self.states[cx].0 = nmps;
                self.renormalise();
            } else {
                self.c += qe;
            }
        } else {
            if self.a < qe {
                self.c += qe;
            } else {
                self.a = qe;
            }
            if switch {
                self.states[cx].1 = 1 - mps;
            }
            self.states[cx].0 = nlps;
            self.renormalise();
        }
    }

    fn renormalise(&mut self) {
        loop {
            self.a <<= 1;
            self.c <<= 1;
            self.ct -= 1;
            if self.ct == 0 {
                self.byte_out();
            }
            if self.a & 0x8000 != 0 {
                break;
            }
        }
    }

    fn byte_out(&mut self) {
        let last = self.out.len() - 1;
        if self.out[last] == 0xFF {
            self.out.push((self.c >> 20) as u8);
            self.c &= 0xF_FFFF;
            self.ct = 7;
        } else if self.c < 0x800_0000 {
            self.out.push((self.c >> 19) as u8);
            self.c &= 0x7_FFFF;
            self.ct = 8;
        } else {
            self.out[last] += 1;
            if self.out[last] == 0xFF {
                self.c &= 0x7FF_FFFF;
                self.out.push((self.c >> 20) as u8);
                self.c &= 0xF_FFFF;
                self.ct = 7;
            } else {
                self.out.push((self.c >> 19) as u8);
                self.c &= 0x7_FFFF;
                self.ct = 8;
            }
        }
    }

    /// The state (index, more probable symbol) of every context.
    pub fn states(&self) -> &[(usize, u8)] {
        &self.states
    }

    /// Sets the contexts from `start` on to `states` (what a later coder continues with).
    pub fn load_states(&mut self, start: usize, states: &[(usize, u8)]) {
        self.states[start..start + states.len()].copy_from_slice(states);
    }

    /// Ends the codeword (`FLUSH`, no marker) and starts a new one over the same context states.
    pub fn terminate(&mut self) -> Vec<u8> {
        let states = self.states.clone();
        let done = std::mem::replace(self, MqEncoder { a: 0x8000, c: 0, ct: 12, out: vec![0], states });
        done.finish(false)
    }

    /// Ends the codeword the JBIG2 way (with the marker 0xFF 0xAC) and starts a new one over the same context states.
    pub fn terminate_jbig2(&mut self) -> Vec<u8> {
        let states = self.states.clone();
        let done = std::mem::replace(self, MqEncoder { a: 0x8000, c: 0, ct: 12, out: vec![0], states });
        done.finish(true)
    }

    /// Puts every context back in state 0 (or the `preset` state), as a code-block style that resets them asks.
    pub fn reset_states(&mut self, preset: &[(usize, usize)]) {
        self.states.iter_mut().for_each(|state| *state = (0, 0));
        for &(cx, index) in preset {
            self.states[cx].0 = index;
        }
    }

    /// The `FLUSH` procedure; the JBIG2 form ends with the marker 0xFF 0xAC.
    pub fn finish(mut self, jbig2_marker: bool) -> Vec<u8> {
        let temp = self.c + self.a;
        self.c |= 0xFFFF;
        if self.c >= temp {
            self.c -= 0x8000;
        }
        self.c <<= self.ct;
        self.byte_out();
        self.c <<= self.ct;
        self.byte_out();
        if self.out.last() == Some(&0xFF) {
            self.out.pop();
        }
        if jbig2_marker {
            self.out.extend([0xFF, 0xAC]);
        }
        self.out.remove(0);
        self.out
    }
}
