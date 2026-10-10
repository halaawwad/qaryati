-- AlterTable
ALTER TABLE "villages" ADD COLUMN "pcbs_code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "villages_pcbs_code_key" ON "villages"("pcbs_code");
