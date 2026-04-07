/**
 * LDAP authentication helper for T&T Control Plane.
 *
 * Performs a bind-then-search against an LDAP/Active Directory server.
 * Reads configuration from environment variables:
 *
 *   LDAP_URL          ldap://or ldaps:// server URI (e.g. ldap://ldap.corp.example.com:389)
 *   LDAP_BIND_DN      Service account DN for initial bind
 *   LDAP_BIND_PW      Service account password
 *   LDAP_BASE_DN      Base DN to search for users (e.g. ou=Users,dc=corp,dc=example,dc=com)
 *   LDAP_USERNAME_ATTR  Attribute that holds the username (default: sAMAccountName for AD, uid for OpenLDAP)
 *   LDAP_ROLE_ATTR    Attribute that holds the role (default: description)
 *   LDAP_ADMIN_GROUP  Group CN for admins    (e.g. CNTnt-Admins)
 *   LDAP_OPERATOR_GROUP  Group CN for operators
 *
 * Requires the `ldapts` package. Install: npm install ldapts
 * If ldapts is not available, throws a clear error.
 */

import type { Role } from "./types";

export interface LdapUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  role: Role;
}

function getLdapConfig() {
  return {
    url: process.env.LDAP_URL ?? "",
    bindDN: process.env.LDAP_BIND_DN ?? "",
    bindPW: process.env.LDAP_BIND_PW ?? "",
    baseDN: process.env.LDAP_BASE_DN ?? "",
    usernameAttr: process.env.LDAP_USERNAME_ATTR ?? "uid",
    roleAttr: process.env.LDAP_ROLE_ATTR ?? "description",
    adminGroup: process.env.LDAP_ADMIN_GROUP ?? "tnt-admins",
    operatorGroup: process.env.LDAP_OPERATOR_GROUP ?? "tnt-operators",
  };
}

function resolveRoleFromGroups(memberOf: string[] | undefined, cfg: ReturnType<typeof getLdapConfig>): Role {
  if (!memberOf || memberOf.length === 0) return "viewer";
  const groups = memberOf.map((g) => g.toLowerCase());
  if (groups.some((g) => g.includes(cfg.adminGroup.toLowerCase()))) return "admin";
  if (groups.some((g) => g.includes(cfg.operatorGroup.toLowerCase()))) return "operator";
  return "viewer";
}

export async function authenticateLdap(username: string, password: string): Promise<LdapUser | null> {
  const cfg = getLdapConfig();
  if (!cfg.url) throw new Error("LDAP_URL not configured");

  let Client: typeof import("ldapts").Client;
  try {
    ({ Client } = await import("ldapts"));
  } catch {
    throw new Error(
      "ldapts package not installed. Run: npm install ldapts\n" +
      "Set AUTH_PROVIDER=ldap in environment to use LDAP authentication."
    );
  }

  const client = new Client({ url: cfg.url, tlsOptions: { rejectUnauthorized: false } });

  try {
    // Step 1: Bind with service account to search for user
    await client.bind(cfg.bindDN, cfg.bindPW);

    const filter = `(${cfg.usernameAttr}=${username})`;
    const { searchEntries } = await client.search(cfg.baseDN, {
      scope: "sub",
      filter,
      attributes: ["dn", "cn", "mail", "memberOf", cfg.usernameAttr, "displayName"],
    });

    if (!searchEntries || searchEntries.length === 0) return null;
    const entry = searchEntries[0];

    // Step 2: Bind as the found user to verify password
    const userDN = entry.dn as string;
    try {
      await client.bind(userDN, password);
    } catch {
      return null; // Wrong password
    }

    const memberOf = Array.isArray(entry.memberOf)
      ? (entry.memberOf as string[])
      : entry.memberOf
      ? [entry.memberOf as string]
      : [];

    const role = resolveRoleFromGroups(memberOf, cfg);
    const mail = (entry.mail as string) ?? `${username}@ldap.local`;
    const displayName = (entry.displayName as string) ?? (entry.cn as string) ?? username;

    return {
      id: `ldap_${username}`,
      username,
      displayName,
      email: mail,
      role,
    };
  } finally {
    await client.unbind();
  }
}
