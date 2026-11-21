//! The cross-reference table: pdf.js's `XRef`. It finds the header and `startxref`, reads classic tables, xref
//! streams (with `/W` and `/Index`), hybrid files (`/XRefStm`) and the `/Prev` chain of incremental updates, and
//! fetches objects: uncompressed ones at their offset (the generation is checked), compressed ones out of their
//! object stream. A broken table is rebuilt by scanning the file (`repair.rs`).
//!
//! Every method takes `&self`: the table and the object cache sit behind a `RefCell`, borrowed only between calls
//! into the parser, because fetching an object parses, and parsing fetches (a `/Length` that is a reference). One
//! `Xref` is therefore used by one thread at a time.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use crate::error::{Guard, PdfError, Result};
use crate::lexer::{Lexer, is_white_space};
use crate::object::{Dict, Obj, Ref};
use crate::parser::{Linearization, Parser};
use crate::stream::{ByteStream, Cipher, Decryptor, DecryptorFactory, PdfStream, StreamFilters};

/// What an `Xref` needs from its caller.
#[derive(Clone)]
pub struct XrefOptions {
    /// Decodes stream filters (xref streams and object streams are read through it).
    pub filters: Arc<dyn StreamFilters>,
    /// Builds the decryptor when the trailer has `/Encrypt`; without it an encrypted file fails to open.
    pub decryptor: Option<Arc<dyn DecryptorFactory>>,
    /// Cancellation and budget.
    pub guard: Arc<Guard>,
}

/// One cross-reference entry. For a compressed object (`uncompressed == false`, not free) `offset` is the number of
/// its object stream and `generation` its index in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub offset: i64,
    pub generation: i64,
    pub free: bool,
    pub uncompressed: bool,
}

pub(crate) struct State {
    pub(crate) entries: BTreeMap<i64, Entry>,
    pub(crate) cache: HashMap<i64, Obj>,
    pending: HashSet<Ref>,
    xref_section_offsets: HashSet<i64>,
    pub(crate) xref_stms: HashSet<i64>,
    xref_sections_complete: bool,
    parsed_with_recovery: bool,
    pub(crate) top_dict: Option<Arc<Dict>>,
    pub(crate) queue: Vec<i64>,
    pub(crate) generation_fallback: bool,
    trailer: Option<Arc<Dict>>,
    root: Option<Arc<Dict>>,
    encrypt: Option<Arc<dyn Decryptor>>,
}

pub struct Xref {
    pub(crate) stream: ByteStream,
    pub(crate) opts: XrefOptions,
    pub(crate) state: RefCell<State>,
    version: Option<String>,
    linearization: Option<Linearization>,
    start_xref: i64,
}

const PDF_HEADER_SIGNATURE: &[u8] = b"%PDF-";
const STARTXREF_SIGNATURE: &[u8] = b"startxref";
const ENDOBJ_SIGNATURE: &[u8] = b"endobj";

/// `document_find`: looks for `signature` in the `limit` bytes from the position (backwards: the last occurrence);
/// on a hit the position is at the signature.
fn find(stream: &mut ByteStream, signature: &[u8], limit: usize, backwards: bool) -> bool {
    let scan = stream.peek_bytes(limit);
    let Some(scan_length) = scan.len().checked_sub(signature.len()).filter(|n| *n > 0) else {
        return false;
    };
    if backwards {
        let signature_end = signature.len() - 1;
        let mut pos = scan.len() - 1;
        while pos >= signature_end {
            if scan[pos + 1 - signature.len()..=pos] == *signature {
                stream.pos += pos - signature_end;
                return true;
            }
            if pos == 0 {
                break;
            }
            pos -= 1;
        }
    } else {
        let mut pos = 0;
        while pos <= scan_length {
            if scan[pos..pos + signature.len()] == *signature {
                stream.pos += pos;
                return true;
            }
            pos += 1;
        }
    }
    false
}

/// `parseInt(text, 10)` of the leading integer, `None` for NaN.
pub(crate) fn parse_int_prefix(text: &str) -> Option<i64> {
    let bytes = text.trim_start().as_bytes();
    let (negative, digits) = match bytes.first() {
        Some(b'-') => (true, &bytes[1..]),
        Some(b'+') => (false, &bytes[1..]),
        _ => (false, bytes),
    };
    let mut value: i128 = 0;
    let mut any = false;
    for b in digits {
        if !b.is_ascii_digit() {
            break;
        }
        any = true;
        value = (value * 10 + i128::from(b - b'0')).min(i128::from(i64::MAX));
    }
    if !any {
        return None;
    }
    let value = i64::try_from(value).unwrap_or(i64::MAX);
    Some(if negative { -value } else { value })
}

/// `checkHeader`: moves the stream's start to `%PDF-` (found in the first 1024 bytes) and reads the version.
fn check_header(stream: &mut ByteStream) -> Option<String> {
    stream.reset();
    if !find(stream, PDF_HEADER_SIGNATURE, 1024, false) {
        return None;
    }
    stream.move_start();
    stream.skip(PDF_HEADER_SIGNATURE.len() as isize);
    let mut version = String::new();
    loop {
        let ch = stream.get_byte();
        if ch <= 0x20 || version.len() >= 7 {
            break;
        }
        version.push(char::from(ch as u8));
    }
    let b = version.as_bytes();
    if b.len() == 3 && (b'1'..=b'9').contains(&b[0]) && b[1] == b'.' && b[2].is_ascii_digit() {
        Some(version)
    } else {
        tracing::warn!("Invalid PDF header version: {version}");
        None
    }
}

/// The `startXRef` getter of `PDFDocument`: the offset the last `startxref` names (the first cross-reference
/// section of a linearized file follows its first `endobj`), 0 when there is none.
fn find_start_xref(stream: &mut ByteStream, linearized: bool) -> i64 {
    if linearized {
        stream.reset();
        if find(stream, ENDOBJ_SIGNATURE, 1024, false) {
            stream.skip(6);
            let mut ch = stream.peek_byte();
            while is_white_space(ch) {
                stream.pos += 1;
                ch = stream.peek_byte();
            }
            return stream.pos as i64 - stream.start as i64;
        }
        return 0;
    }
    const STEP: usize = 1024;
    let mut found = false;
    let mut pos = stream.end;
    while !found && pos > 0 {
        pos = pos.saturating_sub(STEP - STARTXREF_SIGNATURE.len());
        stream.pos = pos;
        found = find(stream, STARTXREF_SIGNATURE, STEP, true);
    }
    if !found {
        return 0;
    }
    stream.skip(9);
    let mut ch;
    loop {
        ch = stream.get_byte();
        if !is_white_space(ch) {
            break;
        }
    }
    let mut text = String::new();
    while (0x20..=0x39).contains(&ch) {
        text.push(char::from(ch as u8));
        ch = stream.get_byte();
    }
    parse_int_prefix(&text).unwrap_or(0)
}

/// `tag_obj_id`: sets `objId` the way `XRef.fetch` does.
fn tag_obj_id(obj: Obj, r: Ref) -> Obj {
    match obj {
        Obj::Dict(mut d) => {
            if d.obj_id.is_none() {
                Arc::make_mut(&mut d).obj_id = Some(r.to_string());
            }
            Obj::Dict(d)
        }
        Obj::Stream(mut s) => {
            if s.dict.obj_id.is_none() {
                Arc::make_mut(&mut Arc::make_mut(&mut s).dict).obj_id = Some(r.to_string());
            }
            Obj::Stream(s)
        }
        other => other,
    }
}

fn to_index(value: i64, what: &str) -> Result<usize> {
    usize::try_from(value).map_err(|_| PdfError::format(format!("Invalid {what}.")))
}

/// A big-endian unsigned field of `width` bytes of an xref stream entry (`what` names it in the error).
fn read_field(data: &mut ByteStream, width: i64, what: &str) -> Result<i32> {
    let mut value: i32 = 0;
    for _ in 0..width {
        let byte = data.get_byte();
        if byte == -1 {
            return Err(PdfError::format(format!("Invalid XRef byteWidths '{what}'.")));
        }
        value = (value << 8) | byte;
    }
    Ok(value)
}

impl Xref {
    /// Opens a file: checks the header, finds `startxref`, reads the cross-reference data and, when pdf.js's
    /// `XRefParseException` says it is unusable, rebuilds the table by scanning the file. A password failure
    /// (`PasswordException`) is returned for the caller to retry with another password.
    pub fn open(data: Arc<[u8]>, opts: XrefOptions) -> Result<Xref> {
        let mut stream = ByteStream::new(data);
        if stream.length() == 0 {
            return Err(PdfError::InvalidPdf("The PDF file is empty, i.e. its size is zero bytes.".to_owned()));
        }
        let version = check_header(&mut stream);
        let linearization = match Linearization::create(&stream, &opts.guard) {
            Ok(linearization) => linearization,
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) => {
                tracing::debug!("{e}");
                None
            }
        };
        let start_xref = find_start_xref(&mut stream, linearization.is_some());
        let state = State {
            entries: BTreeMap::new(),
            cache: HashMap::new(),
            pending: HashSet::new(),
            xref_section_offsets: HashSet::new(),
            xref_stms: HashSet::new(),
            xref_sections_complete: true,
            parsed_with_recovery: false,
            top_dict: None,
            queue: vec![start_xref],
            generation_fallback: false,
            trailer: None,
            root: None,
            encrypt: None,
        };
        let xref = Xref { stream, opts, state: RefCell::new(state), version, linearization, start_xref };
        match xref.parse(false) {
            Ok(()) => Ok(xref),
            Err(PdfError::XRefParse) => {
                xref.rebuild()?;
                Ok(xref)
            }
            Err(e) => Err(e),
        }
    }

    /// Parses again in recovery mode: the table is rebuilt by scanning the file for `obj` and `trailer`
    /// (`XRef.parse(true)`). A caller that finds an xref entry leading nowhere
    /// ([`crate::repair::triggers_rebuild`]) calls this.
    pub fn rebuild(&self) -> Result<()> {
        self.state.borrow_mut().queue = vec![self.start_xref];
        self.parse(true)
    }

    /// The version of the `%PDF-` header (`1.7`), when it is a valid one.
    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    pub fn linearization(&self) -> Option<&Linearization> {
        self.linearization.as_ref()
    }

    /// The offset `startxref` names (relative to the header).
    pub fn start_xref(&self) -> i64 {
        self.start_xref
    }

    /// The file's bytes with the window starting at the header.
    pub fn stream(&self) -> &ByteStream {
        &self.stream
    }

    pub fn guard(&self) -> &Arc<Guard> {
        &self.opts.guard
    }

    pub fn filters(&self) -> &Arc<dyn StreamFilters> {
        &self.opts.filters
    }

    /// The trailer dictionary in use.
    pub fn trailer(&self) -> Option<Arc<Dict>> {
        self.state.borrow().trailer.clone()
    }

    /// The document catalog (`/Root`), a dictionary with a `/Pages` dictionary.
    pub fn root(&self) -> Option<Arc<Dict>> {
        self.state.borrow().root.clone()
    }

    pub fn is_encrypted(&self) -> bool {
        self.state.borrow().encrypt.is_some()
    }

    /// The entry of object `num`, when it is in use.
    pub fn entry(&self, num: i64) -> Option<Entry> {
        self.state.borrow().entries.get(&num).filter(|e| !e.free && e.offset != 0).copied()
    }

    /// One past the highest object number the table knows.
    pub fn entries_len(&self) -> i64 {
        self.state.borrow().entries.keys().next_back().map_or(0, |n| n + 1)
    }

    /// `countUpdatesAfter`: the cross-reference sections (not xref streams of hybrid files) at or after `offset`;
    /// `None` after a rebuild or when a section could not be read.
    pub fn count_updates_after(&self, offset: i64) -> Option<usize> {
        let state = self.state.borrow();
        if state.parsed_with_recovery || !state.xref_sections_complete {
            return None;
        }
        let relative = offset - self.stream.start as i64;
        Some(state.xref_section_offsets.iter().filter(|o| **o >= relative && !state.xref_stms.contains(*o)).count())
    }

    // ---- lookups -------------------------------------------------------------------------------------------------

    /// `dict.get(key)`: the value, an indirect reference fetched. A missing key is [`Obj::Null`] here (pdf.js:
    /// `undefined`); use [`Dict::has`] to tell it from a stored `null`.
    pub fn get(&self, dict: &Dict, key: &str) -> Result<Obj> {
        match dict.get_raw(key) {
            Some(Obj::Ref(r)) => self.fetch(*r, dict.suppress_encryption),
            Some(value) => Ok(value.clone()),
            None => Ok(Obj::Null),
        }
    }

    /// `dict.get(key1, key2)`: `key2` is read when `key1` is not there.
    pub fn get2(&self, dict: &Dict, key1: &str, key2: &str) -> Result<Obj> {
        match dict.get_raw2(key1, key2) {
            Some(Obj::Ref(r)) => self.fetch(*r, dict.suppress_encryption),
            Some(value) => Ok(value.clone()),
            None => Ok(Obj::Null),
        }
    }

    /// `dict.getArray(key)`: like [`Xref::get`], and the references among an array's elements are fetched too.
    pub fn get_array(&self, dict: &Dict, key: &str) -> Result<Obj> {
        match self.get(dict, key)? {
            Obj::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items.iter() {
                    out.push(match item {
                        Obj::Ref(r) => self.fetch(*r, dict.suppress_encryption)?,
                        other => other.clone(),
                    });
                }
                Ok(Obj::Array(Arc::new(out)))
            }
            other => Ok(other),
        }
    }

    /// `fetchIfRef`.
    pub fn fetch_if_ref(&self, obj: &Obj, suppress_encryption: bool) -> Result<Obj> {
        match obj {
            Obj::Ref(r) => self.fetch(*r, suppress_encryption),
            other => Ok(other.clone()),
        }
    }

    fn cipher_for(&self, num: i64, generation: i64) -> Option<Cipher> {
        let decryptor = self.state.borrow().encrypt.clone()?;
        let decryptor = decryptor.for_object(num, generation).unwrap_or(decryptor);
        Some(Cipher { decryptor, num, generation })
    }

    /// `fetch`: the object `r` names. A missing or free entry is [`Obj::Null`], a reference met while it is being
    /// fetched is [`Obj::CircularRef`], an entry that leads to another object is [`PdfError::XRefEntry`].
    pub fn fetch(&self, r: Ref, suppress_encryption: bool) -> Result<Obj> {
        self.opts.guard.tick()?;
        let cached = self.state.borrow().cache.get(&r.num).cloned();
        if let Some(obj) = cached {
            if let Obj::Dict(d) = &obj
                && d.obj_id.is_none()
            {
                let tagged = tag_obj_id(obj.clone(), r);
                self.state.borrow_mut().cache.insert(r.num, tagged.clone());
                return Ok(tagged);
            }
            return Ok(obj);
        }
        let Some(entry) = self.entry(r.num) else {
            return Ok(Obj::Null);
        };
        {
            let mut state = self.state.borrow_mut();
            if state.pending.contains(&r) {
                state.pending.remove(&r);
                tracing::warn!("Ignoring circular reference: {r}.");
                return Ok(Obj::CircularRef);
            }
            state.pending.insert(r);
        }
        let result = if entry.uncompressed { self.fetch_uncompressed(r, entry, suppress_encryption) } else { self.fetch_compressed(r, entry) };
        self.state.borrow_mut().pending.remove(&r);
        Ok(tag_obj_id(result?, r))
    }

    fn fetch_uncompressed(&self, r: Ref, entry: Entry, suppress_encryption: bool) -> Result<Obj> {
        let generation = r.generation;
        let num = r.num;
        if entry.generation != generation {
            let message = format!("Inconsistent generation in XRef: {r}");
            let fallback = self.state.borrow().generation_fallback;
            if fallback && entry.generation < generation {
                tracing::warn!("{message}");
                return self.fetch_uncompressed(Ref::new(num, entry.generation), entry, suppress_encryption);
            }
            return Err(PdfError::XRefEntry(message));
        }
        let bad = || PdfError::XRefEntry(format!("Bad (uncompressed) XRef entry: {r}"));
        let offset = usize::try_from(entry.offset).ok().and_then(|o| o.checked_add(self.stream.start)).ok_or_else(bad)?;
        let stream = self.stream.make_sub_stream(offset, None);
        let mut parser = Parser::new(Lexer::new(stream, self.opts.guard.clone()), Some(self), true, false)?;
        let obj1 = parser.get_obj(None)?;
        let obj2 = parser.get_obj(None)?;
        let obj3 = parser.get_obj(None)?;
        let (Some(n1), Some(n2), Obj::Cmd(cmd)) = (obj1.as_num(), obj2.as_num(), &obj3) else {
            return Err(bad());
        };
        if n1 != num as f64 || n2 != generation as f64 {
            return Err(bad());
        }
        if &**cmd != "obj" {
            if let Some(n) = cmd.strip_prefix("obj").and_then(parse_int_prefix) {
                return Ok(Obj::Num(n as f64));
            }
            return Err(bad());
        }
        let cipher = if suppress_encryption { None } else { self.cipher_for(num, generation) };
        let obj = parser.get_obj(cipher.as_ref())?;
        if !matches!(obj, Obj::Stream(_)) {
            self.state.borrow_mut().cache.insert(num, obj.clone());
        }
        Ok(obj)
    }

    fn fetch_compressed(&self, r: Ref, entry: Entry) -> Result<Obj> {
        let table_offset = entry.offset;
        let guard = &self.opts.guard;
        let Obj::Stream(stream) = self.fetch(Ref::new(table_offset, 0), false)? else {
            return Err(PdfError::format("bad ObjStm stream"));
        };
        let (Some(first), Some(n)) = (self.get(&stream.dict, "First")?.as_int(), self.get(&stream.dict, "N")?.as_int()) else {
            return Err(PdfError::format("invalid first and n parameters for ObjStm stream"));
        };
        let n = to_index(n, "N of the ObjStm stream")?;
        let decoded = ByteStream::from_vec(stream.decode(&*self.opts.filters, guard)?);
        let mut parser = Parser::new(Lexer::new(decoded.clone(), guard.clone()), Some(self), true, false)?;
        let mut nums: Vec<i64> = Vec::new();
        let mut offsets: Vec<i64> = Vec::new();
        for i in 0..n {
            guard.tick()?;
            let num = parser.get_obj(None)?;
            let Some(num) = num.as_int() else {
                return Err(PdfError::format(format!("invalid object number in the ObjStm stream: {num:?}")));
            };
            let offset = parser.get_obj(None)?;
            let Some(offset) = offset.as_int() else {
                return Err(PdfError::format(format!("invalid object offset in the ObjStm stream: {offset:?}")));
            };
            nums.push(num);
            if let Some(e) = self.state.borrow_mut().entries.get_mut(&num)
                && !e.free
                && e.offset != 0
                && e.offset == table_offset
                && e.generation != i as i64
            {
                e.generation = i as i64;
            }
            offsets.push(offset);
        }
        let start = to_index(first, "First of the ObjStm stream")?;
        let mut objects: Vec<Obj> = Vec::with_capacity(n.min(4096));
        for i in 0..n {
            guard.tick()?;
            let length = if i + 1 < n { Some(offsets[i + 1] - offsets[i]) } else { None };
            if length.is_some_and(|l| l < 0) {
                return Err(PdfError::format("Invalid offset in the ObjStm stream."));
            }
            let at = to_index(offsets[i], "offset in the ObjStm stream")?.saturating_add(start);
            let length = length.map(|l| l as usize);
            let sub = decoded.make_sub_stream(at, length);
            let mut parser = Parser::new(Lexer::new(sub, guard.clone()), Some(self), true, false)?;
            let obj = parser.get_obj(None)?;
            objects.push(obj.clone());
            if matches!(obj, Obj::Stream(_)) {
                continue;
            }
            let num = nums[i];
            let mut state = self.state.borrow_mut();
            if state.entries.get(&num).is_some_and(|e| e.offset == table_offset && e.generation == i as i64) {
                state.cache.insert(num, obj);
            }
        }
        // The entry may have been given its index in the loop above.
        let index = self.state.borrow().entries.get(&r.num).map_or(entry.generation, |e| e.generation);
        usize::try_from(index).ok().and_then(|i| objects.get(i).cloned()).ok_or_else(|| PdfError::XRefEntry(format!("Bad (compressed) XRef entry: {r}")))
    }

    // ---- reading the cross-reference data -------------------------------------------------------------------------

    pub(crate) fn add_entry(&self, num: i64, entry: Entry) -> Result<()> {
        let mut state = self.state.borrow_mut();
        if !state.entries.contains_key(&num) {
            if state.entries.len() >= self.opts.guard.budget().max_objects {
                return Err(PdfError::ResourceLimit(format!("more than {} cross-reference entries", self.opts.guard.budget().max_objects)));
            }
            state.entries.insert(num, entry);
        }
        Ok(())
    }

    /// `XRef.parse`: reads the cross-reference data (or rebuilds it in recovery mode), builds the decryptor and
    /// checks that the trailer leads to a catalog with a `/Pages` dictionary.
    pub(crate) fn parse(&self, recovery_mode: bool) -> Result<()> {
        {
            let mut state = self.state.borrow_mut();
            state.parsed_with_recovery = recovery_mode;
            state.encrypt = None;
            state.root = None;
        }
        let trailer = if recovery_mode {
            tracing::warn!("Indexing all PDF objects");
            self.index_objects()?
        } else {
            self.read_xref(false)?.ok_or(PdfError::XRefParse)?
        };
        self.state.borrow_mut().trailer = Some(trailer.clone());
        self.install_decryptor(&trailer)?;
        self.check_root(&trailer, recovery_mode)
    }

    /// Builds the decryptor when the trailer names an `Encrypt` dictionary.
    fn install_decryptor(&self, trailer: &Dict) -> Result<()> {
        let encrypt = match self.get(trailer, "Encrypt") {
            Ok(obj) => obj,
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) => {
                tracing::warn!("XRef.parse - Invalid \"Encrypt\" reference: \"{e}\".");
                Obj::Null
            }
        };
        if let Obj::Dict(encrypt) = encrypt {
            let ids = self.get(trailer, "ID")?;
            let file_id: Vec<u8> = match &ids {
                Obj::Array(items) => items.first().and_then(Obj::as_str).map(<[u8]>::to_vec).unwrap_or_default(),
                _ => Vec::new(),
            };
            let mut encrypt_dict = (*encrypt).clone();
            encrypt_dict.suppress_encryption = true;
            if let Some(Obj::Ref(r)) = trailer.get_raw("Encrypt") {
                self.state.borrow_mut().cache.insert(r.num, Obj::Dict(Arc::new(encrypt_dict.clone())));
            }
            let Some(factory) = self.opts.decryptor.clone() else {
                return Err(PdfError::Unknown("The document is encrypted and no decryptor was given.".to_owned()));
            };
            let decryptor = factory.create(&encrypt_dict, &file_id, self)?;
            self.state.borrow_mut().encrypt = Some(decryptor);
        }
        Ok(())
    }

    /// Accepts the trailer's `Root` when it is a dictionary with a `/Pages` dictionary.
    fn check_root(&self, trailer: &Dict, recovery_mode: bool) -> Result<()> {
        let root = match self.get(trailer, "Root") {
            Ok(obj) => obj,
            Err(e) if e.is_fatal() => return Err(e),
            Err(e) => {
                tracing::warn!("XRef.parse - Invalid \"Root\" reference: \"{e}\".");
                Obj::Null
            }
        };
        if let Obj::Dict(root) = root {
            match self.get(&root, "Pages") {
                Ok(Obj::Dict(_)) => {
                    self.state.borrow_mut().root = Some(root);
                    return Ok(());
                }
                Ok(_) => {}
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) => tracing::warn!("XRef.parse - Invalid \"Pages\" reference: \"{e}\"."),
            }
        }
        if !recovery_mode {
            return Err(PdfError::XRefParse);
        }
        Err(PdfError::InvalidPdf("Invalid Root reference.".to_owned()))
    }

    /// `readXRef`: follows the queue of section offsets (`startxref`, then every `/Prev` and `/XRefStm`). A section
    /// that cannot be read is skipped. `None` in recovery mode when no section could be read.
    pub(crate) fn read_xref(&self, recovery_mode: bool) -> Result<Option<Arc<Dict>>> {
        let mut parsed: HashSet<i64> = HashSet::new();
        loop {
            self.opts.guard.tick()?;
            let Some(start_xref) = self.state.borrow().queue.first().copied() else {
                break;
            };
            if !parsed.insert(start_xref) {
                tracing::warn!("readXRef - skipping XRef table since it was already parsed.");
                self.state.borrow_mut().queue.remove(0);
                continue;
            }
            match self.read_section(start_xref) {
                Ok(()) => {}
                Err(e) if e.is_fatal() => return Err(e),
                Err(e) => {
                    self.state.borrow_mut().xref_sections_complete = false;
                    tracing::debug!("(while reading XRef): {e}");
                }
            }
            self.state.borrow_mut().queue.remove(0);
        }
        if let Some(top) = self.state.borrow().top_dict.clone() {
            return Ok(Some(top));
        }
        if recovery_mode { Ok(None) } else { Err(PdfError::XRefParse) }
    }

    fn read_section(&self, start_xref: i64) -> Result<()> {
        let at = to_index(start_xref, "XRef offset")?.saturating_add(self.stream.start);
        let mut stream = self.stream.clone();
        stream.pos = at;
        let mut parser = Parser::new(Lexer::new(stream, self.opts.guard.clone()), Some(self), true, false)?;
        let obj = parser.get_obj(None)?;
        let dict: Arc<Dict>;
        if obj.is_cmd("xref") {
            dict = self.process_xref_table(&mut parser)?;
            self.set_top_dict(&dict);
            if let Some(stm) = self.get(&dict, "XRefStm")?.as_int() {
                let mut state = self.state.borrow_mut();
                if state.xref_stms.insert(stm) {
                    state.queue.push(stm);
                }
            }
        } else if obj.as_int().is_some() {
            let stream = if parser.get_obj(None)?.as_int().is_some() && parser.get_obj(None)?.is_cmd("obj") {
                match parser.get_obj(None)? {
                    Obj::Stream(s) => Some(s),
                    _ => None,
                }
            } else {
                None
            };
            let Some(stream) = stream else {
                return Err(PdfError::format("Invalid XRef stream"));
            };
            dict = self.process_xref_stream(&stream)?;
            self.set_top_dict(&dict);
        } else {
            return Err(PdfError::format("Invalid XRef stream header"));
        }
        self.state.borrow_mut().xref_section_offsets.insert(start_xref);
        // pdf.js also queues the number of a reference the fetch leaves (an object that holds only `N G R`).
        match self.get(&dict, "Prev")? {
            Obj::Ref(r) => self.state.borrow_mut().queue.push(r.num),
            prev => {
                if let Some(prev) = prev.as_int() {
                    self.state.borrow_mut().queue.push(prev);
                }
            }
        }
        Ok(())
    }

    fn set_top_dict(&self, dict: &Arc<Dict>) {
        let mut state = self.state.borrow_mut();
        if state.top_dict.is_none() {
            state.top_dict = Some(dict.clone());
        }
    }

    /// `processXRefTable` and `readXRefTable`: the subsections, then the trailer dictionary.
    fn process_xref_table(&self, parser: &mut Parser<'_>) -> Result<Arc<Dict>> {
        let guard = &self.opts.guard;
        loop {
            let obj = parser.get_obj(None)?;
            if obj.is_cmd("trailer") {
                break;
            }
            let count = parser.get_obj(None)?;
            let (Some(mut first), Some(count)) = (obj.as_int(), count.as_int()) else {
                return Err(PdfError::format("Invalid XRef table: wrong types in subsection header"));
            };
            let mut i: i64 = 0;
            while i < count {
                guard.tick()?;
                let offset = parser.get_obj(None)?;
                let generation = parser.get_obj(None)?;
                let kind = parser.get_obj(None)?;
                let (free, uncompressed) = match &kind {
                    Obj::Cmd(c) if &**c == "f" => (true, false),
                    Obj::Cmd(c) if &**c == "n" => (false, true),
                    _ => (false, false),
                };
                let (Some(offset), Some(generation), true) = (offset.as_int(), generation.as_int(), free || uncompressed) else {
                    return Err(PdfError::format(format!("Invalid entry in XRef subsection: {first}, {count}")));
                };
                if i == 0 && free && first == 1 {
                    first = 0;
                }
                self.add_entry(first + i, Entry { offset, generation, free, uncompressed })?;
                i += 1;
            }
        }
        if self.state.borrow().entries.get(&0).is_some_and(|e| !e.free) {
            return Err(PdfError::format("Invalid XRef table: unexpected first object"));
        }
        match parser.get_obj(None)? {
            Obj::Dict(dict) => Ok(dict),
            Obj::Stream(stream) => Ok(stream.dict.clone()),
            _ => Err(PdfError::format("Invalid XRef table: could not parse trailer dictionary")),
        }
    }

    /// `processXRefStream` and `readXRefStream`: entries of `/W` field widths for each `/Index` range.
    fn process_xref_stream(&self, stream: &PdfStream) -> Result<Arc<Dict>> {
        let guard = &self.opts.guard;
        let dict = stream.dict.clone();
        let Obj::Array(widths) = self.get(&dict, "W")? else {
            return Err(PdfError::format("Invalid XRef stream widths"));
        };
        let width = |at: usize| widths.get(at).and_then(Obj::as_int);
        let widths = [width(0), width(1), width(2)];
        let ranges: Vec<Obj> = match self.get(&dict, "Index")? {
            Obj::Array(ranges) => ranges.to_vec(),
            Obj::Null | Obj::Bool(false) => vec![Obj::Num(0.0), self.get(&dict, "Size")?],
            Obj::Num(n) if n == 0.0 || n.is_nan() => vec![Obj::Num(0.0), self.get(&dict, "Size")?],
            _ => Vec::new(),
        };
        let data = stream.decode(&*self.opts.filters, guard)?;
        let mut data = ByteStream::from_vec(data);
        for pair in ranges.chunks(2) {
            let (Some(first), Some(n)) = (pair[0].as_int(), pair.get(1).and_then(Obj::as_int)) else {
                return Err(PdfError::format("Invalid XRef range fields"));
            };
            let [Some(type_width), Some(offset_width), Some(generation_width)] = widths else {
                return Err(PdfError::format(format!("Invalid XRef entry fields length: {first}, {n}")));
            };
            if type_width < 0 || offset_width < 0 || generation_width < 0 || type_width + offset_width + generation_width == 0 {
                return Err(PdfError::format(format!("Invalid XRef entry fields length: {first}, {n}")));
            }
            let mut i: i64 = 0;
            while i < n {
                guard.tick()?;
                let kind = if type_width == 0 { 1 } else { read_field(&mut data, type_width, "type")? };
                let offset = read_field(&mut data, offset_width, "offset")?;
                let generation = read_field(&mut data, generation_width, "generation")?;
                let mut entry = Entry { offset: i64::from(offset), generation: i64::from(generation), free: false, uncompressed: false };
                match kind {
                    0 => entry.free = true,
                    1 => entry.uncompressed = true,
                    2 => {}
                    _ => return Err(PdfError::format(format!("Invalid XRef entry type: {kind}"))),
                }
                self.add_entry(first + i, entry)?;
                i += 1;
            }
        }
        Ok(dict)
    }
}
