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

interface ProtocolMeta {
  recordCount: number
  lastTimestamp: number
}

interface Metadata {
  lastPulledTimestamp: number  // global: timestamp up to which data has been pulled across all tables
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

export async function readProtocolJsonl(protocolId: string, type: TvlType): Promise<any[]> {
  const filePath = getJsonlPath(protocolId, type)
  try {
    const content = await fs.promises.readFile(filePath, 'utf8')
    const records = new Map<number, any>()
    for (const line of content.split('\n')) {
      if (!line) continue
      try {
        const record = JSON.parse(line)
        records.set(record.SK, record) // later line overwrites earlier for same SK
      } catch { }
    }
    // return sorted by SK
    return Array.from(records.values()).sort((a, b) => a.SK - b.SK)
  } catch {
    return []
  }
}

export async function appendProtocolJsonl(protocolId: string, type: TvlType, records: any[]): Promise<void> {
  if (records.length === 0) return
  const dir = getProtocolDir(protocolId)
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = getJsonlPath(protocolId, type)
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  await fs.promises.appendFile(filePath, lines)
}

export async function writeProtocolJsonl(protocolId: string, type: TvlType, records: any[]): Promise<void> {
  const dir = getProtocolDir(protocolId)
  await fs.promises.mkdir(dir, { recursive: true })
  const filePath = getJsonlPath(protocolId, type)
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  await fs.promises.writeFile(filePath, lines)
}

export async function readProtocolTvlData(protocolId: string): Promise<{ tvl: any[], tokensInUsd: any[], tokens: any[] }> {
  const [tvl, tokensInUsd, tokens] = await Promise.all([
    readProtocolJsonl(protocolId, 'tvl'),
    readProtocolJsonl(protocolId, 'tokensInUsd'),
    readProtocolJsonl(protocolId, 'tokens'),
  ])
  return { tvl, tokensInUsd, tokens }
}

// --- Update logic ---

interface ProtocolInfo {
  id: string
  misrepresentedTokens?: boolean
}

export async function updateAllTvlDataV2(protocols: ProtocolInfo[]) {
  const metadata = await readMetadata()
  const isFirstRun = metadata.lastPulledTimestamp === 0

  log(`[tvl-cache-v2] ${isFirstRun ? 'First run' : 'Incremental'}, ${protocols.length} protocols`)

  if (isFirstRun) {
    await firstRunPullAllProtocols(protocols, metadata)
  } else {
    await incrementalPull(metadata)
  }

  metadata.lastPulledTimestamp = Math.floor(Date.now() / 1000)
  await writeMetadata(metadata)
  log('[tvl-cache-v2] Metadata written')
}

// First run: pull per protocol with concurrency. Each query hits the id index directly — fast.
// For protocols with misrepresentedTokens, only pull tvl (tokens data is unreliable).
async function firstRunPullAllProtocols(protocols: ProtocolInfo[], metadata: Metadata) {
  let completed = 0

  await PromisePool
    .withConcurrency(13)
    .for(protocols)
    .process(async (protocol: ProtocolInfo) => {
      try {
        const { id: protocolId, misrepresentedTokens } = protocol

        if (misrepresentedTokens) {
          const tvl = await getAllProtocolItems(dailyTvl, protocolId)
          await writeProtocolJsonl(protocolId, 'tvl', tvl ?? [])

          metadata.protocols[protocolId] = {
            recordCount: tvl?.length ?? 0,
            lastTimestamp: tvl?.length ? tvl[tvl.length - 1].SK : 0,
          }
        } else {
          const [tvl, tokensInUsd, tokens] = await Promise.all([
            getAllProtocolItems(dailyTvl, protocolId),
            getAllProtocolItems(dailyUsdTokensTvl, protocolId),
            getAllProtocolItems(dailyTokensTvl, protocolId),
          ])

          await Promise.all([
            writeProtocolJsonl(protocolId, 'tvl', tvl ?? []),
            writeProtocolJsonl(protocolId, 'tokensInUsd', tokensInUsd ?? []),
            writeProtocolJsonl(protocolId, 'tokens', tokens ?? []),
          ])

          metadata.protocols[protocolId] = {
            recordCount: tvl?.length ?? 0,
            lastTimestamp: tvl?.length ? tvl[tvl.length - 1].SK : 0,
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

// Incremental: bulk pull by updatedat to catch new records AND updates to existing records.
async function incrementalPull(metadata: Metadata) {
  const sinceTimestamp = metadata.lastPulledTimestamp - 60 // 60s safety margin

  async function processType(type: TvlType) {
    const ddbPKFunction = TABLE_FUNCTIONS[type]
    let totalRows = 0

    await streamAllItemsSince(ddbPKFunction, sinceTimestamp, async (rows: any[]) => {
      totalRows += rows.length

      // Group rows by protocol id
      const grouped: Record<string, any[]> = {}
      for (const row of rows) {
        const id = row.id
        if (!grouped[id]) grouped[id] = []
        row.data.SK = row.timestamp
        grouped[id].push(row.data)
      }

      // Append to JSONL files for each protocol
      await Promise.all(Object.entries(grouped).map(([protocolId, records]) => {
        if (!metadata.protocols[protocolId]) {
          metadata.protocols[protocolId] = { recordCount: 0, lastTimestamp: 0 }
        }
        const meta = metadata.protocols[protocolId]
        const maxTs = Math.max(...records.map(r => r.SK))
        if (maxTs > meta.lastTimestamp) meta.lastTimestamp = maxTs
        if (type === 'tvl') meta.recordCount += records.length

        return appendProtocolJsonl(protocolId, type, records)
      }))
    })

    log(`[tvl-cache-v2] Incremental ${type}: ${totalRows} rows`)
  }

  // Run all 3 types in parallel — file writes go to different files per type
  await Promise.all(TVL_TYPES.map(processType))
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

  // Read tvl JSONL files for all protocols (only tvl, for backward compat with cache.allTvlData)
  let loaded = 0
  for (const protocolId of protocolIds) {
    try {
      const tvl = await readProtocolJsonl(protocolId, 'tvl')
      if (tvl.length > 0) {
        allTvlData[protocolId] = tvl
        loaded++
      }
    } catch (e) {
      // skip silently, protocol may not have tvl data
    }
  }

  log(`[tvl-cache-v2] Loaded allTvlData for ${loaded} protocols`)
}

