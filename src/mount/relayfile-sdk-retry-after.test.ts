import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayFileClient } from '@relayfile/sdk'

import { RelayfileCloudMountClient } from './relayfile-cloud-mount-client'

// Regression coverage for the Relayfile read path under workspace backpressure.
//
// Relayfile sheds an overloaded workspace with a `429 workspace_busy` whose
// body advertises how long to wait (`details.retryAfterSeconds`) and carries no
// `Retry-After` header. Older SDKs ignored that body field and retried on their
// own sub-second backoff, so all retries landed inside the busy window and the
// read failed. This drives the garden's real read path over a real SDK client
// built with the SDK's default retry options — the same shape
// `RelayfileSetup.client()` returns in production — so the SDK's own retry loop
// is what is under test, and only the HTTP layer is faked.

const WORKSPACE_ID = 'ws_fixture'
const FILE_PATH = '/github/repos/example-org/example-repo/issues/1.json'
const ADVERTISED_RETRY_AFTER_SECONDS = 5

const workspaceBusy = (): Response =>
  new Response(
    JSON.stringify({
      code: 'workspace_busy',
      message: 'workspace is busy; retry later',
      details: { retryAfterSeconds: ADVERTISED_RETRY_AFTER_SECONDS },
    }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  )

const fileRead = (): Response =>
  Response.json({
    path: FILE_PATH,
    revision: 'rev_1',
    contentType: 'application/json',
    content: JSON.stringify({ number: 1, state: 'open' }),
  })

const mountOver = (fetchImpl: typeof fetch): RelayfileCloudMountClient =>
  new RelayfileCloudMountClient({
    workspaceId: WORKSPACE_ID,
    client: new RelayFileClient({
      baseUrl: 'https://relayfile.example',
      token: 'fixture-token',
      fetchImpl,
      readCache: false,
    }),
    // No per-call deadline: this test controls time explicitly.
    operationTimeoutMs: 0,
    skipRegisteredMirrorLookup: true,
  })

describe('Relayfile read path under 429 workspace_busy', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits the server-advertised retryAfterSeconds before retrying, then serves the read', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(workspaceBusy())
      .mockResolvedValueOnce(fileRead())
    const mount = mountOver(fetchImpl)

    const read = mount.readFile(FILE_PATH)
    const settled = read.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    // The SDK's own backoff caps at 2s; a client that ignored the advertised
    // delay would have retried (and been served) well before this point.
    await vi.advanceTimersByTimeAsync(ADVERTISED_RETRY_AFTER_SECONDS * 1_000 - 1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await expect(settled).resolves.toEqual({
      ok: true,
      value: { content: { number: 1, state: 'open' }, revision: 'rev_1' },
    })
    const [url] = fetchImpl.mock.calls[1]!
    expect(String(url)).toContain(`/v1/workspaces/${WORKSPACE_ID}/fs/file`)

    await mount.dispose()
  })
})
