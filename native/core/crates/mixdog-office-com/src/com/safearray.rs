//! SAFEARRAYs of VARIANT, 1-D and 2-D, with their lower bounds.
//!
//! Excel's `Value2` and `Formula` come back as 1-based `object[,]`; a bulk `Range.Value2` write is the 0-based 2-D
//! `object[,]` PowerShell builds (`New-Object 'object[,]' $rows, $columns`). A SAFEARRAY is column-major: the first
//! index (rows) varies fastest, so the element at (`row`, `column`) of an array with `rows` rows is at
//! `(row - lbound_rows) + (column - lbound_columns) * rows` in `data`. Bounds are per dimension, dimension 1 being the
//! first index; they are never read from the reversed `rgsabound` field of the C structure.

use super::Value;

/// One dimension: its lower bound and element count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dim {
    /// `SafeArrayGetLBound`.
    pub lbound: i32,
    /// The number of elements (`ubound - lbound + 1`).
    pub len: u32,
}

impl Dim {
    /// The upper bound (`SafeArrayGetUBound`); `lbound - 1` for an empty dimension.
    pub fn ubound(&self) -> i32 {
        self.lbound.wrapping_add(self.len as i32).wrapping_sub(1)
    }
}

/// A SAFEARRAY of VARIANT.
#[derive(Clone, Debug, PartialEq)]
pub struct SafeArray {
    dims: Vec<Dim>,
    /// Column-major.
    data: Vec<Value>,
}

impl SafeArray {
    /// An array from its dimensions and its elements in storage (column-major) order. `None` when the element count is
    /// not the product of the lengths, or there is no dimension.
    pub fn new(dims: Vec<Dim>, data: Vec<Value>) -> Option<SafeArray> {
        let count = dims.iter().try_fold(1usize, |count, dim| count.checked_mul(dim.len as usize))?;
        (!dims.is_empty() && count == data.len()).then_some(SafeArray { dims, data })
    }

    /// A 1-D array whose first element has index `lbound`.
    pub fn one_d(lbound: i32, items: Vec<Value>) -> SafeArray {
        let len = items.len() as u32;
        SafeArray { dims: vec![Dim { lbound, len }], data: items }
    }

    /// A 2-D array from rows, the first row and column having indexes `lbounds`. `None` when the rows differ in length.
    pub fn from_rows(lbounds: (i32, i32), rows: Vec<Vec<Value>>) -> Option<SafeArray> {
        let columns = rows.first().map_or(0, Vec::len);
        if rows.iter().any(|row| row.len() != columns) {
            return None;
        }
        let row_count = rows.len();
        let mut slots: Vec<Option<Value>> = (0..row_count * columns).map(|_| None).collect();
        for (r, row) in rows.into_iter().enumerate() {
            for (c, value) in row.into_iter().enumerate() {
                slots[r + c * row_count] = Some(value);
            }
        }
        let data = slots.into_iter().map(|slot| slot.unwrap_or(Value::Empty)).collect();
        Some(SafeArray {
            dims: vec![Dim { lbound: lbounds.0, len: row_count as u32 }, Dim { lbound: lbounds.1, len: columns as u32 }],
            data,
        })
    }

    /// The 0-based 2-D array PowerShell passes for a bulk `Range.Value2` write (a 1 x 1 array for one cell).
    pub fn zero_based(rows: Vec<Vec<Value>>) -> Option<SafeArray> {
        SafeArray::from_rows((0, 0), rows)
    }

    /// The number of dimensions.
    pub fn rank(&self) -> usize {
        self.dims.len()
    }

    /// The dimensions, the first index first.
    pub fn dims(&self) -> &[Dim] {
        &self.dims
    }

    /// `GetLowerBound(dimension)` (0-based dimension).
    pub fn lower_bound(&self, dimension: usize) -> Option<i32> {
        self.dims.get(dimension).map(|dim| dim.lbound)
    }

    /// `GetUpperBound(dimension)` (0-based dimension).
    pub fn upper_bound(&self, dimension: usize) -> Option<i32> {
        self.dims.get(dimension).map(Dim::ubound)
    }

    /// The elements in storage (column-major) order.
    pub fn data(&self) -> &[Value] {
        &self.data
    }

    /// The elements in storage order, consumed.
    pub fn into_data(self) -> Vec<Value> {
        self.data
    }

    fn offset(&self, indexes: &[i32]) -> Option<usize> {
        if indexes.len() != self.dims.len() {
            return None;
        }
        let mut offset = 0usize;
        let mut stride = 1usize;
        for (index, dim) in indexes.iter().zip(&self.dims) {
            let position = i64::from(*index) - i64::from(dim.lbound);
            if position < 0 || position >= i64::from(dim.len) {
                return None;
            }
            offset += position as usize * stride;
            stride *= dim.len as usize;
        }
        Some(offset)
    }

    /// The element at the indexes (one per dimension, each within its bounds).
    pub fn get(&self, indexes: &[i32]) -> Option<&Value> {
        self.offset(indexes).and_then(|offset| self.data.get(offset))
    }

    /// The elements of a 1-D array in index order.
    pub fn items(&self) -> Option<&[Value]> {
        (self.dims.len() == 1).then_some(self.data.as_slice())
    }

    /// The rows of a 2-D array, each row in column order.
    pub fn rows(&self) -> Option<Vec<Vec<&Value>>> {
        if self.dims.len() != 2 {
            return None;
        }
        let row_count = self.dims[0].len as usize;
        let column_count = self.dims[1].len as usize;
        Some((0..row_count).map(|r| (0..column_count).map(|c| &self.data[r + c * row_count]).collect()).collect())
    }
}
