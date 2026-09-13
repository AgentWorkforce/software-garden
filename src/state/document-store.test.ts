import { describe, expect, it } from 'vitest'

import type { DispatchLifecycle } from '../ports/state'
import type { WatchStateDocument, WatchStateDocumentStore } from './document-store'
import { DocumentStateStore } from './file-state-store'

describe('DocumentStateStore durable restart boundary', () => {
  it('does not redispatch a claimed lifecycle after the process is replaced', async () => {
    let durableDocument: WatchStateDocument = { version: 3, workspaces: {} }
    const adapter = (): WatchStateDocumentStore => ({
      read: async () => structuredClone(durableDocument),
      write: async (document) => {
        durableDocument = structuredClone(document)
      },
      runMutation: async (operation) => await operation(),
      assertReady: async () => {},
    })

    const firstProcess = new DocumentStateStore({ batchSize: 2, documentStore: adapter() })
    const firstClaim = await firstProcess.claimDispatchLifecycle(
      'workspace',
      'AgentWorkforce/factory#268',
      lifecycle(),
      'first-owner',
      1_000,
      60_000,
    )
    expect(firstClaim).toMatchObject({ acquired: true, created: true })

    const restartedProcess = new DocumentStateStore({ batchSize: 2, documentStore: adapter() })
    const competingClaim = await restartedProcess.claimDispatchLifecycle(
      'workspace',
      'AgentWorkforce/factory#268',
      lifecycle(),
      'second-owner',
      1_001,
      60_000,
    )

    expect(competingClaim).toMatchObject({
      acquired: false,
      created: false,
      lifecycle: { lease: { owner: 'first-owner' } },
    })
  })

  it.each([false, true])('fences reused container PIDs and recovers only after expiry (renewed: %s)', async (renewed) => {
    let document: WatchStateDocument = { version: 3, workspaces: {} }
    const runtime = () => new DocumentStateStore({
      batchSize: 2,
      isProcessAlive: () => true,
      documentStore: {
        read: async () => structuredClone(document),
        write: async (next) => { document = structuredClone(next) },
        runMutation: async (operation) => operation(),
        assertReady: async () => {},
      },
    })
    const previous = runtime()
    const replacement = runtime()
    const owner = '37:previous-process'
    const nextOwner = '37:replacement-process'
    const ttl = 300_000
    const first = await previous.claimDiscoverySweep('workspace', owner, 1_000, ttl)
    expect(first).toMatchObject({ acquired: true, lease: { epoch: 1 } })
    // Even a caller presenting exactly the same identity must wait. Neither
    // equal PIDs nor equal UUIDs prove that the old publisher has stopped.
    expect(await replacement.claimDiscoverySweep('workspace', owner, 2_000, ttl))
      .toMatchObject({ acquired: false, reason: 'in-flight' })
    expect(await replacement.claimDiscoverySweep('workspace', nextOwner, 2_000, ttl))
      .toMatchObject({ acquired: false, reason: 'in-flight' })
    if (renewed) {
      expect(await previous.renewDiscoverySweep('workspace', owner, 1, 300_000, ttl)).toBe(true)
      expect(await replacement.claimDiscoverySweep('workspace', nextOwner, 301_000, ttl))
        .toMatchObject({ acquired: false, state: { lease: { epoch: 1, leaseUntilMs: 600_000 } } })
    }
    const expiry = renewed ? 600_000 : 301_000
    expect(await replacement.claimDiscoverySweep('workspace', nextOwner, expiry, ttl))
      .toMatchObject({ acquired: true, lease: { owner: nextOwner, epoch: 2, leaseUntilMs: expiry + ttl } })
    expect(await previous.renewDiscoverySweep('workspace', owner, 1, expiry + 1, ttl)).toBe(false)
    expect(await previous.completeDiscoverySweep('workspace', owner, 1)).toBe(false)
    await previous.releaseDiscoverySweep('workspace', owner, 1)
    expect(document.workspaces.workspace.discoverySweep.lease)
      .toEqual({ owner: nextOwner, epoch: 2, leaseUntilMs: expiry + ttl })
  })

  it('keeps an unexpired lease owned by a PID in another runtime', async () => {
    let durableDocument: WatchStateDocument = { version: 3, workspaces: {} }
    const adapter = (): WatchStateDocumentStore => ({
      read: async () => structuredClone(durableDocument),
      write: async (document) => {
        durableDocument = structuredClone(document)
      },
      runMutation: async (operation) => await operation(),
      assertReady: async () => {},
    })
    const firstRuntime = new DocumentStateStore({
      batchSize: 2,
      documentStore: adapter(),
      isProcessAlive: () => true,
    })
    expect(await firstRuntime.claimDiscoverySweep('workspace', '111:first-runtime', 1_000, 60_000))
      .toMatchObject({ acquired: true, lease: { owner: '111:first-runtime' } })

    const secondRuntime = new DocumentStateStore({
      batchSize: 2,
      documentStore: adapter(),
      // A remote host must conservatively treat every foreign PID as alive;
      // only the durable lease deadline can permit takeover across runtimes.
      isProcessAlive: () => true,
    })
    expect(await secondRuntime.claimDiscoverySweep('workspace', '222:second-runtime', 1_001, 60_000))
      .toMatchObject({
        acquired: false,
        reason: 'in-flight',
        state: { lease: { owner: '111:first-runtime' } },
      })
  })
})

const lifecycle = (): DispatchLifecycle => ({
  runId: 'run-268',
  issue: {
    uuid: 'AgentWorkforce/factory#268',
    key: '268',
    path: '/github/issues/AgentWorkforce__factory/268.json',
  },
  decision: {
    issue: {
      uuid: 'AgentWorkforce/factory#268',
      key: '268',
      path: '/github/issues/AgentWorkforce__factory/268.json',
    },
    routes: [{ repo: 'AgentWorkforce/factory', rationale: 'durability regression' }],
    scope: 'single',
    implementers: [],
    reviewer: {
      name: 'ar-268-review',
      role: 'reviewer',
      capability: 'spawn:codex',
      task: 'review',
      repo: 'AgentWorkforce/factory',
    },
    thin: false,
    confidence: 'high',
    rationale: 'durability regression',
  },
  dryRun: false,
  phase: 'dispatching',
  agents: [],
  invocationIds: [],
  updatedAtMs: 1_000,
})
