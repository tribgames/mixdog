//! Attribution on readings and records copied from a ledger: Antigravity's five-hour and weekly meters on 2026-11-24
//! (local time, UTC+9), which settle a request a reading late and move on their own between requests, and Grok's
//! weekly meter.

use super::*;

// The five-hour windows, each as (seen at, seen until, used %) under its reset.
const W0_RESET: f64 = 1795485424000.0;
const W0: [(i64, i64, f64); 33] = [
    (1795473241975, 1795473297524, 0.04),
    (1795473597038, 1795473597038, 1.8),
    (1795473896971, 1795473896971, 2.04),
    (1795474197265, 1795474197265, 1.87),
    (1795474497450, 1795474497450, 1.9),
    (1795474797479, 1795474797479, 1.87),
    (1795475096802, 1795475096802, 2.62),
    (1795475396853, 1795475396853, 3.53),
    (1795475697405, 1795475697405, 3.64),
    (1795475997598, 1795476297339, 3.62),
    (1795476597244, 1795476597244, 4.9),
    (1795476898105, 1795476898105, 6.41),
    (1795477197243, 1795477498026, 7.24),
    (1795477797514, 1795477797514, 7.96),
    (1795478097371, 1795478097371, 8.68),
    (1795478397765, 1795478997575, 8.39),
    (1795479495366, 1795479794829, 7.96),
    (1795480095293, 1795480694813, 8.39),
    (1795481037134, 1795481037134, 9.96),
    (1795481271481, 1795481271481, 9.83),
    (1795481337212, 1795481337212, 10.25),
    (1795481637478, 1795481937186, 9.83),
    (1795482237475, 1795482237475, 9.4),
    (1795482536823, 1795482536823, 10.39),
    (1795482837165, 1795482837165, 12.69),
    (1795483136827, 1795483136827, 16.83),
    (1795483437418, 1795483437418, 30.39),
    (1795483737335, 1795483737335, 44.62),
    (1795484037119, 1795484037119, 53.32),
    (1795484337708, 1795484337708, 54.4),
    (1795484636862, 1795484636862, 55.13),
    (1795484937728, 1795484937728, 55.33),
    (1795485237417, 1795485237417, 56.84),
];
const W1_RESET: f64 = 1795503424000.0;
const W1: [(i64, i64, f64); 28] = [
    (1795485537240, 1795485537240, 3.7),
    (1795486002920, 1795486002920, 6.38),
    (1795486301991, 1795486301991, 13.55),
    (1795486601819, 1795486601819, 34.79),
    (1795486901533, 1795486901533, 52.17),
    (1795487202209, 1795487202209, 62.4),
    (1795487501734, 1795487501734, 68.26),
    (1795487801529, 1795487801529, 71.11),
    (1795488102303, 1795488102303, 75.05),
    (1795488401548, 1795488401548, 78.87),
    (1795488701632, 1795488701632, 81.43),
    (1795489001628, 1795489302281, 83.61),
    (1795489602000, 1795489602000, 83.87),
    (1795489902183, 1795489902183, 83.61),
    (1795490201921, 1795490201921, 83.31),
    (1795490502253, 1795490502253, 84.8),
    (1795490801941, 1795490801941, 84.91),
    (1795491101640, 1795491401981, 85.57),
    (1795491702446, 1795491702446, 85.12),
    (1795492001912, 1795492001912, 85.35),
    (1795492302044, 1795492302044, 85.57),
    (1795492602541, 1795492602541, 86.12),
    (1795492901575, 1795492901575, 94.16),
    (1795493201895, 1795493201895, 99.77),
    (1795493502107, 1795494702318, 100.0),
    (1795495001908, 1795495001908, 99.48),
    (1795495302418, 1795496944793, 100.0),
    (1795497244561, 1795503245198, 99.48),
];
const W2_RESET: f64 = 1795521424000.0;
const W2: [(i64, i64, f64); 52] = [
    (1795503544568, 1795503544568, 1.0),
    (1795503845569, 1795504144767, 2.0),
    (1795504444304, 1795504444304, 3.0),
    (1795504744989, 1795504744989, 2.46),
    (1795505045847, 1795505045847, 3.0),
    (1795505344052, 1795505344052, 3.71),
    (1795505649451, 1795505649451, 3.56),
    (1795505949919, 1795505949919, 5.67),
    (1795506412595, 1795506412595, 8.8),
    (1795506712880, 1795506712880, 11.17),
    (1795507012869, 1795507012869, 11.9),
    (1795507313300, 1795507313300, 13.17),
    (1795507614220, 1795507614220, 12.66),
    (1795507913586, 1795508512815, 12.03),
    (1795508813098, 1795508813098, 13.3),
    (1795509112764, 1795509112764, 14.42),
    (1795509413121, 1795509413121, 14.44),
    (1795509712869, 1795509712869, 14.47),
    (1795510013114, 1795510013114, 14.5),
    (1795510312627, 1795510312627, 14.52),
    (1795510613119, 1795510913158, 15.04),
    (1795511214164, 1795511214164, 14.86),
    (1795511512921, 1795511512921, 14.87),
    (1795511813415, 1795511813415, 15.33),
    (1795512112778, 1795512112778, 15.47),
    (1795512412959, 1795512412959, 15.57),
    (1795512712974, 1795512712974, 16.23),
    (1795513012212, 1795513012212, 18.31),
    (1795513312950, 1795513312950, 19.58),
    (1795513612977, 1795513612977, 20.7),
    (1795513913507, 1795513913507, 21.58),
    (1795514212945, 1795514212945, 23.7),
    (1795514513333, 1795514513333, 23.99),
    (1795514813794, 1795514813794, 26.08),
    (1795515113211, 1795515412695, 27.21),
    (1795515713313, 1795515713313, 27.25),
    (1795516013196, 1795516447498, 27.9),
    (1795516747903, 1795516747903, 27.45),
    (1795517048636, 1795517048636, 27.9),
    (1795517348240, 1795517348240, 28.25),
    (1795517617148, 1795517617148, 27.35),
    (1795517915211, 1795517915211, 28.11),
    (1795518416706, 1795518416706, 27.58),
    (1795518716463, 1795518716463, 26.82),
    (1795519078437, 1795519078437, 27.58),
    (1795519378495, 1795519378495, 26.21),
    (1795519678376, 1795519678376, 27.12),
    (1795519978132, 1795519978132, 33.22),
    (1795520278042, 1795520278042, 40.52),
    (1795520578351, 1795520578351, 45.32),
    (1795520878450, 1795520878450, 46.45),
    (1795521178327, 1795521178327, 48.06),
];
const W3_RESET: f64 = 1795539424000.0;
const W3: [(i64, i64, f64); 2] = [(1795521478128, 1795521478128, 0.11), (1795521778359, 1795521778359, 1.0)];
// The weekly window over the same day.
const WEEK_RESET: f64 = 1796072224000.0;
const WEEK: [(i64, i64, f64); 117] = [
    (1795473241975, 1795473297524, 0.01),
    (1795473597038, 1795473597038, 1.2),
    (1795473896971, 1795473896971, 2.01),
    (1795474197265, 1795474797479, 1.22),
    (1795475096802, 1795475096802, 1.41),
    (1795475396853, 1795475396853, 1.38),
    (1795475697405, 1795476297339, 1.41),
    (1795476597244, 1795476597244, 2.01),
    (1795476898105, 1795476898105, 2.85),
    (1795477197243, 1795477498026, 3.06),
    (1795477797514, 1795477797514, 2.96),
    (1795478097371, 1795478097371, 2.64),
    (1795478397765, 1795478997575, 3.1),
    (1795479495366, 1795479794829, 2.96),
    (1795480095293, 1795480694813, 3.1),
    (1795481037134, 1795481037134, 4.53),
    (1795481271481, 1795481271481, 3.75),
    (1795481337212, 1795481337212, 3.89),
    (1795481637478, 1795481937186, 3.75),
    (1795482237475, 1795482237475, 3.42),
    (1795482536823, 1795482536823, 3.67),
    (1795482837165, 1795482837165, 5.0),
    (1795483136827, 1795483136827, 6.53),
    (1795483437418, 1795483437418, 8.66),
    (1795483737335, 1795483737335, 13.06),
    (1795484037119, 1795484037119, 14.8),
    (1795484337708, 1795484337708, 14.72),
    (1795484636862, 1795484636862, 14.9),
    (1795484937728, 1795484937728, 14.98),
    (1795485237417, 1795485237417, 15.95),
    (1795485537240, 1795485537240, 16.06),
    (1795486002920, 1795486002920, 16.48),
    (1795486301991, 1795486301991, 18.72),
    (1795486601819, 1795486601819, 24.01),
    (1795486901533, 1795486901533, 29.02),
    (1795487202209, 1795487202209, 31.8),
    (1795487501734, 1795487501734, 32.8),
    (1795487801529, 1795487801529, 33.85),
    (1795488102303, 1795488102303, 35.21),
    (1795488401548, 1795488401548, 35.39),
    (1795488701632, 1795488701632, 36.93),
    (1795489001628, 1795489302281, 36.97),
    (1795489602000, 1795489602000, 36.82),
    (1795489902183, 1795489902183, 36.97),
    (1795490201921, 1795490201921, 36.45),
    (1795490502253, 1795490502253, 36.6),
    (1795490801941, 1795490801941, 36.63),
    (1795491101640, 1795491101640, 36.3),
    (1795491401981, 1795491401981, 37.21),
    (1795491702446, 1795491702446, 37.16),
    (1795492001912, 1795492001912, 36.33),
    (1795492302044, 1795492302044, 37.21),
    (1795492602541, 1795492602541, 37.16),
    (1795492901575, 1795492901575, 39.68),
    (1795493201895, 1795493201895, 41.4),
    (1795493502107, 1795493502107, 41.45),
    (1795493802715, 1795493802715, 41.99),
    (1795494102416, 1795494401830, 41.51),
    (1795494702318, 1795494702318, 41.45),
    (1795495001908, 1795495001908, 41.39),
    (1795495302418, 1795495302418, 41.45),
    (1795495602431, 1795496202230, 41.51),
    (1795496644299, 1795496644299, 41.99),
    (1795496944793, 1795496944793, 41.51),
    (1795497244561, 1795497244561, 40.71),
    (1795497544193, 1795497544193, 39.4),
    (1795497844490, 1795503245198, 39.26),
    (1795503544568, 1795503544568, 40.26),
    (1795503845569, 1795504144767, 41.26),
    (1795504444304, 1795504444304, 42.26),
    (1795504744989, 1795504744989, 41.38),
    (1795505045847, 1795505045847, 42.26),
    (1795505344052, 1795505344052, 42.44),
    (1795505649451, 1795505649451, 42.4),
    (1795505949919, 1795505949919, 42.54),
    (1795506412595, 1795506412595, 42.71),
    (1795506712880, 1795506712880, 43.42),
    (1795507012869, 1795507012869, 43.85),
    (1795507313300, 1795507313300, 43.48),
    (1795507614220, 1795507614220, 44.41),
    (1795507913586, 1795508512815, 44.01),
    (1795508813098, 1795508813098, 43.57),
    (1795509112764, 1795509413121, 44.66),
    (1795509712869, 1795509712869, 44.67),
    (1795510013114, 1795510013114, 44.25),
    (1795510312627, 1795510312627, 44.26),
    (1795510613119, 1795510913158, 44.28),
    (1795511214164, 1795511214164, 44.77),
    (1795511512921, 1795511512921, 44.16),
    (1795511813415, 1795511813415, 44.35),
    (1795512112778, 1795512112778, 44.39),
    (1795512412959, 1795512412959, 44.41),
    (1795512712974, 1795512712974, 44.89),
    (1795513012212, 1795513012212, 45.57),
    (1795513312950, 1795513312950, 45.98),
    (1795513612977, 1795513612977, 46.92),
    (1795513913507, 1795513913507, 45.98),
    (1795514212945, 1795514513333, 46.92),
    (1795514813794, 1795514813794, 46.94),
    (1795515113211, 1795515412695, 47.13),
    (1795515713313, 1795515713313, 47.23),
    (1795516013196, 1795516447498, 48.09),
    (1795516747903, 1795516747903, 47.28),
    (1795517048636, 1795517048636, 48.09),
    (1795517348240, 1795517348240, 47.43),
    (1795517617148, 1795517617148, 46.51),
    (1795517915211, 1795517915211, 47.35),
    (1795518416706, 1795518416706, 46.92),
    (1795518716463, 1795518716463, 46.07),
    (1795519078437, 1795519078437, 46.92),
    (1795519378495, 1795519378495, 45.88),
    (1795519678376, 1795519678376, 46.8),
    (1795519978132, 1795519978132, 48.75),
    (1795520278042, 1795520278042, 50.87),
    (1795520578351, 1795520578351, 51.1),
    (1795520878450, 1795520878450, 51.78),
    (1795521178327, 1795521178327, 51.93),
];
// Every Mixdog record of the account over the day: (end, duration ms, cost $).
const RECORDS: [(i64, f64, f64); 101] = [
    (1795480917093, 81870.0, 0.218754),
    (1795482832939, 488925.0, 1.550916),
    (1795483043326, 537976.0, 1.635898),
    (1795483628505, 1248369.0, 4.016844),
    (1795483769770, 785994.0, 3.566839),
    (1795483770925, 778842.0, 3.012989),
    (1795483836450, 686208.0, 2.701414),
    (1795483872196, 728191.0, 2.791501),
    (1795483898021, 779877.0, 4.228467),
    (1795483900025, 861382.0, 3.42437),
    (1795483915652, 868730.0, 2.465902),
    (1795483917160, 916688.0, 3.839912),
    (1795483920417, 787129.0, 2.856867),
    (1795483956175, 948025.0, 4.980932),
    (1795484047216, 1015284.0, 3.884366),
    (1795484074887, 949434.0, 3.2631),
    (1795484080452, 1054144.0, 4.197133),
    (1795484105898, 1078658.0, 4.229187),
    (1795484197291, 1209912.0, 4.509472),
    (1795484626680, 1459781.0, 6.140822),
    (1795485366512, 500560.0, 1.485558),
    (1795485434552, 561637.0, 1.328051),
    (1795486090557, 184298.0, 0.39131),
    (1795486221266, 317362.0, 0.686759),
    (1795486311114, 407798.0, 0.78668),
    (1795486410691, 504298.0, 0.985583),
    (1795486460620, 222598.0, 0.498137),
    (1795486498365, 275510.0, 0.647304),
    (1795486986386, 779233.0, 1.82379),
    (1795486986592, 830593.0, 1.545224),
    (1795487010733, 207385.0, 0.42195),
    (1795487054491, 884387.0, 2.749414),
    (1795487057967, 232727.0, 0.528231),
    (1795487092188, 177200.0, 0.409074),
    (1795487131059, 947702.0, 1.869618),
    (1795487221611, 798147.0, 2.90648),
    (1795487271334, 1067324.0, 2.07703),
    (1795487428572, 1020818.0, 1.831071),
    (1795487570123, 386308.0, 1.039739),
    (1795487828603, 517958.0, 1.33406),
    (1795487987495, 207541.0, 0.906178),
    (1795488151966, 377293.0, 0.709029),
    (1795488205066, 149608.0, 1.388562),
    (1795488452522, 228932.0, 1.558329),
    (1795488902191, 388635.0, 2.211466),
    (1795492747234, 38512.0, 0.735332),
    (1795492816875, 120258.0, 1.590192),
    (1795492960663, 255666.0, 1.237267),
    (1795493216917, 575168.0, 1.654837),
    (1795493228666, 549669.0, 1.70064),
    (1795493238032, 545576.0, 1.6116),
    (1795493241923, 584325.0, 2.104636),
    (1795493270977, 647306.0, 3.428911),
    (1795493275830, 611739.0, 1.674678),
    (1795493334220, 689240.0, 2.166457),
    (1795493369018, 701808.0, 1.549473),
    (1795493371810, 315087.0, 1.051156),
    (1795493557769, 944501.0, 2.507349),
    (1795503734042, 469233.0, 1.110695),
    (1795504498149, 207869.0, 0.686191),
    (1795504834139, 116394.0, 0.650241),
    (1795506408944, 671247.0, 1.73112),
    (1795506534432, 807531.0, 2.258742),
    (1795506555528, 824853.0, 2.4567),
    (1795506747630, 1006456.0, 4.536032),
    (1795507141335, 75520.0, 1.276438),
    (1795507195911, 133162.0, 0.927457),
    (1795507528688, 131791.0, 0.425232),
    (1795508737035, 329782.0, 1.007257),
    (1795513216420, 629108.0, 1.641272),
    (1795514532188, 1980876.0, 5.57302),
    (1795514976489, 407079.0, 1.453132),
    (1795515061988, 85296.0, 0.392834),
    (1795515340603, 307778.0, 0.787407),
    (1795515515908, 483185.0, 1.233432),
    (1795515894935, 128773.0, 0.302156),
    (1795520179837, 403116.0, 0.88756),
    (1795520240895, 460969.0, 1.344579),
    (1795520315209, 540779.0, 1.506825),
    (1795520323437, 579870.0, 1.659019),
    (1795520323681, 586668.0, 1.631173),
    (1795520336884, 581880.0, 1.452659),
    (1795520347251, 567539.0, 1.665102),
    (1795520385570, 193133.0, 0.474212),
    (1795520389289, 613745.0, 1.813716),
    (1795520402407, 626863.0, 1.802867),
    (1795520414235, 638348.0, 1.736962),
    (1795520479588, 61580.0, 0.222959),
    (1795520482075, 32926.0, 0.148098),
    (1795520484352, 707885.0, 2.026503),
    (1795520534651, 757883.0, 2.122519),
    (1795520540693, 764301.0, 2.470126),
    (1795520599793, 820664.0, 2.583756),
    (1795520746386, 76664.0, 0.248972),
    (1795520800486, 108263.0, 0.3137),
    (1795521017586, 71659.0, 0.280056),
    (1795521037694, 234344.0, 0.633275),
    (1795521154287, 349426.0, 0.876553),
    (1795521207502, 349571.0, 1.058358),
    (1795521452693, 203118.0, 0.688638),
    (1795522570679, 619456.0, 1.607132),
];
const NOW: f64 = 1795521838359.0;
// Claude's weekly window from 2026-10-04 (account 2b2f5aef): a record took it to 1 %, then it climbed with no record
// running to 57 % over three days.
const CLAUDE_WEEK_RESET: f64 = 1791576000460.0;
const CLAUDE_WEEK: [(i64, i64, f64); 13] = [
    (1791094298551, 1791094413938, 0.0),
    (1791096649923, 1791097443097, 1.0),
    (1791097743000, 1791102242860, 2.0),
    (1791102543438, 1791105242798, 3.0),
    (1791105543203, 1791106745258, 4.0),
    (1791107049742, 1791108843358, 5.0),
    (1791109142938, 1791110643258, 6.0),
    (1791110942961, 1791112443191, 7.0),
    (1791112744143, 1791113342893, 8.0),
    (1791113642876, 1791118142919, 9.0),
    (1791118611075, 1791118611075, 10.0),
    (1791286780645, 1791318327527, 56.0),
    (1791369119470, 1791470681976, 57.0),
];
const CLAUDE_RECORD: (f64, f64) = (1791094429579.0, 21216.0);

fn readings(readings: &[(i64, i64, f64)], reset_at: f64) -> Vec<Row> {
    readings.iter().map(|&(ts, until, used_pct)| Row { ts: ts as f64, until: until as f64, used_pct, reset_at: Some(reset_at), rolling: false }).collect()
}

fn records() -> Vec<Event> {
    RECORDS.iter().map(|&(ts, span_ms, cost_usd)| record(ts as f64, span_ms, cost_usd)).collect()
}

/// The five-hour series as the ledger holds it, a window per reset.
fn five_hour_windows() -> Vec<Instance> {
    let rows: Vec<Row> = [(&W0[..], W0_RESET), (&W1[..], W1_RESET), (&W2[..], W2_RESET), (&W3[..], W3_RESET)]
        .into_iter()
        .flat_map(|(window, reset_at)| readings(window, reset_at))
        .collect();
    quota_instances(&rows, "5H", NOW)
}

/// The window as its readings stood at `at`.
fn read_at(mut window: Instance, at: f64) -> Instance {
    window.rows.retain(|r| r.ts <= at);
    window
}

/// What a window books: Mixdog's points, as the shares its records take, outside use and unattributed points.
struct Booked {
    mixdog: f64,
    outside: f64,
    unattributed: f64,
    window: Instance,
}

fn book(window: Instance, events: &[Event], finer: &[Interval]) -> Booked {
    let mut all = vec![window];
    let (pieces, _) = allocate_quota(&mut all, &[0], events, finer, &[0]);
    let window = all.remove(0);
    Booked { mixdog: pieces.iter().map(|p| p.share).sum(), outside: window.outside, unattributed: window.unattributed, window }
}

#[track_caller]
fn assert_points(actual: (f64, f64, f64), expected: (f64, f64, f64)) {
    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(
        close(actual.0, expected.0) && close(actual.1, expected.1) && close(actual.2, expected.2),
        "(mixdog, outside, unattributed) {actual:?}, expected {expected:?}"
    );
}

fn split(booked: &Booked) -> (f64, f64, f64) {
    (booked.mixdog, booked.outside, booked.unattributed)
}

/// A ledger holding `records` as (end, duration ms) and `readings` as their polls wrote them, under `reset_at`.
fn recorded_ledger(label: &str, readings: &[(i64, i64, f64)], reset_at: f64, records: &[(f64, f64)]) -> Connection {
    let mut conn = ledger(records);
    let polls: Vec<QuotaReading> = readings
        .iter()
        .flat_map(|&(ts, until, used_pct)| {
            let confirmed = (until > ts).then(|| reading(label, false, until as f64, used_pct, reset_at));
            std::iter::once(reading(label, false, ts as f64, used_pct, reset_at)).chain(confirmed)
        })
        .collect();
    record_quota_samples(&mut conn, &polls).unwrap();
    conn
}

/// The history of (from_ms, to_ms].
fn period(label: &str, from_ms: f64, to_ms: f64) -> QuotaHistoryQuery {
    QuotaHistoryQuery {
        provider: "prov".into(),
        account: "acc".into(),
        label: label.into(),
        view: "custom".into(),
        from_ms: Some(from_ms),
        to_ms: Some(to_ms - 1.0),
        ..QuotaHistoryQuery::default()
    }
}

#[test]
fn a_debit_settled_a_reading_late_mid_window_joins_the_rise_before_it() {
    let events = records();
    // 17:26:53 read 13.30 once, after the record that ran 17:20:07-17:25:37; 17:31:52 read 14.42 with none running.
    let window = read_at(five_hour_windows().remove(2), 1795509112764.0);

    let booked = book(window, &events, &[]);

    assert_points(split(&booked), (14.42, 0.0, 0.0));
    let rise = booked.window.intervals.last().unwrap();
    assert_eq!((rise.from_ms, rise.to_ms), (1795507313300.0, 1795509112764.0), "from the 13.17 high at 17:01:53");
    assert!((rise.points - 1.25).abs() < 1e-9 && (rise.cost_usd - (0.425232 + 1.007257)).abs() < 1e-9, "{rise:?}");
    let debit = events.iter().find(|e| e.ts == 1795508737035.0).unwrap();
    let counted: Vec<f64> = booked.window.intervals.iter().map(|i| debit.fraction_in(i.from_ms, i.to_ms)).filter(|f| *f > 0.0).collect();
    assert_eq!(counted, vec![1.0], "the record's $1.01 is in the value once");
}

#[test]
fn a_debit_settled_after_the_reset_joins_the_new_windows_first_rise() {
    // The record ran 20:54:09-20:57:32 across the 20:57:04 reset; 20:57:58 read 0.11 once, 21:02:58 read 1.00 before
    // the next record began at 21:05:51.
    let booked = book(five_hour_windows().remove(3), &records(), &[]);

    assert_points(split(&booked), (1.0, 0.0, 0.0));
    let rises: Vec<(f64, f64, f64)> = booked.window.intervals.iter().map(|i| (i.from_ms, i.to_ms, i.points)).collect();
    assert_eq!(rises.len(), 1, "{rises:?}");
    assert!(rises[0].0 == W2_RESET && rises[0].1 == 1795521778359.0 && (rises[0].2 - 1.0).abs() < 1e-9, "{rises:?}");
}

#[test]
fn a_meter_swinging_around_its_last_rise_between_requests_books_nothing() {
    // 27.90 at 19:26:53, then ten idle readings between 26.21 and 28.25, then Mixdog's 33.22 at 20:32:58.
    let booked = book(read_at(five_hour_windows().remove(2), 1795519978132.0), &records(), &[]);

    assert_points(split(&booked), (33.22, 0.0, 0.0));
    let rise = booked.window.intervals.last().unwrap();
    assert_eq!((rise.from_ms, rise.to_ms), (1795519678376.0, 1795519978132.0));
    assert!((rise.points - (33.22 - 27.90)).abs() < 1e-9, "{rise:?}");
}

#[test]
fn a_meter_drifting_up_within_its_jitter_band_between_requests_books_nothing() {
    let windows = five_hour_windows();
    assert!(windows.iter().all(|w| (w.jitter - (28.25 - 26.21)).abs() < 1e-9), "the band is the series' deepest fall");
    // 14.42 at 17:31:52, then idle readings drifting up to 15.57 at 18:26:52.
    let ended_idle = book(read_at(windows[2].clone(), 1795512412959.0), &records(), &[]);
    let resumed = book(windows[2].clone(), &records(), &[]);

    assert_points(split(&ended_idle), (14.42, 0.0, 0.0));
    assert_points(split(&resumed), (48.06, 0.0, 0.0));
}

#[test]
fn an_idle_drift_past_the_jitter_band_is_outside_by_its_excess_and_unattributed_by_the_band() {
    // 83.61 settled at 11:56:41-12:01:42, then idle readings up to 86.12 at 12:56:42: 2.51 points.
    let window = five_hour_windows().remove(1);

    let wide = book(Instance { jitter: 3.14, ..window.clone() }, &records(), &[]);
    let narrow = book(Instance { jitter: 2.04, ..window }, &records(), &[]);

    assert_points(split(&wide), (100.0, 0.0, 0.0));
    assert_points(split(&narrow), (97.49, 0.47, 2.04));
    let next = narrow.window.intervals.iter().find(|i| i.from_ms == 1795492602541.0).unwrap();
    assert!((next.points - (94.16 - 86.12)).abs() < 1e-9, "Mixdog's next rise counts from the drift: {next:?}");
}

#[test]
fn use_before_the_first_request_is_outside_past_the_jitter_band() {
    // Idle readings from 07:34 rose to 8.68 and settled at 8.39; Mixdog's first record ran 09:40:35-09:41:57.
    let booked = book(read_at(five_hour_windows().remove(0), 1795481037134.0), &records(), &[]);

    assert_points(split(&booked), (9.96 - 8.39, 8.39 - 2.04, 2.04));
}

#[test]
fn a_rise_across_an_unmeasured_gap_after_an_unsettled_record_is_unattributed() {
    // 17:26:53 read 13.30 once after the record that ended 17:25:37; the next reading came at 19:30:00.
    let events: Vec<Event> = records().into_iter().filter(|e| e.ts <= 1795508813098.0).collect();
    let before = book(read_at(five_hour_windows().remove(2), 1795508813098.0), &events, &[]);
    let mut window = read_at(five_hour_windows().remove(2), 1795508813098.0);
    window.rows.push(Row { ts: 1795516200000.0, until: 1795516200000.0, used_pct: 40.0, reset_at: Some(W2_RESET), rolling: false });

    let after = book(window, &events, &[]);

    assert_points(split(&after), (before.mixdog, 0.0, 40.0 - 13.30));
    let gap = after.window.intervals.last().unwrap();
    assert!(gap.total == 0.0 && !is_value_evidence(gap), "{gap:?}");
    let value = |b: &Booked| b.window.estimate.as_ref().map(|e| (e.cost_per_percent, e.samples));
    assert_eq!(value(&after), value(&before));
}

#[test]
fn a_rise_after_a_reading_a_later_poll_confirmed_is_outside() {
    // A meter that does not move on its own: the record ended at minute 8, minute 10 read 1.0.
    let events = vec![record(START + 8.0 * MIN_MS, 5.0 * MIN_MS, 1.0)];
    let confirmed = window(vec![Row { until: START + 15.0 * MIN_MS, ..row(10.0, 1.0) }, row(20.0, 2.0)]);
    let read_once = window(vec![row(10.0, 1.0), row(20.0, 2.0)]);

    assert_points(split(&book(confirmed, &events, &[])), (1.0, 1.0, 0.0));
    assert_points(split(&book(read_once, &events, &[])), (2.0, 0.0, 0.0));
}

#[test]
fn a_one_point_meter_settles_a_debit_a_reading_late() {
    // Grok's weekly meter on 2026-10-22: 5 at 03:03:57 and 6 at 03:08:57, each read once, around the record that
    // ended 03:06:57; 7 at 03:13:57 with no record running since.
    let reset = 1792934628740.0;
    let rows = vec![
        Row { ts: 1792605837032.0, until: 1792605837032.0, used_pct: 5.0, reset_at: Some(reset), rolling: false },
        Row { ts: 1792606137023.0, until: 1792606137023.0, used_pct: 6.0, reset_at: Some(reset), rolling: false },
        Row { ts: 1792606437023.0, until: 1792653277497.0, used_pct: 7.0, reset_at: Some(reset), rolling: false },
    ];
    // Opened when the 4 before it was last read.
    let window = Instance { start_ms: 1792605537036.0, end_ms: reset, rows, ..Default::default() };
    let mut events: Vec<Event> = [1792605552743.0, 1792605555776.0, 1792605818892.0, 1792605822394.0, 1792605831511.0, 1792605839192.0]
        .into_iter()
        .map(|ts| record(ts, 0.0, 0.702))
        .collect();
    events.push(record(1792606017783.0, 4672.0, 0.046304));

    let booked = book(window, &events, &[]);

    assert_points(split(&booked), (7.0, 0.0, 0.0));
    let rise = booked.window.intervals.last().unwrap();
    assert!(rise.to_ms == 1792606437023.0 && (rise.points - 2.0).abs() < 1e-9 && rise.total > 0.0, "{rise:?}");
}

#[test]
fn a_rolling_meter_has_no_jitter_band_and_each_rise_after_a_fall_counts() {
    let reset = START + 5.0 * HOUR_MS;
    let rows: Vec<Row> = [(10.0, 3.0), (20.0, 1.0), (30.0, 2.5)]
        .into_iter()
        .map(|(minutes, used_pct)| Row { reset_at: Some(reset), rolling: true, ..row(minutes, used_pct) })
        .collect();
    let window = quota_instances(&rows, "5H", START + HOUR_MS).remove(0);
    assert_eq!(window.jitter, 0.0, "a fall is use leaving the window");

    let booked = book(window, &[record(START + 10.0 * MIN_MS, 10.0 * MIN_MS, 1.0)], &[]);

    assert_points(split(&booked), (3.0, 1.5, 0.0));
}

#[test]
fn a_weekly_rise_takes_its_five_hour_companions_split() {
    let events = records();
    let finer: Vec<Interval> = five_hour_windows().iter().flat_map(|w| window_intervals(w, &events, &[])).collect();
    let week = quota_instances(&readings(&WEEK, WEEK_RESET), "7D", NOW).remove(0);
    assert!((week.jitter - (41.99 - 39.26)).abs() < 1e-9, "{}", week.jitter);

    let booked = book(week, &events, &finer);

    assert!((booked.outside - 0.37).abs() < 1e-9 && (booked.unattributed - 2.73).abs() < 1e-9, "{} {}", booked.outside, booked.unattributed);
    let in_w2: Vec<&Interval> = booked.window.intervals.iter().filter(|i| i.to_ms > W2_RESET - 5.0 * HOUR_MS).collect();
    assert!(!in_w2.is_empty() && in_w2.iter().all(|i| i.external == 0.0 && i.unattributed == 0.0), "{in_w2:?}");

    // A five-hour stretch past its band, inside a weekly rise Mixdog's records ran through.
    let mut five = window(vec![Row { until: START + 12.0 * MIN_MS, ..row(10.0, 2.0) }, row(20.0, 3.0), row(30.0, 5.0), row(40.0, 6.0)]);
    five.jitter = 1.0;
    let events = vec![record(START + 10.0 * MIN_MS, 10.0 * MIN_MS, 1.0), record(START + 40.0 * MIN_MS, 5.0 * MIN_MS, 1.0)];
    let finer = window_intervals(&five, &events, &[]);

    let booked = book(window(vec![row(60.0, 3.0)]), &events, &finer);

    let rise = &booked.window.intervals[0];
    assert!((rise.external - 1.0).abs() < 1e-9 && (rise.unattributed - 0.5).abs() < 1e-9, "{rise:?}");
    assert!(!is_value_evidence(rise));
    assert_points(split(&booked), (1.5, 1.0, 0.5));
}

#[test]
fn a_meter_climbing_with_no_record_running_books_each_day_what_it_rose_that_day() {
    let conn = recorded_ledger("7D", &CLAUDE_WEEK, CLAUDE_WEEK_RESET, &[CLAUDE_RECORD]);
    // Local midnights (UTC+9) of 2026-10-04, -05, -07 and -08.
    let outside = |from_ms: f64, to_ms: f64| read_quota_history(&conn, &period("7D", from_ms, to_ms), 1791600000000).unwrap()["summary"]["outside"].as_f64();

    // 2 % to 10 % by 21:56, and the part before midnight of the climb to the 56 % read at 20:39 on the 6th.
    assert_eq!(outside(1791039600000.0, 1791126000000.0), Some(11.02));
    // Part of the 1 % from 56 % to the 57 % read at 19:31 on the 7th: the rest ran on the 6th.
    assert_eq!(outside(1791298800000.0, 1791385200000.0), Some(0.85));
}

#[test]
fn a_jittery_stretch_books_its_points_where_its_readings_rose_and_none_on_its_flat_tail() {
    let events = records();
    let finer: Vec<Interval> = five_hour_windows().iter().flat_map(|w| window_intervals(w, &events, &[])).collect();
    // The weekly meter rose to 3.10 % by 08:53:17 before Mixdog's first record, then wavered at or below it to 09:28:15.
    let week = quota_instances(&readings(&WEEK, WEEK_RESET), "7D", NOW).remove(0);

    let booked = book(week, &events, &finer);

    let stretch: Vec<(f64, f64, f64)> = booked.window.intervals.iter().filter(|i| i.total == 0.0).map(|i| (i.from_ms, i.to_ms, i.points)).collect();
    let highs = [
        (WEEK_RESET - 7.0 * 24.0 * HOUR_MS, 0.0),
        (1795473241975.0, 0.01),
        (1795473597038.0, 1.2),
        (1795473896971.0, 2.01),
        (1795476898105.0, 2.85),
        (1795477197243.0, 3.06),
        (1795478397765.0, 3.1),
    ];
    let rises: Vec<(f64, f64, f64)> = highs.windows(2).map(|pair| (pair[0].0, pair[1].0, pair[1].1 - pair[0].1)).collect();
    assert_eq!(stretch.len(), rises.len(), "{stretch:?}");
    for (step, read) in stretch.iter().zip(&rises) {
        assert!(step.0 == read.0 && step.1 == read.1 && (step.2 - read.2).abs() < 1e-9, "{stretch:?}");
    }
}

#[test]
fn points_the_readings_cannot_assign_are_their_own_layer_of_the_chart() {
    let records: Vec<(f64, f64)> = RECORDS.iter().map(|&(ts, span_ms, _)| (ts as f64, span_ms)).collect();
    let conn = recorded_ledger("7D", &WEEK, WEEK_RESET, &records);
    // The weekly window's first three and a half hours: 0.37 % outside and 2.73 % unattributed before Mixdog's first
    // record, up to 09:30.
    let history = read_quota_history(&conn, &period("7D", WEEK_RESET - 7.0 * 24.0 * HOUR_MS, 1795480200000.0), NOW as i64).unwrap();

    let layers: Vec<(String, Option<String>, f64)> = history["modelSeries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let last = s["points"].as_array().unwrap().last().unwrap()[1].as_f64().unwrap();
            (s["key"].as_str().unwrap().to_string(), s["part"].as_str().map(str::to_string), last)
        })
        .collect();
    assert_eq!(layers, vec![(String::new(), Some("outside".into()), 0.37), (String::new(), Some("unattributed".into()), 2.73)]);
}

#[test]
fn a_rolling_window_stays_one_window_as_its_use_ages_out_and_its_reset_slides() {
    // Muse Code's five-hour rolling meter: Mixdog's use from t0 took it to 40 %; five hours on, the oldest of it had aged
    // out to 25 % and the reset had moved on twenty minutes; new use took it to 30 %.
    let t0 = 1_795_500_000_000.0;
    let at = |minutes: f64| t0 + minutes * MIN_MS;
    let mut conn = ledger(&[(at(10.0), 10.0 * MIN_MS), (at(30.0), 10.0 * MIN_MS), (at(315.0), 10.0 * MIN_MS)]);
    let polls = [(10.0, 10.0, 300.0), (30.0, 40.0, 300.0), (305.0, 25.0, 320.0), (320.0, 30.0, 320.0)];
    record_quota_samples(&mut conn, &polls.map(|(minutes, used_pct, reset)| reading("5H", true, at(minutes), used_pct, at(reset)))).unwrap();
    let now = at(360.0) as i64;
    let windows = QuotaWindowsQuery { provider: "prov".into(), account: "acc".into(), label: "5H".into(), in_use: BTreeMap::new(), page: 0.0 };
    let latest = QuotaHistoryQuery { provider: "prov".into(), account: "acc".into(), label: "5H".into(), ..QuotaHistoryQuery::default() };

    let page = read_quota_windows(&conn, &windows, now).unwrap();
    let history = read_quota_history(&conn, &latest, now).unwrap();

    assert_eq!(page["windows"].as_array().unwrap().len(), 1, "{page}");
    let summary = &history["summary"];
    assert_eq!((summary["consumed"].as_f64(), summary["outside"].as_f64()), (Some(10.0 + 30.0 + 5.0), Some(0.0)), "{summary}");
}
