# Database

## Tables

- `users`: application accounts and roles.
- `refresh_tokens`: hashed refresh tokens for user sessions.
- `governorates`: Palestinian governorates.
- `local_authorities`: municipalities, village councils, and project committees.
- `villages`: core village profile and geography.
- `village_names`: alternate, former, historical, and transliterated names.
- `nearby_places`: nearby cities or villages for a village.
- `sources`: provenance records for content.
- `population_records`: sourced population values by year or date.
- `historical_events`: sourced historical notes and events.
- `landmarks`: heritage, archaeological, religious, and other landmarks.
- `heritage_items`: crafts, foods, customs, and other heritage entries.
- `economic_activities`: agriculture, trade, craft, and other activities.
- `facilities`: schools, clinics, parks, and community facilities.
- `audit_logs`: append-only record of entity changes.
- `change_requests`: proposed edits and review decisions.

## Notes

Content tables use `deleted_at` for soft delete, so rows can be hidden without losing history.
The `version` field supports optimistic editing and change review against a known base version.
The `verification_status` field tracks whether content is pending, verified, or rejected.
Rows with a `source_id` point to `sources` so imported and future content can keep provenance.
Village-to-village rows in `nearby_places` are stored once per pair by a unique expression index.
`audit_logs` is append-only and has `created_at` but no `updated_at`.
`as_of_year` means this fact was true as of that year.
Local authority, economic activity, and facility rows now carry a source.
Facility rows support a description.

## Data Policy

Seed data must be real and source-backed.
Empty data means it has not been verified yet.
PCBS 2021 population values are mid-year projections, not census counts.
Synthetic data may only be used later in a separate load-test script and must never be part of the normal seed.
