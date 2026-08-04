CREATE TABLE "AuditSequence" (
    "id" INTEGER NOT NULL,
    "nextValue" BIGINT NOT NULL,

    CONSTRAINT "AuditSequence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditSequence_singleton_check" CHECK ("id" = 1),
    CONSTRAINT "AuditSequence_positive_check" CHECK ("nextValue" > 0)
);

INSERT INTO "AuditSequence" ("id", "nextValue") VALUES (1, 1);

CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "workspaceId" UUID,
    "actorUserId" UUID,
    "action" VARCHAR(128) NOT NULL,
    "resourceType" VARCHAR(64) NOT NULL,
    "resourceId" VARCHAR(128) NOT NULL,
    "metadata" JSONB NOT NULL,
    "requestId" VARCHAR(128) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuditEvent_eventId_key" ON "AuditEvent"("eventId");
CREATE UNIQUE INDEX "AuditEvent_sequence_key" ON "AuditEvent"("sequence");
CREATE INDEX "AuditEvent_workspaceId_occurredAt_idx"
    ON "AuditEvent"("workspaceId", "occurredAt");
CREATE INDEX "AuditEvent_resourceType_resourceId_occurredAt_idx"
    ON "AuditEvent"("resourceType", "resourceId", "occurredAt");

CREATE FUNCTION reject_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'AuditEvent is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "AuditEvent_reject_row_mutation"
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW
EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TRIGGER "AuditEvent_reject_truncate"
BEFORE TRUNCATE ON "AuditEvent"
FOR EACH STATEMENT
EXECUTE FUNCTION reject_audit_event_mutation();

CREATE FUNCTION require_audit_writer()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('nexus.audit_writer', true) IS DISTINCT FROM 'enabled' THEN
        RAISE EXCEPTION 'Audit storage is writable only through AuditWriter'
            USING ERRCODE = '42501';
    END IF;

    IF TG_LEVEL = 'STATEMENT' THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditEvent_require_writer_insert"
BEFORE INSERT ON "AuditEvent"
FOR EACH ROW
EXECUTE FUNCTION require_audit_writer();

CREATE TRIGGER "AuditSequence_require_writer_row"
BEFORE INSERT OR UPDATE OR DELETE ON "AuditSequence"
FOR EACH ROW
EXECUTE FUNCTION require_audit_writer();

CREATE TRIGGER "AuditSequence_require_writer_truncate"
BEFORE TRUNCATE ON "AuditSequence"
FOR EACH STATEMENT
EXECUTE FUNCTION require_audit_writer();
