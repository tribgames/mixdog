//! The methods the worker serves. Each family registers itself here as its task lands.

use crate::registry::Registry;

/// Registers the document methods (office, pdf, image, syntax). None are ported yet: the tasks that port them fill this in.
pub fn register_document_methods(_: &mut Registry) {}
