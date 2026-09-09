import { withRelayfileCallDeadline } from '../mount/relayfile-operation-timeout'

export interface PrProbeReadCacheStatus {
  recordReads: number
  recordCacheHits: number
  recordCacheEntries: number
  recordCacheLimit: number
  invalidations: number
  evictions: number
  uncachedProbes: number
}

/** Reuse successful records only inside one observed mount event watermark. */
export class PrProbeReadCache<T> {
  #snapshot?: { watermark: string; records: Map<string, Promise<T | undefined>> }
  #recordReads = 0
  #recordCacheHits = 0
  #invalidations = 0
  #evictions = 0
  #uncachedProbes = 0
  #watermarkPending?: Promise<string | undefined>
  #watermarkTimedOut = false

  constructor(readonly limit = 4096) {}

  /** Optional cache validation must not become another unbounded dependency. */
  async watermark(read: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.#watermarkTimedOut) return undefined
    if (!this.#watermarkPending) {
      const pending = Promise.resolve().then(read).catch(() => undefined).finally(() => {
        if (this.#watermarkPending === pending) {
          this.#watermarkPending = undefined
          this.#watermarkTimedOut = false
        }
      })
      this.#watermarkPending = pending
    }
    const pending = this.#watermarkPending
    try {
      return await withRelayfileCallDeadline('getEventHighWatermark', 'PR probe cache', 2_000, () => pending)
    } catch {
      // Keep at most one abandoned transport call. Later probes bypass it
      // until it settles instead of accumulating another hung call each time.
      if (this.#watermarkPending === pending) this.#watermarkTimedOut = true
      return undefined
    }
  }

  invalidate(): void {
    if (this.#snapshot) this.#invalidations += 1
    this.#snapshot?.records.clear()
    this.#snapshot = undefined
  }

  reader(watermark: string | undefined, read: (path: string) => Promise<T | undefined>): (path: string, fresh?: boolean) => Promise<T | undefined> {
    if (watermark === undefined) {
      this.invalidate()
      this.#uncachedProbes += 1
      return (path) => {
        this.#recordReads += 1
        return read(path)
      }
    }
    if (this.#snapshot?.watermark !== watermark) {
      this.invalidate()
      this.#snapshot = { watermark, records: new Map() }
    }
    // Capture the generation: a late read cannot populate a newer snapshot.
    const snapshot = this.#snapshot
    return (path, fresh = false) => {
      if (snapshot !== this.#snapshot) {
        this.#recordReads += 1
        return read(path)
      }
      const cached = snapshot.records.get(path)
      if (cached && !fresh) {
        snapshot.records.delete(path)
        snapshot.records.set(path, cached)
        this.#recordCacheHits += 1
        return cached
      }
      this.#recordReads += 1
      const pending = Promise.resolve().then(() => read(path)).then((record) => {
        // A missing/unreadable record is not evidence of absence. Retry it on
        // the next probe even if the provider's watermark has not advanced.
        if (record === undefined && snapshot.records.get(path) === pending) snapshot.records.delete(path)
        return record
      }, (error: unknown) => {
        if (snapshot.records.get(path) === pending) snapshot.records.delete(path)
        throw error
      })
      if (!snapshot.records.has(path) && snapshot.records.size >= this.limit) {
        snapshot.records.delete(snapshot.records.keys().next().value!)
        this.#evictions += 1
      }
      snapshot.records.set(path, pending)
      return pending
    }
  }

  status(): PrProbeReadCacheStatus {
    return {
      recordReads: this.#recordReads,
      recordCacheHits: this.#recordCacheHits,
      recordCacheEntries: this.#snapshot?.records.size ?? 0,
      recordCacheLimit: this.limit,
      invalidations: this.#invalidations,
      evictions: this.#evictions,
      uncachedProbes: this.#uncachedProbes,
    }
  }
}
