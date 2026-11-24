use anser_core::{api::Page, schedule::Rule};
use serde::Serialize;
use sqlx::types::Json;

use crate::queue::{Submission, enqueue_one};
use crate::{DataError, Result, Store, affected, manage, new_id, now_ms};

const SCHEDULE_KEY: &str = "system-scheduled-tasks";
#[derive(Serialize, sqlx::FromRow)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub plugin_id: String,
    pub topic: Option<String>,
    pub interval_minutes: Option<i64>,
    #[sqlx(json)]
    pub rule: Rule,
    pub enabled: bool,
    pub completed: bool,
    pub next_at: Option<i64>,
    pub last_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_count: u32,
}

pub struct NewSchedule<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub plugin_id: &'a str,
    pub encrypted_input: &'a [u8],
    pub topic: Option<&'a str>,
    pub rule: &'a Rule,
    pub next_at: i64,
}

pub struct ScheduleEdit<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub plugin_id: &'a str,
    pub topic: Option<&'a str>,
    pub expected_input: &'a [u8],
    pub encrypted_input: Option<&'a [u8]>,
    pub timing: Option<(&'a Rule, i64)>,
}

#[derive(sqlx::FromRow)]
pub struct ScheduledRun {
    pub id: String,
    pub plugin_id: String,
    pub encrypted_input: Vec<u8>,
    token: String,
}

impl Store {
    pub async fn schedules(&self, after: &str, limit: u32) -> Result<Page<Schedule>> {
        let mut rows =
            sqlx::query_as("SELECT * FROM scheduled_task_views WHERE id>? ORDER BY id LIMIT ?")
                .bind(after)
                .bind(i64::from(limit) + 1)
                .fetch_all(&self.0)
                .await?;
        Ok(manage::page(&mut rows, limit, |row: &Schedule| &row.id))
    }

    pub async fn create_schedule(&self, item: NewSchedule<'_>) -> Result<Schedule> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let topic_id = if let Some(name) = item.topic {
            Some(manage::topic(&mut tx, name).await?.id)
        } else {
            None
        };
        sqlx::query("INSERT INTO scheduled_tasks(id,name,plugin_id,encrypted_input,topic_id,interval_minutes,next_at,rule) VALUES(?,?,?,?,?,?,?,?)")
            .bind(item.id).bind(item.name).bind(item.plugin_id).bind(item.encrypted_input)
            .bind(topic_id).bind(item.rule.interval_minutes().unwrap_or(1)).bind(item.next_at)
            .bind(Json(item.rule)).execute(&mut *tx).await?;
        let result = sqlx::query_as("SELECT * FROM scheduled_task_views WHERE id=?")
            .bind(item.id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn schedule_detail(&self, id: &str) -> Result<(Schedule, Vec<u8>)> {
        let mut tx = self.0.begin().await?;
        let schedule = sqlx::query_as("SELECT * FROM scheduled_task_views WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(DataError::Missing)?;
        let encrypted =
            sqlx::query_scalar("SELECT encrypted_input FROM scheduled_tasks WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        Ok((schedule, encrypted))
    }

    pub async fn edit_schedule(&self, edit: ScheduleEdit<'_>) -> Result<Schedule> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let topic_id = if let Some(name) = edit.topic {
            Some(manage::topic(&mut tx, name).await?.id)
        } else {
            None
        };
        let (rule, next_at) = edit.timing.unzip();
        let result = sqlx::query(
            "UPDATE scheduled_tasks SET name=?,plugin_id=?,topic_id=?,
             encrypted_input=coalesce(?,encrypted_input),
             interval_minutes=coalesce(?,interval_minutes),rule=coalesce(?,rule),
             next_at=coalesce(?,next_at),
             enabled=CASE WHEN ? AND completed=1 THEN 1 ELSE enabled END,
             completed=CASE WHEN ? THEN 0 ELSE completed END,
             lease_token=NULL,lease_until=NULL
             WHERE id=? AND encrypted_input=? AND (lease_until IS NULL OR lease_until<=?)",
        )
        .bind(edit.name)
        .bind(edit.plugin_id)
        .bind(topic_id)
        .bind(edit.encrypted_input)
        .bind(rule.map(|rule| rule.interval_minutes().unwrap_or(1)))
        .bind(rule.map(Json))
        .bind(next_at)
        .bind(next_at.is_some())
        .bind(next_at.is_some())
        .bind(edit.id)
        .bind(edit.expected_input)
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() == 0 {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM scheduled_tasks WHERE id=?)")
                    .bind(edit.id)
                    .fetch_one(&mut *tx)
                    .await?;
            return Err(if exists {
                DataError::Conflict
            } else {
                DataError::Missing
            });
        }
        let schedule = sqlx::query_as("SELECT * FROM scheduled_task_views WHERE id=?")
            .bind(edit.id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(schedule)
    }

    pub async fn change_schedule(&self, id: &str, enabled: bool) -> Result<()> {
        let now = now_ms();
        affected(sqlx::query("UPDATE scheduled_tasks SET enabled=?,next_at=CASE WHEN enabled=0 AND ? THEN max(next_at,?) ELSE next_at END,
            lease_token=CASE WHEN ? THEN lease_token ELSE NULL END,lease_until=CASE WHEN ? THEN lease_until ELSE NULL END WHERE id=? AND completed=0")
            .bind(enabled).bind(enabled).bind(now).bind(enabled).bind(enabled).bind(id).execute(&self.0).await?.rows_affected())
    }

    pub async fn run_schedule_now(&self, id: &str) -> Result<()> {
        let now = now_ms();
        affected(sqlx::query("UPDATE scheduled_tasks SET next_at=? WHERE id=? AND enabled=1 AND completed=0 AND (lease_until IS NULL OR lease_until<=?)")
            .bind(now).bind(id).bind(now).execute(&self.0).await?.rows_affected())
    }

    pub async fn delete_schedule(&self, id: &str) -> Result<()> {
        affected(
            sqlx::query("DELETE FROM scheduled_tasks WHERE id=?")
                .bind(id)
                .execute(&self.0)
                .await?
                .rows_affected(),
        )
    }

    pub async fn claim_schedule(&self, now: i64) -> Result<Option<ScheduledRun>> {
        Ok(sqlx::query_as("UPDATE scheduled_tasks SET lease_token=?,lease_until=?
            WHERE id=(SELECT id FROM scheduled_tasks WHERE enabled=1 AND completed=0 AND next_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_at,id LIMIT 1)
            RETURNING id,plugin_id,encrypted_input,lease_token AS token")
            .bind(new_id()).bind(now.saturating_add(90_000)).bind(now).bind(now)
            .fetch_optional(&self.0).await?)
    }

    /// Commit every draft and the schedule's progress in the same write transaction.
    pub async fn finish_schedule(
        &self,
        run: &ScheduledRun,
        submissions: Vec<Submission>,
        error: Option<&str>,
    ) -> Result<bool> {
        let _writer = self.2.lock().await;
        let mut tx = self.0.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        let job: Option<(Option<String>, Json<Rule>)> = sqlx::query_as(
            "SELECT v.topic,v.rule FROM scheduled_tasks s JOIN scheduled_task_views v ON v.id=s.id
             WHERE s.id=? AND s.enabled=1 AND s.completed=0 AND s.lease_token=? AND s.lease_until>?",
        )
        .bind(&run.id)
        .bind(&run.token)
        .bind(now)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((topic, Json(rule))) = job else {
            return Ok(false);
        };
        let count = if error.is_none() {
            submissions.len()
        } else {
            0
        };
        if count != 0 {
            sqlx::query(
                "INSERT OR IGNORE INTO api_keys(id,secret_hash,name,scopes,enabled,created_at)
                      VALUES(?,zeroblob(32),'Scheduled tasks','[]',0,?)",
            )
            .bind(SCHEDULE_KEY)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            for mut item in submissions {
                item.key_id = SCHEDULE_KEY.into();
                item.topic.clone_from(&topic);
                enqueue_one(&mut tx, item).await?;
            }
        }
        let completed = rule.is_once();
        let next = if completed {
            None
        } else {
            Some(rule.next_after(now).ok_or(DataError::Batch)?)
        };
        sqlx::query(
            "UPDATE scheduled_tasks SET last_at=?,last_status=?,last_count=?,
            next_at=coalesce(?,next_at),enabled=?,completed=?,lease_token=NULL,lease_until=NULL WHERE id=?",
        )
        .bind(now)
        .bind(error.unwrap_or("success"))
        .bind(count as i64)
        .bind(next)
        .bind(!completed)
        .bind(completed)
        .bind(&run.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(count > 0)
    }
}

pub(crate) const RESERVED_SCHEDULE_KEY: &str = SCHEDULE_KEY;
