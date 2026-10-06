#!/usr/bin/env bash
# End-to-end API smoke test. Usage: scripts/smoke.sh [BASE_URL] [USER] [PASS]
# Works against any backing database (sqlite / postgres / mysql).
B="${1:-http://localhost:9090}"; U="${2:-admin}"; PW="${3:-secretpass1}"
JAR=$(mktemp); PASS=0; FAILN=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAILN=$((FAILN+1)); echo "  FAIL $1"; echo "       got: $2"; }
has()  { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "$2"; fi; }
hasnt(){ if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "$2"; else ok "$1"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
J=(-H 'Content-Type: application/json')

echo "== auth"
has "health" "$(curl -s $B/health)" '"status":"healthy"'
has "login ok" "$(curl -s -c $JAR -H 'X-Requested-With: ld' "${J[@]}" -d "{\"username\":\"$U\",\"password\":\"$PW\"}" $B/login/)" '"ok":true'
[ "$(code -H 'X-Requested-With: ld' "${J[@]}" -d "{\"username\":\"$U\",\"password\":\"nope\"}" $B/login/)" = 401 ] && ok "login bad -> 401" || bad "login bad -> 401" ""
[ "$(code $B/api/bookmarks/)" = 401 ] && ok "no credentials -> 401" || bad "no credentials -> 401" ""
[ "$(code -H 'Authorization: Token deadbeef' $B/api/bookmarks/)" = 401 ] && ok "bad token -> 401" || bad "bad token -> 401" ""
[ "$(code -b $JAR -d '{}' $B/api/bookmarks/)" = 403 ] && ok "cookie POST without CSRF header -> 403" || bad "csrf" ""
TOK=$(curl -s -b $JAR -H 'X-Requested-With: ld' "${J[@]}" -d '{"name":"smoke"}' $B/api/user/tokens/ | sed 's/.*"token":"\([a-f0-9]*\)".*/\1/')
[ ${#TOK} = 40 ] && ok "token created (40 hex)" || bad "token" "$TOK"
A=(-H "Authorization: Token $TOK")
has "Bearer accepted" "$(curl -s -H "Authorization: Bearer $TOK" $B/api/user/profile/)" '"version"'

echo "== cleanup (makes the test re-runnable)"
for p in /api/bookmarks/ /api/bookmarks/archived/; do
  for i in $(curl -s "${A[@]}" "$B$p?limit=10000" | grep -o '"id":[0-9]*,"url"' | grep -o '[0-9]*'); do curl -s -o /dev/null -X DELETE "${A[@]}" $B/api/bookmarks/$i/; done
done
for i in $(curl -s "${A[@]}" "$B/api/tags/?limit=10000" | grep -o '"id":[0-9]*,"name"' | grep -o '[0-9]*'); do curl -s -o /dev/null -X DELETE "${A[@]}" $B/api/tags/$i/; done
curl -s -o /dev/null -b $JAR -X PATCH -H 'X-Requested-With: ld' "${J[@]}" -d '{"enable_sharing":false,"enable_public_sharing":false}' $B/api/user/profile/
has "clean slate" "$(curl -s "${A[@]}" $B/api/bookmarks/)" '"count":0,'

echo "== bookmarks"
R=$(curl -s "${A[@]}" "${J[@]}" -d '{"url":"https://Example.com/Path/?b=2&a=1","title":"Example","description":"first desc","notes":"my notes","tag_names":["Rust","web dev","rust"],"unread":true}' "$B/api/bookmarks/?disable_scraping")
has "create returns bookmark" "$R" '"title":"Example"'
has "tags cleaned + sorted" "$R" '"tag_names":["Rust","web-dev"]'
ID=$(printf '%s' "$R" | sed 's/^{"id":\([0-9]*\),.*/\1/')
[ -n "$ID" ] && [ "$ID" -gt 0 ] && ok "id=$ID" || bad "id" "$R"
R=$(curl -s "${A[@]}" "${J[@]}" -d '{"url":"https://example.com/Path?a=1&b=2","title":"Renamed","tag_names":["alpha"]}' "$B/api/bookmarks/?disable_scraping")
has "upsert by normalized url keeps id" "$R" "\"id\":$ID,"
has "upsert overwrote title" "$R" '"title":"Renamed"'
has "upsert replaced tags" "$R" '"tag_names":["alpha"]'
has "upsert kept description" "$R" '"description":"first desc"'
has "count is 1 after upsert" "$(curl -s "${A[@]}" $B/api/bookmarks/)" '"count":1,'
curl -s "${A[@]}" "${J[@]}" -d '{"url":"https://rust-lang.org","title":"Rust Language","description":"A language empowering everyone","tag_names":["rust","lang"]}' "$B/api/bookmarks/?disable_scraping" >/dev/null
curl -s "${A[@]}" "${J[@]}" -d '{"url":"https://news.ycombinator.com","title":"Hacker News","tag_names":["news"]}' "$B/api/bookmarks/?disable_scraping" >/dev/null
has "validation: missing url" "$(curl -s "${A[@]}" "${J[@]}" -d '{}' $B/api/bookmarks/)" '{"url":["This field is required."]}'
has "validation: bad url" "$(curl -s "${A[@]}" "${J[@]}" -d '{"url":"nope"}' $B/api/bookmarks/)" 'Enter a valid URL.'
has "double slash + no trailing slash tolerated" "$(curl -s "${A[@]}" "$B//api/bookmarks?limit=1")" '"count":3,'
has "pagination next link" "$(curl -s "${A[@]}" "$B/api/bookmarks/?limit=1")" '"next":"http://'
has "get one" "$(curl -s "${A[@]}" $B/api/bookmarks/$ID/)" '"title":"Renamed"'
[ "$(code "${A[@]}" $B/api/bookmarks/999999/)" = 404 ] && ok "404 on missing" || bad "404" ""
has "PATCH" "$(curl -s -X PATCH "${A[@]}" "${J[@]}" -d '{"notes":"patched","shared":true}' $B/api/bookmarks/$ID/)" '"notes":"patched"'
has "PUT needs url" "$(curl -s -X PUT "${A[@]}" "${J[@]}" -d '{"title":"x"}' $B/api/bookmarks/$ID/)" '"url":["This field is required."]'
has "duplicate url on update" "$(curl -s -X PATCH "${A[@]}" "${J[@]}" -d '{"url":"https://rust-lang.org/"}' $B/api/bookmarks/$ID/)" 'A bookmark with this URL already exists.'

echo "== search"
q() { curl -s "${A[@]}" --get --data-urlencode "q=$1" $B/api/bookmarks/; }
has "term"            "$(q 'hacker')"            '"count":1,'
has "phrase"          "$(q '"language empowering"')" '"count":1,'
has "#tag"            "$(q '#rust')"             '"count":1,'
has "implicit and"    "$(q '#rust language')"    '"count":1,'
has "or"              "$(q 'hacker or renamed')" '"count":2,'
has "not"             "$(q 'not #rust')"         '"count":2,'
has "parens"          "$(q '(hacker or renamed) and not #news')" '"count":1,'
has "!unread"         "$(q '!unread')"           '"count":1,'
has "!untagged"       "$(q '!untagged')"         '"count":0,'
has "syntax error -> empty" "$(q '(hacker')"     '"count":0,'
has "like wildcard is literal" "$(q '100%')"    '"count":0,'

echo "== archive / tags / bulk"
[ "$(code -X POST "${A[@]}" $B/api/bookmarks/$ID/archive/)" = 204 ] && ok "archive 204" || bad "archive" ""
has "archived list" "$(curl -s "${A[@]}" $B/api/bookmarks/archived/)" '"count":1,'
has "active list shrank" "$(curl -s "${A[@]}" $B/api/bookmarks/)" '"count":2,'
[ "$(code -X POST "${A[@]}" $B/api/bookmarks/$ID/unarchive/)" = 204 ] && ok "unarchive 204" || bad "unarchive" ""
has "tags list" "$(curl -s "${A[@]}" "$B/api/tags/?limit=5000")" '"name":"lang"'
has "tag create is get-or-create" "$(curl -s "${A[@]}" "${J[@]}" -d '{"name":"RUST"}' $B/api/tags/)" '"name":"Rust"'
has "tag stats" "$(curl -s "${A[@]}" $B/api/tags/stats/)" '"name":"news"'
IDS=$(curl -s "${A[@]}" $B/api/bookmarks/ | grep -o '"id":[0-9]*,"url"' | grep -o '[0-9]*' | paste -sd, -)
[ "$(code -X POST "${A[@]}" "${J[@]}" -d "{\"action\":\"tag\",\"ids\":[$IDS],\"tags\":[\"bulk\"]}" $B/api/bookmarks/bulk/)" = 204 ] && ok "bulk tag" || bad "bulk tag" ""
has "bulk applied" "$(q '#bulk')" '"count":3,'
[ "$(code -X POST "${A[@]}" "${J[@]}" -d '{"action":"read","ids":['$ID']}' $B/api/bookmarks/bulk/)" = 204 ] && ok "bulk read" || bad "bulk read" ""

echo "== check endpoint"
has "check existing" "$(curl -s "${A[@]}" --get --data-urlencode 'url=https://rust-lang.org' $B/api/bookmarks/check/)" '"title":"Rust Language"'
has "check unknown has null bookmark" "$(curl -s "${A[@]}" --get --data-urlencode 'url=http://127.0.0.1:1/x' $B/api/bookmarks/check/)" '"bookmark":null'
has "check echoes url in metadata" "$(curl -s "${A[@]}" --get --data-urlencode 'url=http://127.0.0.1:1/x' $B/api/bookmarks/check/)" '"url":"http://127.0.0.1:1/x"'

echo "== export / import (linkding format)"
EXP=$(curl -s -b $JAR "$B/settings/export")
has "export doctype" "$EXP" '<!DOCTYPE NETSCAPE-Bookmark-file-1>'
has "export attrs" "$EXP" 'PRIVATE="0" TOREAD="0"'
has "export tags" "$EXP" 'TAGS="Rust,bulk,lang"'
printf '%s' "$EXP" > .smoke-export.html
cat > .smoke-import.html <<'HTML'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
<DT><H3>Folder</H3>
<DL><p>
<DT><A HREF="https://imported.example/one" ADD_DATE="1600000000" LAST_MODIFIED="1600000100" PRIVATE="0" TOREAD="1" TAGS="imp,linkding:bookmarks.archived">Imported &amp; One</A>
<DD>desc[linkding-notes]some notes[/linkding-notes]
<DT><A HREF="https://rust-lang.org/">dup</A>
<DT><A HREF="not a url">bad</A>
</DL><p>
</DL><p>
HTML
R=$(curl -s -b $JAR -H 'X-Requested-With: ld' -F import_file=@.smoke-import.html -F map_private_flag=on $B/settings/import)
has "import counts" "$R" '"imported":2'; has "import failures" "$R" '"failed":1'
R=$(curl -s "${A[@]}" --get --data-urlencode 'q=#imp' $B/api/bookmarks/archived/)
has "imported archived + title decoded" "$R" '"title":"Imported & One"'
has "imported notes split from desc" "$R" '"description":"desc","notes":"some notes"'
has "imported shared via PRIVATE=0" "$R" '"shared":true'
has "imported unread" "$R" '"unread":true'
has "imported dates" "$R" '"date_added":"2020-09-13T12:26:40.000000Z"'
has "dup keeps single rust-lang" "$(curl -s "${A[@]}" --get --data-urlencode 'q=rust-lang.org' $B/api/bookmarks/)" '"count":1,'

echo "== bundles"
R=$(curl -s "${A[@]}" "${J[@]}" -d '{"name":"B1","all_tags":"bulk","excluded_tags":"news"}' $B/api/bundles/)
has "bundle create" "$R" '"name":"B1"'
has "bundle defaults" "$R" '"filter_unread":"off"'
BID=$(printf '%s' "$R" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
curl -s "${A[@]}" "${J[@]}" -d '{"name":"B2","any_tags":"lang news"}' $B/api/bundles/ >/dev/null
curl -s "${A[@]}" "${J[@]}" -d '{"name":"B3","search":"hacker"}' $B/api/bundles/ >/dev/null
has "bundle order" "$(curl -s "${A[@]}" $B/api/bundles/)" '"order":2'
has "bundle all+excluded filter" "$(curl -s "${A[@]}" "$B/api/bookmarks/?bundle=$BID")" '"count":2,'
BID2=$(curl -s "${A[@]}" $B/api/bundles/ | tr '{' '
' | grep '"name":"B2"' | grep -o '"id":[0-9]*' | grep -o '[0-9]*')
BID3=$(curl -s "${A[@]}" $B/api/bundles/ | tr '{' '
' | grep '"name":"B3"' | grep -o '"id":[0-9]*' | grep -o '[0-9]*')
has "bundle any_tags filter" "$(curl -s "${A[@]}" "$B/api/bookmarks/?bundle=$BID2")" '"count":2,'
has "bundle search filter" "$(curl -s "${A[@]}" "$B/api/bookmarks/?bundle=$BID3")" '"count":1,'
has "bundle + q combine" "$(curl -s "${A[@]}" --get --data-urlencode 'q=#lang' "$B/api/bookmarks/?bundle=$BID2")" '"count":1,'
has "bundle patch" "$(curl -s -X PATCH "${A[@]}" "${J[@]}" -d '{"name":"B1x","filter_unread":"no"}' $B/api/bundles/$BID/)" '"name":"B1x"'
has "bundle bad enum" "$(curl -s -X PATCH "${A[@]}" "${J[@]}" -d '{"filter_shared":"maybe"}' $B/api/bundles/$BID/)" 'Must be one of'
[ "$(code -X DELETE "${A[@]}" $B/api/bundles/$BID/)" = 204 ] && ok "bundle delete" || bad "bundle delete" ""
has "bundle renumbered" "$(curl -s "${A[@]}" $B/api/bundles/)" '"order":1'
for i in $BID2 $BID3; do curl -s -o /dev/null -X DELETE "${A[@]}" $B/api/bundles/$i/; done

echo "== tag cloud / profile / custom css / bundle order+preview"
has "tag cloud lists tags of matching bookmarks" "$(curl -s "${A[@]}" --get --data-urlencode 'q=hacker' "$B/api/tags/cloud/")" '"news"'
hasnt "tag cloud excludes other tags" "$(curl -s "${A[@]}" --get --data-urlencode 'q=hacker' "$B/api/tags/cloud/")" '"lang"'
has "tag cloud invalid query -> empty" "$(curl -s "${A[@]}" --get --data-urlencode 'q=(hacker' "$B/api/tags/cloud/")" '[]'
has "profile PATCH new settings" "$(curl -s -X PATCH "${A[@]}" "${J[@]}" -d '{"tag_grouping":"disabled","sticky_pagination":true,"custom_css":"body{outline:1px solid red}","items_per_page":15}' $B/api/user/profile/)" '"tag_grouping":"disabled"'
has "profile persisted" "$(curl -s "${A[@]}" $B/api/user/profile/)" '"items_per_page":15'
has "custom css served" "$(curl -s -b $JAR $B/custom_css)" 'outline:1px solid red'
curl -s -o /dev/null -X PATCH "${A[@]}" "${J[@]}" -d '{"tag_grouping":"alphabetical","sticky_pagination":false,"custom_css":"","items_per_page":30}' $B/api/user/profile/
PV=$(curl -s "${A[@]}" --get --data-urlencode 'pv=1' --data-urlencode 'pv_any=news lang' "$B/api/bookmarks/")
has "bundle inline preview filter" "$PV" '"count":2,'
echo "== shared / delete"
has "shared requires sharing enabled" "$(curl -s $B/api/bookmarks/shared/)" '"count":0,'
curl -s -b $JAR -X PATCH -H 'X-Requested-With: ld' "${J[@]}" -d '{"enable_sharing":true,"enable_public_sharing":true}' $B/api/user/profile/ >/dev/null
has "public shared list" "$(curl -s $B/api/bookmarks/shared/)" '"title":"Renamed"'
[ "$(code -X DELETE "${A[@]}" $B/api/bookmarks/$ID/)" = 204 ] && ok "delete 204" || bad "delete" ""
[ "$(code "${A[@]}" $B/api/bookmarks/$ID/)" = 404 ] && ok "deleted -> 404" || bad "deleted 404" ""

echo "== pages"
[ "$(code -b $JAR $B/bookmarks)" = 200 ] && ok "/bookmarks 200 with session" || bad "/bookmarks" ""
[ "$(code $B/bookmarks)" = 303 ] && ok "/bookmarks redirects anon" || bad "/bookmarks anon" "$(code $B/bookmarks)"
[ "$(code $B/static/app.js)" = 200 ] && ok "static app.js" || bad "static" ""

rm -f .smoke-export.html .smoke-import.html
echo; echo "passed: $PASS  failed: $FAILN"; rm -f $JAR
[ $FAILN = 0 ]
