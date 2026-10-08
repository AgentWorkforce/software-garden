import type {
  DependencyParkState,
  BabysitterGenerationRecord,
  BabysitterSessionState,
  ConversationSessionState,
  DiscoverySweepState,
  DispatchAttemptState,
  DispatchLifecycle,
  GithubIssueCommentWatchState,
  SlackThreadWatchState,
  WaitingClarification,
} from '../ports/state'

/**
 * The durable half of `DispatchAttemptState`. `inFlight` is deliberately
 * absent: it is one process's "a dispatch of mine is mid-flight" guard, and the
 * durable lifecycle lease is what fences other instances. Persisted, it would
 * leak one instance's guard into another, and a crash mid-dispatch would leave
 * the unit refused as in-flight with no process left to clear it.
 */
export type PersistedDispatchAttemptState = Omit<DispatchAttemptState, 'inFlight'>

export type PersistedWorkspaceState = {
  dependencyParks?: Record<string, DependencyParkState>
  /**
   * The per-work-unit dispatch attempt budget. Optional so documents written
   * before it existed still parse, and so a workspace that never dispatched
   * keeps its exact bytes. It must be durable: kept in process memory, every
   * restart handed each work unit a fresh `dispatch.maxAttempts`.
   */
  dispatchAttempts?: Record<string, PersistedDispatchAttemptState>
  githubIssueCommentWatches: Record<string, GithubIssueCommentWatchState>
  slackThreadWatches: Record<string, SlackThreadWatchState>
  waitingClarifications: Record<string, WaitingClarification>
  babysitterSessions: Record<string, BabysitterSessionState>
  babysitterGenerations: Record<string, BabysitterGenerationRecord>
  conversationSessions: Record<string, ConversationSessionState>
  dispatchLifecycles: Record<string, DispatchLifecycle>
  discoverySweep: DiscoverySweepState
}

export type WatchStateDocument = {
  version: 3
  workspaces: Record<string, PersistedWorkspaceState>
}

/**
 * Persistence seam for the document-backed StateStore behavior.
 *
 * Implementations must make each runMutation callback serializable with every
 * other writer. A local file implementation can hold a filesystem lock; a
 * remote implementation can use revisioned compare-and-set and retry the pure
 * callback after a conflict.
 */
export interface WatchStateDocumentStore {
  read(): Promise<WatchStateDocument>
  write(document: WatchStateDocument): Promise<void>
  runMutation<T>(operation: () => Promise<T>): Promise<T>
  assertReady(): Promise<void>
}

export class WatchStateDocumentConflictError extends Error {
  constructor(message = 'Factory state document changed concurrently') {
    super(message)
    this.name = 'WatchStateDocumentConflictError'
  }
}
