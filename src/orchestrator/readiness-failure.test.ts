import { describe, expect, it } from 'vitest'
import { publicReadinessFailure, readinessFailureCauseClass } from './readiness-failure'
import { normalizePublicHealth } from './public-health'

describe('readiness failure diagnostics', () => {
  it('gives older failed producers a nonempty public explanation and survives normalization', () => {
    const record = { consecutiveFailures: 8, lastDurationMs: 12390, lastFailureAtMs: 100 }
    const health = normalizePublicHealth({ readinessReconcile: record })
    expect(health?.readinessReconcile).toMatchObject({
      ...record,
      lastError: 'Sweep failed during unknown (Error); details: /evidence',
      lastErrorPhase: 'unknown', lastErrorClass: 'Error',
    })
    expect(normalizePublicHealth(health)?.readinessReconcile).toEqual(health?.readinessReconcile)
    expect(publicReadinessFailure({ consecutiveFailures: 0 })).toEqual({})
  })

  it('reconstructs public text and rejects hostile message, phase, and cause fields', () => {
    const hostile = 'private https://example.invalid/?token=secret'
    const health = normalizePublicHealth({ readinessReconcile: {
      consecutiveFailures: 8, lastError: hostile, lastErrorPhase: hostile,
      lastErrorClass: hostile, lastErrorCauseClass: hostile,
    } })
    expect(health?.readinessReconcile?.lastError)
      .toBe('Sweep failed during unknown (Error; cause: Error); details: /evidence')
    expect(JSON.stringify(health)).not.toContain(hostile)
    const safe = publicReadinessFailure({
      consecutiveFailures: 1, lastErrorPhase: 'discovery-session', lastErrorClass: 'Error',
      lastErrorCauseClass: 'RelayfileOperationTimeoutError',
    })
    expect(normalizePublicHealth({ readinessReconcile: safe })?.readinessReconcile).toMatchObject(safe)
  })

  it('walks wrapped causes without looping or letting diagnostics throw', () => {
    const cause = new TypeError('private')
    const inner = new Error('wrapped', { cause })
    const outer = new Error('wrapped again', { cause: inner })
    expect(readinessFailureCauseClass(outer)).toBe('TypeError')
    cause.cause = outer
    expect(readinessFailureCauseClass(outer)).toBe('TypeError')
    expect(readinessFailureCauseClass(undefined)).toBeUndefined()
    expect(readinessFailureCauseClass(Object.defineProperty(new Error('private'), 'cause', {
      get() { throw new Error('bad accessor') },
    }))).toBeUndefined()
  })
})
