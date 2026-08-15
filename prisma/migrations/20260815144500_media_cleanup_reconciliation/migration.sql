ALTER TABLE "MediaImportBatch"
  ADD COLUMN "cleanupLastAttemptAt" TIMESTAMP(3);

ALTER TABLE "MediaAsset"
  ADD COLUMN "cleanupLastAttemptAt" TIMESTAMP(3),
  DROP CONSTRAINT "MediaAsset_cleanup_claim_check",
  ADD CONSTRAINT "MediaAsset_cleanup_claim_check"
    CHECK (
      "cleanupStartedAt" IS NULL
      OR "status" IN ('PENDING', 'DELETING')
    );
