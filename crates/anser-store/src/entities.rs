//! Business read mappings for the existing schema. SQLx owns schema migrations.

pub(crate) mod account {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "accounts")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub space_id: String,
        pub channel: String,
        pub name: String,
        pub tags: String,
        pub weight: u32,
        pub priority: i32,
        pub enabled: bool,
        pub rate_limit: Option<u32>,
        pub proxy_id: Option<String>,
        pub encrypted_config: Vec<u8>,
        pub circuit_until: i64,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub(crate) mod user {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub username: String,
        pub password_hash: String,
        pub admin: bool,
        pub enabled: bool,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub(crate) mod proxy {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "proxy_profiles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub space_id: String,
        pub name: String,
        pub url: String,
        pub authenticated: bool,
        pub encrypted_connection: Vec<u8>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub(crate) mod topic {
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::{Expr, ExprTrait, Func};
    use sea_orm::{QueryFilter, Select};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "topics")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub space_id: String,
        pub name: String,
        pub description: String,
        pub enabled: bool,
        pub default_tags: String,
        pub retention: Option<u32>,
        pub policy: String,
        pub password_hash: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}

    pub(crate) fn in_default_space() -> Select<Entity> {
        Entity::find().filter(Column::SpaceId.eq("default"))
    }

    pub(crate) fn name_prefix(prefix: &str) -> Expr {
        // Compare a literal prefix with the column's equality semantics, including case.
        // Both SQLite and PostgreSQL support substr(text, start, count).
        Expr::expr(
            Func::cust("substr")
                .arg(Column::Name.into_expr())
                .arg(1)
                .arg(Func::char_length(prefix)),
        )
        .eq(prefix)
    }
}

pub(crate) mod channel_setting {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "channel_settings")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub channel: String,
        pub enabled: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub(crate) mod user_profile {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "user_profiles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub user_id: String,
        pub nickname: Option<String>,
        pub avatar: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub(crate) mod notification_template {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel, sqlx::FromRow)]
    #[sea_orm(table_name = "notification_templates")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub space_id: String,
        pub owner_id: Option<String>,
        pub name: String,
        pub title: String,
        pub body: String,
        pub format: String,
        pub shared: bool,
        pub builtin: bool,
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub(crate) mod transform_setting {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "transform_settings")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub plugin_id: String,
        pub encrypted_config: Vec<u8>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
