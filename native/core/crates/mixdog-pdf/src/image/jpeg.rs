//! The JPEG decoder of `DCTDecode` images: pdf.js 6.4.299's own `JpegImage` (`jpg.js`), which the Node configurations
//! run (there is no `ImageDecoder`). Baseline, extended and progressive Huffman JPEGs of 1 to 4 components, its
//! integer inverse DCT (so a result is what pdf.js gives, not what libjpeg gives), nearest-neighbour upsampling and
//! scaling in `getData`, and the colour conversions of Adobe APP14 (`YCbCr` to RGB, `YCCK` to CMYK, CMYK to RGB).
//!
//! Typed-array behaviour is kept where a damaged file reaches it: block data are 16-bit and wrap, a write past the
//! end of a block buffer is dropped, a read past the end of the data is 0, and every output byte is stored as a
//! `Uint8ClampedArray` stores it (rounded half to even, clamped).

use std::collections::HashMap;
use std::sync::Arc;

use crate::color::{ColorSpace, to_u8_clamped};
use crate::error::{PdfError, Result};

const ZIGZAG: [u8; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const COS1: i64 = 4017;
const SIN1: i64 = 799;
const COS3: i64 = 3406;
const SIN3: i64 = 2276;
const COS6: i64 = 1567;
const SIN6: i64 = 3784;
const SQRT2: i64 = 5793;
const SQRT1D2: i64 = 2896;
/// Most 16-bit samples one component's block buffer may hold (a larger frame is a `RangeError` in pdf.js's typed array).
const MAX_BLOCK_SAMPLES: f64 = 1_073_741_824.0;

/// What stops a parse: a failure, or one of the two markers pdf.js's `decodeScan` reports by exception.
enum Stop {
    Failed(String),
    /// `DNLMarkerError`: the scan line count the DNL marker (or the EOI position) suggests.
    Dnl(u32),
    /// `EOIMarkerError`.
    Eoi,
}

type Step<T> = std::result::Result<T, Stop>;

fn fail<T>(message: &str) -> Step<T> {
    Err(Stop::Failed(message.to_owned()))
}

fn jpeg_error(message: &str) -> PdfError {
    PdfError::Format(message.to_owned())
}

/// `data[at]`: past the end is `undefined`, which every use here reads as 0.
fn byte(data: &[u8], at: usize) -> u32 {
    data.get(at).map_or(0, |b| u32::from(*b))
}

/// `view.getUint16(at)`: past the end is a `RangeError`.
fn u16_at(data: &[u8], at: usize) -> Step<u32> {
    match (data.get(at), data.get(at + 1)) {
        (Some(a), Some(b)) => Ok(u32::from(*a) << 8 | u32::from(*b)),
        _ => fail("Offset is outside the bounds of the DataView"),
    }
}

/// `x >> n` of a JavaScript number: converted to 32 bits first.
fn sh(x: i64, n: u32) -> i64 {
    i64::from((x as i32) >> n)
}

// ---- Huffman tables ------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Child {
    Value(u8),
    Node(usize),
}

/// `buildHuffmanTable`: the binary tree as an arena; node 0 is the root.
struct Huffman {
    nodes: Vec<Vec<Option<Child>>>,
}

struct Cell {
    node: usize,
    index: usize,
}

fn build_huffman(code_lengths: &[u8; 16], values: &[u8]) -> Step<Huffman> {
    let mut nodes: Vec<Vec<Option<Child>>> = vec![Vec::new()];
    fn put(nodes: &mut [Vec<Option<Child>>], node: usize, index: usize, child: Child) {
        let slot = &mut nodes[node];
        if slot.len() <= index {
            slot.resize(index + 1, None);
        }
        slot[index] = Some(child);
    }
    let mut length = 16usize;
    while length > 0 && code_lengths[length - 1] == 0 {
        length -= 1;
    }
    let mut code: Vec<Cell> = vec![Cell { node: 0, index: 0 }];
    let mut p = Cell { node: 0, index: 0 };
    let mut k = 0usize;
    let empty = || fail::<Huffman>("Cannot read properties of undefined");
    for i in 0..length {
        for _ in 0..code_lengths[i] {
            p = match code.pop() {
                Some(cell) => cell,
                None => return empty(),
            };
            put(
                &mut nodes,
                p.node,
                p.index,
                Child::Value(values.get(k).copied().unwrap_or(0)),
            );
            while p.index > 0 {
                p = match code.pop() {
                    Some(cell) => cell,
                    None => return empty(),
                };
            }
            p.index += 1;
            code.push(Cell {
                node: p.node,
                index: p.index,
            });
            while code.len() <= i {
                nodes.push(Vec::new());
                let q = nodes.len() - 1;
                code.push(Cell { node: q, index: 0 });
                put(&mut nodes, p.node, p.index, Child::Node(q));
                p = Cell { node: q, index: 0 };
            }
            k += 1;
        }
        if i + 1 < length {
            nodes.push(Vec::new());
            let q = nodes.len() - 1;
            code.push(Cell { node: q, index: 0 });
            put(&mut nodes, p.node, p.index, Child::Node(q));
            p = Cell { node: q, index: 0 };
        }
    }
    Ok(Huffman { nodes })
}

// ---- frame and components ------------------------------------------------------------------------------------------

struct Component {
    h: u32,
    v: u32,
    quantization_id: u32,
    quantization_table: Option<Arc<[u16; 64]>>,
    index: Option<u32>,
    block_data: Vec<i16>,
    blocks_per_line: usize,
    blocks_per_column: usize,
    pred: i64,
    huffman_dc: Option<Arc<Huffman>>,
    huffman_ac: Option<Arc<Huffman>>,
}

struct Frame {
    progressive: bool,
    precision: u32,
    scan_lines: u32,
    samples_per_line: u32,
    components: Vec<Component>,
    component_ids: HashMap<u32, usize>,
    mcus_per_line: usize,
    mcus_per_column: usize,
}

fn block_offset(component: &Component, row: usize, col: usize) -> usize {
    64 * ((component.blocks_per_line + 1) * row + col)
}

fn prepare_components(frame: &mut Frame, max_h: u32, max_v: u32) -> Step<()> {
    let samples = f64::from(frame.samples_per_line);
    let lines = f64::from(frame.scan_lines);
    let mcus_per_line = (samples / 8.0 / f64::from(max_h)).ceil();
    let mcus_per_column = (lines / 8.0 / f64::from(max_v)).ceil();
    for component in &mut frame.components {
        let blocks_per_line =
            ((samples / 8.0).ceil() * f64::from(component.h) / f64::from(max_h)).ceil();
        let blocks_per_column =
            ((lines / 8.0).ceil() * f64::from(component.v) / f64::from(max_v)).ceil();
        let for_mcu_line = mcus_per_line * f64::from(component.h);
        let for_mcu_column = mcus_per_column * f64::from(component.v);
        let size = 64.0 * for_mcu_column * (for_mcu_line + 1.0);
        if !size.is_finite()
            || size > MAX_BLOCK_SAMPLES
            || !blocks_per_line.is_finite()
            || !blocks_per_column.is_finite()
        {
            return fail("Invalid typed array length");
        }
        component.block_data = vec![0i16; size as usize];
        component.blocks_per_line = blocks_per_line as usize;
        component.blocks_per_column = blocks_per_column as usize;
    }
    if !mcus_per_line.is_finite() || !mcus_per_column.is_finite() {
        return fail("Invalid typed array length");
    }
    frame.mcus_per_line = mcus_per_line as usize;
    frame.mcus_per_column = mcus_per_column as usize;
    Ok(())
}

// ---- markers -------------------------------------------------------------------------------------------------------

struct FileMarker {
    /// The first two bytes where a marker was expected, when those were not one (`invalid`).
    invalid: Option<u32>,
    marker: u32,
    offset: usize,
}

fn is_marker(m: u32) -> bool {
    (0xffc0..=0xfffe).contains(&m)
}

/// `findNextFileMarker`.
fn find_next_file_marker(
    data: &[u8],
    current_pos: usize,
    start_pos: isize,
) -> Step<Option<FileMarker>> {
    let max_pos = data.len() as isize - 1;
    let mut new_pos = if start_pos < current_pos as isize {
        start_pos
    } else {
        current_pos as isize
    };
    if current_pos as isize >= max_pos {
        return Ok(None);
    }
    let current_marker = u16_at(data, current_pos)?;
    if is_marker(current_marker) {
        return Ok(Some(FileMarker {
            invalid: None,
            marker: current_marker,
            offset: current_pos,
        }));
    }
    if new_pos < 0 {
        return fail("Offset is outside the bounds of the DataView");
    }
    let mut new_marker = u16_at(data, new_pos as usize)?;
    while !is_marker(new_marker) {
        new_pos += 1;
        if new_pos >= max_pos {
            return Ok(None);
        }
        new_marker = u16_at(data, new_pos as usize)?;
    }
    Ok(Some(FileMarker {
        invalid: Some(current_marker),
        marker: new_marker,
        offset: new_pos as usize,
    }))
}

/// `readDataBlock`: the application data as `(start, end)` of the data; the new offset is `end`.
fn read_data_block(data: &[u8], offset: usize) -> Step<(usize, usize)> {
    let length = u16_at(data, offset)? as isize;
    let start = offset + 2;
    let mut end = (start as isize + length - 2) as usize;
    if let Some(marker) = find_next_file_marker(data, end, start as isize)?
        && let Some(invalid) = marker.invalid
    {
        tracing::warn!("readDataBlock - incorrect length, current marker is: {invalid:x}");
        end = marker.offset;
    }
    let start = start.min(data.len());
    let end = end.min(data.len()).max(start);
    Ok((start, end))
}

// ---- scan decoding -------------------------------------------------------------------------------------------------

/// The state of one `decodeScan`.
struct Scan<'a> {
    data: &'a [u8],
    offset: usize,
    bits_data: u32,
    bits_count: u32,
    eobrun: i64,
    ac_state: u32,
    ac_next_value: i64,
    block_row: usize,
    parse_dnl: bool,
    scan_lines: u32,
    precision: u32,
    spectral_start: usize,
    spectral_end: usize,
    successive: u32,
}

/// `a << n` as JavaScript computes it.
fn shl(a: i64, n: u32) -> i64 {
    i64::from((a as i32).wrapping_shl(n))
}

impl Scan<'_> {
    fn read_bit(&mut self) -> Step<u32> {
        if self.bits_count > 0 {
            self.bits_count -= 1;
            return Ok(self.bits_data >> self.bits_count & 1);
        }
        self.bits_data = byte(self.data, self.offset);
        self.offset += 1;
        if self.bits_data == 0xff {
            let next = byte(self.data, self.offset);
            self.offset += 1;
            if next != 0 {
                if next == 0xdc && self.parse_dnl {
                    self.offset += 2;
                    let scan_lines = u16_at(self.data, self.offset)?;
                    self.offset += 2;
                    if scan_lines > 0 && scan_lines != self.scan_lines {
                        return Err(Stop::Dnl(scan_lines));
                    }
                } else if next == 0xd9 {
                    if self.parse_dnl {
                        let maybe =
                            self.block_row as f64 * if self.precision == 8 { 8.0 } else { 0.0 };
                        if maybe > 0.0 && (f64::from(self.scan_lines) / maybe).round() >= 5.0 {
                            return Err(Stop::Dnl(maybe as u32));
                        }
                    }
                    return Err(Stop::Eoi);
                }
                return Err(Stop::Failed(format!(
                    "unexpected marker {:x}",
                    self.bits_data << 8 | next
                )));
            }
        }
        self.bits_count = 7;
        Ok(self.bits_data >> 7)
    }

    fn decode_huffman(&mut self, tree: &Option<Arc<Huffman>>) -> Step<u32> {
        let Some(tree) = tree else {
            return fail("Cannot read properties of undefined");
        };
        let mut node = 0usize;
        loop {
            let bit = self.read_bit()? as usize;
            match tree.nodes[node].get(bit).copied().flatten() {
                Some(Child::Value(v)) => return Ok(u32::from(v)),
                Some(Child::Node(next)) => node = next,
                None => return fail("invalid huffman sequence"),
            }
        }
    }

    fn receive(&mut self, length: u32) -> Step<i64> {
        let mut n: i32 = 0;
        for _ in 0..length {
            n = n.wrapping_shl(1) | self.read_bit()? as i32;
        }
        Ok(i64::from(n))
    }

    fn receive_and_extend(&mut self, length: u32) -> Step<i64> {
        if length == 1 {
            return Ok(if self.read_bit()? == 1 { 1 } else { -1 });
        }
        let n = self.receive(length)?;
        let threshold = i64::from(1i32.wrapping_shl(length.wrapping_sub(1)));
        Ok(if n >= threshold {
            n
        } else {
            n + i64::from((-1i32).wrapping_shl(length)) + 1
        })
    }

    fn decode_baseline(&mut self, c: &mut Component, off: Option<usize>) -> Step<()> {
        let t = self.decode_huffman(&c.huffman_dc)?;
        let diff = if t == 0 {
            0
        } else {
            self.receive_and_extend(t)?
        };
        c.pred += diff;
        store(&mut c.block_data, off, c.pred);
        let mut k = 1usize;
        while k < 64 {
            let rs = self.decode_huffman(&c.huffman_ac)?;
            let s = rs & 15;
            let r = (rs >> 4) as usize;
            if s == 0 {
                if r < 15 {
                    break;
                }
                k += 16;
                continue;
            }
            k += r;
            let value = self.receive_and_extend(s)?;
            if let Some(z) = ZIGZAG.get(k) {
                store(&mut c.block_data, off.map(|o| o + *z as usize), value);
            }
            k += 1;
        }
        Ok(())
    }

    fn decode_dc_first(&mut self, c: &mut Component, off: Option<usize>) -> Step<()> {
        let t = self.decode_huffman(&c.huffman_dc)?;
        let diff = if t == 0 {
            0
        } else {
            shl(self.receive_and_extend(t)?, self.successive)
        };
        c.pred += diff;
        store(&mut c.block_data, off, c.pred);
        Ok(())
    }

    fn decode_dc_successive(&mut self, c: &mut Component, off: Option<usize>) -> Step<()> {
        let bit = i64::from(self.read_bit()? as i32);
        let current = load(&c.block_data, off);
        store(
            &mut c.block_data,
            off,
            i64::from((current as i32) | (shl(bit, self.successive) as i32)),
        );
        Ok(())
    }

    fn decode_ac_first(&mut self, c: &mut Component, off: Option<usize>) -> Step<()> {
        if self.eobrun > 0 {
            self.eobrun -= 1;
            return Ok(());
        }
        let mut k = self.spectral_start;
        let e = self.spectral_end;
        while k <= e {
            let rs = self.decode_huffman(&c.huffman_ac)?;
            let s = rs & 15;
            let r = rs >> 4;
            if s == 0 {
                if r < 15 {
                    self.eobrun = self.receive(r)? + i64::from(1i32.wrapping_shl(r)) - 1;
                    break;
                }
                k += 16;
                continue;
            }
            k += r as usize;
            let value = self.receive_and_extend(s)? * i64::from(1i32.wrapping_shl(self.successive));
            if let Some(z) = ZIGZAG.get(k) {
                store(&mut c.block_data, off.map(|o| o + *z as usize), value);
            }
            k += 1;
        }
        Ok(())
    }

    fn decode_ac_successive(&mut self, c: &mut Component, off: Option<usize>) -> Step<()> {
        let mut k = self.spectral_start;
        let e = self.spectral_end;
        let mut r: i64 = 0;
        while k <= e {
            let offset_z = ZIGZAG.get(k).and_then(|z| off.map(|o| o + *z as usize));
            let current = load(&c.block_data, offset_z);
            let sign: i64 = if current < 0 { -1 } else { 1 };
            let successive_bit = |scan: &mut Self| -> Step<i64> {
                let bit = i64::from(scan.read_bit()? as i32);
                Ok(shl(bit, scan.successive))
            };
            match self.ac_state {
                0 => {
                    let rs = self.decode_huffman(&c.huffman_ac)?;
                    let s = rs & 15;
                    r = i64::from(rs >> 4);
                    if s == 0 {
                        if r < 15 {
                            self.eobrun =
                                self.receive(r as u32)? + i64::from(1i32.wrapping_shl(r as u32));
                            self.ac_state = 4;
                        } else {
                            r = 16;
                            self.ac_state = 1;
                        }
                    } else {
                        if s != 1 {
                            return fail("invalid ACn encoding");
                        }
                        self.ac_next_value = self.receive_and_extend(s)?;
                        self.ac_state = if r != 0 { 2 } else { 3 };
                    }
                    continue;
                }
                1 | 2 => {
                    if current != 0 {
                        let add = sign * successive_bit(self)?;
                        store(&mut c.block_data, offset_z, current + add);
                    } else {
                        r -= 1;
                        if r == 0 {
                            self.ac_state = if self.ac_state == 2 { 3 } else { 0 };
                        }
                    }
                }
                3 => {
                    if current != 0 {
                        let add = sign * successive_bit(self)?;
                        store(&mut c.block_data, offset_z, current + add);
                    } else {
                        store(
                            &mut c.block_data,
                            offset_z,
                            shl(self.ac_next_value, self.successive),
                        );
                        self.ac_state = 0;
                    }
                }
                _ => {
                    if current != 0 {
                        let add = sign * successive_bit(self)?;
                        store(&mut c.block_data, offset_z, current + add);
                    }
                }
            }
            k += 1;
        }
        if self.ac_state == 4 {
            self.eobrun -= 1;
            if self.eobrun == 0 {
                self.ac_state = 0;
            }
        }
        Ok(())
    }
}

fn load(block_data: &[i16], at: Option<usize>) -> i64 {
    at.and_then(|i| block_data.get(i))
        .map_or(0, |v| i64::from(*v))
}

/// A typed-array store: 16 bits wrap, a write past the end is dropped.
fn store(block_data: &mut [i16], at: Option<usize>, value: i64) {
    if let Some(slot) = at.and_then(|i| block_data.get_mut(i)) {
        *slot = value as i16;
    }
}

#[derive(Clone, Copy)]
enum Mode {
    Baseline,
    DcFirst,
    DcSuccessive,
    AcFirst,
    AcSuccessive,
}

/// `decodeScan`: returns the number of bytes consumed.
#[allow(clippy::too_many_arguments)]
fn decode_scan(
    data: &[u8],
    start: usize,
    frame: &mut Frame,
    selected: &[usize],
    reset_interval: Option<u32>,
    spectral: (usize, usize),
    successive_prev: u32,
    successive: u32,
    parse_dnl: bool,
) -> Step<usize> {
    let mut scan = Scan {
        data,
        offset: start,
        bits_data: 0,
        bits_count: 0,
        eobrun: 0,
        ac_state: 0,
        ac_next_value: 0,
        block_row: 0,
        parse_dnl,
        scan_lines: frame.scan_lines,
        precision: frame.precision,
        spectral_start: spectral.0,
        spectral_end: spectral.1,
        successive,
    };
    let mode = if frame.progressive {
        if spectral.0 == 0 {
            if successive_prev == 0 {
                Mode::DcFirst
            } else {
                Mode::DcSuccessive
            }
        } else if successive_prev == 0 {
            Mode::AcFirst
        } else {
            Mode::AcSuccessive
        }
    } else {
        Mode::Baseline
    };
    let mcus_per_line = frame.mcus_per_line;
    let mcu_expected = if selected.len() == 1 {
        let c = &frame.components[selected[0]];
        c.blocks_per_line * c.blocks_per_column
    } else {
        mcus_per_line * frame.mcus_per_column
    };
    let mut mcu = 0usize;
    while mcu <= mcu_expected {
        let to_read = match reset_interval {
            Some(interval) if interval > 0 => {
                (mcu_expected - mcu.min(mcu_expected)).min(interval as usize)
            }
            _ => mcu_expected,
        };
        if to_read > 0 {
            for &ci in selected {
                frame.components[ci].pred = 0;
            }
            scan.eobrun = 0;
            if selected.len() == 1 {
                let c = &mut frame.components[selected[0]];
                for _ in 0..to_read {
                    let bpl = c.blocks_per_line;
                    scan.block_row = if bpl == 0 { 0 } else { mcu / bpl };
                    let off = if bpl == 0 {
                        None
                    } else {
                        Some(block_offset(c, scan.block_row, mcu % bpl))
                    };
                    scan.run(mode, c, off)?;
                    mcu += 1;
                }
            } else {
                for _ in 0..to_read {
                    for &ci in selected {
                        let c = &mut frame.components[ci];
                        let (h, v) = (c.h as usize, c.v as usize);
                        for j in 0..v {
                            for k in 0..h {
                                let (mcu_row, mcu_col) = if mcus_per_line == 0 {
                                    (0, None)
                                } else {
                                    (mcu / mcus_per_line, Some(mcu % mcus_per_line))
                                };
                                scan.block_row = mcu_row * v + j;
                                let off =
                                    mcu_col.map(|col| block_offset(c, scan.block_row, col * h + k));
                                scan.run(mode, c, off)?;
                            }
                        }
                    }
                    mcu += 1;
                }
            }
        }
        scan.bits_count = 0;
        let Some(marker) = find_next_file_marker(data, scan.offset, scan.offset as isize)? else {
            break;
        };
        if let Some(invalid) = marker.invalid {
            let partial = if to_read > 0 {
                "unexpected"
            } else {
                "excessive"
            };
            tracing::warn!("decodeScan - {partial} MCU data, current marker is: {invalid:x}");
            scan.offset = marker.offset;
        }
        if (0xffd0..=0xffd7).contains(&marker.marker) {
            scan.offset += 2;
        } else {
            break;
        }
    }
    Ok(scan.offset - start)
}

impl Scan<'_> {
    fn run(&mut self, mode: Mode, c: &mut Component, off: Option<usize>) -> Step<()> {
        match mode {
            Mode::Baseline => self.decode_baseline(c, off),
            Mode::DcFirst => self.decode_dc_first(c, off),
            Mode::DcSuccessive => self.decode_dc_successive(c, off),
            Mode::AcFirst => self.decode_ac_first(c, off),
            Mode::AcSuccessive => self.decode_ac_successive(c, off),
        }
    }
}

// ---- inverse DCT ---------------------------------------------------------------------------------------------------

/// `quantizeAndInverse`: dequantises and transforms the block at `at` in place; `p` is the 16-bit scratch.
fn quantize_and_inverse(component: &mut Component, at: usize, p: &mut [i16; 64]) -> Step<()> {
    let Some(qt) = component.quantization_table.clone() else {
        return fail("missing required Quantization Table.");
    };
    let block = &mut component.block_data;
    if at + 64 > block.len() {
        return fail("Cannot read properties of undefined");
    }
    let q = |i: usize| i64::from(qt[i]);
    for row in (0..64).step_by(8) {
        let b = |i: usize| i64::from(block[at + row + i]);
        let mut p0 = b(0);
        let (mut p1, mut p2, mut p3, mut p4, mut p5, mut p6, mut p7) =
            (b(1), b(2), b(3), b(4), b(5), b(6), b(7));
        p0 *= q(row);
        if (p1 | p2 | p3 | p4 | p5 | p6 | p7) == 0 {
            let t = sh(SQRT2 * p0 + 512, 10);
            for i in 0..8 {
                p[row + i] = t as i16;
            }
            continue;
        }
        p1 *= q(row + 1);
        p2 *= q(row + 2);
        p3 *= q(row + 3);
        p4 *= q(row + 4);
        p5 *= q(row + 5);
        p6 *= q(row + 6);
        p7 *= q(row + 7);
        let mut v0 = sh(SQRT2 * p0 + 128, 8);
        let mut v1 = sh(SQRT2 * p4 + 128, 8);
        let mut v2 = p2;
        let mut v3 = p6;
        let mut v4 = sh(SQRT1D2 * (p1 - p7) + 128, 8);
        let mut v7 = sh(SQRT1D2 * (p1 + p7) + 128, 8);
        let mut v5 = shl(p3, 4);
        let mut v6 = shl(p5, 4);
        v0 = sh(v0 + v1 + 1, 1);
        v1 = v0 - v1;
        let mut t = sh(v2 * SIN6 + v3 * COS6 + 128, 8);
        v2 = sh(v2 * COS6 - v3 * SIN6 + 128, 8);
        v3 = t;
        v4 = sh(v4 + v6 + 1, 1);
        v6 = v4 - v6;
        v7 = sh(v7 + v5 + 1, 1);
        v5 = v7 - v5;
        v0 = sh(v0 + v3 + 1, 1);
        v3 = v0 - v3;
        v1 = sh(v1 + v2 + 1, 1);
        v2 = v1 - v2;
        t = sh(v4 * SIN3 + v7 * COS3 + 2048, 12);
        v4 = sh(v4 * COS3 - v7 * SIN3 + 2048, 12);
        v7 = t;
        t = sh(v5 * SIN1 + v6 * COS1 + 2048, 12);
        v5 = sh(v5 * COS1 - v6 * SIN1 + 2048, 12);
        v6 = t;
        p[row] = (v0 + v7) as i16;
        p[row + 7] = (v0 - v7) as i16;
        p[row + 1] = (v1 + v6) as i16;
        p[row + 6] = (v1 - v6) as i16;
        p[row + 2] = (v2 + v5) as i16;
        p[row + 5] = (v2 - v5) as i16;
        p[row + 3] = (v3 + v4) as i16;
        p[row + 4] = (v3 - v4) as i16;
    }
    for col in 0..8 {
        let pv = |i: usize| i64::from(p[col + 8 * i]);
        let p0 = pv(0);
        let (p1, p2, p3, p4, p5, p6, p7) = (pv(1), pv(2), pv(3), pv(4), pv(5), pv(6), pv(7));
        if (p1 | p2 | p3 | p4 | p5 | p6 | p7) == 0 {
            let mut t = sh(SQRT2 * p0 + 8192, 14);
            if t < -2040 {
                t = 0;
            } else if t >= 2024 {
                t = 255;
            } else {
                t = sh(t + 2056, 4);
            }
            for i in 0..8 {
                block[at + col + 8 * i] = t as i16;
            }
            continue;
        }
        let mut v0 = sh(SQRT2 * p0 + 2048, 12);
        let mut v1 = sh(SQRT2 * p4 + 2048, 12);
        let mut v2 = p2;
        let mut v3 = p6;
        let mut v4 = sh(SQRT1D2 * (p1 - p7) + 2048, 12);
        let mut v7 = sh(SQRT1D2 * (p1 + p7) + 2048, 12);
        let mut v5 = p3;
        let mut v6 = p5;
        v0 = sh(v0 + v1 + 1, 1) + 4112;
        v1 = v0 - v1;
        let mut t = sh(v2 * SIN6 + v3 * COS6 + 2048, 12);
        v2 = sh(v2 * COS6 - v3 * SIN6 + 2048, 12);
        v3 = t;
        v4 = sh(v4 + v6 + 1, 1);
        v6 = v4 - v6;
        v7 = sh(v7 + v5 + 1, 1);
        v5 = v7 - v5;
        v0 = sh(v0 + v3 + 1, 1);
        v3 = v0 - v3;
        v1 = sh(v1 + v2 + 1, 1);
        v2 = v1 - v2;
        t = sh(v4 * SIN3 + v7 * COS3 + 2048, 12);
        v4 = sh(v4 * COS3 - v7 * SIN3 + 2048, 12);
        v7 = t;
        t = sh(v5 * SIN1 + v6 * COS1 + 2048, 12);
        v5 = sh(v5 * COS1 - v6 * SIN1 + 2048, 12);
        v6 = t;
        let out = [
            v0 + v7,
            v1 + v6,
            v2 + v5,
            v3 + v4,
            v3 - v4,
            v2 - v5,
            v1 - v6,
            v0 - v7,
        ];
        for (i, value) in out.iter().enumerate() {
            let x = *value;
            let y = if x < 16 {
                0
            } else if x >= 4080 {
                255
            } else {
                sh(x, 4)
            };
            block[at + col + 8 * i] = y as i16;
        }
    }
    Ok(())
}

fn build_component_data(component: &mut Component) -> Step<()> {
    let mut p = [0i16; 64];
    for row in 0..component.blocks_per_column {
        for col in 0..component.blocks_per_line {
            let at = block_offset(component, row, col);
            quantize_and_inverse(component, at, &mut p)?;
        }
    }
    Ok(())
}

// ---- the image -----------------------------------------------------------------------------------------------------

struct Output {
    index: Option<u32>,
    output: Vec<i16>,
    scale_x: f64,
    scale_y: f64,
    blocks_per_line: usize,
}

/// A parsed JPEG, ready for [`JpegImage::get_data`].
pub struct JpegImage {
    width: u32,
    height: u32,
    adobe_transform: Option<u32>,
    components: Vec<Output>,
    color_transform: i64,
}

impl JpegImage {
    /// `new JpegImage({ colorTransform })` and `parse(data)`; `color_transform` is the `ColorTransform` entry of the
    /// filter's parameters (an integer) or `None`.
    pub fn parse(data: &[u8], color_transform: Option<i64>) -> Result<JpegImage> {
        let mut dnl = None;
        loop {
            match Self::parse_once(data, dnl, color_transform.unwrap_or(-1)) {
                Ok(image) => return Ok(image),
                Err(Stop::Failed(message)) => return Err(jpeg_error(&message)),
                Err(Stop::Eoi) => {
                    return Err(jpeg_error(
                        "Found EOI marker (0xFFD9) while parsing scan data",
                    ));
                }
                Err(Stop::Dnl(lines)) => {
                    tracing::warn!(
                        "Found DNL marker (0xFFDC) while parsing scan data -- attempting to re-parse the JPEG image."
                    );
                    dnl = Some(lines);
                }
            }
        }
    }

    fn parse_once(
        data: &[u8],
        dnl_scan_lines: Option<u32>,
        color_transform: i64,
    ) -> Step<JpegImage> {
        let max_offset = data.len() as isize - 1;
        let mut adobe_transform: Option<u32> = None;
        let mut frame: Option<Frame> = None;
        let mut reset_interval: Option<u32> = None;
        let mut num_sos = 0u32;
        let mut quantization_tables: Vec<Option<Arc<[u16; 64]>>> = vec![None; 16];
        let mut huffman_ac: Vec<Option<Arc<Huffman>>> = vec![None; 16];
        let mut huffman_dc: Vec<Option<Arc<Huffman>>> = vec![None; 16];
        let mut offset = 0usize;
        let mut file_marker = u16_at(data, offset)?;
        offset += 2;
        if file_marker != 0xffd8 {
            return fail("SOI not found");
        }
        file_marker = u16_at(data, offset)?;
        offset += 2;
        'markers: while file_marker != 0xffd9 {
            match file_marker {
                0xffe0..=0xffef | 0xfffe => {
                    let (start, end) = read_data_block(data, offset)?;
                    offset = end;
                    let app = &data[start..end];
                    let at = |i: usize| app.get(i).map_or(0, |b| u32::from(*b));
                    if file_marker == 0xffee && app.len() >= 5 && app[..5] == *b"Adobe" {
                        adobe_transform = Some(at(11));
                    }
                }
                0xffdb => {
                    let length = u16_at(data, offset)? as usize;
                    offset += 2;
                    let end = length + offset - 2;
                    while offset < end {
                        let spec = byte(data, offset);
                        offset += 1;
                        let mut table = [0u16; 64];
                        match spec >> 4 {
                            0 => {
                                for j in 0..64 {
                                    table[ZIGZAG[j] as usize] = byte(data, offset) as u16;
                                    offset += 1;
                                }
                            }
                            1 => {
                                for j in 0..64 {
                                    table[ZIGZAG[j] as usize] = u16_at(data, offset)? as u16;
                                    offset += 2;
                                }
                            }
                            _ => return fail("DQT - invalid table spec"),
                        }
                        quantization_tables[(spec & 15) as usize] = Some(Arc::new(table));
                    }
                }
                0xffc0..=0xffc2 => {
                    if frame.is_some() {
                        return fail("Only single frame JPEGs supported");
                    }
                    offset += 2;
                    let precision = byte(data, offset);
                    offset += 1;
                    let sof_scan_lines = u16_at(data, offset)?;
                    offset += 2;
                    let scan_lines = match dnl_scan_lines {
                        Some(lines) if lines != 0 => lines,
                        _ => sof_scan_lines,
                    };
                    let samples_per_line = u16_at(data, offset)?;
                    offset += 2;
                    let count = byte(data, offset);
                    offset += 1;
                    let mut components = Vec::new();
                    let mut ids = HashMap::new();
                    let (mut max_h, mut max_v) = (0u32, 0u32);
                    for _ in 0..count {
                        let id = byte(data, offset);
                        let h = byte(data, offset + 1) >> 4;
                        let v = byte(data, offset + 1) & 15;
                        max_h = max_h.max(h);
                        max_v = max_v.max(v);
                        components.push(Component {
                            h,
                            v,
                            quantization_id: byte(data, offset + 2),
                            quantization_table: None,
                            index: None,
                            block_data: Vec::new(),
                            blocks_per_line: 0,
                            blocks_per_column: 0,
                            pred: 0,
                            huffman_dc: None,
                            huffman_ac: None,
                        });
                        ids.insert(id, components.len() - 1);
                        offset += 3;
                    }
                    let mut f = Frame {
                        progressive: file_marker == 0xffc2,
                        precision,
                        scan_lines,
                        samples_per_line,
                        components,
                        component_ids: ids,
                        mcus_per_line: 0,
                        mcus_per_column: 0,
                    };
                    prepare_components(&mut f, max_h, max_v)?;
                    frame = Some(f);
                }
                0xffc4 => {
                    let length = u16_at(data, offset)? as usize;
                    offset += 2;
                    let mut i = 2usize;
                    while i < length {
                        let spec = byte(data, offset);
                        offset += 1;
                        let mut lengths = [0u8; 16];
                        let mut sum = 0usize;
                        for slot in lengths.iter_mut() {
                            *slot = byte(data, offset) as u8;
                            sum += usize::from(*slot);
                            offset += 1;
                        }
                        let values: Vec<u8> =
                            (0..sum).map(|j| byte(data, offset + j) as u8).collect();
                        offset += sum;
                        i += 17 + sum;
                        let table = Arc::new(build_huffman(&lengths, &values)?);
                        let list = if spec >> 4 == 0 {
                            &mut huffman_dc
                        } else {
                            &mut huffman_ac
                        };
                        list[(spec & 15) as usize] = Some(table);
                    }
                }
                0xffdd => {
                    offset += 2;
                    reset_interval = Some(u16_at(data, offset)?);
                    offset += 2;
                }
                0xffda => {
                    num_sos += 1;
                    let parse_dnl = num_sos == 1 && dnl_scan_lines.is_none_or(|lines| lines == 0);
                    offset += 2;
                    let count = byte(data, offset);
                    offset += 1;
                    let Some(f) = frame.as_mut() else {
                        return fail("Cannot read properties of undefined");
                    };
                    let mut selected = Vec::new();
                    for _ in 0..count {
                        let index = byte(data, offset);
                        offset += 1;
                        let Some(&ci) = f.component_ids.get(&index) else {
                            return fail("Cannot set properties of undefined");
                        };
                        let spec = byte(data, offset);
                        offset += 1;
                        let c = &mut f.components[ci];
                        c.index = Some(index);
                        c.huffman_dc = huffman_dc[(spec >> 4) as usize].clone();
                        c.huffman_ac = huffman_ac[(spec & 15) as usize].clone();
                        selected.push(ci);
                    }
                    let spectral_start = byte(data, offset) as usize;
                    let spectral_end = byte(data, offset + 1) as usize;
                    let approximation = byte(data, offset + 2);
                    offset += 3;
                    match decode_scan(
                        data,
                        offset,
                        f,
                        &selected,
                        reset_interval,
                        (spectral_start, spectral_end),
                        approximation >> 4,
                        approximation & 15,
                        parse_dnl,
                    ) {
                        Ok(processed) => offset += processed,
                        Err(Stop::Eoi) => {
                            tracing::warn!(
                                "Found EOI marker (0xFFD9) while parsing scan data -- ignoring the rest of the image data."
                            );
                            break 'markers;
                        }
                        Err(other) => return Err(other),
                    }
                }
                0xffdc => offset += 4,
                0xffff => {
                    if byte(data, offset) != 0xff {
                        offset -= 1;
                    }
                }
                _ => {
                    let next = find_next_file_marker(data, offset - 2, offset as isize - 3)?;
                    if let Some(FileMarker {
                        invalid: Some(invalid),
                        offset: at,
                        ..
                    }) = &next
                    {
                        tracing::warn!(
                            "JpegImage.parse - unexpected data, current marker is: {invalid:x}"
                        );
                        offset = *at;
                    } else if next.is_none() || offset as isize >= max_offset {
                        tracing::warn!(
                            "JpegImage.parse - reached the end of the image data without finding an EOI marker (0xFFD9)."
                        );
                        break 'markers;
                    } else {
                        return Err(Stop::Failed(format!(
                            "JpegImage.parse - unknown marker: {file_marker:x}"
                        )));
                    }
                }
            }
            if (offset as isize) < max_offset {
                file_marker = u16_at(data, offset)?;
                offset += 2;
            } else {
                file_marker = 0;
            }
        }
        let Some(mut f) = frame else {
            return fail("JpegImage.parse - no frame data found.");
        };
        let (max_h, max_v) = f
            .components
            .iter()
            .fold((0u32, 0u32), |(h, v), c| (h.max(c.h), v.max(c.v)));
        let mut components = Vec::with_capacity(f.components.len());
        for component in &mut f.components {
            if let Some(Some(table)) = quantization_tables.get(component.quantization_id as usize) {
                component.quantization_table = Some(table.clone());
            }
            build_component_data(component)?;
            components.push(Output {
                index: component.index,
                output: std::mem::take(&mut component.block_data),
                scale_x: f64::from(component.h) / f64::from(max_h),
                scale_y: f64::from(component.v) / f64::from(max_v),
                blocks_per_line: component.blocks_per_line,
            });
        }
        Ok(JpegImage {
            width: f.samples_per_line,
            height: f.scan_lines,
            adobe_transform,
            components,
            color_transform,
        })
    }

    /// The number of components of the frame.
    pub fn num_components(&self) -> usize {
        self.components.len()
    }

    /// `#getLinearizedBlockData`: the samples of every component interleaved, scaled to `width x height` by
    /// nearest neighbour.
    fn linearized(&self, width: usize, height: usize) -> Vec<u8> {
        let scale_x = f64::from(self.width) / width as f64;
        let scale_y = f64::from(self.height) / height as f64;
        let count = self.components.len();
        let mut data = vec![0u8; width * height * count];
        let mut x_offsets = vec![0u32; width];
        for (i, component) in self.components.iter().enumerate() {
            let component_scale_x = component.scale_x * scale_x;
            let component_scale_y = component.scale_y * scale_y;
            let blocks_per_scanline = ((component.blocks_per_line + 1) << 3) as i64;
            for (x, slot) in x_offsets.iter_mut().enumerate() {
                let j = js_int(x as f64 * component_scale_x);
                *slot = (((j & !7) << 3) | (j & 7)) as u32;
            }
            let mut at = i;
            for y in 0..height {
                let j = js_int(y as f64 * component_scale_y);
                let index = (blocks_per_scanline * (j & !7)) | ((j & 7) << 3);
                for x in 0..width {
                    let sample = usize::try_from(index + i64::from(x_offsets[x]))
                        .ok()
                        .and_then(|k| component.output.get(k))
                        .map_or(0, |v| *v);
                    data[at] = sample.clamp(0, 255) as u8;
                    at += count;
                }
            }
        }
        data
    }

    /// `_isColorConversionNeeded`.
    fn color_conversion_needed(&self) -> bool {
        if let Some(code) = self.adobe_transform {
            return code != 0;
        }
        if self.components.len() == 3 {
            if self.color_transform == 0 {
                return false;
            }
            let ids: Vec<Option<u32>> = self.components.iter().map(|c| c.index).collect();
            if ids == [Some(0x52), Some(0x47), Some(0x42)] {
                return false;
            }
            return true;
        }
        self.color_transform == 1
    }

    /// `getData({ width, height, forceRGBA, forceRGB })`.
    pub fn get_data(
        &self,
        width: usize,
        height: usize,
        force_rgba: bool,
        force_rgb: bool,
    ) -> Result<Vec<u8>> {
        if self.components.len() > 4 {
            return Err(jpeg_error("Unsupported color mode"));
        }
        let mut data = self.linearized(width, height);
        let count = self.components.len();
        if count == 1 && (force_rgba || force_rgb) {
            let stride = if force_rgba { 4 } else { 3 };
            let mut out = Vec::with_capacity(data.len() * stride);
            for gray in &data {
                out.extend_from_slice(&[*gray, *gray, *gray]);
                if force_rgba {
                    out.push(255);
                }
            }
            return Ok(out);
        }
        if count == 3 && self.color_conversion_needed() {
            let ycc = |p: &[u8]| {
                let (y, cb, cr) = (f64::from(p[0]), f64::from(p[1]), f64::from(p[2]));
                [
                    to_u8_clamped(y - 179.456 + 1.402 * cr),
                    to_u8_clamped(y + 135.459 - 0.344 * cb - 0.714 * cr),
                    to_u8_clamped(y - 226.816 + 1.772 * cb),
                ]
            };
            if force_rgba {
                let mut out = Vec::with_capacity(data.len() / 3 * 4);
                for p in data.chunks_exact(3) {
                    let rgb = ycc(p);
                    out.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
                }
                return Ok(out);
            }
            for p in data.chunks_exact_mut(3) {
                let rgb = ycc(p);
                p.copy_from_slice(&rgb);
            }
            return Ok(data);
        }
        if count == 4 {
            if self.color_conversion_needed() {
                for p in data.chunks_exact_mut(4) {
                    let (y, cb, cr) = (f64::from(p[0]), f64::from(p[1]), f64::from(p[2]));
                    p[0] = to_u8_clamped(434.456 - y - 1.402 * cr);
                    p[1] = to_u8_clamped(119.541 - y + 0.344 * cb + 0.714 * cr);
                    p[2] = to_u8_clamped(481.816 - y - 1.772 * cb);
                }
            } else if !(force_rgba || force_rgb) {
                return Ok(data);
            }
            if force_rgba {
                return cmyk_to_rgb(&data, 1);
            }
            if force_rgb {
                return cmyk_to_rgb(&data, 0);
            }
        }
        Ok(data)
    }
}

/// `ToInt32` of a non-negative sample position (`0 | x`).
fn js_int(x: f64) -> i64 {
    if x.is_finite() {
        i64::from(x.trunc() as i64 as i32)
    } else {
        0
    }
}

/// `_convertCmykToRgb` and `_convertCmykToRgba` (`alpha01` 0 or 1): the alpha of the latter is opaque.
fn cmyk_to_rgb(cmyk: &[u8], alpha01: usize) -> Result<Vec<u8>> {
    let count = cmyk.len() / 4;
    let mut out = vec![0u8; count * (3 + alpha01)];
    ColorSpace::cmyk().get_rgb_buffer(cmyk, 0, count, &mut out, 0, 8, alpha01)?;
    if alpha01 == 1 {
        for pixel in out.chunks_exact_mut(4) {
            pixel[3] = 255;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bytes of a bit string, padded with ones.
    fn pack(bits: &str) -> Vec<u8> {
        let mut padded = bits.to_owned();
        while padded.len() % 8 != 0 {
            padded.push('1');
        }
        padded
            .as_bytes()
            .chunks(8)
            .map(|chunk| {
                u8::from_str_radix(std::str::from_utf8(chunk).expect("ascii"), 2).expect("bits")
            })
            .collect()
    }

    /// An 8x8 gray JPEG with one block: quantisation table of ones, the DC codes `0` (category 0) and `10`
    /// (category 7), the AC code `0` (end of block); `scan` is the entropy coded bit string of the block.
    fn gray_block(scan: &str) -> Vec<u8> {
        let mut jpeg = vec![0xff, 0xd8];
        jpeg.extend([0xff, 0xdb, 0x00, 0x43, 0x00]);
        jpeg.extend([1u8; 64]);
        jpeg.extend([
            0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00,
        ]);
        jpeg.extend([0xff, 0xc4, 0x00, 0x15, 0x00]);
        jpeg.extend([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        jpeg.extend([0, 7]);
        jpeg.extend([0xff, 0xc4, 0x00, 0x14, 0x10]);
        jpeg.extend([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        jpeg.push(0);
        jpeg.extend([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
        jpeg.extend(pack(scan));
        jpeg.extend([0xff, 0xd9]);
        jpeg
    }

    /// DC difference 64: code `10`, seven magnitude bits, then the end of block.
    const DC_64: &str = "1010000000";
    /// DC difference 0: code `0`, then the end of block.
    const DC_0: &str = "00";

    #[test]
    fn a_dc_only_block_decodes_to_a_flat_gray() {
        let image = JpegImage::parse(&gray_block(DC_64), None).expect("parses");
        assert_eq!(image.num_components(), 1);
        let data = image.get_data(8, 8, false, false).expect("data");
        assert_eq!(data.len(), 64);
        assert!(data.iter().all(|v| *v == data[0]));
        // DC 64 * 1 through the 8x8 transform is 64 / 8 = 8 above the level shift of 128.
        assert_eq!(data[0], 136);
    }

    #[test]
    fn gray_is_widened_by_the_force_flags() {
        let image = JpegImage::parse(&gray_block(DC_0), None).expect("parses");
        let rgb = image.get_data(8, 8, false, true).expect("rgb");
        assert_eq!(rgb.len(), 192);
        let rgba = image.get_data(8, 8, true, false).expect("rgba");
        assert_eq!(rgba.len(), 256);
        assert_eq!(rgba[3], 255);
    }

    #[test]
    fn scaling_samples_nearest_neighbour() {
        let image = JpegImage::parse(&gray_block(DC_0), None).expect("parses");
        assert_eq!(image.get_data(16, 4, false, false).expect("data").len(), 64);
    }

    #[test]
    fn a_stream_that_is_not_a_jpeg_fails() {
        assert!(JpegImage::parse(&[1, 2, 3, 4], None).is_err());
        assert!(JpegImage::parse(&[0xff, 0xd8, 0xff, 0xd9], None).is_err());
    }

    #[test]
    fn huffman_tree_reads_two_codes() {
        let mut lengths = [0u8; 16];
        lengths[0] = 1;
        lengths[1] = 1;
        let tree = build_huffman(&lengths, &[7, 9]).ok().expect("builds");
        assert!(matches!(
            tree.nodes[0].first().copied().flatten(),
            Some(Child::Value(7))
        ));
    }
}
