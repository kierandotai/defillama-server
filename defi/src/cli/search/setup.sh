# Replace SEARCH_MASTER_KEY for the master key from meilisearch
SEARCH_MASTER_KEY=""

curl \
  -X POST 'https://search-core.defillama.com/keys' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  --data-binary '{
    "description": "Search for frontend",
    "actions": ["search"],
    "indexes": ["pages", "directory"],
    "expiresAt": null
  }'

curl \
  -X POST 'https://search-core.defillama.com/indexes/pages/documents'\
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  --data-binary @searchlist.json

curl -X GET 'https://search-core.defillama.com/tasks/0' -H "Authorization: Bearer $SEARCH_MASTER_KEY"

# Pages index settings are defined in PAGES_INDEX_SETTINGS in src/updateSearch.ts.
# updateSearch.ts calls syncPagesIndexSettings(), so these curl blocks are a
# manual fallback/reference only and will be silently superseded by auto-sync.
curl \
  -X PUT 'https://search-core.defillama.com/indexes/pages/settings/searchable-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "alias1",
    "alias2",
    "alias3",
    "alias4",
    "alias5",
    "routeAlias",
    "name",
    "symbol",
    "previousNames",
    "nameVariants",
    "keywords"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/pages/settings/ranking-rules' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "words",
    "typo",
    "proximity",
    "topLevelRank:desc",
    "exactness",
    "r:desc",
    "attribute",
    "v:desc",
    "sort"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/pages/settings/filterable-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "type",
    "deprecated",
    "subName"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/pages/settings/sortable-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "v",
    "tvl",
    "name",
    "mcapRank",
    "r",
    "topLevelRank"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/pages/settings/displayed-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "id",
    "name",
    "type",
    "logo",
    "route",
    "deprecated",
    "hideType",
    "previousNames",
    "subName",
    "symbol"
  ]'

# Synonyms: lets short/partial queries resolve to their long forms (and vice
# versa) so e.g. `stable` is treated as an exact-form match for `stablecoins`
# during the `exactness` ranking stage. Without this, an array-valued
# `keywords` attribute only produces `matchesStart` (~0.67) instead of
# `exactMatch` (1.0), so high-`r` metric pages lose to lower-`r` entities that
# happen to have an exact single-word name match.
curl \
  -X PUT 'https://search-core.defillama.com/indexes/pages/settings/synonyms' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '{
    "stable": ["stablecoin", "stablecoins"],
    "stablecoin": ["stable", "stablecoins"],
    "stablecoins": ["stable", "stablecoin"],
    "mcap": ["market cap", "marketcap"],
    "marketcap": ["market cap", "mcap"],
    "market cap": ["mcap", "marketcap"],
    "tvl": ["total value locked"],
    "apy": ["yield", "yields"],
    "yield": ["apy", "yields"],
    "yields": ["apy", "yield"],
    "dex": ["dexs", "exchange"],
    "dexs": ["dex", "exchanges"],
    "cex": ["cexs", "exchange"],
    "cexs": ["cex", "exchanges"]
  }'

# --- Directory index setup ---

# Directory index settings are defined in DIRECTORY_INDEX_SETTINGS in
# src/updateSearch.ts and auto-synced by updateSearch.ts. These curl blocks are
# a manual fallback/reference only.
curl \
  -X PUT 'https://search-core.defillama.com/indexes/directory/settings/ranking-rules' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "words",
    "typo",
    "proximity",
    "exactness",
    "r:desc",
    "attribute",
    "v:desc",
    "sort"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/directory/settings/displayed-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "name",
    "symbol",
    "logo",
    "route",
    "deprecated",
    "previousNames"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/directory/settings/searchable-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "name",
    "symbol",
    "previousNames",
    "nameVariants",
    "route"
  ]'

curl \
  -X PUT 'https://search-core.defillama.com/indexes/directory/settings/sortable-attributes' \
  -H "Authorization: Bearer $SEARCH_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary '[
    "v",
    "tvl",
    "name",
    "r"
  ]'
