//! Embedded files (pdf-lib 1.17.1's `PDFDocument.attach` with `FileEmbedder`/`PDFEmbeddedFile`, and the reading of
//! them in `pdf-edit-document.mjs`'s `attachmentEntries` and `attachmentBytes`).
//!
//! * [`PdfDocument::attach`] writes the file as a Flate stream (`Type /EmbeddedFile`, `Subtype` the MIME type,
//!   `Params` with `Size` and the dates), a `Filespec` dictionary (`F`, `UF`, `EF`, `Desc`, `AFRelationship`), and
//!   appends the name and the filespec to `Names /EmbeddedFiles /Names` of the catalog (made when missing, the list
//!   not sorted: pdf-lib appends) and the filespec to the catalog's `AF` array. pdf-lib embeds at save time; here the
//!   objects are made at once, which no reader can tell apart.
//! * [`PdfDocument::attachments`] lists the pairs of `Names /EmbeddedFiles /Names`; when the structure is not what
//!   that path needs, the answer is no attachments (pdf-lib's helper catches the failure).
//! * [`PdfDocument::attachment_bytes`] decodes the stream of `EF /UF`, else `EF /F`.

use std::sync::Arc;

use crate::error::Guard;
use crate::object::{Dict, Obj, Ref};
use crate::stream::StreamFilters;
use crate::write::object_streams::flate_stream;
use crate::write::pages::{edit_child_array, edit_child_dict, invalid};
use crate::write::{PdfDocument, WriteError, decode_text_string, encode_text_string, pdf_date};

/// The options of `attach` (`mimeType`, `description`, `creationDate`, `modificationDate`, `afRelationship`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttachmentOptions {
    /// `Subtype` of the embedded file stream, written as a name; absent when `None`.
    pub mime_type: Option<String>,
    /// `Desc`; an empty description is left out, as pdf-lib leaves out a falsy one.
    pub description: Option<String>,
    /// `Params /CreationDate`, seconds since the Unix epoch.
    pub creation_date: Option<i64>,
    /// `Params /ModDate`, seconds since the Unix epoch.
    pub modification_date: Option<i64>,
    /// `AFRelationship`, written as a name.
    pub af_relationship: Option<String>,
}

/// One attachment as `attachmentEntries` reports it.
#[derive(Debug, Clone)]
pub struct Attachment {
    /// The position in the list, from 1.
    pub index: usize,
    /// The name of the name-tree pair (`decodeText`, empty when there is none).
    pub name: String,
    /// `Desc` of the filespec (empty when there is none).
    pub description: String,
    /// The filespec dictionary.
    pub spec: Arc<Dict>,
}

/// A name that pdf-lib's `PDFString.of(name)` holds: one byte per UTF-16 code unit, the low byte of each.
fn literal_name_bytes(name: &str) -> Vec<u8> {
    name.encode_utf16().map(|unit| (unit & 0xff) as u8).collect()
}

impl PdfDocument {
    /// `attach(bytes, name, options)`: the file is embedded and listed in the catalog.
    pub fn attach(&mut self, data: &[u8], name: &str, options: &AttachmentOptions) -> Result<Ref, WriteError> {
        let spec_ref = self.store.next_ref();

        let mut params = Dict::new();
        params.set("Size", Obj::Num(data.len() as f64));
        if let Some(created) = options.creation_date {
            params.set("CreationDate", Obj::string(pdf_date(created).as_bytes()));
        }
        if let Some(modified) = options.modification_date {
            params.set("ModDate", Obj::string(pdf_date(modified).as_bytes()));
        }
        let mut stream_dict = Dict::new();
        stream_dict.set("Type", Obj::name("EmbeddedFile"));
        if let Some(mime) = &options.mime_type {
            stream_dict.set("Subtype", Obj::name(mime));
        }
        stream_dict.set("Params", Obj::Dict(Arc::new(params)));
        let stream_ref = self.store.register(flate_stream(stream_dict, data));

        let mut files = Dict::new();
        files.set("F", Obj::Ref(stream_ref));
        let mut spec = Dict::new();
        spec.set("Type", Obj::name("Filespec"));
        spec.set("F", Obj::string(&literal_name_bytes(name)));
        spec.set("UF", Obj::Str(Arc::from(encode_text_string(name))));
        spec.set("EF", Obj::Dict(Arc::new(files)));
        if let Some(description) = options.description.as_deref().filter(|text| !text.is_empty()) {
            spec.set("Desc", Obj::Str(Arc::from(encode_text_string(description))));
        }
        if let Some(relationship) = &options.af_relationship {
            spec.set("AFRelationship", Obj::name(relationship));
        }
        self.store.assign(spec_ref, Obj::Dict(Arc::new(spec)));

        let name_entry = Obj::Str(Arc::from(encode_text_string(name)));
        self.edit_catalog(|store, catalog| {
            edit_child_dict(store, catalog, "Names", true, |store, names| {
                edit_child_dict(store, names, "EmbeddedFiles", true, |store, embedded| {
                    edit_child_array(store, embedded, "Names", true, |items| {
                        items.push(name_entry);
                        items.push(Obj::Ref(spec_ref));
                    })
                })
            })?;
            edit_child_array(store, catalog, "AF", true, |items| items.push(Obj::Ref(spec_ref)))
        })?;
        Ok(spec_ref)
    }

    /// `attachmentEntries`.
    pub fn attachments(&self) -> Vec<Attachment> {
        self.read_attachments().unwrap_or_default()
    }

    fn read_attachments(&self) -> Option<Vec<Attachment>> {
        let catalog = self.store.dict(self.store.trailer.root?)?;
        let Obj::Dict(names) = self.store.lookup(catalog, "Names")? else {
            return None;
        };
        let Obj::Dict(embedded) = self.store.lookup(names, "EmbeddedFiles")? else {
            return None;
        };
        let Obj::Array(entries) = self.store.lookup(embedded, "Names")? else {
            return None;
        };
        let mut output = Vec::new();
        let mut at = 0;
        while at + 1 < entries.len() {
            let Some(Obj::Str(name)) = self.store.resolve(&entries[at]) else {
                return None;
            };
            let Some(Obj::Dict(spec)) = self.store.resolve(&entries[at + 1]) else {
                return None;
            };
            let description = match self.store.lookup(spec, "Desc") {
                None | Some(Obj::Null) => String::new(),
                Some(Obj::Str(text)) => decode_text_string(text),
                Some(_) => return None,
            };
            output.push(Attachment { index: output.len() + 1, name: decode_text_string(name), description, spec: spec.clone() });
            at += 2;
        }
        Some(output)
    }

    /// `attachmentBytes`: the decoded stream of `EF /UF`, else `EF /F`. `Ok(None)` when that entry is not a stream;
    /// a filespec without an `EF` dictionary is an error, as it is in pdf-lib.
    pub fn attachment_bytes(&self, spec: &Dict, filters: &dyn StreamFilters, guard: &Guard) -> Result<Option<Vec<u8>>, WriteError> {
        let Some(Obj::Dict(files)) = self.store.lookup(spec, "EF") else {
            return Err(invalid("Expected instance of PDFDict, but got instance of undefined"));
        };
        match self.store.lookup(files, "UF").or_else(|| self.store.lookup(files, "F")) {
            Some(Obj::Stream(stream)) => Ok(Some(stream.decode(filters, guard)?)),
            _ => Ok(None),
        }
    }
}
