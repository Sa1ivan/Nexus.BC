-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "createOperationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicSlug" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "draftSchemaVersion" INTEGER NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRevision" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "siteConfig" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "scope" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "resourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("scope","operation","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_publicSlug_key" ON "Project"("publicSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_createOperationId_key" ON "Project"("workspaceId", "createOperationId");

-- CreateIndex
CREATE INDEX "Project_workspaceId_updatedAt_idx" ON "Project"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRevision_projectId_version_key" ON "ProjectRevision"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRevision_projectId_operationId_key" ON "ProjectRevision"("projectId", "operationId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_resourceId_idx" ON "IdempotencyRecord"("resourceId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRevision" ADD CONSTRAINT "ProjectRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
