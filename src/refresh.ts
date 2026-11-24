import { appendFileSync } from "fs";
import { LOG_FILE, ensureInstallDir } from "./config.js";

export function log(message: string): void {
  ensureInstallDir();
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `${timestamp} ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore
  }
  console.log(message);
}

export interface RefreshResult {
  success: boolean;
  accessToken?: string;
  error?: string;
  networkError?: boolean;
}

export async function refreshToken(): Promise<RefreshResult> {
  const { loadToken, saveToken, KEYCLOAK_URL, CLIENT_ID } =
    await import("./config.js");

  const token = loadToken();
  if (!token?.refresh_token) {
    return { success: false, error: "No refresh token found" };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: token.refresh_token,
  });

  try {
    const res = await fetch(KEYCLOAK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data: unknown = await res.json().catch(() => null);

    if (!res.ok || !data || typeof data !== "object") {
      const error =
        data && typeof data === "object" && "error" in data
          ? String(data.error)
          : `HTTP ${res.status}`;
      return { success: false, error };
    }

    const token = data as { access_token?: unknown; refresh_token?: unknown };
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
      return { success: false, error: "Invalid token response" };
    }
    saveToken(data as import("./config.js").TokenData);
    return { success: true, accessToken: token.access_token };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      networkError: true,
    };
  }
}
