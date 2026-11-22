//! A file's symbol records as the graph holds them: one row of numbers per symbol and every text of the file's symbols
//! once, in one string. A record of `SymbolInfo`s cost three allocations a symbol and 112 bytes of fields.

use std::collections::HashMap;

use mixdog_graph::outline::SymbolInfo;

/// One symbol, borrowed from its file's [`Symbols`]: the fields of `SymbolInfo`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Sym<'a> {
    pub name: &'a str,
    pub kind: &'static str,
    pub start_line: u32,
    pub end_line: u32,
    pub start_col: u32,
    pub end_col: u32,
    pub exported: bool,
    pub sig: &'a str,
    pub parent: &'a str,
}

impl<'a> From<&'a SymbolInfo> for Sym<'a> {
    fn from(symbol: &'a SymbolInfo) -> Self {
        Self {
            name: &symbol.name,
            kind: symbol.kind,
            start_line: symbol.start_line,
            end_line: symbol.end_line,
            start_col: symbol.start_col,
            end_col: symbol.end_col,
            exported: symbol.exported,
            sig: &symbol.sig,
            parent: &symbol.parent,
        }
    }
}

/// Where a text sits in [`Symbols::text`].
#[derive(Clone, Copy)]
struct Span {
    at: u32,
    len: u32,
}

struct Row {
    name: Span,
    sig: Span,
    parent: Span,
    start_line: u32,
    end_line: u32,
    start_col: u32,
    end_col: u32,
    kind: u16,
    exported: bool,
}

#[derive(Default)]
pub(super) struct Symbols {
    rows: Box<[Row]>,
    /// The distinct kinds of the file; a row holds its kind's index.
    kinds: Box<[&'static str]>,
    text: Box<str>,
}

impl Symbols {
    pub fn pack<'s>(symbols: impl IntoIterator<Item = Sym<'s>>) -> Self {
        let mut text = String::new();
        let mut placed: HashMap<&'s str, Span> = HashMap::new();
        let mut kinds: Vec<&'static str> = Vec::new();
        let mut place = |s: &'s str| -> Span {
            if s.is_empty() {
                return Span { at: 0, len: 0 };
            }
            *placed.entry(s).or_insert_with(|| {
                let span = Span { at: text.len() as u32, len: s.len() as u32 };
                text.push_str(s);
                span
            })
        };
        let rows: Box<[Row]> = symbols
            .into_iter()
            .map(|s| {
                let kind = kinds.iter().position(|k| *k == s.kind).unwrap_or_else(|| {
                    kinds.push(s.kind);
                    kinds.len() - 1
                });
                Row {
                    name: place(s.name),
                    sig: place(s.sig),
                    parent: place(s.parent),
                    start_line: s.start_line,
                    end_line: s.end_line,
                    start_col: s.start_col,
                    end_col: s.end_col,
                    kind: u16::try_from(kind).expect("a file's symbols have fewer than 65536 distinct kinds"),
                    exported: s.exported,
                }
            })
            .collect();
        Self { rows, kinds: kinds.into_boxed_slice(), text: text.into_boxed_str() }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn get(&self, index: usize) -> Sym<'_> {
        let row = &self.rows[index];
        Sym {
            name: self.text_of(row.name),
            kind: self.kinds[usize::from(row.kind)],
            start_line: row.start_line,
            end_line: row.end_line,
            start_col: row.start_col,
            end_col: row.end_col,
            exported: row.exported,
            sig: self.text_of(row.sig),
            parent: self.text_of(row.parent),
        }
    }

    pub fn iter(&self) -> Iter<'_> {
        Iter { symbols: self, range: 0..self.rows.len() }
    }

    /// Heap bytes held.
    pub fn heap_bytes(&self) -> u64 {
        (std::mem::size_of_val(&*self.rows) + std::mem::size_of_val(&*self.kinds) + self.text.len()) as u64
    }

    fn text_of(&self, span: Span) -> &str {
        &self.text[span.at as usize..(span.at + span.len) as usize]
    }
}

impl From<Vec<SymbolInfo>> for Symbols {
    fn from(symbols: Vec<SymbolInfo>) -> Self {
        Self::pack(symbols.iter().map(Sym::from))
    }
}

pub(super) struct Iter<'a> {
    symbols: &'a Symbols,
    range: std::ops::Range<usize>,
}

impl<'a> Iterator for Iter<'a> {
    type Item = Sym<'a>;

    fn next(&mut self) -> Option<Sym<'a>> {
        self.range.next().map(|i| self.symbols.get(i))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.range.size_hint()
    }
}

impl DoubleEndedIterator for Iter<'_> {
    fn next_back(&mut self) -> Option<Self::Item> {
        self.range.next_back().map(|i| self.symbols.get(i))
    }
}

impl ExactSizeIterator for Iter<'_> {}

impl<'a> IntoIterator for &'a Symbols {
    type Item = Sym<'a>;
    type IntoIter = Iter<'a>;

    fn into_iter(self) -> Iter<'a> {
        self.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_symbols_read_back_as_they_were_given() {
        let symbol = |name: &str, kind: &'static str, sig: &str, parent: &str, line: u32| SymbolInfo {
            name: name.into(),
            kind,
            start_line: line,
            end_line: line + 2,
            start_col: 1,
            end_col: 9,
            exported: line % 2 == 0,
            sig: sig.into(),
            parent: parent.into(),
        };
        let given = vec![
            symbol("Store", "class", "pub struct Store", "", 1),
            symbol("읽기", "method", "pub fn 읽기(&self) -> io::Result<String>", "Store", 2),
            symbol("Store", "function", "", "", 3),
            symbol("x", "variable", "", "읽기", 4),
        ];
        let packed = Symbols::from(given.clone());
        assert_eq!(packed.len(), given.len());
        for (at, (back, want)) in packed.iter().zip(&given).enumerate() {
            let want = Sym::from(want);
            assert_eq!(
                (back.name, back.kind, back.sig, back.parent, back.start_line, back.end_line, back.start_col, back.end_col, back.exported),
                (want.name, want.kind, want.sig, want.parent, want.start_line, want.end_line, want.start_col, want.end_col, want.exported),
                "symbol {at}"
            );
        }
        assert_eq!(packed.iter().rev().next().map(|s| s.name), Some("x"));
    }
}
