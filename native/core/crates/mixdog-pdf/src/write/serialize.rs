//! Writing objects as PDF syntax, and the classic file form: a header, every object as `n g obj ... endobj`, a
//! cross-reference table with one subsection per run of object numbers, the trailer and `startxref`
//! (pdf-lib's `PDFWriter`).

use crate::object::{Dict, Obj, Ref};
use crate::write::store::ObjectStore;

/// `%PDF-1.7`, as pdf-lib writes whatever the version of the file read, then a comment of bytes above 127 so a
/// transfer that treats the file as text leaves it alone.
pub(crate) const HEADER: &[u8] = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n\n";

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// `Size`, `Root`, `Encrypt`, `Info` and `ID` of the trailer (`PDFWriter.createTrailerDict`). `size` is one more than
/// the largest object number the file holds.
pub(crate) fn trailer_dict(store: &ObjectStore, size: i64) -> Dict {
    let mut dict = Dict::new();
    dict.set("Size", Obj::Num(size as f64));
    let trailer = &store.trailer;
    if let Some(root) = trailer.root {
        dict.set("Root", Obj::Ref(root));
    }
    if let Some(encrypt) = trailer.encrypt {
        dict.set("Encrypt", Obj::Ref(encrypt));
    }
    if let Some(info) = trailer.info {
        dict.set("Info", Obj::Ref(info));
    }
    if let Some(id) = &trailer.id {
        dict.set("ID", id.clone());
    }
    dict
}

fn write_number(out: &mut Vec<u8>, n: f64) {
    if !n.is_finite() {
        out.push(b'0');
    } else if n.fract() == 0.0 && n.abs() < 1e15 {
        out.extend_from_slice((n as i64).to_string().as_bytes());
    } else {
        // `Display` for `f64` never uses an exponent.
        out.extend_from_slice(n.to_string().as_bytes());
    }
}

fn write_name_byte(out: &mut Vec<u8>, byte: u8) {
    let regular = byte > 0x20
        && byte < 0x7f
        && !matches!(byte, b'#' | b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%');
    if regular {
        out.push(byte);
    } else {
        out.extend_from_slice(&[b'#', HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 15)]]);
    }
}

fn write_name(out: &mut Vec<u8>, name: &str) {
    out.push(b'/');
    // A name holds one byte per character (Latin-1); a character above U+00FF can only have been put in by a caller,
    // and goes out as its UTF-8 bytes.
    let mut buffer = [0u8; 4];
    for c in name.chars() {
        match u8::try_from(u32::from(c)) {
            Ok(byte) => write_name_byte(out, byte),
            Err(_) => {
                for byte in c.encode_utf8(&mut buffer).bytes() {
                    write_name_byte(out, byte);
                }
            }
        }
    }
}

/// A literal string when every byte is printable ASCII, else a hexadecimal string.
fn write_string(out: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.iter().all(|b| (0x20..0x7f).contains(b)) {
        out.push(b'(');
        for &byte in bytes {
            if matches!(byte, b'(' | b')' | b'\\') {
                out.push(b'\\');
            }
            out.push(byte);
        }
        out.push(b')');
    } else {
        out.push(b'<');
        for &byte in bytes {
            out.extend_from_slice(&[HEX[usize::from(byte >> 4)], HEX[usize::from(byte & 15)]]);
        }
        out.push(b'>');
    }
}

fn write_dict(out: &mut Vec<u8>, dict: &Dict) {
    out.extend_from_slice(b"<<");
    for (key, value) in dict.iter() {
        out.push(b'\n');
        write_name(out, key);
        out.push(b' ');
        write_obj(out, value);
    }
    out.extend_from_slice(b"\n>>");
}

/// One object as PDF syntax. A stream is its dictionary (with `Length` the byte count of the stored data) and the
/// data; the markers a parser hands out (`Cmd`, `Eof`, `CircularRef`) are written as `null`.
pub(crate) fn write_obj(out: &mut Vec<u8>, obj: &Obj) {
    match obj {
        Obj::Null | Obj::Cmd(_) | Obj::Eof | Obj::CircularRef => out.extend_from_slice(b"null"),
        Obj::Bool(true) => out.extend_from_slice(b"true"),
        Obj::Bool(false) => out.extend_from_slice(b"false"),
        Obj::Num(n) => write_number(out, *n),
        Obj::Str(bytes) => write_string(out, bytes),
        Obj::Name(name) => write_name(out, name),
        Obj::Array(items) => {
            out.push(b'[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(b' ');
                }
                write_obj(out, item);
            }
            out.push(b']');
        }
        Obj::Dict(dict) => write_dict(out, dict),
        Obj::Stream(stream) => {
            let mut dict = (*stream.dict).clone();
            dict.set("Length", Obj::Num(stream.raw().len() as f64));
            write_dict(out, &dict);
            out.extend_from_slice(b"\nstream\n");
            out.extend_from_slice(stream.raw());
            out.extend_from_slice(b"\nendstream");
        }
        Obj::Ref(r) => write_ref(out, *r),
    }
}

fn write_ref(out: &mut Vec<u8>, r: Ref) {
    out.extend_from_slice(format!("{} {} R", r.num, r.generation).as_bytes());
}

/// `n g obj`, the object, `endobj`.
pub(crate) fn write_indirect(out: &mut Vec<u8>, r: Ref, obj: &Obj) {
    out.extend_from_slice(format!("{} {} obj\n", r.num, r.generation).as_bytes());
    write_obj(out, obj);
    out.extend_from_slice(b"\nendobj\n\n");
}

/// The file in its classic form: every object, a cross-reference table, the trailer.
pub(crate) fn save_classic(store: &ObjectStore) -> Vec<u8> {
    let mut out = HEADER.to_vec();
    let mut entries: Vec<(i64, i64, usize)> = Vec::with_capacity(store.len());
    for (r, obj) in store.iter() {
        entries.push((r.num, r.generation, out.len()));
        write_indirect(&mut out, r, obj);
    }

    let xref_offset = out.len();
    out.extend_from_slice(b"xref\n");
    let mut rows: Vec<(i64, i64, usize, bool)> = vec![(0, 65535, 0, true)];
    rows.extend(entries.iter().map(|&(num, generation, offset)| (num, generation, offset, false)));
    let mut start = 0;
    while start < rows.len() {
        let mut end = start + 1;
        while end < rows.len() && rows[end].0 == rows[end - 1].0 + 1 {
            end += 1;
        }
        out.extend_from_slice(format!("{} {}\n", rows[start].0, end - start).as_bytes());
        for &(_, generation, offset, free) in &rows[start..end] {
            let kind = if free { 'f' } else { 'n' };
            out.extend_from_slice(format!("{offset:010} {generation:05} {kind} \n").as_bytes());
        }
        start = end;
    }

    out.extend_from_slice(b"trailer\n");
    write_dict(&mut out, &trailer_dict(store, store.largest_object_number() + 1));
    out.extend_from_slice(format!("\nstartxref\n{xref_offset}\n%%EOF\n").as_bytes());
    out
}
