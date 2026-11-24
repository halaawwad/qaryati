# ADR-0005: Reviewed village geo enrichment through a replaceable provider

Status: Proposed for local review (November 2026).

## Context

Requirements #24/#25 need external geographic lookup and controlled application to
existing villages. Nearby Villages already computes distances from stored coordinates.
The schema already has coordinates, geoDisplayName and geoEnrichedAt. No existing
applyGeoEnrichment function or village-response cache exists on this branch.

## Decision

Keep routes → controller → service → repository. Add focused geo service/repository
files inside Villages without replacing its public reads or Haversine SQL. Services
orchestrate AuditService using the same Prisma transaction as the village update.

GeoProvider accepts stored Arabic/English identity, governorate and country context
and returns normalized candidates. Nominatim is the initial provider because it offers
structured OSM address/name data and a documented Search API. It is not a source of
automatic truth. English names support candidate comparison; the primary query uses
the stored Arabic name and governorate, with English fallback. There is no arbitrary
query endpoint, autocomplete, bulk processing, scheduled task or automatic enrichment.

Use native fetch and an Undici dispatcher to validate the DNS answers actually used
by the socket. Only HTTPS /search endpoints on DNS hostnames are configured. Credentials,
query fragments, custom ports, IP literals, local/reserved addresses and redirects are
rejected. Runtime schemas bound the body (128 KiB), candidates (5), strings and coordinates.
Country codes must match ps. Usable governorate details must match stored names after
conservative normalization. Territory-level state names are not treated as governorates.
Name/governorate match flags describe exact comparisons; no confidence score is invented.

Fetch and body reading share a configurable AbortController timeout (default 5 seconds).
Retry at most twice, with 250/500 ms backoff, for network failures, timeouts and HTTP
500/502/503/504. Every attempt acquires its own global permit. Other HTTP failures and
malformed data are not retried. HTTP 429 installs a shared cooldown from Retry-After
(seconds or HTTP date, default 60 seconds) and returns a controlled 503 without retry.

Opossum monitors transient attempts in a 60-second window, with minimum volume 5,
default 50% error threshold and 30-second open interval. One half-open probe determines
recovery. Breaker state is local to each process; rate coordination and cooldown are shared.
Timeout is owned by the abortable transport, not a second breaker timer that could leave
an orphaned request. Errors expose controlled messages, never upstream response bodies.

All replicas share a fixed Redis mutex and cooldown namespace. Acquisition/release use
Lua atomically. The mutex has no lease expiry: process stalls cannot allow another worker
to overtake an active request. Completion installs a minimum 1-second cooldown, so starts
are at least a second apart even with retries. Waiting is bounded to 5 seconds, after
which the caller gets 503. No process-local fallback exists during Redis failure.

An operator activation key is required; a blank/rebuilt Redis cannot start geocoding.
This trades availability for provider-policy compliance. Use one durable Redis primary,
no automatic failover/state rollback, no key eviction, and a shared database/key namespace
across replicas. A crashed worker leaves a lock requiring the stop-and-recover procedure
in the runbook. These infrastructure requirements are part of the guarantee, not an
assertion that Redis asynchronous failover provides a linearizable lock.

Normalized, provider/configuration-namespaced SHA-256 cache keys have a default 30-day
positive TTL and 5-minute negative TTL. Equivalent whitespace/case searches share cache.
Invalid/transient responses are not cached. Redis failure fails closed before upstream work.
Geo-specific Redis commands have a 2-second deadline. Late commands are never used to
start provider work; a late lock acquisition can require the same stale-lock recovery.
Independent concurrent cache misses can repeat a lookup, but remain globally rate limited.

Only ADMIN/REVIEWER may look up or apply. A lookup returns no_match, candidates_found or
ambiguous and a random, server-stored reference per candidate, valid for 15 minutes by
default. References bind coordinates to village identity and version, and cannot be
replaced by client coordinates. Manual confirmation is mandatory even for one candidate.
Any existing coordinate, including zero, additionally requires overwriteExisting=true.

Apply locks the active village FOR UPDATE, checks current version, identity and token
expiry, updates only geo fields/updater/version/timestamp, and audits before/after plus
provider reference, actor and request ID in the transaction. PostgreSQL-rounded values
are returned and audited. Replay loses the version check. Audit failure rolls back the
update. VerificationStatus is preserved: a reviewed geographic correction is not an
automatic verification of every village attribute. No Source is fabricated; provider
provenance belongs to this geo audit. A dedicated geo verification/source model would
require a separate team decision. No schema or migration changes are needed.

## Trade-offs and replacement

The country restriction can omit disputed or historically Palestinian locations classified
differently by OSM. Conservative governorate matching can reject transliteration variants.
Return no match rather than broaden geography silently. Human review is still necessary;
an exact name match is not proof of correctness. Review policy for other country contexts
must be explicit before changing the current ps scope.

An apply-time reference can originate from a 30-day cached result; its 15-minute lifetime
means recent selection, not necessarily a fresh upstream fetch. Cache TTL is configurable.
Candidate data and provenance are preserved in Redis/audit, not new schema columns.

Switch compatible Nominatim hosts through configuration (public HTTPS DNS endpoints only).
For another API, implement GeoProvider and replace composition in integrations/geo/index.ts;
the Village domain remains unchanged. Coordinate services hosted on private networks need
a separately reviewed transport policy, not a blanket SSRF exception.

Clients must display OpenStreetMap attribution and comply with ODbL. Public-service usage
is limited to moderate, user-triggered individual village review. There are no guarantees
of upstream availability, coverage or correctness.

## References

- [Nominatim Search API](https://nominatim.org/release-docs/latest/api/Search/)
- [Public Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/)
- [OSM attribution and licensing](https://www.openstreetmap.org/copyright)
- [Opossum](https://nodeshift.dev/opossum/)
- [ADR-0003](0003-modular-monolith.md)
