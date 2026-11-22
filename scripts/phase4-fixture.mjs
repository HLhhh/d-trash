import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import TrashService from '../dist/index.js'
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// All file paths belong to an explicit fresh temporary home. The persistence
// observation is a seam; actual filesystem safety, native flock and I/O are not.
export async function fixture(existingHome) {
  const previousHome = process.env.DSH_HOME
  const home = existingHome ?? await realpath(await mkdtemp(join(tmpdir(), 'trash-phase4-')))
  // The app Host has no DSH_HOME; only the tool shell receives that hint.
  // Exercise the stat-derived location, including child-process recovery.
  delete process.env.DSH_HOME
  await mkdir(join(home, 'sessions', 'synthetic-cwd'), { recursive: true })
  const ctx = new Context(), hooks = {}, logs = [], calls = [], fallbacks = []
  const read = async (name, fallback) => JSON.parse(await readFile(join(home, name), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return JSON.stringify(fallback)
    throw error
  }))
  const medium = new Map(Object.entries(await read('markers.json', {})))
  const native = await read('registry.json', { archived: [], members: [] })
  const archived = new Set(native.archived), members = new Set(native.members)
  const saveNative = () => writeFile(join(home, 'registry.json'), JSON.stringify({ archived: [...archived], members: [...members] }))
  const saveMarkers = async () => {
    const file = join(home, 'markers.json')
    await writeFile(`${file}.tmp`, JSON.stringify(Object.fromEntries(medium)))
    await rename(`${file}.tmp`, file)
  }
  ctx.provide('storage', { backend: { get: () => ({ kv: { async open() { return {
    async loadAll() { return { global: null, tables: { trash: Object.fromEntries(medium) } } },
    async putRecord(table, id, value) {
      await hooks.put?.(id, value)
      medium.set(id, structuredClone(value)); await saveMarkers()
    },
    async deleteRecord(table, id) {
      await hooks.marker?.(id)
      medium.delete(id); await saveMarkers()
    },
    async deleteRecords(table, ids) { ids.forEach(id => medium.delete(id)); await saveMarkers() },
    async close() {},
  } } } }) } })
  ctx.provide('storageDomain', new DomainFacility(ctx, { backend: 'isolated-phase4' }))
  const workspaces = [0, 1].map(index => ({
    get sessionIds() { return index === 0 ? [...members] : [] },
    async detachSession(id) { calls.push(`detach:${index}`); await hooks.detach?.(id, index); members.delete(id); await saveNative() },
  }))
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...archived] },
    list: () => workspaces,
    async archiveSession(id) { calls.push('archive'); await hooks.archive?.(id); archived.add(id); await saveNative() },
    async unarchiveSession(id) { calls.push('unarchive'); await hooks.unarchive?.(id); archived.delete(id); await saveNative(); await hooks.afterUnarchive?.(id) },
  })
  const directory = id => join(home, 'sessions', 'synthetic-cwd', encodeURIComponent(id))
  const log = id => join(directory(id), 'session.v4.jsonl')
  const observe = async id => {
    const override = await hooks.stat?.(id)
    if (override !== undefined) return override
    try { await stat(log(id)) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    return { header: { id }, location: { kind: 'jsonl', path: log(id) }, revision: 'synthetic' }
  }
  ctx.provide('sessionPersistence', { stat: observe, async list() {
    return (await Promise.all([...members].map(observe))).filter(Boolean)
  } })
  const trash = new TrashService(ctx)
  const report = trash.report.bind(trash)
  trash.report = async (sessionId, stage, result, error) => {
    await report(sessionId, stage, result, error)
    logs.push({ sessionId, stage, result, error: String(error ?? '') })
    await hooks.report?.(sessionId, stage, result)
  }
  trash.operationLog.fallback = line => { fallbacks.push(JSON.parse(line)); hooks.fallback?.(line) }
  return { home, ctx, trash, medium, archived, members, workspaces, hooks, calls, logs, fallbacks, directory, log,
    cache: id => join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    async create(id = 'a') {
      await mkdir(directory(id), { recursive: true })
      await writeFile(join(directory(id), 'session.lock'), '')
      await writeFile(log(id), 'SYNTHETIC TEST LOG ONLY\n')
      await writeFile(join(directory(id), 'session.v3.jsonl.zstd'), 'SYNTHETIC OLDER GENERATION')
      members.add(id); await saveNative()
      const cache = join(home, 'storages', 'session_projcache', 'sessions')
      await mkdir(cache, { recursive: true }); await writeFile(join(cache, `${id}.json`), '{}')
      await trash.trashSession(id)
    },
    async dispose(keep = false) {
      await ctx.fiber.dispose()
      if (!keep) await rm(home, { recursive: true, force: true })
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}
