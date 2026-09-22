// Declaration-span containment: one linear sweep shared by call `inSymbol`
// resolution and symbol `parent` resolution, which must agree on who encloses
// a given position.

/// One declaration span of a file: `(start byte, end byte, name)`.
pub type SymbolSpan<'a> = (usize, usize, &'a str);

/// One ordered containment sweep over the declaration spans of a file.
///
/// Declaration spans nest, so the innermost span containing a position is the
/// top of a stack that opens spans in start order and closes them when they
/// end. `spans` must be sorted by (start ASC, end DESC) — the order in which
/// nested declarations are written — and the queries must ask for
/// non-decreasing positions, which makes the whole file one linear pass.
///
/// Both consumers sweep in source order: `calls::finish` resolves each call
/// site's `inSymbol` (`innermost_at`), and `outline::map_items` resolves each
/// symbol's `parent` (`enclosing_of`) from the very same span list, so a call
/// and the declaration it sits in always agree on who encloses them.
pub struct ContainmentSweep<'a> {
    spans: &'a [SymbolSpan<'a>],
    /// Indices into `spans`, innermost last.
    open: Vec<usize>,
    next: usize,
}

impl<'a> ContainmentSweep<'a> {
    pub fn new(spans: &'a [SymbolSpan<'a>]) -> Self {
        Self {
            spans,
            open: Vec::new(),
            next: 0,
        }
    }

    /// Innermost span containing `at`, or `None` at top level.
    pub fn innermost_at(&mut self, at: usize) -> Option<&'a str> {
        while self.next < self.spans.len() && self.spans[self.next].0 <= at {
            self.open.push(self.next);
            self.next += 1;
        }
        self.close(at);
        self.top()
    }

    /// POSITION IN `spans` of the innermost span STRICTLY enclosing
    /// `spans[index]`. Only the spans that precede it in sort order are
    /// opened, so neither the span itself nor a span nested inside it that
    /// starts at the same byte can answer.
    ///
    /// The position, not the name: the outline reads the enclosing
    /// declaration's KIND from it as well (a declaration inside a function
    /// body is local, whatever its own modifiers say).
    pub fn enclosing_of(&mut self, index: usize) -> Option<usize> {
        while self.next < index {
            self.open.push(self.next);
            self.next += 1;
        }
        self.close(self.spans[index].0);
        self.open.last().copied()
    }

    fn close(&mut self, at: usize) {
        while self
            .open
            .last()
            .is_some_and(|&index| self.spans[index].1 <= at)
        {
            self.open.pop();
        }
    }

    fn top(&self) -> Option<&'a str> {
        self.open.last().map(|&index| self.spans[index].2)
    }
}
