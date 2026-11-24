import {
  PROFILE_DIR,
  ensureInstallDir,
  loadToken,
  saveToken,
  type TokenData,
} from "./config.js";

const LOGIN_URL = "https://kalvium.community/internships";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export interface CaptureTokenOptions {
  email?: string;
}

/**
 * Try headless mode first (fast — works if session is still valid).
 * If no session, opens a headed browser and waits for manual login.
 */
export async function captureToken(
  options: CaptureTokenOptions = {}
): Promise<boolean> {
  ensureInstallDir();

  try {
    const { chromium } = await import("playwright");
    console.log("Opening browser for login...");
    const previousRefreshToken = loadToken()?.refresh_token;
    const data = await tryCapture(
      chromium,
      options.email,
      previousRefreshToken
    );

    if (data) {
      saveToken(data);
      console.log("Login complete. Secure refresh token saved.");
      return true;
    }

    console.log("Login did not complete before the timeout. Please try again.");
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`Could not open the login browser: ${message}`);
    return false;
  }
}

/**
 * Try to capture token by loading the page and extracting it from localStorage.
 * Opens headed browser and waits for manual login.
 */
async function tryCapture(
  chromium: typeof import("playwright").chromium,
  email?: string,
  previousRefreshToken?: string
): Promise<TokenData | null> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  let captured: TokenData | null = null;
  const selectedAccountPages = new Set<import("playwright").Page>();

  try {
    // Catch the Keycloak token exchange directly. This is more reliable than
    // relying on a Kalvium localStorage key that can change after deployments.
    context.on("response", (response) => {
      if (!response.url().includes("/openid-connect/token")) return;
      void response.json().then((data: unknown) => {
        const token = tokenFromUnknown(data);
        if (token && isNewUsableToken(token, previousRefreshToken)) {
          captured ??= token;
        }
      }).catch(() => undefined);
    });

    const page = context.pages()[0] || await context.newPage();
    console.log("  ========================================");
    console.log("  Browser opened. Complete Google login and 2FA if prompted.");
    console.log("  This command will finish automatically after Kalvium loads.");
    console.log("  ========================================");

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

    try {
      await page.getByRole("button", { name: /continue with google/i }).first().click({ timeout: 5000 });
      console.log("  Clicked 'Continue with Google'.");
    } catch {
      // An existing session may bypass this button.
    }

    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (captured) return captured;
      for (const openPage of context.pages()) {
        if (!selectedAccountPages.has(openPage)) {
          const selected = await selectGoogleAccount(openPage, email);
          if (selected) selectedAccountPages.add(openPage);
        }
        const token = await readStoredToken(openPage);
        if (token && isNewUsableToken(token, previousRefreshToken)) {
          captured ??= token;
        }
        if (captured) return captured;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function selectGoogleAccount(
  page: import("playwright").Page,
  email?: string
): Promise<boolean> {
  if (!email || !page.url().includes("accounts.google.com")) return false;
  try {
    await page
      .locator("[data-identifier]")
      .filter({ hasText: email })
      .first()
      .click({ timeout: 500 });
    console.log(`  Selected ${email}.`);
    return true;
  } catch {
    // The page may be on password/2FA or not have loaded its account list yet.
    return false;
  }
}

async function readStoredToken(page: import("playwright").Page): Promise<TokenData | null> {
  if (!page.url().includes("kalvium.community")) return null;
  try {
    const values = await page.evaluate(() => {
      const read = (storage: Storage): string[] => {
        const values: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key) values.push(storage.getItem(key) ?? "");
        }
        return values;
      };
      return [...read(localStorage), ...read(sessionStorage)];
    });
    for (const value of values) {
      const token = tokenFromUnknown(value);
      if (token) return token;
    }
  } catch {
    // The browser can be changing origins while Google redirects back.
  }
  return null;
}

function tokenFromUnknown(value: unknown): TokenData | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  const accessToken = data.access_token ?? data.accessToken;
  const refreshToken = data.refresh_token ?? data.refreshToken;
  if (typeof accessToken === "string" && typeof refreshToken === "string") {
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
      refresh_expires_in: typeof data.refresh_expires_in === "number" ? data.refresh_expires_in : undefined,
      token_type: typeof data.token_type === "string" ? data.token_type : undefined,
      session_state: typeof data.session_state === "string" ? data.session_state : undefined,
    };
  }
  for (const nestedValue of Object.values(data)) {
    const token = tokenFromUnknown(nestedValue);
    if (token) return token;
  }
  return null;
}

function isNewUsableToken(
  token: TokenData,
  previousRefreshToken?: string
): boolean {
  if (token.refresh_token === previousRefreshToken) return false;

  const payload = decodeJwtPayload(token.refresh_token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp > Math.floor(Date.now() / 1000);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    return JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf-8"
      )
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}
