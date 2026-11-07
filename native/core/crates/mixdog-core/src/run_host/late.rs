//! The one check every late cell answers to.
//!
//! The composition has a few true cycles (the session directory is built from the tool pool, which
//! needs seams that read the directory; the connection hub exists only after the core). Each is a
//! cell bound once, after what it waits for. A cell read before its bind answers as an unknown
//! thread or a refused dial would, so the unbound state must be unreachable once the server accepts:
//! the composition verifies every cell with [`require`] before the listener accepts, and a cell left
//! unbound fails startup with an [`Unbound`] that names it.

/// A cell that is bound after the part of the composition that waits for it exists.
pub trait Bound {
    /// The cell's name, as the startup error reports it.
    fn cell(&self) -> &'static str;
    /// Whether the cell has been bound (and still holds what it was bound to).
    fn is_bound(&self) -> bool;
}

/// A late cell was left unbound at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the {cell} was not bound before the server accepted connections")]
pub struct Unbound {
    pub cell: &'static str,
}

/// Every cell bound, or the first one that is not.
pub fn require(cells: &[&dyn Bound]) -> Result<(), Unbound> {
    match cells.iter().find(|cell| !cell.is_bound()) {
        Some(cell) => Err(Unbound { cell: cell.cell() }),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    struct Cell(&'static str, AtomicBool);

    impl Bound for Cell {
        fn cell(&self) -> &'static str {
            self.0
        }

        fn is_bound(&self) -> bool {
            self.1.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn the_first_unbound_cell_is_named() {
        let (a, b, c) = (Cell("a", AtomicBool::new(true)), Cell("b", AtomicBool::new(false)), Cell("c", AtomicBool::new(false)));
        assert_eq!(require(&[&a, &b, &c]), Err(Unbound { cell: "b" }));
        b.1.store(true, Ordering::SeqCst);
        assert_eq!(require(&[&a, &b, &c]), Err(Unbound { cell: "c" }));
        c.1.store(true, Ordering::SeqCst);
        assert_eq!(require(&[&a, &b, &c]), Ok(()));
        assert_eq!(Unbound { cell: "b" }.to_string(), "the b was not bound before the server accepted connections");
    }
}
