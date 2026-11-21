use super::*;
use AccountState::{Exhausted, PermanentFailure, Ready, Sending, Succeeded, Waiting};

fn candidate(account_id: &str, priority: i32, weight: u32) -> Candidate<'_> {
    Candidate {
        account_id,
        priority,
        weight,
        available: true,
    }
}

fn seconds(value: u64) -> Duration {
    Duration::from_secs(value)
}

#[test]
fn weighted_is_three_to_one_and_zero_is_a_fallback() {
    let candidates = [
        candidate("zero", 0, 0),
        candidate("three", 0, 3),
        candidate("one", 0, 1),
    ];
    let mut three_first = 0;
    for draw in 0..1000 {
        let order = plan_round(Mode::Weighted, &candidates, |bound| draw % bound);
        three_first += usize::from(order[0] == "three");
        assert_eq!(order[2], "zero");
        assert_ne!(order[0], order[1]);
    }
    assert_eq!(three_first, 750);
}

#[test]
fn weighted_failover_draws_first_then_uses_descending_weight() {
    let candidates = [
        candidate("zero", -1, 0),
        candidate("first", 1, 4),
        candidate("second", 0, 4),
        candidate("selected", 0, 1),
    ];
    assert_eq!(
        plan_round(Mode::WeightedFailover, &candidates, |_| 8),
        ["selected", "second", "first", "zero"]
    );
}

#[test]
fn failover_is_stable_and_excludes_duplicate_or_unavailable_accounts() {
    let candidates = [
        candidate("late", 5, 1),
        candidate("first", 1, 1),
        candidate("first", 0, 1),
        candidate("second", 1, 1),
        Candidate {
            available: false,
            ..candidate("disabled", 0, 1)
        },
    ];
    assert_eq!(
        plan_round(Mode::Failover, &candidates, |_| unreachable!()),
        ["first", "second", "late"]
    );
    let decision = decide(
        Mode::Failover,
        SuccessCriteria::Any,
        &[PermanentFailure, Ready],
        false,
        seconds(0),
        seconds(60),
    );
    assert_eq!(decision.send, [1]);
    let decision = decide(
        Mode::Failover,
        SuccessCriteria::Any,
        &[Succeeded, Ready],
        false,
        seconds(0),
        seconds(60),
    );
    assert_eq!(decision.status, RouteStatus::Success);
    assert!(decision.send.is_empty());
}

#[test]
fn broadcast_keeps_work_active_after_any_success() {
    let states = [Succeeded, Ready, Sending];
    let any = decide(
        Mode::Broadcast,
        SuccessCriteria::Any,
        &states,
        false,
        seconds(0),
        seconds(60),
    );
    let all = decide(
        Mode::Broadcast,
        SuccessCriteria::All,
        &states,
        false,
        seconds(0),
        seconds(60),
    );
    assert_eq!(any.status, RouteStatus::Success);
    assert_eq!(all.status, RouteStatus::Pending);
    assert_eq!(any.send, [1]);
    assert_eq!(
        decide(
            Mode::Broadcast,
            SuccessCriteria::All,
            &[Ready, Ready],
            false,
            seconds(0),
            seconds(60)
        )
        .send,
        [0, 1]
    );
}

#[test]
fn retry_rounds_skip_permanent_errors_and_stop_at_deadline() {
    let states = [Exhausted, PermanentFailure, Exhausted];
    let restart = decide(
        Mode::Weighted,
        SuccessCriteria::Any,
        &states,
        true,
        seconds(5),
        seconds(60),
    );
    assert_eq!(restart.restart, [0, 2]);
    let expired = decide(
        Mode::Weighted,
        SuccessCriteria::Any,
        &states,
        true,
        seconds(60),
        seconds(60),
    );
    assert_eq!(expired.status, RouteStatus::Dead);
    assert!(expired.restart.is_empty());
    let failed = decide(
        Mode::Weighted,
        SuccessCriteria::Any,
        &states,
        false,
        seconds(5),
        seconds(60),
    );
    assert_eq!(failed.status, RouteStatus::Failed);
}

#[test]
fn failover_waits_for_the_current_accounts_retry() {
    let states = [Waiting { until: seconds(30) }, Ready];
    let decision = decide(
        Mode::Failover,
        SuccessCriteria::Any,
        &states,
        true,
        seconds(5),
        seconds(60),
    );
    assert_eq!(decision.wake_at, Some(seconds(30)));
    assert!(decision.send.is_empty());
    let decision = decide(
        Mode::Failover,
        SuccessCriteria::Any,
        &states,
        true,
        seconds(30),
        seconds(60),
    );
    assert_eq!(decision.send, [0]);
}

#[test]
fn backoff_honors_attempt_limit_provider_delay_and_deadline() {
    let mut retry = RetryPolicy {
        max_attempts: NonZeroU32::new(5).unwrap(),
        backoff: Backoff::Exponential,
        base_delay: seconds(2),
        max_delay: seconds(6),
        jitter: false,
    };
    let attempt = |value| NonZeroU32::new(value).unwrap();
    assert_eq!(
        retry.retry_at(
            attempt(3),
            true,
            None,
            seconds(1),
            seconds(60),
            |_| unreachable!()
        ),
        Some(seconds(7))
    );
    assert_eq!(
        retry.retry_at(attempt(5), true, None, seconds(1), seconds(60), |_| 0),
        None
    );
    assert_eq!(
        retry.retry_at(attempt(1), false, None, seconds(1), seconds(60), |_| 0),
        None
    );
    retry.jitter = true;
    retry.backoff = Backoff::Fixed;
    assert_eq!(
        retry.retry_at(
            attempt(1),
            true,
            Some(seconds(8)),
            seconds(1),
            seconds(9),
            |_| 0
        ),
        None
    );
    assert_eq!(
        retry.retry_at(
            attempt(1),
            true,
            Some(seconds(8)),
            seconds(1),
            seconds(10),
            |_| 0
        ),
        Some(seconds(9))
    );
}
