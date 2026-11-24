use jiff::civil::Time;
use jiff::tz::{AmbiguousOffset, TimeZone};
use jiff::{Timestamp, ToSpan};
use serde::{Deserialize, Serialize};

pub const MAX_INTERVAL_MINUTES: i64 = 43_200;
const MINUTE_MS: i64 = 60_000;

/// ISO weekdays run from Monday (1) through Sunday (7).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Rule {
    Interval {
        minutes: i64,
    },
    Weekly {
        weekdays: Vec<u8>,
        time: String,
        time_zone: String,
    },
    Once {
        at: i64,
    },
}

impl Rule {
    pub fn interval_minutes(&self) -> Option<i64> {
        match self {
            Self::Interval { minutes } => Some(*minutes),
            _ => None,
        }
    }

    pub fn is_once(&self) -> bool {
        matches!(self, Self::Once { .. })
    }

    /// Return the first occurrence strictly after the given UTC epoch milliseconds.
    pub fn next_after(&self, after: i64) -> Option<i64> {
        match self {
            Self::Interval { minutes } if (1..=MAX_INTERVAL_MINUTES).contains(minutes) => {
                after.checked_add(minutes * MINUTE_MS)
            }
            Self::Interval { .. } => None,
            Self::Weekly {
                weekdays,
                time,
                time_zone,
            } => {
                if !(1..=7).contains(&weekdays.len())
                    || weekdays.iter().enumerate().any(|(index, day)| {
                        !(1..=7).contains(day) || weekdays[..index].contains(day)
                    })
                {
                    return None;
                }
                if !matches!(
                    time.as_bytes(),
                    [b'0'..=b'9', b'0'..=b'9', b':', b'0'..=b'9', b'0'..=b'9']
                ) {
                    return None;
                }
                let zone = TimeZone::get(time_zone).ok()?;
                let wall_time = Time::strptime("%H:%M", time).ok()?;
                let after = Timestamp::from_millisecond(after).ok()?;
                let local_date = zone.to_datetime(after).date();
                // A weekly occurrence may be skipped during a clock change.
                for offset in 0..=14 {
                    let date = local_date.checked_add(offset.days()).ok()?;
                    if !weekdays.contains(&(date.weekday().to_monday_one_offset() as u8)) {
                        continue;
                    }
                    let instant = zone.to_ambiguous_timestamp(date.to_datetime(wall_time));
                    if matches!(instant.offset(), AmbiguousOffset::Gap { .. }) {
                        continue;
                    }
                    let instant = instant.earlier().ok()?;
                    if instant > after {
                        return Some(instant.as_millisecond());
                    }
                }
                None
            }
            Self::Once { at } if *at > after => Timestamp::from_millisecond(*at).ok().map(|_| *at),
            Self::Once { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch(s: &str) -> i64 {
        s.parse::<Timestamp>().unwrap().as_millisecond()
    }

    fn weekly(weekdays: Vec<u8>, time: &str, zone: &str) -> Rule {
        Rule::Weekly {
            weekdays,
            time: time.into(),
            time_zone: zone.into(),
        }
    }

    #[test]
    fn interval_bounds_and_one_time_occurrence() {
        assert_eq!(
            Rule::Interval { minutes: 1440 }.next_after(10),
            Some(86_400_010)
        );
        assert_eq!(Rule::Interval { minutes: 0 }.next_after(10), None);
        assert_eq!(Rule::Interval { minutes: 43_201 }.next_after(10), None);
        assert_eq!(Rule::Once { at: 200 }.next_after(199), Some(200));
        assert_eq!(Rule::Once { at: 200 }.next_after(200), None);
    }

    #[test]
    fn weekly_selects_local_weekdays_and_rolls_over() {
        let rule = weekly(vec![1, 7], "09:30", "Asia/Shanghai");
        let sunday = epoch("2026-11-29T01:30:00Z");
        assert_eq!(rule.next_after(sunday - 1), Some(sunday));
        assert_eq!(rule.next_after(sunday), Some(epoch("2026-11-30T01:30:00Z")));
        for invalid in [
            weekly(vec![], "09:30", "UTC"),
            weekly(vec![1, 0], "09:30", "UTC"),
            weekly(vec![1], "24:00", "UTC"),
            weekly(vec![1], "09:30", "unknown"),
        ] {
            assert_eq!(invalid.next_after(sunday), None);
        }
    }

    #[test]
    fn weekly_handles_clock_changes_without_duplicate_runs() {
        let rule = weekly(vec![7], "02:30", "Europe/Berlin");
        assert_eq!(
            rule.next_after(epoch("2026-03-28T00:00:00Z")),
            Some(epoch("2026-04-05T00:30:00Z"))
        );
        let early = epoch("2026-10-25T00:30:00Z");
        assert_eq!(rule.next_after(early - 1), Some(early));
        assert_eq!(rule.next_after(early), Some(epoch("2026-11-01T01:30:00Z")));
    }
}
