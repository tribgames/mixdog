//! The bounds an SVG document is read under, shared by every reader of one in the workspace (this crate's decoder and
//! the rasteriser of `mixdog-raster`), so that a small hostile file cannot make either allocate or recurse without end.
//!
//! Every bound is derived from one of two budgets, and the one that protects an allocation is checked before it:
//!
//! * [`TREE_BUDGET`], 256 MiB, is what the parsed tree and the style tree made of it may hold. A parsed node costs
//!   about [`NODE_BYTES`] (64 bytes of `roxmltree` node, as much again for the converted `usvg` node), so a document
//!   has at most [`NODES`] = budget / 128 nodes, the parser's own `nodes_limit`. The smallest thing the parser
//!   allocates for is an element `<a/>` of four input bytes at 16 times its size in memory (or an attribute of six
//!   bytes at 8 times), so a document of at most [`DOCUMENT_BYTES`] = budget / 16 = 16 MiB cannot make the parse
//!   hold more than the budget; that bound is checked on the text, before the parser allocates anything, and a gzip
//!   input is inflated through a reader that stops one byte past it, never into an unbounded buffer.
//! * [`STACK_BUDGET`], 1 MiB, is half of the smallest thread stack a caller runs on (2 MiB). The style and layout
//!   passes recurse over the tree, one level costing at most [`LEVEL_STACK_BYTES`] = 4 KiB across the converters
//!   that call each other, so a tree at most [`DEPTH`] = budget / 4 KiB = 256 deep cannot exhaust it. The parser
//!   itself does not recurse (its nodes are one flat list), so depth is checked on the finished tree, before the
//!   first recursive pass reads it.

use std::borrow::Cow;
use std::io::Read;

use resvg::usvg::roxmltree::{Document, ParsingOptions};

use crate::error::ImagingError;

/// What the parsed and the converted tree of one document may hold.
pub const TREE_BUDGET: usize = 256 * 1024 * 1024;
/// What one parsed node costs, the converted node included.
pub const NODE_BYTES: usize = 128;
/// The smallest input a node is made of (`<a/>`) times the memory it takes: the 16 bytes of memory per input byte.
const MEMORY_PER_INPUT_BYTE: usize = 16;
/// The most bytes of SVG text a document may have once inflated.
pub const DOCUMENT_BYTES: usize = TREE_BUDGET / MEMORY_PER_INPUT_BYTE;
/// The most nodes (elements, texts, comments) of a document.
pub const NODES: u32 = (TREE_BUDGET / NODE_BYTES) as u32;
/// The stack the recursive passes over a tree may use.
pub const STACK_BUDGET: usize = 1024 * 1024;
/// The stack one level of nesting costs the recursive passes.
pub const LEVEL_STACK_BYTES: usize = 4 * 1024;
/// The deepest nesting of elements of a document.
pub const DEPTH: usize = STACK_BUDGET / LEVEL_STACK_BYTES;

/// The sentence of a document over a bound.
pub const TOO_LARGE: &str = "SVG document exceeds the size limit";

/// The text of an SVG document: `bytes` itself, or what gzip makes of it, held to [`DOCUMENT_BYTES`] and valid UTF-8.
pub fn document_text(bytes: &[u8]) -> Result<Cow<'_, str>, ImagingError> {
    let malformed = || ImagingError::invalid("SVG document is not valid");
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut inflated = Vec::new();
        flate2::read::GzDecoder::new(bytes).take(DOCUMENT_BYTES as u64 + 1).read_to_end(&mut inflated).map_err(|_| malformed())?;
        if inflated.len() > DOCUMENT_BYTES {
            return Err(ImagingError::invalid(TOO_LARGE));
        }
        return String::from_utf8(inflated).map(Cow::Owned).map_err(|_| malformed());
    }
    if bytes.len() > DOCUMENT_BYTES {
        return Err(ImagingError::invalid(TOO_LARGE));
    }
    std::str::from_utf8(bytes).map(Cow::Borrowed).map_err(|_| malformed())
}

/// The parser's options: the document type declaration is read (usvg reads it too), the node count is bounded.
pub fn parsing_options() -> ParsingOptions {
    ParsingOptions { allow_dtd: true, nodes_limit: NODES }
}

/// Fails a document nested deeper than [`DEPTH`]; walks the tree without recursion.
pub fn check_depth(document: &Document<'_>) -> Result<(), ImagingError> {
    let mut pending = vec![(document.root(), 0usize)];
    while let Some((node, depth)) = pending.pop() {
        if depth > DEPTH {
            return Err(ImagingError::invalid(TOO_LARGE));
        }
        pending.extend(node.children().map(|child| (child, depth + 1)));
    }
    Ok(())
}

/// The document of `text`, parsed under the bounds.
pub fn parse(text: &str) -> Result<Document<'_>, ImagingError> {
    let document = Document::parse_with_options(text, parsing_options()).map_err(|_| ImagingError::invalid("SVG document is not valid"))?;
    check_depth(&document)?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn a_gzip_document_is_inflated_and_a_plain_one_is_borrowed() {
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        assert_eq!(document_text(&gzip(svg.as_bytes())).unwrap(), svg);
        assert!(matches!(document_text(svg.as_bytes()).unwrap(), Cow::Borrowed(_)));
    }

    #[test]
    fn a_gzip_bomb_is_refused_at_the_bound_without_inflating_past_it() {
        // 65 MiB of spaces is a few tens of KiB gzipped.
        let bomb = gzip(&vec![b' '; DOCUMENT_BYTES + 1024 * 1024]);
        assert!(bomb.len() < 1024 * 1024, "{}", bomb.len());
        assert_eq!(document_text(&bomb).unwrap_err().sentence(), TOO_LARGE);
        let exactly = gzip(&vec![b' '; DOCUMENT_BYTES]);
        assert_eq!(document_text(&exactly).unwrap().len(), DOCUMENT_BYTES);
    }

    #[test]
    fn a_document_nested_past_the_depth_bound_or_over_the_node_bound_is_refused() {
        let deep = format!("{}{}", "<g>".repeat(DEPTH + 10), "</g>".repeat(DEPTH + 10));
        assert!(parse(&format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{deep}</svg>")).is_err());
        let shallow = format!("{}{}", "<g>".repeat(DEPTH - 10), "</g>".repeat(DEPTH - 10));
        assert!(parse(&format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{shallow}</svg>")).is_ok());
        let wide = format!("<svg xmlns=\"http://www.w3.org/2000/svg\">{}</svg>", "<g/>".repeat(NODES as usize + 1));
        assert!(parse(&wide).is_err());
    }
}
