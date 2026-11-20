//! The predefined CMaps of pdfjs-dist 6.4.299 (`cmaps/`, packed `.bcmap`, Adobe BSD-3-Clause, credited in the NOTICE
//! of the crate) and `BinaryCMapReader`, which reads them. The reference configuration passes `cMapUrl` with
//! `cMapPacked`, so pdf.js loads exactly these files; here they are embedded and found by name.

use super::{CMap, CMapValue};
use crate::error::{PdfError, Result};

/// `BUILT_IN_CMAPS` with the bytes of each file, in pdf.js's order. `Identity-H` and `Identity-V` are not here: the
/// factory builds them.
pub const BUILT_IN_CMAPS: &[(&str, &[u8])] = &[
    ("Adobe-GB1-UCS2", include_bytes!("cmaps/Adobe-GB1-UCS2.bcmap")),
    ("Adobe-CNS1-UCS2", include_bytes!("cmaps/Adobe-CNS1-UCS2.bcmap")),
    ("Adobe-Japan1-UCS2", include_bytes!("cmaps/Adobe-Japan1-UCS2.bcmap")),
    ("Adobe-Korea1-UCS2", include_bytes!("cmaps/Adobe-Korea1-UCS2.bcmap")),
    ("78-EUC-H", include_bytes!("cmaps/78-EUC-H.bcmap")),
    ("78-EUC-V", include_bytes!("cmaps/78-EUC-V.bcmap")),
    ("78-H", include_bytes!("cmaps/78-H.bcmap")),
    ("78-RKSJ-H", include_bytes!("cmaps/78-RKSJ-H.bcmap")),
    ("78-RKSJ-V", include_bytes!("cmaps/78-RKSJ-V.bcmap")),
    ("78-V", include_bytes!("cmaps/78-V.bcmap")),
    ("78ms-RKSJ-H", include_bytes!("cmaps/78ms-RKSJ-H.bcmap")),
    ("78ms-RKSJ-V", include_bytes!("cmaps/78ms-RKSJ-V.bcmap")),
    ("83pv-RKSJ-H", include_bytes!("cmaps/83pv-RKSJ-H.bcmap")),
    ("90ms-RKSJ-H", include_bytes!("cmaps/90ms-RKSJ-H.bcmap")),
    ("90ms-RKSJ-V", include_bytes!("cmaps/90ms-RKSJ-V.bcmap")),
    ("90msp-RKSJ-H", include_bytes!("cmaps/90msp-RKSJ-H.bcmap")),
    ("90msp-RKSJ-V", include_bytes!("cmaps/90msp-RKSJ-V.bcmap")),
    ("90pv-RKSJ-H", include_bytes!("cmaps/90pv-RKSJ-H.bcmap")),
    ("90pv-RKSJ-V", include_bytes!("cmaps/90pv-RKSJ-V.bcmap")),
    ("Add-H", include_bytes!("cmaps/Add-H.bcmap")),
    ("Add-RKSJ-H", include_bytes!("cmaps/Add-RKSJ-H.bcmap")),
    ("Add-RKSJ-V", include_bytes!("cmaps/Add-RKSJ-V.bcmap")),
    ("Add-V", include_bytes!("cmaps/Add-V.bcmap")),
    ("Adobe-CNS1-0", include_bytes!("cmaps/Adobe-CNS1-0.bcmap")),
    ("Adobe-CNS1-1", include_bytes!("cmaps/Adobe-CNS1-1.bcmap")),
    ("Adobe-CNS1-2", include_bytes!("cmaps/Adobe-CNS1-2.bcmap")),
    ("Adobe-CNS1-3", include_bytes!("cmaps/Adobe-CNS1-3.bcmap")),
    ("Adobe-CNS1-4", include_bytes!("cmaps/Adobe-CNS1-4.bcmap")),
    ("Adobe-CNS1-5", include_bytes!("cmaps/Adobe-CNS1-5.bcmap")),
    ("Adobe-CNS1-6", include_bytes!("cmaps/Adobe-CNS1-6.bcmap")),
    ("Adobe-GB1-0", include_bytes!("cmaps/Adobe-GB1-0.bcmap")),
    ("Adobe-GB1-1", include_bytes!("cmaps/Adobe-GB1-1.bcmap")),
    ("Adobe-GB1-2", include_bytes!("cmaps/Adobe-GB1-2.bcmap")),
    ("Adobe-GB1-3", include_bytes!("cmaps/Adobe-GB1-3.bcmap")),
    ("Adobe-GB1-4", include_bytes!("cmaps/Adobe-GB1-4.bcmap")),
    ("Adobe-GB1-5", include_bytes!("cmaps/Adobe-GB1-5.bcmap")),
    ("Adobe-Japan1-0", include_bytes!("cmaps/Adobe-Japan1-0.bcmap")),
    ("Adobe-Japan1-1", include_bytes!("cmaps/Adobe-Japan1-1.bcmap")),
    ("Adobe-Japan1-2", include_bytes!("cmaps/Adobe-Japan1-2.bcmap")),
    ("Adobe-Japan1-3", include_bytes!("cmaps/Adobe-Japan1-3.bcmap")),
    ("Adobe-Japan1-4", include_bytes!("cmaps/Adobe-Japan1-4.bcmap")),
    ("Adobe-Japan1-5", include_bytes!("cmaps/Adobe-Japan1-5.bcmap")),
    ("Adobe-Japan1-6", include_bytes!("cmaps/Adobe-Japan1-6.bcmap")),
    ("Adobe-Korea1-0", include_bytes!("cmaps/Adobe-Korea1-0.bcmap")),
    ("Adobe-Korea1-1", include_bytes!("cmaps/Adobe-Korea1-1.bcmap")),
    ("Adobe-Korea1-2", include_bytes!("cmaps/Adobe-Korea1-2.bcmap")),
    ("B5-H", include_bytes!("cmaps/B5-H.bcmap")),
    ("B5-V", include_bytes!("cmaps/B5-V.bcmap")),
    ("B5pc-H", include_bytes!("cmaps/B5pc-H.bcmap")),
    ("B5pc-V", include_bytes!("cmaps/B5pc-V.bcmap")),
    ("CNS-EUC-H", include_bytes!("cmaps/CNS-EUC-H.bcmap")),
    ("CNS-EUC-V", include_bytes!("cmaps/CNS-EUC-V.bcmap")),
    ("CNS1-H", include_bytes!("cmaps/CNS1-H.bcmap")),
    ("CNS1-V", include_bytes!("cmaps/CNS1-V.bcmap")),
    ("CNS2-H", include_bytes!("cmaps/CNS2-H.bcmap")),
    ("CNS2-V", include_bytes!("cmaps/CNS2-V.bcmap")),
    ("ETHK-B5-H", include_bytes!("cmaps/ETHK-B5-H.bcmap")),
    ("ETHK-B5-V", include_bytes!("cmaps/ETHK-B5-V.bcmap")),
    ("ETen-B5-H", include_bytes!("cmaps/ETen-B5-H.bcmap")),
    ("ETen-B5-V", include_bytes!("cmaps/ETen-B5-V.bcmap")),
    ("ETenms-B5-H", include_bytes!("cmaps/ETenms-B5-H.bcmap")),
    ("ETenms-B5-V", include_bytes!("cmaps/ETenms-B5-V.bcmap")),
    ("EUC-H", include_bytes!("cmaps/EUC-H.bcmap")),
    ("EUC-V", include_bytes!("cmaps/EUC-V.bcmap")),
    ("Ext-H", include_bytes!("cmaps/Ext-H.bcmap")),
    ("Ext-RKSJ-H", include_bytes!("cmaps/Ext-RKSJ-H.bcmap")),
    ("Ext-RKSJ-V", include_bytes!("cmaps/Ext-RKSJ-V.bcmap")),
    ("Ext-V", include_bytes!("cmaps/Ext-V.bcmap")),
    ("GB-EUC-H", include_bytes!("cmaps/GB-EUC-H.bcmap")),
    ("GB-EUC-V", include_bytes!("cmaps/GB-EUC-V.bcmap")),
    ("GB-H", include_bytes!("cmaps/GB-H.bcmap")),
    ("GB-V", include_bytes!("cmaps/GB-V.bcmap")),
    ("GBK-EUC-H", include_bytes!("cmaps/GBK-EUC-H.bcmap")),
    ("GBK-EUC-V", include_bytes!("cmaps/GBK-EUC-V.bcmap")),
    ("GBK2K-H", include_bytes!("cmaps/GBK2K-H.bcmap")),
    ("GBK2K-V", include_bytes!("cmaps/GBK2K-V.bcmap")),
    ("GBKp-EUC-H", include_bytes!("cmaps/GBKp-EUC-H.bcmap")),
    ("GBKp-EUC-V", include_bytes!("cmaps/GBKp-EUC-V.bcmap")),
    ("GBT-EUC-H", include_bytes!("cmaps/GBT-EUC-H.bcmap")),
    ("GBT-EUC-V", include_bytes!("cmaps/GBT-EUC-V.bcmap")),
    ("GBT-H", include_bytes!("cmaps/GBT-H.bcmap")),
    ("GBT-V", include_bytes!("cmaps/GBT-V.bcmap")),
    ("GBTpc-EUC-H", include_bytes!("cmaps/GBTpc-EUC-H.bcmap")),
    ("GBTpc-EUC-V", include_bytes!("cmaps/GBTpc-EUC-V.bcmap")),
    ("GBpc-EUC-H", include_bytes!("cmaps/GBpc-EUC-H.bcmap")),
    ("GBpc-EUC-V", include_bytes!("cmaps/GBpc-EUC-V.bcmap")),
    ("H", include_bytes!("cmaps/H.bcmap")),
    ("HKdla-B5-H", include_bytes!("cmaps/HKdla-B5-H.bcmap")),
    ("HKdla-B5-V", include_bytes!("cmaps/HKdla-B5-V.bcmap")),
    ("HKdlb-B5-H", include_bytes!("cmaps/HKdlb-B5-H.bcmap")),
    ("HKdlb-B5-V", include_bytes!("cmaps/HKdlb-B5-V.bcmap")),
    ("HKgccs-B5-H", include_bytes!("cmaps/HKgccs-B5-H.bcmap")),
    ("HKgccs-B5-V", include_bytes!("cmaps/HKgccs-B5-V.bcmap")),
    ("HKm314-B5-H", include_bytes!("cmaps/HKm314-B5-H.bcmap")),
    ("HKm314-B5-V", include_bytes!("cmaps/HKm314-B5-V.bcmap")),
    ("HKm471-B5-H", include_bytes!("cmaps/HKm471-B5-H.bcmap")),
    ("HKm471-B5-V", include_bytes!("cmaps/HKm471-B5-V.bcmap")),
    ("HKscs-B5-H", include_bytes!("cmaps/HKscs-B5-H.bcmap")),
    ("HKscs-B5-V", include_bytes!("cmaps/HKscs-B5-V.bcmap")),
    ("Hankaku", include_bytes!("cmaps/Hankaku.bcmap")),
    ("Hiragana", include_bytes!("cmaps/Hiragana.bcmap")),
    ("KSC-EUC-H", include_bytes!("cmaps/KSC-EUC-H.bcmap")),
    ("KSC-EUC-V", include_bytes!("cmaps/KSC-EUC-V.bcmap")),
    ("KSC-H", include_bytes!("cmaps/KSC-H.bcmap")),
    ("KSC-Johab-H", include_bytes!("cmaps/KSC-Johab-H.bcmap")),
    ("KSC-Johab-V", include_bytes!("cmaps/KSC-Johab-V.bcmap")),
    ("KSC-V", include_bytes!("cmaps/KSC-V.bcmap")),
    ("KSCms-UHC-H", include_bytes!("cmaps/KSCms-UHC-H.bcmap")),
    ("KSCms-UHC-HW-H", include_bytes!("cmaps/KSCms-UHC-HW-H.bcmap")),
    ("KSCms-UHC-HW-V", include_bytes!("cmaps/KSCms-UHC-HW-V.bcmap")),
    ("KSCms-UHC-V", include_bytes!("cmaps/KSCms-UHC-V.bcmap")),
    ("KSCpc-EUC-H", include_bytes!("cmaps/KSCpc-EUC-H.bcmap")),
    ("KSCpc-EUC-V", include_bytes!("cmaps/KSCpc-EUC-V.bcmap")),
    ("Katakana", include_bytes!("cmaps/Katakana.bcmap")),
    ("NWP-H", include_bytes!("cmaps/NWP-H.bcmap")),
    ("NWP-V", include_bytes!("cmaps/NWP-V.bcmap")),
    ("RKSJ-H", include_bytes!("cmaps/RKSJ-H.bcmap")),
    ("RKSJ-V", include_bytes!("cmaps/RKSJ-V.bcmap")),
    ("Roman", include_bytes!("cmaps/Roman.bcmap")),
    ("UniCNS-UCS2-H", include_bytes!("cmaps/UniCNS-UCS2-H.bcmap")),
    ("UniCNS-UCS2-V", include_bytes!("cmaps/UniCNS-UCS2-V.bcmap")),
    ("UniCNS-UTF16-H", include_bytes!("cmaps/UniCNS-UTF16-H.bcmap")),
    ("UniCNS-UTF16-V", include_bytes!("cmaps/UniCNS-UTF16-V.bcmap")),
    ("UniCNS-UTF32-H", include_bytes!("cmaps/UniCNS-UTF32-H.bcmap")),
    ("UniCNS-UTF32-V", include_bytes!("cmaps/UniCNS-UTF32-V.bcmap")),
    ("UniCNS-UTF8-H", include_bytes!("cmaps/UniCNS-UTF8-H.bcmap")),
    ("UniCNS-UTF8-V", include_bytes!("cmaps/UniCNS-UTF8-V.bcmap")),
    ("UniGB-UCS2-H", include_bytes!("cmaps/UniGB-UCS2-H.bcmap")),
    ("UniGB-UCS2-V", include_bytes!("cmaps/UniGB-UCS2-V.bcmap")),
    ("UniGB-UTF16-H", include_bytes!("cmaps/UniGB-UTF16-H.bcmap")),
    ("UniGB-UTF16-V", include_bytes!("cmaps/UniGB-UTF16-V.bcmap")),
    ("UniGB-UTF32-H", include_bytes!("cmaps/UniGB-UTF32-H.bcmap")),
    ("UniGB-UTF32-V", include_bytes!("cmaps/UniGB-UTF32-V.bcmap")),
    ("UniGB-UTF8-H", include_bytes!("cmaps/UniGB-UTF8-H.bcmap")),
    ("UniGB-UTF8-V", include_bytes!("cmaps/UniGB-UTF8-V.bcmap")),
    ("UniJIS-UCS2-H", include_bytes!("cmaps/UniJIS-UCS2-H.bcmap")),
    ("UniJIS-UCS2-HW-H", include_bytes!("cmaps/UniJIS-UCS2-HW-H.bcmap")),
    ("UniJIS-UCS2-HW-V", include_bytes!("cmaps/UniJIS-UCS2-HW-V.bcmap")),
    ("UniJIS-UCS2-V", include_bytes!("cmaps/UniJIS-UCS2-V.bcmap")),
    ("UniJIS-UTF16-H", include_bytes!("cmaps/UniJIS-UTF16-H.bcmap")),
    ("UniJIS-UTF16-V", include_bytes!("cmaps/UniJIS-UTF16-V.bcmap")),
    ("UniJIS-UTF32-H", include_bytes!("cmaps/UniJIS-UTF32-H.bcmap")),
    ("UniJIS-UTF32-V", include_bytes!("cmaps/UniJIS-UTF32-V.bcmap")),
    ("UniJIS-UTF8-H", include_bytes!("cmaps/UniJIS-UTF8-H.bcmap")),
    ("UniJIS-UTF8-V", include_bytes!("cmaps/UniJIS-UTF8-V.bcmap")),
    ("UniJIS2004-UTF16-H", include_bytes!("cmaps/UniJIS2004-UTF16-H.bcmap")),
    ("UniJIS2004-UTF16-V", include_bytes!("cmaps/UniJIS2004-UTF16-V.bcmap")),
    ("UniJIS2004-UTF32-H", include_bytes!("cmaps/UniJIS2004-UTF32-H.bcmap")),
    ("UniJIS2004-UTF32-V", include_bytes!("cmaps/UniJIS2004-UTF32-V.bcmap")),
    ("UniJIS2004-UTF8-H", include_bytes!("cmaps/UniJIS2004-UTF8-H.bcmap")),
    ("UniJIS2004-UTF8-V", include_bytes!("cmaps/UniJIS2004-UTF8-V.bcmap")),
    ("UniJISPro-UCS2-HW-V", include_bytes!("cmaps/UniJISPro-UCS2-HW-V.bcmap")),
    ("UniJISPro-UCS2-V", include_bytes!("cmaps/UniJISPro-UCS2-V.bcmap")),
    ("UniJISPro-UTF8-V", include_bytes!("cmaps/UniJISPro-UTF8-V.bcmap")),
    ("UniJISX0213-UTF32-H", include_bytes!("cmaps/UniJISX0213-UTF32-H.bcmap")),
    ("UniJISX0213-UTF32-V", include_bytes!("cmaps/UniJISX0213-UTF32-V.bcmap")),
    ("UniJISX02132004-UTF32-H", include_bytes!("cmaps/UniJISX02132004-UTF32-H.bcmap")),
    ("UniJISX02132004-UTF32-V", include_bytes!("cmaps/UniJISX02132004-UTF32-V.bcmap")),
    ("UniKS-UCS2-H", include_bytes!("cmaps/UniKS-UCS2-H.bcmap")),
    ("UniKS-UCS2-V", include_bytes!("cmaps/UniKS-UCS2-V.bcmap")),
    ("UniKS-UTF16-H", include_bytes!("cmaps/UniKS-UTF16-H.bcmap")),
    ("UniKS-UTF16-V", include_bytes!("cmaps/UniKS-UTF16-V.bcmap")),
    ("UniKS-UTF32-H", include_bytes!("cmaps/UniKS-UTF32-H.bcmap")),
    ("UniKS-UTF32-V", include_bytes!("cmaps/UniKS-UTF32-V.bcmap")),
    ("UniKS-UTF8-H", include_bytes!("cmaps/UniKS-UTF8-H.bcmap")),
    ("UniKS-UTF8-V", include_bytes!("cmaps/UniKS-UTF8-V.bcmap")),
    ("V", include_bytes!("cmaps/V.bcmap")),
    ("WP-Symbol", include_bytes!("cmaps/WP-Symbol.bcmap")),
];

/// The packed bytes of the predefined CMap `name` (`fetchBuiltInCMap`).
pub fn built_in_cmap_data(name: &str) -> Option<&'static [u8]> {
    BUILT_IN_CMAPS.iter().find(|(candidate, _)| *candidate == name).map(|(_, data)| *data)
}

/// `MAX_NUM_SIZE`: the widest code (in bytes) a record carries.
const MAX_NUM_SIZE: usize = 16;
/// `MAX_ENCODED_NUM_SIZE`: the size of `BinaryCMapStream.tmpBuf`.
const MAX_ENCODED_NUM_SIZE: usize = 19;

type Num = [u8; MAX_NUM_SIZE];

fn unknown(message: &str) -> PdfError {
    PdfError::Unknown(message.to_owned())
}

/// `hexToInt`: the first `size + 1` bytes as a big-endian unsigned 32-bit number (bytes shifted out are lost, as
/// `n << 8 | a[i]` loses them).
fn hex_to_int(a: &Num, size: usize) -> u32 {
    let mut n: u32 = 0;
    for byte in &a[..=size] {
        n = (n << 8) | u32::from(*byte);
    }
    n
}

/// `hexToStr`: the first `size + 1` bytes, each one a char (code unit).
fn hex_to_str(a: &Num, size: usize) -> Vec<u16> {
    a[..=size].iter().map(|byte| u16::from(*byte)).collect()
}

/// `addHex`: `a += b` over `size + 1` bytes, big-endian.
fn add_hex(a: &mut Num, b: &Num, size: usize) {
    let mut c: u32 = 0;
    for i in (0..=size).rev() {
        c += u32::from(a[i]) + u32::from(b[i]);
        a[i] = (c & 255) as u8;
        c >>= 8;
    }
}

/// `incHex`: `a += 1` over `size + 1` bytes.
fn inc_hex(a: &mut Num, size: usize) {
    let mut c: u32 = 1;
    for i in (0..=size).rev() {
        if c == 0 {
            break;
        }
        c += u32::from(a[i]);
        a[i] = (c & 255) as u8;
        c >>= 8;
    }
}

/// `BinaryCMapStream`: a `Stream` over the file with the readers of the packed number forms.
struct BinaryCMapStream<'a> {
    data: &'a [u8],
    pos: usize,
}

impl BinaryCMapStream<'_> {
    fn get_byte(&mut self) -> Option<u8> {
        let byte = self.data.get(self.pos).copied();
        if byte.is_some() {
            self.pos += 1;
        }
        byte
    }

    fn eof() -> PdfError {
        PdfError::Format("unexpected EOF in bcmap".to_owned())
    }

    /// `readNumber`: seven bits per byte, the high bit set on all but the last; 32-bit wrapping as `n << 7 | b`.
    fn read_number(&mut self) -> Result<i32> {
        let mut n: i32 = 0;
        loop {
            let b = self.get_byte().ok_or_else(Self::eof)?;
            n = n.wrapping_shl(7) | i32::from(b & 0x7f);
            if b & 0x80 == 0 {
                return Ok(n);
            }
        }
    }

    /// `readSigned`: the low bit is the sign (set: `~(n >>> 1)`).
    fn read_signed(&mut self) -> Result<i64> {
        let n = self.read_number()?;
        let half = (n as u32) >> 1;
        Ok(if n & 1 != 0 { i64::from(!(half as i32)) } else { i64::from(half) })
    }

    /// `readHex(num, size)`: `num.set(getBytes(size + 1))`; a short read leaves the rest of `num` as it was.
    fn read_hex(&mut self, num: &mut Num, size: usize) {
        let end = (self.pos + size + 1).min(self.data.len());
        let bytes = &self.data[self.pos.min(end)..end];
        num[..bytes.len()].copy_from_slice(bytes);
        self.pos = end;
    }

    /// `readHexNumber`: a packed number spread over `size + 1` bytes, big-endian.
    fn read_hex_number(&mut self, num: &mut Num, size: usize) -> Result<()> {
        let mut stack = [0u8; MAX_ENCODED_NUM_SIZE];
        let mut count: usize = 0;
        loop {
            let b = self.get_byte().ok_or_else(Self::eof)?;
            // A write past the end of the typed array is dropped while the count goes on, as in pdf.js.
            if count < MAX_ENCODED_NUM_SIZE {
                stack[count] = b & 0x7f;
            }
            count += 1;
            if b & 0x80 == 0 {
                break;
            }
        }
        // `stack[--sp]` below index 0, or past the array, is `undefined`, which `<<` takes as 0.
        let mut sp = i64::try_from(count).unwrap_or(i64::MAX);
        let mut buffer: i32 = 0;
        let mut buffer_size: i32 = 0;
        for i in (0..=size).rev() {
            while buffer_size < 8 {
                sp -= 1;
                let value = usize::try_from(sp).ok().and_then(|index| stack.get(index)).copied().unwrap_or(0);
                buffer |= i32::from(value) << buffer_size;
                buffer_size += 7;
            }
            num[i] = (buffer & 255) as u8;
            buffer >>= 8;
            buffer_size -= 8;
        }
        Ok(())
    }

    /// `readHexSigned`.
    fn read_hex_signed(&mut self, num: &mut Num, size: usize) -> Result<()> {
        self.read_hex_number(num, size)?;
        let sign: u32 = if num[size] & 1 != 0 { 255 } else { 0 };
        let mut c: u32 = 0;
        for byte in &mut num[..=size] {
            c = ((c & 1) << 8) | u32::from(*byte);
            *byte = (((c >> 1) ^ sign) & 255) as u8;
        }
        Ok(())
    }

    /// `readString`: a length and then that many numbers, each one a char.
    fn read_string(&mut self) -> Result<String> {
        let len = self.read_number()?;
        let mut out = String::new();
        for _ in 0..len.max(0) {
            let code = self.read_number()?;
            out.push(char::from_u32((code as u32) & 0xffff).unwrap_or('\u{fffd}'));
        }
        Ok(out)
    }
}

/// `BinaryCMapReader.process`: fills `cmap` from the packed file `data`. `extend` is pdf.js's callback for a
/// `usecmap` (`extendCMap(cMap, fetchBuiltInCMap, useCMap)`), called with the CMap and the name it extends from.
pub fn process_binary_cmap<F>(data: &[u8], cmap: &mut CMap, extend: F) -> Result<()>
where
    F: FnOnce(&mut CMap, &str) -> Result<()>,
{
    let mut stream = BinaryCMapStream { data, pos: 0 };
    let header = stream.get_byte().map_or(-1, i32::from);
    cmap.vertical = header & 1 != 0;
    let mut use_cmap: Option<String> = None;
    let mut start: Num = [0; MAX_NUM_SIZE];
    let mut end: Num = [0; MAX_NUM_SIZE];
    let mut char_buf: Num = [0; MAX_NUM_SIZE];
    let mut char_code: Num = [0; MAX_NUM_SIZE];
    let mut tmp: Num = [0; MAX_NUM_SIZE];
    while let Some(b) = stream.get_byte() {
        let kind = b >> 5;
        if kind == 7 {
            match b & 0x1f {
                0 => {
                    stream.read_string()?;
                }
                1 => use_cmap = Some(stream.read_string()?),
                _ => {}
            }
            continue;
        }
        let sequence = b & 0x10 != 0;
        let data_size = usize::from(b & 15);
        if data_size + 1 > MAX_NUM_SIZE {
            return Err(unknown("BinaryCMapReader.process: Invalid dataSize."));
        }
        let ucs2_data_size = 1;
        let subitems_count = stream.read_number()?;
        match kind {
            0 => {
                stream.read_hex(&mut start, data_size);
                stream.read_hex_number(&mut end, data_size)?;
                add_hex(&mut end, &start, data_size);
                cmap.add_codespace_range(data_size + 1, hex_to_int(&start, data_size), hex_to_int(&end, data_size))?;
                for _ in 1..subitems_count {
                    inc_hex(&mut end, data_size);
                    stream.read_hex_number(&mut start, data_size)?;
                    add_hex(&mut start, &end, data_size);
                    stream.read_hex_number(&mut end, data_size)?;
                    add_hex(&mut end, &start, data_size);
                    cmap.add_codespace_range(data_size + 1, hex_to_int(&start, data_size), hex_to_int(&end, data_size))?;
                }
            }
            1 => {
                stream.read_hex(&mut start, data_size);
                stream.read_hex_number(&mut end, data_size)?;
                add_hex(&mut end, &start, data_size);
                stream.read_number()?;
                for _ in 1..subitems_count {
                    inc_hex(&mut end, data_size);
                    stream.read_hex_number(&mut start, data_size)?;
                    add_hex(&mut start, &end, data_size);
                    stream.read_hex_number(&mut end, data_size)?;
                    add_hex(&mut end, &start, data_size);
                    stream.read_number()?;
                }
            }
            2 => {
                stream.read_hex(&mut char_buf, data_size);
                let mut code = i64::from(stream.read_number()?);
                cmap.map_one(hex_to_int(&char_buf, data_size), CMapValue::Cid(code));
                for _ in 1..subitems_count {
                    inc_hex(&mut char_buf, data_size);
                    if !sequence {
                        stream.read_hex_number(&mut tmp, data_size)?;
                        add_hex(&mut char_buf, &tmp, data_size);
                    }
                    code = stream.read_signed()? + (code + 1);
                    cmap.map_one(hex_to_int(&char_buf, data_size), CMapValue::Cid(code));
                }
            }
            3 => {
                stream.read_hex(&mut start, data_size);
                stream.read_hex_number(&mut end, data_size)?;
                add_hex(&mut end, &start, data_size);
                let mut code = i64::from(stream.read_number()?);
                cmap.map_cid_range(hex_to_int(&start, data_size), hex_to_int(&end, data_size), code)?;
                for _ in 1..subitems_count {
                    inc_hex(&mut end, data_size);
                    if sequence {
                        start = end;
                    } else {
                        stream.read_hex_number(&mut start, data_size)?;
                        add_hex(&mut start, &end, data_size);
                    }
                    stream.read_hex_number(&mut end, data_size)?;
                    add_hex(&mut end, &start, data_size);
                    code = i64::from(stream.read_number()?);
                    cmap.map_cid_range(hex_to_int(&start, data_size), hex_to_int(&end, data_size), code)?;
                }
            }
            4 => {
                stream.read_hex(&mut char_buf, ucs2_data_size);
                stream.read_hex(&mut char_code, data_size);
                cmap.map_one(hex_to_int(&char_buf, ucs2_data_size), CMapValue::Str(hex_to_str(&char_code, data_size)));
                for _ in 1..subitems_count {
                    inc_hex(&mut char_buf, ucs2_data_size);
                    if !sequence {
                        stream.read_hex_number(&mut tmp, ucs2_data_size)?;
                        add_hex(&mut char_buf, &tmp, ucs2_data_size);
                    }
                    inc_hex(&mut char_code, data_size);
                    stream.read_hex_signed(&mut tmp, data_size)?;
                    add_hex(&mut char_code, &tmp, data_size);
                    cmap.map_one(hex_to_int(&char_buf, ucs2_data_size), CMapValue::Str(hex_to_str(&char_code, data_size)));
                }
            }
            5 => {
                stream.read_hex(&mut start, ucs2_data_size);
                stream.read_hex_number(&mut end, ucs2_data_size)?;
                add_hex(&mut end, &start, ucs2_data_size);
                stream.read_hex(&mut char_code, data_size);
                cmap.map_bf_range(hex_to_int(&start, ucs2_data_size), hex_to_int(&end, ucs2_data_size), hex_to_str(&char_code, data_size))?;
                for _ in 1..subitems_count {
                    inc_hex(&mut end, ucs2_data_size);
                    if sequence {
                        start = end;
                    } else {
                        stream.read_hex_number(&mut start, ucs2_data_size)?;
                        add_hex(&mut start, &end, ucs2_data_size);
                    }
                    stream.read_hex_number(&mut end, ucs2_data_size)?;
                    add_hex(&mut end, &start, ucs2_data_size);
                    stream.read_hex(&mut char_code, data_size);
                    cmap.map_bf_range(hex_to_int(&start, ucs2_data_size), hex_to_int(&end, ucs2_data_size), hex_to_str(&char_code, data_size))?;
                }
            }
            _ => {
                return Err(PdfError::Unknown(format!("BinaryCMapReader.process - unknown type: {kind}")));
            }
        }
    }
    // `useCMap ? extend(useCMap) : cMap`: an empty name is falsy.
    match use_cmap.filter(|name| !name.is_empty()) {
        Some(name) => extend(cmap, &name),
        None => Ok(()),
    }
}
