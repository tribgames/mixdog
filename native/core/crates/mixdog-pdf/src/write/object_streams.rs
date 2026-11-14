//! The compact file form: objects that may be packed go into object streams (`/Type /ObjStm`, fifty to a stream), the
//! rest are written as they are, and a cross-reference stream (`/Type /XRef`) replaces the table and the trailer
//! (pdf-lib's `PDFStreamWriter` with `useObjectStreams`). Every stream written here is Flate-compressed.

use std::collections::BTreeMap;
use std::io::Write;

use flate2::Compression;
use flate2::write::ZlibEncoder;

use crate::object::{Dict, Obj, Ref};
use crate::stream::FilterSpec;
use crate::write::serialize::{HEADER, trailer_dict, write_indirect, write_obj};
use crate::write::store::{ObjectStore, stream_object};

/// Objects per object stream (`PDFStreamWriter`'s `objectsPerStream`).
const OBJECTS_PER_STREAM: usize = 50;

/// `data` as a zlib stream at the default level (what pdf-lib's pako call does).
pub fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::with_capacity(data.len() / 2 + 16), Compression::default());
    // Writing into a `Vec` does not fail.
    let written = encoder.write_all(data).and_then(|()| encoder.finish());
    written.unwrap_or_default()
}

/// A stream object whose data is `contents` compressed with `FlateDecode`: `dict` gets the `Filter` entry, and its
/// `Length` is written on save. This is how a content stream is made.
pub fn flate_stream(mut dict: Dict, contents: &[u8]) -> Obj {
    dict.set("Filter", Obj::name("FlateDecode"));
    let chain = vec![FilterSpec {
        name: "FlateDecode".to_owned(),
        params: None,
    }];
    stream_object(dict, deflate(contents), chain)
}

/// Where the cross-reference stream finds an object.
enum Placed {
    Free,
    Plain { offset: usize, generation: i64 },
    Packed { stream: i64, index: usize },
}

/// The bytes a field needs (at least one).
fn width_of(n: u64) -> usize {
    ((64 - n.leading_zeros() as usize).max(1)).div_ceil(8)
}

fn push_field(out: &mut Vec<u8>, value: u64, width: usize) {
    let bytes = value.to_be_bytes();
    out.extend_from_slice(&bytes[bytes.len() - width..]);
}

/// The file with object streams and a cross-reference stream. Objects stay out of object streams when they are
/// streams, have a generation other than 0, are the `Encrypt` dictionary, or when the document is encrypted: the
/// strings of an encrypted file are ciphered per object, and a packed object has no key of its own.
pub(crate) fn save_with_object_streams(store: &ObjectStore, encrypted: bool) -> Vec<u8> {
    let mut out = HEADER.to_vec();
    let mut placed: BTreeMap<i64, Placed> = BTreeMap::new();
    placed.insert(0, Placed::Free);

    let mut chunks: Vec<Vec<(Ref, &Obj)>> = Vec::new();
    for (r, obj) in store.iter() {
        let stays = encrypted
            || store.trailer.encrypt == Some(r)
            || matches!(obj, Obj::Stream(_))
            || r.generation != 0;
        if stays {
            placed.insert(
                r.num,
                Placed::Plain {
                    offset: out.len(),
                    generation: r.generation,
                },
            );
            write_indirect(&mut out, r, obj);
        } else {
            if chunks.last().is_none_or(|chunk| chunk.len() == OBJECTS_PER_STREAM) {
                chunks.push(Vec::new());
            }
            if let Some(chunk) = chunks.last_mut() {
                chunk.push((r, obj));
            }
        }
    }

    let mut next_num = store.largest_object_number() + 1;
    for chunk in &chunks {
        let stream_num = next_num;
        next_num += 1;
        let mut header = String::new();
        let mut body: Vec<u8> = Vec::new();
        for (index, (r, obj)) in chunk.iter().enumerate() {
            header.push_str(&format!("{} {} ", r.num, body.len()));
            write_obj(&mut body, obj);
            body.push(b'\n');
            placed.insert(
                r.num,
                Placed::Packed {
                    stream: stream_num,
                    index,
                },
            );
        }
        let mut dict = Dict::new();
        dict.set("Type", Obj::name("ObjStm"));
        dict.set("N", Obj::Num(chunk.len() as f64));
        dict.set("First", Obj::Num(header.len() as f64));
        let mut contents = header.into_bytes();
        contents.extend_from_slice(&body);
        placed.insert(
            stream_num,
            Placed::Plain {
                offset: out.len(),
                generation: 0,
            },
        );
        write_indirect(&mut out, Ref::new(stream_num, 0), &flate_stream(dict, &contents));
    }

    let xref_num = next_num;
    let xref_offset = out.len();
    placed.insert(
        xref_num,
        Placed::Plain {
            offset: xref_offset,
            generation: 0,
        },
    );

    let fields: Vec<(i64, [u64; 3])> = placed
        .iter()
        .map(|(num, place)| {
            let triple = match place {
                Placed::Free => [0, 0, 65535],
                Placed::Plain { offset, generation } => [1, *offset as u64, *generation as u64],
                Placed::Packed { stream, index } => [2, *stream as u64, *index as u64],
            };
            (*num, triple)
        })
        .collect();
    let widths = [0, 1, 2].map(|column| {
        width_of(fields.iter().map(|(_, triple)| triple[column]).max().unwrap_or(0))
    });
    let mut contents = Vec::with_capacity(fields.len() * widths.iter().sum::<usize>());
    for (_, triple) in &fields {
        for (value, width) in triple.iter().zip(widths) {
            push_field(&mut contents, *value, width);
        }
    }
    let mut index: Vec<Obj> = Vec::new();
    let mut at = 0;
    while at < fields.len() {
        let mut end = at + 1;
        while end < fields.len() && fields[end].0 == fields[end - 1].0 + 1 {
            end += 1;
        }
        index.push(Obj::Num(fields[at].0 as f64));
        index.push(Obj::Num((end - at) as f64));
        at = end;
    }

    let mut dict = Dict::new();
    dict.set("Type", Obj::name("XRef"));
    for (key, value) in trailer_dict(store, xref_num + 1).iter() {
        dict.set(key, value.clone());
    }
    dict.set(
        "W",
        Obj::Array(std::sync::Arc::new(widths.iter().map(|w| Obj::Num(*w as f64)).collect())),
    );
    dict.set("Index", Obj::Array(std::sync::Arc::new(index)));
    write_indirect(&mut out, Ref::new(xref_num, 0), &flate_stream(dict, &contents));
    out.extend_from_slice(format!("startxref\n{xref_offset}\n%%EOF\n").as_bytes());
    out
}
