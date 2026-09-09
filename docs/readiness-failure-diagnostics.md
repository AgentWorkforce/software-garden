# Readiness sweep failure diagnostics

`readinessReconcile.lastError` on authenticated status/heartbeat records retains
the actual error message. Public health generates its own `lastError` from
allowlisted fields; it never copies that private message. For example:

```json
{
  "consecutiveFailures": 8,
  "lastError": "Sweep failed during discovery-lease-claim (Error; cause: StateStoreUnavailableError); details: /evidence",
  "lastErrorClass": "Error",
  "lastErrorPhase": "discovery-lease-claim",
  "lastErrorCauseClass": "StateStoreUnavailableError"
}
```

The phase identifies the sweep operation that failed. The cause class comes from
a bounded traversal through contextual error wrappers. It is the deepest retained
class, not a claim that the remote service's root cause has been diagnosed.
`run-once` covers the candidate processing portion of discovery; the authenticated
message and logs give details within that phase. Caller deadline expiry is
`readiness-deadline`. Unknown phases collapse to `unknown`.

Older records with a positive failure count and no error details now publish
`Sweep failed during unknown (Error); details: /evidence`. This communicates the
missing detail without inventing a cause. Normalization reconstructs the public
text instead of trusting a remote `lastError` string.

Startup backfill and periodic reconciliation now share failure recording. A
failed first sweep records its cause and increments the failure count before the
first periodic timer, while leaving `lastCompletedAtMs` absent. A successful pass
clears the message, class, phase, cause class, and consecutive failure count.

## Evidence

The periodic catch already retained the error privately; the public projection
removed the message and exposed only the outer class (`Error` for contextual
wrappers). The startup catch recorded failure timestamps but omitted the cause
and readiness failure accounting.

Authenticated factory-cloud evidence run `34340860342` captured a sweep starting
at 10:33:06.872Z on 2026-09-09 and failing at 10:33:08.785Z (reported duration
1914 ms). The recorded message names a database-overload response during the
dispatch availability check. The later heartbeat reports three sweep failures
while the circuit is closed with zero consecutive failures. Current circuit
state therefore does not explain a previously failed sweep; read the cause
recorded at `lastFailureAtMs`.

This capture does not attribute the earlier reported 12390 ms failure, and this
change does not alter dispatch slot ownership or retry behavior. The regression
uses a failing state store with a healthy fleet to verify startup failure,
eight consecutive failures with no successful completion, heartbeat/public
publication, and recovery. Assertions inspect published signals, not elapsed time.
