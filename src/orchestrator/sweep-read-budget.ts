/**
 * Read budgets inside one readiness sweep (#376).
 *
 * ## Why the sweep budget alone is not enough
 *
 * A GitHub-source sweep reads each routed repository's projection one call at
 * a time: an index (or tree) listing per repository, then one read per
 * candidate. Each call was bounded only by the five-minute transport deadline,
 * and the sweep only by its aggregate budget. So a dependency that is slow but
 * still answering — every call succeeding at just under the transport
 * deadline — could hold one sweep for most of an hour. Dispatch runs only
 * after every candidate is read, so that one slow sweep is a dispatch outage.
 *
 * Three budgets, charged per sweep, turn "slow" into "deferred":
 *
 *   - **per read**: one repository listing or one issue read. A read that
 *     exceeds it fails that repository's listing, or that issue, for this
 *     sweep only.
 *   - **per repository**: total read time one repository may spend in one
 *     sweep. Past it, the rest of that repository's reads are deferred to the
 *     next sweep with a counted reason.
 *   - **read phase**: total time the sweep may spend reading before it stops
 *     reading and dispatches what it has. Unread repositories are deferred.
 *
 * Every deferral is fail-closed per issue by construction: an issue whose own
 * state was not read this sweep is never triaged or dispatched.
 *
 * ## Derived values
 *
 * At the default 30-minute sweep budget the three budgets resolve to
 * 60 s < 3 min < 15 min < 30 min:
 *
 *   - 60 s per read is twice `REMOTE_OPERATION_SLOW_WARN_MS` (30 s), this
 *     repository's own threshold for calling a relayfile call slow, and five
 *     times tighter than the five-minute transport deadline. Healthy reads take
 *     well under a second; a whole warm sweep has been measured at 917 ms.
 *   - 3 min per repository is three per-read budgets. A healthy repository
 *     costs one listing plus a few candidate reads, a second or two in total.
 *   - 15 min for the read phase is three 300 s reconcile intervals, and half
 *     the sweep budget, which leaves the other half for session preparation,
 *     dispatch and the checkpoint commit.
 *
 * Budgets are derived from the sweep budget rather than fixed, so a config (or
 * test) that tightens the sweep keeps the same strict ordering underneath it.
 *
 * ## What it can and cannot interrupt
 *
 * The same honest limitation as `sweep-budget.ts`: expiry abandons the WAIT,
 * it does not cancel the call. The transport's own deadline still ends the
 * abandoned request. What expiry does guarantee is that the sweep stops
 * waiting on it and moves on to the next repository.
 */

/** Ceiling for one read inside a sweep. See the module comment. */
export const SWEEP_READ_CALL_BUDGET_MS = 60_000

/** Ceiling for one repository's total read time inside a sweep. */
export const SWEEP_REPO_READ_BUDGET_MS = 3 * 60_000

/** Ceiling for the sweep's whole read phase, before dispatch starts. */
export const SWEEP_READ_PHASE_BUDGET_MS = 15 * 60_000

export interface SweepReadBudgets {
  /** One repository listing or one issue read. */
  readonly callMs: number
  /** One repository's total read time in one sweep. */
  readonly repoMs: number
  /** The whole read phase of one sweep. */
  readonly readPhaseMs: number
}

/**
 * The read budgets for a sweep with the given aggregate budget.
 *
 * Strictly ordered for every positive sweep budget:
 * `callMs < repoMs < readPhaseMs < sweepBudgetMs`. The read phase takes at most
 * half the sweep, a repository at most a fifth of the read phase, and one read
 * at most a third of a repository. At the defaults the ratios and the ceilings
 * agree exactly (60 s, 3 min, 15 min under 30 min).
 *
 * A deliberately unbounded sweep (`undefined`, or a non-positive value) still
 * gets the ceilings. They bound dispatch latency, not the sweep's lifetime.
 */
export function sweepReadBudgets(sweepBudgetMs: number | undefined): SweepReadBudgets {
  const sweep = sweepBudgetMs !== undefined && Number.isFinite(sweepBudgetMs) && sweepBudgetMs > 0
    ? sweepBudgetMs
    : undefined
  const readPhaseMs = sweep === undefined
    ? SWEEP_READ_PHASE_BUDGET_MS
    : Math.max(3, Math.min(SWEEP_READ_PHASE_BUDGET_MS, Math.floor(sweep / 2)))
  const repoMs = Math.max(2, Math.min(SWEEP_REPO_READ_BUDGET_MS, Math.floor(readPhaseMs / 5)))
  const callMs = Math.max(1, Math.min(SWEEP_READ_CALL_BUDGET_MS, Math.floor(repoMs / 3)))
  return { callMs, repoMs, readPhaseMs }
}

/**
 * Why a read, or a repository, was deferred to the next sweep. A closed set:
 * it reaches counters and logs.
 *
 *   - `read-timeout`: one read exceeded the per-read budget;
 *   - `repo-budget`: the repository spent its per-repository budget;
 *   - `read-deadline`: the sweep's read phase ended first.
 */
export type SweepReadDeferralReason = 'read-timeout' | 'repo-budget' | 'read-deadline'

/**
 * One read did not finish inside the sweep's read budget.
 *
 * Built only from code-controlled values, because a sweep that served nothing
 * rethrows it into the operator-facing `readinessReconcile.lastError`, and the
 * class name reaches the public surface through the error-class allowlist.
 *
 * Deliberately NOT a `RelayfileOperationTimeoutError`. That one means the
 * transport deadline fired, which is treated as a fact about the dependency and
 * escapes the per-item catches (#351). This one means *this sweep* chose to
 * stop waiting on one work unit, which is a fact about that unit.
 */
export class SweepReadBudgetExceededError extends Error {
  readonly code = 'FACTORY_SWEEP_READ_BUDGET_EXCEEDED'

  constructor(
    readonly reason: SweepReadDeferralReason,
    readonly budgetMs: number,
  ) {
    super(`sweep read deferred (${reason}) after ${budgetMs}ms`)
    this.name = 'SweepReadBudgetExceededError'
  }
}

/** Per-sweep deferral counts. Numbers only: this reaches the public surface. */
export interface SweepReadOutcome {
  readTimeouts: number
  reposDeferred: number
  issuesDeferred: number
}

const READ_TIMED_OUT = Symbol('sweep-read-timed-out')

type ReadOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * The read budgets of one sweep, and what they have deferred so far.
 *
 * `now` is injectable for tests. It must be the same clock the timers run on
 * (wall clock by default), because the remaining budget decides the timer.
 */
export class SweepReadTracker {
  readonly budgets: SweepReadBudgets
  readonly #now: () => number
  #deadlineAtMs: number
  readonly #repoSpentMs = new Map<string, number>()
  readonly #deferredRepos = new Map<string, SweepReadDeferralReason>()
  readonly #onDefer?: (event: 'read-timeout' | 'repo-deferred' | 'issue-deferred', reason: SweepReadDeferralReason) => void
  #readTimeouts = 0
  #issuesDeferred = 0

  constructor(
    budgets: SweepReadBudgets,
    opts: {
      now?: () => number
      onDefer?: (event: 'read-timeout' | 'repo-deferred' | 'issue-deferred', reason: SweepReadDeferralReason) => void
    } = {},
  ) {
    this.budgets = budgets
    this.#now = opts.now ?? Date.now
    this.#deadlineAtMs = this.#now() + budgets.readPhaseMs
    this.#onDefer = opts.onDefer
  }

  outcome(): SweepReadOutcome {
    return {
      readTimeouts: this.#readTimeouts,
      reposDeferred: this.#deferredRepos.size,
      issuesDeferred: this.#issuesDeferred,
    }
  }

  /**
   * Run sweep work that is not a read, without spending the read phase on it.
   *
   * The read phase bounds how long the sweep reads before it dispatches. Work
   * the sweep does between its listings and its first issue read (building
   * the orphan-recovery context: a fleet roster and state-store calls) is not
   * reading. Charging it would let a slow one expire the phase before any
   * issue is read, deferring every candidate on every sweep. Its own time is
   * still bounded by the aggregate sweep budget.
   */
  async excluding<T>(start: () => Promise<T>): Promise<T> {
    const startedAtMs = this.#now()
    try {
      return await start()
    } finally {
      this.#deadlineAtMs += Math.max(0, this.#now() - startedAtMs)
    }
  }

  /**
   * Why the next read for `repo` must not start, or `undefined` if it may.
   *
   * A repository already deferred stays deferred for the rest of the sweep,
   * so a deferral is a decision rather than a race each read re-runs.
   */
  deferral(repo: string | undefined): SweepReadDeferralReason | undefined {
    if (repo !== undefined) {
      const recorded = this.#deferredRepos.get(repo)
      if (recorded !== undefined) return recorded
    }
    if (this.#now() >= this.#deadlineAtMs) return 'read-deadline'
    if (repo !== undefined && (this.#repoSpentMs.get(repo) ?? 0) >= this.budgets.repoMs) return 'repo-budget'
    return undefined
  }

  /** Record that `repo` is deferred to the next sweep. Counted once per sweep. */
  deferRepo(repo: string | undefined, reason: SweepReadDeferralReason): void {
    if (repo === undefined || this.#deferredRepos.has(repo)) return
    this.#deferredRepos.set(repo, reason)
    this.#onDefer?.('repo-deferred', reason)
  }

  /** Record that one issue was not read this sweep because of `reason`. */
  deferIssue(repo: string | undefined, reason: SweepReadDeferralReason): void {
    this.#issuesDeferred += 1
    this.#onDefer?.('issue-deferred', reason)
    // A repository whose budget or read phase is spent is deferred as a whole.
    // One timed-out issue is not: it costs that issue, not its neighbours.
    if (reason !== 'read-timeout') this.deferRepo(repo, reason)
  }

  /**
   * Await `start()` under the tightest of the per-read budget, `repo`'s
   * remaining budget, and the read phase's remaining budget.
   *
   * Throws `SweepReadBudgetExceededError` naming whichever bound was binding,
   * without starting the read when one is already spent. Time spent is charged
   * to `repo` whether the read succeeds, fails or is abandoned.
   */
  async run<T>(repo: string | undefined, start: () => Promise<T>): Promise<T> {
    const deferred = this.deferral(repo)
    if (deferred !== undefined) throw new SweepReadBudgetExceededError(deferred, this.#budgetFor(deferred))
    const startedAtMs = this.#now()
    const repoRemainingMs = repo === undefined
      ? Number.POSITIVE_INFINITY
      : this.budgets.repoMs - (this.#repoSpentMs.get(repo) ?? 0)
    const phaseRemainingMs = this.#deadlineAtMs - startedAtMs
    const bounds: Array<[SweepReadDeferralReason, number]> = [
      ['read-timeout', this.budgets.callMs],
      ['repo-budget', repoRemainingMs],
      ['read-deadline', phaseRemainingMs],
    ]
    const [binding, waitMs] = bounds.reduce((tightest, bound) => bound[1] < tightest[1] ? bound : tightest)
    let timer: ReturnType<typeof setTimeout> | undefined
    let abandoned = false
    try {
      // Folded once, so a late rejection from the abandoned read has a handler
      // attached and cannot surface as an unhandled rejection.
      const inFlight: Promise<ReadOutcome<T>> = start().then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
      const outcome = await Promise.race<ReadOutcome<T> | typeof READ_TIMED_OUT>([
        inFlight,
        new Promise<typeof READ_TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(READ_TIMED_OUT), Math.max(0, waitMs))
          // Created once per read, like the per-call relayfile deadline; the
          // sweep budget is the timer that keeps a one-shot run alive.
          timer.unref?.()
        }),
      ])
      if (outcome === READ_TIMED_OUT) {
        // Every read abandoned in flight counts as timed out, whichever bound
        // cut it short; the error's reason says which one did.
        abandoned = true
        this.#readTimeouts += 1
        this.#onDefer?.('read-timeout', binding)
        throw new SweepReadBudgetExceededError(binding, this.#budgetFor(binding))
      }
      if (outcome.ok) return outcome.value
      throw outcome.error
    } finally {
      if (timer) clearTimeout(timer)
      if (repo !== undefined) {
        // An abandoned read is charged the whole wait it was granted. Timers
        // can fire a millisecond early against the wall clock, and charging
        // that shortfall would leave a sliver of budget that only buys
        // another read abandoned at once.
        const elapsedMs = Math.max(0, this.#now() - startedAtMs)
        const chargedMs = abandoned ? Math.max(elapsedMs, waitMs) : elapsedMs
        this.#repoSpentMs.set(repo, (this.#repoSpentMs.get(repo) ?? 0) + chargedMs)
      }
    }
  }

  #budgetFor(reason: SweepReadDeferralReason): number {
    if (reason === 'read-timeout') return this.budgets.callMs
    if (reason === 'repo-budget') return this.budgets.repoMs
    return this.budgets.readPhaseMs
  }
}
