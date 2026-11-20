//! CMaps, ported from pdf.js 6.4.299 (`CMap`, `IdentityCMap`, `CMapFactory` and the CMap parser of
//! `src/core/cmap.js`): embedded CMaps and ToUnicode streams (`begincodespacerange`, `bfchar`, `bfrange` in both
//! forms, `cidchar`, `cidrange`, `usecmap`, `WMode`, `CMapName`), the predefined packed CMaps (see [`bcmap`]) and the
//! built-in `Identity-H` and `Identity-V`.
//!
//! A pdf.js CMap value is a number (a CID) or a string. The strings of a CMap are strings of UTF-16 code units
//! (`[u16]`): the lexer's bytes are chars of 0 to 255, the packed files give byte pairs.

use std::collections::HashMap;
use std::sync::Arc;

use crate::error::{Guard, PdfError, Result};
use crate::lexer::Lexer;
use crate::object::Obj;
use crate::stream::ByteStream;

#[path = "bcmap.rs"]
pub mod bcmap;

/// `MAX_MAP_RANGE`: the entries one CMap accepts through ranges.
const MAX_MAP_RANGE: i64 = (1 << 24) - 1;

/// What a CMap maps a code to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CMapValue {
    /// A CID, or a code point of a ToUnicode `cidchar` (a JS number).
    Cid(i64),
    /// A string of UTF-16 code units (a JS string).
    Str(Vec<u16>),
    /// An entry of a `bfrange` array that is neither a number nor a string. pdf.js stores it as it is; it is never
    /// found by [`CMap::char_code_of`].
    Other,
}

/// The entries of a `Map` in insertion order: setting a key again changes its value and keeps its place.
#[derive(Debug, Clone, Default)]
struct OrderedMap {
    index: HashMap<u32, usize>,
    entries: Vec<(u32, CMapValue)>,
}

impl OrderedMap {
    fn set(&mut self, key: u32, value: CMapValue) {
        match self.index.get(&key) {
            Some(&at) => self.entries[at].1 = value,
            None => {
                self.index.insert(key, self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    fn get(&self, key: u32) -> Option<&CMapValue> {
        self.index.get(&key).map(|&at| &self.entries[at].1)
    }
}

/// pdf.js's `CMap`, and through [`CMap::identity`] its `IdentityCMap`.
#[derive(Debug, Clone)]
pub struct CMap {
    map: OrderedMap,
    mapped_entries: i64,
    codespace_ranges: [Vec<u32>; 4],
    num_codespace_ranges: usize,
    /// `CMapName`, or the name of the predefined CMap.
    pub name: String,
    /// `WMode`: vertical writing.
    pub vertical: bool,
    /// The CMap this one extends (`usecmap`).
    pub use_cmap: Option<Arc<CMap>>,
    /// `builtInCMap`: read from the predefined files.
    pub built_in: bool,
    identity: bool,
}

impl CMap {
    /// `new CMap(builtInCMap)`.
    pub fn new(built_in: bool) -> Self {
        CMap {
            map: OrderedMap::default(),
            mapped_entries: 0,
            codespace_ranges: [Vec::new(), Vec::new(), Vec::new(), Vec::new()],
            num_codespace_ranges: 0,
            name: String::new(),
            vertical: false,
            use_cmap: None,
            built_in,
            identity: false,
        }
    }

    /// `new IdentityCMap(vertical, n)`: every code up to 0xffff maps to itself; `n` is the code width in bytes.
    pub fn identity(vertical: bool, n: usize) -> Self {
        let mut cmap = CMap::new(false);
        cmap.identity = true;
        cmap.vertical = vertical;
        // `n` is 2 at every call; a width outside 1 to 4 would have thrown at `codespaceRanges[n - 1].push`.
        if (1..=4).contains(&n) {
            cmap.codespace_ranges[n - 1].extend([0, 0xffff]);
            cmap.num_codespace_ranges += 1;
        }
        cmap
    }

    /// `instanceof IdentityCMap`.
    pub fn is_identity_kind(&self) -> bool {
        self.identity
    }

    /// `codespaceRanges`: for each width of 1 to 4 bytes, the flat list `low, high, low, high, ...`.
    pub fn codespace_ranges(&self) -> &[Vec<u32>; 4] {
        &self.codespace_ranges
    }

    /// `numCodespaceRanges`.
    pub fn num_codespace_ranges(&self) -> usize {
        self.num_codespace_ranges
    }

    /// `addCodespaceRange(n, low, high)`. A width outside 1 to 4 is a `TypeError` in pdf.js (`codespaceRanges[n - 1]`
    /// is `undefined`), here a failure the CMap parser catches as pdf.js does.
    pub fn add_codespace_range(&mut self, n: usize, low: u32, high: u32) -> Result<()> {
        let Some(ranges) = n.checked_sub(1).and_then(|i| self.codespace_ranges.get_mut(i)) else {
            return Err(PdfError::Unknown("Cannot read properties of undefined (reading 'push')".to_owned()));
        };
        ranges.extend([low, high]);
        self.num_codespace_ranges += 1;
        Ok(())
    }

    /// `#consumeBudget`.
    fn consume_budget(&mut self, count: i64, name: &str) -> Result<()> {
        if count <= 0 {
            return Ok(());
        }
        if self.mapped_entries + count > MAX_MAP_RANGE {
            return Err(PdfError::Unknown(format!("{name} - ignoring data above MAX_MAP_RANGE.")));
        }
        self.mapped_entries += count;
        Ok(())
    }

    /// `mapCidRange(low, high, dstLow)`.
    pub fn map_cid_range(&mut self, low: u32, high: u32, dst_low: i64) -> Result<()> {
        self.consume_budget(i64::from(high) - i64::from(low) + 1, "mapCidRange")?;
        for (code, dst) in (low..=high).zip(dst_low..) {
            self.map.set(code, CMapValue::Cid(dst));
        }
        Ok(())
    }

    /// `mapBfRange(low, high, dstLow)`: each next code maps to the string one greater in the unit that was last in
    /// `dstLow`, carrying into the unit before it (see `next_bf_string`).
    pub fn map_bf_range(&mut self, low: u32, high: u32, dst_low: Vec<u16>) -> Result<()> {
        self.consume_budget(i64::from(high) - i64::from(low) + 1, "mapBfRange")?;
        let last_byte = dst_low.len() as isize - 1;
        let mut dst = dst_low;
        for code in low..=high {
            let next = next_bf_string(&dst, last_byte);
            self.map.set(code, CMapValue::Str(dst));
            dst = next;
        }
        Ok(())
    }

    /// `mapBfRangeToArray(low, high, array)`.
    pub fn map_bf_range_to_array(&mut self, low: u32, high: u32, array: Vec<CMapValue>) -> Result<()> {
        let span = i64::from(high) - i64::from(low) + 1;
        let len = i64::try_from(array.len()).unwrap_or(i64::MAX);
        self.consume_budget(span.min(len), "mapBfRangeToArray")?;
        for (code, value) in (low..=high).zip(array) {
            self.map.set(code, value);
        }
        Ok(())
    }

    /// `mapOne(src, dst)`.
    pub fn map_one(&mut self, src: u32, dst: CMapValue) {
        self.map.set(src, dst);
    }

    /// `lookup(code)`.
    pub fn lookup(&self, code: u32) -> Option<CMapValue> {
        if self.identity {
            return (code <= 0xffff).then(|| CMapValue::Cid(i64::from(code)));
        }
        self.map.get(code).cloned()
    }

    /// `contains(code)`.
    pub fn contains(&self, code: u32) -> bool {
        if self.identity {
            return code <= 0xffff;
        }
        self.map.index.contains_key(&code)
    }

    /// `forEach(callback)`: the entries in insertion order.
    pub fn for_each(&self, mut callback: impl FnMut(u32, &CMapValue)) {
        if self.identity {
            for code in 0..=0xffff_u32 {
                callback(code, &CMapValue::Cid(i64::from(code)));
            }
            return;
        }
        for (code, value) in &self.map.entries {
            callback(*code, value);
        }
    }

    /// `charCodeOf(value)`: the first code that maps to `value`, or -1.
    pub fn char_code_of(&self, value: &CMapValue) -> i64 {
        if matches!(value, CMapValue::Other) {
            return -1;
        }
        if self.identity {
            return match value {
                CMapValue::Cid(n) if *n <= 0xffff => *n,
                _ => -1,
            };
        }
        self.map.entries.iter().find(|(_, entry)| entry == value).map_or(-1, |(code, _)| i64::from(*code))
    }

    /// `getMap()`: a copy of the entries in insertion order.
    pub fn get_map(&self) -> Vec<(u32, CMapValue)> {
        let mut out = Vec::with_capacity(self.size());
        self.for_each(|code, value| out.push((code, value.clone())));
        out
    }

    /// `readCharCode(str, offset, out)`: the code that starts at `offset` of the byte string and its width. A byte
    /// past the end of the string reads as 0, as `charCodeAt` out of range does inside `c << 8 | NaN`.
    pub fn read_char_code(&self, text: &[u8], offset: usize) -> (u32, usize) {
        let mut c: u32 = 0;
        for (n, ranges) in self.codespace_ranges.iter().enumerate() {
            let byte = text.get(offset + n).copied().unwrap_or(0);
            c = (c << 8) | u32::from(byte);
            for pair in ranges.chunks_exact(2) {
                if (pair[0]..=pair[1]).contains(&c) {
                    return (c, n + 1);
                }
            }
        }
        (0, 1)
    }

    /// `getCharCodeLength(charCode)`.
    pub fn get_char_code_length(&self, char_code: u32) -> usize {
        for (n, ranges) in self.codespace_ranges.iter().enumerate() {
            for pair in ranges.chunks_exact(2) {
                if (pair[0]..=pair[1]).contains(&char_code) {
                    return n + 1;
                }
            }
        }
        1
    }

    /// `size`.
    pub fn size(&self) -> usize {
        if self.identity { 0x10000 } else { self.map.entries.len() }
    }

    /// `isIdentityCMap`: named `Identity-H` or `Identity-V` and mapping every code up to 0xffff to itself.
    pub fn is_identity_cmap(&self) -> bool {
        if self.identity {
            return true;
        }
        if self.name != "Identity-H" && self.name != "Identity-V" {
            return false;
        }
        if self.map.entries.len() != 0x10000 {
            return false;
        }
        (0..0x10000_u32).all(|i| self.map.get(i) == Some(&CMapValue::Cid(i64::from(i))))
    }
}

/// `String.prototype.charCodeAt(index)`: `None` is `NaN`.
fn char_code_at(text: &[u16], index: isize) -> Option<u32> {
    usize::try_from(index).ok().and_then(|i| text.get(i)).map(|unit| u32::from(*unit))
}

/// `text.substring(0, end)`: `end` is clamped into the string.
fn prefix(text: &[u16], end: isize) -> &[u16] {
    let end = usize::try_from(end).unwrap_or(0).min(text.len());
    &text[..end]
}

/// The string after `dst` in a `mapBfRange`, written as pdf.js writes it. `last_byte` is `dstLow.length - 1` of the
/// string the range started with, and stays that for every step: the unit it names is incremented, and when it passes
/// 0xff the unit before it is incremented and it becomes 0. A unit that does not exist is `NaN`, which
/// `String.fromCharCode` makes a NUL.
fn next_bf_string(dst: &[u16], last_byte: isize) -> Vec<u16> {
    let next_char_code = char_code_at(dst, last_byte).map(|unit| unit + 1);
    if next_char_code.is_some_and(|code| code > 0xff) {
        let mut next = prefix(dst, last_byte - 1).to_vec();
        next.push(char_code_at(dst, last_byte - 1).map_or(0, |unit| ((unit + 1) & 0xffff) as u16));
        next.push(0);
        return next;
    }
    let mut next = prefix(dst, last_byte).to_vec();
    next.push(next_char_code.map_or(0, |code| code as u16));
    next
}

/// What a CMap is built from (`CMapFactory.create({encoding})`).
#[derive(Debug, Clone, Copy)]
pub enum CMapEncoding<'a> {
    /// A name: `Identity-H`, `Identity-V` or a predefined CMap.
    Name(&'a str),
    /// The decoded bytes of an embedded CMap or ToUnicode stream.
    Stream(&'a [u8]),
}

/// `CMapFactory`.
pub struct CMapFactory;

impl CMapFactory {
    /// `CMapFactory.create({encoding, fetchBuiltInCMap, useCMap})` with the embedded predefined CMaps as the fetch.
    /// `encoding` is `None` when the font has no `/Encoding` (`Error("Encoding required.")`). A stream that parses
    /// as the identity CMap gives the built-in identity CMap of its name.
    pub fn create(encoding: Option<CMapEncoding<'_>>, use_cmap: Option<&str>, guard: &Arc<Guard>) -> Result<CMap> {
        match encoding {
            Some(CMapEncoding::Name(name)) => create_built_in_cmap(name),
            Some(CMapEncoding::Stream(bytes)) => {
                let lexer = Lexer::new(ByteStream::from_vec(bytes.to_vec()), Arc::clone(guard));
                let parsed = parse_cmap(CMap::new(false), lexer, use_cmap)?;
                if parsed.is_identity_cmap() { create_built_in_cmap(&parsed.name) } else { Ok(parsed) }
            }
            None => Err(PdfError::Unknown("Encoding required.".to_owned())),
        }
    }
}

/// `createBuiltInCMap(name, fetchBuiltInCMap)`.
fn create_built_in_cmap(name: &str) -> Result<CMap> {
    match name {
        "Identity-H" => return Ok(CMap::identity(false, 2)),
        "Identity-V" => return Ok(CMap::identity(true, 2)),
        _ => {}
    }
    let Some(data) = bcmap::built_in_cmap_data(name) else {
        return Err(PdfError::Unknown(format!("Unknown CMap name: {name}")));
    };
    let mut cmap = CMap::new(true);
    bcmap::process_binary_cmap(data, &mut cmap, extend_cmap)?;
    Ok(cmap)
}

/// `extendCMap(cMap, fetchBuiltInCMap, useCMap)`: the entries of the predefined CMap `use_cmap` are added where
/// `cmap` has none, and its codespace ranges are taken when `cmap` has none.
fn extend_cmap(cmap: &mut CMap, use_cmap: &str) -> Result<()> {
    let parent = Arc::new(create_built_in_cmap(use_cmap)?);
    cmap.use_cmap = Some(Arc::clone(&parent));
    if cmap.num_codespace_ranges == 0 {
        cmap.codespace_ranges = parent.codespace_ranges.clone();
        cmap.num_codespace_ranges = parent.num_codespace_ranges;
    }
    parent.for_each(|code, value| {
        if !cmap.contains(code) {
            cmap.map_one(code, value.clone());
        }
    });
    Ok(())
}

/// `strToInt`: the chars of a string as one big-endian unsigned 32-bit number.
fn str_to_int(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0u32, |a, b| (a << 8) | u32::from(*b))
}

fn units(bytes: &[u8]) -> Vec<u16> {
    bytes.iter().map(|b| u16::from(*b)).collect()
}

fn malformed(what: &str) -> PdfError {
    PdfError::Format(format!("Malformed CMap: expected {what}."))
}

fn expect_string(obj: &Obj) -> Result<&[u8]> {
    obj.as_str().ok_or_else(|| malformed("string"))
}

fn expect_int(obj: &Obj) -> Result<i64> {
    obj.as_int().ok_or_else(|| malformed("int"))
}

/// A token of a `bfrange` array as a CMap value.
fn array_value(obj: &Obj) -> CMapValue {
    if let Some(bytes) = obj.as_str() {
        CMapValue::Str(units(bytes))
    } else if let Some(n) = obj.as_int() {
        CMapValue::Cid(n)
    } else {
        CMapValue::Other
    }
}

fn parse_bf_char(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    loop {
        let obj = lexer.get_obj()?;
        if obj.is_eof() || obj.is_cmd("endbfchar") {
            return Ok(());
        }
        let src = str_to_int(expect_string(&obj)?);
        let dst = lexer.get_obj()?;
        let dst = units(expect_string(&dst)?);
        cmap.map_one(src, CMapValue::Str(dst));
    }
}

fn parse_bf_range(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    loop {
        let obj = lexer.get_obj()?;
        if obj.is_eof() {
            break;
        }
        if obj.is_cmd("endbfrange") {
            return Ok(());
        }
        let low = str_to_int(expect_string(&obj)?);
        let obj = lexer.get_obj()?;
        let high = str_to_int(expect_string(&obj)?);
        let obj = lexer.get_obj()?;
        if let Some(n) = obj.as_int() {
            // `String.fromCharCode(n)`: one unit, the number modulo 2^16.
            cmap.map_bf_range(low, high, vec![(n & 0xffff) as u16])?;
        } else if let Some(bytes) = obj.as_str() {
            cmap.map_bf_range(low, high, units(bytes))?;
        } else if obj.is_cmd("[") {
            let mut array = Vec::new();
            let mut item = lexer.get_obj()?;
            while !item.is_cmd("]") && !item.is_eof() {
                array.push(array_value(&item));
                item = lexer.get_obj()?;
            }
            cmap.map_bf_range_to_array(low, high, array)?;
        } else {
            break;
        }
    }
    Err(PdfError::Format("Invalid bf range.".to_owned()))
}

fn parse_cid_char(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    loop {
        let obj = lexer.get_obj()?;
        if obj.is_eof() || obj.is_cmd("endcidchar") {
            return Ok(());
        }
        let src = str_to_int(expect_string(&obj)?);
        let dst = lexer.get_obj()?;
        cmap.map_one(src, CMapValue::Cid(expect_int(&dst)?));
    }
}

fn parse_cid_range(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    loop {
        let obj = lexer.get_obj()?;
        if obj.is_eof() || obj.is_cmd("endcidrange") {
            return Ok(());
        }
        let low = str_to_int(expect_string(&obj)?);
        let obj = lexer.get_obj()?;
        let high = str_to_int(expect_string(&obj)?);
        let obj = lexer.get_obj()?;
        cmap.map_cid_range(low, high, expect_int(&obj)?)?;
    }
}

fn parse_codespace_range(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    loop {
        let obj = lexer.get_obj()?;
        if obj.is_eof() {
            break;
        }
        if obj.is_cmd("endcodespacerange") {
            return Ok(());
        }
        let Some(low) = obj.as_str().map(str_to_int) else {
            break;
        };
        let obj = lexer.get_obj()?;
        let Some(high_bytes) = obj.as_str() else {
            break;
        };
        cmap.add_codespace_range(high_bytes.len(), low, str_to_int(high_bytes))?;
    }
    Err(PdfError::Format("Invalid codespace range.".to_owned()))
}

fn parse_wmode(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    let obj = lexer.get_obj()?;
    if let Some(n) = obj.as_int() {
        cmap.vertical = n != 0;
    }
    Ok(())
}

fn parse_cmap_name(cmap: &mut CMap, lexer: &mut Lexer) -> Result<()> {
    let obj = lexer.get_obj()?;
    if let Some(name) = obj.as_name() {
        name.clone_into(&mut cmap.name);
    }
    Ok(())
}

/// One token of the CMap and what it starts; `false` at the end (`endcmap` or the end of the data).
fn parse_cmap_step(cmap: &mut CMap, lexer: &mut Lexer, previous: &mut Option<Obj>, embedded_use_cmap: &mut Option<String>) -> Result<bool> {
    let obj = lexer.get_obj()?;
    if obj.is_eof() {
        return Ok(false);
    }
    if let Some(name) = obj.as_name() {
        match name {
            "WMode" => parse_wmode(cmap, lexer)?,
            "CMapName" => parse_cmap_name(cmap, lexer)?,
            _ => {}
        }
        *previous = Some(obj);
    } else if let Obj::Cmd(cmd) = &obj {
        match &**cmd {
            "endcmap" => return Ok(false),
            "usecmap" => {
                if let Some(name) = previous.as_ref().and_then(Obj::as_name) {
                    *embedded_use_cmap = Some(name.to_owned());
                }
            }
            "begincodespacerange" => parse_codespace_range(cmap, lexer)?,
            "beginbfchar" => parse_bf_char(cmap, lexer)?,
            "begincidchar" => parse_cid_char(cmap, lexer)?,
            "beginbfrange" => parse_bf_range(cmap, lexer)?,
            "begincidrange" => parse_cid_range(cmap, lexer)?,
            _ => {}
        }
    }
    Ok(true)
}

/// `parseCMap(cMap, lexer, fetchBuiltInCMap, useCMap)`: a malformed part is skipped with a warning, as in pdf.js;
/// only a cancellation or a resource limit of the lexer's guard stops the parse.
fn parse_cmap(mut cmap: CMap, mut lexer: Lexer, use_cmap: Option<&str>) -> Result<CMap> {
    let mut previous: Option<Obj> = None;
    let mut embedded_use_cmap: Option<String> = None;
    loop {
        match parse_cmap_step(&mut cmap, &mut lexer, &mut previous, &mut embedded_use_cmap) {
            Ok(true) => {}
            Ok(false) => break,
            Err(error) if error.is_fatal() => return Err(error),
            Err(error) => tracing::warn!("Invalid cMap data: {error}"),
        }
    }
    // An empty name is falsy in pdf.js: it neither replaces the embedded one nor extends.
    let use_cmap = use_cmap.filter(|name| !name.is_empty()).map(str::to_owned).or(embedded_use_cmap).filter(|name| !name.is_empty());
    if let Some(name) = use_cmap {
        extend_cmap(&mut cmap, &name)?;
    }
    Ok(cmap)
}
