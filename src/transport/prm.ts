export interface PrmConfig {
  resource: string;
  issuer: string;
  scopes: string[];
}

export function buildProtectedResourceMetadata(cfg: PrmConfig): Record<string, unknown> {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    scopes_supported: cfg.scopes,
    bearer_methods_supported: ['header'],
  };
}
