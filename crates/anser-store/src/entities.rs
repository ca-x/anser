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
