import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 Proxy (formerly `middleware`).
 *
 * This is deliberately an *optimistic* check only: it looks for the presence of
 * a session cookie and bounces anonymous visitors to /login. It performs no
 * crypto, no database access and no role logic, because the Next.js docs are
 * explicit that Proxy must not be used as the authorization solution.
 *
 * Real enforcement lives in `lib/rbac.ts` and is applied inside every route
 * handler and protected page, where the user is re-read from the database.
 */

const PUBLIC_PATHS = [
  "/login",
  "/offline",
  "/manifest.webmanifest",
  "/sw.js",
  "/logo.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
];

function hasSessionCookie(request: NextRequest): boolean {
  // Auth.js v5 names the cookie `authjs.session-token`, prefixed with
  // `__Secure-` when served over HTTPS.
  return (
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token")
  );
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Auth.js endpoints and static assets must stay reachable.
  //
  // /api/cron/* is also exempt: the scheduler authenticates with a bearer
  // secret rather than a session cookie, so bouncing it here would make the
  // endpoint unreachable to the only caller it exists for. The route does its
  // own authentication (shared secret, or an admin session for a manual run).
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/cron/") ||
    pathname.startsWith("/icons/") ||
    PUBLIC_PATHS.includes(pathname)
  ) {
    return NextResponse.next();
  }

  if (hasSessionCookie(request)) {
    return NextResponse.next();
  }

  // Unauthenticated API calls get a JSON 401 rather than an HTML redirect,
  // so fetch() callers (and the service worker) can handle it sensibly.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") {
    loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except Next internals and files with an extension.
    "/((?!_next/static|_next/image|.*\\..*).*)",
  ],
};
