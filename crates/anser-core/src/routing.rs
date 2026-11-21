//! Pure route selection and retry decisions. Persist a round's plan before
//! dispatch so a process restart cannot choose a different first account.

use std::collections::HashSet;
use std::num::{NonZeroU32, NonZeroU64};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Broadcast,
    Failover,
    Weighted,
    WeightedFailover,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SuccessCriteria {
    Any,
    All,
}

#[derive(Clone, Copy, Debug)]
pub struct Candidate<'a> {
    pub account_id: &'a str,
    pub priority: i32,
    pub weight: u32,
    pub available: bool,
}

/// Order one round with each available account at most once. The input is in
/// configuration order. `sample` returns a uniform draw below the supplied
/// bound. Zero-weight accounts participate only after positive weights.
pub fn plan_round<'a>(
    mode: Mode,
    candidates: &[Candidate<'a>],
    mut sample: impl FnMut(NonZeroU64) -> u64,
) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    let mut remaining: Vec<_> = candidates
        .iter()
        .filter(|target| target.available && seen.insert(target.account_id))
        .collect();
    let mut ordered = Vec::with_capacity(remaining.len());

    match mode {
        Mode::Broadcast => {}
        Mode::Failover => remaining.sort_by_key(|target| target.priority),
        Mode::Weighted | Mode::WeightedFailover => {
            while let Some(index) = weighted_index(&remaining, &mut sample) {
                ordered.push(remaining.remove(index).account_id);
                if mode == Mode::WeightedFailover {
                    break;
                }
            }
            // Keep configuration order for equal weights and priorities.
            remaining.sort_by_key(|target| (std::cmp::Reverse(target.weight), target.priority));
        }
    }
    ordered.extend(remaining.into_iter().map(|target| target.account_id));
    ordered
}

fn weighted_index(
    candidates: &[&Candidate<'_>],
    sample: &mut impl FnMut(NonZeroU64) -> u64,
) -> Option<usize> {
    let total = NonZeroU64::new(
        candidates
            .iter()
            .map(|target| u64::from(target.weight))
            .sum(),
    )?;
    let mut draw = sample(total) % total.get();
    candidates.iter().position(|target| {
        let weight = u64::from(target.weight);
        if draw < weight {
            true
        } else {
            draw -= weight;
            false
        }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AccountState {
    Ready,
    Sending,
    Waiting { until: Duration },
    Succeeded,
    Exhausted,
    PermanentFailure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteStatus {
    Pending,
    Success,
    Failed,
    Dead,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Decision {
    pub status: RouteStatus,
    /// Ready indices from the persisted plan. Broadcast can return several.
    pub send: Vec<usize>,
    /// Exhausted retryable indices to reset after backoff for another round.
    /// A sequential route should replan those candidates for its next round.
    pub restart: Vec<usize>,
    pub wake_at: Option<Duration>,
}

/// Returns the next actions from account states in persisted round order.
/// Times are elapsed from message creation and `deadline` already applies the
/// message expiry, policy TTL and configured global ceiling.
pub fn decide(
    mode: Mode,
    criteria: SuccessCriteria,
    states: &[AccountState],
    until_success: bool,
    now: Duration,
    deadline: Duration,
) -> Decision {
    use AccountState::{Exhausted, Ready, Sending, Succeeded, Waiting};

    let sequential = mode != Mode::Broadcast;
    let any_success = states.contains(&Succeeded);
    let succeeded = !states.is_empty()
        && if sequential || criteria == SuccessCriteria::Any {
            any_success
        } else {
            states.iter().all(|state| *state == Succeeded)
        };
    let mut decision = Decision {
        status: if succeeded {
            RouteStatus::Success
        } else {
            RouteStatus::Pending
        },
        send: Vec::new(),
        restart: Vec::new(),
        wake_at: None,
    };
    if sequential && succeeded {
        return decision;
    }
    if now >= deadline {
        if !succeeded {
            decision.status = RouteStatus::Dead;
        }
        return decision;
    }

    let mut work_pending = false;
    for (index, state) in states.iter().enumerate() {
        match *state {
            Ready => {
                decision.send.push(index);
                work_pending = true;
            }
            Waiting { until } if until <= now => {
                decision.send.push(index);
                work_pending = true;
            }
            Waiting { until } => {
                decision.wake_at = Some(decision.wake_at.map_or(until, |wake| until.min(wake)));
                work_pending = true;
            }
            Sending => work_pending = true,
            Exhausted if until_success => decision.restart.push(index),
            _ => {}
        }
        if sequential && work_pending {
            decision.restart.clear();
            break;
        }
    }

    if !decision.restart.is_empty() {
        work_pending = true;
    }
    if work_pending {
        decision.wake_at = Some(decision.wake_at.map_or(deadline, |wake| deadline.min(wake)));
    } else if !succeeded {
        decision.status = RouteStatus::Failed;
    }

    decision
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Backoff {
    Fixed,
    Exponential,
}

#[derive(Clone, Copy, Debug)]
pub struct RetryPolicy {
    pub max_attempts: NonZeroU32,
    pub backoff: Backoff,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub jitter: bool,
}

impl RetryPolicy {
    /// Uses the failed attempt number starting at one. A provider's retry-after
    /// is a minimum. Once the deadline cannot accommodate it, no retry is due.
    pub fn retry_at(
        self,
        attempt: NonZeroU32,
        retryable: bool,
        provider_delay: Option<Duration>,
        now: Duration,
        deadline: Duration,
        mut sample: impl FnMut(NonZeroU64) -> u64,
    ) -> Option<Duration> {
        if !retryable || attempt >= self.max_attempts {
            return None;
        }
        let delay = match self.backoff {
            Backoff::Fixed => self.base_delay,
            Backoff::Exponential => {
                if self.base_delay.is_zero() {
                    Duration::ZERO
                } else {
                    let mut delay = self.base_delay;
                    // Even one nanosecond doubled 95 times exceeds Duration::MAX.
                    for _ in 1..attempt.get().min(96) {
                        delay = delay.saturating_mul(2);
                        if delay >= self.max_delay {
                            break;
                        }
                    }
                    delay
                }
            }
        }
        .min(self.max_delay);
        let delay = if self.jitter {
            // Full jitter in [0, delay], sampled in milliseconds.
            let upper = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
            let bound = NonZeroU64::new(upper.saturating_add(1)).expect("bound is at least one");
            Duration::from_millis(sample(bound) % bound.get())
        } else {
            delay
        };
        let due = now.saturating_add(delay.max(provider_delay.unwrap_or_default()));
        (due < deadline).then_some(due)
    }
}

#[cfg(test)]
mod tests;
