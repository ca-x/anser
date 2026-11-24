//! Visibility checks and atomic edits for notification templates.

use anser_core::Message;
use anser_core::api::Page;
use anser_core::template::{Error, Format, Reference, Source, Usage, valid_name};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select};
use serde::Serialize;
use sqlx::SqliteConnection;

use crate::entities::notification_template as entity;
use crate::{DataError, Result, Store, affected, manage, new_id, now_ms};

#[derive(Serialize)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub title: String,
    pub body: String,
    pub format: Format,
    pub variables: Vec<String>,
    pub shared: bool,
    pub builtin: bool,
    pub can_edit: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct Definition {
    pub name: String,
    pub title: String,
    pub body: String,
    pub format: Format,
    pub shared: Option<bool>,
}

impl Definition {
    fn validate(&self) -> Result<()> {
        if !valid_name(&self.name) || self.name.starts_with("builtin.") {
            return Err(Error::Definition.into());
        }
        Source {
            title: &self.title,
            body: &self.body,
            format: self.format,
        }
        .variables()?;
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub struct Access<'a> {
    pub owner: Option<&'a str>,
    pub admin: bool,
}

impl Store {
    pub async fn templates(
        &self,
        access: Access<'_>,
        after: &str,
        limit: u32,
    ) -> Result<Page<Template>> {
        use entity::Column as C;
        let mut values = visible(access.owner)
            .filter(C::Id.gt(after))
            .order_by_asc(C::Id)
            .limit(u64::from(limit) + 1)
            .all(self.business_db())
            .await?
            .into_iter()
            .map(|value| view(value, access))
            .collect::<Result<Vec<_>>>()?;
        Ok(manage::page(&mut values, limit, |value| &value.id))
    }

    pub async fn template(&self, access: Access<'_>, id: &str) -> Result<Template> {
        let row = visible(access.owner)
            .filter(entity::Column::Id.eq(id))
            .one(self.business_db())
            .await?
            .ok_or(DataError::TemplateMissing)?;
        view(row, access)
    }

    pub async fn create_template(&self, access: Access<'_>, value: Definition) -> Result<Template> {
        let shared = value.shared.unwrap_or(false);
        let owner = match (shared, access.admin, access.owner) {
            (true, true, _) => None,
            (false, _, Some(owner)) => Some(owner),
            _ => return Err(DataError::Forbidden),
        };
        value.validate()?;
        let now = now_ms();
        let row = sqlx::query_as(
            "INSERT INTO notification_templates
             (id, space_id, owner_id, name, title, body, format, shared, created_at, updated_at)
             VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
        )
        .bind(new_id())
        .bind(owner)
        .bind(value.name)
        .bind(value.title)
        .bind(value.body)
        .bind(value.format.as_str())
        .bind(shared)
        .bind(now)
        .bind(now)
        .fetch_one(&self.0)
        .await
        .map_err(manage::conflict)?;
        view(row, access)
    }

    pub async fn update_template(
        &self,
        access: Access<'_>,
        id: &str,
        value: Definition,
    ) -> Result<Template> {
        if value.shared == Some(true) && !access.admin {
            return Err(DataError::Forbidden);
        }
        if value.shared == Some(false) && access.owner.is_none() {
            return Err(DataError::Forbidden);
        }
        value.validate()?;
        let row = sqlx::query_as(
            "UPDATE notification_templates
             SET name = ?, title = ?, body = ?, format = ?, updated_at = ?,
                 shared = COALESCE(?, shared),
                 owner_id = CASE COALESCE(?, shared) WHEN 1 THEN NULL ELSE COALESCE(owner_id, ?) END
             WHERE space_id = 'default' AND id = ? AND builtin = 0
               AND (owner_id = ? OR (shared = 1 AND ?))
             RETURNING *",
        )
        .bind(value.name)
        .bind(value.title)
        .bind(value.body)
        .bind(value.format.as_str())
        .bind(now_ms())
        .bind(value.shared)
        .bind(value.shared)
        .bind(access.owner)
        .bind(id)
        .bind(access.owner)
        .bind(access.admin)
        .fetch_optional(&self.0)
        .await
        .map_err(manage::conflict)?
        .ok_or(DataError::TemplateMissing)?;
        view(row, access)
    }

    pub async fn delete_template(&self, access: Access<'_>, id: &str) -> Result<()> {
        let changes = sqlx::query(
            "DELETE FROM notification_templates WHERE space_id = 'default' AND id = ?
               AND builtin = 0 AND (owner_id = ? OR (shared = 1 AND ?))",
        )
        .bind(id)
        .bind(access.owner)
        .bind(access.admin)
        .execute(&self.0)
        .await?;
        affected(changes.rows_affected()).map_err(|_| DataError::TemplateMissing)
    }
}

impl Store {
    /// Resolve a template before giving a copy to an external text transformation.
    pub async fn render_message(
        &self,
        owner: Option<&str>,
        usage: Usage,
        message: &mut Message,
    ) -> Result<()> {
        let mut connection = self.0.acquire().await?;
        render(&mut connection, owner, usage, message).await
    }
}

/// Render against the same database snapshot used to commit the message.
pub(crate) async fn render(
    tx: &mut SqliteConnection,
    owner: Option<&str>,
    usage: Usage,
    message: &mut Message,
) -> Result<()> {
    let row: entity::Model = match usage.reference {
        Reference::Id(id) => {
            sqlx::query_as(
                "SELECT * FROM notification_templates
                 WHERE space_id = 'default' AND (shared = 1 OR owner_id = ?) AND id = ?",
            )
            .bind(owner)
            .bind(id)
            .fetch_optional(tx)
            .await?
        }
        Reference::Name(name) => {
            sqlx::query_as(
                "SELECT * FROM notification_templates
                 WHERE space_id = 'default' AND (shared = 1 OR (shared = 0 AND owner_id = ?)) AND name = ?
                 ORDER BY shared ASC LIMIT 1",
            )
            .bind(owner)
            .bind(name)
            .fetch_optional(tx)
            .await?
        }
    }
    .ok_or(DataError::TemplateMissing)?;
    let source = source(&row)?;
    (message.title, message.body) = source.render(&usage.variables)?;
    message.format = source.format.message_format();
    Ok(())
}

fn visible(owner: Option<&str>) -> Select<entity::Entity> {
    use entity::Column as C;
    entity::Entity::find()
        .filter(C::SpaceId.eq("default"))
        .filter(
            Condition::any()
                .add(C::Shared.eq(true))
                .add_option(owner.map(|value| C::OwnerId.eq(value))),
        )
}

fn source(row: &entity::Model) -> Result<Source<'_>> {
    let format = match row.format.as_str() {
        "text" => Format::Text,
        "markdown" => Format::Markdown,
        _ => return Err(Error::Definition.into()),
    };
    Ok(Source {
        title: &row.title,
        body: &row.body,
        format,
    })
}

fn view(row: entity::Model, access: Access<'_>) -> Result<Template> {
    let source = source(&row)?;
    let format = source.format;
    let variables = source.variables()?;
    let can_edit = !row.builtin
        && (if row.shared {
            access.admin
        } else {
            row.owner_id.as_deref() == access.owner
        });
    Ok(Template {
        id: row.id,
        name: row.name,
        title: row.title,
        body: row.body,
        format,
        variables,
        shared: row.shared,
        builtin: row.builtin,
        can_edit,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}
