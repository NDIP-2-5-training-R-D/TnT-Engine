/**
 * Next.js Edge Middleware — protects all routes except /login and /api/auth.
 * Checks for the next-auth session token cookie.
 * Redirects unauthenticated users to /login.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

export async function middleware(request: NextRequest) {
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET || process.env.CSRF_SECRET || "dev-secret-change-me",
  });

  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect all routes EXCEPT: login, auth API, static assets, API health (for probes)
    "/((?!login|api/auth|api/health|_next/static|_next/image|favicon.ico).*)",
  ],
};
