CREATE TABLE "SiteConfigRolloutState" (
  "key" VARCHAR(32) NOT NULL,
  "v5ActivatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SiteConfigRolloutState_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "SiteConfigRolloutState_singleton_check"
    CHECK ("key" = 'site-config')
);

CREATE FUNCTION "deny_site_config_rollout_state_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SiteConfigRolloutState is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "SiteConfigRolloutState_immutable_rows"
BEFORE UPDATE OR DELETE ON "SiteConfigRolloutState"
FOR EACH ROW
EXECUTE FUNCTION "deny_site_config_rollout_state_mutation"();

CREATE TRIGGER "SiteConfigRolloutState_no_truncate"
BEFORE TRUNCATE ON "SiteConfigRolloutState"
FOR EACH STATEMENT
EXECUTE FUNCTION "deny_site_config_rollout_state_mutation"();
