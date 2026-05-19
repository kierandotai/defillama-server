# DefiLlama server

## Setup

Make sure to have the env variables `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` set.

## Development

```bash
npm run build # Build with webpack & check for type errors
npm test # Run tests
npm run format # Format code
```

### Search regression tests

Run the Meilisearch ranking regression suite:

```bash
export APP_ENV=/Users/mint/p/defillama-server/defi/.env
npm run test:search
```

The test suite always uses production search documents as the data source, so the env file must include `SEARCH_MASTER_KEY`.

To run against the prod Meilisearch host with a temporary test index:

```bash
set -a
source .env
set +a
SEARCH_TEST_MEILI_HOST=https://search-core.defillama.com \
SEARCH_TEST_MEILI_KEY="$SEARCH_MASTER_KEY" \
SEARCH_TEST_MEILI_VERSION=1.9.0 \
npm run test:search
```

### Local dev server

```bash
npm run serve
```

## Deploy

Just push your changes to the `master` branch.

## Filling data

```
# fetch latest adapters (important to run this before any refilling commands)
npm run updateAdapters

# fill old historical data
npm run fillOld aave # start refilling aave from now and 1 at a time
npm run fillOld aave 1648098107 # start refilling aave from 1648098107 going backwards 1 at a time
npm run fillOld aave now 4 # start refilling aave from now going backwards 4 at a time

# fill old historical data for a given chain
npm run fillOldChain curve ethereum # start recomputing and updating only ethereum tvl of curve from now and 1 at a time
npm run fillOldChain sushiswap polygon,avax 1648098107 # start recomputing and updating only bsc and avax tvl of sushiswap from 1648098107 and 1 at a time
npm run fillOld  sushiswap polygon,avax now 4 # same as above but from now going backwards 4 at a time

# fill latest data point
npm run fillLast aave
```

If you run into the error `Error: Cannot find module '[...]'` then run:

```
npm run prebuild
```

Run general scripts:

```
export AWS_REGION='eu-central-1' && export tableName='prod-table' && npx ts-node src/<script>
```

## To run a specific file ex: storeGetProtocols.ts

```bash
export AWS_REGION='eu-central-1' && export tableName='prod-table' && npx ts-node src/storeGetProtocols.ts
```

make sure to add `handler({pathParameters:{protocol: "uncx-network"}} as any).then(console.log)` (replace parameters as needed) at the end of the file, and remove it before pushing the code!
