use std::collections::HashMap;

use serde::Serialize;
use sqlx::any::AnyRow;
use sqlx::Row;

use crate::app::now_micros;
use crate::db::{Db, P};

// ---------------------------------------------------------------- URLs

pub fn fnv1a(s: &str) -> i64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h as i64
}

/// Mirrors linkding's `normalize_url`: lowercase scheme and host, strip the
/// trailing slash of the path, sort query parameters, keep the fragment.
pub fn normalize_url(url: &str) -> String {
    let url = url.trim();
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return url.to_string(),
    };
    let mut out = String::with_capacity(url.len());
    out.push_str(parsed.scheme());
    out.push(':');
    if parsed.has_host() {
        out.push_str("//");
        if !parsed.username().is_empty() {
            out.push_str(parsed.username());
            if let Some(p) = parsed.password() {
                out.push(':');
                out.push_str(p);
            }
            out.push('@');
        }
        out.push_str(parsed.host_str().unwrap_or(""));
        if let Some(port) = parsed.port() {
            out.push(':');
            out.push_str(&port.to_string());
        }
    }
    out.push_str(parsed.path().trim_end_matches('/'));
    if let Some(q) = parsed.query() {
        let mut pairs: Vec<(&str, &str)> = q
            .split('&')
            .filter(|s| !s.is_empty())
            .map(|kv| kv.split_once('=').unwrap_or((kv, "")))
            .collect();
        pairs.sort();
        if !pairs.is_empty() {
            out.push('?');
            let joined: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect();
            out.push_str(&joined.join("&"));
        }
    }
    if let Some(f) = parsed.fragment() {
        out.push('#');
        out.push_str(f);
    }
    out
}

pub fn valid_url(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) => matches!(u.scheme(), "http" | "https" | "ftp" | "ftps") && u.has_host(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------- tags

/// Same rules as linkding's `parse_tag_string`: trim, spaces become dashes,
/// drop empties, dedupe case-insensitively (first casing wins), sort by lowercase.
pub fn clean_tag_names<I, T>(names: I) -> Vec<String>
where
    I: IntoIterator<Item = T>,
    T: AsRef<str>,
{
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut order = Vec::new();
    for raw in names {
        for part in raw.as_ref().split(',') {
            let t = part.trim().replace(' ', "-");
            if t.is_empty() || t.chars().count() > 64 {
                continue;
            }
            let lower = t.to_lowercase();
            if !seen.contains_key(&lower) {
                seen.insert(lower.clone(), t);
                order.push(lower);
            }
        }
    }
    order.sort();
    order.into_iter().filter_map(|k| seen.remove(&k)).collect()
}

/// Resolves tag names to ids (creating missing tags) for one owner.
pub async fn ensure_tags(
    db: &Db,
    ex: &mut sqlx::AnyConnection,
    owner: i64,
    names: &[String],
) -> Result<Vec<i64>, sqlx::Error> {
    let mut ids = Vec::with_capacity(names.len());
    for name in names {
        let lower = name.to_lowercase();
        let row = db
            .fetch_opt(&mut *ex, "SELECT id FROM tags WHERE owner_id = ? AND name_lower = ?", &[owner.into(), lower.clone().into()])
            .await?;
        let id = match row {
            Some(r) => r.try_get::<i64, _>(0)?,
            None => {
                let sql = db.insert_ignore("INTO tags (owner_id, name, name_lower, date_added) VALUES (?, ?, ?, ?)");
                db.execute(&mut *ex, &sql, &[owner.into(), name.into(), lower.clone().into(), now_micros().into()])
                    .await?;
                db.fetch_opt(&mut *ex, "SELECT id FROM tags WHERE owner_id = ? AND name_lower = ?", &[owner.into(), lower.into()])
                    .await?
                    .map(|r| r.try_get::<i64, _>(0))
                    .transpose()?
                    .unwrap_or(0)
            }
        };
        ids.push(id);
    }
    Ok(ids)
}

pub async fn set_bookmark_tags(
    db: &Db,
    ex: &mut sqlx::AnyConnection,
    owner: i64,
    bookmark_id: i64,
    names: &[String],
) -> Result<(), sqlx::Error> {
    let ids = ensure_tags(db, &mut *ex, owner, names).await?;
    db.execute(&mut *ex, "DELETE FROM bookmark_tags WHERE bookmark_id = ?", &[bookmark_id.into()])
        .await?;
    let sql = db.insert_ignore("INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)");
    for id in ids {
        db.execute(&mut *ex, &sql, &[bookmark_id.into(), id.into()]).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------- bookmarks

/// Lowercased title/description/notes/url in one column, so a search term is a
/// single `LIKE` instead of four `LOWER(..) LIKE` scans. Lowercasing happens
/// here (not in SQL) so it is Unicode-correct on every database.
pub fn search_text(title: &str, description: &str, notes: &str, url: &str) -> String {
    format!("{title}\n{description}\n{notes}\n{url}").to_lowercase()
}

/// Recomputes `search_text` from the stored row; call after any text-field update.
pub async fn refresh_search_text(db: &Db, conn: &mut sqlx::AnyConnection, id: i64) -> Result<(), sqlx::Error> {
    let row = db
        .fetch_opt(&mut *conn, "SELECT title, description, notes, url FROM bookmarks WHERE id = ?", &[id.into()])
        .await?;
    if let Some(r) = row {
        let st = search_text(&r.try_get::<String, _>(0)?, &r.try_get::<String, _>(1)?, &r.try_get::<String, _>(2)?, &r.try_get::<String, _>(3)?);
        db.execute(&mut *conn, "UPDATE bookmarks SET search_text = ? WHERE id = ?", &[st.into(), id.into()]).await?;
    }
    Ok(())
}

pub const BM_COLS: &str =
    "b.id, b.url, b.title, b.description, b.notes, b.is_archived, b.unread, b.shared, b.date_added, b.date_modified";

#[derive(Clone, Debug, Default)]
pub struct Bm {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub description: String,
    pub notes: String,
    pub is_archived: bool,
    pub unread: bool,
    pub shared: bool,
    pub tag_names: Vec<String>,
    pub date_added: i64,
    pub date_modified: i64,
}

impl Bm {
    pub fn from_row(r: &AnyRow) -> Result<Bm, sqlx::Error> {
        Ok(Bm {
            id: r.try_get(0)?,
            url: r.try_get(1)?,
            title: r.try_get(2)?,
            description: r.try_get(3)?,
            notes: r.try_get(4)?,
            is_archived: r.try_get::<i64, _>(5)? != 0,
            unread: r.try_get::<i64, _>(6)? != 0,
            shared: r.try_get::<i64, _>(7)? != 0,
            tag_names: Vec::new(),
            date_added: r.try_get(8)?,
            date_modified: r.try_get(9)?,
        })
    }
}

/// Loads tags for a page of bookmarks with one query per chunk.
pub async fn attach_tags(db: &Db, bms: &mut [Bm]) -> Result<(), sqlx::Error> {
    if bms.is_empty() {
        return Ok(());
    }
    let mut index: HashMap<i64, usize> = HashMap::with_capacity(bms.len());
    for (i, b) in bms.iter().enumerate() {
        index.insert(b.id, i);
    }
    let ids: Vec<i64> = bms.iter().map(|b| b.id).collect();
    for chunk in ids.chunks(500) {
        let ph = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT bt.bookmark_id, t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id IN ({ph})"
        );
        let params: Vec<P> = chunk.iter().map(|i| P::I(*i)).collect();
        for r in db.fetch_all(&db.pool, &sql, &params).await? {
            let bid: i64 = r.try_get(0)?;
            let name: String = r.try_get(1)?;
            if let Some(i) = index.get(&bid) {
                bms[*i].tag_names.push(name);
            }
        }
    }
    for b in bms.iter_mut() {
        b.tag_names.sort();
    }
    Ok(())
}

#[derive(Serialize)]
pub struct BmOut {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub description: String,
    pub notes: String,
    pub web_archive_snapshot_url: Option<String>,
    pub favicon_url: Option<String>,
    pub preview_image_url: Option<String>,
    pub is_archived: bool,
    pub unread: bool,
    pub shared: bool,
    pub tag_names: Vec<String>,
    pub date_added: String,
    pub date_modified: String,
    pub website_title: Option<String>,
    pub website_description: Option<String>,
}

pub fn iso(micros: i64) -> String {
    chrono::DateTime::from_timestamp_micros(micros)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.6fZ")
        .to_string()
}

impl From<Bm> for BmOut {
    fn from(b: Bm) -> BmOut {
        let stamp = chrono::DateTime::from_timestamp_micros(b.date_added)
            .unwrap_or_default()
            .format("%Y%m%d%H%M%S");
        BmOut {
            id: b.id,
            web_archive_snapshot_url: Some(format!("https://web.archive.org/web/{stamp}/{}", b.url)),
            url: b.url,
            title: b.title,
            description: b.description,
            notes: b.notes,
            favicon_url: None,
            preview_image_url: None,
            is_archived: b.is_archived,
            unread: b.unread,
            shared: b.shared,
            tag_names: b.tag_names,
            date_added: iso(b.date_added),
            date_modified: iso(b.date_modified),
            website_title: None,
            website_description: None,
        }
    }
}

/// Looks up an existing bookmark of `owner` by normalized URL.
pub async fn find_by_url<'e, E>(db: &Db, ex: E, owner: i64, url: &str) -> Result<Option<Bm>, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let norm = normalize_url(url);
    let sql = format!(
        "SELECT {BM_COLS} FROM bookmarks b WHERE b.owner_id = ? AND b.url_hash = ? AND b.url_normalized = ?"
    );
    let row = db
        .fetch_opt(ex, &sql, &[owner.into(), fnv1a(&norm).into(), norm.into()])
        .await?;
    row.map(|r| Bm::from_row(&r)).transpose()
}
