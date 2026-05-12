#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."

export RUN_SEARCH_MEILI_TESTS=1
export SEARCH_TEST_MEILI_HOST="${SEARCH_TEST_MEILI_HOST:-http://127.0.0.1:7700}"
export SEARCH_TEST_MEILI_KEY="${SEARCH_TEST_MEILI_KEY:-masterKey}"
export SEARCH_TEST_MEILI_VERSION="${SEARCH_TEST_MEILI_VERSION:-1.9.0}"
MEILI_HTTP_ADDR="${SEARCH_TEST_MEILI_HOST#http://}"
MEILI_HTTP_ADDR="${MEILI_HTTP_ADDR#https://}"

if [[ -z "${SEARCH_MASTER_KEY:-}" && -z "${APP_ENV:-}" ]]; then
  echo "Set SEARCH_MASTER_KEY or APP_ENV=/path/to/.env before running this test."
  exit 1
fi

check_meili_version() {
  local version
  version="$(
    curl -fsS \
      -H "Authorization: Bearer $SEARCH_TEST_MEILI_KEY" \
      "$SEARCH_TEST_MEILI_HOST/version" \
      | node -e "let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => console.log(JSON.parse(s).pkgVersion))"
  )"

  if [[ "$version" != "$SEARCH_TEST_MEILI_VERSION" && "${SEARCH_TEST_ALLOW_VERSION_MISMATCH:-}" != "1" ]]; then
    echo "Meilisearch at $SEARCH_TEST_MEILI_HOST is $version, but prod search is $SEARCH_TEST_MEILI_VERSION."
    echo "Use a matching Meilisearch server, or set SEARCH_TEST_ALLOW_VERSION_MISMATCH=1 for a non-parity run."
    exit 1
  fi
}

if ! curl -fsS "$SEARCH_TEST_MEILI_HOST/health" >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker rm -f defillama-search-test-meili >/dev/null 2>&1 || true
    docker run \
      --name defillama-search-test-meili \
      -p 7700:7700 \
      -e MEILI_MASTER_KEY="$SEARCH_TEST_MEILI_KEY" \
      -d "getmeili/meilisearch:v$SEARCH_TEST_MEILI_VERSION" >/dev/null
  elif command -v meilisearch >/dev/null 2>&1; then
    LOCAL_MEILI_VERSION="$(meilisearch --version | awk '{ print $2 }')"
    if [[ "$LOCAL_MEILI_VERSION" != "$SEARCH_TEST_MEILI_VERSION" && "${SEARCH_TEST_ALLOW_VERSION_MISMATCH:-}" != "1" ]]; then
      echo "Local meilisearch is $LOCAL_MEILI_VERSION, but prod search is $SEARCH_TEST_MEILI_VERSION."
      echo "Run a matching Docker image, install the matching binary, or set SEARCH_TEST_ALLOW_VERSION_MISMATCH=1 for a non-parity run."
      exit 1
    fi
    MEILI_DB_PATH="${SEARCH_TEST_MEILI_DB_PATH:-/tmp/defillama-search-test-meili}"
    rm -rf "$MEILI_DB_PATH"
    meilisearch \
      --master-key "$SEARCH_TEST_MEILI_KEY" \
      --http-addr "$MEILI_HTTP_ADDR" \
      --db-path "$MEILI_DB_PATH" >/tmp/defillama-search-test-meili.log 2>&1 &
    MEILI_PID=$!
    trap 'kill "$MEILI_PID" >/dev/null 2>&1 || true' EXIT
  else
    echo "No Meilisearch server at $SEARCH_TEST_MEILI_HOST."
    echo "Start one with either:"
    echo "  docker run --rm -p 7700:7700 -e MEILI_MASTER_KEY=masterKey getmeili/meilisearch:v$SEARCH_TEST_MEILI_VERSION"
    echo "  meilisearch --master-key masterKey --http-addr 127.0.0.1:7700"
    echo "Then rerun with SEARCH_TEST_MEILI_HOST and SEARCH_TEST_MEILI_KEY set if you used non-defaults."
    exit 1
  fi

  for _ in {1..60}; do
    if curl -fsS "$SEARCH_TEST_MEILI_HOST/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! curl -fsS "$SEARCH_TEST_MEILI_HOST/health" >/dev/null 2>&1; then
    echo "Meilisearch did not become healthy at $SEARCH_TEST_MEILI_HOST."
    echo "If the script started a local binary, check /tmp/defillama-search-test-meili.log."
    exit 1
  fi
fi

check_meili_version

npx jest src/updateSearch.meili.test.ts --runInBand --no-cache --watchman=false
