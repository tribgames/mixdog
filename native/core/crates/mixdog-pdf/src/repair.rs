//! Reconstruction of a broken cross-reference table: pdf.js's `XRef.indexObjects`. The file is scanned for
//! `N G obj` and `trailer`, the entries are rebuilt from what is found (the last definition of an object wins,
//! unless it is cut off), object streams named by `/XRef` are read for their entries, and the trailer that leads to
//! a catalog is chosen.
//!
//! pdf.js runs it when reading the table raises `XRefParseException`, and for an entry that leads to the wrong
//! object (`XRefEntryException`) while the first or last page is read or the page tree is walked outside recovery
//! mode: [`triggers_rebuild`] says which failures those are, [`crate::Xref::rebuild`] runs it.

use std::sync::Arc;

use crate::error::{PdfError, Result};
use crate::lexer::Lexer;
use crate::object::{Dict, Obj, Ref};
use crate::parser::Parser;
use crate::xref::{Entry, Xref};

/// `true` for the failures after which pdf.js indexes the file again in recovery mode: `XRefParseException`, and
/// `XRefEntryException` when the reader is not in recovery mode already.
pub fn triggers_rebuild(error: &PdfError, in_recovery_mode: bool) -> bool {
    matches!(error, PdfError::XRefParse | PdfError::XRefEntry(_)) && !in_recovery_mode
}

/// `\s` of a JavaScript regular expression on a Latin-1 string (also VT, FF and NBSP, not NEL).
fn js_space(b: u8) -> bool {
    matches!(b, 9..=13 | 0x20 | 0xa0)
}

/// `\w` of a JavaScript regular expression.
fn js_word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `\b` at `at` of `data`.
fn boundary(data: &[u8], at: usize) -> bool {
    let before = at
        .checked_sub(1)
        .and_then(|i| data.get(i))
        .is_some_and(|b| js_word(*b));
    let after = data.get(at).is_some_and(|b| js_word(*b));
    before != after
}

/// `ToInt32` of the number the digits spell (`m[1] | 0`).
fn digits_to_int32(digits: &[u8]) -> i64 {
    let mut value = 0.0_f64;
    for d in digits {
        value = value * 10.0 + f64::from(d - b'0');
    }
    if !value.is_finite() {
        return 0;
    }
    i64::from(value.rem_euclid(4_294_967_296.0) as u64 as u32 as i32)
}

/// `\d+\s+\d+\s+obj` at the start of `data`: the end of the match and the two numbers.
fn match_obj(data: &[u8]) -> Option<(usize, i64, i64)> {
    let digits = |from: usize| {
        data[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let spaces = |from: usize| data[from..].iter().take_while(|b| js_space(**b)).count();
    let d1 = digits(0);
    if d1 == 0 {
        return None;
    }
    let s1 = spaces(d1);
    if s1 == 0 {
        return None;
    }
    let p2 = d1 + s1;
    let d2 = digits(p2);
    if d2 == 0 {
        return None;
    }
    let s2 = spaces(p2 + d2);
    if s2 == 0 {
        return None;
    }
    let end = p2 + d2 + s2 + 3;
    if data.get(p2 + d2 + s2..end)? != b"obj" {
        return None;
    }
    Some((
        end,
        digits_to_int32(&data[..d1]),
        digits_to_int32(&data[p2..p2 + d2]),
    ))
}

/// `objRegExp` (`^(\d+)\s+(\d+)\s+obj\b`) on a token.
fn match_obj_token(token: &[u8]) -> Option<(i64, i64)> {
    let (end, num, generation) = match_obj(token)?;
    let next_is_word = token.get(end).is_some_and(|b| js_word(*b));
    // `\b` after the `j`: it ends the token or is followed by a non-word character.
    if next_is_word {
        None
    } else {
        Some((num, generation))
    }
}

/// What one of the two scanning expressions found.
struct Found {
    start: usize,
    end: usize,
    text_is: &'static str,
}

/// `exec` of `/\b(endobj|\d+\s+\d+\s+obj|xref|trailer\s*<<)\b/g` (`for_obj_end`) or of
/// `/\b(startxref|\d+\s+\d+\s+obj)\b/g` from `from`.
fn scan(data: &[u8], from: usize, for_obj_end: bool) -> Option<Found> {
    let mut p = from;
    while p < data.len() {
        let b = data[p];
        let candidate = b.is_ascii_digit()
            || if for_obj_end {
                matches!(b, b'e' | b'x' | b't')
            } else {
                b == b's'
            };
        if candidate && boundary(data, p) {
            let rest = &data[p..];
            let mut hit: Option<(usize, &'static str)> = None;
            if b.is_ascii_digit() {
                hit = match_obj(rest).map(|(end, _, _)| (end, "obj"));
            } else if for_obj_end && rest.starts_with(b"endobj") {
                hit = Some((6, "endobj"));
            } else if for_obj_end && rest.starts_with(b"xref") {
                hit = Some((4, "xref"));
            } else if for_obj_end && rest.starts_with(b"trailer") {
                let spaces = rest[7..].iter().take_while(|c| js_space(**c)).count();
                if rest[7 + spaces..].starts_with(b"<<") {
                    hit = Some((7 + spaces + 2, "trailer"));
                }
            } else if !for_obj_end && rest.starts_with(b"startxref") {
                hit = Some((9, "startxref"));
            }
            if let Some((len, text_is)) = hit
                && boundary(data, p + len)
            {
                return Some(Found {
                    start: p,
                    end: p + len,
                    text_is,
                });
            }
        }
        p += 1;
    }
    None
}

/// `skipUntil`: how many bytes from `offset` pass before `what` starts (to the end when it does not).
fn skip_until(data: &[u8], offset: usize, what: &[u8]) -> usize {
    match data.get(offset..) {
        Some(tail) if !what.is_empty() => tail
            .windows(what.len())
            .position(|w| w == what)
            .unwrap_or(tail.len()),
        _ => 0,
    }
}

/// `readToken`: the bytes from `offset` up to a line end or `<` (the last byte of the data is left out, as in pdf.js).
fn read_token(data: &[u8], offset: usize) -> &[u8] {
    let mut pos = offset;
    let mut pushed = offset;
    let mut ch = data[offset];
    while ch != 0x0a && ch != 0x0d && ch != b'<' {
        pos += 1;
        if pos >= data.len() {
            break;
        }
        pushed = pos;
        ch = data[pos];
    }
    &data[offset..pushed]
}

impl Xref {
    /// `XRef.indexObjects`: rebuilds the entries by scanning the file and returns the trailer dictionary to use.
    pub(crate) fn index_objects(&self) -> Result<Arc<Dict>> {
        const TAB: u8 = 0x9;
        const LF: u8 = 0xa;
        const CR: u8 = 0xd;
        const SPACE: u8 = 0x20;
        const PERCENT: u8 = 0x25;
        let guard = self.opts.guard.clone();
        {
            let mut state = self.state.borrow_mut();
            state.entries.clear();
            state.cache.clear();
        }
        let data = self.stream.data().clone();
        let buffer: &[u8] = &data;
        let length = buffer.len();
        let start = self.stream.start;
        let mut position = start;
        let mut trailers: Vec<usize> = Vec::new();
        let mut xref_stms: Vec<i64> = Vec::new();
        while position < length {
            guard.tick()?;
            let ch = buffer[position];
            if matches!(ch, TAB | LF | CR | SPACE) {
                position += 1;
                continue;
            }
            if ch == PERCENT {
                loop {
                    position += 1;
                    if position >= length {
                        break;
                    }
                    if matches!(buffer[position], LF | CR) {
                        break;
                    }
                }
                continue;
            }
            let token = read_token(buffer, position);
            if token.starts_with(b"xref") && (token.len() == 4 || js_space(token[4])) {
                position += skip_until(buffer, position, b"trailer");
                trailers.push(position);
                position += skip_until(buffer, position, b"startxref");
            } else if let Some((num, generation)) = match_obj_token(token) {
                let start_pos = position + token.len();
                let existing = self.state.borrow().entries.get(&num).copied();
                let update_entries = match existing {
                    None => true,
                    Some(e) if e.generation == generation => {
                        let sub = self.stream.make_sub_stream(start_pos, None);
                        let checked =
                            Parser::new(Lexer::new(sub, guard.clone()), None, false, false)
                                .and_then(|mut parser| parser.get_obj(None));
                        match checked {
                            Ok(_) => true,
                            Err(PdfError::ParserEof(message)) => {
                                tracing::warn!(
                                    "indexObjects -- checking object ({}): \"ParserEOFException: {message}\".",
                                    String::from_utf8_lossy(token)
                                );
                                false
                            }
                            Err(e) if e.is_fatal() => return Err(e),
                            Err(_) => true,
                        }
                    }
                    Some(_) => false,
                };
                if update_entries {
                    self.add_entry_replacing(
                        num,
                        Entry {
                            offset: (position - start) as i64,
                            generation,
                            free: false,
                            uncompressed: true,
                        },
                    )?;
                }
                let content_length = match scan(buffer, start_pos, true) {
                    Some(found) => {
                        let end_pos = found.end + 1;
                        let mut content_length = end_pos - position;
                        if found.text_is != "endobj" {
                            tracing::warn!(
                                "indexObjects: Found \"{}\" inside of another \"obj\", caused by missing \"endobj\" -- trying to recover.",
                                found.text_is
                            );
                            content_length -= (found.end - found.start) + 1;
                        }
                        content_length
                    }
                    None => length - position,
                };
                let content = &buffer[position..length.min(position + content_length)];
                let xref_tag_offset = skip_until(content, 0, b"/XRef");
                if xref_tag_offset < content_length
                    && content.get(xref_tag_offset + 5).is_some_and(|b| *b < 64)
                {
                    let at = (position - start) as i64;
                    xref_stms.push(at);
                    self.state.borrow_mut().xref_stms.insert(at);
                }
                position += content_length;
            } else if token.starts_with(b"trailer") && (token.len() == 7 || js_space(token[7])) {
                trailers.push(position);
                let start_pos = position + token.len();
                let content_length = match scan(buffer, start_pos, false) {
                    Some(found) => {
                        let end_pos = found.end + 1;
                        let mut content_length = end_pos - position;
                        if found.text_is != "startxref" {
                            tracing::warn!(
                                "indexObjects: Found \"{}\" after \"trailer\", caused by missing \"startxref\" -- trying to recover.",
                                found.text_is
                            );
                            content_length -= (found.end - found.start) + 1;
                        }
                        content_length
                    }
                    None => length - position,
                };
                position += content_length;
            } else {
                position += token.len() + 1;
            }
        }
        for xref_stm in xref_stms {
            self.state.borrow_mut().queue.push(xref_stm);
            self.read_xref(true)?;
        }
        let mut trailer_dicts: Vec<Arc<Dict>> = Vec::new();
        let mut is_encrypted = false;
        for trailer in trailers {
            let mut stream = self.stream.clone();
            stream.pos = trailer;
            let mut parser =
                Parser::new(Lexer::new(stream, guard.clone()), Some(self), true, true)?;
            if !parser.get_obj(None)?.is_cmd("trailer") {
                continue;
            }
            let Obj::Dict(dict) = parser.get_obj(None)? else {
                continue;
            };
            if dict.has("Encrypt") {
                is_encrypted = true;
            }
            trailer_dicts.push(dict);
        }
        let mut trailer_dict: Option<Arc<Dict>> = None;
        let mut trailer_error = false;
        for pass in 0..2 {
            if pass == 1 {
                if !trailer_error {
                    break;
                }
                self.state.borrow_mut().generation_fallback = true;
            }
            for dict in &trailer_dicts {
                guard.tick()?;
                let valid_pages_dict = match self.trailer_pages_count(dict) {
                    Ok(Some(valid)) => valid,
                    Ok(None) => continue,
                    Err(e) if e.is_fatal() => return Err(e),
                    Err(_) => {
                        trailer_error = true;
                        continue;
                    }
                };
                if valid_pages_dict && (!is_encrypted || dict.has("Encrypt")) && dict.has("ID") {
                    return Ok(dict.clone());
                }
                trailer_dict = Some(dict.clone());
            }
        }
        if let Some(dict) = trailer_dict {
            return Ok(dict);
        }
        if let Some(top) = self.state.borrow().top_dict.clone() {
            return Ok(top);
        }
        if trailer_dicts.is_empty() {
            let numbered: Vec<(i64, i64)> = self
                .state
                .borrow()
                .entries
                .iter()
                .map(|(num, e)| (*num, e.generation))
                .collect();
            for (num, generation) in numbered {
                guard.tick()?;
                let obj = match self.fetch(Ref::new(num, generation), false) {
                    Ok(obj) => obj,
                    Err(e) if e.is_fatal() => return Err(e),
                    Err(_) => continue,
                };
                if let Some(dict) = obj.dict_or_stream_dict()
                    && dict.has("Root")
                {
                    return Ok(dict.clone());
                }
            }
        }
        Err(PdfError::InvalidPdf("Invalid PDF structure.".to_owned()))
    }

    /// The `try` block of the trailer selection: `Ok(None)` when the trailer's catalog or page tree is no
    /// dictionary (pdf.js `continue`s), `Ok(Some(true))` when `/Pages` has an integer `/Count`.
    fn trailer_pages_count(&self, trailer: &Dict) -> Result<Option<bool>> {
        let Obj::Dict(root) = self.get(trailer, "Root")? else {
            return Ok(None);
        };
        let Obj::Dict(pages) = self.get(&root, "Pages")? else {
            return Ok(None);
        };
        Ok(Some(self.get(&pages, "Count")?.as_int().is_some()))
    }

    /// `this.#entries[num] = {...}` of `indexObjects`: replaces whatever entry the object had.
    fn add_entry_replacing(&self, num: i64, entry: Entry) -> Result<()> {
        let mut state = self.state.borrow_mut();
        if !state.entries.contains_key(&num)
            && state.entries.len() >= self.opts.guard.budget().max_objects
        {
            return Err(PdfError::ResourceLimit(format!(
                "more than {} cross-reference entries",
                self.opts.guard.budget().max_objects
            )));
        }
        state.entries.insert(num, entry);
        Ok(())
    }
}
