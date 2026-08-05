-- CreateEnum
CREATE TYPE "OutboxDeliveryState" AS ENUM ('READY', 'SENDING', 'UNKNOWN', 'DELIVERED', 'DEAD_LETTER', 'CANCELLED');

-- CreateTable
CREATE TABLE "Outbox" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "businessIdempotencyKey" VARCHAR(256) NOT NULL,
    "kind" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "secretCiphertext" BYTEA,
    "secretExpiresAt" TIMESTAMP(3),
    "secretRedactedAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "state" "OutboxDeliveryState" NOT NULL DEFAULT 'READY',
    "lockedUntil" TIMESTAMP(3),
    "lockedBy" TEXT,
    "claimToken" UUID,
    "attemptOrdinal" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 10,
    "deliveredAt" TIMESTAMP(3),
    "deadLetterAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "providerMessageId" VARCHAR(128),
    "providerOutcomeCode" VARCHAR(64),
    "providerOutcomeObservedAt" TIMESTAMP(3),
    "providerIdempotencyExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_eventId_key" ON "Outbox"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_businessIdempotencyKey_key" ON "Outbox"("businessIdempotencyKey");

-- CreateIndex
CREATE INDEX "Outbox_deliveredAt_deadLetterAt_availableAt_lockedUntil_idx" ON "Outbox"("deliveredAt", "deadLetterAt", "availableAt", "lockedUntil");
