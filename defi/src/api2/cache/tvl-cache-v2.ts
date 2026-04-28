import fs from 'fs'
import path from 'path'
import { log } from '@defillama/sdk'
import PromisePool from '@supercharge/promise-pool'
import getEnv from '../env'
import { dailyTokensTvl, dailyTvl, dailyUsdTokensTvl } from '../../utils/getLastRecord'
import { getAllProtocolItems, streamAllItemsSince } from '../db'

const CACHE_DIR = getEnv().api2CacheDir!
const TVL_CACHE_V2_DIR = path.join(CACHE_DIR, 'api2-data/pg-cache/tvl-cache-v2')
const METADATA_PATH = path.join(TVL_CACHE_V2_DIR, 'tvl-pull-metadata.json')

export const TVL_TYPES = ['tvl', 'tokensInUsd', 'tokens'] as const
export type TvlType = typeof TVL_TYPES[number]

const TABLE_FUNCTIONS: Record<TvlType, Function> = {
  tvl: dailyTvl,
  tokensInUsd: dailyUsdTokensTvl,
  tokens: dailyTokensTvl,
}

// Cache line format version. Lines without `v` are migrated lazily on read.
const CACHE_LINE_VERSION = 1

const SECONDS_PER_DAY = 86400

interface CacheLine {
  v: number
  data: any
  simulated?: boolean
}

interface ProtocolMeta {
  recordCount: number
  lastTimestamp: number
  // Highest SK we've sorted/gap-filled up to. Below this the file is sorted, deduped, gap-filled.
  // Above this we may have appended unsorted records that haven't been compacted yet.
  lastCompactedSK?: number
}

interface Metadata {
  lastPulledTimestamp: number
  protocols: Record<string, ProtocolMeta>
}

function getProtocolDir(protocolId: string): string {
  const padded = protocolId.padStart(2, '0')
  const prefix = padded.slice(0, 2)
  return path.join(TVL_CACHE_V2_DIR, prefix, protocolId)
}

function getJsonlPath(protocolId: string, type: TvlType): string {
  return path.join(getProtocolDir(protocolId), `${type}.jsonl`)
}

// --- Transforms ---

// Replace any key named "avalanche" with "avax", recursively.
function renameAvalancheKeys(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = renameAvalancheKeys(obj[i])
    return obj
  }
  for (const key of Object.keys(obj)) {
    const value = renameAvalancheKeys(obj[key])
    if (key === 'avalanche') {
      delete obj[key]
      obj['avax'] = value
    } else {
      obj[key] = value
    }
  }
  return obj
}

// Round all numeric leaves of an object in place.
// decimals=0 → integers, decimals=5 → 5 decimal places.
function roundNumbersDeep(obj: any, decimals: number): any {
  if (obj == null) return obj
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) return obj
    const factor = Math.pow(10, decimals)
    return Math.round(obj * factor) / factor
  }
  if (typeof obj !== 'object') return obj
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) obj[i] = roundNumbersDeep(obj[i], decimals)
    return obj
  }
  for (const key of Object.keys(obj)) {
    // Don't round timestamp/SK/PK metadata
    if (key === 'SK' || key === 'PK' || key === 'timestamp') continue
    obj[key] = roundNumbersDeep(obj[key], decimals)
  }
  return obj
}

function applyTransforms(data: any, type: TvlType): any {
  if (!data || typeof data !== 'object') return data
  // Skip transforms on tombstones
  if (isDeleteTombstone(data)) return data
  renameAvalancheKeys(data)
  const decimals = type === 'tokens' ? 5 : 0
  roundNumbersDeep(data, decimals)
  return data
}

// --- Tombstone detection ---

// Soft-delete marker written by the UI tool:
//   tvl table         → data.deleted === 0
//   tokens/tokensInUsd → data.deleted is an object (typically {})
function isDeleteTombstone(data: any): boolean {
  return data != null && typeof data === 'object' && 'deleted' in data
}

// --- Line wrapping (legacy migration) ---

function wrapLine(parsed: any): CacheLine {
  if (parsed && typeof parsed === 'object' && typeof parsed.v === 'number' && 'data' in parsed) {
    return parsed as CacheLine
  }
  // Legacy line: the whole object is the data payload
  return { v: CACHE_LINE_VERSION, data: parsed }
}

function serializeLine(line: CacheLine): string {
  return JSON.stringify(line)
}

// --- Metadata ---

export async function readMetadata(): Promise<Metadata> {
  try {
    const data = await fs.promises.readFile(METADATA_PATH, 'utf8')
    return JSON.parse(data)
  } catch {
    return { lastPulledTimestamp: 0, protocols: {} }
  }
}

export async function writeMetadata(metadata: Metadata): Promise<void> {
  await fs.promises.mkdir(TVL_CACHE_V2_DIR, { recursive: true })
  await fs.promises.writeFile(METADATA_PATH, JSON.stringify(metadata))
}

// --- JSONL read/write ---

// Read all lines from a JSONL file, dedupe by SK (later wins), drop tombstones,
// and return the sorted, payload-only data array.
//
// Lines may be in legacy format (raw data) or new wrapped format ({v, data, simulated?}).
// Migration is lazy: we wrap legacy lines on read; the file is rewritten via writeProtocolJsonl
// only when something else triggers a rewrite (gap fill / compaction / delete).
export async function readProtocolJsonl(protocolId: string, type: TvlType): Promise<any[]> {
  const lines = await readProtocolJsonlLines(protocolId, type)
  return collapseLines(lines).map(l => l.data)
}

// Lower-level: returns the wrapped lines (after dedup/tombstone collapse), preserving simulated flag.
async function readProtocolJsonlLines(protocolId: string, type: TvlType): Promise<CacheLine[]> {
  const filePath = getJsonlPath(protocolId, type)
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const all: CacheLine[] = []
  for (const raw of content.split('\n')) {
    if (!raw) continue
    try {
      all.push(wrapLine(JSON.parse(raw)))
    } catch { }
  }
  return all
}

function collapseLines(lines: CacheLine[]): CacheLine[] {
  // Latest line for a given SK wins. Tombstones drop the SK entirely.
  const bySK = new Map<number, CacheLine>()
  for (const line of lines) {
    const sk = line.data?.SK
    if (typeof sk !== 'number') continue
    if (isDeleteTombstone(line.data)) {
      bySK.delete(sk)
    } else {
      bySK.set(sk, line)
    }
  }
  return Array.from(bySK.values()).sort((a, b) => a.data.SK - b.data.SK)
}

export async function appendProtocolJsonl(protocolId: string, type: TvlType, records: any[]): Promise<void> {
  if (records.length === 0) return
  const dir = getProtocolDir(protocolId)
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = getJsonlPath(protocolId, type)
  const lines = records.map(r => serializeLine({ v: CACHE_LINE_VERSION, data: r })).join('\n') + '\n'
  await fs.promises.appendFile(filePath, lines)
}

export async function writeProtocolJsonl(protocolId: string, type: TvlType, records: any[]): Promise<void> {
  const dir = getProtocolDir(protocolId)
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = getJsonlPath(protocolId, type)
  const lines = records.map(r => serializeLine({ v: CACHE_LINE_VERSION, data: r })).join('\n') + '\n'
  await fs.promises.writeFile(filePath, lines)
}

// Write the file from already-wrapped lines (preserves simulated flag etc.)
async function writeProtocolJsonlLines(protocolId: string, type: TvlType, lines: CacheLine[]): Promise<void> {
  const dir = getProtocolDir(protocolId)
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = getJsonlPath(protocolId, type)
  const out = lines.map(serializeLine).join('\n') + (lines.length ? '\n' : '')
  await fs.promises.writeFile(filePath, out)
}

export async function readProtocolTvlData(protocolId: string): Promise<{ tvl: any[], tokensInUsd: any[], tokens: any[] }> {
  const [tvl, tokensInUsd, tokens] = await Promise.all([
    readProtocolJsonl(protocolId, 'tvl'),
    readProtocolJsonl(protocolId, 'tokensInUsd'),
    readProtocolJsonl(protocolId, 'tokens'),
  ])
  return { tvl, tokensInUsd, tokens }
}

// --- Gap filling (tvl only) ---

// Given collapsed, sorted-by-SK tvl lines, fill any missing daily SKs between known points
// by copying the previous record and marking simulated:true.
//
// If `fillUntilSK` is provided and greater than the last known SK, ALSO extrapolate forward
// (cloning the last record) up to that timestamp. For live protocols, pass a recent timestamp;
// for dead protocols, omit it (or pass the last known SK) so we don't fabricate data after death.
function fillTvlGaps(lines: CacheLine[], fillUntilSK?: number): CacheLine[] {
  if (lines.length === 0) return lines
  const out: CacheLine[] = []
  let prev: CacheLine | null = null
  for (const line of lines) {
    if (prev) {
      const prevSK = prev.data.SK as number
      const curSK = line.data.SK as number
      let gapSK = prevSK + SECONDS_PER_DAY
      // tolerate non-day-aligned spacing: only fill when we're cleanly more than a day apart
      while (gapSK < curSK - SECONDS_PER_DAY / 2) {
        const cloned = JSON.parse(JSON.stringify(prev.data))
        cloned.SK = gapSK
        out.push({ v: CACHE_LINE_VERSION, simulated: true, data: cloned })
        gapSK += SECONDS_PER_DAY
      }
    }
    out.push(line)
    prev = line
  }

  // Forward-fill from last known SK up to fillUntilSK (live protocols only).
  if (fillUntilSK != null && prev) {
    const lastSK = prev.data.SK as number
    let gapSK = lastSK + SECONDS_PER_DAY
    while (gapSK < fillUntilSK - SECONDS_PER_DAY / 2) {
      const cloned = JSON.parse(JSON.stringify(prev.data))
      cloned.SK = gapSK
      out.push({ v: CACHE_LINE_VERSION, simulated: true, data: cloned })
      gapSK += SECONDS_PER_DAY
    }
  }

  return out
}

// --- One-time migration ---

// --- Update logic ---

interface ProtocolInfo {
  id: string
  misrepresentedTokens?: boolean
  // Dead protocols: don't gap-fill past their last real datapoint.
  deadFrom?: number
  deprecated?: boolean
}

function isDeadProtocol(p: ProtocolInfo): boolean {
  return !!(p.deadFrom || p.deprecated)
}

// Day-aligned current timestamp; used as the forward-fill target for live protocols.
function todaySK(): number {
  const nowSec = Math.floor(Date.now() / 1000)
  return nowSec - (nowSec % SECONDS_PER_DAY)
}

// fillUntilSK for a given protocol: undefined for dead protocols (no extrapolation),
// today (day-aligned) for live ones.
function getFillUntilSK(p: ProtocolInfo): number | undefined {
  return isDeadProtocol(p) ? undefined : todaySK()
}

export async function updateAllTvlDataV2(protocols: ProtocolInfo[]) {
  const metadata = await readMetadata()
  const isFirstRun = metadata.lastPulledTimestamp === 0

  log(`[tvl-cache-v2] ${isFirstRun ? 'First run' : 'Incremental'}, ${protocols.length} protocols`)

  if (isFirstRun) {
    await firstRunPullAllProtocols(protocols, metadata)
  } else {
    await incrementalPull(metadata, protocols)
  }

  metadata.lastPulledTimestamp = Math.floor(Date.now() / 1000)
  await writeMetadata(metadata)
  log('[tvl-cache-v2] Metadata written')
}

async function firstRunPullAllProtocols(protocols: ProtocolInfo[], metadata: Metadata) {
  let completed = 0

  await PromisePool
    .withConcurrency(13)
    .for(protocols)
    .process(async (protocol: ProtocolInfo) => {
      try {
        const { id: protocolId, misrepresentedTokens } = protocol
        const fillUntil = getFillUntilSK(protocol)

        if (misrepresentedTokens) {
          let tvl = (await getAllProtocolItems(dailyTvl, protocolId)) ?? []
          tvl = tvl.filter((r: any) => !isDeleteTombstone(r))
          tvl.forEach((r: any) => applyTransforms(r, 'tvl'))
          const filledLines = fillTvlGaps(tvl.map((r: any) => ({ v: CACHE_LINE_VERSION, data: r })), fillUntil)
          await writeProtocolJsonlLines(protocolId, 'tvl', filledLines)

          metadata.protocols[protocolId] = {
            recordCount: filledLines.length,
            lastTimestamp: filledLines.length ? filledLines[filledLines.length - 1].data.SK : 0,
            lastCompactedSK: filledLines.length ? filledLines[filledLines.length - 1].data.SK : 0,
          }
        } else {
          let [tvl, tokensInUsd, tokens] = await Promise.all([
            getAllProtocolItems(dailyTvl, protocolId),
            getAllProtocolItems(dailyUsdTokensTvl, protocolId),
            getAllProtocolItems(dailyTokensTvl, protocolId),
          ])
          tvl = (tvl ?? []).filter((r: any) => !isDeleteTombstone(r))
          tokensInUsd = (tokensInUsd ?? []).filter((r: any) => !isDeleteTombstone(r))
          tokens = (tokens ?? []).filter((r: any) => !isDeleteTombstone(r))

          tvl.forEach((r: any) => applyTransforms(r, 'tvl'))
          tokensInUsd.forEach((r: any) => applyTransforms(r, 'tokensInUsd'))
          tokens.forEach((r: any) => applyTransforms(r, 'tokens'))

          const tvlFilled = fillTvlGaps(tvl.map((r: any) => ({ v: CACHE_LINE_VERSION, data: r })), fillUntil)

          await Promise.all([
            writeProtocolJsonlLines(protocolId, 'tvl', tvlFilled),
            writeProtocolJsonl(protocolId, 'tokensInUsd', tokensInUsd),
            writeProtocolJsonl(protocolId, 'tokens', tokens),
          ])

          metadata.protocols[protocolId] = {
            recordCount: tvlFilled.length,
            lastTimestamp: tvlFilled.length ? tvlFilled[tvlFilled.length - 1].data.SK : 0,
            lastCompactedSK: tvlFilled.length ? tvlFilled[tvlFilled.length - 1].data.SK : 0,
          }
        }

        completed++
        if (completed % 100 === 0) {
          log(`[tvl-cache-v2] First run: ${completed}/${protocols.length} protocols done`)
        }
      } catch (e) {
        console.error(`[tvl-cache-v2] Error pulling protocol ${protocol.id}:`, e)
      }
    })

  log(`[tvl-cache-v2] First run complete: ${completed} protocols`)
}

// Track which (protocol, type) need a full rewrite this incremental cycle.
// We rewrite when we see a delete tombstone OR an out-of-order insert (relative to lastCompactedSK).
// For tvl we always rewrite at the end if any new records arrived (to fill gaps).
async function incrementalPull(metadata: Metadata, protocols: ProtocolInfo[]) {
  const sinceTimestamp = metadata.lastPulledTimestamp - 60 // safety margin
  const protocolMap: Record<string, ProtocolInfo> = {}
  for (const p of protocols) protocolMap[p.id] = p

  // Per (protocolId, type) accumulator of incoming records this run
  type Accum = { records: any[], hasDelete: boolean, hasOutOfOrder: boolean }
  const accumulators: Record<TvlType, Map<string, Accum>> = {
    tvl: new Map(),
    tokensInUsd: new Map(),
    tokens: new Map(),
  }

  async function processType(type: TvlType) {
    const ddbPKFunction = TABLE_FUNCTIONS[type]
    let totalRows = 0
    const accMap = accumulators[type]

    await streamAllItemsSince(ddbPKFunction, sinceTimestamp, async (rows: any[]) => {
      totalRows += rows.length

      // Group rows by protocol id, attach SK, apply transforms
      for (const row of rows) {
        const id = row.id
        if (!accMap.has(id)) accMap.set(id, { records: [], hasDelete: false, hasOutOfOrder: false })
        const acc = accMap.get(id)!

        row.data.SK = row.timestamp
        const isTombstone = isDeleteTombstone(row.data)
        if (isTombstone) {
          acc.hasDelete = true
        } else {
          applyTransforms(row.data, type)
        }

        const protoMeta = metadata.protocols[id]
        const lastCompacted = protoMeta?.lastCompactedSK ?? protoMeta?.lastTimestamp ?? 0
        if (row.timestamp <= lastCompacted) acc.hasOutOfOrder = true

        acc.records.push(row.data)
      }
    })

    // Append fast-path records (no delete, no out-of-order, and not tvl).
    // For tvl we defer all writes until after gap-filling decision below.
    if (type !== 'tvl') {
      await Promise.all(Array.from(accMap.entries()).map(async ([protocolId, acc]) => {
        if (!metadata.protocols[protocolId]) {
          metadata.protocols[protocolId] = { recordCount: 0, lastTimestamp: 0, lastCompactedSK: 0 }
        }
        const meta = metadata.protocols[protocolId]
        const skList = acc.records.filter(r => !isDeleteTombstone(r)).map(r => r.SK)
        const maxTs = skList.length ? Math.max(...skList) : 0
        if (maxTs > meta.lastTimestamp) meta.lastTimestamp = maxTs

        if (acc.hasDelete || acc.hasOutOfOrder) {
          // Need full rewrite: read existing, merge, drop tombstones, rewrite
          await rewriteProtocolFile(protocolId, type, acc.records)
        } else {
          await appendProtocolJsonl(protocolId, type, acc.records)
        }
      }))
    }

    log(`[tvl-cache-v2] Incremental ${type}: ${totalRows} rows`)
  }

  // tvl: rewrite-with-gap-fill for any protocol that received records this run.
  async function processTvlAfterPull() {
    const accMap = accumulators.tvl
    await Promise.all(Array.from(accMap.entries()).map(async ([protocolId, acc]) => {
      if (!metadata.protocols[protocolId]) {
        metadata.protocols[protocolId] = { recordCount: 0, lastTimestamp: 0, lastCompactedSK: 0 }
      }
      const meta = metadata.protocols[protocolId]

      // Read existing lines (collapsed: dedup by SK, tombstones dropped)
      const existing = collapseLines(await readProtocolJsonlLines(protocolId, 'tvl'))

      // Merge incoming: incoming wins by SK; tombstones drop
      const bySK = new Map<number, CacheLine>()
      for (const line of existing) bySK.set(line.data.SK, line)
      for (const rec of acc.records) {
        const sk = rec.SK
        if (typeof sk !== 'number') continue
        if (isDeleteTombstone(rec)) {
          bySK.delete(sk)
        } else {
          bySK.set(sk, { v: CACHE_LINE_VERSION, data: rec })
        }
      }

      const merged = Array.from(bySK.values()).sort((a, b) => a.data.SK - b.data.SK)
      const protocol = protocolMap[protocolId]
      // If we don't know the protocol (stale id), skip forward-fill — safer to under-fill than fabricate past death.
      const fillUntil = protocol ? getFillUntilSK(protocol) : undefined
      const filled = fillTvlGaps(merged, fillUntil)

      await writeProtocolJsonlLines(protocolId, 'tvl', filled)

      meta.recordCount = filled.length
      meta.lastTimestamp = filled.length ? filled[filled.length - 1].data.SK : 0
      meta.lastCompactedSK = meta.lastTimestamp
    }))
  }

  // Run all 3 types in parallel
  await Promise.all(TVL_TYPES.map(processType))
  // Then handle tvl rewrites (after the streaming finished and we know all incoming records)
  await processTvlAfterPull()
}

// Rewrite a non-tvl file: read existing, dedupe by SK with incoming, drop tombstones, write back.
async function rewriteProtocolFile(protocolId: string, type: TvlType, incoming: any[]): Promise<void> {
  const existing = collapseLines(await readProtocolJsonlLines(protocolId, type))
  const bySK = new Map<number, CacheLine>()
  for (const line of existing) bySK.set(line.data.SK, line)
  for (const rec of incoming) {
    const sk = rec.SK
    if (typeof sk !== 'number') continue
    if (isDeleteTombstone(rec)) {
      bySK.delete(sk)
    } else {
      bySK.set(sk, { v: CACHE_LINE_VERSION, data: rec })
    }
  }
  const merged = Array.from(bySK.values()).sort((a, b) => a.data.SK - b.data.SK)
  await writeProtocolJsonlLines(protocolId, type, merged)
  // type !== 'tvl' here: we don't track per-type compacted SK; lastCompactedSK is tvl-specific
}

// --- Load cache.allTvlData from v2 JSONL files ---

export async function loadAllTvlDataFromV2(allTvlData: Record<string, any>) {
  const metadata = await readMetadata()
  const protocolIds = Object.keys(metadata.protocols)

  if (protocolIds.length === 0) {
    log('[tvl-cache-v2] No protocols in metadata, skipping load')
    return
  }

  log(`[tvl-cache-v2] Loading allTvlData for ${protocolIds.length} protocols`)

  let loaded = 0
  for (const protocolId of protocolIds) {
    try {
      const tvl = await readProtocolJsonl(protocolId, 'tvl')
      if (tvl.length > 0) {
        allTvlData[protocolId] = tvl
        loaded++
      }
    } catch (e) {
      // skip silently
    }
  }

  log(`[tvl-cache-v2] Loaded allTvlData for ${loaded} protocols`)
}
