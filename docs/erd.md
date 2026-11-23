# Entity Relationship Diagram

Generated from [`prisma/schema.prisma`](../prisma/schema.prisma): 16 tables, PostgreSQL 16.
GitHub renders the diagrams below. To export an image, paste a diagram into <https://mermaid.live>.

Notation: `||--o{` is one-to-many with a required parent, `|o--o{` is one-to-many with an optional parent (nullable foreign key).
`PK` primary key, `FK` foreign key, `UK` unique (alone or as part of a composite unique key).

## 1. Overview

How the content tables connect. `villages` is the centre of the model, and `sources` gives every fact its provenance.

```mermaid
erDiagram
    governorates ||--o{ local_authorities : "governorate_id"
    sources |o--o{ local_authorities : "source_id"
    governorates ||--o{ villages : "governorate_id"
    local_authorities |o--o{ villages : "local_authority_id"
    sources |o--o{ villages : "name_origin_source_id"
    villages ||--o{ village_names : "village_id"
    sources |o--o{ village_names : "source_id"
    villages ||--o{ nearby_places : "village_id"
    villages |o--o{ nearby_places : "related_village_id"
    villages ||--o{ population_records : "village_id"
    sources ||--o{ population_records : "source_id"
    villages ||--o{ historical_events : "village_id"
    sources |o--o{ historical_events : "source_id"
    villages ||--o{ landmarks : "village_id"
    sources |o--o{ landmarks : "source_id"
    villages ||--o{ heritage_items : "village_id"
    sources |o--o{ heritage_items : "source_id"
    villages ||--o{ economic_activities : "village_id"
    sources |o--o{ economic_activities : "source_id"
    villages ||--o{ facilities : "village_id"
    sources |o--o{ facilities : "source_id"
```

## 2. Content tables

All columns of the geography and village content tables.

```mermaid
erDiagram
    governorates ||--o{ local_authorities : "governorate_id"
    sources |o--o{ local_authorities : "source_id"
    governorates ||--o{ villages : "governorate_id"
    local_authorities |o--o{ villages : "local_authority_id"
    sources |o--o{ villages : "name_origin_source_id"
    villages ||--o{ village_names : "village_id"
    sources |o--o{ village_names : "source_id"
    villages ||--o{ nearby_places : "village_id"
    villages |o--o{ nearby_places : "related_village_id"
    villages ||--o{ population_records : "village_id"
    sources ||--o{ population_records : "source_id"
    villages ||--o{ historical_events : "village_id"
    sources |o--o{ historical_events : "source_id"
    villages ||--o{ landmarks : "village_id"
    sources |o--o{ landmarks : "source_id"
    villages ||--o{ heritage_items : "village_id"
    sources |o--o{ heritage_items : "source_id"
    villages ||--o{ economic_activities : "village_id"
    sources |o--o{ economic_activities : "source_id"
    villages ||--o{ facilities : "village_id"
    sources |o--o{ facilities : "source_id"
    governorates {
        uuid id PK
        text name_ar UK
        text name_en UK
        text code UK
        timestamp created_at
        timestamp updated_at
    }
    local_authorities {
        uuid id PK
        uuid governorate_id FK, UK
        text name_ar UK
        text name_en "nullable"
        LocalAuthorityType type
        uuid source_id FK "nullable"
        int as_of_year "nullable"
        timestamp created_at
        timestamp updated_at
    }
    villages {
        uuid id PK
        text slug UK
        text pcbs_code UK "nullable"
        text name_ar
        text name_en "nullable"
        uuid governorate_id FK
        uuid local_authority_id FK "nullable"
        text name_origin "nullable"
        uuid name_origin_source_id FK "nullable"
        decimal latitude "nullable"
        decimal longitude "nullable"
        int elevation_m "nullable"
        decimal area_dunums "nullable"
        text location_description "nullable"
        text historical_overview "nullable"
        text geo_display_name "nullable"
        timestamp geo_enriched_at "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    village_names {
        uuid id PK
        uuid village_id FK
        text name
        text language
        VillageNameType name_type
        int period_from "nullable"
        int period_to "nullable"
        uuid source_id FK "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    nearby_places {
        uuid id PK
        uuid village_id FK, UK
        uuid related_village_id FK "nullable"
        text place_name UK
        PlaceType place_type
        PlaceRelation relation
        decimal distance_km "nullable"
        timestamp created_at
        timestamp updated_at
    }
    sources {
        uuid id PK
        text title
        text author "nullable"
        text publisher "nullable"
        int year "nullable"
        text url "nullable"
        SourceType source_type
        text citation_text "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    population_records {
        uuid id PK
        uuid village_id FK, UK
        int population
        int reference_year UK
        timestamp reference_date "nullable"
        uuid source_id FK, UK
        boolean is_estimate
        boolean is_preferred
        boolean needs_review
        text notes "nullable"
        uuid verified_by_id FK "nullable"
        timestamp verified_at "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    historical_events {
        uuid id PK
        uuid village_id FK
        text title
        text description "nullable"
        int event_year "nullable"
        timestamp event_date "nullable"
        boolean is_approximate
        text category "nullable"
        uuid source_id FK "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    landmarks {
        uuid id PK
        uuid village_id FK
        text name_ar
        text name_en "nullable"
        LandmarkType landmark_type
        text description "nullable"
        decimal latitude "nullable"
        decimal longitude "nullable"
        uuid source_id FK "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    heritage_items {
        uuid id PK
        uuid village_id FK
        HeritageCategory category
        text name
        text description "nullable"
        uuid source_id FK "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    economic_activities {
        uuid id PK
        uuid village_id FK
        EconomicCategory category
        text name
        text description "nullable"
        boolean is_major
        uuid source_id FK "nullable"
        int as_of_year "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    facilities {
        uuid id PK
        uuid village_id FK
        FacilityType facility_type
        text name
        text description "nullable"
        decimal latitude "nullable"
        decimal longitude "nullable"
        uuid source_id FK "nullable"
        int as_of_year "nullable"
        VerificationStatus verification_status
        int version
        uuid created_by_id FK "nullable"
        uuid updated_by_id FK "nullable"
        timestamp deleted_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
```

Shared columns on content tables:

| Column | Purpose |
|---|---|
| `verification_status` | `PENDING`, `VERIFIED` or `REJECTED`; new content starts as `PENDING` |
| `version` | Optimistic locking: an update must send the version it read, otherwise `409 Conflict` |
| `deleted_at` | Soft delete; rows are hidden, not removed |
| `created_by_id`, `updated_by_id` | References to `users` (lines omitted above to keep the diagram readable) |
| `source_id` | Reference to `sources` for provenance |

`population_records` also has `verified_by_id` referencing `users`, and requires a `source_id`.
Its unique key is (`village_id`, `reference_year`, `source_id`): several sources can report the same year, and a reviewer marks one as `is_preferred`.

## 3. Users, authentication, audit and change requests

```mermaid
erDiagram
    users ||--o{ refresh_tokens : "user_id"
    users |o--o{ audit_logs : "actor_id"
    users ||--o{ change_requests : "requested_by_id"
    users |o--o{ change_requests : "reviewed_by_id"
    users {
        uuid id PK
        text email UK
        text password_hash
        text full_name
        Role role
        boolean is_active
        timestamp created_at
        timestamp updated_at
    }
    refresh_tokens {
        uuid id PK
        uuid user_id FK
        text token_hash UK
        timestamp expires_at
        timestamp revoked_at "nullable"
        timestamp created_at
        timestamp updated_at
    }
    audit_logs {
        uuid id PK
        text entity_type
        text entity_id
        AuditAction action
        uuid actor_id FK "nullable"
        jsonb before "nullable"
        jsonb after "nullable"
        text request_id "nullable"
        timestamp created_at
    }
    change_requests {
        uuid id PK
        text entity_type
        text entity_id
        int base_version
        jsonb proposed_changes
        text reason "nullable"
        ChangeRequestStatus status
        uuid requested_by_id FK
        uuid reviewed_by_id FK "nullable"
        text review_comment "nullable"
        timestamp created_at
        timestamp updated_at
        timestamp reviewed_at "nullable"
    }
```

- `refresh_tokens` stores only a SHA-256 hash of each token; rotation revokes the old row.
- `audit_logs` is append-only (no `updated_at`). `entity_type` + `entity_id` point to any table, so they are not foreign keys.
- `change_requests` uses the same polymorphic `entity_type` + `entity_id`, plus `base_version` to detect edits made in the meantime.

## Referential rules

- Every foreign key uses `ON DELETE RESTRICT`: a parent cannot be hard-deleted while rows reference it. Content is removed by soft delete instead.
- Reference tables (`governorates`, `local_authorities`) have no `deleted_at`; see [ADR 0001](adr/0001-reference-tables-read-only.md).
