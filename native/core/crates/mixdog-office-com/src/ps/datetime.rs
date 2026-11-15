//! A COM `VT_DATE` as the text the PowerShell hosts write for a date.
//!
//! A date property of an Office object arrives in PowerShell as a `[DateTime]` of `Kind` `Unspecified` (the OLE automation
//! date read as local time); the hosts write `$date.ToUniversalTime().ToString('o')`, for example
//! `2026-09-12T03:04:05.0000000Z`. [`oa_date_to_ticks`] is `DateTime.FromOADate` of .NET Framework, [`local_ticks_to_utc_ticks`]
//! is `ToUniversalTime()` through the Win32 time zone call (the dynamic time zone of the machine, so its daylight saving
//! rules and their history are the Windows ones, as in .NET Framework) and [`round_trip_text`] is `ToString('o')`.

/// Ticks (100 ns) in a day.
const TICKS_PER_DAY: i64 = 864_000_000_000;
const TICKS_PER_MS: i64 = 10_000;
const MS_PER_DAY: i64 = 86_400_000;
/// `DateTime.MaxValue.Ticks + 1`: 9999-12-31 plus one day, in ticks.
const MAX_TICKS: i64 = 3_652_059 * TICKS_PER_DAY;
/// Days from 0001-01-01 to 1970-01-01.
const DAYS_TO_1970: i64 = 719_162;
/// The OLE automation date 0 (1899-12-30) in milliseconds since 0001-01-01 (`DaysTo1899` days).
const OA_EPOCH_MS: i64 = 693_593 * MS_PER_DAY;

/// `[DateTime]::FromOADate($value).Ticks`. The error texts are those of .NET Framework.
pub fn oa_date_to_ticks(value: f64) -> Result<i64, String> {
    // A NaN fails both comparisons in C#, where (long)NaN is long.MinValue and the date is refused as out of range.
    if value >= 2_958_466.0 || value <= -657_435.0 || value.is_nan() {
        return Err(from_oa_date_error("Not a legal OleAut date."));
    }
    let mut millis = (value * MS_PER_DAY as f64 + if value >= 0.0 { 0.5 } else { -0.5 }) as i64;
    if millis < 0 {
        millis -= (millis % MS_PER_DAY) * 2;
    }
    millis += OA_EPOCH_MS;
    if millis < 0 || millis > MAX_TICKS / TICKS_PER_MS {
        return Err(from_oa_date_error("OleAut date did not convert to a DateTime correctly."));
    }
    Ok(millis * TICKS_PER_MS)
}

/// The text PowerShell gives an exception of the .NET method: `Exception calling "FromOADate" with "1" argument(s): "..."`.
fn from_oa_date_error(reason: &str) -> String {
    format!("Exception calling \"FromOADate\" with \"1\" argument(s): \"{reason}\"")
}

/// A calendar date and time of day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Civil {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    /// The ticks below the second (0 to 9,999,999).
    pub subsecond_ticks: u32,
}

/// The proleptic Gregorian calendar date and time of day of `ticks` since 0001-01-01.
pub fn civil_from_ticks(ticks: i64) -> Civil {
    let days = ticks.div_euclid(TICKS_PER_DAY);
    let in_day = ticks.rem_euclid(TICKS_PER_DAY);
    // Howard Hinnant's civil_from_days over days since 1970-01-01.
    let z = days - DAYS_TO_1970 + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let seconds = in_day / 10_000_000;
    Civil {
        year: year as i32,
        month: month as u32,
        day: day as u32,
        hour: (seconds / 3_600) as u32,
        minute: ((seconds / 60) % 60) as u32,
        second: (seconds % 60) as u32,
        subsecond_ticks: (in_day % 10_000_000) as u32,
    }
}

/// The ticks since 0001-01-01 of a calendar date and time of day (months 1 to 12, days valid for the month).
pub fn ticks_from_civil(civil: &Civil) -> i64 {
    let year = i64::from(civil.year) - i64::from(civil.month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let shifted_month = i64::from(if civil.month > 2 { civil.month - 3 } else { civil.month + 9 });
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(civil.day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468 + DAYS_TO_1970;
    let seconds = i64::from(civil.hour) * 3_600 + i64::from(civil.minute) * 60 + i64::from(civil.second);
    days * TICKS_PER_DAY + seconds * 10_000_000 + i64::from(civil.subsecond_ticks)
}

/// `$date.ToString('o')` for a date of `Kind` `Unspecified` (no suffix) or `Utc` (`Z`): `2026-09-12T03:04:05.0000000Z`.
pub fn round_trip_text(ticks: i64, utc: bool) -> String {
    let civil = civil_from_ticks(ticks);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:07}{}",
        civil.year,
        civil.month,
        civil.day,
        civil.hour,
        civil.minute,
        civil.second,
        civil.subsecond_ticks,
        if utc { "Z" } else { "" }
    )
}

/// `$date.ToUniversalTime()` of a date of `Kind` `Unspecified` or `Local`, as ticks. Windows converts through the machine's
/// dynamic time zone. A date before 1601 is refused by the Windows call; there the zone's base offset applies, as in .NET.
#[cfg(windows)]
pub fn local_ticks_to_utc_ticks(ticks: i64) -> Result<i64, String> {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::Time::DYNAMIC_TIME_ZONE_INFORMATION;
    use windows_sys::Win32::System::Time::GetDynamicTimeZoneInformation;
    use windows_sys::Win32::System::Time::TzSpecificLocalTimeToSystemTimeEx;

    /// `TIME_ZONE_ID_INVALID`.
    const TIME_ZONE_ID_INVALID: u32 = 0xFFFF_FFFF;

    let civil = civil_from_ticks(ticks);
    let sub_millisecond = i64::from(civil.subsecond_ticks) % TICKS_PER_MS;
    let local = SYSTEMTIME {
        wYear: u16::try_from(civil.year).map_err(|_| "The date is outside the range of the Windows time zone call.".to_string())?,
        wMonth: civil.month as u16,
        wDayOfWeek: 0,
        wDay: civil.day as u16,
        wHour: civil.hour as u16,
        wMinute: civil.minute as u16,
        wSecond: civil.second as u16,
        wMilliseconds: (civil.subsecond_ticks / TICKS_PER_MS as u32) as u16,
    };
    // SAFETY: both structs are plain data, fully written by Windows before they are read; the pointers are to locals.
    let mut zone: DYNAMIC_TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    let id = unsafe { GetDynamicTimeZoneInformation(&mut zone) };
    if id == TIME_ZONE_ID_INVALID {
        return Err("The machine's time zone could not be read.".to_string());
    }
    let mut universal: SYSTEMTIME = unsafe { std::mem::zeroed() };
    let converted = unsafe { TzSpecificLocalTimeToSystemTimeEx(&zone, &local, &mut universal) };
    if converted == 0 && civil.year < 1601 {
        // Before the first year Windows has time zone rules for, .NET's `ToUniversalTime` applies the zone's base offset
        // (the standard bias: UTC = local + Bias minutes).
        // `DateTime.MinValue` and `MaxValue` bound the result, as .NET bounds it.
        return Ok((ticks + i64::from(zone.Bias) * 60 * 10_000_000).clamp(0, 3_155_378_975_999_999_999));
    }
    if converted == 0 {
        return Err("The date could not be converted to universal time.".to_string());
    }
    let utc = Civil {
        year: i32::from(universal.wYear),
        month: u32::from(universal.wMonth),
        day: u32::from(universal.wDay),
        hour: u32::from(universal.wHour),
        minute: u32::from(universal.wMinute),
        second: u32::from(universal.wSecond),
        subsecond_ticks: u32::from(universal.wMilliseconds) * TICKS_PER_MS as u32,
    };
    Ok(ticks_from_civil(&utc) + sub_millisecond)
}

/// The time zone call exists on Windows only; Office is Windows-only too, so no host runs elsewhere.
#[cfg(not(windows))]
pub fn local_ticks_to_utc_ticks(_ticks: i64) -> Result<i64, String> {
    Err("Microsoft Office COM is available on Windows only".to_string())
}

/// What the hosts write for a `VT_DATE` value: `[DateTime]::FromOADate($value).ToUniversalTime().ToString('o')`.
pub fn oa_date_to_utc_text(value: f64) -> Result<String, String> {
    let local = oa_date_to_ticks(value)?;
    Ok(round_trip_text(local_ticks_to_utc_ticks(local)?, true))
}

/// `[DateTime]::FromOADate($value).ToString('o')`: the date as read, without a zone.
pub fn oa_date_to_local_text(value: f64) -> Result<String, String> {
    Ok(round_trip_text(oa_date_to_ticks(value)?, false))
}
