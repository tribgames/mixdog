//! `Sort-Object` and `Group-Object` as the hosts use them.
//!
//! PowerShell compares two strings with the current culture, ignoring case: `CompareInfo.Compare(a, b, IgnoreCase)`,
//! which .NET Framework runs as `CompareStringEx` with the user's locale and `NORM_IGNORECASE`. Two numbers compare
//! numerically, `$null` sorts first. Windows PowerShell 5.1 sorts with `Array.Sort` of .NET Framework, which is not stable:
//! values the comparison calls equal (`Apple`, `apple`, `APPLE`) come out in the order its quicksort leaves them, and the
//! hosts' answers (the merged ranges of a sheet, the alignment a table's columns share) carry that order. The same
//! quicksort is run here, so equal values come out in the same order. `-Unique` keeps the first of each run of equal
//! values after the sort and `-Descending` reverses the comparison.

use std::cmp::Ordering;

use super::Decimal;
use super::Value;
use super::convert;

/// `CompareInfo.Compare(a, b, CompareOptions.IgnoreCase)` under the user's locale.
#[cfg(windows)]
pub fn compare_strings(a: &str, b: &str) -> Ordering {
    use std::sync::OnceLock;

    use windows_sys::Win32::Globalization::CSTR_EQUAL;
    use windows_sys::Win32::Globalization::CSTR_GREATER_THAN;
    use windows_sys::Win32::Globalization::CompareStringEx;
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    use windows_sys::Win32::Globalization::NORM_IGNORECASE;

    /// `LOCALE_NAME_MAX_LENGTH`.
    const LOCALE_NAME_MAX_LENGTH: usize = 85;
    static LOCALE: OnceLock<Vec<u16>> = OnceLock::new();
    let locale = LOCALE.get_or_init(|| {
        let mut name = [0u16; LOCALE_NAME_MAX_LENGTH];
        // SAFETY: the buffer is LOCALE_NAME_MAX_LENGTH wide, as the call requires; it returns the length with the NUL.
        let length = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), LOCALE_NAME_MAX_LENGTH as i32) };
        let length = usize::try_from(length).unwrap_or(0).min(LOCALE_NAME_MAX_LENGTH);
        let mut owned = name[..length].to_vec();
        if owned.last() != Some(&0) {
            owned.push(0);
        }
        owned
    });
    let left: Vec<u16> = a.encode_utf16().collect();
    let right: Vec<u16> = b.encode_utf16().collect();
    // SAFETY: the locale name is NUL-terminated; the two strings are passed with their lengths; the reserved parameters
    // are null as documented.
    let result = unsafe {
        CompareStringEx(
            locale.as_ptr(),
            NORM_IGNORECASE,
            left.as_ptr(),
            left.len() as i32,
            right.as_ptr(),
            right.len() as i32,
            std::ptr::null(),
            std::ptr::null(),
            0,
        )
    };
    if result == CSTR_EQUAL {
        Ordering::Equal
    } else if result == CSTR_GREATER_THAN {
        Ordering::Greater
    } else if result == 0 {
        // A failed call: order by code units so a sort still ends.
        a.cmp(b)
    } else {
        Ordering::Less
    }
}

/// Culture-aware comparison is the Windows NLS call; Office is Windows-only, so no host runs elsewhere. Elsewhere the
/// strings compare by lower-cased text so the crate still builds.
#[cfg(not(windows))]
pub fn compare_strings(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase())
}

/// `-eq` of two strings: `String.Equals(a, b, CurrentCultureIgnoreCase)`, that is the culture comparison above.
pub fn strings_equal_ignore_case(a: &str, b: &str) -> bool {
    compare_strings(a, b) == Ordering::Equal
}

fn numeric(value: &Value) -> Option<f64> {
    match value {
        Value::Int(n) => Some(f64::from(*n)),
        Value::Long(n) => Some(*n as f64),
        Value::Double(n) => Some(*n),
        Value::Single(n) => Some(f64::from(*n)),
        Value::Decimal(n) => Some(n.to_f64()),
        _ => None,
    }
}

fn integral(value: &Value) -> Option<i128> {
    match value {
        Value::Int(n) => Some(i128::from(*n)),
        Value::Long(n) => Some(i128::from(*n)),
        _ => None,
    }
}

fn signed_mantissa(decimal: &Decimal) -> Option<i128> {
    let mantissa = i128::try_from(decimal.mantissa).ok()?;
    Some(if decimal.negative { -mantissa } else { mantissa })
}

fn compare_decimal_integral(decimal: &Decimal, whole: i128) -> Option<Ordering> {
    let power = i128::try_from(10u128.checked_pow(u32::from(decimal.scale))?).ok()?;
    let scaled = whole.checked_mul(power)?;
    Some(signed_mantissa(decimal)?.cmp(&scaled))
}

/// Two numbers compared; `None` when either is not a number or a NaN is involved.
fn compare_numbers(a: &Value, b: &Value) -> Option<Ordering> {
    if let (Some(x), Some(y)) = (integral(a), integral(b)) {
        return Some(x.cmp(&y));
    }
    match (a, b) {
        (Value::Decimal(x), Value::Decimal(y)) if x.scale == y.scale => {
            return Some(signed_mantissa(x)?.cmp(&signed_mantissa(y)?));
        }
        (Value::Decimal(x), other) => {
            if let Some(order) = integral(other).and_then(|y| compare_decimal_integral(x, y)) {
                return Some(order);
            }
        }
        (other, Value::Decimal(y)) => {
            if let Some(order) = integral(other).and_then(|x| compare_decimal_integral(y, x)) {
                return Some(order.reverse());
            }
        }
        _ => {}
    }
    numeric(a)?.partial_cmp(&numeric(b)?)
}

/// What `-eq`, `-gt` and the like say of two values: `None` when a NaN makes every comparison false.
pub fn compare_partial(a: &Value, b: &Value) -> Option<Ordering> {
    if numeric(a).is_some() && numeric(b).is_some() {
        return compare_numbers(a, b);
    }
    Some(compare_values(a, b))
}

/// `LanguagePrimitives.Compare(a, b, ignoreCase: true)` of two values: `$null` first, numbers numerically (a NaN before
/// every other number), a number against a string by converting the string to the number when it parses, everything else by
/// the text of the values under [`compare_strings`].
pub fn compare_values(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Null, Value::Null) => return Ordering::Equal,
        (Value::Null, _) => return Ordering::Less,
        (_, Value::Null) => return Ordering::Greater,
        _ => {}
    }
    if let (Some(x), Some(y)) = (numeric(a), numeric(b)) {
        return compare_numbers(a, b).unwrap_or_else(|| match (x.is_nan(), y.is_nan()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Less,
            _ => Ordering::Greater,
        });
    }
    if numeric(a).is_some() {
        if let Value::String(text) = b {
            if let Ok(parsed) = convert::to_double(&Value::string(text)) {
                if let Some(order) = numeric(a).and_then(|x| x.partial_cmp(&parsed)) {
                    return order;
                }
            }
        }
    }
    if let (Value::Bool(x), Value::Bool(y)) = (a, b) {
        return x.cmp(y);
    }
    compare_strings(&convert::to_ps_string(a), &convert::to_ps_string(b))
}

/// `Array.Sort(keys, comparer)` of .NET Framework: a quicksort with a median-of-three pre-sort of the partition, not
/// stable. `compare` is called as `comparer.Compare(a, b)` is, in the same order.
fn framework_sort<T>(items: &mut [T], compare: &mut dyn FnMut(&T, &T) -> Ordering) {
    fn swap_if_greater<T>(items: &mut [T], compare: &mut dyn FnMut(&T, &T) -> Ordering, a: usize, b: usize) {
        if a != b && compare(&items[a], &items[b]) == Ordering::Greater {
            items.swap(a, b);
        }
    }
    fn quick_sort<T>(items: &mut [T], compare: &mut dyn FnMut(&T, &T) -> Ordering, mut left: isize, mut right: isize) {
        loop {
            let mut i = left;
            let mut j = right;
            let middle = i + ((j - i) >> 1);
            swap_if_greater(items, compare, i as usize, middle as usize);
            swap_if_greater(items, compare, i as usize, j as usize);
            swap_if_greater(items, compare, middle as usize, j as usize);
            // The pivot is a copy of the middle element in the original; an index is enough here because the pivot
            // is only ever compared, and the loops below never move the middle element before they are done with it.
            let pivot = middle as usize;
            let mut pivot_at = pivot;
            loop {
                while compare(&items[i as usize], &items[pivot_at]) == Ordering::Less {
                    i += 1;
                }
                while compare(&items[pivot_at], &items[j as usize]) == Ordering::Less {
                    j -= 1;
                }
                if i > j {
                    break;
                }
                if i < j {
                    items.swap(i as usize, j as usize);
                    // Follow the pivot if the swap moved it.
                    if pivot_at == i as usize {
                        pivot_at = j as usize;
                    } else if pivot_at == j as usize {
                        pivot_at = i as usize;
                    }
                }
                i += 1;
                j -= 1;
                if i > j {
                    break;
                }
            }
            if j - left <= right - i {
                if left < j {
                    quick_sort(items, compare, left, j);
                }
                left = i;
            } else {
                if i < right {
                    quick_sort(items, compare, i, right);
                }
                right = j;
            }
            if left >= right {
                break;
            }
        }
    }
    if items.len() > 1 {
        let last = items.len() as isize - 1;
        quick_sort(items, compare, 0, last);
    }
}

/// What `Sort-Object` is asked for.
#[derive(Clone, Copy, Debug, Default)]
pub struct SortOptions {
    pub descending: bool,
    pub unique: bool,
}

/// `Sort-Object` over values compared by their own value (`Sort-Object`, `Sort-Object -Unique`, `-Descending`). Windows
/// PowerShell 5.1 does not pass a `$null` item through the sort: it is dropped.
pub fn sort_values(values: &[Value], options: SortOptions) -> Vec<Value> {
    let present: Vec<Value> = values.iter().filter(|value| !value.is_null()).cloned().collect();
    sort_by_key(&present, options, |value| value.clone())
}

/// `Sort-Object <property>` or `Sort-Object { <expression> }`: the items are ordered by the key computed for each.
pub fn sort_by_key<T: Clone>(items: &[T], options: SortOptions, key: impl Fn(&T) -> Value) -> Vec<T> {
    let mut keyed: Vec<(Value, T)> = items.iter().map(|item| (key(item), item.clone())).collect();
    let descending = options.descending;
    framework_sort(&mut keyed, &mut |left: &(Value, T), right: &(Value, T)| {
        let order = compare_values(&left.0, &right.0);
        if descending { order.reverse() } else { order }
    });
    if options.unique {
        let mut kept: Vec<(Value, T)> = Vec::with_capacity(keyed.len());
        for entry in keyed {
            let duplicate = kept.last().is_some_and(|last| compare_values(&last.0, &entry.0) == Ordering::Equal);
            if !duplicate {
                kept.push(entry);
            }
        }
        return kept.into_iter().map(|(_, item)| item).collect();
    }
    keyed.into_iter().map(|(_, item)| item).collect()
}

/// One row of `Group-Object`: `Name` is the text of the group's first value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub name: String,
    pub count: usize,
}

/// `$values | Group-Object`: values that compare equal (case-insensitively for strings) form a group, in order of first
/// appearance.
pub fn group_values(values: &[Value]) -> Vec<Group> {
    let mut firsts: Vec<Value> = Vec::new();
    let mut groups: Vec<Group> = Vec::new();
    for value in values {
        let found = firsts.iter().position(|first| compare_values(first, value) == Ordering::Equal);
        match found {
            Some(at) => groups[at].count += 1,
            None => {
                firsts.push(value.clone());
                groups.push(Group { name: convert::to_ps_string(value), count: 1 });
            }
        }
    }
    groups
}

/// `$values | Group-Object | Sort-Object Count -Descending`: the most frequent group first; groups of the same count come
/// out in the order the framework's quicksort leaves them.
pub fn groups_by_count_descending(values: &[Value]) -> Vec<Group> {
    let mut groups = group_values(values);
    framework_sort(&mut groups, &mut |left: &Group, right: &Group| right.count.cmp(&left.count));
    groups
}
