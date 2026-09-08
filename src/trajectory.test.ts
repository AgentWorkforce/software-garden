import { describe, expect, it } from 'vitest'

import {
  canonicalTrajectorySessionRef,
  canonicalTrajectorySessionSource,
  renderTrajectoryPointer,
  stripTrajectoryPointers,
  trajectoryPointerFromBody,
  trajectorySessionRefFromBody,
} from './trajectory'

describe('trajectory replay pointer', () => {
  const sessionRef = '0198b179-c6c2-7e63-9177-4ef52f56c192'

  it('renders and parses the ruled three-key pointer for a canonical resolver input', () => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AgentWorkforce/factory#260',
      workUnitSurface: 'github',
      sessionRef,
    })

    expect(rendered).toBe(
      `<!-- trajectory: work_unit_id=AgentWorkforce/factory#260 work_unit_surface=github session_ref=${sessionRef} -->`,
    )
    expect(trajectoryPointerFromBody(rendered)).toEqual({
      workUnitId: 'AgentWorkforce/factory#260',
      workUnitSurface: 'github',
      sessionRef,
    })
    expect(trajectorySessionRefFromBody(rendered)).toBe(sessionRef)
  })

  it.each([
    undefined,
    '',
    'unknown-session-v3b',
    'missing',
    'ar-260-impl-factory',
    '00000000-0000-0000-0000-000000000000',
    'unsafe --> comment',
  ])('does not render unavailable input %j as replayable', (unavailableRef) => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AR-260',
      workUnitSurface: 'linear',
      sessionRef: unavailableRef,
    })

    expect(canonicalTrajectorySessionRef(unavailableRef)).toBeUndefined()
    expect(rendered).toContain('session_ref=missing -->')
    expect(trajectoryPointerFromBody(rendered)).toBeUndefined()
    expect(rendered).not.toContain('relay session replay')
  })

  it('never bakes a replay availability or retention claim into the PR body', () => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AR-260',
      workUnitSurface: 'linear',
      sessionRef,
    })

    expect(rendered).not.toContain('relay session replay')
    expect(rendered).not.toMatch(/retained|retention|expires|available/iu)
  })

  it('refuses conflicting pointers and strips inherited markers', () => {
    const first = renderTrajectoryPointer({
      workUnitId: 'AR-1',
      workUnitSurface: 'linear',
      sessionRef,
    })
    const second = renderTrajectoryPointer({
      workUnitId: 'AR-1',
      workUnitSurface: 'linear',
      sessionRef: '0198b179-c6c2-7e63-9177-4ef52f56c197',
    })

    expect(trajectoryPointerFromBody(`${first}\n${second}`)).toBeUndefined()
    expect(stripTrajectoryPointers(`body\n\n${first}\n${second}`)).toBe('body')
  })

  it('rejects an unsafe work-unit token before emitting an HTML comment', () => {
    expect(() => renderTrajectoryPointer({
      workUnitId: 'AR-1 --> leaked',
      workUnitSurface: 'linear',
      sessionRef,
    })).toThrow(/comment-safe token/u)
  })
})

describe('trajectory pointer session source', () => {
  const sessionRef = '0198b179-c6c2-7e63-9177-4ef52f56c192'

  // Copied verbatim from the tail of AgentWorkforce/factory#465, rendered by
  // the three-key code that is deployed today. It must never be regenerated
  // from the renderer under test — a self-produced fixture would follow the
  // renderer wherever it goes and prove nothing about the bodies already
  // sitting in open PRs.
  const HISTORICAL_THREE_KEY_POINTER =
    '<!-- trajectory: work_unit_id=AgentWorkforce/factory#420 work_unit_surface=github session_ref=missing -->'
  const HISTORICAL_THREE_KEY_POINTER_WITH_SESSION =
    '<!-- trajectory: work_unit_id=AgentWorkforce/factory#420 work_unit_surface=github ' +
    'session_ref=0198b179-c6c2-7e63-9177-4ef52f56c192 -->'

  it('round-trips all four keys', () => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AgentWorkforce/factory#460',
      workUnitSurface: 'github',
      sessionRef,
      sessionSource: 'claude',
    })

    expect(rendered).toBe(
      '<!-- trajectory: work_unit_id=AgentWorkforce/factory#460 work_unit_surface=github ' +
      `session_ref=${sessionRef} session_source=claude -->`,
    )
    expect(trajectoryPointerFromBody(rendered)).toEqual({
      workUnitId: 'AgentWorkforce/factory#460',
      workUnitSurface: 'github',
      sessionRef,
      sessionSource: 'claude',
    })
    expect(trajectorySessionRefFromBody(rendered)).toBe(sessionRef)
  })

  it('still resolves a historical three-key pointer, with no source', () => {
    const body = `Fixes #420\n\n${HISTORICAL_THREE_KEY_POINTER_WITH_SESSION}`

    expect(trajectoryPointerFromBody(body)).toEqual({
      workUnitId: 'AgentWorkforce/factory#420',
      workUnitSurface: 'github',
      sessionRef,
    })
    expect(trajectoryPointerFromBody(body)).not.toHaveProperty('sessionSource')
    expect(trajectorySessionRefFromBody(body)).toBe(sessionRef)
  })

  it('omits the key entirely when no source is known', () => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AgentWorkforce/factory#460',
      workUnitSurface: 'github',
      sessionRef,
    })

    expect(rendered).toBe(
      '<!-- trajectory: work_unit_id=AgentWorkforce/factory#460 work_unit_surface=github ' +
      `session_ref=${sessionRef} -->`,
    )
    expect(rendered).not.toContain('session_source')
  })

  it.each([
    'agent-relay',
    'trajectories',
    'Claude Code',
    '',
    'unsafe --> comment',
  ])('refuses to emit %j as a session source', (invalid) => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AgentWorkforce/factory#460',
      workUnitSurface: 'github',
      sessionRef,
      sessionSource: invalid,
    })

    expect(canonicalTrajectorySessionSource(invalid)).toBeUndefined()
    expect(rendered).not.toContain('session_source')
    expect(rendered).toBe(
      '<!-- trajectory: work_unit_id=AgentWorkforce/factory#460 work_unit_surface=github ' +
      `session_ref=${sessionRef} -->`,
    )
  })

  it.each(['claude', 'codex', 'cursor', 'grok', 'relay', 'trajectory', 'opencode'])(
    'accepts %j, the spelling ai-hist indexes',
    (source) => {
      expect(canonicalTrajectorySessionSource(source)).toBe(source)
      expect(renderTrajectoryPointer({
        workUnitId: 'AR-1',
        workUnitSurface: 'linear',
        sessionRef,
        sessionSource: source,
      })).toContain(` session_source=${source} -->`)
    },
  )

  it('never attaches a source to a pointer that names no session', () => {
    const rendered = renderTrajectoryPointer({
      workUnitId: 'AR-1',
      workUnitSurface: 'linear',
      sessionRef: undefined,
      sessionSource: 'claude',
    })

    expect(rendered).toContain('session_ref=missing -->')
    expect(rendered).not.toContain('session_source')
  })

  it('strips both the three-key and four-key forms', () => {
    const fourKey = renderTrajectoryPointer({
      workUnitId: 'AgentWorkforce/factory#460',
      workUnitSurface: 'github',
      sessionRef,
      sessionSource: 'codex',
    })
    const inherited = `body\n\n${HISTORICAL_THREE_KEY_POINTER}\n${fourKey}`

    expect(stripTrajectoryPointers(inherited)).toBe('body')

    const rerendered = `${stripTrajectoryPointers(inherited)}\n\n${fourKey}`
    expect(rerendered.match(/<!-- trajectory:/gu)).toHaveLength(1)
    expect(trajectoryPointerFromBody(rerendered)).toEqual({
      workUnitId: 'AgentWorkforce/factory#460',
      workUnitSurface: 'github',
      sessionRef,
      sessionSource: 'codex',
    })
  })

  it('refuses a body whose pointers agree on the session but disagree on its source', () => {
    const asClaude = renderTrajectoryPointer({
      workUnitId: 'AR-1',
      workUnitSurface: 'linear',
      sessionRef,
      sessionSource: 'claude',
    })
    const asCodex = renderTrajectoryPointer({
      workUnitId: 'AR-1',
      workUnitSurface: 'linear',
      sessionRef,
      sessionSource: 'codex',
    })

    expect(trajectoryPointerFromBody(`${asClaude}\n${asCodex}`)).toBeUndefined()
  })
})
