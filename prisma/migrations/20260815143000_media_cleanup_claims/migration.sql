ALTER TABLE "MediaImportBatch"
  ADD COLUMN "cleanupStartedAt" TIMESTAMP(3),
  ADD CONSTRAINT "MediaImportBatch_cleanup_state_check"
    CHECK (
      "cleanupStartedAt" IS NULL
      OR ("attachedAt" IS NULL AND "attachedProjectId" IS NULL)
    );

ALTER TABLE "MediaAsset"
  ADD COLUMN "cleanupStartedAt" TIMESTAMP(3),
  ADD CONSTRAINT "MediaAsset_cleanup_claim_check"
    CHECK ("cleanupStartedAt" IS NULL OR "deletionMarkedAt" IS NULL);
