//! A JPEG 2000 encoder for the tests, written from ITU-T T.800: the reversible (G.2) and irreversible (G.3) component
//! transforms, the reversible 5-3 and the irreversible 9-7 wavelets over several decomposition levels (F.4), scalar
//! quantization (expounded or derived), the bit-plane coding of code-blocks (Annex D) over the MQ coder of
//! `read_support` with every code-block style (bypass, reset, termination of every pass, vertically causal contexts,
//! predictable termination, segmentation symbols), many code-blocks per band with tag trees (B.10.2), quality layers,
//! precincts, the five progression orders and progression order changes, start-of-packet and end-of-packet-header
//! markers, packed packet headers (PPM, PPT), tiles and tile-parts, subsampled components, any precision, signed
//! samples, region-of-interest shifts and component-specific coding parameters (COC, QCC).

use crate::read_support::MqEncoder;

type Grid<T> = Vec<Vec<T>>;

pub const BYPASS: u8 = 0x01;
pub const RESET: u8 = 0x02;
pub const TERMALL: u8 = 0x04;
pub const VSC: u8 = 0x08;
pub const PREDICT: u8 = 0x10;
pub const SEGSYM: u8 = 0x20;

#[derive(Clone, Copy, PartialEq)]
enum Band {
    Ll,
    Hl,
    Lh,
    Hh,
}

/// The context of a significance bit (T.800 table D.1).
fn zero_coding(band: Band, h: u32, v: u32, d: u32) -> usize {
    let (h, v) = if band == Band::Hl { (v, h) } else { (h, v) };
    if band == Band::Hh {
        let hv = h + v;
        return match (d, hv) {
            (3.., _) => 8,
            (2, 1..) => 7,
            (2, 0) => 6,
            (1, 2..) => 5,
            (1, 1) => 4,
            (1, 0) => 3,
            (0, 2..) => 2,
            (0, 1) => 1,
            _ => 0,
        };
    }
    match (h, v, d) {
        (2, _, _) => 8,
        (1, 1.., _) => 7,
        (1, 0, 1..) => 6,
        (1, 0, 0) => 5,
        (0, 2, _) => 4,
        (0, 1, _) => 3,
        (0, 0, 2..) => 2,
        (0, 0, 1) => 1,
        _ => 0,
    }
}

/// The bits of a packet header or a raw (bypass) codeword: after a 0xFF byte the next byte carries 7 bits (B.10.1).
struct HeaderBits {
    bytes: Vec<u8>,
    current: u8,
    count: u8,
    limit: u8,
}

impl HeaderBits {
    fn new() -> Self {
        HeaderBits { bytes: Vec::new(), current: 0, count: 0, limit: 8 }
    }

    fn put(&mut self, bit: u8) {
        self.current = (self.current << 1) | bit;
        self.count += 1;
        if self.count == self.limit {
            self.bytes.push(self.current);
            self.limit = if self.current == 0xFF { 7 } else { 8 };
            self.current = 0;
            self.count = 0;
        }
    }

    fn put_value(&mut self, value: u32, bits: u32) {
        for shift in (0..bits).rev() {
            self.put(((value >> shift) & 1) as u8);
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.count > 0 {
            self.current <<= self.limit - self.count;
            self.bytes.push(self.current);
        }
        if self.bytes.last() == Some(&0xFF) {
            self.bytes.push(0);
        }
        self.bytes
    }
}

/// The contexts that do not start in state 0: the first zero-coding context, the run-length one and the uniform one.
const PRESET: [(usize, usize); 3] = [(0, 4), (17, 3), (18, 46)];

struct Block {
    magnitude: Vec<Vec<u32>>,
    negative: Vec<Vec<bool>>,
    significant: Vec<Vec<bool>>,
    visited: Vec<Vec<bool>>,
    refined: Vec<Vec<bool>>,
    band: Band,
    vsc: bool,
    coder: MqEncoder,
    raw: HeaderBits,
}

impl Block {
    fn emit(&mut self, context: usize, bit: u8, raw: bool) {
        if raw {
            self.raw.put(bit);
        } else {
            self.coder.encode(context, bit);
        }
    }

    fn sig(&self, row: i32, column: i32) -> bool {
        row >= 0
            && column >= 0
            && (row as usize) < self.magnitude.len()
            && (column as usize) < self.magnitude[0].len()
            && self.significant[row as usize][column as usize]
    }

    fn signed(&self, row: i32, column: i32) -> i32 {
        if !self.sig(row, column) {
            0
        } else if self.negative[row as usize][column as usize] {
            -1
        } else {
            1
        }
    }

    /// With vertically causal contexts the last row of a stripe does not see the row below (D.7).
    fn sees_below(&self, r: usize) -> bool {
        !(self.vsc && r % 4 == 3)
    }

    fn neighbours(&self, r: usize, c: usize) -> (u32, u32, u32) {
        let (r, c) = (r as i32, c as i32);
        let at = |dr: i32, dc: i32| u32::from(self.sig(r + dr, c + dc));
        let below = u32::from(self.sees_below(r as usize));
        (
            at(0, -1) + at(0, 1),
            at(-1, 0) + below * at(1, 0),
            at(-1, -1) + at(-1, 1) + below * (at(1, -1) + at(1, 1)),
        )
    }

    fn context(&self, r: usize, c: usize) -> usize {
        let (h, v, d) = self.neighbours(r, c);
        zero_coding(self.band, h, v, d)
    }

    fn code_sign(&mut self, r: usize, c: usize, raw: bool) {
        if raw {
            self.raw.put(u8::from(self.negative[r][c]));
            self.significant[r][c] = true;
            return;
        }
        let (ri, ci) = (r as i32, c as i32);
        let south = if self.sees_below(r) { self.signed(ri + 1, ci) } else { 0 };
        let h = (self.signed(ri, ci - 1) + self.signed(ri, ci + 1)).clamp(-1, 1);
        let v = (self.signed(ri - 1, ci) + south).clamp(-1, 1);
        let (context, flip) = match (h, v) {
            (1, 1) => (13, 0),
            (1, 0) => (12, 0),
            (1, -1) => (11, 0),
            (0, 1) => (10, 0),
            (0, 0) => (9, 0),
            (0, -1) => (10, 1),
            (-1, 1) => (11, 1),
            (-1, 0) => (12, 1),
            _ => (13, 1),
        };
        self.coder.encode(context, u8::from(self.negative[r][c]) ^ flip);
        self.significant[r][c] = true;
    }

    fn bit(&self, r: usize, c: usize, plane: u32) -> u8 {
        ((self.magnitude[r][c] >> plane) & 1) as u8
    }

    fn significance_pass(&mut self, plane: u32, raw: bool) {
        let (rows, columns) = (self.magnitude.len(), self.magnitude[0].len());
        for stripe in (0..rows).step_by(4) {
            for c in 0..columns {
                for r in stripe..(stripe + 4).min(rows) {
                    let (h, v, d) = self.neighbours(r, c);
                    if self.significant[r][c] || h + v + d == 0 {
                        continue;
                    }
                    let bit = self.bit(r, c, plane);
                    let context = self.context(r, c);
                    self.emit(context, bit, raw);
                    if bit == 1 {
                        self.code_sign(r, c, raw);
                    }
                    self.visited[r][c] = true;
                }
            }
        }
    }

    fn refinement_pass(&mut self, plane: u32, raw: bool) {
        let (rows, columns) = (self.magnitude.len(), self.magnitude[0].len());
        for stripe in (0..rows).step_by(4) {
            for c in 0..columns {
                for r in stripe..(stripe + 4).min(rows) {
                    if !self.significant[r][c] || self.visited[r][c] {
                        continue;
                    }
                    let (h, v, d) = self.neighbours(r, c);
                    let context = if self.refined[r][c] {
                        16
                    } else if h + v + d > 0 {
                        15
                    } else {
                        14
                    };
                    let bit = self.bit(r, c, plane);
                    self.emit(context, bit, raw);
                    self.refined[r][c] = true;
                }
            }
        }
    }

    fn cleanup_pass(&mut self, plane: u32) {
        let (rows, columns) = (self.magnitude.len(), self.magnitude[0].len());
        for stripe in (0..rows).step_by(4) {
            for c in 0..columns {
                let mut first = stripe;
                if stripe + 4 <= rows
                    && (stripe..stripe + 4).all(|r| {
                        let (h, v, d) = self.neighbours(r, c);
                        !self.significant[r][c] && !self.visited[r][c] && h + v + d == 0
                    })
                {
                    match (stripe..stripe + 4).find(|&r| self.bit(r, c, plane) == 1) {
                        None => {
                            self.coder.encode(17, 0);
                            continue;
                        }
                        Some(r) => {
                            let offset = (r - stripe) as u8;
                            self.coder.encode(17, 1);
                            self.coder.encode(18, offset >> 1);
                            self.coder.encode(18, offset & 1);
                            self.code_sign(r, c, false);
                            first = r + 1;
                        }
                    }
                }
                for r in first..(stripe + 4).min(rows) {
                    if self.significant[r][c] || self.visited[r][c] {
                        continue;
                    }
                    let bit = self.bit(r, c, plane);
                    let context = self.context(r, c);
                    self.coder.encode(context, bit);
                    if bit == 1 {
                        self.code_sign(r, c, false);
                    }
                }
            }
        }
        self.visited.iter_mut().for_each(|row| row.fill(false));
    }
}

/// A coded code-block: its bit planes and its codeword segments `(passes, bytes)`.
struct Coded {
    planes: u32,
    segments: Vec<(u32, Vec<u8>)>,
}

impl Coded {
    fn passes(&self) -> u32 {
        self.segments.iter().map(|s| s.0).sum()
    }
}

/// `None` for a block whose coefficients are all zero (it is left out of the packets). The passes run from the
/// clean-up of the top plane down; the codeword is cut into segments where the style terminates it: after every pass
/// (TERMALL), or with BYPASS after the tenth pass and then after each raw pair of passes and each clean-up pass.
fn encode_block(coefficients: &[Vec<i32>], band: Band, style: u8) -> Option<Coded> {
    let largest = coefficients.iter().flatten().map(|c| c.unsigned_abs()).max().unwrap_or(0);
    if largest == 0 {
        return None;
    }
    let planes = 32 - largest.leading_zeros();
    let (rows, columns) = (coefficients.len(), coefficients[0].len());
    let mut block = Block {
        magnitude: coefficients.iter().map(|row| row.iter().map(|c| c.unsigned_abs()).collect()).collect(),
        negative: coefficients.iter().map(|row| row.iter().map(|&c| c < 0).collect()).collect(),
        significant: vec![vec![false; columns]; rows],
        visited: vec![vec![false; columns]; rows],
        refined: vec![vec![false; columns]; rows],
        band,
        vsc: style & VSC != 0,
        coder: MqEncoder::new(19, &PRESET),
        raw: HeaderBits::new(),
    };
    let total = 3 * planes - 2;
    let mut segments = Vec::new();
    let mut in_segment = 0;
    for k in 0..total {
        let (plane, kind) = if k == 0 { (planes - 1, 2) } else { (planes - 2 - (k - 1) / 3, (k - 1) % 3) };
        // The passes below the fourth plane from the top, but the clean-up ones, are raw with BYPASS (D.6).
        let raw = style & BYPASS != 0 && kind < 2 && plane + 5 <= planes;
        match kind {
            0 => block.significance_pass(plane, raw),
            1 => block.refinement_pass(plane, raw),
            _ => {
                block.cleanup_pass(plane);
                if style & SEGSYM != 0 {
                    for bit in [1, 0, 1, 0] {
                        block.coder.encode(18, bit);
                    }
                }
            }
        }
        in_segment += 1;
        if style & RESET != 0 && !raw {
            block.coder.reset_states(&PRESET);
        }
        let boundary = style & TERMALL != 0 || (style & BYPASS != 0 && (k == 9 || (k >= 10 && kind != 0)));
        if k + 1 == total || boundary {
            let data = if raw { std::mem::replace(&mut block.raw, HeaderBits::new()).finish() } else { block.coder.terminate() };
            segments.push((in_segment, data));
            in_segment = 0;
        }
    }
    Some(Coded { planes, segments })
}

const NEVER: u32 = 1 << 20;

/// A tag tree (B.10.2) over a grid of leaves, as the encoder keeps it: the value of each node is the least of its
/// children's, and what the decoder has been told of each node so far is its lower bound and whether it is known.
struct TagTree {
    dims: Vec<(usize, usize)>,
    value: Vec<Vec<u32>>,
    low: Vec<Vec<u32>>,
    known: Vec<Vec<bool>>,
}

impl TagTree {
    fn new(width: usize, height: usize, leaves: &[u32]) -> Self {
        let mut dims = vec![(width, height)];
        let mut value = vec![leaves.to_vec()];
        while *dims.last().unwrap() != (1, 1) {
            let (w, h) = *dims.last().unwrap();
            let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
            let mut next = vec![u32::MAX; nw * nh];
            for y in 0..h {
                for x in 0..w {
                    let node = &mut next[(y / 2) * nw + x / 2];
                    *node = (*node).min(value.last().unwrap()[y * w + x]);
                }
            }
            dims.push((nw, nh));
            value.push(next);
        }
        let low = value.iter().map(|v| vec![0; v.len()]).collect();
        let known = value.iter().map(|v| vec![false; v.len()]).collect();
        TagTree { dims, value, low, known }
    }

    /// Tells the decoder, from the root down to leaf `(x, y)`, as much as it needs to know whether the leaf's value is
    /// below `threshold` (and the value itself when it is).
    fn encode(&mut self, bits: &mut HeaderBits, x: usize, y: usize, threshold: u32) {
        let mut low = 0;
        for level in (0..self.dims.len()).rev() {
            let i = (y >> level) * self.dims[level].0 + (x >> level);
            if low > self.low[level][i] {
                self.low[level][i] = low;
            } else {
                low = self.low[level][i];
            }
            while low < threshold {
                if low >= self.value[level][i] {
                    if !self.known[level][i] {
                        bits.put(1);
                        self.known[level][i] = true;
                    }
                    break;
                }
                bits.put(0);
                low += 1;
            }
            self.low[level][i] = low;
        }
    }
}

type Part = (u32, Vec<u8>);

/// One code-block as the packets see it: what each layer contributes (for each codeword segment it touches, the
/// passes and the bytes), the first layer it is in, and the state of its length-bit count (`Lblock`, 3 to begin with).
struct Planned {
    coded: Option<Coded>,
    first_layer: usize,
    included: bool,
    lblock: u32,
    layers: Vec<Vec<Part>>,
}

impl Planned {
    fn new(coded: Option<Coded>, layers: usize, first_layer: usize) -> Self {
        let mut contributions = vec![Vec::new(); layers];
        if let Some(coded) = &coded {
            // The passes are cut evenly over the layers from the first one the block is in; each layer takes at least
            // one. A codeword segment may run over several layers: its bytes are cut in proportion to its passes.
            let total = coded.passes() as usize;
            let cut = |layer: usize| -> usize {
                if layer < first_layer {
                    0
                } else if layer + 1 == layers {
                    total
                } else {
                    (total * (layer + 1 - first_layer) / (layers - first_layer)).max(1)
                }
            };
            let mut start = 0usize;
            for (layer, parts) in contributions.iter_mut().enumerate() {
                let end = cut(layer);
                let mut at = 0usize;
                for (count, bytes) in &coded.segments {
                    let (lo, hi) = (start.max(at), end.min(at + *count as usize));
                    if lo < hi {
                        let (from, to) = (bytes.len() * (lo - at) / *count as usize, bytes.len() * (hi - at) / *count as usize);
                        parts.push(((hi - lo) as u32, bytes[from..to].to_vec()));
                    }
                    at += *count as usize;
                }
                start = end;
            }
        }
        Planned { coded, first_layer, included: false, lblock: 3, layers: contributions }
    }
}

/// The blocks of one band of one precinct and the tag trees over them.
struct BandPlan {
    across: usize,
    blocks: Vec<Planned>,
    inclusion: TagTree,
    zero_planes: TagTree,
}

/// One packet: the code-blocks of the bands of a precinct, for `layer`. Returns the header (with the end-of-header
/// marker when asked) and the body.
fn packet(bands: &mut [BandPlan], layer: usize, eph: bool) -> (Vec<u8>, Vec<u8>) {
    let mut header = HeaderBits::new();
    header.put(1); // a non-empty packet
    let mut body = Vec::new();
    for band in bands.iter_mut() {
        for index in 0..band.blocks.len() {
            let (x, y) = (index % band.across, index / band.across);
            let block = &mut band.blocks[index];
            if block.included {
                header.put(u8::from(!block.layers[layer].is_empty()));
                if block.layers[layer].is_empty() {
                    continue;
                }
            } else {
                band.inclusion.encode(&mut header, x, y, layer as u32 + 1);
                if block.coded.is_none() || block.first_layer != layer {
                    continue;
                }
                block.included = true;
                band.zero_planes.encode(&mut header, x, y, 1000);
            }
            let parts = &block.layers[layer];
            let passes: u32 = parts.iter().map(|p| p.0).sum();
            match passes {
                1 => header.put(0),
                2 => header.put_value(0b10, 2),
                3..=5 => header.put_value(0b1100 | (passes - 3), 4),
                6..=36 => header.put_value((0b1111 << 5) | (passes - 6), 9),
                more => header.put_value((0b1_1111_1111 << 7) | (more - 37), 16),
            }
            // One increase of the length-bit count serves every segment of the packet.
            let increase = parts
                .iter()
                .map(|(count, bytes)| (32 - (bytes.len() as u32).leading_zeros()).saturating_sub(block.lblock + (31 - count.leading_zeros())))
                .max()
                .unwrap_or(0);
            for _ in 0..increase {
                header.put(1);
            }
            header.put(0);
            block.lblock += increase;
            for (count, bytes) in parts {
                header.put_value(bytes.len() as u32, block.lblock + (31 - count.leading_zeros()));
                body.extend_from_slice(bytes);
            }
        }
    }
    let mut out = header.finish();
    if eph {
        out.extend([0xFF, 0x92]);
    }
    (out, body)
}

/// A decomposition level: the three high-pass bands (their rows and columns as the band has them).
struct Level<T> {
    hl: Grid<T>,
    lh: Grid<T>,
    hh: Grid<T>,
}

/// The analysis (F.4.2) of a component of a tile: `plane` has its first sample at the global coordinates
/// (`x0`, `y0`); at each level the columns are lifted and then the rows, and the samples sorted into the four bands by
/// the parity of their global coordinates (even ones are low-pass). Returns the lowest band and the levels, the finest
/// first.
fn decompose<T: Copy + Default>(plane: Grid<T>, x0: usize, y0: usize, count: usize, lift: &dyn Fn(&mut [T], usize)) -> (Grid<T>, Vec<Level<T>>) {
    let (mut current, mut u0, mut v0) = (plane, x0, y0);
    let mut levels = Vec::new();
    for _ in 0..count {
        let (rows, columns) = (current.len(), current.first().map_or(0, Vec::len));
        for c in 0..columns {
            let mut column: Vec<T> = (0..rows).map(|r| current[r][c]).collect();
            lift(&mut column, v0 % 2);
            for r in 0..rows {
                current[r][c] = column[r];
            }
        }
        for row in current.iter_mut() {
            lift(row, u0 % 2);
        }
        // The low-pass samples: global coordinates 2k; the high-pass ones 2k + 1.
        let (low_rows, low_columns) = ((v0 + rows).div_ceil(2) - v0.div_ceil(2), (u0 + columns).div_ceil(2) - u0.div_ceil(2));
        let (high_rows, high_columns) = (rows - low_rows, columns - low_columns);
        let place = |origin: usize, index: usize| -> (bool, usize) {
            let global = origin + index;
            if global % 2 == 0 { (true, global / 2 - origin.div_ceil(2)) } else { (false, (global - 1) / 2 - origin / 2) }
        };
        let blank = |r: usize, c: usize| vec![vec![T::default(); c]; r];
        let (mut ll, mut hl, mut lh, mut hh) =
            (blank(low_rows, low_columns), blank(low_rows, high_columns), blank(high_rows, low_columns), blank(high_rows, high_columns));
        for r in 0..rows {
            let (row_low, ri) = place(v0, r);
            for c in 0..columns {
                let (column_low, ci) = place(u0, c);
                let target = match (row_low, column_low) {
                    (true, true) => &mut ll,
                    (true, false) => &mut hl,
                    (false, true) => &mut lh,
                    (false, false) => &mut hh,
                };
                target[ri][ci] = current[r][c];
            }
        }
        levels.push(Level { hl, lh, hh });
        current = ll;
        u0 = u0.div_ceil(2);
        v0 = v0.div_ceil(2);
    }
    (current, levels)
}
/// The synthesis (F.3.2): the reverse of [`forward`], from the deepest level out, rows first.
fn inverse<T: Copy + Default>(grid: &mut Grid<T>, levels: usize, unlift: &dyn Fn(&mut [T])) {
    for level in (0..levels).rev() {
        let (rows, columns) = (grid.len() >> level, grid[0].len() >> level);
        let old: Grid<T> = grid.iter().take(rows).map(|r| r[..columns].to_vec()).collect();
        for i in 0..rows {
            for j in 0..columns {
                grid[i][j] = old[(i % 2) * rows / 2 + i / 2][(j % 2) * columns / 2 + j / 2];
            }
        }
        for row in grid.iter_mut().take(rows) {
            unlift(&mut row[..columns]);
        }
        for c in 0..columns {
            let mut column: Vec<T> = (0..rows).map(|r| grid[r][c]).collect();
            unlift(&mut column);
            for r in 0..rows {
                grid[r][c] = column[r];
            }
        }
    }
}

/// The reversible 5-3 analysis of F.4.8.2 for a line whose first sample has the global coordinate parity `first`:
/// the odd-numbered samples become high-pass, then the even ones low-pass, with whole-sample symmetric extension at the
/// ends; one sample on its own is kept (even position) or doubled (odd position).
fn analyse_53(signal: &mut [i32], first: usize) {
    let n = signal.len();
    if n == 1 {
        if first == 1 {
            signal[0] *= 2;
        }
        return;
    }
    let mirror = |i: isize| -> usize { if i < 0 { (-i) as usize } else if i >= n as isize { (2 * (n as isize - 1) - i) as usize } else { i as usize } };
    for parity in [1, 0] {
        for i in (0..n).filter(|i| (i + first) % 2 == parity) {
            let sum = signal[mirror(i as isize - 1)] + signal[mirror(i as isize + 1)];
            if parity == 1 {
                signal[i] -= sum.div_euclid(2);
            } else {
                signal[i] += (sum + 2).div_euclid(4);
            }
        }
    }
}
const ALPHA: f64 = -1.586_134_342_059_924;
const BETA: f64 = -0.052_980_118_572_961;
const GAMMA: f64 = 0.882_911_075_530_934;
const DELTA: f64 = 0.443_506_852_043_971;
const K: f64 = 1.230_174_104_914_001;

/// Index `i` of a signal of length `n` with whole-sample symmetric extension (it keeps the parity of `i`).
fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    (if i < 0 {
        -i
    } else if i >= n {
        2 * (n - 1) - i
    } else {
        i
    }) as usize
}

/// One lifting step: samples of the parity `parity` get `factor` times the sum of their two neighbours.
fn step(signal: &mut [f64], parity: usize, factor: f64) {
    let n = signal.len();
    for i in (parity..n).step_by(2) {
        signal[i] += factor * (signal[reflect(i as isize - 1, n)] + signal[reflect(i as isize + 1, n)]);
    }
}

/// The irreversible 9-7 analysis of F.4.8.2 for a line whose first sample has the global coordinate parity `first`:
/// four lifting steps, then the scaling of the two bands. A single sample is kept at an even position and doubled at an
/// odd one (F.4.8.1: the synthesis halves it).
fn analyse_97(signal: &mut [f64], first: usize) {
    if signal.len() == 1 {
        if first == 1 {
            signal[0] *= 2.0;
        }
        return;
    }
    let odd = (1 + first) % 2;
    step(signal, odd, ALPHA);
    step(signal, 1 - odd, BETA);
    step(signal, odd, GAMMA);
    step(signal, 1 - odd, DELTA);
    for (i, sample) in signal.iter_mut().enumerate() {
        *sample *= if (i + first) % 2 == 1 { K } else { 1.0 / K };
    }
}
/// The 9-7 synthesis of F.3.8.2: the scaling undone, then the lifting steps in reverse.
fn synthesise_97(signal: &mut [f64]) {
    for (i, sample) in signal.iter_mut().enumerate() {
        *sample *= if i % 2 == 1 { 1.0 / K } else { K };
    }
    step(signal, 0, -DELTA);
    step(signal, 1, -GAMMA);
    step(signal, 0, -BETA);
    step(signal, 1, -ALPHA);
}

const GUARD_BITS: u32 = 4;

/// The band of the coefficient at `(r, c)` of the layout [`forward`] leaves: its decomposition level (1 the finest,
/// `levels` the coarsest) and kind (0 LL, 1 HL, 2 LH, 3 HH).
fn band_of(r: usize, c: usize, rows: usize, columns: usize, levels: usize) -> (usize, usize) {
    for level in 1..=levels {
        let (half_rows, half_columns) = (rows >> level, columns >> level);
        if r >= half_rows || c >= half_columns {
            return (level, usize::from(c >= half_columns) + 2 * usize::from(r >= half_rows));
        }
    }
    (levels, 0)
}

/// The exponent and mantissa of the quantization of band `kind` in resolution `resolution` (0 for LL): with the
/// reversible path no quantization, the exponent the precision and the high-pass gain give plus two (chroma of the
/// colour transform); with the irreversible path either exponents for every band (the step is 2^-3) or one for LL and
/// the others derived from it (E.5), with the mantissa 0x400, which makes the step one and a half times larger.
fn quantizer(precision: u32, kind: usize, resolution: usize, irreversible: bool, derived: bool) -> (u32, u32) {
    let gain = [0, 1, 1, 2][kind];
    match (irreversible, derived) {
        (false, _) => (precision + 2 + gain, 0),
        (true, false) => (precision + 3 + gain, 0),
        (true, true) => (precision + 5 - resolution.saturating_sub(1) as u32, 0x400),
    }
}

/// The step the coefficients of a band of the irreversible path are quantized with (E.3).
fn irreversible_step(precision: u32, kind: usize, resolution: usize, derived: bool) -> f64 {
    let (exponent, mantissa) = quantizer(precision, kind, resolution, true, derived);
    let gain = [0, 1, 1, 2][kind];
    (1.0 + f64::from(mantissa) / 2048.0) * 2f64.powi(precision as i32 + gain - exponent as i32)
}

/// The most a pixel can be off after quantizing every coefficient with its band's step (a coefficient is wrong by
/// less than one step): the largest sum, over the pixels, of the absolute values of the synthesis of each single
/// coefficient times its step (the synthesis is linear, so the sum bounds the effect of any set of such errors).
pub fn synthesis_error(rows: usize, columns: usize, levels: usize, precision: u32, derived: bool) -> f64 {
    let mut total = vec![vec![0.0f64; columns]; rows];
    for r in 0..rows {
        for c in 0..columns {
            let (level, kind) = band_of(r, c, rows, columns, levels);
            let resolution = if kind == 0 { 0 } else { levels - level + 1 };
            let step = irreversible_step(precision, kind, resolution, derived);
            let mut impulse = vec![vec![0.0f64; columns]; rows];
            impulse[r][c] = 1.0;
            inverse(&mut impulse, levels, &synthesise_97);
            for (t, i) in total.iter_mut().flatten().zip(impulse.iter().flatten()) {
                *t += step * i.abs();
            }
        }
    }
    total.iter().flatten().fold(0.0f64, |a, &b| a.max(b))
}

/// The bound of a single 9-7 component with the exponents for every band, 8 bits: the synthesis error and half a level
/// for the rounding of the output.
pub fn irreversible_bound(rows: usize, columns: usize, levels: usize) -> f64 {
    synthesis_error(rows, columns, levels, 8, false) + 0.5
}

/// The 9-7 synthesis of a line whose first sample has the global coordinate parity `first`.
fn synthesise_97_at(signal: &mut [f64], first: usize) {
    if signal.len() == 1 {
        if first == 1 {
            signal[0] /= 2.0;
        }
        return;
    }
    for (i, sample) in signal.iter_mut().enumerate() {
        *sample *= if (i + first) % 2 == 1 { 1.0 / K } else { K };
    }
    let odd = (1 + first) % 2;
    step(signal, 1 - odd, -DELTA);
    step(signal, odd, -GAMMA);
    step(signal, 1 - odd, -BETA);
    step(signal, odd, -ALPHA);
}

/// The synthesis (F.3.2) that undoes [`decompose`] for a plane of `rows` x `columns` samples whose first has the global
/// coordinates (`x0`, `y0`): at each level from the coarsest the four bands are interleaved by the parity of the global
/// coordinates and the rows and then the columns are unlifted.
fn recompose(ll: Grid<f64>, levels: &[Level<f64>], rows: usize, columns: usize, origin: (usize, usize)) -> Grid<f64> {
    let mut current = ll;
    for k in (0..levels.len()).rev() {
        let (u0, v0) = (ceil_shift(origin.0 as i64, k as u32) as usize, ceil_shift(origin.1 as i64, k as u32) as usize);
        let (region_rows, region_columns) =
            (ceil_shift((origin.1 + rows) as i64, k as u32) as usize - v0, ceil_shift((origin.0 + columns) as i64, k as u32) as usize - u0);
        let place = |first: usize, index: usize| -> (bool, usize) {
            let global = first + index;
            if global % 2 == 0 { (true, global / 2 - first.div_ceil(2)) } else { (false, (global - 1) / 2 - first / 2) }
        };
        let mut region = vec![vec![0.0f64; region_columns]; region_rows];
        for (r, row) in region.iter_mut().enumerate() {
            let (row_low, ri) = place(v0, r);
            for (c, sample) in row.iter_mut().enumerate() {
                let (column_low, ci) = place(u0, c);
                *sample = match (row_low, column_low) {
                    (true, true) => current[ri][ci],
                    (true, false) => levels[k].hl[ri][ci],
                    (false, true) => levels[k].lh[ri][ci],
                    (false, false) => levels[k].hh[ri][ci],
                };
            }
        }
        for row in region.iter_mut() {
            synthesise_97_at(row, u0 % 2);
        }
        for c in 0..region_columns {
            let mut column: Vec<f64> = (0..region_rows).map(|r| region[r][c]).collect();
            synthesise_97_at(&mut column, v0 % 2);
            for r in 0..region_rows {
                region[r][c] = column[r];
            }
        }
        current = region;
    }
    current
}

/// The most a pixel can be off after the 9-7 path of a `rows` x `columns` plane at `origin` (any size): the same bound as
/// [`irreversible_bound`], with the synthesis of every single coefficient found by running [`recompose`].
pub fn general_bound(rows: usize, columns: usize, levels: usize, origin: (usize, usize)) -> f64 {
    let zero = vec![vec![0.0f64; columns]; rows];
    let (ll, bands) = decompose(zero, origin.0, origin.1, levels, &analyse_97);
    let mut total = vec![vec![0.0f64; columns]; rows];
    let mut add = |ll: &Grid<f64>, bands: &[Level<f64>], step: f64| {
        let synthesised = recompose(ll.clone(), bands, rows, columns, origin);
        for (t, s) in total.iter_mut().flatten().zip(synthesised.iter().flatten()) {
            *t += step * s.abs();
        }
    };
    let impulse = |grid: &Grid<f64>, r: usize, c: usize| -> Grid<f64> {
        let mut copy = vec![vec![0.0f64; grid.first().map_or(0, Vec::len)]; grid.len()];
        copy[r][c] = 1.0;
        copy
    };
    let blank = |bands: &[Level<f64>]| -> Vec<Level<f64>> {
        bands.iter().map(|l| Level { hl: l.hl.iter().map(|r| vec![0.0; r.len()]).collect(), lh: l.lh.iter().map(|r| vec![0.0; r.len()]).collect(), hh: l.hh.iter().map(|r| vec![0.0; r.len()]).collect() }).collect()
    };
    let step_of = |kind: usize, resolution: usize| irreversible_step(8, kind, resolution, false);
    for r in 0..ll.len() {
        for c in 0..ll[0].len() {
            add(&impulse(&ll, r, c), &blank(&bands), step_of(0, 0));
        }
    }
    for k in 0..levels {
        for kind in 1..4 {
            let grid = match kind {
                1 => &bands[k].hl,
                2 => &bands[k].lh,
                _ => &bands[k].hh,
            };
            for r in 0..grid.len() {
                for c in 0..grid.first().map_or(0, Vec::len) {
                    let mut at = blank(&bands);
                    let target = match kind {
                        1 => &mut at[k].hl,
                        2 => &mut at[k].lh,
                        _ => &mut at[k].hh,
                    };
                    target[r][c] = 1.0;
                    add(&vec![vec![0.0f64; ll.first().map_or(0, Vec::len)]; ll.len()], &at, step_of(kind, levels - k));
                }
            }
        }
    }
    total.iter().flatten().fold(0.0f64, |a, &b| a.max(b)) + 0.5
}
#[derive(Clone, Copy, PartialEq)]
pub enum Packed {
    No,
    /// PPM: the packet headers of every tile-part in the main header.
    Main,
    /// PPT: the packet headers of a tile-part in its header.
    Tile,
}

#[derive(Clone)]
pub struct Settings {
    pub levels: usize,
    /// The 9-7 transform with scalar quantization; otherwise the reversible 5-3 transform.
    pub irreversible: bool,
    pub layers: usize,
    /// Precincts of 8 x 8 samples at the lowest resolution and 16 x 16 at the others.
    pub precincts: bool,
    /// The code-block size as a power of two; by default 64, or 8 with precincts.
    pub block: Option<u32>,
    /// The code-block style bits.
    pub style: u8,
    /// 0 LRCP, 1 RLCP, 2 RPCL, 3 PCRL, 4 CPRL.
    pub progression: u8,
    pub sop: bool,
    pub eph: bool,
    pub packed: Packed,
    /// The tile size; by default one tile.
    pub tile: Option<(usize, usize)>,
    /// The tile-parts each tile is cut into.
    pub parts: usize,
    /// Progression order changes: first resolution, first component, layers, last resolution, last component (the
    /// last two exclusive), progression.
    pub poc: Vec<[usize; 6]>,
    /// Derived quantization (one step for LL, the others from it) with the irreversible path.
    pub derived: bool,
    /// A region-of-interest shift on the upper half of the coefficients of every component.
    pub roi: bool,
    pub precision: u32,
    pub signed: bool,
    /// Sampling factors of the components; by default 1.
    pub subsampling: Vec<(usize, usize)>,
    /// The levels and code-block style of components that differ from the others (COC and QCC).
    pub components: Vec<(usize, u8)>,
    /// The component transform for three components of one size.
    pub colour: bool,
    /// The informative markers: tile-part lengths (TLM), packet lengths (PLT), a comment (COM) and the component
    /// registration (CRG).
    pub side_markers: bool,
    /// The tile-parts in the order of their index first, so that the parts of different tiles alternate.
    pub interleave: bool,
    /// The offset of the image area on the reference grid (XOsiz, YOsiz) and of the tile grid (XTOsiz, YTOsiz).
    pub origin: (usize, usize),
    pub tile_origin: (usize, usize),
    /// A COD and QCD in the header of the first tile-part of a tile with this many levels (for every component), by tile.
    pub tile_levels: Vec<Option<usize>>,
    /// A POC in the header of tile 1.
    pub tile_poc: Vec<[usize; 6]>,
    /// The last tile-part has the length 0 (it runs to the end of the codestream).
    pub open_ended: bool,
    /// The packed packet headers cut into two markers, the second one first.
    pub split_markers: bool,
    /// The form of the tile-part length marker: 0 tile numbers of 8 bits and lengths of 32, 1 no tile numbers and 16 bit
    /// lengths, 2 tile numbers of 16 bits and 16 bit lengths.
    pub tlm_variant: u8,
}

impl Settings {
    pub fn reversible(levels: usize) -> Self {
        Settings {
            levels,
            irreversible: false,
            layers: 1,
            precincts: false,
            block: None,
            style: 0,
            progression: 0,
            sop: false,
            eph: false,
            packed: Packed::No,
            tile: None,
            parts: 1,
            poc: Vec::new(),
            derived: false,
            roi: false,
            precision: 8,
            signed: false,
            subsampling: Vec::new(),
            components: Vec::new(),
            colour: true,
            side_markers: false,
            interleave: false,
            origin: (0, 0),
            tile_origin: (0, 0),
            tile_levels: Vec::new(),
            tile_poc: Vec::new(),
            open_ended: false,
            split_markers: false,
            tlm_variant: 0,
        }
    }
}

fn precinct_exponent(settings: &Settings, resolution: usize) -> u32 {
    match (settings.precincts, resolution) {
        (false, _) => 15,
        (true, 0) => 3,
        (true, _) => 4,
    }
}

fn block_exponent(settings: &Settings) -> u32 {
    settings.block.unwrap_or(if settings.precincts { 3 } else { 6 })
}

struct ResolutionPlan {
    precincts: Vec<Vec<BandPlan>>,
    across: usize,
    exponent: u32,
}

struct ComponentPlan {
    levels: usize,
    resolutions: Vec<ResolutionPlan>,
}

fn ceil_shift(value: i64, shift: u32) -> i64 {
    (value + (1i64 << shift) - 1) >> shift
}

/// Cuts the coefficients of a component of a tile into precincts and code-blocks (B.6, B.7) and codes the blocks. `ll`
/// and `bands` are what [`decompose`] gave; `bounds` is the part of the tile on the component's own grid, (x0, y0, x1,
/// y1). `shift` is the region-of-interest shift: it raises the number of planes the bands allow.
fn plan_component(ll: &Grid<i32>, bands: &[Level<i32>], bounds: (usize, usize, usize, usize), style: u8, settings: &Settings, shift: u32) -> ComponentPlan {
    let levels = bands.len();
    let (cx0, cy0, cx1, cy1) = (bounds.0 as i64, bounds.1 as i64, bounds.2 as i64, bounds.3 as i64);
    let mut counter = 0usize;
    let mut resolutions = Vec::new();
    for resolution in 0..=levels {
        let kinds: &[usize] = if resolution == 0 { &[0] } else { &[1, 2, 3] };
        let down = (levels - resolution) as u32;
        let (rx0, ry0, rx1, ry1) = (ceil_shift(cx0, down), ceil_shift(cy0, down), ceil_shift(cx1, down), ceil_shift(cy1, down));
        let exponent = precinct_exponent(settings, resolution);
        let across = if rx0 == rx1 { 0 } else { (ceil_shift(rx1, exponent) - (rx0 >> exponent)) as usize };
        let rows_of_precincts = if ry0 == ry1 { 0 } else { (ceil_shift(ry1, exponent) - (ry0 >> exponent)) as usize };
        let (tlx, tly) = ((rx0 >> exponent) << exponent, (ry0 >> exponent) << exponent);
        // A precinct covers 2^exponent samples of the resolution: half as many of each band above resolution 0.
        let cell_exponent = if resolution == 0 { exponent } else { exponent - 1 };
        let block_shift = block_exponent(settings).min(cell_exponent);
        let (cell_x, cell_y) = if resolution == 0 { (tlx, tly) } else { (ceil_shift(tlx, 1), ceil_shift(tly, 1)) };
        let mut precincts = Vec::new();
        for p in 0..across * rows_of_precincts {
            let (px, py) = ((p % across) as i64, (p / across) as i64);
            let mut band_plans = Vec::new();
            for &kind in kinds {
                // The band's own rectangle (B.5), the part of it in this precinct, and the grid of its coefficients.
                let (bx0, by0, bx1, by1) = if resolution == 0 {
                    (rx0, ry0, rx1, ry1)
                } else {
                    let (xb, yb) = ((kind & 1) as i64, (kind >> 1) as i64);
                    (
                        ceil_shift(cx0 - (xb << down), down + 1),
                        ceil_shift(cy0 - (yb << down), down + 1),
                        ceil_shift(cx1 - (xb << down), down + 1),
                        ceil_shift(cy1 - (yb << down), down + 1),
                    )
                };
                let grid = match kind {
                    0 => ll,
                    1 => &bands[levels - resolution].hl,
                    2 => &bands[levels - resolution].lh,
                    _ => &bands[levels - resolution].hh,
                };
                let (gx, gy) = (cell_x + (px << cell_exponent), cell_y + (py << cell_exponent));
                let (qx0, qy0) = (gx.max(bx0), gy.max(by0));
                let (qx1, qy1) = ((gx + (1 << cell_exponent)).min(bx1), (gy + (1 << cell_exponent)).min(by1));
                let magnitude_bits = GUARD_BITS + quantizer(settings.precision, kind, resolution, settings.irreversible, settings.derived).0 - 1 + shift;
                let kinds_of_band = [Band::Ll, Band::Hl, Band::Lh, Band::Hh];
                let (mut blocks, mut leaves, mut zeros) = (Vec::new(), Vec::new(), Vec::new());
                let (mut block_columns, mut block_rows) = (0usize, 0usize);
                if qx1 > qx0 && qy1 > qy0 {
                    let (first_x, first_y) = (qx0 >> block_shift, qy0 >> block_shift);
                    block_columns = (ceil_shift(qx1, block_shift) - first_x) as usize;
                    block_rows = (ceil_shift(qy1, block_shift) - first_y) as usize;
                    for ky in 0..block_rows as i64 {
                        for kx in 0..block_columns as i64 {
                            let x_from = ((first_x + kx) << block_shift).max(qx0);
                            let x_to = ((first_x + kx + 1) << block_shift).min(qx1);
                            let y_from = ((first_y + ky) << block_shift).max(qy0);
                            let y_to = ((first_y + ky + 1) << block_shift).min(qy1);
                            let cut: Grid<i32> = (y_from..y_to)
                                .map(|y| (x_from..x_to).map(|x| grid[(y - by0) as usize][(x - bx0) as usize]).collect())
                                .collect();
                            let coded = encode_block(&cut, kinds_of_band[kind], style);
                            let first_layer = usize::from(settings.layers > 1 && counter % 3 == 1);
                            counter += 1;
                            leaves.push(if coded.is_some() { first_layer as u32 } else { NEVER });
                            zeros.push(coded.as_ref().map_or(magnitude_bits, |c| magnitude_bits - c.planes));
                            blocks.push(Planned::new(coded, settings.layers, first_layer));
                        }
                    }
                }
                let (tree_columns, tree_rows) = (block_columns.max(1), block_rows.max(1));
                if blocks.is_empty() {
                    leaves.push(NEVER);
                    zeros.push(0);
                }
                band_plans.push(BandPlan {
                    across: tree_columns,
                    blocks,
                    inclusion: TagTree::new(tree_columns, tree_rows, &leaves),
                    zero_planes: TagTree::new(tree_columns, tree_rows, &zeros),
                });
            }
            precincts.push(band_plans);
        }
        resolutions.push(ResolutionPlan { precincts, across, exponent });
    }
    ComponentPlan { levels, resolutions }
}
/// The packet order of the progression `progression` over the ranges of a progression change (T.800 B.12): packets
/// are `(layer, resolution, component, precinct)`. The position-based orders visit the precincts by the place of their
/// first sample on the reference grid.
fn progression(
    plans: &[ComponentPlan],
    sampling: &[(usize, usize)],
    layers: usize,
    progression: u8,
    ranges: [usize; 4],
) -> Vec<(usize, usize, usize, usize)> {
    let [res0, comp0, res1, comp1] = ranges;
    let mut keyed = Vec::new();
    for (c, plan) in plans.iter().enumerate().take(comp1).skip(comp0) {
        for (r, resolution) in plan.resolutions.iter().enumerate().take(res1).skip(res0) {
            for p in 0..resolution.precincts.len() {
                let (px, py) = (p % resolution.across, p / resolution.across);
                let up = plan.levels - r;
                let (x, y) = (((px << resolution.exponent) << up) * sampling[c].0, ((py << resolution.exponent) << up) * sampling[c].1);
                // A precinct of the lowest resolution starts where its first sample does; the others likewise.
                let (x, y) = if resolution.exponent == 15 { (0, 0) } else { (x, y) };
                for l in 0..layers {
                    let key = match progression {
                        0 => [l, r, c, p, 0],
                        1 => [r, l, c, p, 0],
                        2 => [r, y, x, c, l],
                        3 => [y, x, c, r, l],
                        _ => [c, y, x, r, l],
                    };
                    keyed.push((key, (l, r, c, p)));
                }
            }
        }
    }
    keyed.sort();
    keyed.into_iter().map(|(_, id)| id).collect()
}

struct Packet {
    header: Vec<u8>,
    body: Vec<u8>,
}

fn marker(code: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![0xFF, code];
    out.extend(((body.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(body);
    out
}

fn precinct_bytes(settings: &Settings, levels: usize) -> Vec<u8> {
    if settings.precincts {
        (0..=levels).map(|r| ((precinct_exponent(settings, r) << 4) | precinct_exponent(settings, r)) as u8).collect()
    } else {
        Vec::new()
    }
}

/// The SPcod / SPcoc parameters: levels, code-block size exponents (minus two), style, transform, precincts.
fn coding_parameters(settings: &Settings, levels: usize, style: u8) -> Vec<u8> {
    let exponent = block_exponent(settings) as u8 - 2;
    let mut out = vec![levels as u8, exponent, exponent, style, u8::from(!settings.irreversible)];
    out.extend(precinct_bytes(settings, levels));
    out
}

/// The SPqcd / SPqcc parameters of a component with `levels` levels: the guard bits and style, then the exponents
/// (and mantissas) of the bands in the order LL, then HL, LH, HH of each resolution.
fn quantization_parameters(settings: &Settings, levels: usize) -> Vec<u8> {
    let style = match (settings.irreversible, settings.derived) {
        (false, _) => 0,
        (true, false) => 2,
        (true, true) => 1,
    };
    let mut out = vec![((GUARD_BITS << 5) as u8) | style];
    let bands: Vec<(usize, usize)> = std::iter::once((0, 0)).chain((1..=levels).flat_map(|r| (1..4).map(move |k| (k, r)))).collect();
    let bands = if settings.derived && settings.irreversible { &bands[..1] } else { &bands[..] };
    for &(kind, resolution) in bands {
        let (exponent, mantissa) = quantizer(settings.precision, kind, resolution, settings.irreversible, settings.derived);
        if settings.irreversible {
            out.extend(((exponent << 11 | mantissa) as u16).to_be_bytes());
        } else {
            out.push((exponent << 3) as u8);
        }
    }
    out
}

/// A codestream of the planes (rows of samples, each component its own size) coded as `settings` ask. Sizes are
/// divisible by `2^levels`, and a tile's size and offsets by what keeps the code-block grid of a tile that of the
/// image (a tile size that is a multiple of the code-block size times `2^levels`).
pub fn encode_samples(planes: &[Grid<i32>], settings: &Settings) -> Vec<u8> {
    let count = planes.len();
    let sampling = |c: usize| settings.subsampling.get(c).copied().unwrap_or((1, 1));
    let component = |c: usize| settings.components.get(c).copied().unwrap_or((settings.levels, settings.style));
    let (origin_x, origin_y) = settings.origin;
    let (tile_origin_x, tile_origin_y) = settings.tile_origin;
    // The reference grid is the first component's, which is sampled at every point.
    let (reference_rows, reference_columns) = (planes[0].len() * sampling(0).1, planes[0][0].len() * sampling(0).0);
    let (end_x, end_y) = (origin_x + reference_columns, origin_y + reference_rows);
    let (tile_width, tile_height) = settings.tile.unwrap_or((end_x - tile_origin_x, end_y - tile_origin_y));    let colour = settings.colour
        && count == 3
        && planes.iter().all(|p| p.len() == planes[0].len() && p[0].len() == planes[0][0].len());
    let level_shift = if settings.signed { 0 } else { 1 << (settings.precision - 1) };
    let roi_shift = if settings.roi { settings.precision + 4 } else { 0 };
    let sampling_all: Vec<(usize, usize)> = (0..count).map(sampling).collect();

    // The packets of each tile, in the order of the progression.
    let mut tiles: Vec<Vec<Packet>> = Vec::new();
    for ty in 0..(end_y - tile_origin_y).div_ceil(tile_height) {
        for tx in 0..(end_x - tile_origin_x).div_ceil(tile_width) {
            let tile_x0 = (tile_origin_x + tx * tile_width).max(origin_x);
            let tile_y0 = (tile_origin_y + ty * tile_height).max(origin_y);
            let tile_x1 = (tile_origin_x + (tx + 1) * tile_width).min(end_x);
            let tile_y1 = (tile_origin_y + (ty + 1) * tile_height).min(end_y);
            // The tile's part of each component on the component's own grid.
            let bounds: Vec<(usize, usize, usize, usize)> = (0..count)
                .map(|c| {
                    let (dx, dy) = sampling(c);
                    (tile_x0.div_ceil(dx), tile_y0.div_ceil(dy), tile_x1.div_ceil(dx), tile_y1.div_ceil(dy))
                })
                .collect();
            let mut shifted: Vec<Grid<i32>> = (0..count)
                .map(|c| {
                    let (dx, dy) = sampling(c);
                    let (x0, y0, x1, y1) = bounds[c];
                    let (first_x, first_y) = (origin_x.div_ceil(dx), origin_y.div_ceil(dy));
                    (y0..y1).map(|y| (x0..x1).map(|x| planes[c][y - first_y][x - first_x] - level_shift).collect()).collect()
                })
                .collect();
            let (rows, columns) = (shifted[0].len(), shifted[0][0].len());
            let mut floats: Vec<Grid<f64>> = Vec::new();
            if settings.irreversible {
                floats = shifted.iter().map(|p| p.iter().map(|row| row.iter().map(|&v| f64::from(v)).collect()).collect()).collect();
                if colour {
                    for r in 0..rows {
                        for c in 0..columns {
                            let (red, green, blue) = (floats[0][r][c], floats[1][r][c], floats[2][r][c]);
                            floats[0][r][c] = 0.299 * red + 0.587 * green + 0.114 * blue;
                            floats[1][r][c] = -0.168_75 * red - 0.331_26 * green + 0.5 * blue;
                            floats[2][r][c] = 0.5 * red - 0.418_69 * green - 0.081_31 * blue;
                        }
                    }
                }
            } else if colour {
                for r in 0..rows {
                    for c in 0..columns {
                        let (red, green, blue) = (shifted[0][r][c], shifted[1][r][c], shifted[2][r][c]);
                        shifted[0][r][c] = (red + 2 * green + blue).div_euclid(4);
                        shifted[1][r][c] = blue - green;
                        shifted[2][r][c] = red - green;
                    }
                }
            }
            let tile_index = tiles.len();
            let tile_levels = settings.tile_levels.get(tile_index).copied().flatten();
            let mut plans: Vec<ComponentPlan> = (0..count)
                .map(|c| {
                    let (levels, style) = tile_levels.map_or_else(|| component(c), |l| (l, settings.style));
                    let (x0, y0, _, _) = bounds[c];
                    let (mut ll, mut bands): (Grid<i32>, Vec<Level<i32>>) = if settings.irreversible {
                        let (ll, bands) = decompose(floats[c].clone(), x0, y0, levels, &analyse_97);
                        let quantize = |grid: &Grid<f64>, kind: usize, resolution: usize| -> Grid<i32> {
                            let step = irreversible_step(settings.precision, kind, resolution, settings.derived);
                            grid.iter().map(|row| row.iter().map(|&v| (v.abs() / step).floor() as i32 * if v < 0.0 { -1 } else { 1 }).collect()).collect()
                        };
                        // The finest level is resolution `levels`.
                        let levels_quantized = bands
                            .iter()
                            .enumerate()
                            .map(|(i, l)| Level { hl: quantize(&l.hl, 1, levels - i), lh: quantize(&l.lh, 2, levels - i), hh: quantize(&l.hh, 3, levels - i) })
                            .collect();
                        (quantize(&ll, 0, 0), levels_quantized)
                    } else {
                        decompose(shifted[c].clone(), x0, y0, levels, &analyse_53)
                    };
                    if settings.roi {
                        // Max-shift: the lowest band and the horizontally high-pass ones are raised by the shift; the
                        // others stay smaller than half the smallest raised value.
                        for grid in std::iter::once(&mut ll).chain(bands.iter_mut().map(|l| &mut l.hl)) {
                            grid.iter_mut().flatten().for_each(|v| *v <<= roi_shift);
                        }
                    }
                    plan_component(&ll, &bands, bounds[c], style, settings, roi_shift)
                })
                .collect();            let layers = settings.layers;
            let mut order = Vec::new();
            let mut seen = std::collections::HashSet::new();
            let changes: Vec<[usize; 6]> = if tile_index == 1 && !settings.tile_poc.is_empty() {
                settings.tile_poc.clone()
            } else if settings.poc.is_empty() {
                vec![[0, 0, layers, 33, count, usize::from(settings.progression)]]
            } else {
                settings.poc.clone()
            };
            for [res0, comp0, layer1, res1, comp1, prog] in changes {
                for id in progression(&plans, &sampling_all, layer1.min(layers), prog as u8, [res0, comp0, res1, comp1.min(count)]) {
                    if seen.insert(id) {
                        order.push(id);
                    }
                }
            }
            tiles.push(
                order
                    .into_iter()
                    .map(|(l, r, c, p)| {
                        let (header, body) = packet(&mut plans[c].resolutions[r].precincts[p], l, settings.eph);
                        Packet { header, body }
                    })
                    .collect(),
            );
        }
    }

    // The main header.
    let mut out = vec![0xFF, 0x4F];
    let mut siz = vec![0, 0];
    for value in [end_x, end_y, origin_x, origin_y, tile_width, tile_height, tile_origin_x, tile_origin_y] {
        siz.extend((value as u32).to_be_bytes());
    }
    siz.extend((count as u16).to_be_bytes());
    for c in 0..count {
        siz.extend([(settings.precision as u8 - 1) | (u8::from(settings.signed) << 7), sampling(c).0 as u8, sampling(c).1 as u8]);
    }
    out.extend(marker(0x51, &siz));
    let scod = u8::from(settings.precincts) | (u8::from(settings.sop) << 1) | (u8::from(settings.eph) << 2);
    let cod_for = |levels: usize| {
        let mut cod = vec![scod, settings.progression];
        cod.extend((settings.layers as u16).to_be_bytes());
        cod.push(u8::from(colour));
        cod.extend(coding_parameters(settings, levels, settings.style));
        marker(0x52, &cod)
    };
    // Component numbers are two bytes when there are 257 components or more.
    let component_number = |c: usize| -> Vec<u8> { if count >= 257 { (c as u16).to_be_bytes().to_vec() } else { vec![c as u8] } };
    let poc_bytes = |changes: &[[usize; 6]]| -> Vec<u8> {
        let mut poc = Vec::new();
        for &[res0, comp0, layer1, res1, comp1, prog] in changes {
            poc.push(res0 as u8);
            poc.extend(component_number(comp0));
            poc.extend((layer1 as u16).to_be_bytes());
            poc.push(res1 as u8);
            poc.extend(component_number(comp1));
            poc.push(prog as u8);
        }
        poc
    };
    out.extend(cod_for(settings.levels));
    out.extend(marker(0x5C, &quantization_parameters(settings, settings.levels)));
    for c in 0..count {
        let (levels, style) = component(c);
        if (levels, style) != (settings.levels, settings.style) {
            let mut coc = component_number(c);
            coc.push(u8::from(settings.precincts));
            coc.extend(coding_parameters(settings, levels, style));
            out.extend(marker(0x53, &coc));
            let mut qcc = component_number(c);
            qcc.extend(quantization_parameters(settings, levels));
            out.extend(marker(0x5D, &qcc));
        }
        if settings.roi {
            let mut rgn = component_number(c);
            rgn.extend([0, roi_shift as u8]);
            out.extend(marker(0x5E, &rgn));
        }
    }
    if !settings.poc.is_empty() {
        out.extend(marker(0x5F, &poc_bytes(&settings.poc)));
    }

    // The tile-parts: each tile's packets cut into `parts` runs of whole packets.
    struct Part {
        tile: usize,
        index: usize,
        of: usize,
        headers: Vec<u8>,
        body: Vec<u8>,
        lengths: Vec<usize>,
    }
    let mut parts = Vec::new();
    for (tile, packets) in tiles.iter().enumerate() {
        let of = settings.parts.min(packets.len());
        let mut numbered = 0usize;
        for index in 0..of {
            let run = &packets[packets.len() * index / of..packets.len() * (index + 1) / of];
            let (mut headers, mut body, mut lengths) = (Vec::new(), Vec::new(), Vec::new());
            for packet in run {
                let before = body.len();
                if settings.sop {
                    body.extend([0xFF, 0x91, 0, 4]);
                    body.extend((numbered as u16).to_be_bytes());
                }
                numbered += 1;
                if settings.packed == Packed::No {
                    body.extend_from_slice(&packet.header);
                } else {
                    headers.extend_from_slice(&packet.header);
                }
                body.extend_from_slice(&packet.body);
                lengths.push(body.len() - before);
            }
            parts.push(Part { tile, index, of, headers, body, lengths });
        }
    }
    if settings.interleave {
        parts.sort_by_key(|part| (part.index, part.tile));
    }
    // Each tile-part's length: its SOT segment, header markers, SOD and body.
    let packet_lengths = |part: &Part| -> Vec<u8> {
        let mut plt = vec![0u8];
        for &length in &part.lengths {
            let groups: Vec<u8> = (0..5).rev().map(|i| ((length >> (7 * i)) & 0x7F) as u8).skip_while(|&g| g == 0).collect();
            let groups = if groups.is_empty() { vec![0] } else { groups };
            let last = groups.len() - 1;
            plt.extend(groups.iter().enumerate().map(|(i, g)| if i == last { *g } else { g | 0x80 }));
        }
        plt
    };
    let part_header = |part: &Part| -> Vec<u8> {
        let mut header = Vec::new();
        if settings.side_markers {
            header.extend(marker(0x58, &packet_lengths(part)));
        }
        if part.index == 0 {
            if let Some(Some(levels)) = settings.tile_levels.get(part.tile) {
                header.extend(cod_for(*levels));
                header.extend(marker(0x5C, &quantization_parameters(settings, *levels)));
            }
            if part.tile == 1 && !settings.tile_poc.is_empty() {
                header.extend(marker(0x5F, &poc_bytes(&settings.tile_poc)));
            }
        }
        if settings.packed == Packed::Tile {
            let halves: Vec<(u8, &[u8])> = if settings.split_markers {
                let middle = part.headers.len() / 2;
                vec![(1, &part.headers[middle..]), (0, &part.headers[..middle])]
            } else {
                vec![(0, &part.headers[..])]
            };
            for (z, bytes) in halves {
                let mut ppt = vec![z];
                ppt.extend_from_slice(bytes);
                header.extend(marker(0x61, &ppt));
            }
        }
        header
    };
    if settings.side_markers {
        let mut tlm = vec![0, [0b0101_0000, 0b0000_0000, 0b0010_0000][settings.tlm_variant as usize]];
        for part in &parts {
            let length = 12 + part_header(part).len() + 2 + part.body.len();
            match settings.tlm_variant {
                0 => {
                    tlm.push(part.tile as u8);
                    tlm.extend((length as u32).to_be_bytes());
                }
                1 => tlm.extend((length as u16).to_be_bytes()),
                _ => {
                    tlm.extend((part.tile as u16).to_be_bytes());
                    tlm.extend((length as u16).to_be_bytes());
                }
            }
        }
        out.extend(marker(0x55, &tlm));
        out.extend(marker(0x64, &[0, 1, b'j', b'p', b'x']));
        out.extend(marker(0x63, &vec![0; 4 * count]));
        // A packet length marker of the main header and a reserved marker without a length: both are skipped.
        out.extend(marker(0x57, &[0, 0, 0, 0]));
        out.extend([0xFF, 0x30]);
    }
    if settings.packed == Packed::Main {
        let mut ppm = Vec::new();
        for part in &parts {
            ppm.extend((part.headers.len() as u32).to_be_bytes());
            ppm.extend_from_slice(&part.headers);
        }
        if settings.split_markers {
            let middle = ppm.len() / 2;
            for (z, bytes) in [(1u8, &ppm[middle..]), (0, &ppm[..middle])] {
                let mut body = vec![z];
                body.extend_from_slice(bytes);
                out.extend(marker(0x60, &body));
            }
        } else {
            let mut body = vec![0u8];
            body.extend(ppm);
            out.extend(marker(0x60, &body));
        }
    }
    for (n, part) in parts.iter().enumerate() {
        let header = part_header(part);
        out.extend([0xFF, 0x90, 0, 10]);
        out.extend((part.tile as u16).to_be_bytes());
        let length = if settings.open_ended && n + 1 == parts.len() { 0 } else { 12 + header.len() + 2 + part.body.len() };
        out.extend((length as u32).to_be_bytes());
        out.extend([part.index as u8, part.of as u8]);
        out.extend(header);
        out.extend([0xFF, 0x93]);
        out.extend_from_slice(&part.body);
    }
    out.extend([0xFF, 0xD9]);
    out
}

/// 8-bit planes coded as `settings` ask.
pub fn encode_with(planes: &[Vec<Vec<u8>>], settings: Settings) -> Vec<u8> {
    let samples: Vec<Grid<i32>> =
        planes.iter().map(|p| p.iter().map(|row| row.iter().map(|&v| i32::from(v)).collect()).collect()).collect();
    encode_samples(&samples, &settings)
}

/// The default case: one level, one layer, default precincts, reversible.
pub fn encode(planes: &[Vec<Vec<u8>>]) -> Vec<u8> {
    encode_with(planes, Settings::reversible(1))
}
