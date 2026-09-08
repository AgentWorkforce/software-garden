export type TrajectoryWorkUnitSurface = 'linear' | 'github' | 'factory'

/**
 * The exact session sources ai-hist indexes (`SOURCE_CHOICES` in
 * `relayhistory/crates/ai-hist-core/src/lib.rs`).
 *
 * The downstream `session_links` row is keyed on
 * `(org_id, source, session_id, link_kind, link_ref)`, so the source is part of
 * the identity, not a label: `relay` and `trajectory` are the spellings that
 * resolve — `agent-relay` and `trajectories` do not.
 */
export const TRAJECTORY_SESSION_SOURCES = [
  'claude',
  'codex',
  'cursor',
  'grok',
  'relay',
  'trajectory',
  'opencode',
] as const

export type TrajectorySessionSource = (typeof TRAJECTORY_SESSION_SOURCES)[number]

export interface TrajectoryPointer {
  workUnitId: string
  workUnitSurface: TrajectoryWorkUnitSurface
  sessionRef?: string
  sessionSource?: string
}

/**
 * A pointer proven by parsing. The session ref is canonical; the source is
 * optional because the three-key pointers already living in open PR bodies
 * carry no source and must keep resolving.
 */
export interface ResolvedTrajectoryPointer {
  workUnitId: string
  workUnitSurface: TrajectoryWorkUnitSurface
  sessionRef: string
  sessionSource?: TrajectorySessionSource
}

export const MISSING_TRAJECTORY_SESSION_REF = 'missing'

// `session_source` is optional in the pattern, not a second pattern: pointers
// rendered before this key existed are already in open PR bodies, and
// `trajectoryPointerFromBody` answers a non-match with `undefined` rather than
// an error, so a four-key-only pattern would stop resolving every historical
// PR without saying anything.
const TRAJECTORY_POINTER_PATTERN =
  /<!-- trajectory: work_unit_id=([^\s>]+) work_unit_surface=(linear|github|factory) session_ref=([^\s>]+)(?: session_source=([^\s>]+))? -->/gu
const AI_HIST_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const NIL_SESSION_UUID = '00000000-0000-0000-0000-000000000000'
const POINTER_TOKEN = /^[^\s>]+$/u

/**
 * Accept only the opaque UUID emitted by Relay for an ai-hist session. Factory
 * does not resolve it or infer current replay availability; the authenticated
 * replay resolver owns that live, retention-aware decision.
 */
export function canonicalTrajectorySessionRef(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || !AI_HIST_SESSION_UUID.test(normalized) || normalized.toLowerCase() === NIL_SESSION_UUID) {
    return undefined
  }
  return normalized
}

/**
 * Accept only a source ai-hist indexes. An unrecognized source is dropped, not
 * coerced: a `session_links` row keyed on a source the substrate does not know
 * is worse than a row the future `github` lens declines to write.
 */
export function canonicalTrajectorySessionSource(value: string | undefined): TrajectorySessionSource | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  return (TRAJECTORY_SESSION_SOURCES as readonly string[]).includes(normalized)
    ? normalized as TrajectorySessionSource
    : undefined
}

/**
 * Render the ruled HTML marker without claiming replay availability.
 *
 * `session_source` is emitted only when it qualifies a real session: a known
 * source alongside a canonical ref. There is no `missing` sentinel for it — a
 * source attached to a `session_ref=missing` pointer names no session and
 * would key a `session_links` row on nothing.
 */
export function renderTrajectoryPointer(pointer: TrajectoryPointer): string {
  if (!POINTER_TOKEN.test(pointer.workUnitId)) {
    throw new Error(`Trajectory work unit id must be a comment-safe token: ${pointer.workUnitId}`)
  }
  const sessionRef = canonicalTrajectorySessionRef(pointer.sessionRef)
  const sessionSource = sessionRef ? canonicalTrajectorySessionSource(pointer.sessionSource) : undefined
  const source = sessionSource ? ` session_source=${sessionSource}` : ''
  return `<!-- trajectory: work_unit_id=${pointer.workUnitId} work_unit_surface=${pointer.workUnitSurface} session_ref=${sessionRef ?? MISSING_TRAJECTORY_SESSION_REF}${source} -->`
}

/**
 * Returns one unambiguous resolver input pointer. Parsing proves identity
 * shape, not live replay availability; clients must resolve workspace retention.
 */
export function trajectoryPointerFromBody(body: string): ResolvedTrajectoryPointer | undefined {
  const pointers = new Map<string, ResolvedTrajectoryPointer>()
  for (const match of body.matchAll(TRAJECTORY_POINTER_PATTERN)) {
    const sessionRef = canonicalTrajectorySessionRef(match[3])
    const workUnitId = match[1]
    const workUnitSurface = match[2] as TrajectoryWorkUnitSurface | undefined
    if (!sessionRef || !workUnitId || !workUnitSurface) continue
    const sessionSource = canonicalTrajectorySessionSource(match[4])
    const pointer = { workUnitId, workUnitSurface, sessionRef, ...(sessionSource ? { sessionSource } : {}) }
    // The source is part of the identity: two pointers that agree on the
    // session but disagree on its source are still two answers, and the
    // caller gets `undefined` rather than whichever one was rendered last.
    pointers.set(`${workUnitId}:${workUnitSurface}:${sessionRef}:${sessionSource ?? ''}`, pointer)
  }
  return pointers.size === 1 ? [...pointers.values()][0] : undefined
}

/** Return only the session UUID from the one unambiguous resolver input pointer. */
export function trajectorySessionRefFromBody(body: string): string | undefined {
  return trajectoryPointerFromBody(body)?.sessionRef
}

/** Remove inherited pointers before Factory appends its single canonical one. */
export function stripTrajectoryPointers(body: string): string {
  return body.replace(TRAJECTORY_POINTER_PATTERN, '').replace(/\n{3,}/gu, '\n\n').trim()
}
