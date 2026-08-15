export const SITE_CONFIG_ROLLOUT_READINESS = 'SITE_CONFIG_ROLLOUT_READINESS';

export interface SiteConfigRolloutReadiness {
  isReady(): Promise<boolean>;
}
