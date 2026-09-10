import type { OAuthCredentials } from './types';

/** Profile ARNs identify a shared resource, not the person authorizing access. */
export function kiroAccountIdentity(credential: OAuthCredentials): string | undefined {
  const email = credential.email?.trim().toLowerCase();
  if (credential.kiro?.authType !== 'aws_sso_oidc') return email || credential.accountId;
  const profile = credential.kiro.profileArn;
  const user = credential.accountId && credential.accountId !== profile
    ? credential.accountId : undefined;
  if (user) return JSON.stringify(['sso-user', credential.kiro.ssoRegion ?? '', user]);
  if (profile && email) return JSON.stringify(['sso-profile-user', profile, email]);
  return undefined;
}
