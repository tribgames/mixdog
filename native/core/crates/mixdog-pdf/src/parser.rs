//! The object parser: pdf.js's `Parser`. Two tokens of look-ahead build arrays, dictionaries, indirect references
//! (`12 0 R`) and stream objects. A stream's `/Length` is trusted only when `endstream` follows it; otherwise the
//! data is searched for `endstream` (also in its truncated spellings). Inline images (`BI ... ID ... EI`) are
//! skipped by the end-of-image searches of pdf.js. `Linearization` reads the linearization dictionary.

use std::sync::Arc;

use crate::error::{Guard, PdfError, Result};
use crate::lexer::{KnownCommands, Lexer, is_white_space};
use crate::object::{Dict, Obj, Ref};
use crate::stream::{ByteStream, Cipher, FilterSpec, PdfStream};
use crate::xref::Xref;

pub struct Parser<'x> {
    pub lexer: Lexer,
    xref: Option<&'x Xref>,
    allow_streams: bool,
    recovery_mode: bool,
    buf1: Obj,
    buf2: Obj,
    depth: usize,
    objects: usize,
    guard: Arc<Guard>,
}

impl<'x> Parser<'x> {
    /// `new Parser({lexer, xref, allowStreams, recoveryMode})`. `xref` is where references met while parsing are
    /// fetched from (the `/Length` of a stream, a `/Filter` held in an object).
    pub fn new(
        lexer: Lexer,
        xref: Option<&'x Xref>,
        allow_streams: bool,
        recovery_mode: bool,
    ) -> Result<Self> {
        let guard = lexer.guard().clone();
        let mut parser = Parser {
            lexer,
            xref,
            allow_streams,
            recovery_mode,
            buf1: Obj::Null,
            buf2: Obj::Null,
            depth: 0,
            objects: 0,
            guard,
        };
        parser.refill()?;
        Ok(parser)
    }

    fn refill(&mut self) -> Result<()> {
        self.buf1 = self.lexer.get_obj()?;
        self.buf2 = self.lexer.get_obj()?;
        Ok(())
    }

    fn shift(&mut self) -> Result<()> {
        self.buf1 = std::mem::replace(&mut self.buf2, Obj::Null);
        // After `ID` the bytes are image data, not tokens: nothing is read ahead.
        if !self.buf1.is_cmd("ID") {
            self.buf2 = self.lexer.get_obj()?;
        }
        Ok(())
    }

    /// `tryShift`: `false` when the lexer fails (cancel and budget failures still propagate).
    fn try_shift(&mut self) -> Result<bool> {
        match self.shift() {
            Ok(()) => Ok(true),
            Err(e) if e.is_fatal() => Err(e),
            Err(_) => Ok(false),
        }
    }

    fn fetch_if_ref(&self, obj: Obj) -> Result<Obj> {
        match (self.xref, &obj) {
            (Some(xref), Obj::Ref(r)) => xref.fetch(*r, false),
            _ => Ok(obj),
        }
    }

    /// `dict.get(key1, key2)` of a dictionary this parser made: a reference value is fetched.
    fn dict_get2(&self, dict: &Dict, key1: &str, key2: &str) -> Result<Obj> {
        match dict.get_raw2(key1, key2) {
            Some(value) => self.fetch_if_ref(value.clone()),
            None => Ok(Obj::Null),
        }
    }

    /// `getObj`: the next object. A token that is only a command comes back as [`Obj::Cmd`].
    pub fn get_obj(&mut self, cipher: Option<&Cipher>) -> Result<Obj> {
        self.objects += 1;
        self.guard.check_objects(self.objects)?;
        self.guard.tick()?;
        self.depth += 1;
        let outcome = match self.guard.check_depth(self.depth) {
            Ok(()) => self.read_obj(cipher),
            Err(e) => Err(e),
        };
        self.depth -= 1;
        outcome
    }

    fn read_obj(&mut self, cipher: Option<&Cipher>) -> Result<Obj> {
        let buf1 = self.buf1.clone();
        self.shift()?;
        match &buf1 {
            Obj::Cmd(cmd) => match &**cmd {
                "BI" => self.make_inline_image(cipher),
                "[" => {
                    let mut array = Vec::new();
                    while !self.buf1.is_cmd("]") && !self.buf1.is_eof() {
                        array.push(self.get_obj(cipher)?);
                    }
                    if self.buf1.is_eof() {
                        if self.recovery_mode {
                            return Ok(Obj::Array(Arc::new(array)));
                        }
                        return Err(PdfError::ParserEof("End of file inside array.".to_owned()));
                    }
                    self.shift()?;
                    Ok(Obj::Array(Arc::new(array)))
                }
                "<<" => {
                    let mut dict = Dict::new();
                    while !self.buf1.is_cmd(">>") && !self.buf1.is_eof() {
                        self.guard.tick()?;
                        let Obj::Name(key) = self.buf1.clone() else {
                            tracing::debug!("Malformed dictionary: key must be a name object");
                            self.shift()?;
                            continue;
                        };
                        self.shift()?;
                        if self.buf1.is_eof() {
                            break;
                        }
                        let value = self.get_obj(cipher)?;
                        dict.set(&key, value);
                    }
                    if self.buf1.is_eof() {
                        if self.recovery_mode {
                            return Ok(Obj::Dict(Arc::new(dict)));
                        }
                        return Err(PdfError::ParserEof(
                            "End of file inside dictionary.".to_owned(),
                        ));
                    }
                    if self.buf2.is_cmd("stream") {
                        if self.allow_streams {
                            return self.make_stream(dict, cipher);
                        }
                        return Ok(Obj::Dict(Arc::new(dict)));
                    }
                    self.shift()?;
                    Ok(Obj::Dict(Arc::new(dict)))
                }
                _ => Ok(buf1.clone()),
            },
            Obj::Num(_) if buf1.as_int().is_some() => {
                if let (Some(generation), true) = (self.buf1.as_int(), self.buf2.is_cmd("R")) {
                    let r = Ref::new(buf1.as_int().unwrap_or(0), generation);
                    self.shift()?;
                    self.shift()?;
                    return Ok(Obj::Ref(r));
                }
                Ok(buf1.clone())
            }
            Obj::Str(bytes) => match cipher {
                Some(c) => Ok(Obj::Str(Arc::from(c.decryptor.decrypt_string(
                    c.num,
                    c.generation,
                    bytes,
                    self.xref,
                )?))),
                None => Ok(buf1.clone()),
            },
            _ => Ok(buf1.clone()),
        }
    }

    // ---- inline images -------------------------------------------------------------------------------------------

    /// `makeInlineImage`: the `BI` dictionary, then the data up to `EI`, as a stream. (pdf.js caches short images by
    /// their bytes; a cache changes no result and is not kept.)
    fn make_inline_image(&mut self, cipher: Option<&Cipher>) -> Result<Obj> {
        let mut dict = Dict::new();
        while !self.buf1.is_cmd("ID") && !self.buf1.is_eof() {
            self.guard.tick()?;
            let Obj::Name(key) = self.buf1.clone() else {
                return Err(PdfError::format("Dictionary key must be a name object"));
            };
            self.shift()?;
            if self.buf1.is_eof() {
                break;
            }
            let value = self.get_obj(cipher)?;
            dict.set(&key, value);
        }
        let filter = self.dict_get2(&dict, "F", "Filter")?;
        let filter_name = match &filter {
            Obj::Name(name) => Some(name.to_string()),
            Obj::Array(items) => match items.first() {
                Some(first) => match self.fetch_if_ref(first.clone())? {
                    Obj::Name(name) => Some(name.to_string()),
                    _ => None,
                },
                None => None,
            },
            _ => None,
        };
        let known = self.lexer.known_commands().cloned();
        let guard = self.guard.clone();
        let start_pos = self.lexer.stream.pos;
        let stream = &mut self.lexer.stream;
        let length = match filter_name.as_deref() {
            Some("DCT" | "DCTDecode") => {
                find_dct_decode_inline_stream_end(stream, known.as_ref(), &guard)?
            }
            Some("A85" | "ASCII85Decode") => {
                find_ascii85_decode_inline_stream_end(stream, known.as_ref(), &guard)?
            }
            Some("AHx" | "ASCIIHexDecode") => {
                find_ascii_hex_decode_inline_stream_end(stream, known.as_ref(), &guard)?
            }
            _ => find_default_inline_stream_end(stream, known.as_ref(), &guard)?,
        };
        let length = usize::try_from(length).unwrap_or(0);
        let raw = self.lexer.stream.make_sub_stream(start_pos, Some(length));
        let stream = self.build_stream(dict, &raw, cipher)?;
        self.buf2 = Obj::cmd("EI");
        self.shift()?;
        Ok(stream)
    }

    // ---- streams -------------------------------------------------------------------------------------------------

    /// `#findStreamLength`: the distance from `start_pos` to the next `endstream` (also `endsteam`, `endstrea`
    /// followed by white space), or -1.
    fn find_stream_length(&mut self, start_pos: usize) -> Result<i64> {
        const SCAN_BLOCK_LENGTH: usize = 2048;
        const SIGNATURE_LENGTH: usize = 9;
        const END_SIGNATURE: &[u8] = b"end";
        const PARTIAL_SIGNATURE: [&[u8]; 3] = [b"stream", b"steam", b"strea"];
        let normal_length = SIGNATURE_LENGTH - END_SIGNATURE.len();
        let stream = &mut self.lexer.stream;
        stream.pos = start_pos;
        while stream.pos < stream.end {
            self.guard.tick()?;
            let scan = stream.peek_bytes(SCAN_BLOCK_LENGTH).to_vec();
            let Some(scan_length) = scan.len().checked_sub(SIGNATURE_LENGTH).filter(|n| *n > 0)
            else {
                break;
            };
            let mut pos = 0;
            while pos < scan_length {
                let mut j = 0;
                while j < END_SIGNATURE.len() && scan[pos + j] == END_SIGNATURE[j] {
                    j += 1;
                }
                if j >= END_SIGNATURE.len() {
                    let mut found = false;
                    for part in PARTIAL_SIGNATURE {
                        let mut k = 0;
                        while k < part.len() && scan.get(pos + j + k) == Some(&part[k]) {
                            k += 1;
                        }
                        if k >= normal_length {
                            found = true;
                            break;
                        }
                        if k >= part.len() {
                            let last_byte = scan.get(pos + j + k).map_or(-1, |b| i32::from(*b));
                            if is_white_space(last_byte) {
                                tracing::debug!(
                                    "Found \"end{}\" when searching for endstream command.",
                                    String::from_utf8_lossy(part)
                                );
                                found = true;
                            }
                            break;
                        }
                    }
                    if found {
                        stream.pos += pos;
                        return Ok((stream.pos - start_pos) as i64);
                    }
                }
                pos += 1;
            }
            stream.pos += scan_length;
        }
        Ok(-1)
    }

    /// `makeStream`: the stream whose dictionary has just been read.
    fn make_stream(&mut self, dict: Dict, cipher: Option<&Cipher>) -> Result<Obj> {
        self.lexer.skip_to_next_line();
        let start_pos = self.lexer.stream.pos.saturating_sub(1);
        let length_obj = match dict.get_raw("Length") {
            Some(value) => self.fetch_if_ref(value.clone())?,
            None => Obj::Null,
        };
        let mut length = match length_obj.as_int() {
            Some(length) => length,
            None => {
                tracing::debug!("Bad length in stream.");
                0
            }
        };
        self.lexer.stream.pos =
            usize::try_from((start_pos as i64).saturating_add(length)).unwrap_or(0);
        self.lexer.next_char();
        if self.try_shift()? && self.buf2.is_cmd("endstream") {
            self.shift()?;
        } else {
            length = self.find_stream_length(start_pos)?;
            if length < 0 {
                return Err(PdfError::format("Missing endstream command."));
            }
            self.lexer.next_char();
            self.shift()?;
            self.shift()?;
        }
        self.shift()?;
        let length = usize::try_from(length).unwrap_or(0);
        let raw = self.lexer.stream.make_sub_stream(start_pos, Some(length));
        self.build_stream(dict, &raw, cipher)
    }

    /// Resolves `/Filter` and `/DecodeParms` into the chain, applies the cipher unless there is a `Crypt` filter,
    /// and makes the stream object (`filter` and `makeFilter`, without the decoding).
    fn build_stream(&self, dict: Dict, raw: &ByteStream, cipher: Option<&Cipher>) -> Result<Obj> {
        let (chain, has_crypt) = self.filter_chain(&dict)?;
        let embedded_file = if cipher.is_some_and(|c| c.decryptor.uses_embedded_filter()) {
            self.dict_get2(&dict, "Type", "Type")?.as_name() == Some("EmbeddedFile")
        } else {
            false
        };
        if let Some(c) = cipher {
            if !has_crypt {
                c.decryptor
                    .validate_stream(c.num, c.generation, None, embedded_file, self.xref)?;
            } else if raw.length() != 0 {
                for spec in chain.iter().filter(|spec| spec.name == "Crypt") {
                    let name = spec
                        .params
                        .as_ref()
                        .and_then(|p| p.get_raw("Name"))
                        .and_then(Obj::as_name)
                        .unwrap_or("Identity");
                    if let Err(error) = c.decryptor.validate_stream(
                        c.num,
                        c.generation,
                        Some(name),
                        embedded_file,
                        self.xref,
                    ) {
                        if error.is_fatal() {
                            return Err(error);
                        }
                        tracing::warn!("Invalid stream: \"{error}\"");
                        return Ok(Obj::Stream(Arc::new(PdfStream::new(
                            Arc::new(dict),
                            &ByteStream::from_vec(Vec::new()),
                            Vec::new(),
                            None,
                            false,
                            embedded_file,
                        ))));
                    }
                }
            }
        }

        let stream = PdfStream::new(
            Arc::new(dict),
            raw,
            chain,
            cipher.cloned(),
            cipher.is_some() && !has_crypt,
            embedded_file,
        );
        Ok(Obj::Stream(Arc::new(stream)))
    }

    fn filter_chain(&self, dict: &Dict) -> Result<(Vec<FilterSpec>, bool)> {
        let filter = self.dict_get2(dict, "F", "Filter")?;
        let params = self.dict_get2(dict, "DP", "DecodeParms")?;
        let mut chain = Vec::new();
        let mut has_crypt = false;
        match &filter {
            Obj::Name(name) => {
                if matches!(params, Obj::Array(_)) {
                    tracing::warn!("/DecodeParms should not be an Array, when /Filter is a Name.");
                }
                has_crypt = &**name == "Crypt";
                chain.push(FilterSpec {
                    name: name.to_string(),
                    params: self.resolve_params(&params)?,
                });
            }
            Obj::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    self.guard.tick()?;
                    let item = self.fetch_if_ref(item.clone())?;
                    let name = match &item {
                        Obj::Name(name) => name.clone(),
                        other => {
                            let shown = match other {
                                Obj::Null => "null".to_owned(),
                                Obj::Num(n) => n.to_string(),
                                _ => "[object Object]".to_owned(),
                            };
                            return Err(PdfError::format(format!("Bad filter name \"{shown}\"")));
                        }
                    };
                    has_crypt |= &*name == "Crypt";
                    let param = match &params {
                        Obj::Array(list) => match list.get(i) {
                            Some(p) => self.fetch_if_ref(p.clone())?,
                            None => Obj::Null,
                        },
                        _ => Obj::Null,
                    };
                    chain.push(FilterSpec {
                        name: name.to_string(),
                        params: self.resolve_params(&param)?,
                    });
                }
            }
            _ => {}
        }
        Ok((chain, has_crypt))
    }

    /// The parameter dictionary with the references of its values fetched (the decoders read plain values).
    fn resolve_params(&self, params: &Obj) -> Result<Option<Arc<Dict>>> {
        let Obj::Dict(dict) = params else {
            return Ok(None);
        };
        let mut resolved = Dict::new();
        for (key, value) in dict.iter() {
            let value = match self.fetch_if_ref(value.clone()) {
                Ok(v) => v,
                Err(e) if e.is_fatal() => return Err(e),
                Err(_) => value.clone(),
            };
            resolved.set(key, value);
        }
        Ok(Some(Arc::new(resolved)))
    }
}

// ---- end-of-inline-image searches --------------------------------------------------------------------------------

/// `findDefaultInlineStreamEnd`: scans for `EI` followed by white space, then asks whether what follows reads as
/// content-stream operators (the argument counts of `known_commands`). The returned length excludes the `EI`.
fn find_default_inline_stream_end(
    stream: &mut ByteStream,
    known: Option<&Arc<KnownCommands>>,
    guard: &Arc<Guard>,
) -> Result<i64> {
    const E: i32 = 0x45;
    const I: i32 = 0x49;
    const SPACE: i32 = 0x20;
    const LF: i32 = 0xa;
    const CR: i32 = 0xd;
    const NUL: i32 = 0x0;
    const N: usize = 15;
    let start_pos = stream.pos;
    let mut state = 0;
    let mut maybe_ei_pos = 0_usize;
    let mut ch;
    loop {
        ch = stream.get_byte();
        if ch == -1 {
            break;
        }
        guard.tick()?;
        if state == 0 {
            state = i32::from(ch == E);
        } else if state == 1 {
            state = if ch == I { 2 } else { 0 };
        } else if ch == SPACE || ch == LF || ch == CR {
            maybe_ei_pos = stream.pos;
            let following = stream.peek_bytes(N).to_vec();
            if following.is_empty() {
                break;
            }
            for (i, byte) in following.iter().enumerate() {
                ch = i32::from(*byte);
                if ch == NUL && following.get(i + 1) != Some(&0) {
                    continue;
                }
                if ch != LF && ch != CR && !(SPACE..=0x7f).contains(&ch) {
                    state = 0;
                    break;
                }
            }
            if state != 2 {
                continue;
            }
            let Some(known) = known else {
                tracing::warn!("findDefaultInlineStreamEnd - `lexer.knownCommands` is undefined.");
                continue;
            };
            let tail = stream.peek_bytes(5 * N).to_vec();
            let mut tmp = Lexer::with_known_commands(
                ByteStream::from_vec(tail),
                guard.clone(),
                Some(known.clone()),
            );
            let mut num_args = 0_usize;
            loop {
                let next = tmp.get_obj()?;
                if next.is_eof() {
                    state = 0;
                    break;
                }
                if let Obj::Cmd(cmd) = &next {
                    match known.get(&**cmd) {
                        None => {
                            state = 0;
                            break;
                        }
                        Some(known_command) => {
                            let fits = if known_command.variable_args {
                                num_args <= known_command.num_args
                            } else {
                                num_args == known_command.num_args
                            };
                            if fits {
                                break;
                            }
                        }
                    }
                    num_args = 0;
                    continue;
                }
                num_args += 1;
            }
            if state == 2 {
                break;
            }
        } else {
            state = 0;
        }
    }
    if ch == -1 {
        tracing::warn!(
            "findDefaultInlineStreamEnd: Reached the end of the stream without finding a valid EI marker"
        );
        if maybe_ei_pos != 0 {
            tracing::warn!("... trying to recover by using the last \"EI\" occurrence.");
            stream.skip(-((stream.pos as isize) - (maybe_ei_pos as isize)));
        }
    }
    let mut end_offset: isize = 4;
    stream.skip(-end_offset);
    ch = stream.peek_byte();
    stream.skip(end_offset);
    if !is_white_space(ch) {
        end_offset -= 1;
    }
    Ok(stream.pos as i64 - end_offset as i64 - start_pos as i64)
}

/// `findDCTDecodeInlineStreamEnd`: follows the JPEG markers to the end-of-image marker.
fn find_dct_decode_inline_stream_end(
    stream: &mut ByteStream,
    known: Option<&Arc<KnownCommands>>,
    guard: &Arc<Guard>,
) -> Result<i64> {
    let start_pos = stream.pos;
    let mut found_eoi = false;
    let mut b;
    loop {
        b = stream.get_byte();
        if b == -1 {
            break;
        }
        guard.tick()?;
        if b != 0xff {
            continue;
        }
        match stream.get_byte() {
            0x00 => {}
            0xff => stream.skip(-1),
            0xd9 => found_eoi = true,
            0xc0..=0xc7 | 0xc9..=0xcf | 0xda..=0xef | 0xfe => {
                let marker_length = stream.get_uint16();
                if marker_length > 2 {
                    stream.skip((marker_length - 2) as isize);
                } else {
                    stream.skip(-2);
                }
            }
            _ => {}
        }
        if found_eoi {
            break;
        }
    }
    let length = stream.pos as i64 - start_pos as i64;
    if b == -1 {
        tracing::warn!(
            "Inline DCTDecode image stream: EOI marker not found, searching for /EI/ instead."
        );
        stream.skip(-(length as isize));
        return find_default_inline_stream_end(stream, known, guard);
    }
    inline_stream_skip_ei(stream);
    Ok(length)
}

/// `findASCII85DecodeInlineStreamEnd`: up to the `~>` marker.
fn find_ascii85_decode_inline_stream_end(
    stream: &mut ByteStream,
    known: Option<&Arc<KnownCommands>>,
    guard: &Arc<Guard>,
) -> Result<i64> {
    const TILDE: i32 = 0x7e;
    const GT: i32 = 0x3e;
    let start_pos = stream.pos;
    let mut ch;
    loop {
        ch = stream.get_byte();
        if ch == -1 {
            break;
        }
        guard.tick()?;
        if ch == TILDE {
            let tilde_pos = stream.pos;
            ch = stream.peek_byte();
            while is_white_space(ch) {
                stream.skip(1);
                ch = stream.peek_byte();
            }
            if ch == GT {
                stream.skip(1);
                break;
            }
            if stream.pos > tilde_pos {
                let maybe_ei = stream.peek_bytes(2);
                if maybe_ei.first() == Some(&0x45) && maybe_ei.get(1) == Some(&0x49) {
                    break;
                }
            }
        }
    }
    let length = stream.pos as i64 - start_pos as i64;
    if ch == -1 {
        tracing::warn!(
            "Inline ASCII85Decode image stream: EOD marker not found, searching for /EI/ instead."
        );
        stream.skip(-(length as isize));
        return find_default_inline_stream_end(stream, known, guard);
    }
    inline_stream_skip_ei(stream);
    Ok(length)
}

/// `findASCIIHexDecodeInlineStreamEnd`: up to the `>` marker.
fn find_ascii_hex_decode_inline_stream_end(
    stream: &mut ByteStream,
    known: Option<&Arc<KnownCommands>>,
    guard: &Arc<Guard>,
) -> Result<i64> {
    const GT: i32 = 0x3e;
    let start_pos = stream.pos;
    let mut ch;
    loop {
        ch = stream.get_byte();
        if ch == -1 || ch == GT {
            break;
        }
        guard.tick()?;
    }
    let length = stream.pos as i64 - start_pos as i64;
    if ch == -1 {
        tracing::warn!(
            "Inline ASCIIHexDecode image stream: EOD marker not found, searching for /EI/ instead."
        );
        stream.skip(-(length as isize));
        return find_default_inline_stream_end(stream, known, guard);
    }
    inline_stream_skip_ei(stream);
    Ok(length)
}

/// `inlineStreamSkipEI`: past the next `EI` and the byte after it.
fn inline_stream_skip_ei(stream: &mut ByteStream) {
    const E: i32 = 0x45;
    const I: i32 = 0x49;
    let mut state = 0;
    loop {
        let ch = stream.get_byte();
        if ch == -1 {
            break;
        }
        if state == 0 {
            state = i32::from(ch == E);
        } else if state == 1 {
            state = if ch == I { 2 } else { 0 };
        } else if state == 2 {
            break;
        }
    }
}

// ---- linearization -------------------------------------------------------------------------------------------------

/// The linearization dictionary of a linearized file (`Linearization.create`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Linearization {
    pub length: usize,
    pub hints: Vec<i64>,
    pub object_number_first: i64,
    pub end_first: i64,
    pub num_pages: i64,
    pub main_xref_entries_offset: i64,
    pub page_first: i64,
}

impl Linearization {
    /// Reads the first object at the stream's position. `Ok(None)` when it is no linearization dictionary; an
    /// `Err` (pdf.js: a plain `Error`) when it is one with invalid parameters.
    pub fn create(stream: &ByteStream, guard: &Arc<Guard>) -> Result<Option<Linearization>> {
        fn get_int(dict: &Dict, name: &str, allow_zero: bool) -> Result<i64> {
            let least = i64::from(!allow_zero);
            if let Some(n) = dict.get_raw(name).and_then(Obj::as_int)
                && n >= least
            {
                return Ok(n);
            }
            Err(PdfError::format(format!(
                "The \"{name}\" parameter in the linearization dictionary is invalid."
            )))
        }
        fn get_hints(dict: &Dict) -> Result<Vec<i64>> {
            if let Some(Obj::Array(hints)) = dict.get_raw("H")
                && (hints.len() == 2 || hints.len() == 4)
            {
                let mut out = Vec::new();
                for (index, hint) in hints.iter().enumerate() {
                    match hint.as_int() {
                        Some(n) if n > 0 => out.push(n),
                        _ => {
                            return Err(PdfError::format(format!(
                                "Hint ({index}) in the linearization dictionary is invalid."
                            )));
                        }
                    }
                }
                return Ok(out);
            }
            Err(PdfError::format(
                "Hint array in the linearization dictionary is invalid.",
            ))
        }

        let mut parser = Parser::new(
            Lexer::new(stream.clone(), guard.clone()),
            None,
            false,
            false,
        )?;
        let obj1 = parser.get_obj(None)?;
        let obj2 = parser.get_obj(None)?;
        let obj3 = parser.get_obj(None)?;
        let lin_dict = parser.get_obj(None)?;
        let Obj::Dict(lin_dict) = lin_dict else {
            return Ok(None);
        };
        let linearized = lin_dict
            .get_raw("Linearized")
            .and_then(Obj::as_num)
            .is_some_and(|n| n > 0.0);
        if !(obj1.as_int().is_some() && obj2.as_int().is_some() && obj3.is_cmd("obj") && linearized)
        {
            return Ok(None);
        }
        let length = get_int(&lin_dict, "L", false)?;
        if usize::try_from(length).ok() != Some(stream.length()) {
            return Err(PdfError::format(
                "The \"L\" parameter in the linearization dictionary does not equal the stream length.",
            ));
        }
        Ok(Some(Linearization {
            length: stream.length(),
            hints: get_hints(&lin_dict)?,
            object_number_first: get_int(&lin_dict, "O", false)?,
            end_first: get_int(&lin_dict, "E", false)?,
            num_pages: get_int(&lin_dict, "N", false)?,
            main_xref_entries_offset: get_int(&lin_dict, "T", false)?,
            page_first: if lin_dict.has("P") {
                get_int(&lin_dict, "P", true)?
            } else {
                0
            },
        }))
    }
}
