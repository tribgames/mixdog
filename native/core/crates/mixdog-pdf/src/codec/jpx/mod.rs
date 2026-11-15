//! JPEG 2000 Part 1 for `JPXDecode`: the container and the codestream structure, as far as tier-2.
//!
//! [`parse`] reads the JP2 boxes (or a bare codestream), the main header and every tile-part header. A tile's
//! geometry and the packet contributions of its code-blocks come from [`Codestream::tile`]; tier-1 decoding,
//! dequantisation, the inverse wavelet transform and the component transforms follow in the decoding half of this
//! module.
//!
//! The reference is OpenJPEG 2.5 (BSD-2-Clause, `wasm/LICENSE_OPENJPEG` of pdfjs-dist 6.4.299), whose parameter
//! checks and tolerance for damaged streams are followed. Not covered: Part 15 (HTJ2K) code-blocks, which are
//! refused with an error.
//!
//! The Node configuration the application runs pdf.js in never sets `wasmUrl`, so there pdf.js's `JpxImage` cannot
//! load OpenJPEG at all and reports "OpenJPEG failed to initialize"; JPEG 2000 images do not decode in Node. This
//! decoder is not bound by that.

pub mod boxes;
pub mod markers;
pub mod packets;
pub mod tiles;
pub mod dwt;
pub mod mct;
pub mod output;
pub mod t1;

use std::fmt;

use self::boxes::{Jp2Info, parse_container};
use self::markers::{MainHeader, Siz, TileParams, TlmEntry, read_main_header};
use self::tiles::{TileEntry, TileStructure, assemble, build_tile};

/// A JPEG 2000 stream that cannot be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JpxError(String);

impl JpxError {
    pub(crate) fn new(message: &str) -> Self {
        JpxError(message.to_owned())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for JpxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JpxError {}

/// A parsed JPEG 2000 stream.
pub struct Image {
    /// The JP2 boxes; `None` for a bare codestream.
    pub container: Option<Jp2Info>,
    pub codestream: Codestream,
}

/// A codestream whose main header and tile-part headers are read.
pub struct Codestream {
    data: Vec<u8>,
    pub siz: Siz,
    /// The coding parameters of the main header.
    pub main: TileParams,
    pub tlm: Vec<TlmEntry>,
    pub comments: Vec<Vec<u8>>,
    pub crg: Option<Vec<u8>>,
    /// The codestream ended before an EOC or inside a tile-part.
    pub truncated: bool,
    tiles: Vec<Option<TileEntry>>,
}

/// Reads a JP2 file or a bare codestream.
pub fn parse(data: &[u8]) -> Result<Image, JpxError> {
    let info = parse_container(data)?;
    let is_bare = data.starts_with(&[0xFF, 0x4F]);
    let codestream = Codestream::open(&data[info.codestream.clone()])?;
    Ok(Image { container: if is_bare { None } else { Some(info) }, codestream })
}

impl Codestream {
    /// Reads the main header and every tile-part header of a codestream (the bytes from SOC).
    pub fn open(data: &[u8]) -> Result<Self, JpxError> {
        let head: MainHeader = read_main_header(data)?;
        let (tiles, truncated) = assemble(data, &head)?;
        Ok(Codestream {
            data: data.to_vec(),
            main: head.builder.params.clone(),
            siz: head.siz,
            tlm: head.tlm,
            comments: head.comments,
            crg: head.crg,
            truncated,
            tiles,
        })
    }

    /// Tiles in the tile grid.
    pub fn tile_count(&self) -> u32 {
        self.tiles.len() as u32
    }

    /// Whether any tile-part of tile `index` is in the codestream.
    pub fn has_tile(&self, index: u32) -> bool {
        matches!(self.tiles.get(index as usize), Some(Some(_)))
    }

    /// The parameters tile `index` is coded with, `None` when the codestream has no tile-part of it.
    pub fn tile_params(&self, index: u32) -> Option<&TileParams> {
        self.tiles.get(index as usize)?.as_ref().map(|t| &t.builder.params)
    }

    /// The packet lengths the PLT markers of tile `index` gave.
    pub fn packet_lengths(&self, index: u32) -> &[u32] {
        match self.tiles.get(index as usize) {
            Some(Some(t)) => &t.packet_lengths,
            _ => &[],
        }
    }

    /// Tile-parts of tile `index` found in the codestream.
    pub fn tile_part_count(&self, index: u32) -> u32 {
        match self.tiles.get(index as usize) {
            Some(Some(t)) => t.parts,
            _ => 0,
        }
    }

    /// The geometry of tile `index` with its packets read; `None` when the codestream has no tile-part of it.
    pub fn tile(&self, index: u32) -> Result<Option<TileStructure>, JpxError> {
        let Some(Some(entry)) = self.tiles.get(index as usize) else {
            return Ok(None);
        };
        let mut tile = build_tile(&self.siz, index, &entry.builder.params)?;
        let body: Vec<u8> = entry.bodies.iter().flat_map(|r| self.data[r.clone()].iter().copied()).collect();
        packets::read_packets(&mut tile, &body, entry.packed.as_deref())?;
        Ok(Some(tile))
    }
}
