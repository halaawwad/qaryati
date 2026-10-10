-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'REVIEWER', 'EDITOR');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "LocalAuthorityType" AS ENUM ('MUNICIPALITY', 'VILLAGE_COUNCIL', 'PROJECT_COMMITTEE');

-- CreateEnum
CREATE TYPE "VillageNameType" AS ENUM ('FORMER', 'HISTORICAL', 'ALT_SPELLING', 'TRANSLITERATION');

-- CreateEnum
CREATE TYPE "PlaceType" AS ENUM ('VILLAGE', 'CITY');

-- CreateEnum
CREATE TYPE "PlaceRelation" AS ENUM ('NEARBY', 'ADJACENT');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('CENSUS', 'BOOK', 'ARTICLE', 'GOVERNMENT', 'WEBSITE', 'ORAL', 'OTHER');

-- CreateEnum
CREATE TYPE "LandmarkType" AS ENUM ('HERITAGE_SITE', 'ARCHAEOLOGICAL', 'TRADITIONAL_BUILDING', 'SPRING', 'RELIGIOUS', 'VIEWPOINT', 'OTHER');

-- CreateEnum
CREATE TYPE "HeritageCategory" AS ENUM ('CRAFT', 'FOOD', 'AGRI_PRACTICE', 'CUSTOM', 'OTHER');

-- CreateEnum
CREATE TYPE "EconomicCategory" AS ENUM ('CROP', 'LIVESTOCK', 'CRAFT', 'INDUSTRY', 'TRADE', 'OTHER');

-- CreateEnum
CREATE TYPE "FacilityType" AS ENUM ('SCHOOL', 'CLINIC', 'LIBRARY', 'COMMUNITY_CENTER', 'PARK', 'SPORTS', 'OTHER');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'VERIFY', 'REJECT', 'APPROVE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'EDITOR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governorates" (
    "id" UUID NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governorates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local_authorities" (
    "id" UUID NOT NULL,
    "governorate_id" UUID NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "type" "LocalAuthorityType" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "local_authorities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "villages" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "governorate_id" UUID NOT NULL,
    "local_authority_id" UUID,
    "name_origin" TEXT,
    "name_origin_source_id" UUID,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "elevation_m" INTEGER,
    "area_dunums" DECIMAL,
    "location_description" TEXT,
    "historical_overview" TEXT,
    "geo_display_name" TEXT,
    "geo_enriched_at" TIMESTAMP(3),
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "villages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "village_names" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "name_type" "VillageNameType" NOT NULL,
    "period_from" INTEGER,
    "period_to" INTEGER,
    "source_id" UUID,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "village_names_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nearby_places" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "related_village_id" UUID,
    "place_name" TEXT NOT NULL,
    "place_type" "PlaceType" NOT NULL,
    "relation" "PlaceRelation" NOT NULL,
    "distance_km" DECIMAL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nearby_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "publisher" TEXT,
    "year" INTEGER,
    "url" TEXT,
    "source_type" "SourceType" NOT NULL,
    "citation_text" TEXT,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "population_records" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "population" INTEGER NOT NULL,
    "reference_year" INTEGER NOT NULL,
    "reference_date" TIMESTAMP(3),
    "source_id" UUID NOT NULL,
    "is_estimate" BOOLEAN NOT NULL DEFAULT false,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "verified_by_id" UUID,
    "verified_at" TIMESTAMP(3),
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "population_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_events" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "event_year" INTEGER,
    "event_date" TIMESTAMP(3),
    "is_approximate" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT,
    "source_id" UUID,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "historical_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "landmarks" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "landmark_type" "LandmarkType" NOT NULL,
    "description" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "source_id" UUID,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heritage_items" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "category" "HeritageCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source_id" UUID,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "heritage_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "economic_activities" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "category" "EconomicCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_major" BOOLEAN NOT NULL DEFAULT false,
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "economic_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facilities" (
    "id" UUID NOT NULL,
    "village_id" UUID NOT NULL,
    "facility_type" "FacilityType" NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "verification_status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actor_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "request_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "base_version" INTEGER NOT NULL,
    "proposed_changes" JSONB NOT NULL,
    "reason" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_id" UUID NOT NULL,
    "reviewed_by_id" UUID,
    "review_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reviewed_at" TIMESTAMP(3),

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "governorates_name_ar_key" ON "governorates"("name_ar");

-- CreateIndex
CREATE UNIQUE INDEX "governorates_name_en_key" ON "governorates"("name_en");

-- CreateIndex
CREATE UNIQUE INDEX "governorates_code_key" ON "governorates"("code");

-- CreateIndex
CREATE INDEX "local_authorities_governorate_id_idx" ON "local_authorities"("governorate_id");

-- CreateIndex
CREATE UNIQUE INDEX "local_authorities_governorate_id_name_ar_key" ON "local_authorities"("governorate_id", "name_ar");

-- CreateIndex
CREATE UNIQUE INDEX "villages_slug_key" ON "villages"("slug");

-- CreateIndex
CREATE INDEX "villages_governorate_id_idx" ON "villages"("governorate_id");

-- CreateIndex
CREATE INDEX "villages_local_authority_id_idx" ON "villages"("local_authority_id");

-- CreateIndex
CREATE INDEX "villages_name_origin_source_id_idx" ON "villages"("name_origin_source_id");

-- CreateIndex
CREATE INDEX "villages_created_by_id_idx" ON "villages"("created_by_id");

-- CreateIndex
CREATE INDEX "villages_updated_by_id_idx" ON "villages"("updated_by_id");

-- CreateIndex
CREATE INDEX "village_names_village_id_idx" ON "village_names"("village_id");

-- CreateIndex
CREATE INDEX "village_names_source_id_idx" ON "village_names"("source_id");

-- CreateIndex
CREATE INDEX "village_names_created_by_id_idx" ON "village_names"("created_by_id");

-- CreateIndex
CREATE INDEX "village_names_updated_by_id_idx" ON "village_names"("updated_by_id");

-- CreateIndex
CREATE INDEX "nearby_places_village_id_idx" ON "nearby_places"("village_id");

-- CreateIndex
CREATE INDEX "nearby_places_related_village_id_idx" ON "nearby_places"("related_village_id");

-- CreateIndex
CREATE UNIQUE INDEX "nearby_places_village_id_place_name_key" ON "nearby_places"("village_id", "place_name");

-- CreateIndex
CREATE INDEX "sources_created_by_id_idx" ON "sources"("created_by_id");

-- CreateIndex
CREATE INDEX "sources_updated_by_id_idx" ON "sources"("updated_by_id");

-- CreateIndex
CREATE INDEX "population_records_village_id_idx" ON "population_records"("village_id");

-- CreateIndex
CREATE INDEX "population_records_source_id_idx" ON "population_records"("source_id");

-- CreateIndex
CREATE INDEX "population_records_verified_by_id_idx" ON "population_records"("verified_by_id");

-- CreateIndex
CREATE INDEX "population_records_created_by_id_idx" ON "population_records"("created_by_id");

-- CreateIndex
CREATE INDEX "population_records_updated_by_id_idx" ON "population_records"("updated_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "population_records_village_id_reference_year_source_id_key" ON "population_records"("village_id", "reference_year", "source_id");

-- CreateIndex
CREATE INDEX "historical_events_village_id_idx" ON "historical_events"("village_id");

-- CreateIndex
CREATE INDEX "historical_events_source_id_idx" ON "historical_events"("source_id");

-- CreateIndex
CREATE INDEX "historical_events_created_by_id_idx" ON "historical_events"("created_by_id");

-- CreateIndex
CREATE INDEX "historical_events_updated_by_id_idx" ON "historical_events"("updated_by_id");

-- CreateIndex
CREATE INDEX "landmarks_village_id_idx" ON "landmarks"("village_id");

-- CreateIndex
CREATE INDEX "landmarks_source_id_idx" ON "landmarks"("source_id");

-- CreateIndex
CREATE INDEX "landmarks_created_by_id_idx" ON "landmarks"("created_by_id");

-- CreateIndex
CREATE INDEX "landmarks_updated_by_id_idx" ON "landmarks"("updated_by_id");

-- CreateIndex
CREATE INDEX "heritage_items_village_id_idx" ON "heritage_items"("village_id");

-- CreateIndex
CREATE INDEX "heritage_items_source_id_idx" ON "heritage_items"("source_id");

-- CreateIndex
CREATE INDEX "heritage_items_created_by_id_idx" ON "heritage_items"("created_by_id");

-- CreateIndex
CREATE INDEX "heritage_items_updated_by_id_idx" ON "heritage_items"("updated_by_id");

-- CreateIndex
CREATE INDEX "economic_activities_village_id_idx" ON "economic_activities"("village_id");

-- CreateIndex
CREATE INDEX "economic_activities_created_by_id_idx" ON "economic_activities"("created_by_id");

-- CreateIndex
CREATE INDEX "economic_activities_updated_by_id_idx" ON "economic_activities"("updated_by_id");

-- CreateIndex
CREATE INDEX "facilities_village_id_idx" ON "facilities"("village_id");

-- CreateIndex
CREATE INDEX "facilities_created_by_id_idx" ON "facilities"("created_by_id");

-- CreateIndex
CREATE INDEX "facilities_updated_by_id_idx" ON "facilities"("updated_by_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "change_requests_requested_by_id_idx" ON "change_requests"("requested_by_id");

-- CreateIndex
CREATE INDEX "change_requests_reviewed_by_id_idx" ON "change_requests"("reviewed_by_id");

-- CreateIndex
CREATE INDEX "change_requests_status_idx" ON "change_requests"("status");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local_authorities" ADD CONSTRAINT "local_authorities_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villages" ADD CONSTRAINT "villages_governorate_id_fkey" FOREIGN KEY ("governorate_id") REFERENCES "governorates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villages" ADD CONSTRAINT "villages_local_authority_id_fkey" FOREIGN KEY ("local_authority_id") REFERENCES "local_authorities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villages" ADD CONSTRAINT "villages_name_origin_source_id_fkey" FOREIGN KEY ("name_origin_source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villages" ADD CONSTRAINT "villages_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "villages" ADD CONSTRAINT "villages_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_names" ADD CONSTRAINT "village_names_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_names" ADD CONSTRAINT "village_names_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_names" ADD CONSTRAINT "village_names_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "village_names" ADD CONSTRAINT "village_names_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nearby_places" ADD CONSTRAINT "nearby_places_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nearby_places" ADD CONSTRAINT "nearby_places_related_village_id_fkey" FOREIGN KEY ("related_village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "population_records" ADD CONSTRAINT "population_records_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "population_records" ADD CONSTRAINT "population_records_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "population_records" ADD CONSTRAINT "population_records_verified_by_id_fkey" FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "population_records" ADD CONSTRAINT "population_records_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "population_records" ADD CONSTRAINT "population_records_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_events" ADD CONSTRAINT "historical_events_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_events" ADD CONSTRAINT "historical_events_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_events" ADD CONSTRAINT "historical_events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_events" ADD CONSTRAINT "historical_events_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landmarks" ADD CONSTRAINT "landmarks_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landmarks" ADD CONSTRAINT "landmarks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landmarks" ADD CONSTRAINT "landmarks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "landmarks" ADD CONSTRAINT "landmarks_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heritage_items" ADD CONSTRAINT "heritage_items_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heritage_items" ADD CONSTRAINT "heritage_items_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heritage_items" ADD CONSTRAINT "heritage_items_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "heritage_items" ADD CONSTRAINT "heritage_items_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economic_activities" ADD CONSTRAINT "economic_activities_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economic_activities" ADD CONSTRAINT "economic_activities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economic_activities" ADD CONSTRAINT "economic_activities_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_village_id_fkey" FOREIGN KEY ("village_id") REFERENCES "villages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain checks that Prisma cannot express directly.
ALTER TABLE "population_records"
  ADD CONSTRAINT "population_records_population_positive_check" CHECK ("population" > 0),
  ADD CONSTRAINT "population_records_reference_year_range_check" CHECK ("reference_year" BETWEEN 1800 AND 2100);

ALTER TABLE "villages"
  ADD CONSTRAINT "villages_latitude_range_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "villages_longitude_range_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);

ALTER TABLE "landmarks"
  ADD CONSTRAINT "landmarks_latitude_range_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "landmarks_longitude_range_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);

ALTER TABLE "facilities"
  ADD CONSTRAINT "facilities_latitude_range_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
  ADD CONSTRAINT "facilities_longitude_range_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);

ALTER TABLE "nearby_places"
  ADD CONSTRAINT "nearby_places_not_self_check" CHECK ("related_village_id" IS NULL OR "village_id" <> "related_village_id");

CREATE UNIQUE INDEX "population_records_one_preferred_per_year_idx"
  ON "population_records"("village_id", "reference_year")
  WHERE "is_preferred" = true;

CREATE UNIQUE INDEX "nearby_places_unique_village_pair_idx"
  ON "nearby_places"(LEAST("village_id", "related_village_id"), GREATEST("village_id", "related_village_id"))
  WHERE "related_village_id" IS NOT NULL;
