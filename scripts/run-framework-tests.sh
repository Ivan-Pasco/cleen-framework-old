#!/bin/bash

# Clean Framework Test Runner
# Compiles and executes .cln test files

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_DIR="$(dirname "$SCRIPT_DIR")"
TESTS_ROOT="$FRAMEWORK_DIR/tests"
TEST_DIR="$TESTS_ROOT/framework"
OUTPUT_DIR="$TEST_DIR/output"
COMPILER="${CLEEN_CLN:-$HOME/.cleen/bin/cln}"

# Test database: SQLite :memory: per server process (tests/CONVENTIONS.md —
# the framework default for tests). Override with DATABASE_URL.
export DATABASE_URL="${DATABASE_URL:-sqlite::memory:}"
# MySQL instead: FRAMEWORK_TEST_MYSQL_URL=mysql://user:pass@host:port names a
# MySQL server whose user may create databases. Every test then runs against
# a fresh database of its own, created before the test and dropped after it
# (needs the `mysql` command-line client).
MYSQL_URL="${FRAMEWORK_TEST_MYSQL_URL:-}"
# JWT signing secret for auth tests. frame-auth reads it from the environment
# (`secret = env.get("JWT_SECRET")`, AUTH-C004), so each run gets a fresh
# random value instead of a secret committed to source.
export JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
# frame.storage tests: clean-server confines storage.* paths to this root
# (CLEAN_FS_WRITE_ROOT) and resolves them against its working directory.
export CLEAN_FS_WRITE_ROOT="${CLEAN_FS_WRITE_ROOT:-$PWD}"
SERVER="${CLEEN_SERVER:-$HOME/.cleen/bin/clean-server}"

# Counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Default filter (all tests)
FILTER=""
VERBOSE=false
DRY_RUN=false
COMPILE_ONLY=false

# Print usage
usage() {
    echo "Usage: $0 [OPTIONS] [FILTER]"
    echo ""
    echo "Options:"
    echo "  -h, --help       Show this help message"
    echo "  -v, --verbose    Verbose output"
    echo "  -d, --dry-run    Show what would be run without executing"
    echo "  -c, --compile    Compile only, don't run tests"
    echo ""
    echo "Environment:"
    echo "  CLEEN_CLN        Compiler (default: ~/.cleen/bin/cln)"
    echo "  CLEEN_SERVER     Runtime  (default: ~/.cleen/bin/clean-server)"
    echo "  CLEEN_TEST_PORT  Port each test server binds (default: 3334)"
    echo "  FRAMEWORK_TEST_MYSQL_URL  mysql://user:pass@host:port — run every test"
    echo "                   against a fresh MySQL database instead of SQLite"
    echo ""
    echo "Filters:"
    echo "  runtime          Run only the runtime smoke test"
    echo "  unit             Run only unit tests"
    echo "  unit/plugins     Run only plugin unit tests"
    echo "  unit/plugins/<p> Run only one plugin's tests (server, data, auth, ui, ...)"
    echo "  unit/bridge      Run only bridge tests"
    echo "  integration      Run only integration tests"
    echo "  e2e              Run only end-to-end tests"
    echo "  cln/bugfixes     Run only the regression tests in tests/cln/bugfixes"
    echo ""
    echo "Examples:"
    echo "  $0                    # Run all tests"
    echo "  $0 unit               # Run unit tests only"
    echo "  $0 unit/plugins/server # Run frame.server tests only"
    echo "  $0 -v integration     # Run integration tests with verbose output"
}

# Print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
}

print_error() {
    echo -e "${RED}[FAIL]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_section() {
    echo ""
    echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Check prerequisites
check_prerequisites() {
    print_section "Checking Prerequisites"

    # Check compiler
    if [ ! -f "$COMPILER" ]; then
        print_error "Compiler not found at: $COMPILER"
        print_info "Install with: ~/.cleen/bin/cleen install latest (or set CLEEN_CLN)"
        exit 1
    fi
    print_success "Compiler found: $COMPILER"

    # Check server — REQUIRED. Tests run against the real host bridge via clean-server.
    # Compiled-only fallback is no longer acceptable; see tests/CONVENTIONS.md §2.
    if [ -f "$SERVER" ]; then
        print_success "Server found: $SERVER"
    else
        print_error "Server not found at: $SERVER"
        print_info "Install with: ~/.cleen/bin/cleen server install"
        print_info "Override with CLEEN_SERVER, or pass --compile-only to only compile."
        if [ "$COMPILE_ONLY" != "true" ]; then
            exit 1
        fi
    fi

    if [ -n "$MYSQL_URL" ]; then
        if ! command -v mysql >/dev/null 2>&1; then
            print_error "FRAMEWORK_TEST_MYSQL_URL is set but the mysql client is not installed"
            exit 1
        fi
        if ! mysql_admin "SELECT 1" >/dev/null; then
            print_error "Cannot reach the MySQL server in FRAMEWORK_TEST_MYSQL_URL"
            exit 1
        fi
        print_success "MySQL server: $(mysql_url_part host):$(mysql_url_part port) (a fresh database per test)"
    fi

    # Create output directory
    mkdir -p "$OUTPUT_DIR"
    print_success "Output directory ready: $OUTPUT_DIR"
}

# One part (user, password, host, port) of FRAMEWORK_TEST_MYSQL_URL.
mysql_url_part() {
    python3 - "$MYSQL_URL" "$1" <<'PYEOF'
import sys
from urllib.parse import urlsplit, unquote
url = urlsplit(sys.argv[1])
part = sys.argv[2]
value = {"user": url.username, "password": url.password, "host": url.hostname, "port": url.port}[part]
if value is None:
    value = {"user": "root", "password": "", "host": "127.0.0.1", "port": 3306}[part]
print(unquote(str(value)) if part in ("user", "password") else value)
PYEOF
}

# Run one SQL statement as the FRAMEWORK_TEST_MYSQL_URL user.
mysql_admin() {
    MYSQL_PWD="$(mysql_url_part password)" mysql --protocol=TCP \
        -h "$(mysql_url_part host)" -P "$(mysql_url_part port)" \
        -u "$(mysql_url_part user)" -N -e "$1"
}

# The DATABASE_URL a test runs with: SQLite :memory: (or DATABASE_URL), or a
# fresh MySQL database when FRAMEWORK_TEST_MYSQL_URL is set.
test_database_url() {
    local db_name="$1"
    if [ -z "$MYSQL_URL" ]; then
        echo "$DATABASE_URL"
        return 0
    fi
    mysql_admin "DROP DATABASE IF EXISTS \`$db_name\`; CREATE DATABASE \`$db_name\`" || return 1
    echo "${MYSQL_URL%/}/$db_name"
}

# Compile a single test file
compile_test() {
    local test_file="$1"
    local relative_path="${test_file#$TESTS_ROOT/}"
    relative_path="${relative_path#framework/}"
    local output_name="${relative_path//\//_}"
    output_name="${output_name%.cln}.wasm"
    local output_path="$OUTPUT_DIR/$output_name"

    if [ "$VERBOSE" = true ]; then
        print_info "Compiling: $relative_path" >&2
    fi

    # Compile the test file (redirect all output to stderr or /dev/null)
    if "$COMPILER" compile "$test_file" -o "$output_path" --plugins >/dev/null 2>&1; then
        if [ "$VERBOSE" = true ]; then
            print_success "Compiled: $output_name" >&2
        fi
        echo "$output_path"
        return 0
    else
        print_error "Compilation failed: $relative_path" >&2
        return 1
    fi
}

# Poll a server log until it matches a pattern, the server exits, or 15 s pass.
wait_for_log() {
    local log_file="$1"
    local pid="$2"
    local pattern="$3"
    local waited=0
    while [ $waited -lt 150 ]; do
        if [ -f "$log_file" ] && grep -qE "$pattern" "$log_file"; then
            return 0
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    return 0
}

# Run a single compiled test using clean-server.
#
# Two shapes are supported:
#   1. Boot-time test — emits PASS: from `start:` immediately. Runner just
#      captures stdout.
#   2. Server-shaped test — declares `endpoints:` and needs the runner to
#      hit "/test" (canonical endpoint name) to drive request-context code.
#      The runner detects this by grepping the source (passed as arg 3) for
#      `GET "/test"` and, if found, curls it after boot.
run_test() {
    local wasm_file="$1"
    local test_name="$2"
    local source_file="${3:-}"
    # FRAMEWORK_TEST_PORT (or CLEEN_TEST_PORT) lets several checkouts run the
    # suite at the same time without killing each other's servers.
    local test_port="${FRAMEWORK_TEST_PORT:-${CLEEN_TEST_PORT:-3334}}"

    if [ "$VERBOSE" = true ]; then
        print_info "Running: $test_name"
    fi

    # --compile-only: the test compiled (compile_test succeeded); do not run it.
    if [ "$COMPILE_ONLY" = true ]; then
        print_success "$test_name (compiled only)"
        return 0
    fi

    # Kill any existing server on the test port
    pkill -f "clean-server.*--port $test_port\$" 2>/dev/null || true
    sleep 0.2

    # Each test gets an empty database (SQLite :memory: is empty per process).
    local db_name="cln_fw_test_${test_port}_$$"
    local database_url
    if ! database_url=$(test_database_url "$db_name"); then
        print_error "$test_name (could not create MySQL database $db_name)"
        return 1
    fi

    # Start clean-server with the WASM file and capture output
    local server_log="/tmp/test_server_$$_${test_port}.log"
    # The server runs from the framework root so tests can name fixture files
    # (translation tables, ...) by repo-relative paths whatever the caller's
    # cwd; stdin is closed so a stdio app can't swallow the runner's input.
    (cd "$FRAMEWORK_DIR" && DATABASE_URL="$database_url" exec "$SERVER" "$wasm_file" --port "$test_port") < /dev/null > "$server_log" 2>&1 &
    local server_pid=$!

    # Wait for server to initialize (it runs start() on load). start() may do
    # slow work (password hashing, ...), so wait until the server is listening,
    # a PASS:/FAIL: verdict is printed, or the process exits — up to 15 s.
    wait_for_log "$server_log" "$server_pid" 'Server listening|PASS:|FAIL:'

    # If the source declares an endpoint at "/test", drive it. This is how
    # server-shaped tests (auth session, role guards, endpoint routing, ...)
    # get their handler bodies executed.
    if [ -n "$source_file" ] && [ -f "$source_file" ] && \
       grep -qE '(GET|POST|PUT|PATCH|DELETE|FEED)[[:space:]]+"/test"' "$source_file"; then
        # A test can shape that request with header lines:
        #   // test-request-header: Accept-Language: de   (repeatable)
        #   // test-request-query: locale=es
        local -a header_args=()
        local header_line
        while IFS= read -r header_line; do
            header_args+=(-H "$header_line")
        done < <(sed -n 's|^// test-request-header: ||p' "$source_file")
        local query
        query=$(sed -n 's|^// test-request-query: ||p' "$source_file" | head -1)
        local test_url="http://127.0.0.1:$test_port/test"
        [ -n "$query" ] && test_url="$test_url?$query"
        # FEED (server-sent events) is a GET whose response may stay open.
        curl -sS --max-time 5 -o /dev/null ${header_args[@]+"${header_args[@]}"} "$test_url" 2>/dev/null || true
        wait_for_log "$server_log" "$server_pid" 'PASS:|FAIL:'
    elif [ -n "$source_file" ] && [ -f "$source_file" ] && \
         grep -qE 'LIVE[[:space:]]+"/test"' "$source_file"; then
        # WebSocket endpoint: open the connection with an upgrade handshake so
        # the LIVE handler runs.
        curl -sS --http1.1 --max-time 2 -o /dev/null \
            -H "Connection: Upgrade" -H "Upgrade: websocket" \
            -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
            "http://127.0.0.1:$test_port/test" 2>/dev/null || true
        wait_for_log "$server_log" "$server_pid" 'PASS:|FAIL:'
    fi

    # Check if server is still running (it may have exited after start())
    local output=""
    if [ -f "$server_log" ]; then
        output=$(cat "$server_log")
    fi

    # Kill the server
    kill $server_pid 2>/dev/null || true
    sleep 0.2
    if [ -n "$MYSQL_URL" ]; then
        mysql_admin "DROP DATABASE IF EXISTS \`$db_name\`" || true
    fi

    # Check for test results in output
    if echo "$output" | grep -q "FAIL:"; then
        print_error "$test_name"
        if [ "$VERBOSE" = true ]; then
            echo "$output" | grep -E "(FAIL:|PASS:|Test)" | while read line; do
                echo "    $line"
            done
        fi
        rm -f "$server_log"
        return 1
    elif echo "$output" | grep -q "PASS:"; then
        print_success "$test_name"
        if [ "$VERBOSE" = true ]; then
            echo "$output" | grep "PASS:" | while read line; do
                echo "    $line"
            done
        fi
        rm -f "$server_log"
        return 0
    elif echo "$output" | grep -qi "error\|failed"; then
        print_error "$test_name (runtime error)"
        if [ "$VERBOSE" = true ]; then
            echo "    $(echo "$output" | grep -i "error\|failed" | head -3)"
        fi
        rm -f "$server_log"
        return 1
    else
        # No explicit PASS/FAIL — by convention this is a failure (see tests/CONVENTIONS.md §6).
        # Every test must end with an explicit "PASS: <suite>" line.
        print_error "$test_name (no PASS: line emitted — see tests/CONVENTIONS.md §6)"
        if [ "$VERBOSE" = true ]; then
            echo "    $(echo "$output" | tail -10)"
        fi
        rm -f "$server_log"
        return 1
    fi
}

# Run tests in a category
run_test_category() {
    local category="$1"
    local test_files

    print_section "Running Tests: $category"

    # Categories resolve under tests/framework/ first, then under tests/
    # (e.g. `cln/bugfixes` for the regression tests in tests/cln/bugfixes/).
    local category_dir="$TEST_DIR/$category"
    if [ ! -d "$category_dir" ] && [ -d "$TESTS_ROOT/$category" ]; then
        category_dir="$TESTS_ROOT/$category"
    fi
    if [ ! -d "$category_dir" ]; then
        print_error "Test directory not found: $category"
        FAILED_TESTS=$((FAILED_TESTS+1))
        return
    fi

    test_files=$(find "$category_dir" -name "*.cln" -type f 2>/dev/null | sort)

    if [ -z "$test_files" ]; then
        print_warning "No test files found in: $category"
        return
    fi

    while IFS= read -r test_file; do
        local relative_path="${test_file#$TESTS_ROOT/}"
        relative_path="${relative_path#framework/}"
        local test_name="${relative_path%.cln}"

        # NB: use VAR=$((VAR+1)) not ((VAR++)) — the latter returns the
        # pre-increment value as exit code, which trips `set -e` when the
        # counter is 0 and silently aborts the runner before the first test.
        TOTAL_TESTS=$((TOTAL_TESTS+1))

        if [ "$DRY_RUN" = true ]; then
            print_info "[DRY RUN] Would run: $test_name"
            continue
        fi

        # Compile the test
        local wasm_file
        if wasm_file=$(compile_test "$test_file"); then
            # Run the test — pass the source too so server-shaped tests get driven.
            if run_test "$wasm_file" "$test_name" "$test_file"; then
                PASSED_TESTS=$((PASSED_TESTS+1))
            else
                FAILED_TESTS=$((FAILED_TESTS+1))
            fi
        else
            FAILED_TESTS=$((FAILED_TESTS+1))
        fi
    done <<< "$test_files"
}

# Main test runner
run_tests() {
    local start_time=$(date +%s)

    print_section "Clean Framework Test Suite"
    print_info "Test directory: $TEST_DIR"
    print_info "Filter: ${FILTER:-all}"

    check_prerequisites

    if [ -n "$FILTER" ]; then
        # Run specific category
        run_test_category "$FILTER"
    else
        # Run all categories in order
        if [ -d "$TEST_DIR/runtime" ]; then
            run_test_category "runtime"
        fi

        if [ -d "$TEST_DIR/unit" ]; then
            run_test_category "unit"
        fi

        if [ -d "$TEST_DIR/integration" ]; then
            run_test_category "integration"
        fi

        if [ -d "$TEST_DIR/e2e" ]; then
            run_test_category "e2e"
        fi

        if [ -d "$TESTS_ROOT/cln/bugfixes" ]; then
            run_test_category "cln/bugfixes"
        fi
    fi

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Print summary
    print_section "Test Summary"
    echo ""
    echo "  Total:   $TOTAL_TESTS"
    echo -e "  ${GREEN}Passed:  $PASSED_TESTS${NC}"
    echo -e "  ${RED}Failed:  $FAILED_TESTS${NC}"
    echo ""
    echo "  Duration: ${duration}s"
    echo ""

    if [ $FAILED_TESTS -gt 0 ]; then
        print_error "Some tests failed!"
        exit 1
    else
        print_success "All tests passed!"
        exit 0
    fi
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            exit 0
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -c|--compile|--compile-only)
            COMPILE_ONLY=true
            shift
            ;;
        -*)
            print_error "Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            FILTER="$1"
            shift
            ;;
    esac
done

# Run the tests
run_tests
