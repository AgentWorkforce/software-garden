import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DISCOVERY_SWEEP_BUDGET_MS,
  DEFAULT_READINESS_RECONCILE_TIMEOUT_MS,
} from '../config/schema'
import { READINESS_RECONCILE_STALL_INTERVALS } from './public-health'
import {
  SWEEP_READ_CALL_BUDGET_MS,
  SWEEP_READ_PHASE_BUDGET_MS,
  SWEEP_REPO_READ_BUDGET_MS,
  SweepReadBudgetExceededError,
  SweepReadTracker,
  sweepReadBudgets,
} from './sweep-read-budget'

/**
 * Read budgets inside one readiness sweep (#376).
 *
 * The ordering is the property under test: per read < per repository < read
 * phase < sweep < every bar the deployment enforces from outside. A bound that
 * sits above one of those bars can never fire, which is how the 90-minute sweep
 * budget failed silently.
 */

const NEVER = (): Promise<never> => new Promise<never>(() => undefined)

/** The deployed reconcile cadence the constants are derived against. */
const DEPLOYED_RECONCILE_INTERVAL_MS = 300_000
/** Measured: the shortest-lived sweep was killed by a container replacement 47.3 minutes in. */
const SHORTEST_OBSERVED_SWEEP_LIFETIME_MS = 47.3 * 60_000
/** The container's startup grace for its first progress receipt, which only a committed sweep writes. */
const CONTAINER_STARTUP_GRACE_MS = 75 * 60_000

describe('sweep read budget ordering', () => {
  it('resolves the default sweep budget to 60 s < 3 min < 15 min < 30 min', () => {
    expect(DEFAULT_DISCOVERY_SWEEP_BUDGET_MS).toBe(30 * 60_000)
    expect(sweepReadBudgets(DEFAULT_DISCOVERY_SWEEP_BUDGET_MS)).toEqual({
      callMs: SWEEP_READ_CALL_BUDGET_MS,
      repoMs: SWEEP_REPO_READ_BUDGET_MS,
      readPhaseMs: SWEEP_READ_PHASE_BUDGET_MS,
    })
    expect([SWEEP_READ_CALL_BUDGET_MS, SWEEP_REPO_READ_BUDGET_MS, SWEEP_READ_PHASE_BUDGET_MS])
      .toEqual([60_000, 180_000, 900_000])
  })

  it('keeps the sweep budget below every bar that would otherwise end the sweep first', () => {
    const stallMs = READINESS_RECONCILE_STALL_INTERVALS * DEPLOYED_RECONCILE_INTERVAL_MS
    const bars = [stallMs, SHORTEST_OBSERVED_SWEEP_LIFETIME_MS, CONTAINER_STARTUP_GRACE_MS, DEFAULT_READINESS_RECONCILE_TIMEOUT_MS]
    for (const bar of bars) expect(DEFAULT_DISCOVERY_SWEEP_BUDGET_MS).toBeLessThan(bar)
    // The defect this replaces: the old default equalled the reconcile
    // timeout, and was above both the stall report and the container's life.
    expect(DEFAULT_READINESS_RECONCILE_TIMEOUT_MS).toBeGreaterThan(CONTAINER_STARTUP_GRACE_MS)
  })

  it('fits a healthy sweep and the read phase inside a small multiple of the reconcile interval', () => {
    // The read phase is three deployed intervals; a healthy ~19-repository
    // sweep (one listing plus about three candidate reads each, well under a
    // second per read) needs roughly a minute of it.
    expect(SWEEP_READ_PHASE_BUDGET_MS).toBe(3 * DEPLOYED_RECONCILE_INTERVAL_MS)
    expect(19 * 4 * 1_000).toBeLessThan(DEPLOYED_RECONCILE_INTERVAL_MS)
    // Every repository timing out at the per-read budget is still bounded by
    // the read phase, not by the per-repository sum.
    expect(19 * SWEEP_READ_CALL_BUDGET_MS).toBeGreaterThan(SWEEP_READ_PHASE_BUDGET_MS)
  })

  it.each([50, 400, 6_000, 60_000, 10 * 60_000, 30 * 60_000, 90 * 60_000, 6 * 60 * 60_000])(
    'is strictly ordered under a %d ms sweep budget',
    (sweepBudgetMs) => {
      const { callMs, repoMs, readPhaseMs } = sweepReadBudgets(sweepBudgetMs)
      expect(callMs).toBeGreaterThan(0)
      expect(callMs).toBeLessThan(repoMs)
      expect(repoMs).toBeLessThan(readPhaseMs)
      expect(readPhaseMs).toBeLessThan(sweepBudgetMs)
    },
  )

  it.each([undefined, 0, -1, Number.NaN])('keeps the ceilings for a deliberately unbounded sweep (%s)', (sweepBudgetMs) => {
    expect(sweepReadBudgets(sweepBudgetMs)).toEqual({
      callMs: SWEEP_READ_CALL_BUDGET_MS,
      repoMs: SWEEP_REPO_READ_BUDGET_MS,
      readPhaseMs: SWEEP_READ_PHASE_BUDGET_MS,
    })
  })
})

describe('SweepReadTracker', () => {
  /** A tracker on a hand-driven clock; timers stay real and short. */
  const tracker = (budgets = { callMs: 20, repoMs: 50, readPhaseMs: 1_000 }) => {
    let nowMs = 1_000_000
    const events: string[] = []
    const reads = new SweepReadTracker(budgets, {
      now: () => nowMs,
      onDefer: (event, reason) => events.push(`${event}:${reason}`),
    })
    return {
      reads,
      events,
      advance: (ms: number) => { nowMs += ms },
    }
  }

  it('fails one read past the per-read budget without deferring its repository', async () => {
    const { reads, events } = tracker()
    await expect(reads.run('owner/slow', NEVER)).rejects.toMatchObject({
      name: 'SweepReadBudgetExceededError',
      reason: 'read-timeout',
      budgetMs: 20,
    })
    expect(reads.deferral('owner/slow')).toBeUndefined()
    await expect(reads.run('owner/slow', async () => 'served')).resolves.toBe('served')
    expect(reads.outcome()).toEqual({ readTimeouts: 1, reposDeferred: 0, issuesDeferred: 0 })
    expect(events).toEqual(['read-timeout:read-timeout'])
  })

  it('defers a repository once it has spent its budget, without issuing another read', async () => {
    const { reads, advance } = tracker()
    for (let index = 0; index < 5; index += 1) {
      await reads.run('owner/slow', async () => { advance(10) })
    }
    expect(reads.deferral('owner/slow')).toBe('repo-budget')
    // Other repositories are untouched: the budget is per repository.
    expect(reads.deferral('owner/fast')).toBeUndefined()
    let started = false
    await expect(reads.run('owner/slow', async () => { started = true })).rejects.toBeInstanceOf(SweepReadBudgetExceededError)
    expect(started).toBe(false)
  })

  it('charges an abandoned read its whole wait, so a repository defers after exactly its budget', async () => {
    // The clock never advances here, as if every timer fired early against
    // the wall clock: the charge must still add up to the budget.
    const { reads } = tracker()
    await expect(reads.run('owner/slow', NEVER)).rejects.toMatchObject({ reason: 'read-timeout' })
    await expect(reads.run('owner/slow', NEVER)).rejects.toMatchObject({ reason: 'read-timeout' })
    // 40 ms spent of 50: the third read is capped at the 10 ms left.
    await expect(reads.run('owner/slow', NEVER)).rejects.toMatchObject({ reason: 'repo-budget' })
    expect(reads.deferral('owner/slow')).toBe('repo-budget')
    expect(reads.outcome().readTimeouts).toBe(3)
  })

  it('charges a failed read to its repository too', async () => {
    const { reads, advance } = tracker()
    await expect(reads.run('owner/slow', async () => {
      advance(60)
      throw new Error('backend error')
    })).rejects.toThrow('backend error')
    expect(reads.deferral('owner/slow')).toBe('repo-budget')
  })

  it('caps a read at the repository budget it has left', async () => {
    const { reads, advance } = tracker({ callMs: 1_000, repoMs: 2_000, readPhaseMs: 10_000 })
    await reads.run('owner/slow', async () => { advance(1_990) })
    await expect(reads.run('owner/slow', NEVER)).rejects.toMatchObject({ reason: 'repo-budget' })
  })

  it('defers every read once the read phase has ended', async () => {
    const { reads, advance } = tracker()
    advance(1_000)
    expect(reads.deferral(undefined)).toBe('read-deadline')
    expect(reads.deferral('owner/any')).toBe('read-deadline')
    await expect(reads.run(undefined, async () => 'late')).rejects.toMatchObject({ reason: 'read-deadline' })
  })

  it('does not spend the read phase on excluded work that is not a read', async () => {
    const { reads, advance } = tracker()
    // 900 ms of a 1 s phase goes on work that is not reading...
    await reads.excluding(async () => { advance(900) })
    // ...and 500 ms of reading later the phase is still open.
    advance(500)
    expect(reads.deferral(undefined)).toBeUndefined()
    await expect(reads.run(undefined, async () => 'read')).resolves.toBe('read')
    advance(500)
    expect(reads.deferral(undefined)).toBe('read-deadline')
  })

  it('still excludes the time when the excluded work fails', async () => {
    const { reads, advance } = tracker()
    await expect(reads.excluding(async () => {
      advance(2_000)
      throw new Error('roster unavailable')
    })).rejects.toThrow('roster unavailable')
    expect(reads.deferral(undefined)).toBeUndefined()
  })

  it('counts a deferred repository once, and a deferred issue every time', () => {
    const { reads, events } = tracker()
    reads.deferIssue('owner/slow', 'repo-budget')
    reads.deferIssue('owner/slow', 'repo-budget')
    reads.deferIssue('owner/other', 'read-timeout')
    expect(reads.outcome()).toEqual({ readTimeouts: 0, reposDeferred: 1, issuesDeferred: 3 })
    expect(reads.deferral('owner/slow')).toBe('repo-budget')
    // A timed-out issue costs that issue, not its repository.
    expect(reads.deferral('owner/other')).toBeUndefined()
    expect(events).toEqual([
      'issue-deferred:repo-budget',
      'repo-deferred:repo-budget',
      'issue-deferred:repo-budget',
      'issue-deferred:read-timeout',
    ])
  })

  it('surfaces the read error itself when the read fails inside its budget', async () => {
    const { reads } = tracker()
    const failure = Object.assign(new Error('shed'), { status: 429 })
    await expect(reads.run('owner/repo', async () => { throw failure })).rejects.toBe(failure)
  })
})
