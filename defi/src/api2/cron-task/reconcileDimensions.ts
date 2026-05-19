import '../utils/failOnError'
require("dotenv").config()

import PromisePool from '@supercharge/promise-pool'

import { AdapterType } from '../../adaptors/data/types'
import loadAdaptorsData from '../../adaptors/data'
import { handler2 } from '../../adaptors/handlers/storeAdaptorData'
import { getTimestampAtStartOfDayUTC } from '../../utils/date'
import { runWithRuntimeLogging } from '../utils'
import { sendMessage } from '../../utils/discord'

/* ============================================================================
 *  Reconcile job for dimension adapters
 * ============================================================================
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  Some dimension adapter sources (Dune, lagging subgraphs, on-chain indexers
 *  with re-org settling) finalize their data a few days after the fact. The
 *  regular daily cron writes today's record once and never revisits it, so
 *  late-settling values stay incomplete forever.
 *
 *  This job re-fetches a trailing N-day window for a curated list of adapters
 *  and overwrites whatever is in storage for those days. It is a separate
 *  cron, runs once a day, and never touches anything outside its allowlist.
 *
 *  WHY THE ALLOWLIST IS HERE (NOT IN THE ADAPTER FILE)
 *  ---------------------------------------------------
 *  The dimension-adapters repo accepts public contributions. Putting a
 *  `reconcileDays` flag on the adapter object would let any contributor opt
 *  their adapter into N× extra fetches (and N× the source cost — important
 *  for paid sources like Dune). Keeping the allowlist server-side means
 *  enabling reconcile is a maintainer decision that goes through normal code
 *  review.
 *
 *  HOW TO ADD AN ADAPTER
 *  ---------------------
 *  Append an entry to RECONCILE_CONFIG below:
 *    - adapterType: which AdapterType the protocol lives under (FEES, DEXS, ...)
 *    - id:          protocol id, id, displayName, or module name (any works)
 *    - days:        size of the trailing window to refill (2..30)
 *    - mode:        'daily' or 'interval' (see below)
 *
 *  MODES
 *  -----
 *  'daily'    — Re-fetch the last `days` days every time this cron runs.
 *               Maximum overlap; a transient failure on day D self-heals on
 *               day D+1 because tomorrow's window still covers today.
 *               Pay (days × source-cost) per cron run. Best for cheap sources
 *               or high-value data where redundancy matters.
 *
 *  'interval' — Only fire on every Nth run, then re-fetch the last `days`
 *               days. Pay (days × source-cost) once per N runs (~N× cheaper
 *               than 'daily'). The trade-off: a single failed scheduled run
 *               leaves a gap that won't be retried until the next interval
 *               (up to N days later), so 'interval' is best for sources that
 *               are reliable AND expensive (Dune, Allium).
 *
 *  WHY EPOCH-DAY MODULO (NOT day-of-month MODULO)
 *  ----------------------------------------------
 *  The intuitive way to schedule "every N days" is `today.getDate() % N === 0`.
 *  That looks fine inside a single month but breaks at month boundaries:
 *
 *    days=7, day-of-month modulo:  fires on 7, 14, 21, 28, then jumps to 7
 *                                  of next month -> 10–11 day gap
 *    days=30, day-of-month modulo: only fires on day 30 of months that have
 *                                  one. February never fires.
 *    days=4:  fires on 4,8,12,...,28, then 4 of next month -> 7–8 day gap.
 *
 *  Those gaps can exceed the configured `days` window, which means a missed
 *  run during the gap is unrecoverable until the next firing.
 *
 *  Epoch-day modulo (`floor(now / ONE_DAY_MS) % days === 0`) gives strict
 *  N-day spacing year-round, regardless of month length. Same number of
 *  lines, no edge cases. The only "downside" is the firing day isn't
 *  pinned to a calendar number — irrelevant for an automated cron.
 *
 *  ============================================================================
 */

type ReconcileMode = 'daily' | 'interval'

type ReconcileEntry = {
  adapterType: AdapterType
  // Stable protocol identifier (matched against protocol.id, falling back to protocol.id).
  // We use id instead of name/module/displayName because those can change over time
  // (rebrands, module reshuffles), which would silently disable reconcile for this entry.
  id: string
  // Human-readable label shown in logs and Discord alerts only — never used for lookup.
  label: string
  days: number
  mode: ReconcileMode
}

// ============================================================================
// EDIT HERE — maintainer-curated allowlist
// ============================================================================
//
// To find a protocol's id: search defi/src/protocols/data*.ts for the name and
// take the `id` field. (For most protocols id === id; if id is set explicitly
// on the protocol entry, use that instead.)
//
// Examples (uncomment and edit to enable):
//
//   { adapterType: AdapterType.FEES,        id: '111',  label: 'aave-v3',     days: 7,  mode: 'daily'    },
//   { adapterType: AdapterType.DEXS,        id: '2197', label: 'uniswap-v3',  days: 30, mode: 'interval' },
//   { adapterType: AdapterType.DERIVATIVES, id: '5761', label: 'hyperliquid', days: 14, mode: 'daily'    },
//
const RECONCILE_CONFIG: ReconcileEntry[] = [
  // delay in dune dex decoded tables 
  { adapterType: AdapterType.FEES, id: '6922', label: 'fomo', days: 7, mode: 'interval' },
  { adapterType: AdapterType.FEES, id: '7768', label: 'terminal', days: 7, mode: 'interval' },

  // kyberswap aggregator volumes are delayed in their api
  { adapterType: AdapterType.AGGREGATORS, id: '3982', label: 'kyberswap aggregator', days: 7, mode: 'daily' },

  // kamino liquidity api delayed reconciliation
  { adapterType: AdapterType.FEES, id: '2062', label: 'kamino liquidity', days: 7, mode: 'interval' },

  // near intent api delays
  { adapterType: AdapterType.FEES, id: '6225', label: 'near intents', days: 7, mode: 'interval' },
  { adapterType: AdapterType.DEXS, id: '6225', label: 'near intents', days: 7, mode: 'interval' },
]

// ============================================================================

const ONE_DAY_IN_SECONDS = 24 * 60 * 60
const ONE_DAY_IN_MS = ONE_DAY_IN_SECONDS * 1000
const RECONCILE_DAYS_MIN = 2
const RECONCILE_DAYS_MAX = 30
const PER_ENTRY_DAY_CONCURRENCY = 3
const ACROSS_ENTRY_CONCURRENCY = 4

function shouldRunToday(entry: ReconcileEntry, now: number = Date.now()): boolean {
  if (process.env.RECONCILE_FORCE === 'true') return true
  if (entry.mode === 'daily') return true
  const epochDay = Math.floor(now / ONE_DAY_IN_MS)
  return epochDay % entry.days === 0
}

function validateEntry(entry: ReconcileEntry): string | null {
  if (!Object.values(AdapterType).includes(entry.adapterType)) {
    return `unknown adapterType: ${entry.adapterType}`
  }
  if (!entry.id) return 'id is empty'
  if (!entry.label) return 'label is empty'
  if (!Number.isInteger(entry.days)) return `days must be an integer (got ${entry.days})`
  if (entry.days < RECONCILE_DAYS_MIN || entry.days > RECONCILE_DAYS_MAX) {
    return `days must be in [${RECONCILE_DAYS_MIN}, ${RECONCILE_DAYS_MAX}] (got ${entry.days})`
  }
  if (entry.mode !== 'daily' && entry.mode !== 'interval') {
    return `unknown mode: ${entry.mode}`
  }
  return null
}

function resolveProtocol(entry: ReconcileEntry) {
  const { protocolAdaptors } = loadAdaptorsData(entry.adapterType) as any
  return protocolAdaptors.find((p: any) => p.id === entry.id || p.id === entry.id)
}

async function reconcileEntry(entry: ReconcileEntry, yesterdayEndTimestamp: number): Promise<{ ok: number, failed: number }> {
  const label = `${entry.adapterType}/${entry.label}#${entry.id}`
  const validationError = validateEntry(entry)
  if (validationError) {
    console.error(`[reconcile] skipping ${label}: ${validationError}`)
    return { ok: 0, failed: 0 }
  }

  if (!shouldRunToday(entry)) {
    console.log(`[reconcile] ${label} mode=interval days=${entry.days} — not scheduled today, skipping`)
    return { ok: 0, failed: 0 }
  }

  const protocol = resolveProtocol(entry)
  if (!protocol) {
    console.error(`[reconcile] ${label}: protocol not found in ${entry.adapterType}`)
    return { ok: 0, failed: 0 }
  }

  const days = Array.from({ length: entry.days }, (_, i) => yesterdayEndTimestamp - i * ONE_DAY_IN_SECONDS)

  console.log(`[reconcile] ${label} mode=${entry.mode} refilling ${entry.days} days for "${protocol.displayName}"`)

  let ok = 0
  let failed = 0

  await PromisePool
    .withConcurrency(PER_ENTRY_DAY_CONCURRENCY)
    .for(days)
    .process(async (dayEnd: number) => {
      const dayLabel = new Date(dayEnd * 1000).toISOString().slice(0, 10)
      try {
        await handler2({
          timestamp: dayEnd,
          adapterType: entry.adapterType,
          protocolNames: new Set([protocol.displayName]),
          isRunFromRefillScript: true,
          runType: 'refill-all',
          throwError: true,
        })
        ok++
      } catch (e: any) {
        failed++
        console.error(`[reconcile] ${label} ${dayLabel} failed:`, e?.message ?? e)
      }
    })

  console.log(`[reconcile] ${label} done — ok=${ok} failed=${failed}`)
  return { ok, failed }
}

async function run() {
  if (RECONCILE_CONFIG.length === 0) {
    console.log('[reconcile] RECONCILE_CONFIG is empty — nothing to do')
    return
  }

  const yesterdayEndTimestamp = getTimestampAtStartOfDayUTC(Math.floor(Date.now() / 1000)) - 1

  console.log(`[reconcile] starting — ${RECONCILE_CONFIG.length} entries, anchored at ${new Date(yesterdayEndTimestamp * 1000).toISOString()}`)

  const poolResult = await PromisePool
    .withConcurrency(ACROSS_ENTRY_CONCURRENCY)
    .for(RECONCILE_CONFIG)
    .process((entry: ReconcileEntry) => reconcileEntry(entry, yesterdayEndTimestamp))

  // PromisePool catches thrown errors from the processor and pushes them onto poolResult.errors
  // instead of rejecting the outer await. Without inspecting errors, an entry-level crash
  // (e.g. a bug inside reconcileEntry, a thrown handler2) would be silently dropped.
  const totals = (poolResult.results as Array<{ ok: number, failed: number }>).reduce(
    (acc, r) => ({ ok: acc.ok + r.ok, failed: acc.failed + r.failed }),
    { ok: 0, failed: 0 }
  )

  const entryErrorMessages: string[] = []
  for (const err of (poolResult.errors ?? [])) {
    const entry = (err as any).item as ReconcileEntry | undefined
    const entryLabel = entry ? `${entry.adapterType}/${entry.label}#${entry.id}` : '<unknown>'
    const message = (err as any)?.message ?? (err as any)?.raw?.message ?? String(err)
    console.error(`[reconcile] entry crashed ${entryLabel}:`, message)
    entryErrorMessages.push(`${entryLabel}: ${message}`)
    totals.failed++
  }

  console.log(`[reconcile] complete — total ok=${totals.ok} failed=${totals.failed} (entry-level crashes: ${entryErrorMessages.length})`)

  if (totals.failed > 0 && process.env.DIM_ERROR_CHANNEL_WEBHOOK) {
    const summary = `Dimension reconcile job: ${totals.failed} failures (out of ${totals.ok + totals.failed}). Check logs.`
    const detail = entryErrorMessages.length
      ? `\nEntry-level crashes:\n${entryErrorMessages.map(m => `  • ${m}`).join('\n')}`
      : ''
    await sendMessage(summary + detail, process.env.DIM_ERROR_CHANNEL_WEBHOOK!)
  }
}

runWithRuntimeLogging(run, {
  application: 'cron-task',
  type: 'reconcile-dimensions',
})
  .catch(async (e: any) => {
    console.error(e)
    const errorMessage = e?.message ?? e?.stack ?? JSON.stringify(e)
    if (process.env.DIM_ERROR_CHANNEL_WEBHOOK) {
      await sendMessage(`reconcile-dimensions cron failed: ${errorMessage}`, process.env.DIM_ERROR_CHANNEL_WEBHOOK!)
    }
  })
  .then(() => process.exit(0))
