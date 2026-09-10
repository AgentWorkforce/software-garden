# PR probe record reads

`health.prProbe` reports cumulative counters for this daemon, including probes
from completion maintenance outside the discovery sweep. Compare samples from
the same `heartbeat.startedAtMs`; a restart resets them. These are not the last
sweep's counters.

| Field | Meaning |
| --- | --- |
| `recordReads` | PR resolver record-read attempts issued to the mount |
| `recordCacheHits` | Record visits served from the current watermark's cache |
| `recordCacheEntries` / `recordCacheLimit` | Current retained records and the 4096-entry bound |
| `invalidations` | Cached generations discarded after a watermark change, loss of watermark support, PR file events, or completion |
| `evictions` | Entries removed to keep the cache bounded |
| `uncachedProbes` | Probes for which no usable event watermark was available |

The pull index carries branch and title association, but cannot answer body-only
matches. An `index-no-match` fallback therefore reads historical PR records. A
negative result never entered the existing successful-resolution cache, so
repeated probes paid for the same history again. For P records and Q such probes,
that was P × Q remote record reads even on an unchanged mount.

Discovery reaches this loop through dependency resolution
(`performRunOnce` → `triageIssue`/dispatch dependency checks →
`dependencyIsTerminalOrMerged` → `resolveIssuePrFromMount`), and through orphan
recovery (`reconcileOrphanedGithubInProgress` → `openCompletionPr`). The
dependency-result memo introduced in #498 retains unresolved verdicts for up to
30 minutes, invalidating on PR events or changed association inputs. Record reuse
serves probes after that memo expires, distinct dependencies, and orphan recovery
while preserving the existing verdict invalidation rules.

Successful record reads now share a bounded cache keyed by the mount's GitHub
event high watermark. The index and trees are still read on each resolution. A changed
or unavailable watermark discards the cache; missing and failed record reads are
never retained. Index winners still receive a fresh confirming record read.
PR file events invalidate records even when the watermark is unchanged.
Completion also invalidates records to preserve its existing explicit refresh
boundary. This layer caches records; #498 separately caches negative dependency
answers. In a stable watermark, Q
fallback probes over P records that fit the cache issue P record reads, while
still evaluating each query against all P records.

Watermark validation is optional and waits at most two seconds. If a validation
call hangs, probes use fresh record reads until it settles; they retain at most
one pending validation call rather than accumulating more transports. A discarded
generation is cleared immediately, and old readers cannot repopulate it.

## Evidence and limits

The authenticated capture in factory-cloud Actions run `34336895871` on
2026-09-09 shows a 282-entry PR walk: 24 records at 15,067 ms, 161 at 91,122 ms,
and 271 at 152,575 ms. Another walk of the same size begins less than three
minutes after the first began. The `index-no-match` log identifies the fallback.
This demonstrates cost proportional to historical records and repeated probes.

The later capture `34338930654` caught a **212,506 ms discovery sweep**. Inside
it, a dependency PR probe visits 161 records: 80 at 45,972 ms, 133 at 76,159 ms,
and 159 at 91,286 ms. At 10:11:06.482Z the sweep records that work unit as
`parked-dependency` and proceeds to the next candidate. This ties roughly 92
seconds of record enumeration to an actual slow sweep, independently of the
concurrent 282-entry completion probe. It is a different dependency from the
previously resolved dependency-walk incident. Subsequent dispatch attempts also
fail fleet admission; the trace does not assign the entire 212 seconds to PR I/O.

This does **not** demonstrate monotonic process-age degradation. The earlier
capture `34320643216` records sweep durations of 91,556, 74,542, 20,005, and
87,466 ms, with 45 candidate paths in the enumerating passes. Those passes also
record fleet-admission failures. The initial 282-entry PR walks occur during
completion maintenance, so their cost must not be assigned to a discovery
duration merely because they overlap. Attribution of the originally reported
188,487 ms sweep remains unconfirmed; the later 212,506 ms sweep has the direct
dependency-probe evidence above.

The deterministic regression runs six negative probes over 282 records with and
without caching: 282 versus 1692 record reads. Advancing the watermark rereads
the records and finds a newly added body-only association. Assertions use
published counters and resolution results, never elapsed time. Active event
streams invalidate reuse, and corpora larger than the cache can incur evictions;
the counters expose both limits.

The sweep regressions also exercise the production callers: three sweeps parked
on an unresolved dependency, each after the 30-minute verdict expiry, read 161
records with caching versus 483 without,
and both arms dispatch after the watermark advances to expose a merged PR. Two
orphan candidates in one sweep read 282 records with caching versus 564 without,
with identical recovered and dispatched work.

The 2026-09-10 sibling-lane measurement reports repeated `index-no-match` walks
over 84 records, with 69–71 reads taking 45–47 seconds. That sample does not
demonstrate the historical 1,493-path walk or establish PR I/O as the cause of
the sandbox-enrollment failures. Record reuse reduces repeated read latency;
those enrollment failures remain the primary dispatch blocker.
