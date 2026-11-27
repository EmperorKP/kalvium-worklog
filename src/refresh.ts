import {
  CLIENT_ID,
  KEYCLOAK_URL,
  decodeJwt,
  loadToken,
  saveToken,
  type TokenData,
} from "./config.js";

export { log } from "./config.js";

export interface RefreshResult {
  success: boolean;
  accessToken?: string;
  error?: string;
  networkError?: boolean;
  /** True when the stored access token was reused and nothing was rotated. */
  cached?: boolean;
}

// Every refresh rotates the refresh token. Reusing a still-valid access token
// keeps rotations (and, in cloud mode, secret writes) to about one per day.
const MIN_REMAINING_SECONDS = 5 * 60;
const MAX_AGE_SECONDS = 12 * 60 * 60;

function reusableAccessToken(token: TokenData | null): string | null {
  if (!token?.access_token) return null;
  const payload = decodeJwt(token.access_token);
  if (!payload || typeof payload.exp !== "number") return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp - now < MIN_REMAINING_SECONDS) return null;
  // Refresh at least daily so the refresh token never goes stale.
  if (typeof payload.iat !== "number" || now - payload.iat > MAX_AGE_SECONDS) return null;
  return token.access_token;
}

/**
 * Return a usable access token, refreshing (and rotating) only when the stored
 * one is missing, old or about to expire.
 */
export async function getAccessToken(
  options: { forceRefresh?: boolean } = {}
): Promise<RefreshResult> {
  if (!options.forceRefresh) {
    const accessToken = reusableAccessToken(loadToken());
    if (accessToken) return { success: true, accessToken, cached: true };
  }
  return refreshToken();
}

export async function refreshToken(): Promise<RefreshResult> {
  const token = loadToken();
  if (!token?.refresh_token) {
    return { success: false, error: "No refresh token found" };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: token.refresh_token,
  });

  let res: Response;
  try {
    res = await fetch(KEYCLOAK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      networkError: true,
    };
  }

  const data: unknown = await res.json().catch(() => null);

  if (!res.ok || !data || typeof data !== "object") {
    const error =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `HTTP ${res.status}`;
    // A server-side outage is not a rejected login; let callers retry it.
    const transient = res.status >= 500 || res.status === 429;
    return { success: false, error, networkError: transient };
  }

  const fresh = data as { access_token?: unknown; refresh_token?: unknown };
  if (typeof fresh.access_token !== "string" || typeof fresh.refresh_token !== "string") {
    return { success: false, error: "Invalid token response" };
  }
  saveToken(data as TokenData);
  return { success: true, accessToken: fresh.access_token };
}
