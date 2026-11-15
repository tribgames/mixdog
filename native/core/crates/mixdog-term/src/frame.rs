//! The cell grid and the frame writer.
//!
//! A [`Grid`] is the screen as rows of [`Cell`]s. A glyph that is two cells wide (CJK, emoji, and the arrows and
//! enclosed digits the display-width policy widens) sits in its head cell with `width` 2 and is followed by a
//! continuation cell: an empty symbol, `width` 0, the head's style and link. [`FrameWriter`] diffs a grid against the
//! one it last wrote and sends only the changed runs; [`FramePacer`] and [`PacedFrames`] coalesce draw requests into
//! frames at [`TUI_FRAME_MS`].

mod pacer;
mod sgr;
mod writer;

pub use pacer::{FrameAck, FramePacer, Pace, PacedFrames, TUI_FRAME_MS, TUI_RENDER_FPS};
pub use sgr::{apply_sgr, parse_hyperlink};
pub use writer::{CursorPos, FrameWriter, WriteStats};

/// A rectangle of cells.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl Rect {
    pub const fn new(x: u16, y: u16, width: u16, height: u16) -> Self {
        Self { x, y, width, height }
    }

    /// One past the last column.
    pub fn right(&self) -> u32 {
        u32::from(self.x) + u32::from(self.width)
    }

    /// One past the last row.
    pub fn bottom(&self) -> u32 {
        u32::from(self.y) + u32::from(self.height)
    }

    /// The cells both rectangles hold (empty when they do not meet).
    pub fn intersect(&self, other: &Rect) -> Rect {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= u32::from(x) || bottom <= u32::from(y) {
            return Rect::new(x, y, 0, 0);
        }
        Rect::new(x, y, (right - u32::from(x)) as u16, (bottom - u32::from(y)) as u16)
    }

    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// A 24-bit colour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }
}

/// A foreground or background colour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Color {
    /// The terminal's own colour.
    #[default]
    Default,
    /// An entry of the 256-colour palette (0 to 15 are the sixteen basic colours).
    Indexed(u8),
    /// A colour the writer sends at the colour level of the session: truecolor, or the nearest 256-colour or
    /// 16-colour entry.
    Rgb(Rgb),
    /// A colour sent as truecolor at every level: the Ink fork writes the selection highlight that way, so it shows
    /// on a terminal whose colour level is low or off.
    Literal(Rgb),
}

/// The display attributes of a cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub strikethrough: bool,
}

impl Style {
    /// Whether the style sets an attribute or a foreground colour (the part of a style a selection keeps).
    pub fn has_foreground_or_attribute(&self) -> bool {
        self.fg != Color::Default || self.bold || self.dim || self.italic || self.underline || self.strikethrough
    }
}

const INLINE: usize = 14;

/// The text of a cell: one grapheme cluster, or empty for a continuation cell. Short clusters live inline.
#[derive(Clone, Debug, Eq)]
pub enum Symbol {
    Inline(u8, [u8; INLINE]),
    Heap(Box<str>),
}

impl Symbol {
    pub fn new(text: &str) -> Self {
        if text.len() <= INLINE {
            let mut bytes = [0u8; INLINE];
            bytes[..text.len()].copy_from_slice(text.as_bytes());
            Symbol::Inline(text.len() as u8, bytes)
        } else {
            Symbol::Heap(text.into())
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Symbol::Inline(len, bytes) => std::str::from_utf8(&bytes[..usize::from(*len)]).unwrap_or(""),
            Symbol::Heap(text) => text,
        }
    }
}

impl PartialEq for Symbol {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}

impl Default for Symbol {
    fn default() -> Self {
        Symbol::new(" ")
    }
}

/// One cell of the grid.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Cell {
    pub symbol: Symbol,
    /// Cells the glyph occupies: 1, 2 for the head of a wide glyph, 0 for its continuation cell.
    pub width: u8,
    pub style: Style,
    /// The hyperlink of the cell: 0 for none, otherwise `id + 1` of the grid's link table.
    pub link: u32,
}

impl Cell {
    /// A blank cell: a space in the default style.
    pub fn blank() -> Self {
        Self { symbol: Symbol::default(), width: 1, style: Style::default(), link: 0 }
    }

    /// The continuation cell of a wide glyph.
    pub fn continuation(style: Style, link: u32) -> Self {
        Self { symbol: Symbol::new(""), width: 0, style, link }
    }

    pub fn is_continuation(&self) -> bool {
        self.width == 0 && self.symbol.as_str().is_empty()
    }

    /// A space in the default style with no link.
    pub fn is_plain_blank(&self) -> bool {
        self.width == 1 && self.symbol.as_str() == " " && self.style == Style::default() && self.link == 0
    }

    /// The text of the cell as the cell grid of the Ink fork keeps it: the glyph, or empty for a continuation.
    pub fn text(&self) -> &str {
        self.symbol.as_str()
    }
}

/// The screen as rows of cells, and the hyperlinks its cells point at.
#[derive(Clone, Debug, Default)]
pub struct Grid {
    pub width: u16,
    pub height: u16,
    pub cells: Vec<Cell>,
    /// The hyperlink table: the url of link id `n + 1` is `links[n]`.
    pub links: Vec<String>,
    /// `soft_wrap[y]`: row `y` continues the row above because a text wrapped there (Ink's `output.js` marks the same
    /// rows); the selection joins such rows without a line break. A row past the end of the list is not one. It is a
    /// note about how the cells came to be and is not part of what two grids compare on.
    pub soft_wrap: Vec<bool>,
}

impl PartialEq for Grid {
    fn eq(&self, other: &Self) -> bool {
        self.width == other.width && self.height == other.height && self.cells == other.cells && self.links == other.links
    }
}

impl Eq for Grid {}

impl Grid {
    /// A grid of blank cells.
    pub fn new(width: u16, height: u16) -> Self {
        Self { width, height, cells: vec![Cell::blank(); usize::from(width) * usize::from(height)], links: Vec::new(), soft_wrap: Vec::new() }
    }

    fn index(&self, x: u16, y: u16) -> Option<usize> {
        (x < self.width && y < self.height).then(|| usize::from(y) * usize::from(self.width) + usize::from(x))
    }

    pub fn cell(&self, x: u16, y: u16) -> Option<&Cell> {
        self.index(x, y).map(|at| &self.cells[at])
    }

    pub fn cell_mut(&mut self, x: u16, y: u16) -> Option<&mut Cell> {
        self.index(x, y).map(|at| &mut self.cells[at])
    }

    /// The cells of row `y` (empty past the last row).
    pub fn row(&self, y: u16) -> &[Cell] {
        if y >= self.height {
            return &[];
        }
        let start = usize::from(y) * usize::from(self.width);
        &self.cells[start..start + usize::from(self.width)]
    }

    pub fn row_mut(&mut self, y: u16) -> &mut [Cell] {
        if y >= self.height {
            return &mut [];
        }
        let start = usize::from(y) * usize::from(self.width);
        let width = usize::from(self.width);
        &mut self.cells[start..start + width]
    }

    /// Notes that row `y` continues the row above because a text wrapped there.
    pub fn mark_soft_wrap(&mut self, y: i32) {
        let Ok(y) = usize::try_from(y) else { return };
        if y >= usize::from(self.height) {
            return;
        }
        if self.soft_wrap.len() <= y {
            self.soft_wrap.resize(usize::from(self.height), false);
        }
        self.soft_wrap[y] = true;
    }

    /// The id of a hyperlink (the same url always gets the same id).
    pub fn intern_link(&mut self, url: &str) -> u32 {
        if let Some(at) = self.links.iter().position(|known| known == url) {
            return at as u32 + 1;
        }
        self.links.push(url.to_owned());
        self.links.len() as u32
    }

    /// The url behind a link id (`None` for 0 and for an id the table does not hold).
    pub fn link_url(&self, id: u32) -> Option<&str> {
        let at = usize::try_from(id.checked_sub(1)?).ok()?;
        self.links.get(at).map(String::as_str)
    }

    /// Row `y` as text: each glyph once, a continuation cell nothing, trailing spaces kept.
    pub fn row_text(&self, y: u16) -> String {
        self.row(y).iter().map(Cell::text).collect()
    }

    /// Writes one grapheme cluster of `width` cells (1 or 2) at `(x, y)`; a position outside the grid is ignored.
    /// Overwriting half of an earlier wide glyph blanks the other half, so a half-visible glyph is never left. A wide
    /// glyph that would not fit in the last column becomes a space.
    pub fn put_glyph(&mut self, x: i32, y: i32, symbol: &str, width: usize, style: Style, link: u32) {
        let (Ok(x), Ok(y)) = (u16::try_from(x), u16::try_from(y)) else { return };
        if x >= self.width || y >= self.height {
            return;
        }
        let mut width = width.clamp(1, 2);
        let mut symbol = symbol;
        if width == 2 && x + 1 >= self.width {
            width = 1;
            symbol = " ";
        }
        let row = self.row_mut(y);
        let at = usize::from(x);
        if row[at].is_continuation() && at > 0 {
            row[at - 1] = Cell::blank();
        }
        let last = at + width - 1;
        if row.get(last + 1).is_some_and(Cell::is_continuation) {
            row[last + 1] = Cell::blank();
        }
        row[at] = Cell { symbol: Symbol::new(symbol), width: width as u8, style, link };
        if width == 2 {
            row[at + 1] = Cell::continuation(style, link);
        }
    }

    /// Fills a rectangle (clipped to the grid) with blanks of one style.
    pub fn fill(&mut self, rect: Rect, style: Style) {
        for y in rect.y..rect.y.saturating_add(rect.height).min(self.height) {
            for x in rect.x..rect.x.saturating_add(rect.width).min(self.width) {
                self.put_glyph(i32::from(x), i32::from(y), " ", 1, style, 0);
            }
        }
    }

    /// Clears the grid to blank cells.
    pub fn clear(&mut self) {
        self.cells.fill(Cell::blank());
        self.links.clear();
    }
}
