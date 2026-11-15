//! Financial exports of installed formulajs 4.6.1, index.mjs 11473-13050.
//! Operation order, truthy defaults, repeated parsing and iteration conditions
//! follow the source. Calendar functions are dispatched to the owned datetime
//! table, not duplicated as alternative day-count formulas here.
//! Some original inputs do not terminate. Product evaluation must stay in the
//! externally cancellable owned ext-worker process, never on a daemon thread.
use crate::coerce::{
    flatten, is_defined, is_truthy, parse_date, parse_date_array, parse_number,
    parse_number_array, to_js_number, to_js_utf16,
};
use crate::registry::{Table, library};
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::time::{date_parse, local_fields, local_to_utc_ms};
use mixdog_js::{math as m, number_to_string, parse_int_radix, string_to_number};
use std::collections::HashMap;

fn arg(a: &[V], i: usize) -> V {
    a.get(i).cloned().unwrap_or(V::Undefined)
}
fn default(a: &[V], i: usize, v: f64) -> V {
    match a.get(i) {
        None | Some(V::Undefined) => V::Number(v),
        Some(v) => v.clone(),
    }
}
fn truthy_default(v: V, d: f64) -> V {
    if is_truthy(&v) { v } else { V::Number(d) }
}
fn numeric(v: &V) -> Result<f64, E> {
    match parse_number(v) {
        V::Number(n) => Ok(n),
        V::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
fn nums(a: &[V]) -> Result<Vec<f64>, E> {
    a.iter().map(numeric).collect()
}
fn numbers(a: &[V]) -> Result<Vec<f64>, E> {
    parse_number_array(&flatten(a)).map(|a| a.iter().map(to_js_number).collect())
}
fn date(v: &V) -> Result<f64, E> {
    match parse_date(v) {
        V::Date(t) => Ok(t),
        V::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
fn num(n: f64) -> Result<V, Failure> {
    Ok(V::Number(n))
}
fn error(e: E) -> Result<V, Failure> {
    Ok(V::Error(e))
}
macro_rules! value_error {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(_) => return error(E::Value),
        }
    };
}
fn parsed_args(a: &[V], count: usize) -> Result<Vec<f64>, E> {
    nums(&(0..count).map(|i| arg(a, i)).collect::<Vec<_>>())
}
fn internal(name: &str, a: &[V]) -> Result<f64, Failure> {
    run(name, a).map(|v| to_js_number(&v))
}
// Internal function results can be Error objects. Keep them as Values until
// the particular JS operator requests numeric coercion: CUMPRINC's `+` can
// concatenate an Error's primitive string rather than returning numeric NaN.
fn addition_primitive(value: V) -> V {
    match value {
        V::Array(_) | V::Date(_) | V::Error(_) => V::from_utf16(to_js_utf16(&value)),
        other => other,
    }
}
fn add_values(left: V, right: V) -> V {
    let left = addition_primitive(left);
    let right = addition_primitive(right);
    if left.is_text() || right.is_text() {
        let mut units = to_js_utf16(&left);
        units.extend(to_js_utf16(&right));
        V::from_utf16(units)
    } else {
        V::Number(m::add(to_js_number(&left), to_js_number(&right)))
    }
}

fn calendar(name: &str, a: &[V]) -> Result<f64, Failure> {
    let function = library().resolve(name).ok_or_else(|| {
        Failure::unsupported(format!("financial dependency {name} is not registered"))
    })?;
    function(a).map(|v| to_js_number(&v))
}
fn primitive(v: &V) -> V {
    match v {
        V::Array(_) | V::Error(_) => V::from_utf16(to_js_utf16(v)),
        V::Date(t) => V::Number(*t),
        _ => v.clone(),
    }
}
fn less(a: &V, b: &V) -> bool {
    match (primitive(a), primitive(b)) {
        (a, b) if a.is_text() && b.is_text() => a.text_units().unwrap() < b.text_units().unwrap(),
        (a, b) => to_js_number(&a) < to_js_number(&b),
    }
}
fn less_equal(a: &V, b: &V) -> bool {
    match (primitive(a), primitive(b)) {
        (a, b) if a.is_text() && b.is_text() => a.text_units().unwrap() <= b.text_units().unwrap(),
        (a, b) => to_js_number(&a) <= to_js_number(&b),
    }
}
fn parse_int(n: f64) -> f64 {
    parse_int_radix(&number_to_string(n), 10.0)
}
fn number_values(a: &[f64]) -> Vec<V> {
    a.iter().copied().map(V::Number).collect()
}
fn annuity_args(a: &[V], count: usize, fv: usize, kind: usize) -> Result<Vec<f64>, E> {
    let mut a: Vec<_> = (0..count).map(|i| arg(a, i)).collect();
    a[fv] = truthy_default(a[fv].clone(), 0.0);
    a[kind] = truthy_default(a[kind].clone(), 0.0);
    nums(&a)
}
// ACCRINT alone uses new Date(value), rather than spreadsheet parseDate(serial).
fn ensure_date(v: &V) -> f64 {
    match v {
        V::Date(t) => *t,
        V::Text(s) => date_parse(s),
        V::Utf16(units) => mixdog_js::time::date_parse_utf16(units),
        V::Array(_) | V::Error(_) => mixdog_js::time::date_parse_utf16(&to_js_utf16(v)),
        _ => {
            let t = to_js_number(v);
            if t.is_finite() && t.abs() <= 8.64e15 {
                t.trunc()
            } else {
                f64::NAN
            }
        }
    }
}
fn set_date(t: f64, year: Option<i64>, month: Option<i64>) -> f64 {
    let Some(f) = local_fields(t) else {
        return f64::NAN;
    };
    let mon = month.unwrap_or(i64::from(f.month) - 1);
    let yr = year.unwrap_or(i64::from(f.year)) + mon.div_euclid(12);
    local_to_utc_ms(
        yr,
        mon.rem_euclid(12) + 1,
        i64::from(f.day),
        i64::from(f.hour),
        i64::from(f.minute),
        i64::from(f.second),
        i64::from(f.millisecond),
    )
}
fn coupon_days(a: &[V]) -> Result<V, Failure> {
    let basis = numeric(&arg(a, 3));
    let frequency = numeric(&arg(a, 2));
    let settlement = value_error!(date(&arg(a, 0)));
    let maturity = value_error!(date(&arg(a, 1)));
    let (Ok(basis), Ok(frequency)) = (basis, frequency) else {
        return error(E::Num);
    };
    if ![0.0, 1.0, 2.0, 3.0, 4.0].contains(&basis)
        || ![1.0, 2.0, 4.0].contains(&frequency)
        || settlement >= maturity
    {
        return error(E::Num);
    }
    if basis != 1.0 {
        return num(if basis == 3.0 { 365.0 } else { 360.0 } / frequency);
    }
    // lastCoupDateBeforeSettlement reparses maturity and calls setFullYear;
    // NaN Dates coming from whitespace retain the source's TypeError path.
    let mut current = date(&V::Date(maturity))
        .map_err(|_| Failure::thrown("date.setFullYear is not a function"))?;
    current = match local_fields(settlement) {
        Some(f) => set_date(current, Some(i64::from(f.year)), None),
        None => f64::NAN,
    };
    if current < settlement {
        let f = local_fields(current).expect("finite date");
        current = set_date(current, Some(i64::from(f.year) + 1), None);
    }
    while current > settlement {
        let f = local_fields(current).expect("finite date");
        current = set_date(
            current,
            None,
            Some(i64::from(f.month) - 1 - (12.0 / frequency) as i64),
        );
    }
    let next = date(&V::Date(current))
        .map_err(|_| Failure::thrown("nextDate.getMonth is not a function"))?;
    let next = local_fields(next).map_or(f64::NAN, |f| {
        set_date(
            next,
            None,
            Some(i64::from(f.month) - 1 + (12.0 / frequency) as i64),
        )
    });
    num(calendar(
        "DATEDIF",
        &[V::Date(current), V::Date(next), V::text("D")],
    )?)
}

fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    match name {
        "ACCRINT" => {
            let issue = ensure_date(&arg(a, 0));
            let first = ensure_date(&arg(a, 1));
            let settlement = ensure_date(&arg(a, 2));
            let frequency = numeric(&arg(a, 5));
            let basis = numeric(&arg(a, 6));
            let (Ok(frequency), Ok(basis)) = (frequency, basis) else {
                return error(E::Num);
            };
            if ![1.0, 2.0, 4.0].contains(&frequency) || ![0.0, 1.0, 2.0, 3.0, 4.0].contains(&basis)
            {
                return error(E::Num);
            }
            if !issue.is_finite() || !first.is_finite() || !settlement.is_finite() {
                return error(E::Value);
            }
            let rate = to_js_number(&arg(a, 3));
            let par = arg(a, 4);
            if rate <= 0.0 || to_js_number(&par) <= 0.0 || settlement <= issue {
                return error(E::Num);
            }
            let par = to_js_number(&truthy_default(par, 0.0));
            num(par
                * rate
                * calendar(
                    "YEARFRAC",
                    &[V::Date(issue), V::Date(settlement), V::Number(basis)],
                )?)
        }
        "COUPDAYS" => coupon_days(a),
        "CUMIPMT" | "CUMPRINC" => {
            let p = value_error!(parsed_args(a, 3));
            let (rate, nper, pv) = (p[0], p[1], p[2]);
            let mut start = arg(a, 3);
            let end = arg(a, 4);
            let kind = arg(a, 5);
            if rate <= 0.0
                || nper <= 0.0
                || pv <= 0.0
                || less(&start, &V::Number(1.0))
                || less(&end, &V::Number(1.0))
                || less(&end, &start)
            {
                return error(E::Num);
            }
            let V::Number(kind) = kind else {
                return error(E::Num);
            };
            if kind != 0.0 && kind != 1.0 {
                return error(E::Num);
            }
            let payment = run("PMT", &number_values(&[rate, nper, pv, 0.0, kind]))?;
            let mut total = V::Number(0.0);
            if matches!(start, V::Number(1.0)) {
                total = if name == "CUMIPMT" {
                    V::Number(if kind == 0.0 { -pv } else { 0.0 })
                } else if kind == 0.0 {
                    add_values(payment.clone(), V::Number(m::mul(pv, rate)))
                } else {
                    payment.clone()
                };
                start = V::Number(2.0);
            }
            while less_equal(&start, &end) {
                let i = to_js_number(&start);
                let future = run(
                    "FV",
                    &[
                        V::Number(rate),
                        V::Number(i - if kind == 1.0 { 2.0 } else { 1.0 }),
                        payment.clone(),
                        V::Number(pv),
                        V::Number(kind),
                    ],
                )?;
                let interest = if kind == 1.0 {
                    V::Number(to_js_number(&future) - to_js_number(&payment))
                } else {
                    future
                };
                let term = if name == "CUMIPMT" {
                    interest
                } else {
                    V::Number(to_js_number(&payment) - m::mul(to_js_number(&interest), rate))
                };
                total = add_values(total, term);
                start = V::Number(m::add(i, 1.0));
            }
            if name == "CUMIPMT" {
                num(m::mul(to_js_number(&total), rate))
            } else {
                Ok(total)
            }
        }
        "DB" | "DDB" => {
            let raw = [
                arg(a, 0),
                arg(a, 1),
                arg(a, 2),
                arg(a, 3),
                default(a, 4, if name == "DB" { 12.0 } else { 2.0 }),
            ];
            let p = value_error!(nums(&raw));
            let (cost, salvage, life, period, extra) = (p[0], p[1], p[2], p[3], p[4]);
            if cost < 0.0 || salvage < 0.0 || life < 0.0 || period < 0.0 {
                return error(E::Num);
            }
            if (name == "DB" && !(1.0..=12.0).contains(&extra))
                || (name == "DB" && extra.fract() != 0.0)
                || (name == "DDB" && extra <= 0.0)
                || period > life
            {
                return error(E::Num);
            }
            if salvage >= cost {
                return num(0.0);
            }
            if name == "DDB" {
                let (mut total, mut current, mut i) = (0.0, 0.0, 1.0);
                while i <= period {
                    current = m::min((cost - total) * (extra / life), cost - salvage - total);
                    total += current;
                    i += 1.0;
                }
                return num(current);
            }
            let rate = string_to_number(&m::to_fixed(1.0 - m::pow(salvage / cost, 1.0 / life), 3));
            let initial = cost * rate * extra / 12.0;
            let (mut total, mut current, mut i) = (initial, 0.0, 2.0);
            let ceiling = if period == life { life - 1.0 } else { period };
            while i <= ceiling {
                current = (cost - total) * rate;
                total += current;
                i += 1.0;
            }
            num(if period == 1.0 {
                initial
            } else if period == life {
                (cost - total) * rate
            } else {
                current
            })
        }
        "DISC" | "PRICEDISC" => {
            let s = value_error!(date(&arg(a, 0)));
            let maturity = value_error!(date(&arg(a, 1)));
            let p = value_error!(nums(&[arg(a, 2), arg(a, 3), arg(a, 4)]));
            let (price, redemption) = (p[0], p[1]);
            let basis = if p[2] == 0.0 || p[2].is_nan() {
                0.0
            } else {
                p[2]
            };
            if price <= 0.0 || redemption <= 0.0 {
                return error(E::Num);
            }
            if s >= maturity {
                return error(E::Value);
            }
            let (basis_days, difference) = match basis {
                0.0 | 4.0 => (
                    360.0,
                    calendar(
                        "DAYS360",
                        &[V::Date(s), V::Date(maturity), V::Bool(basis == 4.0)],
                    )?,
                ),
                1.0 | 2.0 | 3.0 => (
                    if basis == 2.0 { 360.0 } else { 365.0 },
                    calendar("DATEDIF", &[V::Date(s), V::Date(maturity), V::text("D")])?,
                ),
                _ => return error(E::Num),
            };
            num(if name == "DISC" {
                ((redemption - price) / redemption * basis_days) / difference
            } else {
                redemption - (price * redemption * difference) / basis_days
            })
        }
        "DOLLARDE" | "DOLLARFR" => {
            let p = value_error!(parsed_args(a, 2));
            let dollar = p[0];
            let fraction = p[1];
            if fraction < 0.0 {
                return error(E::Num);
            }
            if (0.0..1.0).contains(&fraction) {
                return error(E::Div0);
            }
            let fraction = parse_int(fraction);
            let mut result = parse_int(dollar);
            // V8's remainder of an infinite dollar by 1 is the negative canonical NaN.
            let fractional = if dollar.is_infinite() { f64::from_bits(0xfff8_0000_0000_0000) } else { dollar % 1.0 };
            if name == "DOLLARDE" {
                let decimal = m::mul(
                    fractional,
                    m::pow(10.0, m::ceil(m::ln(fraction) / std::f64::consts::LN_10)),
                ) / fraction;
                result = m::add(result, decimal);
                let power = m::pow(
                    10.0,
                    m::add(m::ceil(m::ln(fraction) / std::f64::consts::LN_2), 1.0),
                );
                result = m::round(m::mul(result, power)) / power;
            } else {
                let decimal = m::mul(
                    m::mul(
                        fractional,
                        m::pow(10.0, -m::ceil(m::ln(fraction) / std::f64::consts::LN_10)),
                    ),
                    fraction,
                );
                result = m::add(result, decimal);
            }
            num(result)
        }
        "EFFECT" | "NOMINAL" => {
            let p = value_error!(parsed_args(a, 2));
            let (rate, periods) = (p[0], p[1]);
            if rate <= 0.0 || periods < 1.0 {
                return error(E::Num);
            }
            let periods = parse_int(periods);
            num(if name == "EFFECT" {
                m::pow(1.0 + rate / periods, periods) - 1.0
            } else {
                (m::pow(rate + 1.0, 1.0 / periods) - 1.0) * periods
            })
        }
        "FV" | "PMT" | "PV" => {
            let p = value_error!(annuity_args(a, 5, 3, 4));
            let (rate, nper, payment, last, kind) = (p[0], p[1], p[2], p[3], p[4]);
            if name == "PV" {
                return num(if rate == 0.0 {
                    -payment * nper - last
                } else {
                    (((1.0 - m::pow(1.0 + rate, nper)) / rate) * payment * (1.0 + rate * kind)
                        - last)
                        / m::pow(1.0 + rate, nper)
                });
            }
            let result = if rate == 0.0 {
                if name == "FV" {
                    last + payment * nper
                } else {
                    (payment + last) / nper
                }
            } else {
                let term = m::pow(1.0 + rate, nper);
                if name == "FV" {
                    if kind == 1.0 {
                        last * term + (payment * (1.0 + rate) * (term - 1.0)) / rate
                    } else {
                        last * term + (payment * (term - 1.0)) / rate
                    }
                } else {
                    let value =
                        (last * rate) / (term - 1.0) + (payment * rate) / (1.0 - 1.0 / term);
                    if kind == 1.0 {
                        value / (1.0 + rate)
                    } else {
                        value
                    }
                }
            };
            num(-result)
        }
        "FVSCHEDULE" => {
            let principal = value_error!(numeric(&arg(a, 0)));
            let schedule = value_error!(numbers(&[arg(a, 1)]));
            let mut result = principal;
            for rate in schedule {
                result *= 1.0 + rate;
            }
            num(result)
        }
        "IPMT" => {
            let p = value_error!(annuity_args(a, 6, 4, 5));
            let (rate, per, nper, pv, fv, kind) = (p[0], p[1], p[2], p[3], p[4], p[5]);
            let payment = internal("PMT", &number_values(&[rate, nper, pv, fv, kind]))?;
            let interest = if per == 1.0 {
                if kind == 1.0 { 0.0 } else { -pv }
            } else if kind == 1.0 {
                internal("FV", &number_values(&[rate, per - 2.0, payment, pv, 1.0]))? - payment
            } else {
                internal("FV", &number_values(&[rate, per - 1.0, payment, pv, 0.0]))?
            };
            num(interest * rate)
        }
        "PPMT" => {
            let p = value_error!(nums(&[
                arg(a, 0),
                arg(a, 2),
                arg(a, 3),
                truthy_default(arg(a, 4), 0.0),
                truthy_default(arg(a, 5), 0.0)
            ]));
            let payment = internal("PMT", &number_values(&p))?;
            let interest = internal(
                "IPMT",
                &[
                    V::Number(p[0]),
                    arg(a, 1),
                    V::Number(p[1]),
                    V::Number(p[2]),
                    V::Number(p[3]),
                    V::Number(p[4]),
                ],
            )?;
            num(payment - interest)
        }
        "IRR" => irr(a),
        "ISPMT" => {
            let p = value_error!(parsed_args(a, 4));
            num(p[3] * p[0] * (p[1] / p[2] - 1.0))
        }
        "MIRR" => {
            let values = value_error!(numbers(&[arg(a, 0)]));
            let rates = value_error!(nums(&[arg(a, 1), arg(a, 2)]));
            let mut payments = Vec::new();
            let mut incomes = Vec::new();
            let n = values.len() as f64;
            for value in values {
                if value < 0.0 {
                    payments.push(V::Number(value))
                } else {
                    incomes.push(V::Number(value))
                }
            }
            let numerator = m::mul(
                -internal("NPV", &[V::Number(rates[1]), V::Array(incomes)])?,
                m::pow(m::add(1.0, rates[1]), n - 1.0),
            );
            let denominator = m::mul(
                internal("NPV", &[V::Number(rates[0]), V::Array(payments)])?,
                m::add(1.0, rates[0]),
            );
            num(m::pow(numerator / denominator, 1.0 / (n - 1.0)) - 1.0)
        }
        "NPER" => {
            let p = value_error!(nums(&[
                arg(a, 0),
                arg(a, 1),
                arg(a, 2),
                default(a, 3, 0.0),
                default(a, 4, 0.0)
            ]));
            let (r, pmt, pv, fv, kind) = (p[0], p[1], p[2], p[3], p[4]);
            num(if r == 0.0 {
                -(pv + fv) / pmt
            } else {
                let n = pmt * (1.0 + r * kind) - fv * r;
                let d = pv * r + pmt * (1.0 + r * kind);
                m::ln(n / d) / m::ln(1.0 + r)
            })
        }
        "NPV" => {
            let p = match numbers(a) {
                Ok(p) => p,
                Err(e) => return error(e),
            };
            let mut result = 0.0;
            for (j, v) in p.iter().enumerate().skip(1) {
                result += v / m::pow(1.0 + p[0], j as f64);
            }
            num(result)
        }
        "PDURATION" => {
            let p = value_error!(parsed_args(a, 3));
            if p[0] <= 0.0 {
                return error(E::Num);
            }
            num((m::ln(p[2]) - m::ln(p[1])) / m::ln(1.0 + p[0]))
        }
        "RATE" => rate(a),
        "RRI" => {
            let p = value_error!(parsed_args(a, 3));
            if p[0] == 0.0 || p[1] == 0.0 {
                return error(E::Num);
            }
            num(m::pow(p[2] / p[1], 1.0 / p[0]) - 1.0)
        }
        "SLN" => {
            let p = value_error!(parsed_args(a, 3));
            if p[2] == 0.0 {
                return error(E::Num);
            }
            num((p[0] - p[1]) / p[2])
        }
        "SYD" => {
            let p = value_error!(parsed_args(a, 4));
            if p[2] == 0.0 || p[3] < 1.0 || p[3] > p[2] {
                return error(E::Num);
            }
            num(((p[0] - p[1]) * (p[2] - parse_int(p[3]) + 1.0) * 2.0) / (p[2] * (p[2] + 1.0)))
        }
        "TBILLEQ" | "TBILLPRICE" | "TBILLYIELD" => {
            let s = value_error!(date(&arg(a, 0)));
            let maturity = value_error!(date(&arg(a, 1)));
            let discount = value_error!(numeric(&arg(a, 2)));
            if discount <= 0.0 || s > maturity || maturity - s > 365.0 * 24.0 * 60.0 * 60.0 * 1000.0
            {
                return error(E::Num);
            }
            let days = calendar("DAYS360", &[V::Date(s), V::Date(maturity), V::Bool(false)])?;
            num(match name {
                "TBILLEQ" => (365.0 * discount) / (360.0 - discount * days),
                "TBILLPRICE" => 100.0 * (1.0 - (discount * days) / 360.0),
                _ => (100.0 - discount) * 360.0 / (discount * days),
            })
        }
        "XIRR" | "XNPV" => dated_cashflows(name, a),
        _ => unreachable!("registered financial export"),
    }
}
fn rate(a: &[V]) -> Result<V, Failure> {
    let p = value_error!(nums(&[
        arg(a, 0),
        arg(a, 1),
        arg(a, 2),
        default(a, 3, 0.0),
        default(a, 4, 0.0),
        default(a, 5, 0.1)
    ]));
    let (nper, pmt, pv, fv, raw_kind) = (p[0], p[1], p[2], p[3], p[4]);
    let kind = if raw_kind != 0.0 && !raw_kind.is_nan() {
        1.0
    } else {
        0.0
    };
    let mut rate = p[5];
    let eps = 1e-10;
    for _ in 0..100 {
        if rate <= -1.0 {
            return error(E::Num);
        }
        let y = if m::abs(rate) < eps {
            pv * (1.0 + nper * rate) + pmt * (1.0 + rate * kind) * nper + fv
        } else {
            let f = m::pow(1.0 + rate, nper);
            pv * f + pmt * (1.0 / rate + kind) * (f - 1.0) + fv
        };
        if m::abs(y) < eps {
            return num(rate);
        }
        let dy = if m::abs(rate) < eps {
            pv * nper + pmt * kind * nper
        } else {
            let f = m::pow(1.0 + rate, nper);
            let df = nper * m::pow(1.0 + rate, nper - 1.0);
            pv * df + pmt * (1.0 / rate + kind) * df + pmt * (-1.0 / (rate * rate)) * (f - 1.0)
        };
        rate -= y / dy;
    }
    num(rate)
}
fn irr(a: &[V]) -> Result<V, Failure> {
    let guess = match arg(a, 1) {
        V::Number(n) => n,
        V::Undefined => 0.1,
        v => value_error!(numeric(&v)),
    };
    let defined: Vec<_> = flatten(&[arg(a, 0)])
        .into_iter()
        .filter(is_defined)
        .collect();
    let cash = value_error!(numbers(&[V::Array(defined)]));
    if !cash.iter().any(|n| *n > 0.0) || !cash.iter().any(|n| *n < 0.0) {
        return error(E::Num);
    }
    let mut cache = HashMap::new();
    let mut npv = |rate: f64| -> f64 {
        let rounded = m::round(m::mul(rate, 1e10)) / 1e10;
        let key = if rounded.is_nan() {
            f64::NAN.to_bits()
        } else if rounded == 0.0 {
            0
        } else {
            rounded.to_bits()
        };
        if let Some(v) = cache.get(&key) {
            return *v;
        }
        let r = m::add(
            1.0,
            if rounded <= -1.0 {
                -0.999999999
            } else {
                rounded
            },
        );
        let mut result = cash[0];
        let mut factor = 1.0;
        for v in cash.iter().skip(1) {
            factor = m::mul(factor, r);
            result = m::add(result, v / factor);
        }
        cache.insert(key, result);
        result
    };
    let eps = 1e-10;
    let mut rate = guess;
    let mut previous = rate;
    for iteration in 0..1000 {
        let current = npv(rate);
        if m::abs(current) < eps {
            return num(rate);
        }
        if iteration > 0 && m::abs(rate - previous) < eps * 10.0 {
            break;
        }
        let delta = m::max(0.0001, m::abs(m::mul(rate, 0.0001)));
        let derivative = (npv(m::add(rate, delta)) - current) / delta;
        if m::abs(derivative) < eps {
            break;
        }
        previous = rate;
        let step = current / derivative;
        let max_step = m::max(0.1, m::mul(m::abs(rate), 0.5));
        if m::abs(step) > max_step {
            rate -= m::mul(if step < 0.0 { -1.0 } else { 1.0 }, max_step)
        } else {
            rate -= step
        }
        if rate <= -1.0 {
            rate = -0.99999999
        }
        if rate > 1000.0 {
            rate = 1000.0
        }
    }
    let current = npv(rate);
    if m::abs(current) < eps {
        return num(rate);
    }
    let (mut left, mut right);
    if current > 0.0 {
        left = rate;
        right = m::add(rate, 0.1);
        while npv(right) > 0.0 && right < 1000.0 {
            right = m::add(m::mul(right, 2.0), 0.1);
        }
        if right >= 1000.0 {
            return num(rate);
        }
    } else {
        right = rate;
        left = m::max(-0.99999999, rate - 0.1);
        while npv(left) < 0.0 && left > -0.99999999 {
            left = m::max(-0.99999999, left - 0.1);
        }
        if left <= -0.99999999 {
            return num(rate);
        }
    }
    let mut middle = f64::NAN;
    for _ in 0..1000 {
        middle = m::add(left, right) / 2.0;
        let value = npv(middle);
        if m::abs(value) < eps || m::abs(right - left) < eps {
            return num(middle);
        }
        if m::mul(value, npv(left)) < 0.0 {
            right = middle
        } else {
            left = middle
        }
    }
    num(middle)
}
fn dated_cashflows(name: &str, a: &[V]) -> Result<V, Failure> {
    let offset = usize::from(name == "XNPV");
    let mut rate = if offset == 1 {
        value_error!(numeric(&arg(a, 0)))
    } else {
        value_error!(numeric(&arg(a, 2)))
    };
    let values = value_error!(numbers(&[arg(a, offset)]));
    let dates = value_error!(parse_date_array(&flatten(&[arg(a, offset + 1)])));
    let fraction = |i: usize| -> Result<f64, Failure> {
        Ok(calendar("DAYS", &[arg(&dates, i), arg(&dates, 0)])? / 365.0)
    };
    if name == "XNPV" {
        let mut result = 0.0;
        for (i, v) in values.iter().enumerate() {
            result += v / m::pow(1.0 + rate, fraction(i)?);
        }
        return num(result);
    }
    if !values.iter().any(|n| *n > 0.0) || !values.iter().any(|n| *n < 0.0) {
        return error(E::Num);
    }
    if rate == 0.0 || rate.is_nan() {
        rate = 0.1
    }
    // The installed source has no iteration count here. Retain its conjunction
    // termination rule; do not add an invented numerical limit/refusal.
    loop {
        let r = rate + 1.0;
        let mut result = values[0];
        for (i, v) in values.iter().enumerate().skip(1) {
            result += v / m::pow(r, fraction(i)?);
        }
        let mut derivative = 0.0;
        for (i, v) in values.iter().enumerate().skip(1) {
            let frac = fraction(i)?;
            derivative -= (frac * v) / m::pow(r, frac + 1.0);
        }
        let next = rate - result / derivative;
        let epsilon = m::abs(next - rate);
        rate = next;
        if !(epsilon > 1e-10 && m::abs(result) > 1e-10) {
            return num(rate);
        }
    }
}
macro_rules! functions {($($name:ident),+$(,)?)=>{$(fn $name(a:&[V])->Result<V,Failure>{run(stringify!($name),a)})+pub const FUNCTIONS:Table=&[$((stringify!($name),$name)),+];};}
#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        ACCRINT, COUPDAYS, CUMIPMT, CUMPRINC, DB, DDB, DISC, DOLLARDE, DOLLARFR, EFFECT, FV,
        FVSCHEDULE, IPMT, IRR, ISPMT, MIRR, NOMINAL, NPER, NPV, PDURATION, PMT, PPMT, PRICEDISC,
        PV, RATE, RRI, SLN, SYD, TBILLEQ, TBILLPRICE, TBILLYIELD, XIRR, XNPV
    );
}
pub use exports::FUNCTIONS;
