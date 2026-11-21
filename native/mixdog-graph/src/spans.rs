// Declaration-span containment: one linear sweep shared by call `inSymbol`
// resolution and symbol `parent` resolution, which must agree on who encloses
// a given position.

/// One declaration span of a file: `(start byte, end byte, name)`.
pub type SymbolSpan<'a> = (usize, usize, &'a str);

/// One ordered containment sweep over the declaration spans of a file.
///
/// `spans` must be sorted by (start ASC, end DESC) and queries must ask for
/// non-decreasing positions, which makes the whole file one linear pass.
pub struct ContainmentSweep<'a> {
    spans: &'a [SymbolSpan<'a>],
    /// Indices into `spans`, innermost last.
    open: Vec<usize>,
    next: usize,
}

impl<'a> ContainmentSweep<'a> {
    pub fn new(spans: &'a [SymbolSpan<'a>]) -> Self {
        Self { spans, open: Vec::new(), next: 0 }
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

    /// Position in `spans` of the innermost span strictly enclosing `spans[index]`.
    pub fn enclosing_of(&mut self, index: usize) -> Option<usize> {
        while self.next < index {
            self.open.push(self.next);
            self.next += 1;
        }
        self.close(self.spans[index].0);
        self.open.last().copied()
    }

    fn close(&mut self, at: usize) {
        while self.open.last().is_some_and(|&index| self.spans[index].1 <= at) {
            self.open.pop();
        }
    }

    fn top(&self) -> Option<&'a str> {
        self.open.last().map(|&index| self.spans[index].2)
    }
}
