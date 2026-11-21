//! CFF and Type 2 charstrings, following pdf.js `cff_parser.js` (`CFFParser`, with the repair pass over every
//! charstring that pdf.js runs on every font it reads) and the Type 2 interpreter of `font_renderer.js`
//! (`compileCharString`). Hints are ignored; `endchar` with four arguments (seac) draws the accent and the base.

use super::truetype::{subarray, u8_at};
use super::{CURVE_TO, CmapRange, Commands, FONT_IDENTITY_MATRIX, LINE_TO, MOVE_TO, Matrix, Result, error, lookup_cmap};

const MAX_SUBR_NESTING: u32 = 10;
const MAX_FD_ARRAY_COUNT: usize = 256;
/// Depth of nested subroutine calls the interpreter follows (a validated charstring nests at most
/// [`MAX_SUBR_NESTING`]; pdf.js has no limit and overflows its stack).
const MAX_CALL_DEPTH: usize = 100;

/// The Unicode value of the glyph name at each code of the Adobe StandardEncoding (0 where the code has no glyph):
/// `glyphsUnicode[StandardEncoding[code]]`, what `endchar` with four arguments looks the accent and base up by.
#[rustfmt::skip]
const STANDARD_ENCODING_UNICODE: [u16; 256] = [
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x2019,
    0x0028, 0x0029, 0x002A, 0x002B, 0x002C, 0x002D, 0x002E, 0x002F,
    0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037,
    0x0038, 0x0039, 0x003A, 0x003B, 0x003C, 0x003D, 0x003E, 0x003F,
    0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047,
    0x0048, 0x0049, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E, 0x004F,
    0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057,
    0x0058, 0x0059, 0x005A, 0x005B, 0x005C, 0x005D, 0x005E, 0x005F,
    0x2018, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067,
    0x0068, 0x0069, 0x006A, 0x006B, 0x006C, 0x006D, 0x006E, 0x006F,
    0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077,
    0x0078, 0x0079, 0x007A, 0x007B, 0x007C, 0x007D, 0x007E, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x00A1, 0x00A2, 0x00A3, 0x2044, 0x00A5, 0x0192, 0x00A7,
    0x00A4, 0x0027, 0x201C, 0x00AB, 0x2039, 0x203A, 0xFB01, 0xFB02,
    0x0000, 0x2013, 0x2020, 0x2021, 0x00B7, 0x0000, 0x00B6, 0x2022,
    0x201A, 0x201E, 0x201D, 0x00BB, 0x2026, 0x2030, 0x0000, 0x00BF,
    0x0000, 0x0060, 0x00B4, 0x02C6, 0x02DC, 0x00AF, 0x02D8, 0x02D9,
    0x00A8, 0x0000, 0x02DA, 0x00B8, 0x0000, 0x02DD, 0x02DB, 0x02C7,
    0x2014, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x00C6, 0x0000, 0x00AA, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0141, 0x00D8, 0x0152, 0x00BA, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x00E6, 0x0000, 0x0000, 0x0000, 0x0131, 0x0000, 0x0000,
    0x0142, 0x00F8, 0x0153, 0x00DF, 0x0000, 0x0000, 0x0000, 0x0000
];

/// What the renderer needs of a font dictionary of a CID-keyed CFF: its `FontMatrix`.
#[derive(Debug, Clone)]
struct FontDict {
    font_matrix: Vec<f64>,
}

/// A parsed CFF font: the charstrings after repair, the subroutines and, for a CID-keyed font, the font dictionaries.
#[derive(Debug)]
pub struct Type2Font {
    glyphs: Vec<Vec<u8>>,
    gsubrs: Vec<Vec<u8>>,
    /// Local subroutines: index 0 is the top dictionary's, `1 + n` the one of font dictionary `n`.
    locals: Vec<Option<Vec<Vec<u8>>>>,
    gsubrs_bias: i64,
    subrs_bias: i64,
    is_cid: bool,
    fd_select: Option<Vec<u8>>,
    fd_array: Vec<FontDict>,
}

fn subroutine_bias(count: usize) -> i64 {
    if count >= 33900 {
        32768
    } else if count < 1240 {
        107
    } else {
        1131
    }
}

/// `array[n]` of a JS array: `None` for an index that is not a whole number inside it.
fn index_of(n: f64, len: usize) -> Option<usize> {
    if n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n < len as f64 { Some(n as usize) } else { None }
}

impl Type2Font {
    pub fn glyph(&self, id: usize) -> Option<&[u8]> {
        self.glyphs.get(id).map(Vec::as_slice)
    }

    pub fn glyph_count(&self) -> usize {
        self.glyphs.len()
    }

    /// The font matrix to draw glyph `id` with: the font dictionary's of a CID-keyed font (default 0.001 when it has
    /// none), `default` otherwise or when the glyph's font dictionary index is invalid.
    pub(crate) fn glyph_font_matrix(&self, id: usize, default: Matrix) -> Result<Matrix> {
        let mut matrix = default;
        if self.is_cid {
            match self.fd_index(id) {
                Some(fd) => {
                    let m = &self.fd_array[fd].font_matrix;
                    if m.len() != 6 {
                        return error("Expected a valid fontMatrix.");
                    }
                    matrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
                }
                None => tracing::warn!("Invalid fd index for glyph index."),
            }
        }
        Ok(matrix)
    }

    fn fd_index(&self, glyph: usize) -> Option<usize> {
        let fd = usize::from(*self.fd_select.as_ref()?.get(glyph)?);
        (fd < self.fd_array.len()).then_some(fd)
    }

    /// pdf.js `compileCharString` of glyph `id` into `cmds`; `cmap` finds the glyphs of `endchar`'s accent and base.
    pub(crate) fn compile(&self, id: usize, cmds: &mut Commands, cmap: &[CmapRange]) -> Result<()> {
        let Some(code) = self.glyph(id) else {
            return error("Cannot read properties of undefined (reading 'buffer')");
        };
        Interpreter { font: self, cmap, cmds, glyph_id: id, stack: Vec::new(), x: 0.0, y: 0.0, stems: 0, first_point: None, depth: 0 }.run(code)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// CFF structure

/// pdf.js `parseIndex`: the objects of the INDEX at `pos` and the position after it. A position outside the data
/// reads as zero bytes.
fn parse_index(bytes: &[u8], pos: usize) -> Result<(Vec<Vec<u8>>, usize)> {
    let byte = |at: usize| usize::from(u8_at(bytes, at).unwrap_or(0));
    let count = (byte(pos) << 8) | byte(pos + 1);
    let mut pos = pos + 2;
    let mut offsets: Vec<usize> = Vec::new();
    let mut end = pos;
    if count != 0 {
        let offset_size = byte(pos);
        pos += 1;
        if !(1..=4).contains(&offset_size) {
            return error(format!("Invalid CFF INDEX offset size: {offset_size}"));
        }
        let start_pos = pos + (count + 1) * offset_size - 1;
        let len = bytes.len();
        let mut prev = start_pos;
        for _ in 0..=count {
            let mut offset = 0usize;
            for _ in 0..offset_size {
                offset = (offset << 8) | byte(pos);
                pos += 1;
            }
            prev = (start_pos + offset).max(prev).min(len);
            offsets.push(prev);
        }
        end = offsets[count];
    }
    let objects = offsets.windows(2).map(|w| subarray(bytes, w[0], w[1]).to_vec()).collect();
    Ok((objects, end))
}

/// JS `parseFloat` of the text of a real number operand.
pub(crate) fn js_parse_float(text: &str) -> f64 {
    let b = text.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'-' || b[i] == b'+') {
        i += 1;
    }
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let int_digits = digits(i);
    i += int_digits;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        frac_digits = digits(i + 1);
        if int_digits > 0 || frac_digits > 0 {
            i += 1 + frac_digits;
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut k = i + 1;
        if k < b.len() && (b[k] == b'-' || b[k] == b'+') {
            k += 1;
        }
        let exp_digits = digits(k);
        if exp_digits > 0 {
            i = k + exp_digits;
        }
    }
    text[..i].parse().unwrap_or(f64::NAN)
}

/// pdf.js `parseDict`: the entries (operator, operands) of a DICT; a reserved operand byte reads as NaN.
fn parse_dict(dict: &[u8]) -> Vec<(u16, Vec<f64>)> {
    let get = |at: usize| u8_at(dict, at).unwrap_or(0);
    let mut entries = Vec::new();
    let mut operands: Vec<f64> = Vec::new();
    let mut pos = 0usize;
    while pos < dict.len() {
        let mut b = u16::from(dict[pos]);
        if b <= 21 {
            if b == 12 {
                pos += 1;
                b = (12 << 8) | u16::from(get(pos));
            }
            entries.push((b, std::mem::take(&mut operands)));
            pos += 1;
        } else {
            let value = dict[pos];
            pos += 1;
            let operand = match value {
                30 => {
                    let mut text = String::new();
                    while pos < dict.len() {
                        let byte = dict[pos];
                        pos += 1;
                        let (b1, b2) = (byte >> 4, byte & 15);
                        let push = |text: &mut String, nibble: u8| match nibble {
                            0..=9 => text.push((b'0' + nibble) as char),
                            10 => text.push('.'),
                            11 => text.push('E'),
                            12 => text.push_str("E-"),
                            14 => text.push('-'),
                            _ => text.push_str("null"),
                        };
                        if b1 == 15 {
                            break;
                        }
                        push(&mut text, b1);
                        if b2 == 15 {
                            break;
                        }
                        push(&mut text, b2);
                    }
                    js_parse_float(&text)
                }
                28 => {
                    let v = i16::from_be_bytes([get(pos), get(pos + 1)]);
                    pos += 2;
                    f64::from(v)
                }
                29 => {
                    let v = i32::from_be_bytes([get(pos), get(pos + 1), get(pos + 2), get(pos + 3)]);
                    pos += 4;
                    f64::from(v)
                }
                32..=246 => f64::from(value) - 139.0,
                247..=250 => {
                    let v = (f64::from(value) - 247.0) * 256.0 + f64::from(get(pos)) + 108.0;
                    pos += 1;
                    v
                }
                251..=254 => {
                    let v = -((f64::from(value) - 251.0) * 256.0) - f64::from(get(pos)) - 108.0;
                    pos += 1;
                    v
                }
                _ => {
                    tracing::warn!("CFFParser.parseDict: \"{value}\" is a reserved command.");
                    f64::NAN
                }
            };
            operands.push(operand);
        }
    }
    entries
}

/// The values of a parsed DICT by operator. An entry with no operands or with a NaN operand is not kept
/// (`CFFDict.setByKey`).
#[derive(Debug, Default)]
struct Dict(std::collections::HashMap<u16, Vec<f64>>);

impl Dict {
    fn from_entries(entries: Vec<(u16, Vec<f64>)>) -> Self {
        let mut map = std::collections::HashMap::new();
        for (key, values) in entries {
            if values.is_empty() {
                continue;
            }
            if values.iter().any(|v| v.is_nan()) {
                tracing::warn!("Invalid CFFDict value: \"{values:?}\" for key \"{key}\".");
                continue;
            }
            map.insert(key, values);
        }
        Self(map)
    }

    fn has(&self, key: u16) -> bool {
        self.0.contains_key(&key)
    }

    /// The first operand of an `offset` or `num` entry.
    fn scalar(&self, key: u16) -> Option<f64> {
        self.0.get(&key).and_then(|v| v.first().copied())
    }
}

const OP_CHARSET: u16 = 15;
const OP_ENCODING: u16 = 16;
const OP_CHARSTRINGS: u16 = 17;
const OP_PRIVATE: u16 = 18;
const OP_SUBRS: u16 = 19;
const OP_FONT_MATRIX: u16 = (12 << 8) | 7;
const OP_ROS: u16 = (12 << 8) | 30;
const OP_FDARRAY: u16 = (12 << 8) | 36;
const OP_FDSELECT: u16 = (12 << 8) | 37;

/// What `parsePrivateDict` leaves of a dictionary's private dictionary.
enum Private {
    /// No usable private dictionary (`privateDict` is null in pdf.js: reading it throws).
    Missing,
    Present {
        subrs: Option<Vec<Vec<u8>>>,
    },
}

fn parse_private(bytes: &[u8], parent: &Dict) -> Result<Private> {
    if !parent.has(OP_PRIVATE) {
        return Ok(Private::Present { subrs: None });
    }
    let Some(po) = parent.0.get(&OP_PRIVATE).filter(|v| v.len() == 2) else {
        return Ok(Private::Missing);
    };
    let (size, offset) = (po[0], po[1]);
    if size == 0.0 || offset >= bytes.len() as f64 {
        return Ok(Private::Present { subrs: None });
    }
    if offset + size > bytes.len() as f64 {
        return error("CFF Private DICT extends past end of font");
    }
    let (size, offset) = (size.max(0.0) as usize, offset.max(0.0) as usize);
    let dict = Dict::from_entries(parse_dict(&bytes[offset..offset + size]));
    let subrs_offset = dict.scalar(OP_SUBRS).unwrap_or(0.0);
    if subrs_offset == 0.0 {
        return Ok(Private::Present { subrs: None });
    }
    let relative = offset as f64 + subrs_offset;
    if relative >= bytes.len() as f64 {
        return Ok(Private::Present { subrs: None });
    }
    let (objects, _) = parse_index(bytes, relative.max(0.0) as usize)?;
    Ok(Private::Present { subrs: Some(objects) })
}

/// The font dictionaries of a CID font's `FDArray`: each one's matrix, whether its private dictionary is readable, and
/// its local subroutines.
#[derive(Default)]
struct FdArray {
    dicts: Vec<FontDict>,
    private_ok: Vec<bool>,
    locals: Vec<Option<Vec<Vec<u8>>>>,
}

fn parse_fd_array(bytes: &[u8], top: &Dict) -> Result<FdArray> {
    let Some(fd_array_offset) = top.scalar(OP_FDARRAY) else {
        return error("Cannot read properties of undefined (reading 'length')");
    };
    let (fd_objects, _) = parse_index(bytes, fd_array_offset.max(0.0) as usize)?;
    let mut fd_count = fd_objects.len();
    if fd_count > MAX_FD_ARRAY_COUNT {
        tracing::warn!("CFFParser.parse: too many FDArray entries ({fd_count}).");
        fd_count = MAX_FD_ARRAY_COUNT;
    }
    let mut fds = FdArray { dicts: Vec::new(), private_ok: Vec::new(), locals: Vec::new() };
    for raw in fd_objects.iter().take(fd_count) {
        let dict = Dict::from_entries(parse_dict(raw));
        let private = parse_private(bytes, &dict)?;
        let font_matrix = dict.0.get(&OP_FONT_MATRIX).cloned().unwrap_or_else(|| FONT_IDENTITY_MATRIX.to_vec());
        fds.dicts.push(FontDict { font_matrix });
        match private {
            Private::Present { subrs } => {
                fds.private_ok.push(true);
                fds.locals.push(subrs);
            }
            Private::Missing => {
                fds.private_ok.push(false);
                fds.locals.push(None);
            }
        }
    }
    Ok(fds)
}

/// pdf.js `parseFDSelect`: the font dictionary index of each of `length` glyphs.
fn parse_fd_select(bytes: &[u8], mut pos: usize, length: usize) -> Result<Vec<u8>> {
    let get = |at: usize| usize::from(u8_at(bytes, at).unwrap_or(0));
    let format = u8_at(bytes, pos);
    pos += 1;
    let mut select: Vec<u8> = Vec::new();
    match format {
        Some(0) => {
            for _ in 0..length {
                select.push(get(pos) as u8);
                pos += 1;
            }
        }
        Some(3) => {
            let ranges = (get(pos) << 8) | get(pos + 1);
            pos += 2;
            for i in 0..ranges {
                let mut first = (get(pos) << 8) | get(pos + 1);
                pos += 2;
                if i == 0 && first != 0 {
                    tracing::warn!("parseFDSelect: The first range must have a first GID of 0 -- trying to recover.");
                    first = 0;
                }
                let fd = get(pos) as u8;
                pos += 1;
                let next = (get(pos) << 8) | get(pos + 1);
                if next as i64 - first as i64 > length as i64 - select.len() as i64 {
                    return error("parseFDSelect: Invalid font data.");
                }
                for _ in first..next {
                    select.push(fd);
                }
            }
        }
        other => {
            return error(format!("parseFDSelect: Unknown format \"{}\".", other.map_or("undefined".to_string(), |f| f.to_string())));
        }
    }
    if select.len() != length {
        return error("parseFDSelect: Invalid font data.");
    }
    Ok(select)
}

/// `parseCharsets` and `parseEncoding` throw for a format they do not know; nothing else of them reaches a path.
fn check_charset_and_encoding(bytes: &[u8], top: &Dict, is_cid: bool) -> Result<()> {
    let charset = top.scalar(OP_CHARSET).unwrap_or(0.0);
    if charset > 2.0 {
        let format = u8_at(bytes, charset as usize);
        if !matches!(format, Some(0..=2)) {
            return error("Unknown charset format");
        }
    }
    if !is_cid {
        let encoding = top.scalar(OP_ENCODING).unwrap_or(0.0);
        if encoding != 0.0 && encoding != 1.0 {
            let format = u8_at(bytes, encoding as usize).unwrap_or(0);
            if !matches!(format & 0x7f, 0 | 1) {
                return error(format!("Unknown encoding format: {format} in CFF"));
            }
        }
    }
    Ok(())
}

/// pdf.js `parseCff` over the bytes of a `CFF ` table (or a bare CFF file): structure, then the repair pass over the
/// charstrings. `seac_analysis` is pdf.js's `seacAnalysisEnabled` (always on in the renderer): a glyph whose
/// `endchar` has four arguments is replaced by a bare `endchar`, its parts are drawn through the font's own seac data.
pub fn parse_cff(data: &[u8], seac_analysis: bool) -> Result<Type2Font> {
    let shift = match data.iter().position(|&b| b == 1) {
        Some(p) => p,
        None => return error("Invalid CFF header"),
    };
    if shift != 0 {
        tracing::info!("cff data is shifted");
    }
    let bytes = &data[shift..];
    let hdr_size = usize::from(u8_at(bytes, 2).unwrap_or(0));
    let (_, name_end) = parse_index(bytes, hdr_size)?;
    let (top_dicts, top_end) = parse_index(bytes, name_end)?;
    let (_, string_end) = parse_index(bytes, top_end)?;
    let (gsubrs, _) = parse_index(bytes, string_end)?;
    let Some(top_raw) = top_dicts.first() else {
        return error("Cannot read properties of undefined (reading 'buffer')");
    };
    let top = Dict::from_entries(parse_dict(top_raw));
    let top_private = parse_private(bytes, &top)?;
    let is_cid = top.has(OP_ROS);
    let (mut glyphs, _) = parse_index(bytes, top.scalar(OP_CHARSTRINGS).unwrap_or(0.0).max(0.0) as usize)?;
    let glyph_count = glyphs.len();
    let mut locals: Vec<Option<Vec<Vec<u8>>>> = Vec::new();
    let mut fds = FdArray::default();
    let mut fd_select = None;
    let Private::Present { subrs: top_subrs } = top_private else {
        return error("Cannot read properties of null (reading 'subrsIndex')");
    };
    locals.push(top_subrs);
    check_charset_and_encoding(bytes, &top, is_cid)?;
    if is_cid {
        fds = parse_fd_array(bytes, &top)?;
        locals.extend(std::mem::take(&mut fds.locals));
        let Some(select_offset) = top.scalar(OP_FDSELECT) else {
            return error("Cannot read properties of undefined (reading 'length')");
        };
        fd_select = Some(parse_fd_select(bytes, select_offset.max(0.0) as usize, glyph_count)?);
    }
    let mut ctx = Repair { glyphs: &mut glyphs, gsubrs, locals, seac_analysis };
    for i in 0..glyph_count {
        let mut valid = true;
        let mut local_set = None;
        match (&fd_select, fds.dicts.is_empty()) {
            (Some(select), false) => {
                let fd = select.get(i).map(|&f| usize::from(f));
                if fd.is_none() {
                    tracing::warn!("Glyph index is not in fd select.");
                    valid = false;
                }
                if fd.is_some_and(|f| f >= fds.dicts.len()) {
                    tracing::warn!("Invalid fd index for glyph index.");
                    valid = false;
                }
                if valid {
                    let fd = fd.unwrap_or(0);
                    if !fds.private_ok[fd] {
                        return error("Cannot read properties of null (reading 'subrsIndex')");
                    }
                    local_set = Some(1 + fd);
                }
            }
            _ => {
                if ctx.locals[0].is_some() {
                    local_set = Some(0);
                }
            }
        }
        ctx.repair_glyph(i, local_set, valid);
    }
    let Repair { gsubrs, locals, .. } = ctx;
    let subrs_bias = subroutine_bias(locals[0].as_ref().map_or(0, Vec::len));
    Ok(Type2Font { glyphs, gsubrs_bias: subroutine_bias(gsubrs.len()), gsubrs, locals, subrs_bias, is_cid, fd_select, fd_array: fds.dicts })
}

impl Type2Font {
    /// A font over charstrings made elsewhere, as pdf.js reads back a Type 1 font it compiled to CFF: glyph 0 is the
    /// bare `.notdef` (`139 endchar`) and `glyphs` follow; `subrs` are the local subroutines. Every charstring goes
    /// through the same repair pass as a font read from bytes. An empty charstring is written as `139 endchar`, as
    /// pdf.js's `CFFCompiler.compileCharStrings` writes it.
    pub fn from_charstrings(glyphs: Vec<Vec<u8>>, subrs: Vec<Vec<u8>>) -> Self {
        let mut all = Vec::with_capacity(glyphs.len() + 1);
        all.push(vec![0x8b, 0x0e]);
        all.extend(glyphs.into_iter().map(|g| if g.is_empty() { vec![0x8b, 0x0e] } else { g }));
        let mut ctx = Repair { glyphs: &mut all, gsubrs: Vec::new(), locals: vec![Some(subrs)], seac_analysis: true };
        for i in 0..ctx.glyphs.len() {
            ctx.repair_glyph(i, Some(0), true);
        }
        let Repair { gsubrs, locals, .. } = ctx;
        let subrs_bias = subroutine_bias(locals[0].as_ref().map_or(0, Vec::len));
        Self { glyphs: all, gsubrs_bias: subroutine_bias(gsubrs.len()), gsubrs, locals, subrs_bias, is_cid: false, fd_select: None, fd_array: Vec::new() }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The repair pass (CFFParser.parseCharString)

#[derive(Clone, Copy)]
enum Ref {
    Glyph(usize),
    Gsubr(usize),
    Local(usize, usize),
}

struct RepairState {
    call_depth: u32,
    stack_size: i64,
    stack: Vec<f64>,
    hints: i64,
    first_stack_clearing: bool,
    has_v_stems: bool,
}

impl RepairState {
    fn new() -> Self {
        Self { call_depth: 0, stack_size: 0, stack: Vec::new(), hints: 0, first_stack_clearing: true, has_v_stems: false }
    }
}

/// One entry of `CharstringValidationData`.
#[derive(Clone, Copy)]
struct Validation {
    min: i64,
    stack_clearing: bool,
    reset_stack: bool,
    stem: bool,
    /// `stackDelta`, with the arithmetic `stackFn` of the operator (`add`, `sub`, `div`, `neg`, `mul`).
    delta: Option<(i64, Option<StackFn>)>,
}

#[derive(Clone, Copy)]
enum StackFn {
    Add,
    Sub,
    Div,
    Neg,
    Mul,
}

const fn plain(min: i64) -> Validation {
    Validation { min, stack_clearing: false, reset_stack: false, stem: false, delta: None }
}
const fn clearing(min: i64) -> Validation {
    Validation { min, stack_clearing: true, reset_stack: false, stem: false, delta: None }
}
const fn stem(min: i64) -> Validation {
    Validation { min, stack_clearing: true, reset_stack: false, stem: true, delta: None }
}
const fn reset(min: i64) -> Validation {
    Validation { min, stack_clearing: false, reset_stack: true, stem: false, delta: None }
}
const fn delta(min: i64, d: i64, f: Option<StackFn>) -> Validation {
    Validation { min, stack_clearing: false, reset_stack: false, stem: false, delta: Some((d, f)) }
}

/// `CharstringValidationData[op]`.
fn validation(op: u8) -> Option<Validation> {
    Some(match op {
        1 | 3 | 18 | 23 => stem(2),
        4 | 22 => clearing(1),
        5 => reset(2),
        6 | 7 => reset(1),
        8 => reset(6),
        10 | 29 => plain(1),
        11 => plain(0),
        14 | 19 | 20 => clearing(0),
        21 => clearing(2),
        24 | 25 => reset(8),
        26 | 27 | 30 | 31 => reset(4),
        _ => return None,
    })
}

/// `CharstringValidationData12[op]` for the escape `12 op`.
fn validation12(op: u8) -> Option<Validation> {
    Some(match op {
        3 | 4 => delta(2, -1, None),
        5 => delta(1, 0, None),
        9 => delta(1, 0, None),
        10 => delta(2, -1, Some(StackFn::Add)),
        11 => delta(2, -1, Some(StackFn::Sub)),
        12 => delta(2, -1, Some(StackFn::Div)),
        14 => delta(1, 0, Some(StackFn::Neg)),
        15 => delta(2, -1, None),
        18 => delta(1, -1, None),
        20 => delta(2, -2, None),
        21 => delta(1, 0, None),
        22 => delta(4, -3, None),
        23 => delta(0, 1, None),
        24 => delta(2, -1, Some(StackFn::Mul)),
        26 => delta(1, 0, None),
        27 => delta(1, 1, None),
        28 => delta(2, 0, None),
        29 => delta(2, 0, None),
        30 => delta(3, -2, None),
        34 => reset(7),
        35 => reset(13),
        36 => reset(9),
        37 => reset(11),
        _ => return None,
    })
}

struct Repair<'a> {
    glyphs: &'a mut Vec<Vec<u8>>,
    gsubrs: Vec<Vec<u8>>,
    locals: Vec<Option<Vec<Vec<u8>>>>,
    seac_analysis: bool,
}

/// `stack[stackSize++] = v` of the repair pass: the stack grows with NaN holes where JS leaves holes.
fn push_value(state: &mut RepairState, stack_size: &mut i64, v: f64) {
    if *stack_size >= 0 {
        let idx = *stack_size as usize;
        if state.stack.len() <= idx {
            state.stack.resize(idx + 1, f64::NAN);
        }
        state.stack[idx] = v;
    }
    *stack_size += 1;
}

impl Repair<'_> {
    /// Repairs glyph `i`; one that fails to validate, or whose font dictionary is already `!valid`, becomes a bare
    /// `endchar`.
    fn repair_glyph(&mut self, i: usize, local_set: Option<usize>, valid: bool) {
        let valid = valid && self.parse_char_string(&mut RepairState::new(), Ref::Glyph(i), local_set);
        if !valid {
            self.glyphs[i] = vec![14];
        }
    }

    fn byte(&self, r: Ref, at: usize) -> Option<u8> {
        self.data(r).get(at).copied()
    }

    fn data(&self, r: Ref) -> &[u8] {
        match r {
            Ref::Glyph(i) => &self.glyphs[i],
            Ref::Gsubr(i) => &self.gsubrs[i],
            Ref::Local(set, i) => self.locals[set].as_ref().map_or(&[], |l| l[i].as_slice()),
        }
    }

    fn data_mut(&mut self, r: Ref) -> &mut Vec<u8> {
        match r {
            Ref::Glyph(i) => &mut self.glyphs[i],
            Ref::Gsubr(i) => &mut self.gsubrs[i],
            Ref::Local(set, i) => &mut self.locals[set].as_mut().expect("local subroutine set")[i],
        }
    }

    /// `data.copyWithin(j - 1, j, -1)`: the byte before `j` is dropped by shifting the rest one place left.
    fn drop_byte_before(&mut self, r: Ref, j: usize) {
        let data = self.data_mut(r);
        let len = data.len();
        if j < len.saturating_sub(1) {
            data.copy_within(j..len - 1, j - 1);
        }
    }

    /// pdf.js `CFFParser.parseCharString`: validates the charstring at `r` (and the subroutines it calls) and repairs
    /// it in place. `false` marks it invalid.
    fn parse_char_string(&mut self, state: &mut RepairState, r: Ref, local_set: Option<usize>) -> bool {
        if state.call_depth > MAX_SUBR_NESTING {
            return false;
        }
        let mut stack_size = state.stack_size;
        let mut length = self.data(r).len();
        let mut j = 0usize;
        while j < length {
            let value = self.data(r)[j];
            j += 1;
            let mut command: Option<Validation> = None;
            if value == 12 {
                let q = self.byte(r, j);
                j += 1;
                if q == Some(0) {
                    let data = self.data_mut(r);
                    data[j - 2] = 139;
                    data[j - 1] = 22;
                    stack_size = 0;
                } else if let Some(q) = q {
                    command = validation12(q);
                }
            } else if value == 28 {
                let v = i16::from_be_bytes([self.byte(r, j).unwrap_or(0), self.byte(r, j + 1).unwrap_or(0)]);
                push_value(state, &mut stack_size, f64::from(v));
                j += 2;
            } else if value == 14 {
                if stack_size >= 4 {
                    stack_size -= 4;
                    if self.seac_analysis {
                        return false;
                    }
                }
                command = validation(14);
            } else if (32..=246).contains(&value) {
                push_value(state, &mut stack_size, f64::from(value) - 139.0);
            } else if (247..=254).contains(&value) {
                let next = self.byte(r, j).map_or(f64::NAN, f64::from);
                push_value(
                    state,
                    &mut stack_size,
                    if value < 251 {
                        f64::from((i32::from(value) - 247) << 8) + next + 108.0
                    } else {
                        -f64::from((i32::from(value) - 251) << 8) - next - 108.0
                    },
                );
                j += 1;
            } else if value == 255 {
                let v = i32::from_be_bytes([
                    self.byte(r, j).unwrap_or(0),
                    self.byte(r, j + 1).unwrap_or(0),
                    self.byte(r, j + 2).unwrap_or(0),
                    self.byte(r, j + 3).unwrap_or(0),
                ]);
                push_value(state, &mut stack_size, f64::from(v) / 65536.0);
                j += 4;
            } else if value == 19 || value == 20 {
                state.hints += stack_size >> 1;
                if state.hints == 0 {
                    self.drop_byte_before(r, j);
                    j -= 1;
                    length -= 1;
                    continue;
                }
                j += ((state.hints + 7) >> 3) as usize;
                stack_size %= 2;
                command = validation(value);
            } else if value == 10 || value == 29 {
                let count = if value == 10 { local_set.and_then(|s| self.locals[s].as_ref()).map(Vec::len) } else { Some(self.gsubrs.len()) };
                let Some(count) = count else {
                    tracing::warn!("Missing subrsIndex for {}", if value == 10 { "callsubr" } else { "callgsubr" });
                    return false;
                };
                let bias = if count < 1240 {
                    107
                } else if count < 33900 {
                    1131
                } else {
                    32768
                };
                stack_size -= 1;
                let popped = if stack_size >= 0 { state.stack.get(stack_size as usize).copied().unwrap_or(f64::NAN) } else { f64::NAN };
                let subr_number = popped + f64::from(bias);
                let Some(index) = index_of(subr_number, count) else {
                    tracing::warn!("Out of bounds subrIndex for {}", if value == 10 { "callsubr" } else { "callgsubr" });
                    return false;
                };
                state.stack_size = stack_size;
                state.call_depth += 1;
                let target = if value == 10 { Ref::Local(local_set.unwrap_or(0), index) } else { Ref::Gsubr(index) };
                if !self.parse_char_string(state, target, local_set) {
                    return false;
                }
                state.call_depth -= 1;
                stack_size = state.stack_size;
                continue;
            } else if value == 11 {
                state.stack_size = stack_size;
                return true;
            } else if value == 0 && j == self.data(r).len() {
                self.data_mut(r)[j - 1] = 14;
                command = validation(14);
            } else if value == 9 {
                self.drop_byte_before(r, j);
                j -= 1;
                length -= 1;
                continue;
            } else {
                command = validation(value);
            }
            if let Some(cmd) = command {
                if cmd.stem {
                    state.hints += stack_size >> 1;
                    if value == 3 || value == 23 {
                        state.has_v_stems = true;
                    } else if state.has_v_stems && (value == 1 || value == 18) {
                        tracing::warn!("CFF stem hints are in wrong order");
                        self.data_mut(r)[j - 1] = if value == 1 { 3 } else { 23 };
                    }
                }
                if stack_size < cmd.min {
                    tracing::warn!("Not enough parameters for a charstring command; actual: {stack_size}, expected: {}", cmd.min);
                    if stack_size == 0 {
                        self.data_mut(r)[j - 1] = 14;
                        return true;
                    }
                    return false;
                }
                if state.first_stack_clearing && cmd.stack_clearing {
                    state.first_stack_clearing = false;
                    stack_size -= cmd.min;
                    if stack_size >= 2 && cmd.stem {
                        stack_size %= 2;
                    } else if stack_size > 1 {
                        tracing::warn!("Found too many parameters for stack-clearing command");
                    }
                }
                if let Some((d, function)) = cmd.delta {
                    if let Some(function) = function {
                        let at = |k: i64| -> f64 { if k >= 0 { state.stack.get(k as usize).copied().unwrap_or(f64::NAN) } else { f64::NAN } };
                        let a = at(stack_size - 2);
                        let b = at(stack_size - 1);
                        let (slot, v) = match function {
                            StackFn::Add => (stack_size - 2, a + b),
                            StackFn::Sub => (stack_size - 2, a - b),
                            StackFn::Div => (stack_size - 2, a / b),
                            StackFn::Mul => (stack_size - 2, a * b),
                            StackFn::Neg => (stack_size - 1, -b),
                        };
                        if slot >= 0 {
                            let slot = slot as usize;
                            if state.stack.len() <= slot {
                                state.stack.resize(slot + 1, f64::NAN);
                            }
                            state.stack[slot] = v;
                        }
                    }
                    stack_size += d;
                } else if cmd.stack_clearing || cmd.reset_stack {
                    stack_size = 0;
                }
            }
        }
        if length < self.data(r).len() {
            self.data_mut(r)[length..].fill(14);
        }
        state.stack_size = stack_size;
        true
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The Type 2 interpreter (font_renderer.js compileCharString)

struct Interpreter<'a> {
    font: &'a Type2Font,
    cmap: &'a [CmapRange],
    cmds: &'a mut Commands,
    glyph_id: usize,
    stack: Vec<f64>,
    x: f64,
    y: f64,
    stems: i64,
    first_point: Option<[f64; 2]>,
    depth: usize,
}

impl<'a> Interpreter<'a> {
    fn run(mut self, code: &'a [u8]) -> Result<()> {
        self.parse(code)
    }

    fn shift(&mut self) -> f64 {
        if self.stack.is_empty() { f64::NAN } else { self.stack.remove(0) }
    }

    fn pop(&mut self) -> f64 {
        self.stack.pop().unwrap_or(f64::NAN)
    }

    fn move_to(&mut self, x: f64, y: f64) {
        if let Some(fp) = self.first_point {
            self.cmds.add(LINE_TO, &fp);
        }
        self.first_point = Some([x, y]);
        self.cmds.add(MOVE_TO, &[x, y]);
    }

    fn line_to(&mut self, x: f64, y: f64) {
        self.cmds.add(LINE_TO, &[x, y]);
    }

    fn curve_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, x: f64, y: f64) {
        self.cmds.add(CURVE_TO, &[x1, y1, x2, y2, x, y]);
    }

    /// The local subroutine `n` of the glyph being drawn (`callsubr`).
    fn local_subr(&self, n: f64) -> Option<&'a [u8]> {
        let font = self.font;
        if font.is_cid {
            let Some(fd) = font.fd_select.as_ref().and_then(|s| s.get(self.glyph_id)).map(|&f| usize::from(f)).filter(|&f| f < font.fd_array.len()) else {
                tracing::warn!("Invalid fd index for glyph index.");
                return None;
            };
            let subrs = font.locals.get(1 + fd)?.as_ref()?;
            return index_of(n + subroutine_bias(subrs.len()) as f64, subrs.len()).map(|i| subrs[i].as_slice());
        }
        let subrs = font.locals[0].as_deref().unwrap_or(&[]);
        index_of(n + font.subrs_bias as f64, subrs.len()).map(|i| subrs[i].as_slice())
    }

    fn parse(&mut self, code: &'a [u8]) -> Result<()> {
        self.depth += 1;
        if self.depth > MAX_CALL_DEPTH {
            return error("Maximum call stack size exceeded");
        }
        let result = self.parse_ops(code);
        self.depth -= 1;
        result
    }

    fn parse_ops(&mut self, code: &'a [u8]) -> Result<()> {
        let mut i = 0usize;
        while i < code.len() {
            let mut stack_clean = false;
            let mut v = code[i];
            i += 1;
            let mut xa: f64;
            let mut xb: f64;
            let mut ya: f64;
            let mut yb: f64;
            let y1: f64;
            let y2: f64;
            let y3: f64;
            match v {
                1 | 3 | 18 | 23 => {
                    self.stems += (self.stack.len() >> 1) as i64;
                    stack_clean = true;
                }
                4 => {
                    self.y += self.pop();
                    self.move_to(self.x, self.y);
                    stack_clean = true;
                }
                5 => {
                    while !self.stack.is_empty() {
                        self.x += self.shift();
                        self.y += self.shift();
                        self.line_to(self.x, self.y);
                    }
                }
                6 => {
                    while !self.stack.is_empty() {
                        self.x += self.shift();
                        self.line_to(self.x, self.y);
                        if self.stack.is_empty() {
                            break;
                        }
                        self.y += self.shift();
                        self.line_to(self.x, self.y);
                    }
                }
                7 => {
                    while !self.stack.is_empty() {
                        self.y += self.shift();
                        self.line_to(self.x, self.y);
                        if self.stack.is_empty() {
                            break;
                        }
                        self.x += self.shift();
                        self.line_to(self.x, self.y);
                    }
                }
                8 => {
                    while !self.stack.is_empty() {
                        xa = self.x + self.shift();
                        ya = self.y + self.shift();
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.x = xb + self.shift();
                        self.y = yb + self.shift();
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                    }
                }
                10 => {
                    let n = self.pop();
                    if let Some(subr) = self.local_subr(n) {
                        self.parse(subr)?;
                    }
                }
                11 => return Ok(()),
                12 => {
                    let Some(&second) = code.get(i) else {
                        return error("unknown operator: 12 undefined");
                    };
                    i += 1;
                    v = second;
                    match v {
                        34 => {
                            xa = self.x + self.shift();
                            xb = xa + self.shift();
                            y1 = self.y + self.shift();
                            self.x = xb + self.shift();
                            self.curve_to(xa, self.y, xb, y1, self.x, y1);
                            xa = self.x + self.shift();
                            xb = xa + self.shift();
                            self.x = xb + self.shift();
                            self.curve_to(xa, y1, xb, self.y, self.x, self.y);
                        }
                        35 => {
                            xa = self.x + self.shift();
                            ya = self.y + self.shift();
                            xb = xa + self.shift();
                            yb = ya + self.shift();
                            self.x = xb + self.shift();
                            self.y = yb + self.shift();
                            self.curve_to(xa, ya, xb, yb, self.x, self.y);
                            xa = self.x + self.shift();
                            ya = self.y + self.shift();
                            xb = xa + self.shift();
                            yb = ya + self.shift();
                            self.x = xb + self.shift();
                            self.y = yb + self.shift();
                            self.curve_to(xa, ya, xb, yb, self.x, self.y);
                            self.pop();
                        }
                        36 => {
                            xa = self.x + self.shift();
                            y1 = self.y + self.shift();
                            xb = xa + self.shift();
                            y2 = y1 + self.shift();
                            self.x = xb + self.shift();
                            self.curve_to(xa, y1, xb, y2, self.x, y2);
                            xa = self.x + self.shift();
                            xb = xa + self.shift();
                            y3 = y2 + self.shift();
                            self.x = xb + self.shift();
                            self.curve_to(xa, y2, xb, y3, self.x, self.y);
                        }
                        37 => {
                            let (x0, y0) = (self.x, self.y);
                            xa = self.x + self.shift();
                            ya = self.y + self.shift();
                            xb = xa + self.shift();
                            yb = ya + self.shift();
                            self.x = xb + self.shift();
                            self.y = yb + self.shift();
                            self.curve_to(xa, ya, xb, yb, self.x, self.y);
                            xa = self.x + self.shift();
                            ya = self.y + self.shift();
                            xb = xa + self.shift();
                            yb = ya + self.shift();
                            self.x = xb;
                            self.y = yb;
                            if (self.x - x0).abs() > (self.y - y0).abs() {
                                self.x += self.shift();
                            } else {
                                self.y += self.shift();
                            }
                            self.curve_to(xa, ya, xb, yb, self.x, self.y);
                        }
                        _ => return error(format!("unknown operator: 12 {v}")),
                    }
                }
                14 => {
                    if self.stack.len() >= 4 {
                        let achar = self.pop();
                        let bchar = self.pop();
                        self.y = self.pop();
                        self.x = self.pop();
                        self.cmds.save();
                        self.cmds.translate(self.x, self.y);
                        self.compile_seac_part(achar)?;
                        self.cmds.restore();
                        self.compile_seac_part(bchar)?;
                    }
                    return Ok(());
                }
                19 | 20 => {
                    self.stems += (self.stack.len() >> 1) as i64;
                    i += ((self.stems + 7) >> 3) as usize;
                    stack_clean = true;
                }
                21 => {
                    self.y += self.pop();
                    self.x += self.pop();
                    self.move_to(self.x, self.y);
                    stack_clean = true;
                }
                22 => {
                    self.x += self.pop();
                    self.move_to(self.x, self.y);
                    stack_clean = true;
                }
                24 => {
                    while self.stack.len() > 2 {
                        xa = self.x + self.shift();
                        ya = self.y + self.shift();
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.x = xb + self.shift();
                        self.y = yb + self.shift();
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                    }
                    self.x += self.shift();
                    self.y += self.shift();
                    self.line_to(self.x, self.y);
                }
                25 => {
                    while self.stack.len() > 6 {
                        self.x += self.shift();
                        self.y += self.shift();
                        self.line_to(self.x, self.y);
                    }
                    xa = self.x + self.shift();
                    ya = self.y + self.shift();
                    xb = xa + self.shift();
                    yb = ya + self.shift();
                    self.x = xb + self.shift();
                    self.y = yb + self.shift();
                    self.curve_to(xa, ya, xb, yb, self.x, self.y);
                }
                26 => {
                    if self.stack.len() % 2 == 1 {
                        self.x += self.shift();
                    }
                    while !self.stack.is_empty() {
                        xa = self.x;
                        ya = self.y + self.shift();
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.x = xb;
                        self.y = yb + self.shift();
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                    }
                }
                27 => {
                    if self.stack.len() % 2 == 1 {
                        self.y += self.shift();
                    }
                    while !self.stack.is_empty() {
                        xa = self.x + self.shift();
                        ya = self.y;
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.x = xb + self.shift();
                        self.y = yb;
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                    }
                }
                28 => {
                    let (Some(&hi), Some(&lo)) = (code.get(i), code.get(i + 1)) else {
                        return error("Offset is outside the bounds of the DataView");
                    };
                    self.stack.push(f64::from(i16::from_be_bytes([hi, lo])));
                    i += 2;
                }
                29 => {
                    let n = self.pop() + self.font.gsubrs_bias as f64;
                    if let Some(index) = index_of(n, self.font.gsubrs.len()) {
                        self.parse(self.font.gsubrs[index].as_slice())?;
                    }
                }
                30 => {
                    while !self.stack.is_empty() {
                        xa = self.x;
                        ya = self.y + self.shift();
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.x = xb + self.shift();
                        self.y = yb + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                        if self.stack.is_empty() {
                            break;
                        }
                        xa = self.x + self.shift();
                        ya = self.y;
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.y = yb + self.shift();
                        self.x = xb + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                    }
                }
                31 => {
                    while !self.stack.is_empty() {
                        xa = self.x + self.shift();
                        ya = self.y;
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.y = yb + self.shift();
                        self.x = xb + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                        if self.stack.is_empty() {
                            break;
                        }
                        xa = self.x;
                        ya = self.y + self.shift();
                        xb = xa + self.shift();
                        yb = ya + self.shift();
                        self.x = xb + self.shift();
                        self.y = yb + if self.stack.len() == 1 { self.shift() } else { 0.0 };
                        self.curve_to(xa, ya, xb, yb, self.x, self.y);
                    }
                }
                _ => {
                    if v < 32 {
                        return error(format!("unknown operator: {v}"));
                    }
                    if v < 247 {
                        self.stack.push(f64::from(v) - 139.0);
                    } else if v < 251 {
                        let next = code.get(i).map_or(f64::NAN, |&b| f64::from(b));
                        i += 1;
                        self.stack.push((f64::from(v) - 247.0) * 256.0 + next + 108.0);
                    } else if v < 255 {
                        let next = code.get(i).map_or(f64::NAN, |&b| f64::from(b));
                        i += 1;
                        self.stack.push(-(f64::from(v) - 251.0) * 256.0 - next - 108.0);
                    } else {
                        let Some(b) = code.get(i..i + 4) else {
                            return error("Offset is outside the bounds of the DataView");
                        };
                        self.stack.push(f64::from(i32::from_be_bytes([b[0], b[1], b[2], b[3]])) / 65536.0);
                        i += 4;
                    }
                }
            }
            if stack_clean {
                self.stack.clear();
            }
        }
        Ok(())
    }

    /// One half of seac: the glyph of the StandardEncoding code `code`, found through the `cmap`, drawn into the
    /// same path by a new interpreter.
    fn compile_seac_part(&mut self, code: f64) -> Result<()> {
        let unicode = match index_of(code, 256) {
            Some(i) => u32::from(STANDARD_ENCODING_UNICODE[i]),
            None => 0,
        };
        let glyph_id = usize::from(lookup_cmap(self.cmap, unicode)?);
        let Some(glyph) = self.font.glyph(glyph_id) else {
            return error("Cannot read properties of undefined (reading 'buffer')");
        };
        let mut inner = Interpreter {
            font: self.font,
            cmap: self.cmap,
            cmds: &mut *self.cmds,
            glyph_id,
            stack: Vec::new(),
            x: 0.0,
            y: 0.0,
            stems: 0,
            first_point: None,
            depth: self.depth,
        };
        inner.parse(glyph)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_of(font: &Type2Font, id: usize) -> Vec<f32> {
        let mut cmds = Commands::new();
        font.compile(id, &mut cmds, &[]).unwrap();
        cmds.into_path()
    }

    /// `n` as a Type 2 number operand (-107..=107).
    fn num(n: i32) -> u8 {
        (n + 139) as u8
    }

    #[test]
    fn a_triangle_charstring_draws_move_and_lines() {
        // 100 0 rmoveto, 100 0 rlineto, -100 100 rlineto endchar
        let glyph = vec![num(100), num(0), 21, num(100), num(0), 5, num(-100), num(100), 5, 14];
        let font = Type2Font::from_charstrings(vec![glyph], Vec::new());
        let path = path_of(&font, 1);
        assert_eq!(path, vec![MOVE_TO, 100.0, 0.0, LINE_TO, 200.0, 0.0, LINE_TO, 100.0, 100.0]);
    }

    #[test]
    fn a_second_moveto_closes_the_previous_contour_with_a_line_to_its_start() {
        let glyph = vec![num(10), num(10), 21, num(5), num(0), 5, num(20), num(20), 21, num(5), num(0), 5, 14];
        let font = Type2Font::from_charstrings(vec![glyph], Vec::new());
        let path = path_of(&font, 1);
        assert_eq!(path[0], MOVE_TO);
        // the second moveto is preceded by a lineto back to (10, 10)
        let second = path.iter().rposition(|&w| w == MOVE_TO).unwrap();
        assert_eq!(&path[second - 3..second], &[LINE_TO, 10.0, 10.0]);
    }

    #[test]
    fn a_subroutine_is_called_through_the_bias() {
        // subr 0: 50 0 rlineto return; glyph: 0 0 rmoveto, -107 callsubr (bias 107 -> index 0), endchar
        let subr = vec![num(50), num(0), 5, 11];
        let glyph = vec![num(0), num(0), 21, num(-107), 10, 14];
        let font = Type2Font::from_charstrings(vec![glyph], vec![subr]);
        let path = path_of(&font, 1);
        assert_eq!(path, vec![MOVE_TO, 0.0, 0.0, LINE_TO, 50.0, 0.0]);
    }

    #[test]
    fn a_charstring_with_too_few_arguments_is_replaced_by_endchar() {
        // rlineto needs two arguments and has one
        let glyph = vec![num(5), 5, 14];
        let font = Type2Font::from_charstrings(vec![glyph], Vec::new());
        assert_eq!(font.glyph(1), Some(&[14u8][..]));
        assert!(path_of(&font, 1).is_empty());
    }

    #[test]
    fn an_empty_charstring_is_compiled_as_a_bare_endchar_with_one_operand() {
        let font = Type2Font::from_charstrings(vec![Vec::new()], Vec::new());
        assert_eq!(font.glyph(1), Some(&[0x8b, 0x0e][..]));
        assert!(path_of(&font, 1).is_empty());
    }

    #[test]
    fn real_operands_read_like_parse_float() {
        assert_eq!(js_parse_float("-1.5E-2"), -0.015);
        assert_eq!(js_parse_float("12null3"), 12.0);
        assert!(js_parse_float("null").is_nan());
        assert!(js_parse_float("").is_nan());
    }

    fn index(objects: &[&[u8]]) -> Vec<u8> {
        let mut out = (objects.len() as u16).to_be_bytes().to_vec();
        if objects.is_empty() {
            return out;
        }
        out.push(1);
        let mut offset = 1u8;
        out.push(offset);
        for object in objects {
            offset += object.len() as u8;
            out.push(offset);
        }
        for object in objects {
            out.extend_from_slice(object);
        }
        out
    }

    fn offset_operand(value: usize, op: &[u8]) -> Vec<u8> {
        let mut out = vec![29];
        out.extend((value as u32).to_be_bytes());
        out.extend_from_slice(op);
        out
    }

    /// A CFF font of `glyphs`; a CID-keyed one when `fd_select` (one font dictionary index per glyph) is given.
    fn cff_font(glyphs: &[&[u8]], fd_select: Option<&[u8]>) -> Vec<u8> {
        let top_dict = |charstrings: usize, fd_array: usize, select: usize| {
            let mut dict = Vec::new();
            if fd_select.is_some() {
                dict.extend([139, 139, 139, 12, 30]);
                dict.extend(offset_operand(fd_array, &[12, 36]));
                dict.extend(offset_operand(select, &[12, 37]));
            }
            dict.extend(offset_operand(charstrings, &[17]));
            dict
        };
        let head = [vec![1, 0, 4, 1], index(&[b"F"]), index(&[&top_dict(0, 0, 0)]), index(&[]), index(&[])].concat();
        let charstrings = index(glyphs);
        let charstrings_at = head.len();
        let fd_array_at = charstrings_at + charstrings.len();
        let fd_array = index(&[&[]]);
        let select_at = fd_array_at + fd_array.len();
        let top = top_dict(charstrings_at, fd_array_at, select_at);
        let mut font = [vec![1, 0, 4, 1], index(&[b"F"]), index(&[&top]), index(&[]), index(&[])].concat();
        font.extend(charstrings);
        if let Some(select) = fd_select {
            font.extend(fd_array);
            font.push(0);
            font.extend_from_slice(select);
        }
        font
    }

    #[test]
    fn a_name_keyed_cff_font_reads_its_glyphs_and_replaces_a_broken_one_by_endchar() {
        let triangle = [num(100), num(0), 21, num(100), num(0), 5, 14];
        let broken = [num(5), 5, 14];
        let font = parse_cff(&cff_font(&[&[0x8b, 14], &triangle, &broken], None), true).unwrap();
        assert!(!font.is_cid);
        assert_eq!(font.glyph(1), Some(&triangle[..]));
        assert_eq!(font.glyph(2), Some(&[14u8][..]));
        assert_eq!(path_of(&font, 1), vec![MOVE_TO, 100.0, 0.0, LINE_TO, 200.0, 0.0]);
    }

    #[test]
    fn a_cid_keyed_cff_font_replaces_the_glyph_of_an_unknown_font_dictionary_by_endchar() {
        let triangle = [num(100), num(0), 21, num(100), num(0), 5, 14];
        let bytes = cff_font(&[&triangle, &triangle], Some(&[0, 3]));
        let font = parse_cff(&bytes, true).unwrap();
        assert!(font.is_cid);
        assert_eq!(font.glyph(0), Some(&triangle[..]));
        assert_eq!(font.glyph(1), Some(&[14u8][..]));
        assert_eq!(path_of(&font, 0), vec![MOVE_TO, 100.0, 0.0, LINE_TO, 200.0, 0.0]);
    }

    #[test]
    fn a_dict_reads_integer_and_real_operands_before_each_operator() {
        // 100 (1 byte), 1000 (28 int16), -1.5 (30 nibbles `-1.5` then 0xf), then operator 17; then `12 7`
        let dict = [num(100), 28, 0x03, 0xe8, 30, 0xe1, 0xa5, 0xff, 17, 12, 7];
        assert_eq!(parse_dict(&dict), vec![(17, vec![100.0, 1000.0, -1.5]), ((12 << 8) | 7, vec![])]);
    }

    #[test]
    fn index_offsets_are_clamped_to_the_data() {
        // count 2, offSize 1, offsets 1, 3, 200 (past the end): the last object is cut at the end of the data
        let bytes = [0, 2, 1, 1, 3, 200, 0xaa, 0xbb, 0xcc];
        let (objects, end) = parse_index(&bytes, 0).unwrap();
        assert_eq!(objects, vec![vec![0xaa, 0xbb], vec![0xcc]]);
        assert_eq!(end, bytes.len());
    }
}
