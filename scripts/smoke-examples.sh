#!/bin/bash
# Smoke-test every example application in examples/.
#
# For each example:
#   1. compile main.cln with the old-toolchain compiler (--plugins);
#   2. start it in clean-server on a free port, from the example folder (so
#      render() finds app/ui/web/pages and ./public is mounted), with an
#      in-memory SQLite database and a random JWT secret;
#   3. request its routes and check the answers:
#      - every page under app/ui/web/pages/ without a [param] segment is
#        served (200) at its file-based URL (frame-ui-semantics UI-R001..R003),
#        except pages a <page auth="required"> / roles= declaration or a
#        routes: guard protects (their example flow checks them);
#      - every GET endpoint without a :param answers 200, or 401/403 when
#        it is role-guarded;
#      - every /public/... stylesheet the home page links is served (200);
#      - example-specific flows (register/login/session) listed below.
#
# A browser-target example (no app/ folder, root index.html) is compiled
# with --target browser and checked for the generated loader and the event
# handlers its index.html relies on.
#
# Usage: scripts/smoke-examples.sh [example ...]   (default: all)
# Environment: CLEEN_CLN, CLEEN_SERVER (default ~/.cleen/bin/{cln,clean-server};
# plain `cln` on PATH is a different toolchain and is never used).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXAMPLES_DIR="$(cd "$SCRIPT_DIR/../examples" && pwd)"
CLN="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"
SERVER="${CLEEN_SERVER:-$HOME/.cleen/bin/clean-server}"
WORK="$(mktemp -d)"
SERVER_PID=""
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"' EXIT

for bin in "$CLN" "$SERVER"; do
    [ -x "$bin" ] || { echo "not found: $bin" >&2; exit 1; }
done
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

FAILED_EXAMPLES=()
CHECKS=0
CHECK_FAILS=0

ok()   { CHECKS=$((CHECKS + 1)); echo "    ok   $*"; }
bad()  { CHECKS=$((CHECKS + 1)); CHECK_FAILS=$((CHECK_FAILS + 1)); EXAMPLE_FAILED=1; echo "    FAIL $*"; }

free_port() {
    python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

# status <method> <path> [extra curl args...]
status() {
    local method="$1" path="$2"; shift 2
    curl -s -o /dev/null -m 10 -w '%{http_code}' -X "$method" "$@" "http://127.0.0.1:$PORT$path"
}

# expect <expected-codes-regex> <method> <path> [curl args...]
expect() {
    local want="$1" method="$2" path="$3"; shift 3
    local got
    got="$(status "$method" "$path" "$@")"
    if [[ "$got" =~ ^($want)$ ]]; then ok "$method $path -> $got"; else bad "$method $path -> $got (want $want)"; fi
}

# Session cookie from a login/register response.
cookie_from() {
    grep -i '^set-cookie:' | head -1 | sed -E 's/^[^:]*: *//; s/;.*//' | tr -d '\r'
}

# page_url app/ui/web/pages/a/index.html -> /a
page_url() {
    local rel="${1#app/ui/web/pages/}"
    rel="${rel%.html}"
    rel="${rel%index}"
    rel="${rel%/}"
    echo "/$rel"
}

start_server() {
    local example_dir="$1" wasm="$2"
    PORT="$(free_port)"
    LOG="$WORK/$(basename "$example_dir").log"
    JWT_SECRET_VALUE="$(openssl rand -hex 32)"
    (cd "$example_dir" && DATABASE_URL="sqlite::memory:" JWT_SECRET="$JWT_SECRET_VALUE" \
        exec "$SERVER" "$wasm" --port "$PORT") > "$LOG" 2>&1 &
    SERVER_PID=$!
    local i
    for i in $(seq 1 100); do
        grep -qiE 'listening' "$LOG" && return 0
        kill -0 "$SERVER_PID" 2>/dev/null || return 1
        sleep 0.1
    done
    return 1
}

stop_server() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
}

# expect_redirect <location-path> <path> [curl args...] — a 302 to location.
expect_redirect() {
    local want="$1" path="$2"; shift 2
    local got
    got="$(curl -s -o /dev/null -m 10 -w '%{http_code} %{redirect_url}' "$@" "http://127.0.0.1:$PORT$path")"
    if [ "$got" = "302 http://127.0.0.1:$PORT$want" ]; then ok "GET $path -> 302 $want"; else bad "GET $path -> $got (want 302 $want)"; fi
}

# An HS256 JWT for user 1 with the given role, signed with the server's
# JWT_SECRET (clean-server reads `Authorization: Bearer` tokens).
jwt_for_role() {
    python3 - "$JWT_SECRET_VALUE" "$1" <<'PY'
import base64, hashlib, hmac, json, sys, time
secret, role = sys.argv[1].encode(), sys.argv[2]
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
body = b64(json.dumps({"sub": 1, "role": role, "exp": int(time.time()) + 600}).encode())
sig = b64(hmac.new(secret, (head + "." + body).encode(), hashlib.sha256).digest())
print(head + "." + body + "." + sig)
PY
}

# True when a page is protected by its <page auth="required"> / roles=
# declaration or by a routes: guard pattern (the generic page check skips
# it; the example's flow checks it).
page_is_protected() {
    local dir="$1" file="$2" url="$3"
    grep -qE '<page[^>]*(auth="required"|roles=)' "$dir/$file" && return 0
    local pattern prefix
    while IFS= read -r pattern; do
        prefix="${pattern%%\**}"
        [ -n "$prefix" ] && [[ "$url" == "$prefix"* ]] && return 0
    done < <(grep -rhoE 'guard: *"[^"]+"' "$dir/app" --include='*.cln' 2>/dev/null | sed -E 's/.*"([^"]+)"/\1/')
    return 1
}

# ---- example-specific flows -------------------------------------------------

# Page access (frame-ui-semantics UI-B015 / UI-B016, frame-server.ebnf §10.2).
flow_auth_guards() {
    local admin editor viewer
    admin="$(jwt_for_role admin)"; editor="$(jwt_for_role editor)"; viewer="$(jwt_for_role user)"
    expect_redirect /login /account
    expect 200 GET /account -H "Authorization: Bearer $viewer"
    expect_redirect /forbidden /editorial
    expect_redirect /forbidden /editorial -H "Authorization: Bearer $viewer"
    expect 200 GET /editorial -H "Authorization: Bearer $editor"
    expect 200 GET /editorial -H "Authorization: Bearer $admin"
    expect 401 GET /admin/panel
    expect 401 GET /admin/panel -H "Authorization: Bearer $editor"
    expect 200 GET /admin/panel -H "Authorization: Bearer $admin"
    expect 200 GET /login
    expect_redirect / /login -H "Authorization: Bearer $viewer"
}

flow_todo_api() {
    expect 200 POST /auth/register -d '{"email":"ann@example.com","password":"correct-horse-1","name":"Ann"}'
    local c
    c="$(curl -s -i -m 10 -X POST "http://127.0.0.1:$PORT/auth/login" -d '{"email":"ann@example.com","password":"correct-horse-1"}' | cookie_from)"
    if [ -n "$c" ]; then ok "login sets a session cookie"; else bad "login sets no session cookie"; fi
    expect 200 GET /auth/me -H "Cookie: $c"
    expect 200 GET /todos -H "Cookie: $c"
    expect '401|403' GET /admin/users -H "Cookie: $c"
    expect 401 GET /todos
}

flow_full_stack() {
    expect 200 POST /api/register -d '{"email":"ann@example.com","password":"correct-horse-1","name":"Ann"}'
    local c
    c="$(curl -s -i -m 10 -X POST "http://127.0.0.1:$PORT/api/login" -d '{"email":"ann@example.com","password":"correct-horse-1"}' | cookie_from)"
    if [ -n "$c" ]; then ok "login sets a session cookie"; else bad "login sets no session cookie"; fi
    expect 200 GET /api/me -H "Cookie: $c"
}

flow_blog_app() {
    local c
    c="$(curl -s -i -m 10 -X POST "http://127.0.0.1:$PORT/api/auth/register" -d '{"email":"ann@example.com","password":"correct-horse-1","name":"Ann"}' | cookie_from)"
    if [ -n "$c" ]; then ok "register sets a session cookie"; else bad "register sets no session cookie"; fi
    expect 200 GET /api/me -H "Cookie: $c"
}

flow_complete_demo() {
    expect 303 POST /register --data 'username=ann&email=ann%40example.com&password=correct-horse-1&password_confirm=correct-horse-1'
    expect 200 POST /api/users/login -d '{"email":"ann@example.com","password":"correct-horse-1"}'
    expect 401 POST /api/users/login -d '{"email":"ann@example.com","password":"wrong-password"}'
    local body
    body="$(curl -s -m 10 "http://127.0.0.1:$PORT/dashboard")"
    if echo "$body" | grep -q 'ann@example.com'; then ok "dashboard lists the registered user"; else bad "dashboard does not list the registered user"; fi
    body="$(curl -s -m 10 "http://127.0.0.1:$PORT/api/users")"
    if echo "$body" | grep -q 'password_hash'; then bad "GET /api/users exposes password_hash"; else ok "GET /api/users hides password_hash"; fi
    # The home page's <canvas data-scene> gets frame.canvas's runtime, which
    # the build emits and the server serves.
    body="$(curl -s -m 10 "http://127.0.0.1:$PORT/")"
    if echo "$body" | grep -q "<script src='/frame-canvas-bridge.js'></script><script src='/frame-canvas.js'></script>"; then
        ok "the canvas page loads the canvas runtime"
    else
        bad "the canvas page does not load the canvas runtime"
    fi
    expect 200 GET /frame-canvas-bridge.js
    expect 200 GET /frame-canvas.js
}

flow_html_first() {
    # Dynamic page with a companion load(Request) reading the [slug] param.
    local body
    body="$(curl -s -m 10 "http://127.0.0.1:$PORT/blog/hello-world")"
    if echo "$body" | grep -q 'Blog Post: hello-world'; then ok "GET /blog/hello-world renders the slug"; else bad "GET /blog/hello-world does not render the slug"; fi
}

# ---- per-example driver -------------------------------------------------------

smoke_browser_example() {
    local dir="$1" name="$2"
    local out="$WORK/$name-browser"
    mkdir -p "$out"
    cp -R "$dir"/. "$out"/
    if (cd "$out" && "$CLN" compile main.cln -o app.wasm --target browser --plugins) > "$WORK/$name.compile.log" 2>&1; then
        ok "compiles (--target browser)"
    else
        bad "compile failed:"; grep -iE '^error' "$WORK/$name.compile.log" | head -5 | sed 's/^/      /'
        return
    fi
    if [ -f "$out/loader.js" ]; then ok "loader.js generated"; else bad "loader.js not generated"; fi
    if command -v wasm-tools >/dev/null; then
        # Every handler wired with ui.onEvent(selector, event, "handler") must
        # be exported for loader.js to call it.
        wasm-tools print "$out/app.wasm" > "$out/app.wat"
        local handler
        for handler in $(grep -oE 'ui\.onEvent\([^)]*"[A-Za-z_][A-Za-z0-9_]*"\)' "$dir/main.cln" \
                | sed -E 's/.*"([A-Za-z_][A-Za-z0-9_]*)"\)$/\1/' | sort -u); do
            if grep -q "(export \"$handler\"" "$out/app.wat"; then
                ok "exports handler $handler"
            else
                bad "handler $handler is not exported"
            fi
        done
    fi
}

smoke_server_example() {
    local dir="$1" name="$2"
    local wasm="$WORK/$name.wasm"
    if (cd "$dir" && "$CLN" compile main.cln -o "$wasm" --plugins) > "$WORK/$name.compile.log" 2>&1; then
        ok "compiles"
    else
        bad "compile failed:"; grep -iE '^error' "$WORK/$name.compile.log" | head -5 | sed 's/^/      /'
        return
    fi
    if ! start_server "$dir" "$wasm"; then
        bad "server did not start:"; tail -5 "$LOG" | sed 's/^/      /'
        stop_server
        return
    fi
    ok "server listening on $PORT"

    # Pages (file-based routing).
    local page
    while IFS= read -r page; do
        [ -n "$page" ] || continue
        page_is_protected "$dir" "$page" "$(page_url "$page")" && continue
        expect 200 GET "$(page_url "$page")"
    done < <(cd "$dir" && find app/ui/web/pages -name '*.html' 2>/dev/null | grep -v '\[' | sort)

    # GET endpoints without path parameters (page routes, handled by
    # <module>_render functions, were checked above).
    local route
    while IFS= read -r route; do
        [ -n "$route" ] || continue
        if grep -rqE "GET \"$route\" *\[" "$dir/app" 2>/dev/null; then
            expect '401|403' GET "$route"
        else
            expect 200 GET "$route"
        fi
    done < <(grep -E '  GET /' "$LOG" | grep -v '_render$' | grep -oE '  GET /[^ ]*' | awk '{print $2}' | grep -v ':' | grep -v '^/_debug/' | sort -u)

    # Stylesheets linked from the home page.
    local css
    if [ -f "$dir/app/ui/web/pages/index.html" ]; then
        while IFS= read -r css; do
            [ -n "$css" ] || continue
            expect 200 GET "$css"
        done < <(grep -oE 'href="/public/[^"]+\.css"' "$dir/app/ui/web/pages/index.html" | sed -E 's/href="([^"]+)"/\1/')
    fi

    case "$name" in
        todo-api) flow_todo_api ;;
        full-stack) flow_full_stack ;;
        blog-app) flow_blog_app ;;
        complete-demo) flow_complete_demo ;;
        html-first) flow_html_first ;;
        auth-guards) flow_auth_guards ;;
    esac

    if grep -qE 'wasm trap|panicked|RuntimeError' "$LOG"; then
        bad "server log shows a trap or panic:"; grep -m3 -E 'wasm trap|panicked|RuntimeError' "$LOG" | sed 's/^/      /'
    fi
    stop_server
}

if [ $# -gt 0 ]; then
    EXAMPLES=("$@")
else
    EXAMPLES=()
    for d in "$EXAMPLES_DIR"/*/; do
        [ -f "$d/main.cln" ] && EXAMPLES+=("$(basename "$d")")
    done
fi

for name in "${EXAMPLES[@]}"; do
    dir="$EXAMPLES_DIR/$name"
    echo "== $name"
    EXAMPLE_FAILED=0
    if [ ! -f "$dir/main.cln" ]; then
        bad "no main.cln"
    elif [ ! -d "$dir/app" ] && [ -f "$dir/index.html" ]; then
        smoke_browser_example "$dir" "$name"
    else
        smoke_server_example "$dir" "$name"
    fi
    [ "$EXAMPLE_FAILED" -eq 0 ] || FAILED_EXAMPLES+=("$name")
done

echo
echo "$CHECKS checks, $CHECK_FAILS failed."
if [ ${#FAILED_EXAMPLES[@]} -gt 0 ]; then
    echo "FAIL: smoke-examples (${FAILED_EXAMPLES[*]})"
    exit 1
fi
echo "PASS: smoke-examples"
