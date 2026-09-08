# Completed-session replay pointers on Software Garden PRs

Every pull request Software Garden opens ends with the ruled, reference-only trajectory
marker:

```html
<!-- trajectory: work_unit_id=AgentWorkforce/factory#260 work_unit_surface=github session_ref=<relay-session-uuid> -->
```

When Software Garden knows which agent produced the session, the marker carries a
fourth, optional key naming that source:

```html
<!-- trajectory: work_unit_id=AgentWorkforce/factory#260 work_unit_surface=github session_ref=<relay-session-uuid> session_source=claude -->
```

The first three keys are the contract and always appear, in that order.
`session_ref` is the existing opaque UUID emitted by Relay; Software Garden does
not mint a replay id. Linear work uses its issue key, GitHub work uses
`owner/repo#number`, and work without a provider ticket uses a Software
Garden-synthesized work-unit id.

`session_source` is **optional and additive**. It names the agent that produced
the session, so a consumer keyed on `(source, session_id)` — such as the
`session_links` model — does not have to guess. It is written only when the
source is both known and one of the sources ai-hist indexes (`claude`, `codex`,
`cursor`, `grok`, `relay`, `trajectory`, `opencode` — note `relay`, not
`agent-relay`), and it is never written alongside `session_ref=missing`, because
a source that qualifies no session names nothing.

Two rules bind a resolver:

- It **must** accept a marker carrying only the three keys. Every pointer
  written before this key existed has that shape, and those PRs are still open.
- It **must not** treat an unrecognized `session_source` value as if the key
  were absent. The SDK parser rejects such a marker outright rather than
  returning it as a source-less pointer, so an unvalidatable source identity can
  never be silently downgraded into a legacy-looking one.

Software Garden deliberately does not write `relay session replay <session_ref>` or a
retention claim into the PR body. Replay availability changes after publication
as the workspace's pricing-tier retention window advances. An authenticated
resolver reads this marker, obtains the workspace's live `retained-since` or
never-prune boundary, and only then renders the copyable replay command. If the
conversation has aged out, the resolver must show incomplete coverage and must
not render it as replayable.

When Software Garden has no canonical non-nil session UUID, the marker says
`session_ref=missing`. The SDK parser does not return that marker as resolver
input. Parsing a UUID does not itself establish replay availability. Software Garden
also strips inherited trajectory markers from issue text before
appending its single canonical marker.

The PR carries only a reference. Conversation payload and access control remain
at resolution time, and replay of completed work stays distinct from attaching
to or relocating a running session.
