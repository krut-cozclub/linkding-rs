use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::app::*;
use crate::auth::{default_settings, hash_password, verify_password, Auth, MaybeAuth};
use crate::db::P;
use crate::models::*;
use crate::scrape::fetch_meta;
use crate::search;

type Q = Query<HashMap<String, String>>;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// ------------------------------------------------------------ helpers

fn parse_body(body: &Bytes) -> ApiResult<Map<String, Value>> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(other) => {
            let kind = match other {
                Value::Array(_) => "list",
                Value::String(_) => "str",
                Value::Number(_) => "number",
                Value::Bool(_) => "bool",
                _ => "NoneType",
            };
            Err(ApiError {
                status: StatusCode::BAD_REQUEST,
                body: json!({ "non_field_errors": [format!("Invalid data. Expected a dictionary, but got {kind}.")] }),
                www_auth: false,
            })
        }
        Err(e) => Err(ApiError::detail(StatusCode::BAD_REQUEST, &format!("JSON parse error - {e}"))),
    }
}

fn origin(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .unwrap_or("http")
        .trim()
        .to_string();
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost");
    format!("{scheme}://{host}")
}

fn page_url(headers: &HeaderMap, path: &str, q: &HashMap<String, String>, limit: i64, offset: i64) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    ser.append_pair("limit", &limit.to_string());
    if offset > 0 {
        ser.append_pair("offset", &offset.to_string());
    }
    let mut rest: Vec<(&String, &String)> = q.iter().filter(|(k, _)| *k != "limit" && *k != "offset").collect();
    rest.sort();
    for (k, v) in rest {
        ser.append_pair(k, v);
    }
    format!("{}{}?{}", origin(headers), path, ser.finish())
}

#[derive(Serialize)]
struct Page<T: Serialize> {
    count: i64,
    next: Option<String>,
    previous: Option<String>,
    results: Vec<T>,
}

fn paging(q: &HashMap<String, String>) -> (i64, i64) {
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(100)
        .min(10_000);
    let offset = q.get("offset").and_then(|v| v.parse::<i64>().ok()).filter(|v| *v >= 0).unwrap_or(0);
    (limit, offset)
}

fn page<T: Serialize>(
    headers: &HeaderMap,
    path: &str,
    q: &HashMap<String, String>,
    count: i64,
    limit: i64,
    offset: i64,
    results: Vec<T>,
) -> Response {
    let next = (offset + limit < count).then(|| page_url(headers, path, q, limit, offset + limit));
    let previous = (offset > 0).then(|| page_url(headers, path, q, limit, (offset - limit).max(0)));
    json_response(StatusCode::OK, &Page { count, next, previous, results })
}

fn parse_date(v: &Value, field: &str, errs: &mut Map<String, Value>) -> Option<i64> {
    match v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(d) => Some(d.timestamp_micros()),
        None => {
            errs.insert(
                field.into(),
                json!(["Datetime has wrong format. Use one of these formats instead: YYYY-MM-DDThh:mm[:ss[.uuuuuu]][+HH:MM|-HH:MM|Z]."]),
            );
            None
        }
    }
}

#[derive(Default)]
struct Input {
    url: Option<String>,
    title: Option<String>,
    description: Option<String>,
    notes: Option<String>,
    is_archived: Option<bool>,
    unread: Option<bool>,
    shared: Option<bool>,
    tag_names: Option<Vec<String>>,
    date_added: Option<i64>,
    date_modified: Option<i64>,
}

fn parse_input(app: &S, m: &Map<String, Value>, require_url: bool) -> ApiResult<Input> {
    let mut errs = Map::new();
    let mut inp = Input::default();

    let text = |key: &str, max: usize, errs: &mut Map<String, Value>| -> Option<String> {
        match m.get(key) {
            None => None,
            Some(Value::Null) => {
                errs.insert(key.into(), json!(["This field may not be null."]));
                None
            }
            Some(Value::String(s)) => {
                if s.chars().count() > max {
                    errs.insert(key.into(), json!([format!("Ensure this field has no more than {max} characters.")]));
                    None
                } else {
                    Some(s.clone())
                }
            }
            Some(_) => {
                errs.insert(key.into(), json!(["Not a valid string."]));
                None
            }
        }
    };
    let boolean = |key: &str, errs: &mut Map<String, Value>| -> Option<bool> {
        match m.get(key) {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => {
                errs.insert(key.into(), json!(["Must be a valid boolean."]));
                None
            }
        }
    };

    match m.get("url") {
        None if require_url => {
            errs.insert("url".into(), json!(["This field is required."]));
        }
        None => {}
        Some(_) => {
            if let Some(u) = text("url", 2048, &mut errs) {
                let u = u.trim().to_string();
                if u.is_empty() {
                    errs.insert("url".into(), json!(["This field may not be blank."]));
                } else if !app.cfg.disable_url_validation && !valid_url(&u) {
                    errs.insert("url".into(), json!(["Enter a valid URL."]));
                } else {
                    inp.url = Some(u);
                }
            }
        }
    }
    inp.title = text("title", 512, &mut errs);
    inp.description = text("description", usize::MAX, &mut errs);
    inp.notes = text("notes", usize::MAX, &mut errs);
    inp.is_archived = boolean("is_archived", &mut errs);
    inp.unread = boolean("unread", &mut errs);
    inp.shared = boolean("shared", &mut errs);
    match m.get("tag_names") {
        None => {}
        Some(Value::Array(a)) => {
            let mut names = Vec::new();
            for v in a {
                match v.as_str() {
                    Some(s) => names.push(s.to_string()),
                    None => {
                        errs.insert("tag_names".into(), json!(["Not a valid string."]));
                        break;
                    }
                }
            }
            inp.tag_names = Some(clean_tag_names(names));
        }
        Some(_) => {
            errs.insert("tag_names".into(), json!(["Expected a list of items."]));
        }
    }
    if let Some(v) = m.get("date_added") {
        inp.date_added = parse_date(v, "date_added", &mut errs);
    }
    if let Some(v) = m.get("date_modified") {
        inp.date_modified = parse_date(v, "date_modified", &mut errs);
    }
    if errs.is_empty() {
        Ok(inp)
    } else {
        Err(ApiError { status: StatusCode::BAD_REQUEST, body: Value::Object(errs), www_auth: false })
    }
}

async fn get_bm(app: &S, owner: i64, id: i64) -> ApiResult<Option<Bm>> {
    let sql = format!("SELECT {BM_COLS} FROM bookmarks b WHERE b.id = ? AND b.owner_id = ?");
    let row = app.db.fetch_opt(&app.db.pool, &sql, &[id.into(), owner.into()]).await?;
    let Some(row) = row else { return Ok(None) };
    let mut v = vec![Bm::from_row(&row)?];
    attach_tags(&app.db, &mut v).await?;
    Ok(v.pop())
}

// ------------------------------------------------------------ bookmark list

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Active,
    Archived,
    Shared,
}

async fn list_core(
    app: &S,
    owner: Option<i64>,
    headers: &HeaderMap,
    path: &str,
    q: &HashMap<String, String>,
    mode: Mode,
) -> ApiResult<Response> {
    let (limit, offset) = paging(q);
    let mut where_sql = String::new();
    let mut params: Vec<P> = Vec::new();

    match mode {
        Mode::Active | Mode::Archived => {
            let owner = owner.ok_or_else(|| ApiError::unauthorized("Authentication credentials were not provided."))?;
            where_sql.push_str("b.owner_id = ? AND b.is_archived = ?");
            params.push(owner.into());
            params.push((mode == Mode::Archived).into());
        }
        Mode::Shared => {
            where_sql.push_str(
                "b.shared = 1 AND b.is_archived = 0 AND EXISTS (SELECT 1 FROM users u WHERE u.id = b.owner_id AND u.enable_sharing = 1",
            );
            if owner.is_none() {
                where_sql.push_str(" AND u.enable_public_sharing = 1");
            }
            if let Some(user) = q.get("user").filter(|u| !u.is_empty()) {
                where_sql.push_str(" AND u.username = ?");
                params.push(user.as_str().into());
            }
            where_sql.push(')');
        }
    }

    if let (Some(bid), Some(owner)) = (q.get("bundle").and_then(|b| b.parse::<i64>().ok()), owner) {
        let row = app
            .db
            .fetch_opt(
                &app.db.pool,
                "SELECT search, any_tags, all_tags, excluded_tags, filter_unread, filter_shared FROM bundles WHERE id = ? AND owner_id = ?",
                &[bid.into(), owner.into()],
            )
            .await?;
        if let Some(r) = row {
            let words = |i: usize| -> Result<Vec<String>, sqlx::Error> {
                Ok(r.try_get::<String, _>(i)?.split_whitespace().map(|t| t.to_lowercase()).collect())
            };
            let tag_in = |sql: &mut String, params: &mut Vec<P>, tags: &[String], sep: &str, negate: bool| {
                if tags.is_empty() {
                    return;
                }
                sql.push_str(" AND ");
                if negate {
                    sql.push_str("NOT ");
                }
                sql.push('(');
                for (i, t) in tags.iter().enumerate() {
                    if i > 0 {
                        sql.push_str(sep);
                    }
                    sql.push_str(search::TAG_EXISTS);
                    params.push(P::S(t.clone()));
                }
                sql.push(')');
            };
            let (any, all, excl) = (words(1)?, words(2)?, words(3)?);
            tag_in(&mut where_sql, &mut params, &any, " OR ", false);
            tag_in(&mut where_sql, &mut params, &all, " AND ", false);
            tag_in(&mut where_sql, &mut params, &excl, " OR ", true);
            for (i, col) in [(4, "b.unread"), (5, "b.shared")] {
                match r.try_get::<String, _>(i)?.as_str() {
                    "yes" => where_sql.push_str(&format!(" AND {col} = 1")),
                    "no" => where_sql.push_str(&format!(" AND {col} = 0")),
                    _ => {}
                }
            }
            let bsearch: String = r.try_get(0)?;
            if let Ok(Some(node)) = search::parse(&bsearch) {
                where_sql.push_str(" AND ");
                search::to_sql(&node, false, &mut where_sql, &mut params);
            }
        }
    }

    let query = q.get("q").map(|s| s.as_str()).unwrap_or("");
    if !query.trim().is_empty() {
        match search::parse(query) {
            Err(()) => {
                return Ok(page::<BmOut>(headers, path, q, 0, limit, offset, vec![]));
            }
            Ok(None) => {}
            Ok(Some(node)) => {
                let mut lax = false;
                if let Some(o) = owner {
                    if let Some(r) = app.db.fetch_opt(&app.db.pool, "SELECT settings FROM users WHERE id = ?", &[o.into()]).await? {
                        let s: String = r.try_get(0)?;
                        lax = s.contains("\"tag_search\":\"lax\"");
                    }
                }
                where_sql.push_str(" AND ");
                search::to_sql(&node, lax, &mut where_sql, &mut params);
            }
        }
    }
    for (key, col) in [("unread", "b.unread"), ("shared", "b.shared")] {
        match q.get(key).map(|s| s.as_str()) {
            Some("yes") => where_sql.push_str(&format!(" AND {col} = 1")),
            Some("no") => where_sql.push_str(&format!(" AND {col} = 0")),
            _ => {}
        }
    }
    for (key, col) in [("modified_since", "b.date_modified"), ("added_since", "b.date_added")] {
        if let Some(d) = q.get(key).and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
            where_sql.push_str(&format!(" AND {col} > ?"));
            params.push(d.timestamp_micros().into());
        }
    }
    let order = match q.get("sort").map(|s| s.as_str()).unwrap_or("added_desc") {
        "added_asc" => "b.date_added ASC, b.id ASC",
        "modified_asc" => "b.date_modified ASC, b.id ASC",
        "modified_desc" => "b.date_modified DESC, b.id DESC",
        "title_asc" => "LOWER(CASE WHEN b.title = '' THEN b.url ELSE b.title END) ASC, b.id ASC",
        "title_desc" => "LOWER(CASE WHEN b.title = '' THEN b.url ELSE b.title END) DESC, b.id DESC",
        _ => "b.date_added DESC, b.id DESC",
    };

    let count_sql = format!("SELECT COUNT(*) FROM bookmarks b WHERE {where_sql}");
    let rows_sql = format!("SELECT {BM_COLS} FROM bookmarks b WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    let mut row_params = params.clone();
    row_params.push(limit.into());
    row_params.push(offset.into());

    let (count, rows) = tokio::join!(
        app.db.fetch_opt(&app.db.pool, &count_sql, &params),
        app.db.fetch_all(&app.db.pool, &rows_sql, &row_params)
    );
    let count: i64 = count?.map(|r| r.try_get(0)).transpose()?.unwrap_or(0);
    let mut bms = rows?.iter().map(Bm::from_row).collect::<Result<Vec<_>, _>>()?;
    attach_tags(&app.db, &mut bms).await?;
    let out: Vec<BmOut> = bms.into_iter().map(BmOut::from).collect();
    Ok(page(headers, path, q, count, limit, offset, out))
}

pub async fn bookmarks_list(State(app): State<S>, Auth(uid): Auth, headers: HeaderMap, Query(q): Q) -> ApiResult<Response> {
    list_core(&app, Some(uid), &headers, "/api/bookmarks/", &q, Mode::Active).await
}

pub async fn bookmarks_archived(State(app): State<S>, Auth(uid): Auth, headers: HeaderMap, Query(q): Q) -> ApiResult<Response> {
    list_core(&app, Some(uid), &headers, "/api/bookmarks/archived/", &q, Mode::Archived).await
}

pub async fn bookmarks_shared(State(app): State<S>, MaybeAuth(uid): MaybeAuth, headers: HeaderMap, Query(q): Q) -> ApiResult<Response> {
    list_core(&app, uid, &headers, "/api/bookmarks/shared/", &q, Mode::Shared).await
}

// ------------------------------------------------------------ bookmark CRUD

pub async fn bookmark_create(
    State(app): State<S>,
    Auth(uid): Auth,
    Query(q): Q,
    body: Bytes,
) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let inp = parse_input(&app, &m, true)?;
    let url = inp.url.clone().unwrap_or_default();
    let skip_scrape = q.contains_key("disable_scraping");

    let existing = find_by_url(&app.db, &app.db.pool, uid, &url).await?;
    let mut title = inp.title.clone();
    let mut description = inp.description.clone();

    let missing = |v: &Option<String>| v.as_deref().map(|s| s.is_empty()).unwrap_or(true);
    if !skip_scrape && (missing(&title) || missing(&description)) {
        let meta = fetch_meta(&app, &url, false).await;
        if missing(&title) && existing.is_none() {
            title = meta.title.or(title);
        }
        if missing(&description) && existing.is_none() {
            description = meta.description.or(description);
        }
    }

    let mut tx = app.db.pool.begin().await?;
    let now = now_micros();
    let (id, status) = match existing {
        Some(ex) => {
            // upsert: overwrite the supplied fields, replace tags
            let mut sets = vec!["date_modified = ?".to_string()];
            let mut p: Vec<P> = vec![now.into()];
            let mut add = |col: &str, v: P| {
                sets.push(format!("{col} = ?"));
                p.push(v);
            };
            if let Some(t) = &title {
                add("title", t.into());
            }
            if let Some(d) = &description {
                add("description", d.into());
            }
            if let Some(n) = &inp.notes {
                add("notes", n.into());
            }
            if let Some(u) = inp.unread {
                add("unread", u.into());
            }
            if let Some(s) = inp.shared {
                add("shared", s.into());
            }
            p.push(ex.id.into());
            let sql = format!("UPDATE bookmarks SET {} WHERE id = ?", sets.join(", "));
            app.db.execute(&mut *tx, &sql, &p).await?;
            refresh_search_text(&app.db, &mut tx, ex.id).await?;
            if let Some(tags) = &inp.tag_names {
                set_bookmark_tags(&app.db, &mut tx, uid, ex.id, tags).await?;
            }
            (ex.id, StatusCode::CREATED)
        }
        None => {
            let norm = normalize_url(&url);
            let id = app
                .db
                .insert(
                    &mut *tx,
                    "INSERT INTO bookmarks (owner_id, url, url_normalized, url_hash, search_text, title, description, notes, is_archived, unread, shared, date_added, date_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    &[
                        uid.into(),
                        url.clone().into(),
                        norm.clone().into(),
                        fnv1a(&norm).into(),
                        search_text(
                            title.as_deref().unwrap_or(""),
                            description.as_deref().unwrap_or(""),
                            inp.notes.as_deref().unwrap_or(""),
                            &url,
                        )
                        .into(),
                        title.clone().unwrap_or_default().into(),
                        description.clone().unwrap_or_default().into(),
                        inp.notes.clone().unwrap_or_default().into(),
                        inp.is_archived.unwrap_or(false).into(),
                        inp.unread.unwrap_or(false).into(),
                        inp.shared.unwrap_or(false).into(),
                        inp.date_added.unwrap_or(now).into(),
                        inp.date_modified.unwrap_or(now).into(),
                    ],
                )
                .await?;
            if let Some(tags) = &inp.tag_names {
                set_bookmark_tags(&app.db, &mut tx, uid, id, tags).await?;
            }
            (id, StatusCode::CREATED)
        }
    };
    tx.commit().await?;
    let bm = get_bm(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(json_response(status, &BmOut::from(bm)))
}

pub async fn bookmark_get(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let bm = get_bm(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(json_response(StatusCode::OK, &BmOut::from(bm)))
}

async fn bookmark_update(app: S, uid: i64, id: i64, body: Bytes, partial: bool) -> ApiResult<Response> {
    let existing = get_bm(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    let m = parse_body(&body)?;
    let inp = parse_input(&app, &m, !partial)?;
    let mut sets = vec!["date_modified = ?".to_string()];
    let mut p: Vec<P> = vec![now_micros().into()];
    let mut add = |col: &str, v: P| {
        sets.push(format!("{col} = ?"));
        p.push(v);
    };
    if let Some(url) = &inp.url {
        let norm = normalize_url(url);
        if norm != normalize_url(&existing.url) {
            if let Some(other) = find_by_url(&app.db, &app.db.pool, uid, url).await? {
                if other.id != id {
                    return Err(ApiError::field("url", "A bookmark with this URL already exists."));
                }
            }
        }
        add("url", url.into());
        add("url_normalized", norm.clone().into());
        add("url_hash", fnv1a(&norm).into());
    }
    if let Some(v) = &inp.title {
        add("title", v.into());
    }
    if let Some(v) = &inp.description {
        add("description", v.into());
    }
    if let Some(v) = &inp.notes {
        add("notes", v.into());
    }
    if let Some(v) = inp.is_archived {
        add("is_archived", v.into());
    }
    if let Some(v) = inp.unread {
        add("unread", v.into());
    }
    if let Some(v) = inp.shared {
        add("shared", v.into());
    }
    if let Some(v) = inp.date_added {
        add("date_added", v.into());
    }
    p.push(id.into());
    p.push(uid.into());
    let sql = format!("UPDATE bookmarks SET {} WHERE id = ? AND owner_id = ?", sets.join(", "));
    let mut tx = app.db.pool.begin().await?;
    app.db.execute(&mut *tx, &sql, &p).await?;
    refresh_search_text(&app.db, &mut tx, id).await?;
    if let Some(tags) = &inp.tag_names {
        set_bookmark_tags(&app.db, &mut tx, uid, id, tags).await?;
    }
    tx.commit().await?;
    let bm = get_bm(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(json_response(StatusCode::OK, &BmOut::from(bm)))
}

pub async fn bookmark_put(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>, body: Bytes) -> ApiResult<Response> {
    bookmark_update(app, uid, id, body, false).await
}

pub async fn bookmark_patch(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>, body: Bytes) -> ApiResult<Response> {
    bookmark_update(app, uid, id, body, true).await
}

pub async fn bookmark_delete(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut tx = app.db.pool.begin().await?;
    let n = app
        .db
        .execute(&mut *tx, "DELETE FROM bookmarks WHERE id = ? AND owner_id = ?", &[id.into(), uid.into()])
        .await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    app.db.execute(&mut *tx, "DELETE FROM bookmark_tags WHERE bookmark_id = ?", &[id.into()]).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn set_archived(app: S, uid: i64, id: i64, archived: bool) -> ApiResult<Response> {
    let n = app
        .db
        .execute(
            &app.db.pool,
            "UPDATE bookmarks SET is_archived = ?, date_modified = ? WHERE id = ? AND owner_id = ?",
            &[archived.into(), now_micros().into(), id.into(), uid.into()],
        )
        .await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn bookmark_archive(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    set_archived(app, uid, id, true).await
}

pub async fn bookmark_unarchive(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    set_archived(app, uid, id, false).await
}

pub async fn bookmark_check(State(app): State<S>, Auth(uid): Auth, Query(q): Q) -> ApiResult<Response> {
    let url = q.get("url").map(|s| s.trim().to_string()).unwrap_or_default();
    if url.is_empty() {
        return Err(ApiError::field("url", "This field is required."));
    }
    let existing = find_by_url(&app.db, &app.db.pool, uid, &url).await?;
    let (bookmark, metadata) = match existing {
        Some(b) => {
            // already saved: no need to hit the network
            let meta = json!({ "url": url, "title": b.title, "description": b.description, "preview_image": null });
            let mut v = vec![b];
            attach_tags(&app.db, &mut v).await?;
            (json!(BmOut::from(v.remove(0))), meta)
        }
        None => {
            let ignore = q.get("ignore_cache").map(|s| s == "true").unwrap_or(false);
            let m = fetch_meta(&app, &url, ignore).await;
            (
                Value::Null,
                json!({ "url": m.url, "title": m.title, "description": m.description, "preview_image": m.preview_image }),
            )
        }
    };
    Ok(json_response(
        StatusCode::OK,
        &json!({ "bookmark": bookmark, "metadata": metadata, "auto_tags": [] }),
    ))
}

/// Not part of linkding's API: bulk actions for the web UI.
pub async fn bookmarks_bulk(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let action = m.get("action").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ids: Vec<i64> = m
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let tags = clean_tag_names(
        m.get("tags")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    let ph = vec!["?"; ids.len()].join(",");
    let owned_ids = format!("SELECT id FROM bookmarks WHERE owner_id = ? AND id IN ({ph})");
    let mut id_params: Vec<P> = vec![uid.into()];
    id_params.extend(ids.iter().map(|i| P::I(*i)));
    let now = now_micros();

    let mut tx = app.db.pool.begin().await?;
    let simple = |col: &str, val: i64| format!("UPDATE bookmarks SET {col} = {val}, date_modified = ? WHERE owner_id = ? AND id IN ({ph})");
    let upd = match action.as_str() {
        "archive" => Some(simple("is_archived", 1)),
        "unarchive" => Some(simple("is_archived", 0)),
        "read" => Some(simple("unread", 0)),
        "unread" => Some(simple("unread", 1)),
        "share" => Some(simple("shared", 1)),
        "unshare" => Some(simple("shared", 0)),
        _ => None,
    };
    if let Some(sql) = upd {
        let mut p: Vec<P> = vec![now.into()];
        p.extend(id_params.clone());
        app.db.execute(&mut *tx, &sql, &p).await?;
    } else {
        match action.as_str() {
            "delete" => {
                let sql = format!("DELETE FROM bookmark_tags WHERE bookmark_id IN ({owned_ids})");
                app.db.execute(&mut *tx, &sql, &id_params).await?;
                let sql = format!("DELETE FROM bookmarks WHERE owner_id = ? AND id IN ({ph})");
                app.db.execute(&mut *tx, &sql, &id_params).await?;
            }
            "tag" => {
                let tag_ids = ensure_tags(&app.db, &mut tx, uid, &tags).await?;
                let ins = app.db.insert_ignore("INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)");
                let rows = app.db.fetch_all(&mut *tx, &owned_ids, &id_params).await?;
                for r in rows {
                    let bid: i64 = r.try_get(0)?;
                    for t in &tag_ids {
                        app.db.execute(&mut *tx, &ins, &[bid.into(), (*t).into()]).await?;
                    }
                }
            }
            "untag" => {
                if !tags.is_empty() {
                    let tph = vec!["?"; tags.len()].join(",");
                    let sql = format!(
                        "DELETE FROM bookmark_tags WHERE bookmark_id IN ({owned_ids}) AND tag_id IN (SELECT id FROM tags WHERE owner_id = ? AND name_lower IN ({tph}))"
                    );
                    let mut p = id_params.clone();
                    p.push(uid.into());
                    p.extend(tags.iter().map(|t| P::S(t.to_lowercase())));
                    app.db.execute(&mut *tx, &sql, &p).await?;
                }
            }
            _ => return Err(ApiError::field("action", "Unknown action.")),
        }
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ------------------------------------------------------------ tags

fn tag_json(id: i64, name: &str, added: i64) -> Value {
    json!({ "id": id, "name": name, "date_added": iso(added) })
}

pub async fn tags_list(State(app): State<S>, Auth(uid): Auth, headers: HeaderMap, Query(q): Q) -> ApiResult<Response> {
    let (limit, offset) = paging(&q);
    let count: i64 = app
        .db
        .fetch_opt(&app.db.pool, "SELECT COUNT(*) FROM tags WHERE owner_id = ?", &[uid.into()])
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or(0);
    let rows = app
        .db
        .fetch_all(
            &app.db.pool,
            "SELECT id, name, date_added FROM tags WHERE owner_id = ? ORDER BY id LIMIT ? OFFSET ?",
            &[uid.into(), limit.into(), offset.into()],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(tag_json(r.try_get(0)?, &r.try_get::<String, _>(1)?, r.try_get(2)?));
    }
    Ok(page(&headers, "/api/tags/", &q, count, limit, offset, out))
}

pub async fn tags_create(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let name = match m.get("name") {
        None => return Err(ApiError::field("name", "This field is required.")),
        Some(Value::String(s)) => s.trim().to_string(),
        Some(_) => return Err(ApiError::field("name", "Not a valid string.")),
    };
    if name.is_empty() {
        return Err(ApiError::field("name", "This field may not be blank."));
    }
    if name.chars().count() > 64 {
        return Err(ApiError::field("name", "Ensure this field has no more than 64 characters."));
    }
    let mut conn = app.db.pool.acquire().await?;
    let id = ensure_tags(&app.db, &mut conn, uid, &[name]).await?.remove(0);
    let r = app
        .db
        .fetch_opt(&mut *conn, "SELECT id, name, date_added FROM tags WHERE id = ?", &[id.into()])
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(json_response(
        StatusCode::CREATED,
        &tag_json(r.try_get(0)?, &r.try_get::<String, _>(1)?, r.try_get(2)?),
    ))
}

pub async fn tag_get(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let r = app
        .db
        .fetch_opt(&app.db.pool, "SELECT id, name, date_added FROM tags WHERE id = ? AND owner_id = ?", &[id.into(), uid.into()])
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(json_response(StatusCode::OK, &tag_json(r.try_get(0)?, &r.try_get::<String, _>(1)?, r.try_get(2)?)))
}

pub async fn tag_delete(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let mut tx = app.db.pool.begin().await?;
    let n = app.db.execute(&mut *tx, "DELETE FROM tags WHERE id = ? AND owner_id = ?", &[id.into(), uid.into()]).await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    app.db.execute(&mut *tx, "DELETE FROM bookmark_tags WHERE tag_id = ?", &[id.into()]).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Not part of linkding's API: rename a tag.
pub async fn tag_patch(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let name = clean_tag_names([m.get("name").and_then(|v| v.as_str()).unwrap_or("")]).into_iter().next();
    let Some(name) = name else {
        return Err(ApiError::field("name", "This field may not be blank."));
    };
    let lower = name.to_lowercase();
    if let Some(r) = app
        .db
        .fetch_opt(&app.db.pool, "SELECT id FROM tags WHERE owner_id = ? AND name_lower = ?", &[uid.into(), lower.clone().into()])
        .await?
    {
        if r.try_get::<i64, _>(0)? != id {
            return Err(ApiError::field("name", &format!("Tag \"{name}\" already exists.")));
        }
    }
    let n = app
        .db
        .execute(
            &app.db.pool,
            "UPDATE tags SET name = ?, name_lower = ? WHERE id = ? AND owner_id = ?",
            &[name.clone().into(), lower.into(), id.into(), uid.into()],
        )
        .await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    tag_get(State(app), Auth(uid), Path(id)).await
}

/// Not part of linkding's API: tags with bookmark counts for the sidebar.
pub async fn tags_stats(State(app): State<S>, Auth(uid): Auth) -> ApiResult<Response> {
    let rows = app
        .db
        .fetch_all(
            &app.db.pool,
            "SELECT t.id, t.name, (SELECT COUNT(*) FROM bookmark_tags bt WHERE bt.tag_id = t.id) FROM tags t WHERE t.owner_id = ? ORDER BY t.name_lower",
            &[uid.into()],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(json!({ "id": r.try_get::<i64, _>(0)?, "name": r.try_get::<String, _>(1)?, "count": r.try_get::<i64, _>(2)? }));
    }
    Ok(json_response(StatusCode::OK, &out))
}

/// Not part of linkding's API: merge tags into a target tag.
pub async fn tags_merge(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let target = clean_tag_names([m.get("target").and_then(|v| v.as_str()).unwrap_or("")]);
    let sources = clean_tag_names(
        m.get("sources")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
            .unwrap_or_default(),
    );
    if target.is_empty() || sources.is_empty() {
        return Err(ApiError::field("target", "Target and sources are required."));
    }
    let mut tx = app.db.pool.begin().await?;
    let tid = ensure_tags(&app.db, &mut tx, uid, &target).await?[0];
    let ins = app
        .db
        .insert_ignore("INTO bookmark_tags (bookmark_id, tag_id) SELECT bookmark_id, ? FROM bookmark_tags WHERE tag_id = ?");
    for s in sources {
        let row = app
            .db
            .fetch_opt(&mut *tx, "SELECT id FROM tags WHERE owner_id = ? AND name_lower = ?", &[uid.into(), s.to_lowercase().into()])
            .await?;
        let Some(row) = row else { continue };
        let sid: i64 = row.try_get(0)?;
        if sid == tid {
            continue;
        }
        app.db.execute(&mut *tx, &ins, &[tid.into(), sid.into()]).await?;
        app.db.execute(&mut *tx, "DELETE FROM bookmark_tags WHERE tag_id = ?", &[sid.into()]).await?;
        app.db.execute(&mut *tx, "DELETE FROM tags WHERE id = ?", &[sid.into()]).await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ------------------------------------------------------------ user

async fn profile_json(app: &S, uid: i64) -> ApiResult<Value> {
    let r = app
        .db
        .fetch_opt(
            &app.db.pool,
            "SELECT username, settings, enable_sharing, enable_public_sharing FROM users WHERE id = ?",
            &[uid.into()],
        )
        .await?
        .ok_or_else(ApiError::not_found)?;
    let mut out = default_settings();
    if let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(&r.try_get::<String, _>(1)?) {
        for (k, v) in stored {
            out[k] = v;
        }
    }
    out["username"] = json!(r.try_get::<String, _>(0)?);
    out["enable_sharing"] = json!(r.try_get::<i64, _>(2)? != 0);
    out["enable_public_sharing"] = json!(r.try_get::<i64, _>(3)? != 0);
    out["version"] = json!(VERSION);
    Ok(out)
}

pub async fn profile_get(State(app): State<S>, Auth(uid): Auth) -> ApiResult<Response> {
    Ok(json_response(StatusCode::OK, &profile_json(&app, uid).await?))
}

pub async fn profile_patch(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let mut current = profile_json(&app, uid).await?;
    const ALLOWED: [&str; 9] = [
        "theme",
        "bookmark_date_display",
        "bookmark_link_target",
        "web_archive_integration",
        "tag_search",
        "enable_favicons",
        "display_url",
        "permanent_notes",
        "search_preferences",
    ];
    let mut settings = default_settings();
    for k in ALLOWED.iter().chain(["items_per_page"].iter()) {
        if let Some(v) = m.get(*k) {
            current[*k] = v.clone();
        }
        settings[*k] = current[*k].clone();
    }
    let sharing = m.get("enable_sharing").and_then(|v| v.as_bool()).unwrap_or_else(|| current["enable_sharing"].as_bool().unwrap_or(false));
    let public = sharing && m.get("enable_public_sharing").and_then(|v| v.as_bool()).unwrap_or_else(|| current["enable_public_sharing"].as_bool().unwrap_or(false));
    app.db
        .execute(
            &app.db.pool,
            "UPDATE users SET settings = ?, enable_sharing = ?, enable_public_sharing = ? WHERE id = ?",
            &[settings.to_string().into(), sharing.into(), public.into(), uid.into()],
        )
        .await?;
    Ok(json_response(StatusCode::OK, &profile_json(&app, uid).await?))
}

pub async fn password_change(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body)?;
    let cur = m.get("current").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let new = m.get("new").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if new.len() < 8 {
        return Err(ApiError::field("new", "This password is too short. It must contain at least 8 characters."));
    }
    let hash: String = app
        .db
        .fetch_opt(&app.db.pool, "SELECT password_hash FROM users WHERE id = ?", &[uid.into()])
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or_default();
    let ok = tokio::task::spawn_blocking(move || verify_password(&cur, &hash)).await.unwrap_or(false);
    if !ok {
        return Err(ApiError::field("current", "Your old password was entered incorrectly."));
    }
    let nh = tokio::task::spawn_blocking(move || hash_password(&new)).await.unwrap_or_default();
    app.db
        .execute(&app.db.pool, "UPDATE users SET password_hash = ? WHERE id = ?", &[nh.into(), uid.into()])
        .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn tokens_list(State(app): State<S>, Auth(uid): Auth) -> ApiResult<Response> {
    let rows = app
        .db
        .fetch_all(&app.db.pool, "SELECT id, name, token, created FROM api_tokens WHERE user_id = ? ORDER BY id", &[uid.into()])
        .await?;
    let mut out = Vec::new();
    for r in rows {
        out.push(json!({
            "id": r.try_get::<i64, _>(0)?,
            "name": r.try_get::<String, _>(1)?,
            "token": r.try_get::<String, _>(2)?,
            "created": iso(r.try_get::<i64, _>(3)? * 1_000_000),
        }));
    }
    Ok(json_response(StatusCode::OK, &out))
}

pub async fn tokens_create(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = parse_body(&body).unwrap_or_default();
    let name: String = m.get("name").and_then(|v| v.as_str()).unwrap_or("").chars().take(128).collect();
    let token = random_hex(20);
    let id = app
        .db
        .insert(
            &app.db.pool,
            "INSERT INTO api_tokens (user_id, token, name, created) VALUES (?, ?, ?, ?)",
            &[uid.into(), token.clone().into(), name.clone().into(), now_secs().into()],
        )
        .await?;
    Ok(json_response(StatusCode::CREATED, &json!({ "id": id, "name": name, "token": token })))
}

pub async fn tokens_delete(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let n = app
        .db
        .execute(&app.db.pool, "DELETE FROM api_tokens WHERE id = ? AND user_id = ?", &[id.into(), uid.into()])
        .await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    if let Ok(mut t) = app.tokens.write() {
        t.clear();
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ------------------------------------------------------------ bundles

const BUNDLE_COLS: &str =
    "id, name, search, any_tags, all_tags, excluded_tags, filter_unread, filter_shared, sort_order, date_created, date_modified";

fn bundle_json(r: &sqlx::any::AnyRow) -> Result<Value, sqlx::Error> {
    Ok(json!({
        "id": r.try_get::<i64, _>(0)?,
        "name": r.try_get::<String, _>(1)?,
        "search": r.try_get::<String, _>(2)?,
        "any_tags": r.try_get::<String, _>(3)?,
        "all_tags": r.try_get::<String, _>(4)?,
        "excluded_tags": r.try_get::<String, _>(5)?,
        "filter_unread": r.try_get::<String, _>(6)?,
        "filter_shared": r.try_get::<String, _>(7)?,
        "order": r.try_get::<i64, _>(8)?,
        "date_created": iso(r.try_get::<i64, _>(9)?),
        "date_modified": iso(r.try_get::<i64, _>(10)?),
    }))
}

async fn get_bundle(app: &S, uid: i64, id: i64) -> ApiResult<Option<Value>> {
    let sql = format!("SELECT {BUNDLE_COLS} FROM bundles WHERE id = ? AND owner_id = ?");
    let row = app.db.fetch_opt(&app.db.pool, &sql, &[id.into(), uid.into()]).await?;
    Ok(row.map(|r| bundle_json(&r)).transpose()?)
}

pub async fn bundles_list(State(app): State<S>, Auth(uid): Auth, headers: HeaderMap, Query(q): Q) -> ApiResult<Response> {
    let (limit, offset) = paging(&q);
    let sql = format!("SELECT {BUNDLE_COLS} FROM bundles WHERE owner_id = ? ORDER BY sort_order, id");
    let rows = app.db.fetch_all(&app.db.pool, &sql, &[uid.into()]).await?;
    let all = rows.iter().map(bundle_json).collect::<Result<Vec<_>, _>>()?;
    let count = all.len() as i64;
    let results: Vec<Value> = all.into_iter().skip(offset as usize).take(limit as usize).collect();
    Ok(page(&headers, "/api/bundles/", &q, count, limit, offset, results))
}

pub async fn bundle_get(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let b = get_bundle(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(json_response(StatusCode::OK, &b))
}

fn bundle_fields(m: &Map<String, Value>, create: bool) -> ApiResult<Map<String, Value>> {
    let mut errs = Map::new();
    let mut out = Map::new();
    for (key, max) in [("name", 256usize), ("search", 256), ("any_tags", 1024), ("all_tags", 1024), ("excluded_tags", 1024)] {
        match m.get(key) {
            None if create && key == "name" => {
                errs.insert(key.into(), json!(["This field is required."]));
            }
            None => {}
            Some(Value::String(s)) if s.chars().count() <= max => {
                if key == "name" && s.trim().is_empty() {
                    errs.insert(key.into(), json!(["This field may not be blank."]));
                } else {
                    out.insert(key.into(), json!(s.trim()));
                }
            }
            Some(Value::String(_)) => {
                errs.insert(key.into(), json!([format!("Ensure this field has no more than {max} characters.")]));
            }
            Some(_) => {
                errs.insert(key.into(), json!(["Not a valid string."]));
            }
        }
    }
    for key in ["filter_unread", "filter_shared"] {
        match m.get(key).and_then(|v| v.as_str()) {
            None if !m.contains_key(key) => {}
            Some(v @ ("off" | "yes" | "no")) => {
                out.insert(key.into(), json!(v));
            }
            _ => {
                errs.insert(key.into(), json!(["Must be one of: off, yes, no."]));
            }
        }
    }
    if errs.is_empty() {
        Ok(out)
    } else {
        Err(ApiError { status: StatusCode::BAD_REQUEST, body: Value::Object(errs), www_auth: false })
    }
}

fn s(m: &Map<String, Value>, k: &str, d: &str) -> String {
    m.get(k).and_then(|v| v.as_str()).unwrap_or(d).to_string()
}

pub async fn bundle_create(State(app): State<S>, Auth(uid): Auth, body: Bytes) -> ApiResult<Response> {
    let m = bundle_fields(&parse_body(&body)?, true)?;
    let next: i64 = app
        .db
        .fetch_opt(&app.db.pool, "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM bundles WHERE owner_id = ?", &[uid.into()])
        .await?
        .map(|r| r.try_get(0))
        .transpose()?
        .unwrap_or(0);
    let now = now_micros();
    let id = app
        .db
        .insert(
            &app.db.pool,
            "INSERT INTO bundles (owner_id, name, search, any_tags, all_tags, excluded_tags, filter_unread, filter_shared, sort_order, date_created, date_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            &[
                uid.into(),
                s(&m, "name", "").into(),
                s(&m, "search", "").into(),
                s(&m, "any_tags", "").into(),
                s(&m, "all_tags", "").into(),
                s(&m, "excluded_tags", "").into(),
                s(&m, "filter_unread", "off").into(),
                s(&m, "filter_shared", "off").into(),
                next.into(),
                now.into(),
                now.into(),
            ],
        )
        .await?;
    let b = get_bundle(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(json_response(StatusCode::CREATED, &b))
}

async fn bundle_update(app: S, uid: i64, id: i64, body: Bytes, partial: bool) -> ApiResult<Response> {
    get_bundle(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    let m = bundle_fields(&parse_body(&body)?, !partial)?;
    let mut sets = vec!["date_modified = ?".to_string()];
    let mut p: Vec<P> = vec![now_micros().into()];
    for (k, v) in &m {
        sets.push(format!("{k} = ?"));
        p.push(v.as_str().unwrap_or("").into());
    }
    p.push(id.into());
    p.push(uid.into());
    let sql = format!("UPDATE bundles SET {} WHERE id = ? AND owner_id = ?", sets.join(", "));
    app.db.execute(&app.db.pool, &sql, &p).await?;
    let b = get_bundle(&app, uid, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(json_response(StatusCode::OK, &b))
}

pub async fn bundle_put(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>, body: Bytes) -> ApiResult<Response> {
    bundle_update(app, uid, id, body, false).await
}

pub async fn bundle_patch(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>, body: Bytes) -> ApiResult<Response> {
    bundle_update(app, uid, id, body, true).await
}

pub async fn bundle_delete(State(app): State<S>, Auth(uid): Auth, Path(id): Path<i64>) -> ApiResult<Response> {
    let n = app
        .db
        .execute(&app.db.pool, "DELETE FROM bundles WHERE id = ? AND owner_id = ?", &[id.into(), uid.into()])
        .await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    // keep the ordering contiguous like linkding does
    let rows = app
        .db
        .fetch_all(&app.db.pool, "SELECT id FROM bundles WHERE owner_id = ? ORDER BY sort_order, id", &[uid.into()])
        .await?;
    for (i, r) in rows.iter().enumerate() {
        app.db
            .execute(&app.db.pool, "UPDATE bundles SET sort_order = ? WHERE id = ?", &[(i as i64).into(), r.try_get::<i64, _>(0)?.into()])
            .await?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
