import { telemetryErrorClass, telemetryErrorClassName } from '../observability/error-class'
import { DISCOVERY_SWEEP_PHASES, type DiscoverySweepPhase } from './sweep-budget'

export type ReadinessFailurePhase = DiscoverySweepPhase | 'readiness-deadline' | 'unknown'

/** Bounded cause traversal: contextual wrappers must not hide the useful class. */
export function readinessFailureCauseClass(error: unknown): string | undefined {
  let result: string | undefined
  try {
    const seen = new Set<unknown>([error])
    for (let depth = 0; error instanceof Error && depth < 8; depth += 1) {
      const cause: unknown = error.cause
      if (cause === undefined || seen.has(cause)) break
      seen.add(cause)
      result = telemetryErrorClass(cause)
      error = cause
    }
  } catch {
    // Diagnostics must not replace the failure with a hostile cause accessor.
  }
  return result
}

/** Reconstruct public text from controlled fields, never copy an error message. */
export function publicReadinessFailure(record: {
  consecutiveFailures?: unknown
  lastError?: unknown
  lastErrorClass?: unknown
  lastErrorPhase?: unknown
  lastErrorCauseClass?: unknown
}): {
  lastError?: string
  lastErrorClass?: string
  lastErrorPhase?: ReadinessFailurePhase
  lastErrorCauseClass?: string
} {
  if (!(typeof record.consecutiveFailures === 'number' && Number.isFinite(record.consecutiveFailures) && record.consecutiveFailures > 0) &&
      record.lastError === undefined && record.lastErrorClass === undefined) return {}
  const errorClass = telemetryErrorClassName(record.lastErrorClass)
  const phase = (DISCOVERY_SWEEP_PHASES as readonly unknown[]).includes(record.lastErrorPhase) ||
      record.lastErrorPhase === 'readiness-deadline'
    ? record.lastErrorPhase as ReadinessFailurePhase
    : 'unknown'
  const causeClass = record.lastErrorCauseClass === undefined
    ? undefined
    : telemetryErrorClassName(record.lastErrorCauseClass)
  return {
    lastError: `Sweep failed during ${phase} (${errorClass}${causeClass ? `; cause: ${causeClass}` : ''}); details: /evidence`,
    lastErrorClass: errorClass,
    lastErrorPhase: phase,
    ...(causeClass ? { lastErrorCauseClass: causeClass } : {}),
  }
}
