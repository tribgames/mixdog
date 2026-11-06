//! `Array.prototype.sort(compareFn)` as V8 runs it (TimSort, `third_party/v8/builtins/array-sort.tq`).
//!
//! A comparator that is not a strict weak order (several rules that can disagree, as the model
//! picker's recency order has) gives a result that depends on the algorithm's exact sequence of
//! comparisons, so the sort is reproduced step for step: binary insertion for a short run,
//! natural runs, the merge stack with its invariant, galloping merges.

const MIN_GALLOP_WINS: usize = 7;

/// `compareFn(a, b)`: V8 reads `NaN` as 0.
fn order<T, F: FnMut(&T, &T) -> f64>(compare: &mut F, a: &T, b: &T) -> f64 {
    let v = compare(a, b);
    if v.is_nan() { 0.0 } else { v }
}

/// `GallopLeft`: the leftmost position in the sorted `array[base..base + length]` where `key`
/// goes, searching outwards from `hint`.
fn gallop_left<T, F: FnMut(&T, &T) -> f64>(compare: &mut F, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize {
    let (base, length, hint) = (base as isize, length as isize, hint as isize);
    let at = |i: isize| &array[(base + i) as usize];
    let (mut last_ofs, mut offset) = (0isize, 1isize);
    if order(compare, at(hint), key) < 0.0 {
        // a[hint] < key: gallop right until a[hint + lastOfs] < key <= a[hint + offset]
        let max_ofs = length - hint;
        while offset < max_ofs {
            if order(compare, at(hint + offset), key) >= 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        last_ofs += hint;
        offset += hint;
    } else {
        // key <= a[hint]: gallop left until a[hint - offset] < key <= a[hint - lastOfs]
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if order(compare, at(hint - offset), key) < 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        let previous = last_ofs;
        last_ofs = hint - offset;
        offset = hint - previous;
    }
    last_ofs += 1;
    while last_ofs < offset {
        let m = last_ofs + ((offset - last_ofs) >> 1);
        if order(compare, at(m), key) < 0.0 {
            last_ofs = m + 1;
        } else {
            offset = m;
        }
    }
    offset as usize
}

/// `GallopRight`: the rightmost position where `key` goes.
fn gallop_right<T, F: FnMut(&T, &T) -> f64>(compare: &mut F, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize {
    let (base, length, hint) = (base as isize, length as isize, hint as isize);
    let at = |i: isize| &array[(base + i) as usize];
    let (mut last_ofs, mut offset) = (0isize, 1isize);
    if order(compare, key, at(hint)) < 0.0 {
        // key < a[hint]: gallop left until a[hint - offset] <= key < a[hint - lastOfs]
        let max_ofs = hint + 1;
        while offset < max_ofs {
            if order(compare, key, at(hint - offset)) >= 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        let previous = last_ofs;
        last_ofs = hint - offset;
        offset = hint - previous;
    } else {
        // a[hint] <= key: gallop right until a[hint + lastOfs] <= key < a[hint + offset]
        let max_ofs = length - hint;
        while offset < max_ofs {
            if order(compare, key, at(hint + offset)) < 0.0 {
                break;
            }
            last_ofs = offset;
            offset = (offset << 1) + 1;
        }
        offset = offset.min(max_ofs);
        last_ofs += hint;
        offset += hint;
    }
    last_ofs += 1;
    while last_ofs < offset {
        let m = last_ofs + ((offset - last_ofs) >> 1);
        if order(compare, key, at(m)) < 0.0 {
            offset = m;
        } else {
            last_ofs = m + 1;
        }
    }
    offset as usize
}

fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

struct Sorter<'a, T, F: FnMut(&T, &T) -> f64> {
    array: Vec<T>,
    compare: &'a mut F,
    min_gallop: usize,
    /// `(base, length)` of each pending run.
    runs: Vec<(usize, usize)>,
}

/// Sorts `items` as `items.sort(compare)` does; `compare` answers a JS number (`NaN` counts as 0).
pub fn js_sort_by<T: Clone>(items: &mut Vec<T>, mut compare: impl FnMut(&T, &T) -> f64) {
    if items.len() < 2 {
        return;
    }
    let mut sorter = Sorter { array: std::mem::take(items), compare: &mut compare, min_gallop: MIN_GALLOP_WINS, runs: Vec::new() };
    sorter.sort();
    *items = sorter.array;
}

impl<T: Clone, F: FnMut(&T, &T) -> f64> Sorter<'_, T, F> {
    fn sort(&mut self) {
        let length = self.array.len();
        let min_run = min_run_length(length);
        let (mut low, mut remaining) = (0, length);
        while remaining != 0 {
            let mut current = self.count_and_make_run(low, low + remaining);
            if current < min_run {
                let forced = min_run.min(remaining);
                self.binary_insertion_sort(low, low + current, low + forced);
                current = forced;
            }
            self.runs.push((low, current));
            self.merge_collapse();
            low += current;
            remaining -= current;
        }
        self.merge_force_collapse();
    }

    fn count_and_make_run(&mut self, low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let descending = order(self.compare, &self.array[low], &self.array[low - 1]) < 0.0;
        let mut previous = low;
        for idx in low + 1..high {
            let o = order(self.compare, &self.array[idx], &self.array[previous]);
            if descending {
                if o >= 0.0 {
                    break;
                }
            } else if o < 0.0 {
                break;
            }
            previous = idx;
            run += 1;
        }
        if descending {
            self.array[low_arg..low_arg + run].reverse();
        }
        run
    }

    fn binary_insertion_sort(&mut self, low: usize, start_arg: usize, high: usize) {
        let first = if start_arg == low { start_arg + 1 } else { start_arg };
        for start in first..high {
            let (mut left, mut right) = (low, start);
            let pivot = self.array[start].clone();
            while left < right {
                let mid = left + ((right - left) >> 1);
                if order(self.compare, &pivot, &self.array[mid]) < 0.0 {
                    right = mid;
                } else {
                    left = mid + 1;
                }
            }
            let mut p = start;
            while left < p {
                self.array[p] = self.array[p - 1].clone();
                p -= 1;
            }
            self.array[left] = pivot;
        }
    }

    /// `RunInvariantEstablished`.
    fn invariant(&self, n: usize) -> bool {
        n < 2 || self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    fn merge_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.invariant(n + 1) || !self.invariant(n) {
                if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(n);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                n -= 1;
            }
            self.merge_at(n);
        }
    }

    fn merge_at(&mut self, i: usize) {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        if i + 3 == self.runs.len() {
            self.runs[i + 1] = self.runs[i + 2];
        }
        self.runs.pop();
        // Where run B's first element goes in A: the elements before it are in place.
        let key = self.array[base_b].clone();
        let k = gallop_right(self.compare, &self.array, &key, base_a, length_a, 0);
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        // Where run A's last element goes in B: the elements after it are in place.
        let key = self.array[base_a + length_a - 1].clone();
        length_b = gallop_left(self.compare, &self.array, &key, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(base_a, length_a, base_b, length_b);
        }
    }

    fn merge_low(&mut self, base_a: usize, mut length_a: usize, base_b: usize, mut length_b: usize) {
        enum End {
            /// The rest of A goes in.
            Succeed,
            /// One element of A is left: B's rest, then it.
            CopyB,
        }
        let temp: Vec<T> = self.array[base_a..base_a + length_a].to_vec();
        let (mut dest, mut cursor_temp, mut cursor_b) = (base_a, 0usize, base_b);
        self.array[dest] = self.array[cursor_b].clone();
        dest += 1;
        cursor_b += 1;
        length_b -= 1;
        let end = 'merge: {
            if length_b == 0 {
                break 'merge End::Succeed;
            }
            if length_a == 1 {
                break 'merge End::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                // Straightforward merge until one run appears to win consistently.
                loop {
                    if order(self.compare, &self.array[cursor_b], &temp[cursor_temp]) < 0.0 {
                        self.array[dest] = self.array[cursor_b].clone();
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        self.array[dest] = temp[cursor_temp].clone();
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                // Galloping: one run is winning consistently.
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = self.array[cursor_b].clone();
                    wins_a = gallop_right(self.compare, &temp, &key, cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        self.array[dest..dest + wins_a].clone_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        // length_a == 0 only with an inconsistent comparator.
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.array[dest] = self.array[cursor_b].clone();
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                    wins_b = gallop_left(self.compare, &self.array, &temp[cursor_temp], cursor_b, length_b, 0);
                    if wins_b > 0 {
                        for n in 0..wins_b {
                            self.array[dest + n] = self.array[cursor_b + n].clone();
                        }
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.array[dest] = temp[cursor_temp].clone();
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge End::CopyB;
                    }
                }
                min_gallop += 1; // penalize leaving galloping mode
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                self.array[dest..dest + length_a].clone_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
            }
            End::CopyB => {
                for n in 0..length_b {
                    self.array[dest + n] = self.array[cursor_b + n].clone();
                }
                self.array[dest + length_b] = temp[cursor_temp].clone();
            }
        }
    }

    fn merge_high(&mut self, base_a: usize, mut length_a: usize, base_b: usize, mut length_b: usize) {
        enum End {
            /// The rest of B goes in.
            Succeed,
            /// One element of B is left: A's rest, then it.
            CopyA,
        }
        let temp: Vec<T> = self.array[base_b..base_b + length_b].to_vec();
        let mut dest = (base_b + length_b) as isize - 1;
        let mut cursor_temp = length_b as isize - 1;
        let mut cursor_a = (base_a + length_a) as isize - 1;
        self.array[dest as usize] = self.array[cursor_a as usize].clone();
        dest -= 1;
        cursor_a -= 1;
        length_a -= 1;
        let end = 'merge: {
            if length_a == 0 {
                break 'merge End::Succeed;
            }
            if length_b == 1 {
                break 'merge End::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let (mut wins_a, mut wins_b) = (0usize, 0usize);
                loop {
                    if order(self.compare, &temp[cursor_temp as usize], &self.array[cursor_a as usize]) < 0.0 {
                        self.array[dest as usize] = self.array[cursor_a as usize].clone();
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    } else {
                        self.array[dest as usize] = temp[cursor_temp as usize].clone();
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let k = gallop_right(self.compare, &self.array, &temp[cursor_temp as usize], base_a, length_a, length_a - 1);
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a as isize;
                        cursor_a -= wins_a as isize;
                        for n in (0..wins_a).rev() {
                            self.array[(dest + 1) as usize + n] = self.array[(cursor_a + 1) as usize + n].clone();
                        }
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.array[dest as usize] = temp[cursor_temp as usize].clone();
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge End::CopyA;
                    }
                    let k = gallop_left(self.compare, &temp, &self.array[cursor_a as usize], 0, length_b, length_b - 1);
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b as isize;
                        cursor_temp -= wins_b as isize;
                        for n in 0..wins_b {
                            self.array[(dest + 1) as usize + n] = temp[(cursor_temp + 1) as usize + n].clone();
                        }
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        // length_b == 0 only with an inconsistent comparator.
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    self.array[dest as usize] = self.array[cursor_a as usize].clone();
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                let start = (dest - (length_b as isize - 1)) as usize;
                self.array[start..start + length_b].clone_from_slice(&temp[..length_b]);
            }
            End::CopyA => {
                dest -= length_a as isize;
                cursor_a -= length_a as isize;
                for n in (0..length_a).rev() {
                    self.array[(dest + 1) as usize + n] = self.array[(cursor_a + 1) as usize + n].clone();
                }
                self.array[dest as usize] = temp[cursor_temp as usize].clone();
            }
        }
    }
}

#[cfg(test)]
#[path = "array_sort_tests.rs"]
mod tests;
