//! The function library of the formula engine, through the public API: what a spreadsheet user gets for the common
//! functions of each family (math, statistics, distributions, engineering, financial, text and date), the error values
//! they answer, and how text made of UTF-16 units that are not valid characters travels through them.

#![allow(clippy::excessive_precision)] // the reference values are 17-digit mpmath results

use mixdog_js::time::{Tz, local_fields, with_local_zone};
use mixdog_xlsx_formula::coerce::{js_strict_equals, parse_string, to_js_number, to_js_utf16};
use mixdog_xlsx_formula::{Context, ErrorValue, Failure, Value, evaluate_formula, library};

/// A sheet with the numbers 1..=5 in A1:A5 and the word `north` in B1.
struct Sheet;

impl Context for Sheet {
    fn sheet(&self) -> &str {
        "Sheet1"
    }

    fn value(&mut self, _sheet: &str, reference: &str) -> Result<Value, Failure> {
        Ok(match reference {
            "A1" => Value::Number(1.0),
            "A2" => Value::Number(2.0),
            "A3" => Value::Number(3.0),
            "A4" => Value::Number(4.0),
            "A5" => Value::Number(5.0),
            "B1" => Value::text("north"),
            "Z1" | "Z2" | "Z3" | "Z4" => Value::Error(ErrorValue::Div0),
            _ => Value::text(""),
        })
    }
}

fn eval(formula: &str) -> Result<Value, Failure> {
    with_local_zone(Tz::UTC, || evaluate_formula(formula, &mut Sheet))
}

fn num(formula: &str) -> f64 {
    match eval(formula) {
        Ok(Value::Number(number)) => number,
        other => panic!("{formula}: {other:?}"),
    }
}

fn text(formula: &str) -> String {
    match eval(formula) {
        Ok(Value::Text(text)) => text,
        other => panic!("{formula}: {other:?}"),
    }
}

fn error(formula: &str) -> ErrorValue {
    match eval(formula) {
        Ok(Value::Error(error)) => error,
        other => panic!("{formula}: {other:?}"),
    }
}

fn close(formula: &str, expected: f64, tolerance: f64) {
    let got = num(formula);
    assert!((got - expected).abs() <= tolerance, "{formula}: {got} is not {expected} +- {tolerance}");
}

/// `expected` to a relative 1e-12: the statistical functions are computed to that accuracy or better.
fn rel(formula: &str, expected: f64) {
    let got = num(formula);
    assert!((got - expected).abs() <= 1e-12 * expected.abs(), "{formula}: {got:e} is not {expected:e} (relative {:e})", ((got - expected) / expected).abs());
}

#[test]
fn math_functions_round_and_divide_the_way_a_spreadsheet_does() {
    assert_eq!(num("=ABS(-3.5)"), 3.5);
    assert_eq!(num("=MOD(-3,2)"), 1.0);
    assert_eq!(num("=POWER(2,10)"), 1024.0);
    // Halves round away from zero.
    assert_eq!(num("=ROUND(2.5,0)"), 3.0);
    assert_eq!(num("=ROUND(-2.5,0)"), -3.0);
    assert_eq!(num("=ROUND(1234.5678,-2)"), 1200.0);
    assert_eq!(num("=INT(-1.5)"), -2.0);
    assert_eq!(num("=GCD(12,18)"), 6.0);
    assert_eq!(num("=LCM(4,6)"), 12.0);
    assert_eq!(num("=FACT(5)"), 120.0);
    assert_eq!(num("=COMBIN(5,2)"), 10.0);
    assert_eq!(num("=SUM(A1:A5)"), 15.0);
    assert_eq!(num("=SUMPRODUCT(A1:A2,A4:A5)"), 14.0);
    assert_eq!(error("=SQRT(-1)"), ErrorValue::Num);
    assert_eq!(error("=MOD(1,0)"), ErrorValue::Div0);
}

#[test]
fn logical_and_information_functions_answer_booleans_and_keep_unrelated_errors_out() {
    assert_eq!(eval("=AND(TRUE,A1>0)"), Ok(Value::Bool(true)));
    assert_eq!(eval("=OR(FALSE,A1>5)"), Ok(Value::Bool(false)));
    assert_eq!(eval("=NOT(TRUE)"), Ok(Value::Bool(false)));
    assert_eq!(eval("=ISNUMBER(A1)"), Ok(Value::Bool(true)));
    assert_eq!(eval("=ISTEXT(B1)"), Ok(Value::Bool(true)));
    assert_eq!(eval("=ISERROR(1/0)"), Ok(Value::Bool(true)));
    assert_eq!(num("=IF(A1=1,10,1/0)"), 10.0);
}

#[test]
fn descriptive_statistics_read_a_range() {
    assert_eq!(num("=AVERAGE(A1:A5)"), 3.0);
    assert_eq!(num("=MEDIAN(A1:A4)"), 2.5);
    assert_eq!(num("=MAX(A1:A5)"), 5.0);
    assert_eq!(num("=MIN(A1:A5)"), 1.0);
    assert_eq!(num("=COUNT(A1:A5)"), 5.0);
    assert_eq!(num("=LARGE(A1:A5,2)"), 4.0);
    assert_eq!(num("=SMALL(A1:A5,2)"), 2.0);
    assert_eq!(num("=VAR.P(A1:A5)"), 2.0);
    assert_eq!(num("=VAR.S(A1:A5)"), 2.5);
    close("=STDEV(A1:A5)", 2.5_f64.sqrt(), 1e-12);
    assert_eq!(num("=PERCENTILE(A1:A5,0.5)"), 3.0);
    assert_eq!(num("=RANK(4,A1:A5)"), 2.0);
    assert_eq!(num("=COUNTIF(A1:A5,\">2\")"), 3.0);
    assert_eq!(num("=SUMIF(A1:A5,\"<=2\")"), 3.0);
}

#[test]
fn distributions_agree_with_their_textbook_values() {
    rel("=NORM.S.DIST(0,TRUE)", 0.5);
    rel("=NORM.S.DIST(1.96,TRUE)", 0.97500210485177956);
    close("=BINOM.DIST(2,4,0.5,FALSE)", 0.375, 1e-12);
    close("=POISSON.DIST(0,1,FALSE)", (-1.0_f64).exp(), 1e-12);
    close("=EXPON.DIST(1,1,TRUE)", 1.0 - (-1.0_f64).exp(), 1e-12);
    rel("=NORM.S.INV(0.975)", 1.9599639845400539);
}

#[test]
fn engineering_functions_convert_bases_units_and_complex_numbers() {
    assert_eq!(num("=BIN2DEC(\"1010\")"), 10.0);
    assert_eq!(text("=DEC2BIN(10)"), "1010");
    assert_eq!(text("=DEC2HEX(255)").to_uppercase(), "FF");
    assert_eq!(num("=HEX2DEC(\"ff\")"), 255.0);
    assert_eq!(num("=BITAND(12,10)"), 8.0);
    assert_eq!(num("=DELTA(2,2)"), 1.0);
    assert_eq!(text("=COMPLEX(3,4)"), "3+4i");
    assert_eq!(num("=IMABS(\"3+4i\")"), 5.0);
    assert_eq!(num("=CONVERT(1,\"km\",\"m\")"), 1000.0);
    rel("=ERF(1)", 0.84270079294971487);
    // A binary number has at most ten digits, and only 0 and 1.
    assert_eq!(error("=BIN2DEC(\"12\")"), ErrorValue::Num);
}

#[test]
fn financial_functions_follow_the_time_value_of_money() {
    // 10000 borrowed at 5% a year over 60 months: the payment is 188.71 a month, paid out (negative sign).
    close("=PMT(0.05/12,60,10000)", -188.7123362, 1e-6);
    close("=NPV(0.1,100,200)", 100.0 / 1.1 + 200.0 / 1.21, 1e-9);
    close("=FV(0.1,2,0,-100)", 121.0, 1e-9);
    close("=PV(0.1,2,0,-121)", 100.0, 1e-9);
}

#[test]
fn text_functions_cut_join_and_convert() {
    assert_eq!(text("=LEFT(B1,2)"), "no");
    assert_eq!(text("=MID(B1,2,3)"), "ort");
    assert_eq!(text("=UPPER(B1)"), "NORTH");
    assert_eq!(text("=TRIM(\"  a   b  \")"), "a b");
    assert_eq!(text("=SUBSTITUTE(\"a-b-c\",\"-\",\"+\")"), "a+b+c");
    assert_eq!(text("=REPT(\"ab\",3)"), "ababab");
    assert_eq!(num("=LEN(B1)"), 5.0);
    assert_eq!(num("=CODE(\"A\")"), 65.0);
    assert_eq!(text("=CHAR(66)"), "B");
    assert_eq!(text("=TEXTJOIN(\"-\",TRUE,\"a\",\"b\")"), "a-b");
    assert_eq!(text("=TEXT(1234.5,\"0.00\")"), "1234.50");
    // A string that would not fit in a JavaScript string is an error of the engine, not an allocation.
    assert!(eval("=REPT(\"abcdefgh\",100000000)").is_err());
}

#[test]
fn date_functions_count_calendar_days_from_the_excel_epoch() {
    // 31 January 2024 is day 45322.
    assert_eq!(num("=DATE(2024,1,31)"), 45322.0);
    assert_eq!(num("=EDATE(DATE(2024,1,31),1)"), 45351.0);
    assert_eq!(num("=EOMONTH(DATE(2024,1,15),0)"), 45322.0);
    assert_eq!(num("=YEAR(DATE(2024,5,6))"), 2024.0);
    assert_eq!(num("=MONTH(DATE(2024,5,6))"), 5.0);
    assert_eq!(num("=DAY(DATE(2024,5,6))"), 6.0);
    // Wednesday, counting Sunday as 1.
    assert_eq!(num("=WEEKDAY(DATE(2024,1,31))"), 4.0);
    assert_eq!(num("=DATEDIF(\"2020-01-01\",\"2024-03-01\",\"Y\")"), 4.0);
    assert_eq!(num("=NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,7))"), 5.0);
}

#[test]
fn now_and_today_read_the_current_calendar_of_the_local_zone() {
    let clock = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
    for zone in [Tz::UTC, Tz::Asia__Seoul, Tz::America__New_York] {
        with_local_zone(zone, || {
            let before = clock();
            let Value::Date(now) = library().resolve("NOW").unwrap()(&[]).unwrap() else { panic!("NOW is a date") };
            let after = clock();
            assert!(before <= now && now <= after);
            let Value::Date(today) = library().resolve("TODAY").unwrap()(&[]).unwrap() else { panic!("TODAY is a date") };
            let fields = local_fields(today).unwrap();
            assert_eq!((fields.hour, fields.minute, fields.second, fields.millisecond), (0, 0, 0, 0));
            let current = local_fields(after).unwrap();
            assert_eq!((fields.year, fields.month, fields.day), (current.year, current.month, current.day));
        });
    }
}

#[test]
fn text_with_unpaired_surrogates_stays_a_string_and_recombines() {
    let high = Value::from_utf16(vec![0xd83d]);
    let low = Value::from_utf16(vec![0xde00]);
    assert!(high.is_text());
    assert!(to_js_number(&high).is_nan());
    assert_eq!(parse_string(&high), high);
    assert!(js_strict_equals(&high, &Value::from_utf16(vec![0xd83d])));
    assert_eq!(to_js_utf16(&Value::Array(vec![high.clone(), low.clone()])), vec![0xd83d, u16::from(b','), 0xde00]);
    // Two halves joined are the character they make together.
    assert_eq!(Value::from_utf16([to_js_utf16(&high), to_js_utf16(&low)].concat()), Value::text("\u{1F600}"));
    // Written out as UTF-8 a lone half is the replacement character.
    assert_eq!(high.text_to_utf8_lossy().unwrap().as_bytes(), [0xef, 0xbf, 0xbd]);
}

#[test]
fn unpaired_surrogates_reach_engineering_and_financial_functions_unchanged() {
    let raw = Value::from_utf16(vec![0xd800]);
    let call = |name: &str, args: &[Value]| library().resolve(name).unwrap()(args);
    assert_eq!(call("BIN2DEC", std::slice::from_ref(&raw)), Ok(Value::Error(ErrorValue::Num)));
    assert_eq!(call("DEC2BIN", std::slice::from_ref(&raw)), Ok(Value::Error(ErrorValue::Value)));
    assert_eq!(call("IMPRODUCT", std::slice::from_ref(&raw)), Ok(raw.clone()));
    let mut issue = vec![0xd800];
    issue.extend(" Jan 1, 2024".encode_utf16());
    with_local_zone(Tz::UTC, || {
        let accrued = call(
            "ACCRINT",
            &[
                Value::from_utf16(issue),
                Value::text("Jul 1, 2024"),
                Value::text("Feb 1, 2024"),
                Value::Number(0.05),
                Value::Number(1000.0),
                Value::Number(2.0),
                Value::Number(0.0),
                Value::Bool(true),
            ],
        );
        // One month of a 5% coupon on 1000 paid twice a year: 1000 * 0.05 / 12.
        assert_eq!(accrued, Ok(Value::Number(4.166666666666666)));
    });
}

#[test]
fn inverse_distributions_reject_a_probability_outside_their_domain() {
    assert_eq!(error("=NORM.S.INV(1.5)"), ErrorValue::Num);
    assert_eq!(error("=NORM.S.INV(0)"), ErrorValue::Num);
    assert_eq!(error("=NORM.S.INV(1)"), ErrorValue::Num);
    assert_eq!(error("=NORMSINV(-0.1)"), ErrorValue::Num);
    assert_eq!(error("=NORM.INV(1.5,0,1)"), ErrorValue::Num);
    assert_eq!(error("=NORMINV(0,0,1)"), ErrorValue::Num);
    assert_eq!(error("=NORM.INV(0.5,0,0)"), ErrorValue::Num);
    assert_eq!(num("=NORM.INV(0.5,10,2)"), 10.0);
    rel("=NORMSINV(0.975)", 1.9599639845400539);
    assert_eq!(error("=LOGNORM.INV(1.5,0,1)"), ErrorValue::Num);
    assert_eq!(error("=LOGINV(0,0,1)"), ErrorValue::Num);
    rel("=LOGINV(0.5,0,1)", 1.0);
    assert_eq!(error("=T.INV(1.5,10)"), ErrorValue::Num);
    assert_eq!(error("=T.INV(0.5,0)"), ErrorValue::Num);
    assert_eq!(error("=CHISQ.INV(1.5,2)"), ErrorValue::Num);
    assert_eq!(error("=F.INV(1.5,5,5)"), ErrorValue::Num);
    assert_eq!(error("=BETA.INV(1.5,2,3)"), ErrorValue::Num);
    assert_eq!(error("=BETAINV(0.5,0,3)"), ErrorValue::Num);
    assert_eq!(error("=BINOM.INV(10,0.5,1.5)"), ErrorValue::Num);
    assert_eq!(error("=CRITBINOM(10,1.5,0.5)"), ErrorValue::Num);
    assert_eq!(num("=BINOM.INV(10,0.5,0.5)"), 5.0);
    assert_eq!(error("=CONFIDENCE.NORM(1.5,1,100)"), ErrorValue::Num);
    assert_eq!(error("=CONFIDENCE(0.05,0,100)"), ErrorValue::Num);
}

#[test]
fn right_tail_legacy_functions_coerce_numeric_text_and_accept_the_lower_bound() {
    rel("=CHIDIST(0.5,2)", (-0.25_f64).exp());
    assert_eq!(num("=CHIDIST(0,2)"), 1.0);
    assert_eq!(error("=CHIDIST(-1,2)"), ErrorValue::Num);
    assert_eq!(error("=CHIDIST(1,0)"), ErrorValue::Num);
    assert_eq!(error("=CHIDIST(1,2,3)"), ErrorValue::Na);
    // mpmath: 2*log(2)
    rel("=CHIINV(0.5,\"2\")", 1.3862943611198906);
    rel("=CHISQ.DIST.RT(\"0.5\",\"2\")", (-0.25_f64).exp());
    rel("=BETADIST(3,1,1,2,6)", 0.25);
    rel("=FDIST(3,2,2)", 0.25);
    rel("=FINV(0.25,2,2)", 3.0);
    assert_eq!(num("=FDIST(0,2,2)"), 1.0);
    assert_eq!(error("=NORMSDIST(1,2)"), ErrorValue::Na);
    assert_eq!(error("=BETADIST(0.5,2)"), ErrorValue::Na);
    assert_eq!(error("=BETADIST(0.5,2,2,0,1,9)"), ErrorValue::Na);
    assert_eq!(error("=LOGNORMDIST(0,0,1)"), ErrorValue::Num);
}

#[test]
fn quantile_functions_fix_the_singular_endpoint_and_the_integer_arguments() {
    assert_eq!(num("=BINOM.INV(0.5,0.5,0.9)"), 0.0);
    assert_eq!(num("=BINOM.INV(10.9,0.5,0.5)"), 5.0);
    for bad in
        ["=BINOM.INV(-1,0.5,0.5)", "=BINOM.INV(10,0,0.5)", "=BINOM.INV(10,1,0.5)", "=BINOM.INV(10,0.5,0)", "=BINOM.INV(10,0.5,1)", "=CRITBINOM(10,0.5,1)"]
    {
        assert_eq!(error(bad), ErrorValue::Num, "{bad}");
    }
    assert_eq!(error("=CONFIDENCE.T(0.05,1,1.9)"), ErrorValue::Div0);
    rel("=CONFIDENCE.NORM(0.05,1,1.9)", 1.9599639845400539);
    // mpmath: tan(pi*(1/2 - 0.025)), one degree of freedom after truncation
    rel("=TINV(0.05,1.9)", 12.706204736174705);
    // closed forms: chi-square(2) median 2 ln 2; F(2,2) cdf x/(1+x), median 1 (df truncate to 2)
    rel("=CHISQ.INV(0.5,2.9)", 1.3862943611198906);
    rel("=F.INV(0.5,2.9,2.9)", 1.0);
    assert_eq!(error("=BETA.INV(0.5,2,2,4,4)"), ErrorValue::Num);
    assert_eq!(num("=F.INV(0,2,2)"), 0.0);
    for singular in ["=CHISQ.INV(1,2)", "=F.INV(1,2,2)", "=T.INV(1,5)", "=GAMMA.INV(1,2,2)", "=CHISQ.INV.RT(0,2)", "=F.INV.RT(0,2,2)"] {
        assert_eq!(error(singular), ErrorValue::Num, "{singular}");
    }
    assert_eq!(num("=CHISQ.INV.RT(1,2)"), 0.0);
    assert_eq!(num("=F.INV.RT(1,2,2)"), 0.0);
}

#[test]
fn poisson_and_weibull_require_the_cumulative_flag() {
    assert_eq!(error("=POISSON.DIST(2,3)"), ErrorValue::Value);
    assert_eq!(error("=POISSON(2,3)"), ErrorValue::Value);
    assert_eq!(error("=WEIBULL.DIST(1,1,1)"), ErrorValue::Value);
    assert_eq!(error("=WEIBULL(1,1,1)"), ErrorValue::Value);
    rel("=POISSON.DIST(2,3,FALSE)", 0.22404180765538774);
    rel("=POISSON.DIST(2.9,3,FALSE)", 0.22404180765538774);
    close("=WEIBULL.DIST(1,1,1,FALSE)", (-1.0_f64).exp(), 1e-12);
    assert_eq!(error("=POISSON.DIST(-1,3,TRUE)"), ErrorValue::Num);
    assert_eq!(error("=WEIBULL.DIST(1,0,1,TRUE)"), ErrorValue::Num);
}

#[test]
fn engineering_padding_is_limited_to_ten_places_and_ignored_for_negatives() {
    assert_eq!(error("=DEC2HEX(1,11)"), ErrorValue::Num);
    assert_eq!(error("=DEC2BIN(1,1E300)"), ErrorValue::Num);
    assert_eq!(text("=DEC2HEX(255,10)"), "00000000FF");
    assert_eq!(text("=DEC2HEX(-1,1)"), "FFFFFFFFFF");
    assert_eq!(text("=BIN2HEX(\"1111111111\",1)"), "FFFFFFFFFF");
    assert_eq!(text("=OCT2HEX(\"7777777777\",1)"), "FFFFFFFFFF");
}

#[test]
fn student_t_functions_split_the_cumulative_flag_from_the_tails_count() {
    rel("=T.DIST(1,1,TRUE)", 0.75);
    rel("=T.DIST(1,1,FALSE)", 0.15915494309189534);
    rel("=T.DIST(-1,1,TRUE)", 0.25);
    rel("=TDIST(1,1,1)", 0.25);
    rel("=TDIST(1,1,2)", 0.5);
    assert_eq!(error("=TDIST(-1,1,1)"), ErrorValue::Num);
    assert_eq!(error("=TDIST(1,1,3)"), ErrorValue::Num);
    rel("=T.DIST.RT(-1,1)", 0.75);
    assert_eq!(error("=T.DIST.2T(-1,1)"), ErrorValue::Num);
    assert_eq!(error("=T.DIST(1,0,TRUE)"), ErrorValue::Num);
}

#[test]
fn t_test_honours_tails_and_type() {
    rel("=T.TEST(A1:A5,A1:A5,2,2)", 1.0);
    rel("=T.TEST(A1:A5,A1:A5,1,3)", 0.5);
    // Equal variances: t = 0.5 / sqrt((15/7) * 0.45) with 7 degrees of freedom.
    let t = "0.5/SQRT((15/7)*0.45)";
    close(&format!("=T.TEST(A1:A5,A1:A4,2,2)-TDIST({t},7,2)"), 0.0, 1e-12);
    close(&format!("=T.TEST(A1:A5,A1:A4,1,2)-TDIST({t},7,1)"), 0.0, 1e-12);
    assert!((0.0..1.0).contains(&num("=T.TEST(A1:A5,A1:A4,2,3)")));
    assert_eq!(error("=T.TEST(A1:A5,A1:A4,2,1)"), ErrorValue::Na);
    assert_eq!(error("=T.TEST(A1:A5,A1:A5,3,2)"), ErrorValue::Num);
    assert_eq!(error("=T.TEST(A1:A5,A1:A5,2,4)"), ErrorValue::Num);
    assert_eq!(error("=T.TEST(A1:A5,A1:A5,2,1)"), ErrorValue::Div0);
}

#[test]
fn distribution_domains_follow_the_function_pages() {
    rel("=BETA.DIST(0.5,2,2,TRUE)", 0.5);
    for bad in [
        "=BETA.DIST(0.5,0,2,TRUE)",
        "=BETA.DIST(5,2,2,TRUE,0,1)",
        "=BETA.DIST(1,2,2,TRUE,1,1)",
        "=BINOM.DIST(11,10,0.5,TRUE)",
        "=BINOM.DIST(2,4,1.5,FALSE)",
        "=BINOM.DIST.RANGE(10,0.5,3,2)",
        "=BINOM.DIST.RANGE(10,0.5,3,11)",
        "=EXPON.DIST(-1,1,TRUE)",
        "=EXPON.DIST(1,0,TRUE)",
        "=CHISQ.DIST(-1,2,TRUE)",
        "=CHISQ.DIST(2,0,TRUE)",
        "=F.DIST(-1,2,2,TRUE)",
        "=F.DIST(1,0,2,TRUE)",
        "=GAMMA.DIST(-1,2,2,TRUE)",
        "=GAMMA.DIST(1,0,2,TRUE)",
        "=GAMMALN(0)",
        "=GAMMALN.PRECISE(0)",
        "=LOGNORM.DIST(0,0,1,TRUE)",
        "=LOGNORM.DIST(1,0,0,TRUE)",
        "=NEGBINOM.DIST(-1,5,0.25,FALSE)",
        "=NEGBINOM.DIST(1,0,0.25,FALSE)",
        "=NEGBINOM.DIST(1,5,1.5,FALSE)",
        "=NEGBINOM.DIST(1,5,1,FALSE)",
    ] {
        assert_eq!(error(bad), ErrorValue::Num, "{bad}");
    }
    close("=BINOM.DIST(2.9,4.9,0.5,FALSE)", 0.375, 1e-12);
    assert_eq!(num("=GAMMALN.PRECISE(\"2\")"), 0.0); // ln Γ(2) is exactly 0
    rel("=HYPGEOM.DIST(1,4,8,20,FALSE)", 0.36326109391124871);
    rel("=HYPGEOM.DIST(1,4,8,20,TRUE)", 0.46542827657378741);
    rel("=NEGBINOM.DIST(10,5,0.25,FALSE)", 0.05504866037517786);
    assert_eq!(num("=F.DIST.RT(0,2,2)"), 1.0);
}

#[test]
fn the_cumulative_flag_is_required_and_must_be_a_logical_or_a_number() {
    for missing in [
        "=NORM.S.DIST(0)",
        "=NORM.DIST(0,0,1)",
        "=T.DIST(1,1)",
        "=BINOM.DIST(2,4,0.5)",
        "=CHISQ.DIST(1,2)",
        "=EXPON.DIST(1,1)",
        "=F.DIST(1,2,2)",
        "=LOGNORM.DIST(1,0,1)",
        "=HYPGEOM.DIST(1,4,8,20)",
        "=NEGBINOM.DIST(10,5,0.25)",
        "=BETA.DIST(0.5,2,2)",
        "=GAMMA.DIST(1,2,2)",
    ] {
        let got = eval(missing);
        assert!(matches!(got, Ok(Value::Error(ErrorValue::Value) | Value::Error(ErrorValue::Na))), "{missing}: {got:?}");
    }
    for bogus in ["=F.DIST(1,2,2,\"bogus\")", "=NORM.S.DIST(0,\"yes\")", "=BINOM.DIST(2,4,0.5,B1)"] {
        assert_eq!(error(bogus), ErrorValue::Value, "{bogus}");
    }
    rel("=F.DIST(1,2,2,TRUE)", 0.5);
    rel("=F.DIST(1,2,2,1)", 0.5);
    rel("=F.DIST(1,2,2,\"1\")", 0.5);
    rel("=NORM.S.DIST(0,0)", 0.39894228040143268);
    rel("=NORM.S.DIST(0,FALSE)", 0.39894228040143268);
    rel("=NORM.S.DIST(0,TRUE)", 0.5);
    // The flagless legacy signatures keep their own argument lists.
    rel("=HYPGEOMDIST(1,4,8,20)", 0.36326109391124871);
    rel("=NEGBINOMDIST(10,5,0.25)", 0.05504866037517786);
    rel("=NORMSDIST(0)", 0.5);
    assert_eq!(error("=HYPGEOMDIST(1,4,8,20,TRUE)"), ErrorValue::Na);
    assert_eq!(error("=NEGBINOMDIST(10,5,0.25,TRUE)"), ErrorValue::Na);
    assert_eq!(error("=HYPGEOMDIST(1,4,8)"), ErrorValue::Na);
}

#[test]
fn degrees_of_freedom_ceilings_follow_excel() {
    // Excel 16.0 (build 20527), evaluated through COM: 10^10 degrees of freedom is accepted by every chi-square,
    // F and t function, 10^10 + 1 is #NUM! for all of them except CHISQ.INV.RT / CHIINV, which have no ceiling.
    xl_rel("=F.DIST.RT(1,1E10,2)", 0.6321205587917698);
    xl_rel("=FDIST(1,1E10,2)", 0.6321205587917698);
    xl_rel("=FDIST(1,2,1E10)", 0.36787944120823024);
    assert_eq!(num("=F.DIST(0,1E10,2,TRUE)"), 0.0);
    assert_eq!(num("=F.DIST.RT(0,1E10,2)"), 1.0);
    // Excel answers 0.6931472063948522 here, 3.7e-8 above the median of F(2, 1E10) (mpmath: 0.6931471806079906); its own
    // F.INV(0.5,2,1E10) gives 0.69314718060798908. The exact value is expected, not Excel's slip.
    xl_rel("=F.INV.RT(0.5,2,1E10)", 0.6931471806079906);
    xl_rel("=F.INV.RT(0.5,2,9999999999)", 0.6931471806079906);
    xl_rel("=FINV(0.5,2,1E10)", 0.6931471806079906);
    xl_rel("=F.INV.RT(0.5,1E10,2)", 1.4426950407889665);
    // likewise Excel's F.INV(0.5,1E10,2) = 1.4426949871169916 is off; its F.INV.RT above agrees with mpmath
    xl_rel("=F.INV(0.5,1E10,2)", 1.4426950407889634);
    xl_rel("=F.INV(0.5,2,1E10)", 0.6931471806079906);
    assert_eq!(num("=T.DIST.RT(0,1E10)"), 0.5);
    xl_rel("=TDIST(1,1E10,1)", 0.15865525394355556);
    // Excel answers 0.6744895023650482, which is 3.7e-7 low (mpmath root: 0.6744897502206152)
    xl_rel("=TINV(0.5,1E10)", 0.6744897502206152);
    xl_rel("=T.INV.2T(0.5,1E10)", 0.6744897502206152);
    assert_eq!(num("=CHISQ.DIST(1,1E10,TRUE)"), 0.0);
    assert_eq!(num("=CHISQ.DIST.RT(1,1E10)"), 1.0);
    assert_eq!(num("=CHIDIST(1,1E10)"), 1.0);
    xl_rel("=CHISQ.INV(0.5,1E10)", 9999999999.333334);
    xl_rel("=CHISQ.INV.RT(0.5,1E10)", 9999999999.333334);
    xl_rel("=CHIINV(0.5,1E10)", 9999999999.333334);
    xl_rel("=CHIINV(0.5,9999999999)", 9999999998.333334);
    // CHISQ.INV.RT / CHIINV have no ceiling in Excel
    xl_rel("=CHIINV(0.5,10000000001)", 10000000000.333334);
}

#[test]
fn degrees_of_freedom_above_the_ceiling_are_num_errors() {
    for limited in [
        "=CHISQ.DIST(1,10000000001,TRUE)",
        "=CHISQ.DIST.RT(1,10000000001)",
        "=CHISQ.INV(0.5,10000000001)",
        "=CHIDIST(1,10000000001)",
        "=F.DIST(1,1E11,2,TRUE)",
        "=F.DIST(1,2,1E11,TRUE)",
        "=F.DIST(1,10000000001,2,FALSE)",
        "=F.DIST.RT(1,2,10000000001)",
        "=F.INV(0.5,10000000001,2)",
        "=F.INV(0.5,2,1E11)",
        "=F.INV.RT(0.5,10000000001,2)",
        "=F.INV.RT(0.5,1E11,2)",
        "=FDIST(1,10000000001,2)",
        "=FDIST(1,2,10000000001)",
        "=FINV(0.5,10000000001,2)",
        "=FINV(0.5,2,10000000001)",
        "=T.DIST.RT(0,10000000001)",
        "=T.DIST(1,10000000001,TRUE)",
        "=T.DIST.2T(1,10000000001)",
        "=TDIST(1,10000000001,1)",
        "=T.INV(0.9,10000000001)",
        "=TINV(0.5,10000000001)",
        "=T.INV.2T(0.5,1E11)",
        "=BINOM.DIST(5,10000000001,0.5,TRUE)",
    ] {
        assert_eq!(error(limited), ErrorValue::Num, "{limited}");
    }
}

#[test]
fn right_tail_inverses_keep_their_precision_for_tiny_probabilities() {
    // mpmath: 2*log(10**20); the right tail of chi-square with 2 degrees of freedom is exp(-x/2)
    rel("=CHIINV(1E-20,2)", 92.10340371976183);
    rel("=CHISQ.INV.RT(1E-20,2)", 92.10340371976183);
    // mpmath: findroot of gammainc(2, x/2, inf, regularized=True) = 0.05
    rel("=CHISQ.INV.RT(0.05,4)", 9.487729036781158);
    // F(2,2) right tail is 1/(1+x); T(2) two-tail p gives t = sqrt(2)(1-p)/sqrt(p(2-p))
    rel("=F.INV.RT(1E-20,2,2)", 1e20);
    rel("=FINV(1E-20,2,2)", 1e20);
    rel("=T.INV.2T(1E-20,2)", 1e10);
    rel("=TINV(1E-20,2)", 1e10);
    // the closed forms keep their precision down to 1e-300
    rel("=CHISQ.INV.RT(1E-300,2)", 2.0 * 300.0 * std::f64::consts::LN_10);
    rel("=F.INV.RT(1E-300,2,2)", 1e300);
    rel("=CHISQ.DIST.RT(1381.55,2)", (-1381.55_f64 / 2.0).exp());
    // two-tail p = 1 - t/sqrt(2+t^2) = 1e-20 - 1.5e-40 + ...
    rel("=T.DIST.2T(1E10,2)", 1e-20);
}

#[test]
fn tails_with_extreme_degrees_of_freedom_keep_twelve_digits() {
    // mpmath at 50 digits: t tail with d = 1e9 (a continued fraction whose naive form cancels to 1e-8)
    rel("=T.DIST.RT(3,1E9)", 0.0013498980648689578);
    rel("=T.DIST.RT(10,1E9)", 7.619872453045539e-24);
    // mpmath: betainc(1000, 0.01, 0, 0.999, regularized=True)
    rel("=BETA.DIST(0.999,1000,0.01,TRUE)", 0.0022162154994438497);
    // mpmath: gammainc(50, 0, 1, regularized=True) is 2.9e-70-sized; the lower tail of chi-square(100) at 1
    rel("=CHISQ.DIST(1,100,TRUE)", 1.7887765104351365e-80);
    // mpmath: F(30, 1000) right tail at 100
    rel("=F.DIST.RT(100,30,1000)", 1.4468648952916547e-276);
    // a quantile near the median: mpmath root of betainc(5/2, 1/2, ...) for two-tail p = 0.999999, d = 5
    rel("=T.INV.2T(0.999999,5)", 1.3171527621084687e-06);
    // a quantile beyond the double range (about 5e599 here) is an error, never a clipped value; Excel answers
    // 1.848E150 for this one, which is not the quantile
    assert_eq!(error("=F.INV.RT(1E-300,2,1)"), ErrorValue::Num);
}

#[test]
fn chisq_test_of_one_cell_is_not_available_and_error_cells_propagate() {
    // the 1x1 range has no degrees of freedom
    assert_eq!(error("=CHISQ.TEST(A1,A2)"), ErrorValue::Na);
    // Excel: text and blanks in a range are ignored, an error cell in a range is the result
    assert_eq!(error("=Z.TEST(Z1:Z2,2)"), ErrorValue::Div0);
    assert_eq!(error("=F.TEST(A1:A4,Z1:Z2)"), ErrorValue::Div0);
    assert_eq!(error("=T.TEST(A1:A4,Z1:Z4,2,2)"), ErrorValue::Div0);
    assert_eq!(error("=PROB(Z1:Z4,A1:A4,2)"), ErrorValue::Div0);
    assert_eq!(error("=CHISQ.TEST(A1:A2,Z1:Z2)"), ErrorValue::Div0);
}

#[test]
fn t_test_matches_independent_constants() {
    // 1..5 against 1..4, two-tailed.
    rel("=T.TEST(A1:A5,A1:A4,2,2)", 0.6262832660486095);
    rel("=T.TEST(A1:A5,A1:A4,2,3)", 0.6176652970841955);
}

/// Probabilities in column B, a bad column C, a zero-sum column D, and the chi-square example of the
/// CHISQ.TEST page in E1:F3 (observed) and G1:H3 (expected).
struct Cells;

impl Context for Cells {
    fn sheet(&self) -> &str {
        "Sheet1"
    }

    fn value(&mut self, _sheet: &str, reference: &str) -> Result<Value, Failure> {
        let cell = |n: f64| Ok(Value::Number(n));
        match reference {
            "A1" => cell(1.0),
            "A2" => cell(2.0),
            "A3" => cell(3.0),
            "A4" => cell(4.0),
            "B1" => cell(0.1),
            "B2" => cell(0.2),
            "B3" => cell(0.3),
            "B4" => cell(0.4),
            "C1" | "C2" | "C3" => cell(0.5),
            "C4" => cell(-0.5),
            "D1" | "D2" | "D3" | "D4" => cell(0.1),
            "E1" => cell(58.0),
            "F1" => cell(35.0),
            "E2" => cell(11.0),
            "F2" => cell(25.0),
            "E3" => cell(10.0),
            "F3" => cell(23.0),
            "G1" => cell(45.35),
            "H1" => cell(47.65),
            "G2" => cell(17.56),
            "H2" => cell(18.44),
            "G3" => cell(16.09),
            "H3" => cell(16.91),
            _ => Ok(Value::text("")),
        }
    }
}

fn cells(formula: &str) -> Result<Value, Failure> {
    with_local_zone(Tz::UTC, || evaluate_formula(formula, &mut Cells))
}

fn cell_num(formula: &str) -> f64 {
    match cells(formula) {
        Ok(Value::Number(number)) => number,
        other => panic!("{formula}: {other:?}"),
    }
}

fn cell_error(formula: &str) -> ErrorValue {
    match cells(formula) {
        Ok(Value::Error(error)) => error,
        other => panic!("{formula}: {other:?}"),
    }
}

#[test]
fn prob_z_test_f_test_and_chisq_test_follow_their_function_pages() {
    assert!((cell_num("=PROB(A1:A4,B1:B4,2)") - 0.2).abs() < 1e-12);
    assert!((cell_num("=PROB(A1:A4,B1:B4,2,3)") - 0.5).abs() < 1e-12);
    assert_eq!(cell_error("=PROB(A1:A4,B1:B3,2)"), ErrorValue::Na);
    assert_eq!(cell_error("=PROB(A1:A4,C1:C4,2)"), ErrorValue::Num);
    assert_eq!(cell_error("=PROB(A1:A4,D1:D4,2)"), ErrorValue::Num);
    assert_eq!(cell_error("=PROB(A1:A4,B1:B4)"), ErrorValue::Value);
    // Z.TEST: one-tailed, empty array #N/A, an explicit sigma of 0 is a division by zero.
    // mpmath: Φ(-1) and Φ(-0.5/(sd/2)) with sd = sqrt(5/3), not another engine result
    assert!((cell_num("=Z.TEST(A1:A4,2,1)") - 0.15865525393145705).abs() <= 1e-12 * 0.15865525393145705);
    assert!((cell_num("=Z.TEST(A1:A4,2)") - 0.21928901304049993).abs() <= 1e-12 * 0.21928901304049993);
    assert_eq!(cell_error("=Z.TEST(X1:X2,2)"), ErrorValue::Na);
    // Excel: an explicit sigma of 0 or below is #NUM! (probed: Z.TEST(A1:A4,1,0), Z.TEST(A1:A4,1,-1))
    assert_eq!(cell_error("=Z.TEST(A1:A4,2,0)"), ErrorValue::Num);
    // F.TEST: the two-tailed probability, not the variance ratio.
    let p = cell_num("=F.TEST(A1:A4,E1:E3)");
    assert!((0.0..=1.0).contains(&p), "{p}");
    assert!((cell_num("=F.TEST(A1:A4,A1:A4)") - 1.0).abs() < 1e-12);
    assert_eq!(cell_error("=F.TEST(A1:A1,A1:A4)"), ErrorValue::Div0);
    assert_eq!(cell_error("=F.TEST(X1:X2,A1:A4)"), ErrorValue::Div0);
    // CHISQ.TEST: the page's example, #N/A for ranges of different shape.
    // mpmath: statistic 16.169575074796885 on 2 degrees of freedom, gammainc(1, s/2, inf, regularized=True)
    let expected = 0.0003081920170083089;
    assert!((cell_num("=CHISQ.TEST(E1:F3,G1:H3)") - expected).abs() <= 1e-12 * expected);
    assert_eq!(cell_error("=CHISQ.TEST(E1:F3,G1:G3)"), ErrorValue::Na);
}

#[test]
fn hexadecimal_results_are_upper_case_and_either_case_is_accepted() {
    assert_eq!(text("=DEC2HEX(255)"), "FF");
    assert_eq!(text("=DEC2HEX(255,4)"), "00FF");
    assert_eq!(text("=DEC2HEX(-1)"), "FFFFFFFFFF");
    assert_eq!(text("=BIN2HEX(\"11111111\")"), "FF");
    assert_eq!(text("=BIN2HEX(\"1111111111\")"), "FFFFFFFFFF");
    assert_eq!(text("=OCT2HEX(377)"), "FF");
    assert_eq!(text("=OCT2HEX(\"7777777777\")"), "FFFFFFFFFF");
    assert_eq!(num("=HEX2DEC(\"ff\")"), 255.0);
    assert_eq!(num("=HEX2DEC(\"FF\")"), 255.0);
    assert_eq!(text("=HEX2BIN(\"fF\")"), "11111111");
    assert_eq!(text("=HEX2OCT(\"ff\")"), "377");
}

#[test]
fn legacy_names_answer_like_the_function_they_stand_for() {
    assert_eq!(num("=VARP(A1:A5)"), 2.0);
    assert_eq!(num("=VAR(A1:A5)"), 2.5);
    close("=STDEVP(A1:A5)", 2.0_f64.sqrt(), 1e-12);
    assert_eq!(num("=COVAR(A1:A5,A1:A5)"), 2.0);
    assert_eq!(num("=PERCENTRANK(A1:A5,3)"), 0.5);
    assert_eq!(num("=QUARTILE(A1:A5,1)"), 2.0);
    assert_eq!(num("=MODE(1,2,2,3)"), 2.0);
    rel("=CONFIDENCE(0.05,1,100)", 0.19599639845400539);
    close("=POISSON(0,1,FALSE)", (-1.0_f64).exp(), 1e-12);
    close("=WEIBULL(1,1,1,TRUE)", 1.0 - (-1.0_f64).exp(), 1e-12);
    // Legacy functions with their own signature: always cumulative, or right-tailed, or two-tailed.
    rel("=NORMSDIST(1.96)", 0.97500210485177956);
    rel("=LOGNORMDIST(1,0,1)", 0.5);
    rel("=BETADIST(0.5,2,2)", 0.5);
    // mpmath: gammainc(1/2, 3.84/2, inf, regularized=True) and the root of gammainc(1/2, x/2, inf, ...) = 0.05
    rel("=CHIDIST(3.84,1)", 0.0500435212487051);
    rel("=CHIINV(0.05,1)", 3.841458820694126);
    rel("=FDIST(1,5,5)", 0.5);
    rel("=FINV(0.5,5,5)", 1.0);
    // mpmath: root of betainc(5, 1/2, 0, 10/(10+t*t), regularized=True) = 0.05
    rel("=TINV(0.05,10)", 2.228138851986275);
}

/// The worksheet the Excel results below were taken from: A1:A4 = 1..4; C1:C4 = #DIV/0!, #N/A, 5, 7;
/// D1:D4 = 2, #NUM!, 6, 9; E1:E4 = "x", 3, 4, 8; F1:F4 = 1, 2, 3, 5; every other cell blank.
struct ExcelSheet;

impl Context for ExcelSheet {
    fn sheet(&self) -> &str {
        "Sheet1"
    }

    fn value(&mut self, _sheet: &str, reference: &str) -> Result<Value, Failure> {
        let n = |x: f64| Ok(Value::Number(x));
        match reference {
            "A1" => n(1.0),
            "A2" => n(2.0),
            "A3" => n(3.0),
            "A4" => n(4.0),
            "C1" => Ok(Value::Error(ErrorValue::Div0)),
            "C2" => Ok(Value::Error(ErrorValue::Na)),
            "C3" => n(5.0),
            "C4" => n(7.0),
            "D1" => n(2.0),
            "D2" => Ok(Value::Error(ErrorValue::Num)),
            "D3" => n(6.0),
            "D4" => n(9.0),
            "E1" => Ok(Value::text("x")),
            "E2" => n(3.0),
            "E3" => n(4.0),
            "E4" => n(8.0),
            "F1" => n(1.0),
            "F2" => n(2.0),
            "F3" => n(3.0),
            "F4" => n(5.0),
            _ => Ok(Value::text("")),
        }
    }
}

fn xl(formula: &str) -> Result<Value, Failure> {
    with_local_zone(Tz::UTC, || evaluate_formula(formula, &mut ExcelSheet))
}

/// A number from the Excel sheet, to a relative 1e-12.
fn xl_rel(formula: &str, expected: f64) {
    xl_near(formula, expected, 1e-12)
}

/// A number from the Excel sheet to the stated relative tolerance (Excel's own result is not always that exact).
fn xl_near(formula: &str, expected: f64, tolerance: f64) {
    match xl(formula) {
        Ok(Value::Number(got)) => assert!((got - expected).abs() <= tolerance * expected.abs(), "{formula}: {got:e} is not {expected:e}"),
        other => panic!("{formula}: {other:?}"),
    }
}

fn xl_error(formula: &str, expected: ErrorValue) {
    assert_eq!(xl(formula), Ok(Value::Error(expected)), "{formula}");
}

#[test]
fn ranges_follow_excel_for_text_blanks_and_error_cells() {
    // Excel 16.0 (build 20527) through COM. A range's text and blanks are ignored, an error cell is the result with
    // the first range read before the second and the cells in reading order, an error argument is the result.
    xl_rel("=Z.TEST(E1:E4,2)", 0.024767306717813357);
    // Excel and mpmath agree on 1.01727730727e-7; the engine forms 1 - NORM.S.DIST and is good to 1e-9 there
    xl_rel("=Z.TEST(E1:E4,2,1)", 1.017277307272216e-7);
    xl_rel("=F.TEST(E1:E4,F1:F4)", 0.4770566714969556);
    xl_rel("=F.TEST(E2:E4,F1:F2)", 0.3713906763541037);
    xl_rel("=F.TEST(A1:A4,F1:F4)", 0.6571069200056);
    // T.TEST: type 2 and 3 drop the text, the paired type drops a pair when either cell is text
    xl_rel("=T.TEST(E1:E4,F1:F4,2,2)", 0.22579098914800336);
    xl_rel("=T.TEST(E2:E4,F1:F3,2,2)", 0.14006598491201783);
    xl_rel("=T.TEST(E1:E4,F1:F4,2,3)", 0.28285495623824597);
    xl_rel("=T.TEST(E1:E4,F1:F4,2,1)", 0.1296117202215108);
    xl_rel("=T.TEST(E2:E4,F1:F3,2,1)", 0.09546596626670922);
    xl_rel("=T.TEST(A1:A4,F1:F4,2,2)", 0.823098858571037);
}

#[test]
fn chisq_test_leaves_out_pairs_with_text_or_blank_cells() {
    // the degrees of freedom keep the range's shape
    xl_rel("=CHISQ.TEST(A1:A2,A3:A4)", 0.12663045794761724);
    xl_rel("=CHISQ.TEST(A1:B1,A2:B2)", 0.4795001221869535);
    xl_rel("=CHISQ.TEST(E1:E2,F1:F2)", 0.4795001221869535);
    xl_rel("=CHISQ.TEST(E1:E4,F1:F4)", 0.4516757277642599);
    xl_rel("=CHISQ.TEST(E2:E4,F2:F4)", 0.26802723870777256);
    xl_rel("=CHISQ.TEST(E2:E3,F2:F3)", 0.3613104285261788);
    // a single cell has no degrees of freedom
    xl_error("=CHISQ.TEST(A1,A2)", ErrorValue::Na);
    xl_error("=CHISQ.TEST(A1:A1,A2:A2)", ErrorValue::Na);
}

#[test]
fn an_error_cell_or_argument_in_a_statistical_range_is_the_result() {
    for (formula, expected) in [
        ("=CHISQ.TEST(A1:A2,C1:C2)", ErrorValue::Div0),
        ("=CHISQ.TEST(A1:A2,D1:D2)", ErrorValue::Num),
        ("=CHISQ.TEST(C1:C2,D1:D2)", ErrorValue::Div0),
        ("=CHISQ.TEST(D1:D2,C1:C2)", ErrorValue::Num),
        ("=Z.TEST(C1:C4,2)", ErrorValue::Div0),
        ("=Z.TEST(D1:D4,2)", ErrorValue::Num),
        ("=Z.TEST(C1:D4,2)", ErrorValue::Div0),
        ("=Z.TEST(A1:A4,C1)", ErrorValue::Div0),
        ("=Z.TEST(A1:A4,2,D2)", ErrorValue::Num),
        ("=Z.TEST(A1:A4,C1,D2)", ErrorValue::Div0),
        ("=F.TEST(C1:C4,A1:A4)", ErrorValue::Div0),
        ("=F.TEST(A1:A4,C1:C4)", ErrorValue::Div0),
        ("=F.TEST(C1:C4,D1:D4)", ErrorValue::Div0),
        ("=F.TEST(D1:D4,C1:C4)", ErrorValue::Num),
        ("=T.TEST(C1:C4,A1:A4,2,2)", ErrorValue::Div0),
        ("=T.TEST(A1:A4,C1:C4,2,2)", ErrorValue::Div0),
        ("=T.TEST(C1:C4,D1:D4,2,2)", ErrorValue::Div0),
        ("=T.TEST(D1:D4,C1:C4,2,2)", ErrorValue::Num),
        ("=T.TEST(A1:A4,F1:F4,C1,2)", ErrorValue::Div0),
        ("=T.TEST(A1:A4,F1:F4,2,C1)", ErrorValue::Div0),
        ("=PROB(C1:C4,A1:A4,2)", ErrorValue::Div0),
        ("=PROB(A1:A4,C1:C4,2)", ErrorValue::Div0),
        ("=PROB(D1:D4,C1:C4,2)", ErrorValue::Num),
        ("=PROB(C1:C4,D1:D4,2)", ErrorValue::Div0),
        ("=T.DIST(C1,5,TRUE)", ErrorValue::Div0),
        ("=T.DIST(2,C1,TRUE)", ErrorValue::Div0),
        ("=BINOM.DIST(C1,10,0.5,TRUE)", ErrorValue::Div0),
        ("=BINOM.DIST(2,10,0.5,C1)", ErrorValue::Div0),
        ("=NORM.DIST(C1,0,1,TRUE)", ErrorValue::Div0),
        ("=CHISQ.DIST(C2,2,TRUE)", ErrorValue::Na),
        ("=F.INV(C1,2,2)", ErrorValue::Div0),
    ] {
        xl_error(formula, expected);
    }
}

#[test]
fn extreme_quantiles_and_tails_follow_excel() {
    // Excel 16.0 (build 20527) through COM; the quantile is whatever fits a double, nothing is clipped.
    xl_rel("=T.INV.2T(1E-300,1)", 6.366197723675814e+299);
    xl_rel("=TINV(1E-300,1)", 6.366197723675814e+299);
    xl_rel("=T.INV.2T(1E-200,1)", 6.366197723675814e+199);
    xl_rel("=T.INV.2T(1E-307,1)", 6.366197723675814e+306);
    xl_rel("=T.INV.2T(1E-300,2)", 1.0000000000000156e+150);
    xl_rel("=T.INV.2T(1E-305,2)", 3.162277660168533e+152);
    xl_rel("=T.INV.2T(1E-305,3)", 6.041668820269218e+101);
    xl_rel("=T.INV(1E-300,1)", -3.183098861837907e+299);
    xl_rel("=T.INV(1E-307,1)", -3.183098861837907e+306);
    xl_rel("=F.INV.RT(1E-300,2,2)", 9.999999999999764e+299);
    xl_rel("=F.INV.RT(1E-100,2,1)", 5.0000000000001095e+199);
    xl_rel("=F.INV(1-1E-15,1,1)", 4.059333823527306e+29);
    xl_rel("=CHISQ.INV.RT(1E-300,2)", 1381.5510557964274);
    xl_rel("=CHISQ.INV(1E-300,3)", 2.4179879310247905e-200);
    xl_rel("=CHISQ.INV(1E-200,100)", 0.003896799715517671);
    // a lower-tail root below the smallest double is 0
    assert_eq!(num("=CHISQ.INV(1E-300,1)"), 0.0);
    // t tails: x is accepted while x*x is finite
    xl_rel("=T.DIST.RT(1E150,1)", 3.183098861837907e-151);
    xl_rel("=T.DIST.RT(1E153,1)", 3.183098861837907e-154);
    xl_rel("=T.DIST.2T(1E150,1)", 6.366197723675813e-151);
    xl_rel("=T.DIST.RT(10,1E9)", 7.619872453045571e-24);
    xl_rel("=T.DIST.RT(3,1E9)", 0.0013498980648689591);
    xl_rel("=T.DIST(1E150,1,FALSE)", 3.1830988618379073e-301);
    assert_eq!(num("=T.DIST.RT(1E152,5)"), 0.0);
    for bad in ["=T.DIST.RT(1.35E154,1)", "=T.DIST.2T(1E300,1)", "=T.DIST(-1.4E154,1,TRUE)", "=T.DIST(1.4E154,1,FALSE)", "=TDIST(1.4E154,1,2)"] {
        assert_eq!(error(bad), ErrorValue::Num, "{bad}");
    }
    // binomial: no rounding to 1e-10
    xl_rel("=BINOM.DIST(3,100,0.5,TRUE)", 1.315433448065097e-25);
    xl_rel("=BINOM.DIST(0,100,0.5,TRUE)", 7.888609052210105e-31);
    xl_rel("=BINOM.DIST(50,100,0.5,TRUE)", 0.5397946186935894);
    xl_rel("=BINOM.DIST(10,1000,0.5,TRUE)", 2.4833387914897154e-278);
    xl_rel("=BINOM.DIST(9,10,0.5,TRUE)", 0.9990234375);
    for (formula, expected) in [
        ("=BINOM.INV(100,0.5,0.4)", 49.0),
        ("=BINOM.INV(100,0.5,1E-12)", 16.0),
        ("=BINOM.INV(100,0.5,1E-20)", 7.0),
        ("=BINOM.INV(100,0.5,0.9999999999)", 81.0),
        ("=BINOM.INV(1000,0.5,1E-30)", 321.0),
    ] {
        assert_eq!(num(formula), expected, "{formula}");
    }
    xl_rel("=BETA.INV(0.5,2,3)", 0.3857275681323895);
}

#[test]
fn every_registered_distribution_name_answers_like_its_function() {
    // Excel 16.0 (build 20527) values for the functions that were only exercised through the recordings; the
    // normal-distribution kernels are good to about 1e-9, the rest to 1e-12.
    // GAMMA and GAMMALN still use the jStat Lanczos fit, good to about 3e-9 relative
    xl_rel("=GAMMA(2.5)", 1.329340388179137);
    xl_rel("=GAUSS(1)", 0.34134474606854295);
    xl_rel("=PHI(1)", 0.24197072451914335);
    xl_rel("=BINOM.DIST.RANGE(10,0.5,3,5)", 0.568359375);
    xl_rel("=GAMMA.INV(0.5,3,2)", 5.348120627447122);
    xl_rel("=GAMMA.DIST(4,3,2,TRUE)", 0.3233235838169366);
    xl_rel("=POISSON.DIST(3,2,TRUE)", 0.8571234604985469);
    xl_rel("=LOGNORM.INV(0.3,0.5,1.2)", 0.87872734665093635);
    xl_rel("=EXPON.DIST(2,0.5,TRUE)", 0.6321205588285577);
    xl_rel("=WEIBULL.DIST(2,1.5,3,TRUE)", 0.41977020402532705);
    xl_rel("=GAMMALN.PRECISE(4.5)", 2.4537365708424422);
    // every alias is the same function as its modern name
    for (alias, canonical, args) in [
        ("BINOMDIST", "BINOM.DIST", "3,10,0.4,TRUE"),
        ("BINOMDIST.RANGE", "BINOM.DIST.RANGE", "10,0.5,3,5"),
        ("CHIDIST.RT", "CHISQ.DIST.RT", "3.5,4"),
        ("CHIDISTRT", "CHISQ.DIST.RT", "3.5,4"),
        ("CHIINV.RT", "CHISQ.INV.RT", "0.2,4"),
        ("CHIINVRT", "CHISQ.INV.RT", "0.2,4"),
        ("CHITEST", "CHISQ.TEST", "A1:A2,A3:A4"),
        ("EXPONDIST", "EXPON.DIST", "2,0.5,TRUE"),
        ("FDIST.RT", "F.DIST.RT", "2.5,4,6"),
        ("FDISTRT", "F.DIST.RT", "2.5,4,6"),
        ("FINV.RT", "F.INV.RT", "0.2,4,6"),
        ("FINVRT", "F.INV.RT", "0.2,4,6"),
        ("FTEST", "F.TEST", "A1:A4,F1:F4"),
        ("GAMMADIST", "GAMMA.DIST", "4,3,2,TRUE"),
        ("GAMMAINV", "GAMMA.INV", "0.5,3,2"),
        ("GAMMALNPRECISE", "GAMMALN.PRECISE", "4.5"),
        ("LOGNORMINV", "LOGNORM.INV", "0.3,0.5,1.2"),
        ("NORMDIST", "NORM.DIST", "1,0,1,TRUE"),
        ("POISSONDIST", "POISSON.DIST", "3,2,TRUE"),
        ("TDIST.2T", "T.DIST.2T", "1.5,6"),
        ("TDIST.RT", "T.DIST.RT", "1.5,6"),
        ("TDISTRT", "T.DIST.RT", "1.5,6"),
        ("TINV.2T", "T.INV.2T", "0.2,6"),
        ("TTEST", "T.TEST", "A1:A4,F1:F4,2,3"),
        ("WEIBULLDIST", "WEIBULL.DIST", "2,1.5,3,TRUE"),
        ("ZTEST", "Z.TEST", "A1:A4,2,1"),
    ] {
        assert_eq!(xl(&format!("={alias}({args})")), xl(&format!("={canonical}({args})")), "{alias}");
    }
}

#[test]
fn binomial_range_and_inverse_terminate_and_follow_excel_limits() {
    // Excel answers #NUM! from 2147483647 trials upward (2147483646 answers); the engine must also return, not loop.
    for f in ["=BINOM.DIST.RANGE(1E16,0.5,1E16,1E16)", "=BINOM.DIST.RANGE(2147483647,0.5,5,5)", "=BINOM.INV(1E16,0.5,0.5)", "=BINOM.INV(2147483647,0.5,0.5)"] {
        assert_eq!(error(f), ErrorValue::Num, "{f}");
    }
    assert_eq!(num("=BINOM.INV(2147483646,0.5,0.5)"), 1073741823.0); // Excel
    // mpmath, exact sums of the masses (the tails of 2000 fair trials, 1100..1300 and its mirror 700..900, are equal)
    rel("=BINOM.DIST.RANGE(2000,0.5,1100,1300)", 4.2285447677519636e-6);
    rel("=BINOM.DIST.RANGE(2000,0.5,700,900)", 4.2285447677519636e-6);
    rel("=BINOM.DIST.RANGE(2000,0.5,900,1100)", 0.99999314383283998906);
    assert_eq!(num("=BINOM.INV(2000,0.5,0.3)"), 988.0);
    assert_eq!(num("=BINOM.INV(2000,0.3,1E-10)"), 473.0);
    assert_eq!(num("=BINOM.INV(2000,0.3,0.999999)"), 699.0);
    assert_eq!(num("=BINOM.INV(2000,0.5,0.5)"), 1000.0);
}

#[test]
fn quantiles_reach_the_top_of_the_double_range() {
    // Gamma(1, 1E308): Q = exp(-x/b), so the 0.75 quantile is 1E308 * ln 4 (mpmath: 1.386294361119890618834e308).
    rel("=GAMMA.INV(0.75,1,1E308)", 1.3862943611198906e308);
    // chi-square(2) has the same law with scale 2
    rel("=CHISQ.INV(0.75,2)", 2.772588722239781);
}

#[test]
fn beta_with_tiny_shapes_keeps_the_small_tail() {
    // mpmath.betainc at 150 digits; the old code returned 1 - q = 0 or 1.1e-20 for the first
    rel("=BETA.DIST(0.9,1,1E-20,TRUE)", 2.3025850929940459e-20);
    rel("=BETA.DIST(0.9,2.5,1E-300,TRUE)", 1.170316343532798e-300);
    rel("=BETA.DIST(0.99,5,1E-5,TRUE)", 2.5615121036032401e-5);
    rel("=BETA.DIST(0.7,0.001,0.001,TRUE)", 0.50042303786032353);
}

#[test]
fn densities_and_masses_are_rebuilt_without_overflow_or_cancellation() {
    // every reference: mpmath at 120 digits from the closed form (loggamma) of the density or mass, rounded to f64
    for (f, want) in [
        ("=POISSON.DIST(1000,1000,FALSE)", 0.0126146113487215),
        ("=POISSON.DIST(1E9,1E9,FALSE)", 1.2615662609049495e-5),
        ("=POISSON.DIST(1E12,1E12,FALSE)", 3.9894228040139943e-7),
        ("=POISSON.DIST(50,3,FALSE)", 1.1751800705454761e-42),
        ("=POISSON.DIST(12,30,FALSE)", 0.00010382062415205693),
        ("=BINOM.DIST(1000,2000,0.5,FALSE)", 0.017839011145854321),
        ("=BINOM.DIST(1E9,2E9,0.5,FALSE)", 1.7841241159297556e-5),
        ("=BINOM.DIST(3,1E6,1E-6,FALSE)", 0.061313209538546197),
        ("=BINOM.DIST(15,40,0.3,FALSE)", 0.077405104153787636),
        ("=BINOM.DIST(0,1E9,1E-9,FALSE)", 0.36787944098750258),
        ("=BINOM.DIST(999,1000,0.9,FALSE)", 1.9420791685807714e-44),
        ("=BINOM.DIST(500,1E4,0.01,FALSE)", 8.6613772079345013e-182),
        ("=T.DIST(0,1E10,FALSE)", 0.39894228039145912),
        ("=T.DIST(1,1E10,FALSE)", 0.24197072450704481),
        ("=T.DIST(1E10,3,FALSE)", 3.3079733725307523e-40),
        ("=T.DIST(0.5,30,FALSE)", 0.34787857969720454),
        ("=T.DIST(3,2,FALSE)", 0.027410122234342148),
        ("=T.DIST(100,5,FALSE)", 4.7379731090455337e-11),
        ("=T.DIST(8,1E6,FALSE)", 5.0572839430647417e-15),
        ("=GAMMA.DIST(1E6,1E6,1,FALSE)", 0.00039894224715624403),
        ("=GAMMA.DIST(3,2.5,2,FALSE)", 0.15418032980376928),
        ("=CHISQ.DIST(3,5,FALSE)", 0.15418032980376928),
        ("=CHISQ.DIST(1E9,1E9,FALSE)", 8.9206205792770855e-6),
        ("=F.DIST(1,1000,1000,FALSE)", 6.3062545445902005),
        ("=F.DIST(0.5,3,7,FALSE)", 0.61235813027721281),
        ("=F.DIST(2,1,2,FALSE)", 0.088388347648318441),
        ("=BETA.DIST(0.5,1000,1000,FALSE)", 35.678022291708641),
        ("=BETA.DIST(5,2,3,FALSE,0,10)", 0.15),
        ("=BETA.DIST(5,1,1,FALSE,0,10)", 0.1),
        ("=BETA.DIST(0.9,30,2,FALSE)", 4.3804196884390077),
        ("=NEGBINOM.DIST(1000,500,0.3,FALSE)", 0.00014887397415914648),
        ("=NEGBINOM.DIST(5,3,0.4,FALSE)", 0.10450944),
        ("=NEGBINOM.DIST(0,5,0.5,FALSE)", 0.03125),
        ("=NEGBINOM.DIST(1E6,500,0.0005,FALSE)", 8.9163476046269017e-6),
        ("=NORM.DIST(1,0,1,FALSE)", 0.24197072451914335),
        ("=NORM.DIST(40,0,1,FALSE)", 0.0),
        ("=NORM.S.DIST(1,FALSE)", 0.24197072451914335),
        ("=PHI(1)", 0.24197072451914335),
        ("=LOGNORM.DIST(1,0,1,FALSE)", 0.39894228040143268),
        ("=LOGNORM.DIST(2.5,0.3,0.4,FALSE)", 0.12174116150928863),
        ("=WEIBULL.DIST(2,1.5,3,FALSE)", 0.23687782228285621),
        ("=EXPON.DIST(0.5,3,FALSE)", 0.66939048044528949),
    ] {
        if want == 0.0 {
            assert_eq!(num(f), 0.0, "{f}"); // true value 1.46e-348 is below the double range
        } else {
            rel(f, want);
        }
    }
}

#[test]
fn large_shapes_reach_the_transition_region_and_the_inverses() {
    // references: mpmath findroot on the Temme expansion at 60 digits (the expansion matches mpmath.gammainc to 1e-17
    // wherever mpmath can still evaluate it, a <= 1e6); Excel answers #NUM! or is off beyond 1e10 degrees of freedom
    for (f, want) in [
        ("=GAMMA.INV(0.1,100000000000,1)", 99999594738.025518),
        ("=GAMMA.INV(0.5,100000000000,1)", 99999999999.666667),
        ("=GAMMA.INV(0.9,100000000000,1)", 100000405262.40273),
        ("=GAMMA.INV(0.1,1E13,1)", 9999995947378.328),
        ("=GAMMA.INV(0.5,1E13,1)", 9999999999999.6667),
        ("=GAMMA.INV(0.9,1E13,1)", 10000004052622.1),
        ("=GAMMA.INV(0.1,1E15,1)", 999999959473781.35),
        ("=GAMMA.INV(0.5,1E15,1)", 999999999999999.67),
        ("=GAMMA.INV(0.9,1E15,1)", 1000000040526219.1),
        // chi-square with 2a degrees of freedom is Gamma(a, 2)
        ("=CHISQ.INV.RT(0.5,2E11)", 2.0 * 99999999999.666667),
        ("=CHIINV(0.9,2E15)", 2.0 * 999999959473781.35), // right tail 0.9 is the left quantile 0.1
    ] {
        rel(f, want);
    }
}

#[test]
fn gamma_and_normal_functions_are_accurate_in_their_hard_regions() {
    // mpmath at 100 digits. Near the zeros of ln Γ at 1 and 2 the relative precision of the old Lanczos fit was lost.
    for (f, want) in [
        ("=GAMMA(2.5)", 1.329340388179137),
        ("=GAMMA(1.0000001)", 0.99999994227844337),
        ("=GAMMA(0.9999999)", 1.0000000577215764),
        ("=GAMMA(2.0000001)", 1.0000000422784376),
        ("=GAMMA(1.9999999)", 0.99999995772157061),
        ("=GAMMA(171.62)", 1.7576826789978127e308),
        ("=GAMMA(170.5)", 5.5620924145599996e305),
        ("=GAMMA(-0.5)", -3.5449077018110321),
        ("=GAMMA(-30.5)", -2.1357974436941746e-33),
        ("=GAMMA(-100.3)", -1.0431432495783089e-158),
        ("=GAMMA(-170.5)", -3.3127395215386073e-308),
        ("=GAMMA(-2.7)", -0.93108278483896397),
        ("=GAMMA(1E-300)", 1e300),
        ("=GAMMA(-1E-300)", -1e300),
        ("=GAMMA(-0.0000001)", -10000000.577215764),
        ("=GAMMA(7.7)", 2769.8303623273146),
        ("=GAMMA(100.25)", 2.94846628183877e156),
        ("=GAMMALN(1.0000001)", -5.7721558299185071e-8),
        ("=GAMMALN(0.9999999)", 5.7721574684441928e-8),
        ("=GAMMALN(2.0000001)", 4.2278436665324979e-8),
        ("=GAMMALN(1.9999999)", -4.2278430309861298e-8),
        ("=GAMMALN.PRECISE(1.0000001)", -5.7721558299185071e-8),
        ("=GAMMALN(1E-300)", 690.77552789821371),
        ("=GAMMALN(1E10)", 220258509288.81058),
        ("=GAMMALN(1E300)", 6.8977552789821371e302),
        ("=GAMMALN(1.25)", -0.098271836421813161),
        ("=GAMMALN(171.7)", 710.17161294037501),
        // quantile from the tail it is in
        ("=NORM.S.INV(1E-300)", -37.047096299361199),
        ("=NORM.S.INV(1E-100)", -21.273453560965324),
        ("=NORM.S.INV(1E-20)", -9.2623400897984076),
        ("=NORM.S.INV(0.01)", -2.3263478740408411),
        ("=NORM.S.INV(0.975)", 1.9599639845400539),
        ("=NORM.S.INV(0.999999)", 4.7534243088170878),
        ("=NORM.INV(0.3,10,2)", 10.0 - 2.0 * 0.52440051270804082),
        ("=LOGNORM.INV(1E-10,0,1)", 0.0017270493538983824),
        // cumulative from erfc, never 1 - cdf
        ("=NORM.S.DIST(-37,TRUE)", 5.7255712225245768e-300),
        ("=NORM.S.DIST(-10,TRUE)", 7.6198530241605261e-24),
        ("=NORM.S.DIST(-1,TRUE)", 0.15865525393145705),
        ("=NORM.S.DIST(3,TRUE)", 0.99865010196836991),
        ("=NORMSDIST(0.5)", 0.6914624612740131),
        ("=GAUSS(0.001)", 0.00039894221391106258),
        ("=GAUSS(1)", 0.34134474606854295),
    ] {
        rel(f, want);
    }
}

#[test]
fn gauss_of_a_tiny_argument_is_exact_where_excel_is_off() {
    // Excel's GAUSS(1E-10) = 3.9894310077670525E-11 is off by 2e-6
    rel("=GAUSS(1E-10)", 3.9894228040143268e-11);
}

#[test]
fn z_test_tail_far_from_the_mean_is_not_negative() {
    // 1 - NORM.S.DIST(8.2) would be 1.1e-16 + noise; the tail comes from erfc
    assert!(num("=Z.TEST(A1:A5,0,0.1)") >= 0.0);
}

#[test]
fn gamma_domain_errors_are_num() {
    assert_eq!(error("=GAMMA(0)"), ErrorValue::Num);
    assert_eq!(error("=GAMMA(-3)"), ErrorValue::Num);
    assert_eq!(error("=GAMMA(171.7)"), ErrorValue::Num); // Excel: #NUM! (result beyond the double range)
    assert_eq!(error("=GAMMA(1E300)"), ErrorValue::Num);
    assert_eq!(error("=GAMMALN(0)"), ErrorValue::Num);
}

#[test]
fn competing_errors_follow_excels_left_to_right_order() {
    // every row probed in Excel 16.0 build 20527 on the ExcelSheet workbook (A1:A4 = 1..4; C = #DIV/0!, #N/A, 5, 7;
    // D = 2, #NUM!, 6, 9): the first argument, left to right, that is an error or cannot be coerced decides, before any
    // domain check; the legacy names and aliases answer like the modern ones
    use ErrorValue::{Div0, Na, Num, Value as Val};
    let mut wrong = Vec::new();
    for (f, want) in [
        ("=BINOM.DIST(1/0,10,0.5,NA())", Div0),
        ("=BINOM.DIST(NA(),1/0,0.5,TRUE)", Na),
        ("=BINOM.DIST(5,10,NA(),1/0)", Na),
        ("=BINOM.DIST(1/0,NA(),SQRT(-1),TRUE)", Div0),
        ("=BINOM.DIST(-1,NA(),0.5,TRUE)", Na),
        ("=BINOM.DIST(-1,10,0.5,NA())", Na),
        ("=BINOM.DIST(-1,10,0.5,\"abc\")", Val),
        ("=BINOM.DIST(1/0,10,0.5,\"abc\")", Div0),
        ("=BINOM.DIST(\"x\",10,0.5,NA())", Val),
        ("=BINOMDIST(1/0,10,0.5,NA())", Div0),
        ("=NORM.DIST(1/0,NA(),1,TRUE)", Div0),
        ("=NORM.DIST(NA(),1,0,TRUE)", Na),
        ("=NORM.DIST(1,1,0,NA())", Na),
        ("=NORMDIST(1/0,NA(),1,TRUE)", Div0),
        ("=NORM.DIST(1/0,0,1,\"abc\")", Div0),
        ("=POISSON.DIST(1/0,NA(),NA())", Div0),
        ("=POISSON.DIST(-1,NA(),TRUE)", Na),
        ("=CHISQ.INV.RT(2,NA())", Na),
        ("=CHISQ.INV.RT(2,1/0)", Div0),
        ("=CHIINV(2,NA())", Na),
        ("=CHISQ.INV.RT(0.5,0)", Num),
        ("=CHISQ.INV(2,NA())", Na),
        ("=CHISQ.DIST(-1,NA(),TRUE)", Na),
        ("=CHISQ.DIST(-1,1,NA())", Na),
        ("=CHISQ.DIST.RT(-1,NA())", Na),
        ("=CHIDIST(-1,NA())", Na),
        ("=T.DIST(NA(),1/0,TRUE)", Na),
        ("=T.DIST(1,1/0,NA())", Div0),
        ("=T.DIST(1,0,NA())", Na),
        ("=T.DIST.2T(-1,NA())", Na),
        ("=F.DIST(1/0,NA(),SQRT(-1),NA())", Div0),
        ("=F.DIST(1,NA(),SQRT(-1),TRUE)", Na),
        ("=GAMMA.DIST(1/0,NA(),SQRT(-1),NA())", Div0),
        ("=BETA.DIST(1/0,NA(),SQRT(-1),NA())", Div0),
        ("=BETA.DIST(2,NA(),1,TRUE)", Na),
        ("=BETA.DIST(1,1,1,TRUE,1/0)", Div0),
        ("=BETA.DIST(1,1,1,TRUE,2,2)", Num),
        ("=BETA.DIST(1,1,1,TRUE,NA(),1/0)", Na),
        ("=WEIBULL.DIST(1/0,NA(),1,NA())", Div0),
        ("=WEIBULL.DIST(-1,NA(),1,TRUE)", Na),
        ("=EXPON.DIST(1/0,NA(),NA())", Div0),
        ("=EXPON.DIST(-1,NA(),TRUE)", Na),
        ("=LOGNORM.DIST(0,NA(),1,TRUE)", Na),
        ("=NEGBINOM.DIST(1/0,NA(),0.5,NA())", Div0),
        ("=HYPGEOM.DIST(1/0,NA(),1,1,NA())", Div0),
        ("=HYPGEOM.DIST(-1,NA(),1,1,TRUE)", Na),
        ("=BINOM.INV(1/0,NA(),0.5)", Div0),
        ("=BINOM.INV(-1,NA(),0.5)", Na),
        ("=BINOM.DIST.RANGE(1/0,NA(),1,1)", Div0),
        ("=BINOM.DIST.RANGE(-1,NA(),1,1)", Na),
        ("=NORM.INV(NA(),1/0,0)", Na),
        ("=NORM.INV(2,NA(),1)", Na),
        ("=NORM.S.DIST(1/0,NA())", Div0),
        ("=GAUSS(1/0)", Div0),
        ("=NORMSDIST(1/0)", Div0),
        ("=T.INV(NA(),0)", Na),
        ("=T.INV(2,NA())", Na),
        ("=GAMMA.INV(2,NA(),1/0)", Na),
        ("=BETA.INV(2,NA(),1)", Na),
        ("=F.INV.RT(2,NA(),1)", Na),
        ("=F.INV.RT(0.5,NA(),0)", Na),
        ("=F.INV.RT(0.5,0,NA())", Na),
        ("=F.INV(0.5,0,NA())", Na),
        ("=LOGNORM.INV(NA(),0,0)", Na),
        ("=NORMSINV(2)", Num),
        // Z.TEST: array errors, x, sigma in that order, and only then the empty array
        ("=Z.TEST(K1:K3,1/0)", Div0),
        ("=Z.TEST(K1:K3,NA())", Na),
        ("=Z.TEST(K1:K3,1,1/0)", Div0),
        ("=Z.TEST(A1:A4,1/0,NA())", Div0),
        ("=Z.TEST(A1:A4,NA(),1/0)", Na),
        ("=Z.TEST(C1:C4,1,1)", Div0),
        ("=Z.TEST(K1:K3,1,1)", Na),
        ("=Z.TEST(A1:A4,1,0)", Num),
        ("=Z.TEST(A1:A4,1,-1)", Num),
        ("=Z.TEST(A1:A4,1/0,0)", Div0),
        ("=Z.TEST(A1:A1,1)", Div0),
        ("=Z.TEST(A1:A1,NA())", Na),
        // CHISQ.TEST: unequal shapes are #N/A before the cells are read for errors
        ("=CHISQ.TEST(A1:A4,C1:C2)", Na),
        ("=CHISQ.TEST(D1:D4,A1:A2)", Na),
        ("=CHISQ.TEST(A1:A2,D1:D4)", Na),
        ("=CHISQ.TEST(A1:A4,C1:C4)", Div0),
        ("=CHISQ.TEST(D1:D4,A1:A4)", Num),
        ("=CHISQ.TEST(A1:A4,D1:D4)", Num),
        ("=CHISQ.TEST(A1:A1,A1:A1)", Na),
        // F.TEST, T.TEST, PROB
        ("=F.TEST(C1:C4,A1:A4)", Div0),
        ("=F.TEST(D1:D4,K1:K3)", Num),
        ("=F.TEST(K1:K3,D1:D4)", Num),
        ("=T.TEST(C1:C4,A1:A4,1/0,2)", Div0),
        ("=T.TEST(A1:A4,A1:A3,NA(),2)", Na),
        ("=T.TEST(D1:D4,A1:A4,5,2)", Num),
        ("=PROB(A1:A4,D1:D4,1)", Num),
        ("=PROB(A1:A4,A1:A3,1)", Na),
        ("=PROB(C1:C4,A1:A4,1)", Div0),
        ("=PROB(A1:A4,A1:A4,NA())", Na),
    ] {
        if xl(f) != Ok(Value::Error(want)) {
            wrong.push(format!("{f}: {:?} want {want:?}", xl(f)));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn departures_from_excel_are_pinned_with_their_reason() {
    use ErrorValue::{Div0, Num};
    // Excel's F.INV.RT(0.5,2,1E10) = 0.6931472063948522 is 3.7e-8 off at huge degrees of freedom: the exact value
    // (mpmath, F(2, 1E10) median) is returned
    rel("=F.INV.RT(0.5,2,1E10)", 0.6931471806079906);
    // the root of F.INV.RT(1E-300,2,1) is about 5e599, beyond the double range: #NUM!
    assert_eq!(error("=F.INV.RT(1E-300,2,1)"), Num);
    // P(T > 1.2E154) at one degree of freedom is atan(1/t)/pi = 2.6525823848649223E-155 (mpmath): kept, not 0
    rel("=T.DIST.RT(1.2E154,1)", 2.6525823848649223e-155);
    // the error type for a subnormal probability follows Excel: #DIV/0! at one degree of freedom, #NUM! from two on, for
    // a one-tail probability below 2.22507385850721E-308 (T.INV p, T.INV.2T and TINV p/2); at and above it, answers
    for (f, want) in [
        ("=T.INV(0,1)", Div0),
        ("=T.INV(1E-308,1)", Div0),
        ("=T.INV(2.2250738585072019E-308,1)", Div0),
        ("=T.INV(1E-308,3)", Num),
        ("=T.INV(2.2250738585072019E-308,3)", Num),
        ("=T.INV(0,3)", Num),
        ("=T.INV.2T(4E-308,1)", Div0),
        ("=T.INV.2T(2.3E-308,1)", Div0),
        ("=T.INV.2T(4.45E-308,2)", Num),
        ("=TINV(2.3E-308,1)", Div0),
        ("=TINV(0,1)", Div0),
        ("=T.INV(-1,1)", Num),
        ("=T.INV(1,1)", Num),
    ] {
        assert_eq!(error(f), want, "{f}");
    }
    // answers just above the boundary (mpmath: -cot(pi p) at one degree, the quantile root at three)
    rel("=T.INV(2.226E-308,1)", -1.4299635497924109e307);
    rel("=T.INV(2.3E-308,1)", -1.3839560268860464e307);
    rel("=T.INV(2.226E-308,3)", -3.6725850621834596e102);
    rel("=T.INV(2.3E-308,3)", -3.6327677889441078e102);
    rel("=T.INV.2T(4.5E-308,1)", 1.4147106052612919e307);
    rel("=TINV(5E-308,1)", 1.2732395447351627e307);
}

#[test]
fn hypergeometric_mass_and_cumulative_match_exact_binomial_arithmetic() {
    // references: exact integer binomials in mpmath (the old code overflowed COMBIN and lost digits in the quotient)
    for (f, want) in [
        ("=HYPGEOM.DIST(5,10,20,50,FALSE)", 0.21508500718492517),
        ("=HYPGEOM.DIST(500,1000,2000,5000,FALSE)", 2.0521748302545805e-13),
        ("=HYPGEOM.DIST(5000,10000,100000,200000,FALSE)", 0.0081859176794066453),
        ("=HYPGEOM.DIST(3,5,7,30,FALSE)", 0.062137734551527655),
        ("=HYPGEOM.DIST(0,100,50,10000,FALSE)", 0.60425542235671083),
        ("=HYPGEOM.DIST(99,100,5000,10000,FALSE)", 4.8814158416936092e-29),
        ("=HYPGEOM.DIST(30,60,100,300,FALSE)", 0.0013308393259110203),
        ("=HYPGEOMDIST(5,1000,1000,100000)", 0.037072985613616017),
        ("=HYPGEOM.DIST(5,10,20,50,TRUE)", 0.86011189706713326),
        ("=HYPGEOM.DIST(480,1000,2000,5000,TRUE)", 0.99999999611800485),
        ("=HYPGEOM.DIST(2,5,7,30,TRUE)", 0.93206601827291482),
        ("=HYPGEOM.DIST(4950,10000,100000,200000,TRUE)", 0.15488165414633678),
    ] {
        rel(f, want);
    }
}

/// X1:X4 = 1..4 and P1:P4 = 0.1, 0.2, 0.3, 0.4, for PROB.
struct ProbSheet;

impl Context for ProbSheet {
    fn sheet(&self) -> &str {
        "Sheet1"
    }

    fn value(&mut self, _sheet: &str, reference: &str) -> Result<Value, Failure> {
        let at = |s: &str| s[1..].parse::<f64>().unwrap();
        Ok(match reference {
            r if r.starts_with('X') => Value::Number(at(r)),
            r if r.starts_with('P') => Value::Number(at(r) / 10.0),
            _ => Value::text(""),
        })
    }
}

/// One case per registered name, each value from mpmath at 80 digits (closed forms, regularized incomplete
/// functions, findroot on them for the inverses, exact integer binomials), rounded to f64.
fn accuracy_cases() -> [(&'static str, &'static str, f64); 85] {
    [
        ("BETA.DIST", "=BETA.DIST(0.4,2,3,TRUE)", 0.52480000000000004),
        ("BETADIST", "=BETADIST(0.4,2,3)", 0.52480000000000004),
        ("BETA.INV", "=BETA.INV(0.3,2,3)", 0.27238394207510534),
        ("BETAINV", "=BETAINV(0.3,2,3)", 0.27238394207510534),
        ("BINOM.DIST", "=BINOM.DIST(5,10,0.3,TRUE)", 0.95265101260000001),
        ("BINOMDIST", "=BINOMDIST(5,10,0.3,TRUE)", 0.95265101260000001),
        ("BINOM.DIST.RANGE", "=BINOM.DIST.RANGE(10,0.3,3,5)", 0.56986822619999998),
        ("BINOMDIST.RANGE", "=BINOMDIST.RANGE(10,0.3,3,5)", 0.56986822619999998),
        ("BINOM.INV", "=BINOM.INV(10,0.3,0.6)", 3.0),
        ("CRITBINOM", "=CRITBINOM(10,0.3,0.6)", 3.0),
        ("CHISQ.DIST", "=CHISQ.DIST(3,4,TRUE)", 0.44217459962892543),
        ("CHISQ.DIST.RT", "=CHISQ.DIST.RT(3,4)", 0.55782540037107457),
        ("CHIDIST", "=CHIDIST(3,4)", 0.55782540037107457),
        ("CHIDIST.RT", "=CHIDIST.RT(3,4)", 0.55782540037107457),
        ("CHIDISTRT", "=CHIDISTRT(3,4)", 0.55782540037107457),
        ("CHISQ.INV", "=CHISQ.INV(0.3,4)", 2.1946984214069832),
        ("CHISQ.INV.RT", "=CHISQ.INV.RT(0.3,4)", 4.8784329665604088),
        ("CHIINV", "=CHIINV(0.3,4)", 4.8784329665604088),
        ("CHIINV.RT", "=CHIINV.RT(0.3,4)", 4.8784329665604088),
        ("CHIINVRT", "=CHIINVRT(0.3,4)", 4.8784329665604088),
        ("CHISQ.TEST", "=CHISQ.TEST(A1:A4,F1:F4)", 0.9775892977616494),
        ("CHITEST", "=CHITEST(A1:A4,F1:F4)", 0.9775892977616494),
        ("CONFIDENCE.NORM", "=CONFIDENCE.NORM(0.05,2,10)", 1.239590064609123),
        ("CONFIDENCE.T", "=CONFIDENCE.T(0.05,2,10)", 1.4307138119413295),
        ("EXPON.DIST", "=EXPON.DIST(0.5,3,TRUE)", 0.77686983985157017),
        ("EXPONDIST", "=EXPONDIST(0.5,3,TRUE)", 0.77686983985157017),
        ("F.DIST", "=F.DIST(1.5,4,6,TRUE)", 0.6875),
        ("F.DIST.RT", "=F.DIST.RT(1.5,4,6)", 0.3125),
        ("FDIST", "=FDIST(1.5,4,6)", 0.3125),
        ("FDIST.RT", "=FDIST.RT(1.5,4,6)", 0.3125),
        ("FDISTRT", "=FDISTRT(1.5,4,6)", 0.3125),
        ("F.INV", "=F.INV(0.3,4,6)", 0.56152679515881667),
        ("F.INV.RT", "=F.INV.RT(0.3,4,6)", 1.5512907007699352),
        ("FINV", "=FINV(0.3,4,6)", 1.5512907007699352),
        ("FINV.RT", "=FINV.RT(0.3,4,6)", 1.5512907007699352),
        ("FINVRT", "=FINVRT(0.3,4,6)", 1.5512907007699352),
        ("F.TEST", "=F.TEST(A1:A4,F1:F4)", 0.65710692000559992),
        ("FTEST", "=FTEST(A1:A4,F1:F4)", 0.65710692000559992),
        ("GAMMA", "=GAMMA(4.5)", 11.631728396567449),
        ("GAMMA.DIST", "=GAMMA.DIST(3,2.5,1.5,TRUE)", 0.45058404864721977),
        ("GAMMADIST", "=GAMMADIST(3,2.5,1.5,TRUE)", 0.45058404864721977),
        ("GAMMA.INV", "=GAMMA.INV(0.3,2.5,1.5)", 2.2499310995699297),
        ("GAMMAINV", "=GAMMAINV(0.3,2.5,1.5)", 2.2499310995699297),
        ("GAMMALN", "=GAMMALN(4.5)", 2.4537365708424422),
        ("GAMMALN.PRECISE", "=GAMMALN.PRECISE(4.5)", 2.4537365708424422),
        ("GAMMALNPRECISE", "=GAMMALNPRECISE(4.5)", 2.4537365708424422),
        ("GAUSS", "=GAUSS(1.2)", 0.38493032977829172),
        ("HYPGEOM.DIST", "=HYPGEOM.DIST(3,5,7,30,FALSE)", 0.062137734551527655),
        ("HYPGEOMDIST", "=HYPGEOMDIST(3,5,7,30)", 0.062137734551527655),
        ("LOGNORM.DIST", "=LOGNORM.DIST(2,0.3,0.6,TRUE)", 0.74384508399548578),
        ("LOGNORMDIST", "=LOGNORMDIST(2,0.3,0.6)", 0.74384508399548578),
        ("LOGNORM.INV", "=LOGNORM.INV(0.3,0.3,0.6)", 0.98546634059027768),
        ("LOGINV", "=LOGINV(0.3,0.3,0.6)", 0.98546634059027768),
        ("LOGNORMINV", "=LOGNORMINV(0.3,0.3,0.6)", 0.98546634059027768),
        ("NEGBINOM.DIST", "=NEGBINOM.DIST(4,3,0.4,FALSE)", 0.124416),
        ("NEGBINOMDIST", "=NEGBINOMDIST(4,3,0.4)", 0.124416),
        ("NORM.DIST", "=NORM.DIST(1.2,0.5,2,TRUE)", 0.63683065117561906),
        ("NORMDIST", "=NORMDIST(1.2,0.5,2,TRUE)", 0.63683065117561906),
        ("NORM.INV", "=NORM.INV(0.3,0.5,2)", -0.54880102541608163),
        ("NORMINV", "=NORMINV(0.3,0.5,2)", -0.54880102541608163),
        ("NORM.S.DIST", "=NORM.S.DIST(0.7,TRUE)", 0.75803634777692697),
        ("NORMSDIST", "=NORMSDIST(0.7)", 0.75803634777692697),
        ("NORM.S.INV", "=NORM.S.INV(0.3)", -0.52440051270804082),
        ("NORMSINV", "=NORMSINV(0.3)", -0.52440051270804082),
        ("PHI", "=PHI(0.7)", 0.31225393336676127),
        ("POISSON.DIST", "=POISSON.DIST(4,3.5,TRUE)", 0.72544495330960461),
        ("POISSONDIST", "=POISSONDIST(4,3.5,TRUE)", 0.72544495330960461),
        ("PROB", "=PROB(X1:X4,P1:P4,2,3)", 0.5),
        ("T.DIST", "=T.DIST(1.3,7,TRUE)", 0.88261608230381142),
        ("T.DIST.2T", "=T.DIST.2T(1.3,7)", 0.23476783539237715),
        ("TDIST.2T", "=TDIST.2T(1.3,7)", 0.23476783539237715),
        ("T.DIST.RT", "=T.DIST.RT(1.3,7)", 0.11738391769618858),
        ("TDISTRT", "=TDISTRT(1.3,7)", 0.11738391769618858),
        ("TDIST.RT", "=TDIST.RT(1.3,7)", 0.11738391769618858),
        ("TDIST", "=TDIST(1.3,7,2)", 0.23476783539237715),
        ("T.INV", "=T.INV(0.3,7)", -0.54910965794728505),
        ("T.INV.2T", "=T.INV.2T(0.3,7)", 1.1191591283613644),
        ("TINV", "=TINV(0.3,7)", 1.1191591283613644),
        ("TINV.2T", "=TINV.2T(0.3,7)", 1.1191591283613644),
        ("T.TEST", "=T.TEST(A1:A4,F1:F4,2,2)", 0.82309885857103717),
        ("TTEST", "=TTEST(A1:A4,F1:F4,2,2)", 0.82309885857103717),
        ("WEIBULL.DIST", "=WEIBULL.DIST(2,1.5,3,TRUE)", 0.41977020402532718),
        ("WEIBULLDIST", "=WEIBULLDIST(2,1.5,3,TRUE)", 0.41977020402532718),
        ("Z.TEST", "=Z.TEST(A1:A4,2,1)", 0.15865525393145705),
        ("ZTEST", "=ZTEST(A1:A4,2,1)", 0.15865525393145705),
    ]
}

#[test]
fn the_accuracy_cases_cover_exactly_the_registered_distribution_names() {
    let source = include_str!("../src/functions/distributions.rs");
    let table = &source[source.find("pub const FUNCTIONS: Table").unwrap()..];
    let table = &table[..table.find("];").unwrap()];
    let mut registered: Vec<&str> = table.lines().filter_map(|l| l.trim_start().strip_prefix("(\"")?.split('"').next()).collect();
    registered.sort_unstable();
    let mut covered: Vec<&str> = accuracy_cases().iter().map(|c| c.0).collect();
    covered.sort_unstable();
    assert_eq!(covered, registered, "the cases must cover exactly the registered names");
}

#[test]
fn every_registered_distribution_name_answers_its_own_accuracy_case() {
    for (name, formula, want) in accuracy_cases() {
        assert!(library().resolve(name).is_some(), "{name} is not registered");
        let got = match with_local_zone(Tz::UTC, || {
            if formula.contains("X1:X4") { evaluate_formula(formula, &mut ProbSheet) } else { evaluate_formula(formula, &mut ExcelSheet) }
        }) {
            Ok(Value::Number(x)) => x,
            other => panic!("{formula}: {other:?}"),
        };
        assert!((got - want).abs() <= 1e-12 * want.abs(), "{formula}: {got:e} is not {want:e} (relative {:e})", ((got - want) / want).abs());
    }
}
#[test]
fn domain_endpoints_follow_the_excel_table() {
    // `endpoint_cases.txt`: ~650 formulas evaluated in Excel 16.0 build 20527 (value or error) at the ends of every
    // distribution's domain, for the modern and the legacy names: x at its bounds (also inside scaled intervals),
    // probabilities 0 and 1, counts 0 and n, shapes and scales at 0 or 1, both flag values. Excel's numbers are
    // compared to 1e-9 (Excel is not exact at some of them); every error type must be the same.
    let text = include_str!("endpoint_cases.txt");
    let mut bad = Vec::new();
    let mut checked = 0;
    for line in text.lines().skip(1) {
        let Some((f, want)) = line.split_once(" => ") else { continue };
        let w = want.trim();
        if w == "COMERR" {
            continue;
        }
        checked += 1;
        let ok = match (xl(f), w) {
            (Ok(Value::Error(e)), "#NUM!") => e == ErrorValue::Num,
            (Ok(Value::Error(e)), "#DIV/0!") => e == ErrorValue::Div0,
            (Ok(Value::Error(e)), "#N/A") => e == ErrorValue::Na,
            (Ok(Value::Number(g)), n) => n.replace("E+", "e").replace('E', "e").parse::<f64>().is_ok_and(|e| (g - e).abs() <= 1e-9 * e.abs().max(1e-300)),
            _ => false,
        };
        if !ok {
            bad.push(format!("{f}: excel {w}, engine {:?}", xl(f)));
        }
    }
    assert!(checked > 450);
    assert!(bad.is_empty(), "{} endpoint mismatches:\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn subnormal_probabilities_are_zero_in_excel_and_in_the_engine() {
    // Excel flushes every subnormal to 0 on entry: a cell holding 1E-320 satisfies `=J1=0` and `=J1*1E300` is 0, and
    // formula literals below 2.2E-308 down to 1E-310 are #DIV/0!/#NUM! exactly like 0, and smaller ones are refused
    // by the formula parser. So the subnormal range has no behaviour of its own: it is the zero case, #DIV/0! at one
    // degree of freedom and #NUM! from two (T.INV, T.INV.2T, TINV, df 1,2,3,5,10 probed with the value held in a
    // cell).
    use ErrorValue::{Div0, Num};
    for (f, want) in [
        ("=T.INV(1E-309,1)", Div0),
        ("=T.INV(5E-324,1)", Div0),
        ("=T.INV.2T(1E-320,1)", Div0),
        ("=TINV(1E-315,1)", Div0),
        ("=T.INV(1E-309,2)", Num),
        ("=T.INV.2T(1E-320,3)", Num),
        ("=TINV(5E-324,5)", Num),
        ("=T.INV(1E-318,10)", Num),
    ] {
        assert_eq!(error(f), want, "{f}");
    }
}
#[test]
fn huge_arguments_are_a_departure_from_excels_overflow_artefacts() {
    // Excel's answers for counts and shapes beyond about 1E12 follow no rule: POISSON.DIST(1E300,1,TRUE) is #NUM! but
    // (1E200,1,TRUE) is 1; GAMMA.DIST(1,1E100,2,TRUE) is #NUM! but 1E200 gives 0 and 1E50 gives 0; NEGBINOM.DIST(3,1E20,
    // 0.5,FALSE) is #NUM! but 1E16 gives 0. The engine answers the mathematical limit everywhere.
    rel("=POISSON.DIST(1E300,1,TRUE)", 1.0);
    assert_eq!(num("=GAMMA.DIST(1,1E300,2,TRUE)"), 0.0);
    assert_eq!(num("=NEGBINOM.DIST(3,1E300,0.5,FALSE)"), 0.0);
}

#[test]
fn intermediates_beyond_the_double_range_do_not_decide_ordinary_answers() {
    // Chernoff bound on the gamma mgf: ln Q(1e308, 1.7e308) <= -a (t/a - 1 - ln(t/a)) = -1.69e307, so P rounds to 1
    assert_eq!(num("=GAMMA.DIST(1.7E308,1E308,1,TRUE)"), 1.0);
    // mpmath at 300 digits on the exact binary64 arguments: gammainc(1/2, 0, 1e-200/1e200, regularized=True)
    rel("=GAMMA.DIST(1E-200,0.5,1E200,TRUE)", 1.1283791670955126e-200);
    // the score is (1e308 - -1e308) / 1e308 = 2 although the difference is beyond the double range: ncdf(2)
    rel("=NORM.DIST(1E308,-1E308,1E308,TRUE)", 0.9772498680518208);
    // the density exp(-z^2/2) / (sqrt(2 pi) sd) with 1/sd = 1e200 beyond any product of doubles below 1e308
    rel("=NORM.DIST(4E-199,0,1E-200,FALSE)", 1.4632702508383032e-148);
    // near the mode of a very unequal beta: x^a (1-x)^b / (a B(a,b)) 2F1(a+b, 1; a+1; x) at 300 digits
    rel("=BETA.DIST(1E-98,100,1E100,TRUE)", 0.5132987982791485);
    // a cut exactly on the mode (the exact quotient is one): symmetric shapes give 1/2, gamma(2) at t = 2 gives
    // 1 - 3 e^-2, Cauchy at 1 gives 3/4
    rel("=BETA.DIST(0,1,1,TRUE,-5,5)", 0.5);
    rel("=F.DIST(1,3,3,TRUE)", 0.5);
    rel("=GAMMA.DIST(2,2,1,TRUE)", 1.0 - 3.0 * (-2.0_f64).exp());
    rel("=T.DIST(1,1,TRUE)", 0.75);
}

#[test]
fn discrete_counts_stay_exact_at_every_magnitude() {
    // exact rationals (Python fractions on the binary64 probabilities)
    rel("=BINOM.DIST(15,40,0.3,TRUE)", 0.8848533494186117);
    rel("=NEGBINOM.DIST(10,5,0.25,TRUE)", 0.3135140584781766);
    rel("=BINOM.DIST.RANGE(1000,0.3,200,400)", 0.9999999999926817);
    rel("=BINOM.DIST.RANGE(100,0.5,40,60)", 0.9647997997822951);
    rel("=HYPGEOM.DIST(1,4,8,20,TRUE)", 0.46542827657378744);
    rel("=HYPGEOM.DIST(1,10,20,50,TRUE)", 0.03078070996202395);
    rel("=HYPGEOM.DIST(500,1000,1000,2000,TRUE)", 0.517834551951791);
    rel("=HYPGEOM.DIST(5000,10000,10000,20000,TRUE)", 0.5056416842683511);
    // mpmath gammainc(1001, 1000, inf, regularized=True)
    rel("=POISSON.DIST(1000,1000,TRUE)", 0.508409367168506);
    // counts above 2^53: adding one to 1E16 as a double returns 1E16, so a walk on a floating index never ends.
    // The mass of k = K = n is 1/C(2E16, 1E16) ~ 2^-2E16 (a flushed zero); the table with K = n = N/2 is symmetric
    // about k = N/4, so P(X <= N/4) = (1 + P(X = N/4))/2 with the mass from mpmath loggamma at 60 digits
    assert_eq!(num("=HYPGEOM.DIST(1E16,1E16,1E16,2E16,FALSE)"), 0.0);
    rel("=HYPGEOM.DIST(5E15,1E16,1E16,2E16,FALSE)", 1.1283791670955125e-8);
    rel("=HYPGEOM.DIST(5E15,1E16,1E16,2E16,TRUE)", 0.5000000056418958);
}

#[test]
fn quantiles_search_the_worksheet_coordinate_with_exact_crossings() {
    // exact medians of symmetric laws: the tail there is exactly 1/2, decided as an equality
    assert_eq!(num("=NORM.INV(0.5,3,2)"), 3.0);
    assert_eq!(num("=T.INV(0.5,3)"), 0.0);
    assert_eq!(num("=BETA.INV(0.5,2,2)"), 0.5);
    assert_eq!(num("=BETA.INV(0.5,3,3,-1,7)"), 3.0);
    assert_eq!(num("=F.INV(0.5,4,4)"), 1.0);
    assert_eq!(num("=LOGNORM.INV(0.5,0,3)"), 1.0);
    // dyadic binomial crossings: P(X <= 500) = 1/2 for Bin(1001, 1/2); P(X <= 0) = 1/4 and P(X <= 1) = 3/4 for
    // Bin(2, 1/2). The smallest count reaching alpha includes the equality.
    assert_eq!(num("=BINOM.INV(1001,0.5,0.5)"), 500.0);
    assert_eq!(num("=BINOM.INV(2,0.5,0.25)"), 0.0);
    assert_eq!(num("=BINOM.INV(2,0.5,0.75)"), 1.0);
    // the worksheet x of a beta on [-1e308, 1e308] (the width 2e308 is beyond the double range): mpmath
    // -1e308 + u (1e308 - -1e308) with u the root of betainc(2, 5, 0, u) = 0.3
    rel("=BETA.INV(0.3,2,5,-1E308,1E308)", -6.363930573621016e307);
    // a shifted normal: 1e10 + z, z the root of ncdf(z) = 1e-10 (mpmath, 80 digits)
    rel("=NORM.INV(1E-10,1E10,1)", 9999999993.638659);
    // subnormal quantiles are the nearest double: -1e-10 log1p(-1e-300) = 1.0000000000000000615e-310, and the
    // chi-square(1) root 2 erfinv(1e-160)^2 = 1.5707963267948966e-320 = 3179.3 least subnormals
    assert_eq!(num("=GAMMA.INV(1E-300,1,1E-10)"), 1e-310);
    assert_eq!(num("=CHISQ.INV(1E-160,1)").to_bits(), 3179);
    // quantiles below half the least subnormal are zero: 0.5^(1/1e-300) and about 1e-600
    assert_eq!(num("=GAMMA.INV(0.5,1E-300,1)"), 0.0);
    assert_eq!(num("=GAMMA.INV(1E-300,1,1E-300)"), 0.0);
}

/// The adversarial termination grid: wide hypergeometric tables (populations 1e6, 2^53, 2e16, 1e100, 1e308 with
/// balanced, tiny, nearly full and unequal margins, k at the mode and 1, 10 and 40 deviations either side), counts at
/// and above 2^53, the review's inputs, and quantiles at the ends of their ranges.
fn adversarial_grid() -> Vec<String> {
    let mut out = hypergeometric_grid();
    out.extend(large_count_formulas());
    out.extend(EXTREME_FORMULAS.iter().map(|f| f.to_string()));
    out
}

fn hypergeometric_grid() -> Vec<String> {
    let mut out = Vec::new();
    for big_n in [1e6, 2f64.powi(53), 2e16, 1e100, 1e308] {
        for (n, k) in [
            (big_n / 2.0, big_n / 2.0),
            (big_n / 2.0, 10.0),
            (big_n / 2.0, big_n - 10.0),
            (10.0, big_n / 2.0),
            (big_n - 10.0, big_n / 2.0),
            (big_n / 3.0, big_n / 7.0),
        ] {
            let mean = n * (k / big_n);
            let sd = (n * (k / big_n) * (1.0 - k / big_n) * ((big_n - n) / big_n)).max(0.0).sqrt();
            let (lo, hi) = ((n + k - big_n).max(0.0), n.min(k));
            let mut seen = Vec::new();
            for c in [0.0, -1.0, 1.0, -10.0, 10.0, -40.0, 40.0] {
                let x = (mean + c * sd).floor();
                if (lo..=hi).contains(&x) && !seen.contains(&x) {
                    seen.push(x);
                    out.push(format!("=HYPGEOM.DIST({x:e},{n:e},{k:e},{big_n:e},TRUE)"));
                }
            }
        }
    }
    out
}

fn large_count_formulas() -> Vec<String> {
    let mut out = Vec::new();
    for k in [2f64.powi(53), 2f64.powi(53) + 2.0, 1e16, 2f64.powi(63), 1e300] {
        out.push(format!("=POISSON.DIST({k:e},{k:e},TRUE)"));
        out.push(format!("=NEGBINOM.DIST({k:e},{k:e},0.5,TRUE)"));
        out.push(format!("=NEGBINOM.DIST({k:e},3,0.5,FALSE)"));
    }
    out
}

const EXTREME_FORMULAS: &[&str] = &[
    "=HYPGEOM.DIST(1E16,1E16,1E16,2E16,FALSE)",
    "=HYPGEOM.DIST(1E16,1E16,1E16,2E16,TRUE)",
    "=GAMMA.DIST(1.7E308,1E308,1,TRUE)",
    "=GAMMA.DIST(1E-200,0.5,1E200,TRUE)",
    "=NORM.DIST(1E308,-1E308,1E308,TRUE)",
    "=NORM.DIST(4E-199,0,1E-200,FALSE)",
    "=BETA.DIST(1E-98,100,1E100,TRUE)",
    "=BETA.DIST(0.9,2.5,1E-300,TRUE)",
    "=BETA.DIST(1E-300,1E-300,1E-300,TRUE)",
    "=T.DIST.RT(3,1E9)",
    "=F.DIST.RT(1,1E10,2)",
    "=TDIST(1,1E10,1)",
    "=BINOM.DIST(5E9,1E10,0.5,TRUE)",
    "=BINOM.DIST.RANGE(2147483646,0.5,1000000000,1100000000)",
    "=BINOM.INV(2147483646,0.5,0.5)",
    "=GAMMA.INV(0.5,1E308,1)",
    "=GAMMA.INV(0.5,1E-300,1)",
    "=BETA.INV(0.5,1E300,1E300)",
    "=BETA.INV(1E-300,1E-300,1E300)",
    "=T.INV(1E-300,1)",
    "=T.INV.2T(1E-300,1E10)",
    "=F.INV(1E-300,1E10,1)",
    "=CHISQ.INV.RT(1E-300,1E15)",
    "=CHISQ.INV(1E-160,1)",
    "=LOGNORM.INV(1E-300,-700,30)",
    "=NORM.INV(0.3,1E308,1E308)",
    "=NORM.DIST(2.5,2.2250738585072014E-308,2.5,TRUE)",
    "=LOGNORM.DIST(3,1E300,1E300,TRUE)",
    "=LOGNORM.INV(0.1,-700,2)",
    "=LOGNORM.INV(0.1,700,1)",
    "=GAMMA.DIST(5E-21,1E-20,1,TRUE)",
    "=GAMMA.DIST(1.1,1E-200,1E200,TRUE)",
    "=GAMMA.DIST(5E-321,1E-20,1E-300,TRUE)",
    "=GAMMA.INV(1E-300,1,1)",
    "=GAMMA.INV(2.2250738585072014E-308,1,2.5)",
    "=GAMMA.INV(0.75,0.01,2.2250738585072014E-308)",
];

#[test]
fn a_standard_score_a_hair_from_one_keeps_the_tails_at_the_gamma_mode() {
    // z = 1 - 1E-308 and z = -1 + 1E-300 ln 3: the squared score rounds to a ball holding 1, the mode of the half-shape
    // gamma that carries the normal tails; Phi(1) = 0.841344746068542948585..., Phi(-1) = 0.158655253931457051414...
    rel("=NORM.DIST(2.5,2.2250738585072014E-308,2.5,TRUE)", 0.841_344_746_068_543);
    rel("=NORM.DIST(1E100,1,1E100,TRUE)", 0.841_344_746_068_543);
    rel("=LOGNORM.DIST(3,1E300,1E300,TRUE)", 0.158_655_253_931_457_05);
    // lognormal quantiles exp(mu + sd z) whose double-precision estimate is a few 2^-45 off (references: mpmath)
    rel("=LOGNORM.INV(0.1,-700,2)", 7.598_381_963_517_407e-306);
    rel("=LOGNORM.INV(0.1,700,1)", 2.815_571_490_808_265_3e303);
}

#[test]
fn tiny_gamma_shapes_and_quantiles_a_hair_from_a_double_are_exact() {
    // P(1e-20, 5e-21) = 1 - 4.6e-19 and P(1e-200, 1.1e-200) = 1 - 4.6e-198 (were 0); the quantile of
    // GAMMA.INV(1E-300,1,1) is 1E-300 (1 + 5E-301), nearest double 1E-300 (took 23 s)
    rel("=GAMMA.DIST(5E-21,1E-20,1,TRUE)", 1.0);
    rel("=GAMMA.DIST(1.1,1E-200,1E200,TRUE)", 1.0);
    rel("=GAMMA.DIST(1E-25,1E-20,1,TRUE)", 1.0);
    rel("=GAMMA.INV(1E-300,1,1)", 1e-300);
    rel("=GAMMA.INV(2.2250738585072014E-308,1,2.5)", 5.562_684_646_268_003e-308);
    // a subnormal quantile at the scale DBL_MIN: ln 2 * DBL_MIN (took 2.7 s)
    rel("=GAMMA.INV(0.5,1,2.2250738585072014E-308)", 1.542_303_671_561_905_3e-308);
}

#[test]
fn every_formula_of_the_adversarial_grid_ends_within_its_time_bound() {
    // the bound per formula: 2 s for an optimised build (the release gate, measured by the sweep harness), 20 s for
    // this unoptimised test build (about 4-8 times slower); the grid's slowest formula takes 2.5 s here
    let bound = std::time::Duration::from_secs(if cfg!(debug_assertions) { 20 } else { 2 });
    let grid = adversarial_grid();
    let slow = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for chunk in grid.chunks(grid.len().div_ceil(8)) {
            let slow = &slow;
            s.spawn(move || {
                for f in chunk {
                    let start = std::time::Instant::now();
                    let got = eval(f);
                    let took = start.elapsed();
                    if took > bound || !matches!(got, Ok(Value::Number(_)) | Ok(Value::Error(_))) {
                        slow.lock().unwrap().push(format!("{f}: {got:?} in {took:?}"));
                    }
                }
            });
        }
    });
    let slow = slow.into_inner().unwrap();
    assert!(grid.len() > 100);
    assert!(slow.is_empty(), "{} formulas over {bound:?}:\n{}", slow.len(), slow.join("\n"));
}

/// Cells given as `A1=1.5;B2=-3` (numbers only; every other cell blank).
struct GivenCells(std::collections::HashMap<String, f64>);

impl Context for GivenCells {
    fn sheet(&self) -> &str {
        "Sheet1"
    }

    fn value(&mut self, _sheet: &str, reference: &str) -> Result<Value, Failure> {
        Ok(self.0.get(reference).map_or_else(|| Value::text(""), |x| Value::Number(*x)))
    }
}

/// The accuracy sweep's engine (`sweep.py`): with `MIXDOG_SWEEP_SERVE` set, reads `formula|cells` lines from stdin
/// and answers each with `@@<number> <bits hex>` or `@@ERR:<code>`, a tab and the evaluation time in microseconds
/// (the line `__HANG__` never answers: the harness's own timeout check).
/// Without the variable it returns at once, so the suite is unaffected.
#[test]
fn sweep_eval() {
    use std::io::{BufRead, Write};
    if std::env::var_os("MIXDOG_SWEEP_SERVE").is_none() {
        return;
    }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    // libtest has printed `test sweep_eval ... ` without a line end: every answer starts its own line
    writeln!(out).expect("stdout");
    for line in stdin.lock().lines() {
        let line = line.expect("a line of input");
        let (formula, cells) = line.split_once('|').unwrap_or((&line, ""));
        if formula == "__HANG__" {
            // the harness self-check: a formula that never answers must be killed at its deadline and fail its row
            loop {
                std::thread::park();
            }
        }
        let cells = cells.split(';').filter_map(|c| c.split_once('=')).map(|(k, v)| (k.to_string(), v.parse::<f64>().expect("a numeric cell"))).collect();
        let start = std::time::Instant::now();
        let got = with_local_zone(Tz::UTC, || evaluate_formula(formula, &mut GivenCells(cells)));
        let us = start.elapsed().as_micros();
        let text = match got {
            Ok(Value::Number(x)) => format!("{x:e} {:016x}", x.to_bits()),
            Ok(Value::Error(e)) => format!("ERR:{e:?}"),
            other => format!("ERR:{other:?}"),
        };
        writeln!(out, "@@{text}\t{us}").expect("stdout");
        out.flush().expect("stdout");
    }
}
