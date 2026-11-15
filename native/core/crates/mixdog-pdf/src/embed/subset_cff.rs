//! The OpenType CFF subset: fontkit's `CFFSubset`. The result is a CID-keyed CFF font (the `CIDFontType0C` program of a
//! Type0 font) whose glyph ids are the positions in the list of glyphs: the charstrings of the listed glyphs in order,
//! a charset of the identity (CID = glyph id), the Registry-Ordering-Supplement `Adobe-Identity-0`, and the subroutines
//! the charstrings call kept while every other subroutine is replaced by a lone `return` (so the numbering and the
//! subroutine bias stay as they were). A font that is not CID-keyed gets one font dictionary with its Private dictionary
//! and a format-3 FDSelect; a CID-keyed one keeps the font dictionaries its glyphs use.

use std::collections::BTreeSet;

use super::{EmbedError, be_u16, be_u32};

/// The standard strings of CFF: a SID below this is one of them, the rest index the font's own String INDEX.
const STANDARD_STRINGS: u16 = 391;
/// A subroutine nesting the specification allows is 10; a charstring that goes deeper is cut here.
const MAX_SUBR_DEPTH: usize = 16;

fn damaged() -> EmbedError {
    EmbedError::new("The CFF table is damaged")
}

/// An INDEX: where each object is in the table, and where the INDEX ends.
struct Index {
    objects: Vec<(usize, usize)>,
    end: usize,
}

impl Index {
    fn read(data: &[u8], at: usize) -> Result<Self, EmbedError> {
        let count = usize::from(be_u16(data, at).ok_or_else(damaged)?);
        if count == 0 {
            return Ok(Self {
                objects: Vec::new(),
                end: at + 2,
            });
        }
        let size = usize::from(*data.get(at + 2).ok_or_else(damaged)?);
        if !(1..=4).contains(&size) {
            return Err(damaged());
        }
        let offset = |index: usize| -> Result<usize, EmbedError> {
            let start = at + 3 + index * size;
            let bytes = data.get(start..start + size).ok_or_else(damaged)?;
            Ok(bytes
                .iter()
                .fold(0usize, |value, byte| value * 256 + usize::from(*byte)))
        };
        let base = at + 3 + (count + 1) * size - 1;
        let mut objects = Vec::with_capacity(count);
        for index in 0..count {
            let (start, end) = (base + offset(index)?, base + offset(index + 1)?);
            if start > end || end > data.len() {
                return Err(damaged());
            }
            objects.push((start, end));
        }
        Ok(Self {
            objects,
            end: base + offset(count)?,
        })
    }

    fn get<'a>(&self, data: &'a [u8], index: usize) -> Option<&'a [u8]> {
        self.objects
            .get(index)
            .map(|(start, end)| &data[*start..*end])
    }

    fn len(&self) -> usize {
        self.objects.len()
    }
}

/// One operand of a DICT: its bytes as written, and its value.
#[derive(Clone)]
struct Operand {
    raw: Vec<u8>,
    value: f64,
}

/// One operator of a DICT with its operands; the two-byte operators `12 n` are `1200 + n`.
#[derive(Clone)]
struct Entry {
    op: u16,
    operands: Vec<Operand>,
}

fn real_value(nibbles: &[u8]) -> f64 {
    let mut text = String::new();
    for nibble in nibbles {
        match nibble {
            0..=9 => text.push(char::from(b'0' + nibble)),
            0xA => text.push('.'),
            0xB => text.push('E'),
            0xC => text.push_str("E-"),
            0xE => text.push('-'),
            _ => {}
        }
    }
    text.parse().unwrap_or(0.0)
}

fn read_dict(data: &[u8]) -> Result<Vec<Entry>, EmbedError> {
    let mut entries = Vec::new();
    let mut operands: Vec<Operand> = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let b0 = data[at];
        let operand = |length: usize, value: f64, at: usize| -> Result<Operand, EmbedError> {
            Ok(Operand {
                raw: data.get(at..at + length).ok_or_else(damaged)?.to_vec(),
                value,
            })
        };
        match b0 {
            0..=21 => {
                let op = if b0 == 12 {
                    1200 + u16::from(*data.get(at + 1).ok_or_else(damaged)?)
                } else {
                    u16::from(b0)
                };
                at += if b0 == 12 { 2 } else { 1 };
                entries.push(Entry {
                    op,
                    operands: std::mem::take(&mut operands),
                });
            }
            28 => {
                let value = f64::from(be_u16(data, at + 1).ok_or_else(damaged)? as i16);
                operands.push(operand(3, value, at)?);
                at += 3;
            }
            29 => {
                let value = f64::from(be_u32(data, at + 1).ok_or_else(damaged)? as i32);
                operands.push(operand(5, value, at)?);
                at += 5;
            }
            30 => {
                let mut end = at + 1;
                let mut nibbles = Vec::new();
                loop {
                    let byte = *data.get(end).ok_or_else(damaged)?;
                    end += 1;
                    let (high, low) = (byte >> 4, byte & 15);
                    if high == 15 {
                        break;
                    }
                    nibbles.push(high);
                    if low == 15 {
                        break;
                    }
                    nibbles.push(low);
                }
                operands.push(Operand {
                    raw: data[at..end].to_vec(),
                    value: real_value(&nibbles),
                });
                at = end;
            }
            32..=246 => {
                operands.push(operand(1, f64::from(b0) - 139.0, at)?);
                at += 1;
            }
            247..=250 => {
                let b1 = f64::from(*data.get(at + 1).ok_or_else(damaged)?);
                operands.push(operand(
                    2,
                    (f64::from(b0) - 247.0) * 256.0 + b1 + 108.0,
                    at,
                )?);
                at += 2;
            }
            251..=254 => {
                let b1 = f64::from(*data.get(at + 1).ok_or_else(damaged)?);
                operands.push(operand(
                    2,
                    -(f64::from(b0) - 251.0) * 256.0 - b1 - 108.0,
                    at,
                )?);
                at += 2;
            }
            _ => return Err(damaged()),
        }
    }
    Ok(entries)
}

fn find(entries: &[Entry], op: u16) -> Option<&Entry> {
    entries.iter().find(|entry| entry.op == op)
}

/// The font dictionary's Private DICT and its local subroutines.
struct Private {
    entries: Vec<Entry>,
    subrs: Option<Index>,
}

fn read_private(data: &[u8], dict: &[Entry]) -> Result<Option<Private>, EmbedError> {
    let Some(operands) = find(dict, 18).map(|entry| &entry.operands) else {
        return Ok(None);
    };
    if operands.len() < 2 {
        return Err(damaged());
    }
    let (size, offset) = (operands[0].value as usize, operands[1].value as usize);
    let entries = read_dict(data.get(offset..offset + size).ok_or_else(damaged)?)?;
    let subrs = match find(&entries, 19).and_then(|entry| entry.operands.first()) {
        Some(relative) => Some(Index::read(data, offset + relative.value as usize)?),
        None => None,
    };
    Ok(Some(Private { entries, subrs }))
}

/// The font dictionary an FD index selects for each glyph of a CID-keyed font (`FDSelect`).
fn read_fd_select(data: &[u8], at: usize, glyph_count: usize) -> Result<Vec<u8>, EmbedError> {
    let mut selected = vec![0u8; glyph_count];
    match *data.get(at).ok_or_else(damaged)? {
        0 => {
            for (gid, slot) in selected.iter_mut().enumerate() {
                *slot = *data.get(at + 1 + gid).ok_or_else(damaged)?;
            }
        }
        3 => {
            let ranges = usize::from(be_u16(data, at + 1).ok_or_else(damaged)?);
            for range in 0..ranges {
                let base = at + 3 + range * 3;
                let first = usize::from(be_u16(data, base).ok_or_else(damaged)?);
                let fd = *data.get(base + 2).ok_or_else(damaged)?;
                let next = usize::from(be_u16(data, base + 3).ok_or_else(damaged)?);
                for slot in selected.iter_mut().take(next.min(glyph_count)).skip(first) {
                    *slot = fd;
                }
            }
        }
        _ => return Err(damaged()),
    }
    Ok(selected)
}

/// The bias added to the operand of `callsubr` and `callgsubr` (Type 2 charstring format, 4.7).
fn bias(count: usize) -> i64 {
    if count < 1240 {
        107
    } else if count < 33900 {
        1131
    } else {
        32768
    }
}

/// Follows a charstring for the subroutines it calls, like fontkit's charstring runner: the numbers are kept on a stack
/// so that the operand of a call is known, the stem hints are counted so that the mask after `hintmask` is skipped.
struct Scanner<'a> {
    data: &'a [u8],
    globals: &'a Index,
    locals: Option<&'a Index>,
    used_globals: &'a mut BTreeSet<usize>,
    used_locals: &'a mut BTreeSet<usize>,
    stack: Vec<f64>,
    transient: [f64; 32],
    stems: usize,
}

/// Replaces the two numbers on top of the stack with `apply(lower, upper)`.
fn binary(stack: &mut Vec<f64>, apply: impl Fn(f64, f64) -> f64) {
    if let (Some(b), Some(a)) = (stack.pop(), stack.pop()) {
        stack.push(apply(a, b));
    }
}

impl Scanner<'_> {
    /// Runs `code`; true once `endchar` was reached (the whole charstring is over).
    fn run(&mut self, code: &[u8], depth: usize) -> bool {
        let mut at = 0;
        while at < code.len() {
            let b0 = code[at];
            at += 1;
            match b0 {
                28 => {
                    let value = code
                        .get(at..at + 2)
                        .map_or(0, |bytes| i16::from_be_bytes([bytes[0], bytes[1]]));
                    self.stack.push(f64::from(value));
                    at += 2;
                }
                32..=246 => self.stack.push(f64::from(b0) - 139.0),
                247..=250 => {
                    self.stack.push(
                        (f64::from(b0) - 247.0) * 256.0
                            + f64::from(code.get(at).copied().unwrap_or(0))
                            + 108.0,
                    );
                    at += 1;
                }
                251..=254 => {
                    self.stack.push(
                        -(f64::from(b0) - 251.0) * 256.0
                            - f64::from(code.get(at).copied().unwrap_or(0))
                            - 108.0,
                    );
                    at += 1;
                }
                255 => {
                    let value = code.get(at..at + 4).map_or(0, |bytes| {
                        i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
                    });
                    self.stack.push(f64::from(value) / 65536.0);
                    at += 4;
                }
                1 | 3 | 18 | 23 => {
                    self.stems += self.stack.len() / 2;
                    self.stack.clear();
                }
                19 | 20 => {
                    self.stems += self.stack.len() / 2;
                    self.stack.clear();
                    at += self.stems.div_ceil(8);
                }
                10 | 29 => {
                    let Some(operand) = self.stack.pop() else {
                        continue;
                    };
                    let global = b0 == 29;
                    let count = if global {
                        self.globals.len()
                    } else {
                        self.locals.map_or(0, Index::len)
                    };
                    let number = operand as i64 + bias(count);
                    if number < 0 || number as usize >= count || depth >= MAX_SUBR_DEPTH {
                        continue;
                    }
                    let number = number as usize;
                    let body = if global {
                        self.used_globals.insert(number);
                        self.globals.get(self.data, number)
                    } else {
                        self.used_locals.insert(number);
                        self.locals.and_then(|locals| locals.get(self.data, number))
                    };
                    if let Some(body) = body
                        && self.run(body, depth + 1)
                    {
                        return true;
                    }
                }
                11 => return false,
                14 => {
                    self.stack.clear();
                    return true;
                }
                12 => {
                    let Some(second) = code.get(at).copied() else {
                        return false;
                    };
                    at += 1;
                    self.escape(second);
                }
                _ => self.stack.clear(),
            }
        }
        false
    }

    fn escape(&mut self, op: u8) {
        let stack = &mut self.stack;
        match op {
            3 => binary(stack, |a, b| f64::from(u8::from(a != 0.0 && b != 0.0))),
            4 => binary(stack, |a, b| f64::from(u8::from(a != 0.0 || b != 0.0))),
            5 => {
                if let Some(a) = stack.pop() {
                    stack.push(f64::from(u8::from(a == 0.0)));
                }
            }
            9 | 14 | 26 => {
                if let Some(a) = stack.pop() {
                    stack.push(match op {
                        9 => a.abs(),
                        14 => -a,
                        _ => a.sqrt(),
                    });
                }
            }
            10 => binary(stack, |a, b| a + b),
            11 => binary(stack, |a, b| a - b),
            12 => binary(stack, |a, b| a / b),
            15 => binary(stack, |a, b| f64::from(u8::from(a == b))),
            24 => binary(stack, |a, b| a * b),
            18 => {
                stack.pop();
            }
            20 => {
                if let (Some(index), Some(value)) = (stack.pop(), stack.pop())
                    && let Some(slot) = self.transient.get_mut(index as usize)
                {
                    *slot = value;
                }
            }
            21 => {
                if let Some(index) = stack.pop() {
                    stack.push(self.transient.get(index as usize).copied().unwrap_or(0.0));
                }
            }
            22 => {
                if let (Some(v2), Some(v1), Some(s2), Some(s1)) =
                    (stack.pop(), stack.pop(), stack.pop(), stack.pop())
                {
                    stack.push(if v1 <= v2 { s1 } else { s2 });
                }
            }
            23 => stack.push(0.5),
            27 => {
                if let Some(a) = stack.last().copied() {
                    stack.push(a);
                }
            }
            28 => {
                let length = stack.len();
                if length >= 2 {
                    stack.swap(length - 1, length - 2);
                }
            }
            29 => {
                if let Some(index) = stack.pop() {
                    let length = stack.len();
                    let from = if index < 0.0 {
                        length.checked_sub(1)
                    } else {
                        length.checked_sub(1 + index as usize)
                    };
                    if let Some(from) = from {
                        stack.push(stack[from]);
                    }
                }
            }
            30 => {
                if let (Some(shift), Some(count)) = (stack.pop(), stack.pop()) {
                    let count = count as usize;
                    if count > 0 && count <= stack.len() {
                        let start = stack.len() - count;
                        let window = &mut stack[start..];
                        let by = (shift as i64).rem_euclid(count as i64) as usize;
                        window.rotate_right(by);
                    }
                }
            }
            _ => stack.clear(),
        }
    }
}

// ---- writing ----------------------------------------------------------------------------------------------------------------

/// A DICT integer in the shortest form.
fn int_operand(value: i64) -> Vec<u8> {
    match value {
        -107..=107 => vec![(value + 139) as u8],
        108..=1131 => {
            let v = value - 108;
            vec![(v / 256 + 247) as u8, (v % 256) as u8]
        }
        -1131..=-108 => {
            let v = -value - 108;
            vec![(v / 256 + 251) as u8, (v % 256) as u8]
        }
        -32768..=32767 => vec![28, (value >> 8) as u8, value as u8],
        _ => five_byte(value),
    }
}

/// A DICT integer of five bytes: an offset whose size must not depend on its value.
fn five_byte(value: i64) -> Vec<u8> {
    let bytes = (value as i32).to_be_bytes();
    vec![29, bytes[0], bytes[1], bytes[2], bytes[3]]
}

fn operator(op: u16) -> Vec<u8> {
    if op >= 1200 {
        vec![12, (op - 1200) as u8]
    } else {
        vec![op as u8]
    }
}

fn write_entry(out: &mut Vec<u8>, entry: &Entry) {
    for operand in &entry.operands {
        out.extend_from_slice(&operand.raw);
    }
    out.extend_from_slice(&operator(entry.op));
}

fn write_with(out: &mut Vec<u8>, operands: &[Vec<u8>], op: u16) {
    for operand in operands {
        out.extend_from_slice(operand);
    }
    out.extend_from_slice(&operator(op));
}

/// An INDEX holding `objects`.
fn write_index(objects: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(objects.len() as u16).to_be_bytes());
    if objects.is_empty() {
        return out;
    }
    let total: usize = objects.iter().map(Vec::len).sum::<usize>() + 1;
    let size = match total {
        0..=0xFF => 1,
        0x100..=0xFFFF => 2,
        0x1_0000..=0xFF_FFFF => 3,
        _ => 4,
    };
    out.push(size as u8);
    let mut offset = 1usize;
    let put = |out: &mut Vec<u8>, value: usize| {
        out.extend_from_slice(&(value as u32).to_be_bytes()[4 - size..])
    };
    put(&mut out, offset);
    for object in objects {
        offset += object.len();
        put(&mut out, offset);
    }
    for object in objects {
        out.extend_from_slice(object);
    }
    out
}

/// The String INDEX being built: a SID is the standard-string count plus the position.
#[derive(Default)]
struct Strings(Vec<Vec<u8>>);

impl Strings {
    fn add(&mut self, text: &[u8]) -> u16 {
        self.0.push(text.to_vec());
        STANDARD_STRINGS + (self.0.len() - 1) as u16
    }
}

/// The top-dict operators whose operand is a SID.
fn is_sid_operator(op: u16) -> bool {
    matches!(op, 0..=4 | 1200 | 1221 | 1222)
}

/// The top-dict operators the subset does not copy: it writes its own, or they do not apply to a CID-keyed font.
fn is_dropped_top_operator(op: u16) -> bool {
    matches!(op, 15..=18 | 1220 | 1230..=1238)
}

/// The subset of the CFF table `cff` for `glyphs` (original glyph ids, `.notdef` first).
pub(super) fn subset(cff: &[u8], glyphs: &[u16]) -> Result<Vec<u8>, EmbedError> {
    let header_size = usize::from(*cff.get(2).ok_or_else(damaged)?);
    let names = Index::read(cff, header_size)?;
    let tops = Index::read(cff, names.end)?;
    let strings = Index::read(cff, tops.end)?;
    let globals = Index::read(cff, strings.end)?;
    let top = read_dict(tops.get(cff, 0).ok_or_else(damaged)?)?;
    let char_strings = Index::read(
        cff,
        find(&top, 17)
            .and_then(|entry| entry.operands.first())
            .ok_or_else(damaged)?
            .value as usize,
    )?;
    let cid = find(&top, 1230).is_some();

    // the font dictionaries (a CID-keyed font) or the single Private dictionary, and which glyph uses which
    let mut dicts: Vec<Vec<Entry>> = Vec::new();
    let mut selected: Vec<u8> = Vec::new();
    if cid {
        let array = Index::read(
            cff,
            find(&top, 1236)
                .and_then(|entry| entry.operands.first())
                .ok_or_else(damaged)?
                .value as usize,
        )?;
        for index in 0..array.len() {
            dicts.push(read_dict(array.get(cff, index).ok_or_else(damaged)?)?);
        }
        selected = read_fd_select(
            cff,
            find(&top, 1237)
                .and_then(|entry| entry.operands.first())
                .ok_or_else(damaged)?
                .value as usize,
            char_strings.len(),
        )?;
    } else {
        dicts.push(top.clone());
    }
    let privates: Vec<Option<Private>> = dicts
        .iter()
        .map(|dict| read_private(cff, dict))
        .collect::<Result<_, _>>()?;

    // the subroutines the glyphs call
    let mut used_globals = BTreeSet::new();
    let mut used_locals: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); dicts.len()];
    let mut used_fds: Vec<usize> = Vec::new();
    let mut fd_of_glyph: Vec<usize> = Vec::with_capacity(glyphs.len());
    let mut charstrings: Vec<Vec<u8>> = Vec::with_capacity(glyphs.len());
    for gid in glyphs {
        let code = char_strings.get(cff, usize::from(*gid)).unwrap_or(&[14]);
        let fd = if cid {
            usize::from(selected.get(usize::from(*gid)).copied().unwrap_or(0))
        } else {
            0
        };
        let fd = fd.min(dicts.len().saturating_sub(1));
        if !used_fds.contains(&fd) {
            used_fds.push(fd);
        }
        fd_of_glyph.push(fd);
        let mut scanner = Scanner {
            data: cff,
            globals: &globals,
            locals: privates[fd]
                .as_ref()
                .and_then(|private| private.subrs.as_ref()),
            used_globals: &mut used_globals,
            used_locals: &mut used_locals[fd],
            stack: Vec::new(),
            transient: [0.0; 32],
            stems: 0,
        };
        scanner.run(code, 0);
        charstrings.push(code.to_vec());
    }
    let stubbed = |index: &Index, used: &BTreeSet<usize>| -> Vec<Vec<u8>> {
        (0..index.len())
            .map(|number| {
                if used.contains(&number) {
                    index.get(cff, number).unwrap_or(&[11]).to_vec()
                } else {
                    vec![11]
                }
            })
            .collect()
    };
    let global_subrs = stubbed(&globals, &used_globals);

    // the strings: the ones of the top dictionary that are not standard, then Adobe and Identity
    let mut new_strings = Strings::default();
    let mut top_entries: Vec<Entry> = Vec::new();
    for entry in &top {
        if is_dropped_top_operator(entry.op) {
            continue;
        }
        if is_sid_operator(entry.op) {
            let Some(sid) = entry.operands.first().map(|operand| operand.value as u16) else {
                continue;
            };
            if sid < STANDARD_STRINGS {
                top_entries.push(entry.clone());
            } else if let Some(text) = strings.get(cff, usize::from(sid - STANDARD_STRINGS)) {
                let sid = new_strings.add(text);
                top_entries.push(Entry {
                    op: entry.op,
                    operands: vec![Operand {
                        raw: int_operand(i64::from(sid)),
                        value: f64::from(sid),
                    }],
                });
            }
            continue;
        }
        top_entries.push(entry.clone());
    }
    let adobe = new_strings.add(b"Adobe");
    let identity = new_strings.add(b"Identity");

    // what is written, in file order
    let count = charstrings.len();
    let name_index = write_index(&[names.get(cff, 0).unwrap_or(&[]).to_vec()]);
    let string_index = write_index(&new_strings.0);
    let global_index = write_index(&global_subrs);
    let char_strings_index = write_index(&charstrings);
    let charset = if count < 2 {
        vec![0]
    } else if count <= 256 {
        vec![1, 0, 1, (count - 2) as u8]
    } else {
        let mut bytes = vec![2, 0, 1];
        bytes.extend_from_slice(&((count - 2) as u16).to_be_bytes());
        bytes
    };
    let (fd_select, fd_list): (Vec<u8>, Vec<usize>) = if cid {
        let mut bytes = vec![0u8];
        bytes.extend(
            fd_of_glyph
                .iter()
                .map(|fd| used_fds.iter().position(|used| used == fd).unwrap_or(0) as u8),
        );
        (bytes, used_fds.clone())
    } else {
        let mut bytes = vec![3, 0, 1, 0, 0, 0];
        bytes.extend_from_slice(&(count as u16).to_be_bytes());
        (bytes, vec![0])
    };

    // the Private dictionaries with their local subroutines, one per font dictionary written
    let mut private_blobs: Vec<Option<(Vec<u8>, Vec<u8>)>> = Vec::new();
    for fd in &fd_list {
        let Some(private) = &privates[*fd] else {
            private_blobs.push(None);
            continue;
        };
        let local = private
            .subrs
            .as_ref()
            .filter(|index| index.len() > 0)
            .map(|index| write_index(&stubbed(index, &used_locals[*fd])));
        let mut body = Vec::new();
        for entry in private.entries.iter().filter(|entry| entry.op != 19) {
            write_entry(&mut body, entry);
        }
        if local.is_some() {
            let size = body.len() + 6;
            write_with(&mut body, &[five_byte(size as i64)], 19);
        }
        private_blobs.push(Some((body, local.unwrap_or_default())));
    }

    // sizes first, then the offsets they give
    let top_with = |charset_at: usize,
                    char_strings_at: usize,
                    fd_array_at: usize,
                    fd_select_at: usize|
     -> Vec<u8> {
        let mut dict = Vec::new();
        write_with(
            &mut dict,
            &[
                int_operand(i64::from(adobe)),
                int_operand(i64::from(identity)),
                int_operand(0),
            ],
            1230,
        );
        for entry in &top_entries {
            write_entry(&mut dict, entry);
        }
        write_with(&mut dict, &[int_operand(count as i64)], 1234);
        write_with(&mut dict, &[five_byte(charset_at as i64)], 15);
        write_with(&mut dict, &[five_byte(char_strings_at as i64)], 17);
        write_with(&mut dict, &[five_byte(fd_array_at as i64)], 1236);
        write_with(&mut dict, &[five_byte(fd_select_at as i64)], 1237);
        dict
    };
    let top_index_size = write_index(&[top_with(0, 0, 0, 0)]).len();
    let charset_at =
        4 + name_index.len() + top_index_size + string_index.len() + global_index.len();
    let fd_select_at = charset_at + charset.len();
    let char_strings_at = fd_select_at + fd_select.len();
    let fd_array_at = char_strings_at + char_strings_index.len();
    let fd_dict = |private: Option<(usize, usize)>, entries: &[Entry]| -> Vec<u8> {
        let mut dict = Vec::new();
        for entry in entries
            .iter()
            .filter(|entry| entry.op != 1238 && entry.op != 18)
        {
            write_entry(&mut dict, entry);
        }
        if let Some((size, offset)) = private {
            write_with(
                &mut dict,
                &[five_byte(size as i64), five_byte(offset as i64)],
                18,
            );
        }
        dict
    };
    let placeholder: Vec<Vec<u8>> = fd_list
        .iter()
        .zip(&private_blobs)
        .map(|(fd, blob)| {
            fd_dict(
                blob.as_ref().map(|_| (0, 0)),
                if cid { dicts[*fd].as_slice() } else { &[] },
            )
        })
        .collect();
    let fd_array_size = write_index(&placeholder).len();
    let mut private_at = fd_array_at + fd_array_size;
    let mut fd_dicts: Vec<Vec<u8>> = Vec::new();
    let mut private_bytes: Vec<u8> = Vec::new();
    for (fd, blob) in fd_list.iter().zip(&private_blobs) {
        let place = blob.as_ref().map(|(body, local)| {
            let at = private_at;
            private_at += body.len() + local.len();
            private_bytes.extend_from_slice(body);
            private_bytes.extend_from_slice(local);
            (body.len(), at)
        });
        fd_dicts.push(fd_dict(
            place,
            if cid { dicts[*fd].as_slice() } else { &[] },
        ));
    }

    let mut out = vec![1, 0, 4, 4];
    out.extend_from_slice(&name_index);
    out.extend_from_slice(&write_index(&[top_with(
        charset_at,
        char_strings_at,
        fd_array_at,
        fd_select_at,
    )]));
    out.extend_from_slice(&string_index);
    out.extend_from_slice(&global_index);
    out.extend_from_slice(&charset);
    out.extend_from_slice(&fd_select);
    out.extend_from_slice(&char_strings_index);
    out.extend_from_slice(&write_index(&fd_dicts));
    out.extend_from_slice(&private_bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_round_trip() {
        let objects = vec![vec![1, 2, 3], vec![], vec![9]];
        let bytes = write_index(&objects);
        let index = Index::read(&bytes, 0).unwrap();
        assert_eq!(index.len(), 3);
        assert_eq!(index.end, bytes.len());
        assert_eq!(index.get(&bytes, 0), Some(&[1u8, 2, 3][..]));
        assert_eq!(index.get(&bytes, 1), Some(&[][..]));
        assert_eq!(write_index(&[]), vec![0, 0]);
    }

    #[test]
    fn dict_numbers_keep_their_bytes_and_values() {
        let mut dict = Vec::new();
        write_with(
            &mut dict,
            &[
                int_operand(-5),
                int_operand(500),
                int_operand(-500),
                int_operand(20000),
                five_byte(70000),
            ],
            1236,
        );
        let entries = read_dict(&dict).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].op, 1236);
        let values: Vec<f64> = entries[0]
            .operands
            .iter()
            .map(|operand| operand.value)
            .collect();
        assert_eq!(values, vec![-5.0, 500.0, -500.0, 20000.0, 70000.0]);
        assert_eq!(entries[0].operands[0].raw.len(), 1);
        assert_eq!(entries[0].operands[4].raw.len(), 5);
    }

    #[test]
    fn real_numbers_are_read_from_nibbles() {
        // 0.25 = nibbles 0 a 2 5, then the end nibble
        let entries = read_dict(&[30, 0x0A, 0x25, 0xFF, 7]).unwrap();
        assert_eq!(entries[0].operands[0].value, 0.25);
        assert_eq!(entries[0].operands[0].raw, vec![30, 0x0A, 0x25, 0xFF]);
    }

    #[test]
    fn the_scanner_marks_called_subroutines_through_nested_calls() {
        // global subrs: [0] calls [1]; local subrs: [0] unused. The charstring calls global 0 (operand -107 + bias 107).
        let global_a: Vec<u8> = vec![139 - 106, 29, 11]; // pushes -106 + ... : operand 33 - 139 = -106 -> index 1
        let global_b: Vec<u8> = vec![11];
        let globals_bytes = write_index(&[global_a, global_b]);
        let globals = Index::read(&globals_bytes, 0).unwrap();
        let mut used_globals = BTreeSet::new();
        let mut used_locals = BTreeSet::new();
        let mut scanner = Scanner {
            data: &globals_bytes,
            globals: &globals,
            locals: None,
            used_globals: &mut used_globals,
            used_locals: &mut used_locals,
            stack: Vec::new(),
            transient: [0.0; 32],
            stems: 0,
        };
        // 32 pushes -107: global 0; the body pushes -106: global 1
        assert!(scanner.run(&[32, 29, 14], 0));
        assert_eq!(used_globals.into_iter().collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn hintmask_skips_its_mask_bytes() {
        let globals_bytes = write_index(&[]);
        let globals = Index::read(&globals_bytes, 0).unwrap();
        let (mut used_globals, mut used_locals) = (BTreeSet::new(), BTreeSet::new());
        let mut scanner = Scanner {
            data: &globals_bytes,
            globals: &globals,
            locals: None,
            used_globals: &mut used_globals,
            used_locals: &mut used_locals,
            stack: Vec::new(),
            transient: [0.0; 32],
            stems: 0,
        };
        // two stems (four numbers, hstemhm), hintmask with a mask byte 0x1d that looks like callgsubr, then endchar
        assert!(scanner.run(&[140, 141, 142, 143, 18, 19, 29, 14], 0));
        assert!(used_globals.is_empty());
    }
}
