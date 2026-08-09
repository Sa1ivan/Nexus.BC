-- CreateTable
CREATE TABLE "Release" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "siteConfig" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActiveRelease" (
    "projectId" UUID NOT NULL,
    "releaseId" UUID NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActiveRelease_pkey" PRIMARY KEY ("projectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Release_projectId_id_key" ON "Release"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Release_projectId_version_key" ON "Release"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Release_projectId_operationId_key" ON "Release"("projectId", "operationId");

-- CreateIndex
CREATE INDEX "ActiveRelease_releaseId_idx" ON "ActiveRelease"("releaseId");

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveRelease" ADD CONSTRAINT "ActiveRelease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveRelease" ADD CONSTRAINT "ActiveRelease_projectId_releaseId_fkey" FOREIGN KEY ("projectId", "releaseId") REFERENCES "Release"("projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
