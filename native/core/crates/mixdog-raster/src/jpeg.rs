//! The JPEG decode sharp gets from libjpeg-turbo, bit for bit: the integer "slow" inverse DCT, the triangle ("fancy")
//! chroma upsampling of 2:1 sampled components and the fixed-point YCbCr to RGB conversion, for the files the office
//! code meets (sequential Huffman, 8 bits, grey or three components, one interleaved scan).
//!
//! `mixdog-imaging`'s general decoder rounds the inverse DCT and the chroma differently (up to 4 levels on a colour
//! photo), which every operation after it inherits; the samples libvips resizes must be the ones libjpeg-turbo gives.
//! [`decode`] answers `None` for anything else (progressive, arithmetic coding, CMYK, an Adobe
//! marker, a damaged or cut stream) and the caller decodes those with the general decoder, which also gives the errors.

use mixdog_imaging::Raster;

/// The natural-order position of each zigzag index.
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
    22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

struct Component {
    id: u8,
    h: usize,
    v: usize,
    quant: usize,
    dc: usize,
    ac: usize,
    /// Width and height of the component's samples that belong to the picture.
    width: usize,
    height: usize,
    /// The decoded samples, `stride` per row, whole blocks.
    stride: usize,
    samples: Vec<u8>,
}

/// A Huffman table as a 16-bit lookahead: the code length and symbol of every 16-bit prefix.
struct Huffman {
    lookup: Vec<u16>,
}

impl Huffman {
    fn build(counts: &[u8; 16], symbols: &[u8]) -> Option<Self> {
        let mut lookup = vec![0u16; 1 << 16];
        let mut code = 0u32;
        let mut at = 0usize;
        for (length, &count) in counts.iter().enumerate() {
            let length = length + 1;
            for _ in 0..count {
                let symbol = *symbols.get(at)?;
                at += 1;
                if code >= (1 << length) {
                    return None;
                }
                let first = (code << (16 - length)) as usize;
                let span = 1usize << (16 - length);
                let entry = ((length as u16) << 8) | u16::from(symbol);
                lookup[first..first + span].fill(entry);
                code += 1;
            }
            code <<= 1;
        }
        Some(Self { lookup })
    }
}

/// Entropy-coded bits with the `FF 00` stuffing removed; a marker ends the data.
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
    buffer: u64,
    count: u32,
    /// Set when a marker (not a stuffed zero) was met: the data is over.
    marker: Option<u8>,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8], at: usize) -> Self {
        Self { data, at, buffer: 0, count: 0, marker: None }
    }

    fn fill(&mut self) {
        while self.count <= 48 {
            let byte = if self.marker.is_some() {
                0
            } else {
                match self.data.get(self.at) {
                    None => {
                        self.marker = Some(0xD9);
                        0
                    }
                    Some(0xFF) => match self.data.get(self.at + 1) {
                        Some(0) => {
                            self.at += 2;
                            0xFF
                        }
                        Some(0xFF) => {
                            self.at += 1;
                            continue;
                        }
                        Some(&marker) => {
                            self.marker = Some(marker);
                            0
                        }
                        None => {
                            self.marker = Some(0xD9);
                            0
                        }
                    },
                    Some(&byte) => {
                        self.at += 1;
                        byte
                    }
                }
            };
            self.buffer |= u64::from(byte) << (56 - self.count);
            self.count += 8;
        }
    }

    fn peek16(&mut self) -> usize {
        if self.count < 16 {
            self.fill();
        }
        (self.buffer >> 48) as usize
    }

    fn take(&mut self, bits: u32) {
        self.buffer <<= bits;
        self.count -= bits;
    }

    fn receive(&mut self, bits: u32) -> i32 {
        if bits == 0 {
            return 0;
        }
        if self.count < bits {
            self.fill();
        }
        let value = (self.buffer >> (64 - bits)) as i32;
        self.take(bits);
        value
    }

    fn decode(&mut self, table: &Huffman) -> Option<u8> {
        let entry = table.lookup[self.peek16()];
        let length = u32::from(entry >> 8);
        if length == 0 || length > self.count {
            return None;
        }
        self.take(length);
        Some(entry as u8)
    }

    /// At a restart: drops the bits left in the byte and takes the `RSTn` marker.
    fn restart(&mut self, number: u8) -> bool {
        self.buffer = 0;
        self.count = 0;
        let mut at = self.at;
        loop {
            match (self.data.get(at), self.data.get(at + 1)) {
                (Some(0xFF), Some(&marker)) if marker != 0 && marker != 0xFF => {
                    if marker != 0xD0 + (number & 7) {
                        return false;
                    }
                    self.at = at + 2;
                    self.marker = None;
                    return true;
                }
                (Some(_), Some(_)) => at += 1,
                _ => return false,
            }
        }
    }
}

fn extend(value: i32, bits: u32) -> i32 {
    if bits == 0 {
        0
    } else if value < (1 << (bits - 1)) {
        value - (1 << bits) + 1
    } else {
        value
    }
}

const FIX_0_298631336: i64 = 2446;
const FIX_0_390180644: i64 = 3196;
const FIX_0_541196100: i64 = 4433;
const FIX_0_765366865: i64 = 6270;
const FIX_0_899976223: i64 = 7373;
const FIX_1_175875602: i64 = 9633;
const FIX_1_501321110: i64 = 12299;
const FIX_1_847759065: i64 = 15137;
const FIX_1_961570560: i64 = 16069;
const FIX_2_053119869: i64 = 16819;
const FIX_2_562915447: i64 = 20995;
const FIX_3_072711026: i64 = 25172;

fn descale(value: i64, bits: u32) -> i64 {
    (value + (1 << (bits - 1))) >> bits
}

/// One 8-point pass of libjpeg's accurate integer inverse DCT: the eight inputs to the eight outputs before descaling.
/// The sums are 64-bit, as libjpeg-turbo's `JLONG` is on the 64-bit builds sharp ships: a damaged file cannot overflow.
fn idct_line(i: [i64; 8]) -> [i64; 8] {
    let z1 = (i[2] + i[6]) * FIX_0_541196100;
    let tmp2 = z1 + i[6] * -FIX_1_847759065;
    let tmp3 = z1 + i[2] * FIX_0_765366865;
    let tmp0 = (i[0] + i[4]) << 13;
    let tmp1 = (i[0] - i[4]) << 13;
    let tmp10 = tmp0 + tmp3;
    let tmp13 = tmp0 - tmp3;
    let tmp11 = tmp1 + tmp2;
    let tmp12 = tmp1 - tmp2;
    let (mut t0, mut t1, mut t2, mut t3) = (i[7], i[5], i[3], i[1]);
    let mut z1 = t0 + t3;
    let mut z2 = t1 + t2;
    let mut z3 = t0 + t2;
    let mut z4 = t1 + t3;
    let z5 = (z3 + z4) * FIX_1_175875602;
    t0 *= FIX_0_298631336;
    t1 *= FIX_2_053119869;
    t2 *= FIX_3_072711026;
    t3 *= FIX_1_501321110;
    z1 *= -FIX_0_899976223;
    z2 *= -FIX_2_562915447;
    z3 *= -FIX_1_961570560;
    z4 *= -FIX_0_390180644;
    z3 += z5;
    z4 += z5;
    t0 += z1 + z3;
    t1 += z2 + z4;
    t2 += z2 + z3;
    t3 += z1 + z4;
    [tmp10 + t3, tmp11 + t2, tmp12 + t1, tmp13 + t0, tmp13 - t0, tmp12 - t1, tmp11 - t2, tmp10 - t3]
}

/// The inverse DCT of one dequantised block into 8x8 samples at `out` (row stride `stride`).
fn idct_block(block: &[i64; 64], out: &mut [u8], stride: usize) {
    let mut work = [0i64; 64];
    for column in 0..8 {
        let line = idct_line([
            block[column],
            block[8 + column],
            block[16 + column],
            block[24 + column],
            block[32 + column],
            block[40 + column],
            block[48 + column],
            block[56 + column],
        ]);
        for (row, value) in line.iter().enumerate() {
            work[row * 8 + column] = descale(*value, 11);
        }
    }
    for row in 0..8 {
        let line = idct_line([
            work[row * 8],
            work[row * 8 + 1],
            work[row * 8 + 2],
            work[row * 8 + 3],
            work[row * 8 + 4],
            work[row * 8 + 5],
            work[row * 8 + 6],
            work[row * 8 + 7],
        ]);
        for (column, value) in line.iter().enumerate() {
            out[row * stride + column] = (descale(*value, 18) + 128).clamp(0, 255) as u8;
        }
    }
}

fn be16(bytes: &[u8], at: usize) -> Option<usize> {
    Some(usize::from(*bytes.get(at)?) << 8 | usize::from(*bytes.get(at + 1)?))
}

/// libjpeg-turbo's `h2v1_fancy_upsample` on one row of `n` (more than 2) samples.
fn upsample_h2v1(input: &[u8], n: usize, out: &mut [u8]) {
    let at = |i: usize| i32::from(input[i]);
    out[0] = input[0];
    out[1] = ((at(0) * 3 + at(1) + 2) >> 2) as u8;
    for i in 1..n - 1 {
        let value = at(i) * 3;
        out[2 * i] = ((value + at(i - 1) + 1) >> 2) as u8;
        out[2 * i + 1] = ((value + at(i + 1) + 2) >> 2) as u8;
    }
    out[2 * n - 2] = ((at(n - 1) * 3 + at(n - 2) + 1) >> 2) as u8;
    out[2 * n - 1] = input[n - 1];
}

/// libjpeg-turbo's `h2v2_fancy_upsample` for one output row: `near` is the row it lies over, `far` the row on the side
/// of the output row (above for the upper one, below for the lower one).
fn upsample_h2v2(near: &[u8], far: &[u8], n: usize, out: &mut [u8]) {
    let sum = |i: usize| i32::from(near[i]) * 3 + i32::from(far[i]);
    let mut this = sum(0);
    let mut next = sum(1);
    out[0] = ((this * 4 + 8) >> 4) as u8;
    out[1] = ((this * 3 + next + 7) >> 4) as u8;
    let mut last = this;
    this = next;
    for i in 1..n - 1 {
        next = sum(i + 1);
        out[2 * i] = ((this * 3 + last + 8) >> 4) as u8;
        out[2 * i + 1] = ((this * 3 + next + 7) >> 4) as u8;
        last = this;
        this = next;
    }
    out[2 * n - 2] = ((this * 3 + last + 8) >> 4) as u8;
    out[2 * n - 1] = ((this * 4 + 7) >> 4) as u8;
}

/// One component's samples at the picture's resolution, `width` x `height`.
fn full_size(component: &Component, h_max: usize, v_max: usize, width: usize, height: usize) -> Option<Vec<u8>> {
    let (h_ratio, v_ratio) = (h_max / component.h, v_max / component.v);
    if h_max % component.h != 0 || v_max % component.v != 0 {
        return None;
    }
    let (cw, ch, stride) = (component.width, component.height, component.stride);
    let mut out = vec![0u8; width * height];
    let mut row = vec![0u8; cw * 2 + 2];
    match (h_ratio, v_ratio) {
        (1, 1) => {
            for y in 0..height {
                out[y * width..(y + 1) * width].copy_from_slice(&component.samples[y * stride..y * stride + width]);
            }
        }
        (2, 1) if cw > 2 => {
            for y in 0..height {
                upsample_h2v1(&component.samples[y * stride..y * stride + cw], cw, &mut row);
                out[y * width..(y + 1) * width].copy_from_slice(&row[..width]);
            }
        }
        (2, 2) if cw > 2 => {
            for y in 0..height {
                let source = y / 2;
                let far = if y % 2 == 0 { source.saturating_sub(1) } else { (source + 1).min(ch - 1) };
                upsample_h2v2(&component.samples[source * stride..source * stride + cw], &component.samples[far * stride..far * stride + cw], cw, &mut row);
                out[y * width..(y + 1) * width].copy_from_slice(&row[..width]);
            }
        }
        (h, v) => {
            // The box replication libjpeg uses where the fancy filter does not apply (a 2:1 component of at most
            // two columns); other ratios are libjpeg's own filters, which are not here.
            if h > 2 || (h == 1 && v != 1) {
                return None;
            }
            for y in 0..height {
                for x in 0..width {
                    out[y * width + x] = component.samples[(y / v) * stride + x / h];
                }
            }
        }
    }
    Some(out)
}

/// libjpeg's YCbCr to RGB tables: 16-bit fixed point, the green sum cut after the add.
fn ycc_to_rgb(y: u8, cb: u8, cr: u8) -> [u8; 3] {
    let (cb, cr) = (i32::from(cb) - 128, i32::from(cr) - 128);
    let y = i32::from(y);
    let r = y + ((91_881 * cr + 32_768) >> 16);
    let g = y + ((-22_554 * cb - 46_802 * cr + 32_768) >> 16);
    let b = y + ((116_130 * cb + 32_768) >> 16);
    [r.clamp(0, 255) as u8, g.clamp(0, 255) as u8, b.clamp(0, 255) as u8]
}

struct Frame<'a> {
    quant: [[i32; 64]; 4],
    quant_set: [bool; 4],
    dc_tables: [Option<Huffman>; 4],
    ac_tables: [Option<Huffman>; 4],
    components: Vec<Component>,
    width: usize,
    height: usize,
    restart: usize,
    profile_chunks: Vec<(u8, Vec<u8>)>,
    jfif: bool,
    scan_header: &'a [u8],
    scan_at: usize,
}

struct Layout {
    single: bool,
    h_max: usize,
    v_max: usize,
    mcus_x: usize,
    mcus_y: usize,
}

fn read_quant_tables(body: &[u8], quant: &mut [[i32; 64]; 4], quant_set: &mut [bool; 4]) -> Option<()> {
    let mut rest = body;
    while !rest.is_empty() {
        let (precision, id) = (rest[0] >> 4, usize::from(rest[0] & 15));
        let size = if precision == 0 { 64 } else { 128 };
        let table = rest.get(1..1 + size)?;
        if id > 3 || precision > 1 {
            return None;
        }
        for k in 0..64 {
            quant[id][ZIGZAG[k]] = if precision == 0 { i32::from(table[k]) } else { i32::from(table[2 * k]) << 8 | i32::from(table[2 * k + 1]) };
        }
        quant_set[id] = true;
        rest = &rest[1 + size..];
    }
    Some(())
}

fn read_huffman_tables(body: &[u8], dc_tables: &mut [Option<Huffman>; 4], ac_tables: &mut [Option<Huffman>; 4]) -> Option<()> {
    let mut rest = body;
    while !rest.is_empty() {
        let (class, id) = (rest[0] >> 4, usize::from(rest[0] & 15));
        let counts: [u8; 16] = rest.get(1..17)?.try_into().ok()?;
        let total: usize = counts.iter().map(|c| usize::from(*c)).sum();
        let symbols = rest.get(17..17 + total)?;
        if id > 3 || class > 1 {
            return None;
        }
        let table = Huffman::build(&counts, symbols)?;
        if class == 0 {
            dc_tables[id] = Some(table)
        } else {
            ac_tables[id] = Some(table)
        }
        rest = &rest[17 + total..];
    }
    Some(())
}

/// A baseline or extended sequential frame header: the picture's size and its components.
fn read_frame_header(body: &[u8], frame: &mut Frame<'_>) -> Option<()> {
    if !frame.components.is_empty() || body.len() < 6 || body[0] != 8 {
        return None;
    }
    frame.height = be16(body, 1)?;
    frame.width = be16(body, 3)?;
    let count = usize::from(body[5]);
    if frame.width == 0 || frame.height == 0 || !(count == 1 || count == 3) || body.len() < 6 + count * 3 {
        return None;
    }
    for c in 0..count {
        let spec = &body[6 + c * 3..9 + c * 3];
        let (h, v) = (usize::from(spec[1] >> 4), usize::from(spec[1] & 15));
        if !(1..=2).contains(&h) || !(1..=2).contains(&v) || spec[2] > 3 {
            return None;
        }
        frame.components.push(Component { id: spec[0], h, v, quant: usize::from(spec[2]), dc: 0, ac: 0, width: 0, height: 0, stride: 0, samples: Vec::new() });
    }
    Some(())
}

/// The markers up to the start of the scan: tables, the frame header, the restart interval, the colour profile.
fn read_markers(bytes: &[u8]) -> Option<Frame<'_>> {
    if bytes.get(..2)? != [0xFF, 0xD8] {
        return None;
    }
    let mut frame = Frame {
        quant: [[0i32; 64]; 4],
        quant_set: [false; 4],
        dc_tables: [None, None, None, None],
        ac_tables: [None, None, None, None],
        components: Vec::new(),
        width: 0,
        height: 0,
        restart: 0,
        profile_chunks: Vec::new(),
        jfif: false,
        scan_header: &[],
        scan_at: 0,
    };
    let mut at = 2usize;
    loop {
        // Skip to the next marker.
        while *bytes.get(at)? != 0xFF {
            at += 1;
        }
        while *bytes.get(at + 1)? == 0xFF {
            at += 1;
        }
        let marker = *bytes.get(at + 1)?;
        at += 2;
        match marker {
            0xD8 | 0x01 | 0xD0..=0xD7 => continue,
            0xD9 => return None,
            _ => {}
        }
        let length = be16(bytes, at)?;
        let body = bytes.get(at + 2..at + length)?;
        match marker {
            0xDB => read_quant_tables(body, &mut frame.quant, &mut frame.quant_set)?,
            0xC4 => read_huffman_tables(body, &mut frame.dc_tables, &mut frame.ac_tables)?,
            0xC0 | 0xC1 => read_frame_header(body, &mut frame)?,
            // Progressive, lossless, arithmetic coded, hierarchical: not here.
            0xC2 | 0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
            0xDD => {
                frame.restart = be16(body, 0)?;
            }
            // A colour profile is handed back to be applied; an Adobe transform changes the colours the general decoder applies.
            0xE2 if body.starts_with(b"ICC_PROFILE\0") && body.len() >= 14 => frame.profile_chunks.push((body[12], body[14..].to_vec())),
            0xEE if body.starts_with(b"Adobe") => return None,
            0xE0 if body.starts_with(b"JFIF ") => frame.jfif = true,
            0xDA => {
                frame.scan_header = body;
                frame.scan_at = at + length;
                return Some(frame);
            }
            _ => {}
        }
        at += length;
    }
}

/// Checks the scan header (every component in one interleaved scan, baseline parameters) and sizes the component planes.
fn prepare_scan(frame: &mut Frame<'_>, pixel_limit: u64) -> Option<Layout> {
    let components = &mut frame.components;
    if components.is_empty() || (frame.width as u64) * (frame.height as u64) > pixel_limit {
        return None;
    }
    // Without a JFIF marker libjpeg-turbo reads three components named R, G and B as RGB, not YCbCr.
    if !frame.jfif && components.iter().map(|c| c.id).eq([b'R', b'G', b'B']) {
        return None;
    }
    let header = frame.scan_header;
    let count = usize::from(*header.first()?);
    if count != components.len() || header.len() < 1 + count * 2 + 3 {
        return None;
    }
    for c in 0..count {
        let id = header[1 + c * 2];
        let tables = header[2 + c * 2];
        let component = components.iter_mut().find(|component| component.id == id)?;
        component.dc = usize::from(tables >> 4);
        component.ac = usize::from(tables & 15);
        if component.dc > 3 || component.ac > 3 {
            return None;
        }
    }
    let tail = &header[1 + count * 2..];
    if tail[0] != 0 || tail[1] != 63 || tail[2] != 0 {
        return None;
    }
    let single = components.len() == 1;
    if single {
        components[0].h = 1;
        components[0].v = 1;
    }
    let h_max = components.iter().map(|c| c.h).max()?;
    let v_max = components.iter().map(|c| c.v).max()?;
    let (mcus_x, mcus_y) = (frame.width.div_ceil(8 * h_max), frame.height.div_ceil(8 * v_max));
    for component in components.iter_mut() {
        component.width = (frame.width * component.h).div_ceil(h_max);
        component.height = (frame.height * component.v).div_ceil(v_max);
        component.stride = mcus_x * component.h * 8;
        component.samples = vec![0u8; component.stride * mcus_y * component.v * 8];
        if !frame.quant_set[component.quant] || frame.dc_tables[component.dc].is_none() || frame.ac_tables[component.ac].is_none() {
            return None;
        }
    }
    Some(Layout { single, h_max, v_max, mcus_x, mcus_y })
}

/// Decodes the entropy-coded scan into the component planes; `None` for a stream that is damaged or was cut.
fn decode_scan(bytes: &[u8], frame: &mut Frame<'_>, layout: &Layout) -> Option<()> {
    let Layout { single, mcus_x, mcus_y, .. } = *layout;
    let mut bits = Bits::new(bytes, frame.scan_at);
    let mut predictors = vec![0i64; frame.components.len()];
    let mut block = [0i64; 64];
    let mut done = 0usize;
    let restart = frame.restart;
    for mcu in 0..mcus_x * mcus_y {
        if restart > 0 && done == restart {
            if !bits.restart(((mcu / restart - 1) & 7) as u8) {
                return None;
            }
            predictors.iter_mut().for_each(|p| *p = 0);
            done = 0;
        }
        let (mx, my) = (mcu % mcus_x, mcu / mcus_x);
        for (index, component) in frame.components.iter_mut().enumerate() {
            let dc = frame.dc_tables[component.dc].as_ref()?;
            let ac = frame.ac_tables[component.ac].as_ref()?;
            let quant = &frame.quant[component.quant];
            let (blocks_x, blocks_y) = if single { (1, 1) } else { (component.h, component.v) };
            for by in 0..blocks_y {
                for bx in 0..blocks_x {
                    block.fill(0);
                    let size = u32::from(bits.decode(dc)?);
                    if size > 11 {
                        return None;
                    }
                    let diff = extend(bits.receive(size), size);
                    predictors[index] += i64::from(diff);
                    block[0] = predictors[index] * i64::from(quant[0]);
                    let mut k = 1usize;
                    while k < 64 {
                        let symbol = bits.decode(ac)?;
                        let (run, size) = (usize::from(symbol >> 4), u32::from(symbol & 15));
                        if size == 0 {
                            if run == 15 {
                                k += 16;
                                continue;
                            }
                            break;
                        }
                        k += run;
                        if k > 63 {
                            return None;
                        }
                        let value = extend(bits.receive(size), size);
                        block[ZIGZAG[k]] = i64::from(value) * i64::from(quant[ZIGZAG[k]]);
                        k += 1;
                    }
                    let (column, row) = (mx * blocks_x + bx, my * blocks_y + by);
                    let origin = row * 8 * component.stride + column * 8;
                    let stride = component.stride;
                    idct_block(&block, &mut component.samples[origin..], stride);
                }
            }
        }
        done += 1;
    }
    // The data ends at a marker; a stream that was cut has none.
    bytes[bits.at.min(bytes.len())..].windows(2).any(|pair| pair == [0xFF, 0xD9]).then_some(())
}

fn to_rgb(frame: &Frame<'_>, layout: &Layout) -> Option<Vec<u8>> {
    let (width, height) = (frame.width, frame.height);
    let mut data = Vec::with_capacity(width * height * 3);
    if layout.single {
        let component = &frame.components[0];
        for y in 0..height {
            for x in 0..width {
                let value = component.samples[y * component.stride + x];
                data.extend_from_slice(&[value, value, value]);
            }
        }
    } else {
        let planes: Vec<Vec<u8>> = frame.components.iter().map(|c| full_size(c, layout.h_max, layout.v_max, width, height)).collect::<Option<_>>()?;
        for i in 0..width * height {
            data.extend_from_slice(&ycc_to_rgb(planes[0][i], planes[1][i], planes[2][i]));
        }
    }
    Some(data)
}

/// libjpeg-turbo's decode of `bytes`, or `None` when the file is not one this decoder takes (see the module text).
pub fn decode(bytes: &[u8], pixel_limit: u64) -> Option<Jpeg> {
    let mut frame = read_markers(bytes)?;
    let layout = prepare_scan(&mut frame, pixel_limit)?;
    decode_scan(bytes, &mut frame, &layout)?;
    let data = to_rgb(&frame, &layout)?;
    let mut profile_chunks = std::mem::take(&mut frame.profile_chunks);
    profile_chunks.sort_by_key(|(sequence, _)| *sequence);
    let profile: Vec<u8> = profile_chunks.into_iter().flat_map(|(_, chunk)| chunk).collect();
    Some(Jpeg {
        raster: Raster { width: frame.width as u32, height: frame.height as u32, has_alpha: false, data },
        profile: (!profile.is_empty()).then_some(profile),
        grey: layout.single,
    })
}

/// What [`decode`] answers: the samples, the embedded colour profile (the caller applies it to colour pictures) and
/// whether the file has one component.
pub struct Jpeg {
    pub raster: Raster,
    pub profile: Option<Vec<u8>>,
    pub grey: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_with_only_a_dc_term_is_flat() {
        let mut block = [0i64; 64];
        block[0] = 8 * 40;
        let mut out = [0u8; 64];
        idct_block(&block, &mut out, 8);
        assert!(out.iter().all(|v| *v == 168), "{out:?}");
    }

    #[test]
    fn the_triangle_upsampling_keeps_the_ends_and_blends_the_rest() {
        let mut out = [0u8; 8];
        upsample_h2v1(&[0, 100, 100, 0], 4, &mut out);
        assert_eq!(out, [0, 25, 75, 100, 100, 75, 25, 0]);
    }

    #[test]
    fn a_file_that_is_not_a_baseline_jpeg_is_left_to_the_general_decoder() {
        assert!(decode(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], 1 << 20).is_none());
        assert!(decode(&[0xFF, 0xD8, 0xFF, 0xD9], 1 << 20).is_none());
    }

    #[test]
    fn ycc_grey_stays_grey_and_red_chroma_raises_red() {
        assert_eq!(ycc_to_rgb(100, 128, 128), [100, 100, 100]);
        let [r, g, b] = ycc_to_rgb(100, 128, 200);
        assert!(r > 100 && g < 100 && b == 100);
    }

    const COLOUR_420: &str = "ffd8ffe000104a46494600010100000100010000ffdb0043000d090a0b0a080d0b0a0b0e0e0d0f13201513121213271c1e17202e2931302e292d2c333a4a3e333646372c2d405741464c4e525352323e5a615a50604a51524fffdb0043010e0e0e131113261515264f352d354f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4fffc0001108000a001203012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00e6ed342ce3e4adab6f0f8001650056dd82af1f28fcab5a1553372a3b76ae155b968aa92576dd8e5cbb31ad748e70683163a7fe3a68aed822e07ca3f2a2b4f68ff963f73ff33e8ffb4aa9ffd9";
    const GREY: &str = "ffd8ffe000104a46494600010100000100010000ffdb0043000d090a0b0a080d0b0a0b0e0e0d0f13201513121213271c1e17202e2931302e292d2c333a4a3e333646372c2d405741464c4e525352323e5a615a50604a51524fffc0000b080009000901011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f006f81ede38625966658e345dceec70140e4927b0aa7ff000b275eff009f2d37fefd49ff00c5d5fd2bfe455d4ffebca6ff00d00d7115ffd9";

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap()).collect()
    }

    fn fnv(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3))
    }

    #[test]
    fn a_colour_jpeg_with_half_sampled_chroma_decodes_as_libjpeg_turbo_does() {
        let jpeg = decode(&hex(COLOUR_420), 1 << 20).expect("decoded");
        assert_eq!((jpeg.raster.width, jpeg.raster.height, jpeg.grey, jpeg.profile.is_none()), (18, 10, false, true));
        assert_eq!(fnv(&jpeg.raster.data), 0xde37_a019_c134_9b99);
    }

    #[test]
    fn a_grey_jpeg_decodes_as_libjpeg_turbo_does() {
        let jpeg = decode(&hex(GREY), 1 << 20).expect("decoded");
        assert_eq!((jpeg.raster.width, jpeg.raster.height, jpeg.grey), (9, 9, true));
        assert_eq!(fnv(&jpeg.raster.data), 0x9f0b_2644_adca_9738);
    }

    #[test]
    fn a_picture_over_the_pixel_limit_or_cut_short_is_refused() {
        assert!(decode(&hex(COLOUR_420), 179).is_none());
        let whole = hex(COLOUR_420);
        assert!(decode(&whole[..whole.len() - 2], 1 << 20).is_none());
    }
}
