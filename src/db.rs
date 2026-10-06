use std::borrow::Cow;

use sqlx::any::{install_default_drivers, AnyPoolOptions, AnyRow};
use sqlx::{Any, AnyPool, AssertSqlSafe, Executor};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Sqlite,
    Postgres,
    Mysql,
}

/// A bind parameter. Everything is either BIGINT or text so that all three
/// databases behave identically through the `Any` driver.
#[derive(Clone, Debug)]
pub enum P {
    I(i64),
    S(String),
}

impl From<i64> for P {
    fn from(v: i64) -> P {
        P::I(v)
    }
}
impl From<bool> for P {
    fn from(v: bool) -> P {
        P::I(v as i64)
    }
}
impl From<&str> for P {
    fn from(v: &str) -> P {
        P::S(v.to_string())
    }
}
impl From<String> for P {
    fn from(v: String) -> P {
        P::S(v)
    }
}
impl From<&String> for P {
    fn from(v: &String) -> P {
        P::S(v.clone())
    }
}

#[derive(Clone)]
pub struct Db {
    pub pool: AnyPool,
    pub dialect: Dialect,
}

pub fn dialect_of(url: &str) -> Dialect {
    if url.starts_with("postgres") {
        Dialect::Postgres
    } else if url.starts_with("mysql") || url.starts_with("mariadb") {
        Dialect::Mysql
    } else {
        Dialect::Sqlite
    }
}

macro_rules! bind_all {
    ($q:ident, $p:ident) => {
        for v in $p {
            $q = match v {
                P::I(i) => $q.bind(*i),
                P::S(s) => $q.bind(s.clone()),
            };
        }
    };
}

impl Db {
    pub async fn connect(url: &str, pool_size: u32) -> Result<Db, sqlx::Error> {
        install_default_drivers();
        let dialect = dialect_of(url);
        let mut url = url.to_string();
        if dialect == Dialect::Sqlite {
            // make sure the parent directory exists and the file gets created
            let path = url
                .trim_start_matches("sqlite://")
                .trim_start_matches("sqlite:")
                .split('?')
                .next()
                .unwrap_or("")
                .to_string();
            if !path.is_empty() && path != ":memory:" {
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    if !parent.as_os_str().is_empty() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                }
                if !url.contains("mode=") {
                    url.push(if url.contains('?') { '&' } else { '?' });
                    url.push_str("mode=rwc");
                }
            }
        }
        let opts = AnyPoolOptions::new()
            .max_connections(pool_size)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .after_connect(move |conn, _| {
                Box::pin(async move {
                    if dialect == Dialect::Sqlite {
                        conn.execute("PRAGMA journal_mode=WAL").await?;
                        conn.execute("PRAGMA synchronous=NORMAL").await?;
                        conn.execute("PRAGMA busy_timeout=5000").await?;
                        conn.execute("PRAGMA temp_store=MEMORY").await?;
                    }
                    Ok(())
                })
            });
        let pool = opts.connect(&url).await?;
        Ok(Db { pool, dialect })
    }

    /// Rewrites `?` placeholders to `$n` for postgres.
    pub fn sql<'a>(&self, sql: &'a str) -> Cow<'a, str> {
        if self.dialect != Dialect::Postgres {
            return Cow::Borrowed(sql);
        }
        let mut out = String::with_capacity(sql.len() + 8);
        let mut n = 0;
        for c in sql.chars() {
            if c == '?' {
                n += 1;
                out.push('$');
                out.push_str(&n.to_string());
            } else {
                out.push(c);
            }
        }
        Cow::Owned(out)
    }

    pub async fn fetch_all<'e, E>(&self, ex: E, sql: &str, p: &[P]) -> Result<Vec<AnyRow>, sqlx::Error>
    where
        E: Executor<'e, Database = Any>,
    {
        let sql = self.sql(sql);
        // SQL text is built only from fixed fragments; all values go through bind parameters.
        let mut q = sqlx::query(AssertSqlSafe(sql.into_owned()));
        bind_all!(q, p);
        q.fetch_all(ex).await
    }

    pub async fn fetch_opt<'e, E>(&self, ex: E, sql: &str, p: &[P]) -> Result<Option<AnyRow>, sqlx::Error>
    where
        E: Executor<'e, Database = Any>,
    {
        let sql = self.sql(sql);
        // SQL text is built only from fixed fragments; all values go through bind parameters.
        let mut q = sqlx::query(AssertSqlSafe(sql.into_owned()));
        bind_all!(q, p);
        q.fetch_optional(ex).await
    }

    pub async fn execute<'e, E>(&self, ex: E, sql: &str, p: &[P]) -> Result<u64, sqlx::Error>
    where
        E: Executor<'e, Database = Any>,
    {
        let sql = self.sql(sql);
        // SQL text is built only from fixed fragments; all values go through bind parameters.
        let mut q = sqlx::query(AssertSqlSafe(sql.into_owned()));
        bind_all!(q, p);
        Ok(q.execute(ex).await?.rows_affected())
    }

    /// INSERT returning the new `id` on every dialect.
    pub async fn insert<'e, E>(&self, ex: E, sql: &str, p: &[P]) -> Result<i64, sqlx::Error>
    where
        E: Executor<'e, Database = Any>,
    {
        use sqlx::Row;
        // The sqlx Any driver only reports last_insert_id for MySQL; SQLite (3.35+) and Postgres use RETURNING.
        if self.dialect != Dialect::Mysql {
            let sql = format!("{sql} RETURNING id");
            let row = self.fetch_opt(ex, &sql, p).await?;
            return match row {
                Some(r) => r.try_get::<i64, _>(0),
                None => Ok(0),
            };
        }
        let sql = self.sql(sql);
        // SQL text is built only from fixed fragments; all values go through bind parameters.
        let mut q = sqlx::query(AssertSqlSafe(sql.into_owned()));
        bind_all!(q, p);
        Ok(q.execute(ex).await?.last_insert_id().unwrap_or(0))
    }

    /// An INSERT that silently ignores duplicate keys. `rest` is `INTO t (cols) VALUES (?,?)`.
    pub fn insert_ignore(&self, rest: &str) -> String {
        match self.dialect {
            Dialect::Sqlite => format!("INSERT OR IGNORE {rest}"),
            Dialect::Mysql => format!("INSERT IGNORE {rest}"),
            Dialect::Postgres => format!("INSERT {rest} ON CONFLICT DO NOTHING"),
        }
    }

    pub async fn migrate(&self) -> Result<(), sqlx::Error> {
        let pk = match self.dialect {
            Dialect::Sqlite => "INTEGER PRIMARY KEY AUTOINCREMENT",
            Dialect::Postgres => "BIGSERIAL PRIMARY KEY",
            Dialect::Mysql => "BIGINT AUTO_INCREMENT PRIMARY KEY",
        };
        let tables = [
            "CREATE TABLE IF NOT EXISTS users (
                id {PK},
                username VARCHAR(150) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                is_superuser BIGINT NOT NULL,
                enable_sharing BIGINT NOT NULL,
                enable_public_sharing BIGINT NOT NULL,
                settings TEXT NOT NULL,
                created BIGINT NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS api_tokens (
                id {PK},
                user_id BIGINT NOT NULL,
                token VARCHAR(64) NOT NULL UNIQUE,
                name VARCHAR(128) NOT NULL,
                created BIGINT NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS sessions (
                token VARCHAR(64) NOT NULL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                expires BIGINT NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS bookmarks (
                id {PK},
                owner_id BIGINT NOT NULL,
                url TEXT NOT NULL,
                url_normalized TEXT NOT NULL,
                url_hash BIGINT NOT NULL,
                search_text TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                notes TEXT NOT NULL,
                is_archived BIGINT NOT NULL,
                unread BIGINT NOT NULL,
                shared BIGINT NOT NULL,
                date_added BIGINT NOT NULL,
                date_modified BIGINT NOT NULL
            )",
            "CREATE TABLE IF NOT EXISTS tags (
                id {PK},
                owner_id BIGINT NOT NULL,
                name VARCHAR(64) NOT NULL,
                name_lower VARCHAR(64) NOT NULL,
                date_added BIGINT NOT NULL,
                UNIQUE (owner_id, name_lower)
            )",
            "CREATE TABLE IF NOT EXISTS bookmark_tags (
                bookmark_id BIGINT NOT NULL,
                tag_id BIGINT NOT NULL,
                PRIMARY KEY (bookmark_id, tag_id)
            )",
        ];
        for t in tables {
            let sql = t.replace("{PK}", pk);
            sqlx::query(AssertSqlSafe(sql)).execute(&self.pool).await?;
        }
        let indexes = [
            ("idx_bm_owner_list", "bookmarks (owner_id, is_archived, date_added)"),
            ("idx_bm_owner_hash", "bookmarks (owner_id, url_hash)"),
            ("idx_bm_shared", "bookmarks (shared, date_added)"),
            ("idx_bt_tag", "bookmark_tags (tag_id)"),
            ("idx_tokens_user", "api_tokens (user_id)"),
        ];
        for (name, cols) in indexes {
            if self.dialect == Dialect::Mysql {
                // MySQL has no IF NOT EXISTS for indexes; a duplicate-name error is expected on restart.
                let _ = sqlx::query(AssertSqlSafe(format!("CREATE INDEX {name} ON {cols}")))
                    .execute(&self.pool)
                    .await;
            } else {
                sqlx::query(AssertSqlSafe(format!("CREATE INDEX IF NOT EXISTS {name} ON {cols}")))
                    .execute(&self.pool)
                    .await?;
            }
        }
        Ok(())
    }
}
