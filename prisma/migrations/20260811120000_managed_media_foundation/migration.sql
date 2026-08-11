-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING', 'READY', 'DELETING');

-- Protect composite media ownership.
CREATE UNIQUE INDEX "Project_workspaceId_id_key" ON "Project"("workspaceId", "id");

-- CreateTable
CREATE TABLE "MediaImportBatch" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "attachedProjectId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attachedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaImportBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MediaImportBatch_attachment_state_check"
        CHECK (("attachedAt" IS NULL) = ("attachedProjectId" IS NULL)),
    CONSTRAINT "MediaImportBatch_expiry_check"
        CHECK ("expiresAt" = "createdAt" + INTERVAL '24 hours')
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID,
    "importBatchId" UUID,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING',
    "objectKey" VARCHAR(1024) NOT NULL,
    "declaredFileName" VARCHAR(256) NOT NULL,
    "declaredMimeType" VARCHAR(64) NOT NULL,
    "declaredSizeBytes" INTEGER NOT NULL,
    "declaredChecksumSha256" VARCHAR(64) NOT NULL,
    "verifiedMimeType" VARCHAR(64),
    "verifiedSizeBytes" INTEGER,
    "verifiedWidth" INTEGER,
    "verifiedHeight" INTEGER,
    "verifiedChecksumSha256" VARCHAR(64),
    "verifiedAt" TIMESTAMP(3),
    "deletionMarkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MediaAsset_owner_check"
        CHECK ("projectId" IS NOT NULL OR "importBatchId" IS NOT NULL),
    CONSTRAINT "MediaAsset_object_key_check"
        CHECK (btrim("objectKey") <> ''),
    CONSTRAINT "MediaAsset_declared_file_name_check"
        CHECK (btrim("declaredFileName") <> ''),
    CONSTRAINT "MediaAsset_declared_mime_check"
        CHECK ("declaredMimeType" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "MediaAsset_declared_size_check"
        CHECK ("declaredSizeBytes" BETWEEN 1 AND 10485760),
    CONSTRAINT "MediaAsset_declared_checksum_check"
        CHECK ("declaredChecksumSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "MediaAsset_verified_mime_check"
        CHECK ("verifiedMimeType" IS NULL OR "verifiedMimeType" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "MediaAsset_verified_size_check"
        CHECK ("verifiedSizeBytes" IS NULL OR "verifiedSizeBytes" BETWEEN 1 AND 10485760),
    CONSTRAINT "MediaAsset_verified_dimensions_check"
        CHECK (
            ("verifiedWidth" IS NULL AND "verifiedHeight" IS NULL)
            OR (
                "verifiedWidth" BETWEEN 1 AND 12000
                AND "verifiedHeight" BETWEEN 1 AND 12000
                AND "verifiedWidth"::BIGINT * "verifiedHeight"::BIGINT <= 40000000
            )
        ),
    CONSTRAINT "MediaAsset_verified_checksum_check"
        CHECK ("verifiedChecksumSha256" IS NULL OR "verifiedChecksumSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "MediaAsset_verified_matches_declared_check"
        CHECK (
            "verifiedMimeType" IS NULL
            OR (
                "verifiedMimeType" = "declaredMimeType"
                AND "verifiedSizeBytes" = "declaredSizeBytes"
                AND "verifiedChecksumSha256" = "declaredChecksumSha256"
            )
        ),
    CONSTRAINT "MediaAsset_status_state_check"
        CHECK (
            (
                "status" = 'PENDING'
                AND "verifiedMimeType" IS NULL
                AND "verifiedSizeBytes" IS NULL
                AND "verifiedWidth" IS NULL
                AND "verifiedHeight" IS NULL
                AND "verifiedChecksumSha256" IS NULL
                AND "verifiedAt" IS NULL
                AND "deletionMarkedAt" IS NULL
            )
            OR (
                "status" = 'READY'
                AND "verifiedMimeType" IS NOT NULL
                AND "verifiedSizeBytes" IS NOT NULL
                AND "verifiedWidth" IS NOT NULL
                AND "verifiedHeight" IS NOT NULL
                AND "verifiedChecksumSha256" IS NOT NULL
                AND "verifiedAt" IS NOT NULL
                AND "deletionMarkedAt" IS NULL
            )
            OR (
                "status" = 'DELETING'
                AND "verifiedMimeType" IS NOT NULL
                AND "verifiedSizeBytes" IS NOT NULL
                AND "verifiedWidth" IS NOT NULL
                AND "verifiedHeight" IS NOT NULL
                AND "verifiedChecksumSha256" IS NOT NULL
                AND "verifiedAt" IS NOT NULL
                AND "deletionMarkedAt" IS NOT NULL
            )
        )
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaImportBatch_workspaceId_id_key" ON "MediaImportBatch"("workspaceId", "id");
CREATE INDEX "MediaImportBatch_workspaceId_expiresAt_idx" ON "MediaImportBatch"("workspaceId", "expiresAt");
CREATE INDEX "MediaImportBatch_attachedProjectId_idx" ON "MediaImportBatch"("attachedProjectId");

CREATE UNIQUE INDEX "MediaAsset_objectKey_key" ON "MediaAsset"("objectKey");
CREATE UNIQUE INDEX "MediaAsset_workspaceId_id_key" ON "MediaAsset"("workspaceId", "id");
CREATE INDEX "MediaAsset_workspaceId_projectId_createdAt_idx" ON "MediaAsset"("workspaceId", "projectId", "createdAt");
CREATE INDEX "MediaAsset_workspaceId_importBatchId_idx" ON "MediaAsset"("workspaceId", "importBatchId");
CREATE INDEX "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "MediaImportBatch"
    ADD CONSTRAINT "MediaImportBatch_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MediaImportBatch"
    ADD CONSTRAINT "MediaImportBatch_workspaceId_attachedProjectId_fkey"
    FOREIGN KEY ("workspaceId", "attachedProjectId")
    REFERENCES "Project"("workspaceId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MediaAsset"
    ADD CONSTRAINT "MediaAsset_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MediaAsset"
    ADD CONSTRAINT "MediaAsset_workspaceId_projectId_fkey"
    FOREIGN KEY ("workspaceId", "projectId")
    REFERENCES "Project"("workspaceId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MediaAsset"
    ADD CONSTRAINT "MediaAsset_workspaceId_importBatchId_fkey"
    FOREIGN KEY ("workspaceId", "importBatchId")
    REFERENCES "MediaImportBatch"("workspaceId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
