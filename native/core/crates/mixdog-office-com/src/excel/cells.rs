//! The cells of a worksheet as the reader sees them: a COM value as the PowerShell value the host wrote (`Cell-Value`,
//! `Excel-MatrixValue`), column letters, a range's cell address, and where a chart or a picture sits on the
//! grid (`Excel-DrawingAnchor`, `Excel-FrozenSplit`), with the casts the host's code applies to what a property answers.
//!
//! A VT_ERROR cell (`#N/A` and the rest) reads as the Int32 of its scode and a VT_NULL as `DBNull`, as PowerShell
//! presented them; a VT_EMPTY is `$null`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::com::errtext;
use crate::ps;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::datetime;

/// What `[string]` of a COM object reads as.
const COM_OBJECT_TEXT: &str = "System.__ComObject";

/// A `[ordered]` dictionary of the pairs in this order.
pub(super) fn ordered(pairs: Vec<(&str, Value)>) -> Value {
    Value::object(ObjectKind::Ordered, pairs)
}

/// A COM value as the PowerShell value the host sees.
pub(crate) fn ps_of(value: &Com) -> Value {
    match value {
        Com::Empty | Com::Missing => Value::Null,
        Com::Null => Value::DbNull,
        Com::Bool(flag) => Value::Bool(*flag),
        Com::I1(n) => Value::Int(i32::from(*n)),
        Com::I2(n) => Value::Int(i32::from(*n)),
        Com::I4(n) => Value::Int(*n),
        Com::UI1(n) => Value::Int(i32::from(*n)),
        Com::UI2(n) => Value::Int(i32::from(*n)),
        Com::UI4(n) => i32::try_from(*n).map_or(Value::Long(i64::from(*n)), Value::Int),
        Com::I8(n) => Value::Long(*n),
        Com::UI8(n) => i64::try_from(*n).map_or(Value::Double(*n as f64), Value::Long),
        Com::R4(n) => Value::Single(*n),
        Com::R8(n) => Value::Double(*n),
        Com::Currency(n) => Value::Decimal(ps::Decimal { negative: *n < 0, mantissa: u128::from(n.unsigned_abs()), scale: 4 }),
        Com::Date(days) => datetime::oa_date_to_ticks(*days).map_or(Value::Null, convert::unspecified_date),
        Com::Str(text) => Value::String(text.clone()),
        Com::Error(code) => Value::Int(*code),
        Com::Decimal(decimal) => Value::Decimal(ps::Decimal {
            negative: decimal.negative,
            mantissa: (u128::from(decimal.hi32) << 64) | u128::from(decimal.lo64),
            scale: decimal.scale,
        }),
        Com::Dispatch(_) | Com::Unknown(_) => Value::String(COM_OBJECT_TEXT.to_owned()),
        Com::Array(array) => Value::Array(array.data().iter().map(ps_of).collect()),
    }
}

/// `$null -eq $value`: only an empty VARIANT (a VT_NULL is `DBNull`, which is not `$null`).
pub(super) fn is_ps_null(value: &Com) -> bool {
    matches!(value, Com::Empty | Com::Missing)
}

/// `$null -eq $value -or $value -is [System.DBNull]`.
pub(super) fn is_null_or_dbnull(value: &Com) -> bool {
    matches!(value, Com::Empty | Com::Missing | Com::Null)
}

/// `[string]$value`.
pub(super) fn string_of(value: &Com) -> String {
    convert::to_ps_string(&ps_of(value))
}

/// `[int]$value`.
pub(super) fn int_of(value: &Com) -> Result<i32> {
    convert::to_int(&ps_of(value)).map_err(Error::host)
}


/// `[double]$value`.
pub(super) fn double_of(value: &Com) -> Result<f64> {
    convert::to_double(&ps_of(value)).map_err(Error::host)
}

/// `[bool]$value`: a COM object is true.
pub(super) fn bool_of(value: &Com) -> bool {
    convert::to_bool(&ps_of(value))
}

/// `$collection.Count` as one side of `-le` or `-gt`: `$null` compares as 0.
pub(super) fn count_of(collection: &Com) -> Result<i64> {
    let count = collection.member("Count")?;
    match &count {
        Com::Null | Com::Empty => Ok(0),
        other => other
            .as_i64()
            .or_else(|| other.as_f64().map(|number| convert::round_half_even(number) as i64))
            .ok_or_else(|| Error::host(format!("Cannot compare the value of type \"{}\" with a number.", other.dotnet_type_name()))),
    }
}

/// `$value.Name(args)` on a parameterized property (`Item(n)`, `Cells.Item(r, c)`, `Range(a)`, `Address($false, $false)`):
/// a method call on `$null` fails.
pub(super) fn get_with(value: &Com, name: &str, args: &[Com]) -> Result<Com> {
    match value.as_obj() {
        Some(object) => object.get_with(name, args),
        None => Err(errtext::null_method_call()),
    }
}

/// `$range.Address($false, $false)`.
pub(super) fn relative_address(range: &Com) -> Result<Com> {
    get_with(range, "Address", &[Com::Bool(false), Com::Bool(false)])
}

/// `$payload.name` as a condition.
pub(super) fn payload_flag(payload: &Value, name: &str) -> bool {
    convert::to_bool(&ps::payload::property(payload, name))
}

/// `[string]$payload.name`.
pub(super) fn payload_text(payload: &Value, name: &str) -> String {
    convert::to_ps_string(&ps::payload::property(payload, name))
}

/// `[int]$range.Rows.Count` (`dimension` is `Rows` or `Columns`).
pub(super) fn dimension_count(range: &Com, dimension: &str) -> Result<i32> {
    int_of(&range.member(dimension)?.member("Count")?)
}

/// `@($collection)`: the items of a collection, or the one value that is not one.
pub(super) fn items_of(value: &Com) -> Result<Vec<Com>> {
    match value.as_obj() {
        Some(collection) => collection.items(),
        None => Ok(vec![value.clone()]),
    }
}

/// `try { ... } catch { }`: the answer, or nothing when it failed.
pub(super) fn attempt<T>(body: impl FnOnce() -> Result<T>) -> Option<T> {
    body().ok()
}

fn int_math(value: std::result::Result<Value, String>) -> Result<i32> {
    convert::to_int(&value.map_err(Error::host)?).map_err(Error::host)
}

/// `[Math]::Min` of two `[int]`.
pub(super) fn min_int(a: i32, b: i32) -> Result<i32> {
    int_math(convert::min(&Value::Int(a), &Value::Int(b)))
}

/// `[Math]::Max(1, [Math]::Floor($numerator / [Math]::Max(1, $divisor)))`: how many blocks of `divisor` fit in
/// `numerator` cells, at least one (`[Math]::Floor` of an `[int]` is a Decimal, and `[Math]::Max` takes the overload of
/// its first argument, an `[int]`).
pub(super) fn blocks_fitting(numerator: i32, divisor: i32) -> Result<i32> {
    let divisor = convert::max(&Value::Int(1), &Value::Int(divisor)).map_err(Error::host)?;
    let quotient = convert::divide(&Value::Int(numerator), &divisor).map_err(Error::host)?;
    let floored = convert::floor(&quotient).map_err(Error::host)?;
    int_math(convert::max(&Value::Int(1), &floored))
}

const OUT_OF_BOUNDS: &str = "Index was outside the bounds of the array.";

/// `Excel-MatrixValue`: the element of a two-dimensional array at the 1-based row and column (counted from its lower
/// bounds); a value that is not one is its own (1, 1) and has nothing elsewhere.
pub(super) fn matrix_value(matrix: &Com, row: i32, column: i32) -> Com {
    if let Com::Array(array) = matrix {
        if array.rank() == 2 {
            let (rows, columns) = (array.lower_bound(0).unwrap_or(0), array.lower_bound(1).unwrap_or(0));
            return array.get(&[rows + row - 1, columns + column - 1]).cloned().unwrap_or(Com::Empty);
        }
    }
    if row == 1 && column == 1 { matrix.clone() } else { Com::Empty }
}

/// `Excel-ColumnLetters`: `A` for 1, `AA` for 27; nothing for a column below 1.
pub(crate) fn column_letters(column: i32) -> String {
    let mut column = column;
    let mut letters = String::new();
    while column > 0 {
        column -= 1;
        letters.insert(0, char::from(b'A' + (column % 26) as u8));
        column /= 26;
    }
    letters
}

/// `Excel-RangeCellAddress`: the address of the cell at the 1-based row and column of a range.
pub(super) fn range_cell_address(range: &Com, row: i32, column: i32) -> Result<String> {
    let absolute_row = int_of(&range.member("Row")?)? + row - 1;
    let absolute_column = int_of(&range.member("Column")?)? + column - 1;
    Ok(format!("{}{absolute_row}", column_letters(absolute_column)))
}

/// `Cell-Value`: a range's `Value2` as the host wrote it: `$null`, a scalar, or the rows as arrays (one row is that row
/// alone: a function's output of one item is the item).
pub(super) fn cell_value(cell: &Com) -> Result<Value> {
    let value = cell.member("Value2")?;
    if is_ps_null(&value) {
        return Ok(Value::Null);
    }
    let Com::Array(array) = &value else { return Ok(ps_of(&value)) };
    if array.rank() != 2 {
        return Err(Error::host(OUT_OF_BOUNDS));
    }
    let mut rows = Vec::new();
    for row in 1..=array.dims()[0].len as i32 {
        let mut line = Vec::new();
        for column in 1..=array.dims()[1].len as i32 {
            let element = array.get(&[row, column]).ok_or_else(|| Error::host(OUT_OF_BOUNDS))?;
            line.push(ps_of(element));
        }
        rows.push(Value::Array(line));
    }
    Ok(ps::unroll(rows))
}

/// `Excel-DrawingAnchor`: a chart frame or picture on the cell grid in the portable reader's shape, the cells under its
/// corners (1-based). An edge that falls exactly on a column or row boundary is counted as the end of the column or row it
/// closes (a 0.5 pt tolerance); a drawing that cannot be placed answers `$null`.
pub(super) fn drawing_anchor(drawing: &Com) -> Value {
    anchor_of(drawing).unwrap_or(Value::Null)
}

fn anchor_of(drawing: &Com) -> Result<Value> {
    let first = drawing.member("TopLeftCell")?;
    let mut last = drawing.member("BottomRightCell")?;
    let mut end_column = int_of(&last.member("Column")?)?;
    let mut end_row = int_of(&last.member("Row")?)?;
    if end_column > int_of(&first.member("Column")?)?
        && double_of(&drawing.member("Left")?)? + double_of(&drawing.member("Width")?)? <= double_of(&last.member("Left")?)? + 0.5
    {
        end_column -= 1;
    }
    if end_row > int_of(&first.member("Row")?)?
        && double_of(&drawing.member("Top")?)? + double_of(&drawing.member("Height")?)? <= double_of(&last.member("Top")?)? + 0.5
    {
        end_row -= 1;
    }
    if end_column != int_of(&last.member("Column")?)? || end_row != int_of(&last.member("Row")?)? {
        let cells = last.member("Worksheet")?.member("Cells")?;
        last = get_with(&cells, "Item", &[Com::I4(end_row), Com::I4(end_column)])?;
    }
    let from = string_of(&relative_address(&first)?);
    let to = string_of(&relative_address(&last)?);
    let start_column = int_of(&first.member("Column")?)?;
    let start_row = int_of(&first.member("Row")?)?;
    let round = |name: &str| -> Result<Value> {
        let number = double_of(&drawing.member(name)?)?;
        Ok(Value::Double(convert::round_digits(number, 2).map_err(Error::host)?))
    };
    Ok(ordered(vec![
        ("from", Value::String(from)),
        ("to", Value::String(to)),
        ("startColumn", Value::Int(start_column)),
        ("startRow", Value::Int(start_row)),
        ("endColumn", Value::Int(end_column)),
        ("endRow", Value::Int(end_row)),
        ("left", round("Left")?),
        ("top", round("Top")?),
        ("width", round("Width")?),
        ("height", round("Height")?),
    ]))
}

/// `Excel-FrozenSplit`: the frozen rows and columns as the top-left pane holds them. `SplitRow` counts only the frozen rows
/// a small hidden window can show; the pane keeps them all.
pub(super) fn frozen_split(window: &Com) -> Result<(i32, i32)> {
    let mut row = int_of(&window.member("SplitRow")?)?;
    let mut column = int_of(&window.member("SplitColumn")?)?;
    if bool_of(&window.member("FreezePanes")?) && count_of(&window.member("Panes")?)? > 1 {
        let panes = window.member("Panes")?;
        let frozen = get_with(&panes, "Item", &[Com::I4(1)])?.member("VisibleRange")?;
        if row > 0 {
            row = int_of(&frozen.member("Rows")?.member("Count")?)?;
        }
        if column > 0 {
            column = int_of(&frozen.member("Columns")?.member("Count")?)?;
        }
    }
    Ok((row, column))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::com::Dim;
    use crate::com::SafeArray;

    #[test]
    fn column_letters_count_like_excel() {
        assert_eq!(column_letters(0), "");
        assert_eq!(column_letters(1), "A");
        assert_eq!(column_letters(26), "Z");
        assert_eq!(column_letters(27), "AA");
        assert_eq!(column_letters(52), "AZ");
        assert_eq!(column_letters(703), "AAA");
        assert_eq!(column_letters(16384), "XFD");
    }

    #[test]
    fn a_matrix_is_read_from_its_lower_bounds_and_a_scalar_is_its_own_first_cell() {
        let array = SafeArray::new(
            vec![Dim { lbound: 1, len: 2 }, Dim { lbound: 1, len: 2 }],
            vec![Com::R8(1.0), Com::R8(3.0), Com::R8(2.0), Com::Str("d".to_owned())],
        )
        .expect("an array");
        let matrix = Com::Array(array);
        assert_eq!(matrix_value(&matrix, 1, 2), Com::R8(2.0));
        assert_eq!(matrix_value(&matrix, 2, 2), Com::Str("d".to_owned()));
        let zero_based = Com::Array(SafeArray::zero_based(vec![vec![Com::I4(7)]]).expect("an array"));
        assert_eq!(matrix_value(&zero_based, 1, 1), Com::I4(7));
        let scalar = Com::Str("x".to_owned());
        assert_eq!(matrix_value(&scalar, 1, 1), scalar);
        assert_eq!(matrix_value(&scalar, 1, 2), Com::Empty);
    }

    #[test]
    fn error_values_and_nulls_read_as_powershell_presented_them() {
        assert_eq!(ps_of(&Com::Error(-2_146_826_246)), Value::Int(-2_146_826_246));
        assert_eq!(ps_of(&Com::Null), Value::DbNull);
        assert_eq!(ps_of(&Com::Empty), Value::Null);
        assert!(is_ps_null(&Com::Empty) && !is_ps_null(&Com::Null) && is_null_or_dbnull(&Com::Null));
    }

    #[test]
    fn blocks_fitting_is_the_floor_of_the_quotient_and_at_least_one() {
        assert_eq!(blocks_fitting(500, 3).unwrap(), 166);
        assert_eq!(blocks_fitting(500, 500).unwrap(), 1);
        assert_eq!(blocks_fitting(500, 1000).unwrap(), 1);
        assert_eq!(blocks_fitting(20000, 0).unwrap(), 20000);
    }
}
