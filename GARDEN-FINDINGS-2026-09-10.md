# Software Garden dispatch finding — 2026-09-10

**The dispatcher is running. The four ready issues reach discovery and durable queuing, then wait for dispatch capacity occupied by work repeatedly failing Cloud sandbox enrollment before agent placement.** A separate retained readiness failure names fleet database overload. This is not currently a start-disabled deployment, an empty queue, or evidence of two independent claim namespaces.

## Evidence, in the requested diagnostic order

1. **Process:** `GET https://agentworkforce-factory.agent-workforce.workers.dev/healthz` returned HTTP 200 at **19:21:41 UTC**, with `phase=running`, `factoryProcess=running`, and a fresh heartbeat. The daemon started at **18:50:04.169 UTC**. Its build is **0.1.90 / 191f6fb7a04b7bc29a85badec82e5094c30b4795**. The authenticated companion read says `factory.requestedLiveStart=true`.

   The brief's deployment warning is historical: current `Deploy Factory` defaults `dry_run=false`, changed by [factory-cloud #141](https://github.com/AgentWorkforce/factory-cloud/pull/141). Regardless of that source change, the direct process measurement rules out start-disabled mode for this observation. No deployment was initiated.

2. **Readiness reconciliation:** the **19:23:35.514 UTC** authenticated heartbeat reports `state=retrying`, `consecutiveFailures=2`, `lastDurationMs=487022`, and `lastFailureAtMs=1789067601697` (**19:13:21.697 UTC**). Its retained error is:

   > Aborting readiness pass after 5 unclassified dispatch failures without a successful dispatch: Software Garden dispatch paused because the fleet control plane is unavailable: The database is temporarily overloaded. Retry after the interval in the Retry-After header.

   This names the preceding failed pass. It does not mean the in-flight pass failed at the same point. Successful-enumeration counters are absent in this heartbeat; they must not be interpreted as zero candidates.

3. **Capacity:** the first health read had `active=5`, `batchSize=5`, `waiting=0`, with **all five occupants at `placedAgents=0`**. At **19:24:50.537 UTC**, capacity reported `state=waiting`, `active=5`, `waiting=19`; all five occupants still had no placed agents. Its configured agentless hold budget is **1,800,000 ms (30 minutes)**.

   The logs explicitly name all four requested issues and their gate:

   | Issue | Discovery result, UTC | Subsequent capacity result |
   | --- | --- | --- |
   | #427 | 19:23:12.929 — `queued-or-escalated` | 19:23:13.966 — queued for batch capacity |
   | #413 | 19:23:23.736 — `queued-or-escalated` | 19:23:24.771 — queued for batch capacity |
   | #409 | 19:23:25.868 — `queued-or-escalated` | 19:23:26.910 — queued for batch capacity |
   | #390 | 19:23:31.220 — `queued-or-escalated` | 19:23:32.257 — queued for batch capacity |

   Each wait names the same five occupants, issues 124–128 in another routed repository. Thus discovery reaches these four issues; their immediate gate is capacity, not missing ingestion. The earlier `waiting=0` snapshot did not establish an empty queue.

4. **Fleet control plane and placement:** both health snapshots report a **closed** circuit with zero consecutive failures and `fleetConnect.state=connected`. The authenticated retained error proves an earlier overload; a later closed circuit cannot disprove it.

   Independently, occupant retry logs show fresh sandbox ensure failing with **HTTP 504**, `provisioning_timeout`, and **`enrollmentDiagnosis=node_absent_from_roster`**. The response says no node carrying the sandbox's name appeared in a readable, populated fleet roster. Other retries return **HTTP 502**, explicitly **`during fleet_enrollment`**. These are distinct failures: the 504 is enrollment observation timing out; the 502 is an enrollment preparation failure.

   The reuse fallback is rejected because Cloud returns a pre-existing node without a `sandboxId`, which cannot establish the JIT clone-layout contract. Weakening that refusal would not fix enrollment. The sample also reports `cleanup=destroyed` for specific timed-out allocations; this does not establish that all historical allocations were reclaimed.

Primary evidence: [authenticated evidence run 34519986008](https://github.com/AgentWorkforce/factory-cloud/actions/runs/34519986008). Both unauthenticated and wrong-bearer controls returned 401 before the authenticated read succeeded. The workflow only reads `/evidence` and `/healthz`.

## Why the claims are still present

[Claim read 34520042088](https://github.com/AgentWorkforce/factory-cloud/actions/runs/34520042088) found these durable records under the deployed `AgentWorkforce/factory` identity:

| Issue | Durable phase | Evidence |
| --- | --- | --- |
| #390, #409, #413, #427 | `queued`, no agents | Live leases; capacity waits above |
| #417 | `dispatching` | Lease epoch 5, updated 19:24:03.405 UTC; named implementer/babysitter records; spawn failures at 19:21:25.955, 19:22:41.666, and 19:23:08.940 |
| #430 | `queued`, no agents | Lease epoch 1, updated 19:24:05.236 UTC; capacity waits begin 19:23:09.696 |
| #221 | No matching claim at tested legacy paths | A second read also found none at tested renamed-repository paths |

All six found records have the same owner, `37:11e79ecd-10ed-439f-aa2a-b728990a8e1b`, and `dryRun=false`. Agent names in #417's record are not proof of current placement. The spawn errors explain why its current retry does not advance; #430 has not passed capacity admission. Neither row is currently a completed/released lifecycle that merely forgot to remove a label.

The label timestamps date the external GitHub claim, **not uninterrupted ownership of one durable run**. These fresh observations explain present retention; they do not reconstruct every intervening event across 42–55 hours. Older issue comments about missing `factory.lifecycle` are from earlier attempts and must not be substituted for today's spawn evidence. #417 also has existing open [PR #464](https://github.com/AgentWorkforce/software-garden/pull/464); manually freeing it without reconciliation risks duplicate work.

A second [claim read under `issue_repo=software-garden`](https://github.com/AgentWorkforce/factory-cloud/actions/runs/34520261268), at **19:25:07–19:25:15 UTC**, found a separate set of **historical terminal records** for the same six issues. #390 and #417 are `abandoned` with `releaseReason=publish-retries-exhausted`; #409, #413, #427, and #430 are `abandoned` with `releaseReason=agentless-slot-past-deadline`. Every one was last updated **September 6**, and every projected lease expired that day. #221 was absent under this spelling too. Thus repository renaming did leave two durable identity spellings, but the observed renamed rows are terminal historical attempts; only the legacy `factory` rows show current nonterminal ownership. This is not evidence of two concurrent live owners. In particular, the abandoned renamed #417/#430 attempts predate the September 8/9 GitHub label events and cannot alone explain those later labels.

The two label names are a migration alias, not two isolated claim stores in this build. At the exact deployed commit, [hasGardenLifecycleLabel](https://github.com/AgentWorkforce/software-garden/blob/191f6fb7a04b7bc29a85badec82e5094c30b4795/src/constants/lifecycle-labels.ts#L103) accepts both `factory:in-progress` and `garden:in-progress`; new writes use `garden:*`. GitHub events show #221's legacy label applied by `khaliqgant` on **August 13**, versus #417/#430's garden labels applied by `agent-relay-code[bot]` on **September 8/9**. There is no evidence here of a second live dispatcher owning #221. No claims or labels were changed.

## PR-walk cost and existing fixes

The captured logs do show repeated `index-no-match` full PR walks: probes read **84 records**, with 69–71 reads already costing **45–47 seconds**. This is real additional latency, but the sample does not show the historical 1,493-path dependency walk, and no inference that such a walk caused the enrollment failures is warranted. [PR #499](https://github.com/AgentWorkforce/software-garden/pull/499) already targets repeated PR-body reads and remains open; [PR #500](https://github.com/AgentWorkforce/software-garden/pull/500) targets failure-cause visibility and remains open. No duplicate PR was created.

Several relevant fixes are merged but **absent from the deployed build**:

- [#497](https://github.com/AgentWorkforce/software-garden/pull/497), merged September 9: dispatch slot lifetime and candidate-capacity signals.
- [#510](https://github.com/AgentWorkforce/software-garden/pull/510), merged September 10: bounded stale-roster admission during transient failures.
- [#498](https://github.com/AgentWorkforce/software-garden/pull/498), merged September 9: discovery stall reporting and dependency-result retention.

The deployed commit precedes all three; factory-cloud still pins **0.1.90**, and software-garden main still declares that version. Another deploy of the same pinned artifact cannot deliver these fixes. They need the existing version-PR/publish process followed by an explicit live deployment. Releasing those changes is mitigation, not proof that Cloud enrollment works.

The enrollment failure itself is already tracked by [Cloud #3396](https://github.com/AgentWorkforce/cloud/issues/3396); related ongoing provisioning/registration failures are recorded in [Cloud #3401](https://github.com/AgentWorkforce/cloud/issues/3401). Today's evidence narrows it to `fleet_enrollment` and `node_absent_from_roster`, but does not expose the failing enrollment command's stderr. That is the next discriminating measurement for a root-cause code fix. No speculative lifecycle rewrite, production reset, release, or merge was performed.

## Reproduce the read-only measurements

```sh
curl -fsS https://agentworkforce-factory.agent-workforce.workers.dev/healthz

gh workflow run read-evidence.yml \
  -R AgentWorkforce/factory-cloud --ref main

gh workflow run read-dispatch-claims.yml \
  -R AgentWorkforce/factory-cloud --ref main \
  -f issue_repo=factory -f issue_numbers=221,390,409,413,417,427,430
```

No start-mode correction command is prescribed: the measured dispatcher is already live. No new code patch was justified by these observations beyond the existing PRs. The unresolved operational blocker is Cloud enrollment; the Factory release gap leaves known resilience and capacity improvements unavailable in production.
