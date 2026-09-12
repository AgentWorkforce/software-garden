import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync(new URL('../../.github/workflows/review-at-head-enforced.yml', import.meta.url), 'utf8'))
const advisory = parse(readFileSync(new URL('../../.github/workflows/review-at-head.yml', import.meta.url), 'utf8'))
const steps = workflow.jobs.evaluate.steps
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

// Execute the actual workflow's API scripts so assertions cover publication,
// including fail-closed outcomes, not a second implementation of the YAML.
const execute = (script: string, github: unknown, context: unknown, env = {}) =>
  new AsyncFunction('github', 'context', 'process', script)(github, context, { env })

const context = {
  repo: { owner: 'owner', repo: 'repo' }, eventName: 'workflow_run',
  payload: { workflow_run: { conclusion: 'success', pull_requests: [], head_sha: 'attacker-head' } },
}

describe('trusted review workflow', () => {
  it('never loads the enforcement workflow through a PR-owned event', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request_target', 'push', 'schedule', 'workflow_run'])
    expect(workflow.on.workflow_run).toEqual({ workflows: [advisory.name], types: ['requested', 'completed'] })
    expect(advisory.on.pull_request_review.types).toEqual(['submitted', 'edited', 'dismissed'])
    expect(advisory.on.pull_request_review_comment.types).toEqual(['created', 'edited', 'deleted'])
    expect(Object.keys(workflow.jobs)).not.toContain('enforced')
    expect(workflow.jobs.evaluate.concurrency['cancel-in-progress']).toBe(false)
    const checkout = steps.find((step: any) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout.with).toEqual({ ref: '${{ matrix.pull.base }}', 'persist-credentials': false })
    expect(steps.find((step: any) => step.uses?.startsWith('actions/setup-node@')).with.cache).toBeUndefined()
    expect(steps.some((step: any) => /download-artifact|actions\/cache/.test(step.uses))).toBe(false)
  })

  it('uses current API metadata even for a fork wakeup with no PR association', async () => {
    const pulls = [
      { number: 3, state: 'open', head: { sha: 'current-head' }, base: { ref: 'main', sha: 'stale-snapshot' } },
      { number: 4, state: 'closed', head: { sha: 'closed' }, base: { sha: 'base' } },
    ]
    const paginate = vi.fn().mockResolvedValue(pulls)
    const getRef = vi.fn().mockResolvedValue({ data: { object: { sha: 'trusted-base' } } })
    const result = await execute(workflow.jobs.targets.steps[0].with.script,
      { paginate, rest: { pulls: { list: 'list' }, git: { getRef } } }, context)
    expect(result).toEqual([{ number: 3, head: 'current-head', base: 'trusted-base' }])
    expect(paginate).toHaveBeenCalledWith('list', { owner: 'owner', repo: 'repo', state: 'open', per_page: 100 })
    expect(getRef).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', ref: 'heads/main' })
  })

  it('resolves the live base for a pull_request_target wakeup too', async () => {
    const get = vi.fn().mockResolvedValue({ data: {
      number: 3, state: 'open', head: { sha: 'head' }, base: { ref: 'release/v1', sha: 'stale-snapshot' },
    } })
    const getRef = vi.fn().mockResolvedValue({ data: { object: { sha: 'live-base' } } })
    const result = await execute(workflow.jobs.targets.steps[0].with.script,
      { rest: { pulls: { get }, git: { getRef } } }, {
        ...context, eventName: 'pull_request_target', payload: { pull_request: { number: 3 } },
      })
    expect(result).toEqual([{ number: 3, head: 'head', base: 'live-base' }])
    expect(getRef).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', ref: 'heads/release/v1' })
  })

  it('creates the enforced check on the selected PR head, not the workflow SHA', async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: 17 } })
    const check = steps.find((step: any) => step.id === 'check')
    expect(await execute(check.with.script, { rest: { checks: { create } } }, context,
      { HEAD_SHA: 'current-head' })).toBe(17)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Review at head (enforced)', head_sha: 'current-head', status: 'in_progress',
    }))
  })

  it.each(['failure', 'cancelled', 'skipped', undefined])('fails closed when evaluation is %s', async verdict => {
    const update = vi.fn()
    await execute(steps.at(-1).with.script, { rest: { checks: { update } } }, context,
      { CHECK_ID: '17', VERDICT: verdict })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 17, conclusion: 'failure' }))
  })

  it('publishes success only for the executed predicate succeeding', async () => {
    const update = vi.fn()
    await execute(steps.at(-1).with.script, { rest: { checks: { update } } }, context,
      { CHECK_ID: '17', VERDICT: 'success' })
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 17, conclusion: 'success' }))
    const verdict = steps.find((step: any) => step.id === 'verdict')
    expect(verdict.run).toContain('"$EXPECTED_HEAD" "$EXPECTED_BASE"')
    expect(verdict.env.EXPECTED_HEAD).toBe('${{ matrix.pull.head }}')
    expect(verdict.env.EXPECTED_BASE).toBe('${{ matrix.pull.base }}')
  })
})
