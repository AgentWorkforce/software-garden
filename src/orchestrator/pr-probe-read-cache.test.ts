import { describe, expect, it, vi } from 'vitest'
import { PrProbeReadCache } from './pr-probe-read-cache'
import { normalizePublicHealth, publicHealthFromHeartbeat } from './public-health'
import { parseLinearIssue, resolveIssuePrFromMount } from './factory'
import { FactoryConfigSchema } from '../config/schema'
import { FakeMountClient } from '../testing'

describe('PR probe record cache', () => {
  it('reuses historical records across no-match probes and invalidates body changes', async () => {
    const records = Array.from({ length: 282 }, (_, index) => ({
      number: index + 1, title: 'Unrelated', body: '', headRef: `unrelated-${index}`, state: 'OPEN',
    }))
    type Record = typeof records[number]
    const prefix = '/github/repos/example/project/pulls/by-id/'
    const files = Object.fromEntries(records.map((record) => [`${prefix}${record.number}.json`, record]))
    const mount = new FakeMountClient(files)
    const config = FactoryConfigSchema.parse({ repos: { default: 'example/project' } })
    const issue = parseLinearIssue('/linear/issues/PROJ-900.json', { id: 'issue-900', identifier: 'PROJ-900', title: 'Work' })
    const cache = new PrProbeReadCache<Record>()
    const read = async (path: string) => (await mount.readFile(path)).content as Record
    const probe = (watermark: string) => resolveIssuePrFromMount(
      mount, config, issue, {}, undefined, undefined, cache.reader(watermark, read),
    )

    expect(await probe('evt-1')).toBeUndefined()
    for (let pass = 0; pass < 5; pass += 1) expect(await probe('evt-1')).toBeUndefined()
    expect(cache.status()).toMatchObject({ recordReads: 282, recordCacheHits: 1410, recordCacheEntries: 282 })

    const uncached = new PrProbeReadCache<Record>()
    for (let pass = 0; pass < 6; pass += 1) {
      expect(await resolveIssuePrFromMount(mount, config, issue, {}, undefined, undefined, uncached.reader(undefined, read))).toBeUndefined()
    }
    expect(uncached.status()).toMatchObject({ recordReads: 1692, recordCacheHits: 0 })

    // A body-only association cannot be answered from the pull index. Changing
    // the source watermark must make it discoverable on the very next probe.
    await mount.writeFile(`${prefix}282.json`, { ...records[281], body: 'Fixes PROJ-900' })
    expect((await probe('evt-2'))?.prNumber).toBe(282)
    expect(cache.status()).toMatchObject({ recordReads: 564, invalidations: 1 })

    const health = publicHealthFromHeartbeat({
      pid: 1, status: 'running', iteration: 0, maxIterations: 0,
      updatedAt: new Date(0).toISOString(), updatedAtMs: 0, prProbe: cache.status(),
    }, { nowMs: 0, staleMs: 1000 })
    expect(health.prProbe).toEqual(cache.status())
    expect(normalizePublicHealth(health)?.prProbe).toEqual(cache.status())
  })

  it('retries missing records and failures, and bypasses caching without a watermark', async () => {
    const cache = new PrProbeReadCache<number>()
    let calls = 0
    const read = async () => {
      calls += 1
      if (calls === 1) return undefined
      if (calls === 2) throw new Error('temporary read failure')
      return calls
    }
    expect(await cache.reader('evt-1', read)('path')).toBeUndefined()
    await expect(cache.reader('evt-1', read)('path')).rejects.toThrow('temporary')
    expect(await cache.reader('evt-1', read)('path')).toBe(3)
    expect(await cache.reader('evt-1', read)('path')).toBe(3)
    expect(await cache.reader(undefined, read)('path')).toBe(4)
    expect(await cache.reader(undefined, read)('path')).toBe(5)
    expect(cache.status()).toMatchObject({ recordReads: 5, recordCacheHits: 1, recordCacheEntries: 0, uncachedProbes: 2 })
  })

  it('bounds accumulated records, coalesces reads, and keeps late reads out of a new generation', async () => {
    const cache = new PrProbeReadCache<number>(2)
    let settle!: (value: number) => void
    const old = cache.reader('evt-1', () => new Promise<number>((resolve) => { settle = resolve }))
    const first = old('a')
    const joined = old('a')
    await Promise.resolve()
    let value = 2
    const fresh = cache.reader('evt-2', async () => value)
    expect(await fresh('a')).toBe(2)
    settle(1)
    expect(await first).toBe(1)
    expect(await joined).toBe(1)
    expect(await fresh('a')).toBe(2)
    await fresh('b')
    await fresh('c')
    expect(cache.status()).toMatchObject({ recordReads: 4, recordCacheHits: 2, recordCacheEntries: 2, evictions: 1 })
    value = 3
    expect(await fresh('c', true)).toBe(3)
    expect(cache.status()).toMatchObject({ recordReads: 5, evictions: 1 })
  })

  it('publishes counts only and leaves older producers absent', () => {
    expect(normalizePublicHealth({})?.prProbe).toBeUndefined()
    expect(normalizePublicHealth({ prProbe: { recordReads: 12.9, recordCacheHits: -1, watermark: 'private', path: '/private' } })?.prProbe)
      .toEqual({ recordReads: 12, recordCacheHits: 0, recordCacheEntries: 0, recordCacheLimit: 0, invalidations: 0, evictions: 0, uncachedProbes: 0 })
  })

  it('bypasses a hung optional watermark without accumulating validation calls', async () => {
    vi.useFakeTimers()
    try {
      const cache = new PrProbeReadCache<number>()
      let settle!: (watermark: string) => void
      const read = vi.fn(() => new Promise<string>((resolve) => { settle = resolve }))
      const first = cache.watermark(read)
      await vi.runAllTimersAsync()
      expect(await first).toBeUndefined()
      for (let probe = 0; probe < 20; probe += 1) {
        const watermark = await cache.watermark(read)
        expect(watermark).toBeUndefined()
        expect(await cache.reader(watermark, async () => 1)('record')).toBe(1)
      }
      expect(cache.status()).toMatchObject({ uncachedProbes: 20, recordReads: 20, recordCacheEntries: 0 })
      expect(read).toHaveBeenCalledTimes(1)
      settle('evt-1')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(await cache.watermark(async () => 'evt-2')).toBe('evt-2')
    } finally {
      vi.useRealTimers()
    }
  })
})
