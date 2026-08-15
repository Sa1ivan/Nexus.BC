CREATE INDEX "MediaImportBatch_cleanup_due_idx"
  ON "MediaImportBatch" (
    (COALESCE("cleanupLastAttemptAt", "expiresAt")),
    "id"
  )
  WHERE "attachedAt" IS NULL;

CREATE INDEX "MediaAsset_project_cleanup_due_idx"
  ON "MediaAsset" (
    (COALESCE(
      "cleanupLastAttemptAt",
      CASE
        WHEN "status" = 'PENDING'
          THEN "createdAt" + INTERVAL '24 hours'
        ELSE "deletionMarkedAt"
      END
    )),
    "id"
  )
  WHERE "projectId" IS NOT NULL
    AND "status" IN ('PENDING', 'DELETING');

CREATE INDEX "MediaAsset_import_cleanup_due_idx"
  ON "MediaAsset" (
    "workspaceId",
    "importBatchId",
    (COALESCE("cleanupLastAttemptAt", "createdAt")),
    "id"
  )
  WHERE "projectId" IS NULL;
