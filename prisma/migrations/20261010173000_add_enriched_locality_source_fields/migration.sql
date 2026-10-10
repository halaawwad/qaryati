-- AlterTable
ALTER TABLE "local_authorities" ADD COLUMN "source_id" UUID,
ADD COLUMN "as_of_year" INTEGER;

-- AlterTable
ALTER TABLE "economic_activities" ADD COLUMN "source_id" UUID,
ADD COLUMN "as_of_year" INTEGER;

-- AlterTable
ALTER TABLE "facilities" ADD COLUMN "description" TEXT,
ADD COLUMN "source_id" UUID,
ADD COLUMN "as_of_year" INTEGER;

-- CreateIndex
CREATE INDEX "local_authorities_source_id_idx" ON "local_authorities"("source_id");

-- CreateIndex
CREATE INDEX "economic_activities_source_id_idx" ON "economic_activities"("source_id");

-- CreateIndex
CREATE INDEX "facilities_source_id_idx" ON "facilities"("source_id");

-- AddForeignKey
ALTER TABLE "local_authorities" ADD CONSTRAINT "local_authorities_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "economic_activities" ADD CONSTRAINT "economic_activities_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
