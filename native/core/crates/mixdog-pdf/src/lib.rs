//! The PDF reader of the read path, following pdf.js 6.4.299.
//!
//! This crate holds the structure layer: the lexer, the parser, the object model, the cross-reference table with its
//! reconstruction of broken files, and the stream and decryption seams ([`StreamFilters`], [`Decryptor`]) that the
//! codec crate fills. The modules after them (`document`, `page`, `codec_glue`, `fonts`, `text`, `fontfile`,
//! `inspect`) are declared here so later tasks each own their files and never share one.

pub mod codec;
pub mod codec_glue;
pub mod color;
pub mod document;
pub mod error;
pub mod fontdraw;
pub mod fontfile;
pub mod fonts;
pub mod function;
pub mod function_ps;
pub mod glyph;
pub mod inspect;
pub mod lexer;
pub mod object;
pub mod page;
pub mod parser;
pub mod repair;
pub mod stream;
pub mod text;
pub mod write;
pub mod xref;
pub mod annotations;
pub mod oplist;
pub mod outline_read;
pub mod embed;
pub mod image;
pub mod author;
pub mod render;

pub use error::{Budget, CancelCheck, Guard, INCORRECT_PASSWORD, NEED_PASSWORD, PdfError, Result};
pub use lexer::{CommandArgs, KnownCommands, Lexer};
pub use object::{Dict, Obj, Ref};
pub use parser::{Linearization, Parser};
pub use stream::{
    ByteStream, Cipher, Decryptor, DecryptorFactory, FilterResult, FilterSpec, PdfStream,
    StreamFilters,
};
pub use xref::{Entry, Xref, XrefOptions};
