use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub host: String,
    pub port: u16,
    pub su_name: Option<String>,
    pub su_pass: Option<String>,
    pub disable_url_validation: bool,
    pub allowed_internal_hosts: Vec<String>,
    pub session_age: i64,
    pub cors_origins: Vec<String>,
    pub pool_size: u32,
}

fn flag(name: &str) -> bool {
    matches!(env::var(name).as_deref(), Ok("True") | Ok("true") | Ok("1"))
}

fn list(name: &str) -> Vec<String> {
    env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

impl Config {
    pub fn from_env() -> Config {
        let database_url = env::var("DATABASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "sqlite://data/db.sqlite3".to_string());
        let port = env::var("PORT")
            .or_else(|_| env::var("LD_SERVER_PORT"))
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(9090);
        Config {
            database_url,
            host: env::var("LD_SERVER_HOST").unwrap_or_else(|_| "::".to_string()),
            port,
            su_name: env::var("LD_SUPERUSER_NAME").ok().filter(|s| !s.is_empty()),
            su_pass: env::var("LD_SUPERUSER_PASSWORD").ok().filter(|s| !s.is_empty()),
            disable_url_validation: flag("LD_DISABLE_URL_VALIDATION"),
            allowed_internal_hosts: list("LD_ALLOWED_INTERNAL_HOSTS"),
            session_age: env::var("LD_SESSION_COOKIE_AGE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1_209_600),
            cors_origins: list("LD_CORS_ALLOWED_ORIGINS"),
            pool_size: env::var("LD_DB_POOL")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5),
        }
    }
}
