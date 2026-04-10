/**
 * NextAuth.js configuration — multi-provider auth with RBAC.
 *
 * Provider selection (via environment variables):
 *   AUTH_PROVIDER=credentials  (default) — local user store, dev only
 *   AUTH_PROVIDER=ldap         — LDAP/Active Directory (requires ldapts)
 *   AUTH_PROVIDER=oidc         — OpenID Connect (any compliant IdP)
 *
 * OIDC env vars: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
 * LDAP env vars: LDAP_URL, LDAP_BIND_DN, LDAP_BIND_PW, LDAP_BASE_DN
 *
 * Session strategy: JWT (stateless).
 * Backend integration: On each login, T&T Engine health is probed and
 *   the engine's base URL is stored in the JWT for API proxying.
 */

import type { AuthOptions } from "next-auth";
import type { User } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import type { Role } from "./types";
import { findUserByUsername, verifyDevPassword } from "./users";
import { authenticateLdap } from "./ldap-auth";

// ── T&T Engine connectivity probe ─────────────────────────────────

async function probeTntEngine(): Promise<boolean> {
  const baseUrl = process.env.TNT_ENGINE_URL ?? "http://localhost:8000";
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Provider factory ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProviders(): any[] {
  const provider = process.env.AUTH_PROVIDER ?? "credentials";

  // ── OIDC provider ──────────────────────────────────────────────
  if (provider === "oidc") {
    // Lazy import to avoid loading OAuth code in credentials-only deploys
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: OAuthProvider } = require("next-auth/providers/oauth");
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) throw new Error("OIDC_ISSUER must be set when AUTH_PROVIDER=oidc");

    return [
      OAuthProvider({
        id: "oidc",
        name: process.env.OIDC_PROVIDER_NAME ?? "SSO",
        type: "oauth",
        wellKnown: `${issuer}/.well-known/openid-configuration`,
        clientId: process.env.OIDC_CLIENT_ID!,
        clientSecret: process.env.OIDC_CLIENT_SECRET!,
        authorization: { params: { scope: "openid email profile groups" } },
        idToken: true,
        checks: ["pkce", "state"],
        profile(profile: Record<string, unknown>) {
          // Map OIDC groups claim to T&T role
          const groups: string[] = (profile.groups as string[]) ?? [];
          let role: Role = "requester";
          if (groups.some((g) => /admin/i.test(g))) role = "admin";
          else if (groups.some((g) => /manager/i.test(g))) role = "manager";

          return {
            id: profile.sub as string,
            name: profile.name as string,
            email: profile.email as string,
            username: (profile.preferred_username ?? profile.email) as string,
            role,
          };
        },
      }),
    ];
  }

  // ── LDAP provider (wrapped as CredentialsProvider) ─────────────
  if (provider === "ldap") {
    return [
      CredentialsProvider({
        id: "ldap",
        name: "LDAP / Active Directory",
        credentials: {
          username: { label: "Username", type: "text" },
          password: { label: "Password", type: "password" },
        },
        async authorize(credentials) {
          if (!credentials?.username || !credentials?.password) return null;
          try {
            const user = await authenticateLdap(credentials.username, credentials.password);
            if (!user) return null;
            return {
              id: user.id,
              name: user.displayName,
              email: user.email,
              username: user.username,
              role: user.role,
            } as unknown as User;
          } catch (err) {
            console.error("[auth] LDAP error:", err);
            return null;
          }
        },
      }),
    ];
  }

  // ── Default: local credentials (dev) ──────────────────────────
  return [
    CredentialsProvider({
      id: "credentials",
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;

        const user = findUserByUsername(credentials.username);
        if (!user) return null;

        const valid = verifyDevPassword(credentials.username, credentials.password);
        if (!valid) return null;

        return {
          id: user.id,
          name: user.displayName,
          email: `${user.username}@tnt-engine.local`,
          username: user.username,
          role: user.role,
        } as unknown as User;
      },
    }),
  ];
}

// ── Auth options ───────────────────────────────────────────────────

export const authOptions: AuthOptions = {
  providers: buildProviders(),

  session: { strategy: "jwt", maxAge: 8 * 60 * 60 }, // 8 hours

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // First login — populate JWT claims
        token.id = (user as unknown as Record<string, unknown>).id as string;
        token.username = (user as unknown as Record<string, unknown>).username as string;
        token.role = (user as unknown as Record<string, unknown>).role as Role;
        token.tntEngineUrl = process.env.TNT_ENGINE_URL ?? "http://localhost:8000";

        // Probe T&T Engine at login time and record connectivity state
        token.tntEngineHealthy = await probeTntEngine();
      }
      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).id = token.id;
        (session.user as Record<string, unknown>).username = token.username;
        (session.user as Record<string, unknown>).role = token.role;
        (session.user as Record<string, unknown>).tntEngineHealthy = token.tntEngineHealthy ?? false;
      }
      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
  },

  secret: process.env.NEXTAUTH_SECRET ?? process.env.CSRF_SECRET ?? "dev-secret-change-me",
};
