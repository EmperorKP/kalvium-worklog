import {
  PROFILE_DIR,
  CONFIG_FILE,
  ensureInstallDir,
  saveConfig,
  loadToken,
  getPositionIdFromToken,
} from "./config.js";

interface CapturedData {
  token?: string;
  api_url?: string;
}

/**
 * Discover the user's internship position ID.
 * Tries JWT extraction first (no browser needed).
 * Falls back to browser-based discovery via Playwright.
 */
export async function discoverPosition(): Promise<boolean> {
  ensureInstallDir();

  console.log("=== Discovering internship position ID ===\n");

  // Step 1: Try extracting from saved token (no browser needed)
  const token = loadToken();
  if (token) {
    const positionId = getPositionIdFromToken(token);
    if (positionId) {
      const worklogUrl = `https://student-api.kalvium.community/api/internships/worklogs/${positionId}`;
      saveConfig({ position_id: positionId, worklog_api_url: worklogUrl });
      console.log(`\n=== SUCCESS ===`);
      console.log(`Position ID: ${positionId}`);
      console.log(`Worklog API: ${worklogUrl}`);
      console.log(`Saved to: ${CONFIG_FILE}`);
      return true;
    }
    console.log("  Could not extract position ID from token.");
  } else {
    console.log("  No token found. Run `kalvium-worklog login` first.");
  }

  // Step 2: Fall back to browser-based discovery
  const { chromium } = await import("playwright");

  console.log("\nOpening browser for manual login...");
  const captured = await discoverViaBrowser(chromium, false);

  if (!captured.token) {
    console.log("\nERROR: Could not capture token. Please log in and try again.");
    return false;
  }

  console.log(`   Token captured: ${captured.token.slice(0, 40)}...`);

  // Step 3: Extract position ID from captured API URLs
  const positionId = extractPositionId(captured.api_url ?? "");

  if (!positionId) {
    console.log("\nERROR: Could not determine position ID from API calls");
    return false;
  }

  // Step 4: Save config
  const worklogUrl = `https://student-api.kalvium.community/api/internships/worklogs/${positionId}`;
  saveConfig({ position_id: positionId, worklog_api_url: worklogUrl });

  console.log(`\n=== SUCCESS ===`);
  console.log(`Position ID: ${positionId}`);
  console.log(`Worklog API: ${worklogUrl}`);
  console.log(`Saved to: ${CONFIG_FILE}`);
  return true;
}

async function discoverViaBrowser(
  chromium: typeof import("playwright").chromium,
  headless: boolean
): Promise<CapturedData> {
  const captured: CapturedData = {};

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(headless ? ["--headless=new"] : []),
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());

  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("student-api.kalvium")) {
      const auth = req.headers()["authorization"] ?? "";
      if (auth.startsWith("Bearer ")) {
        captured.token = auth;
      }
      if (url.includes("internships")) {
        captured.api_url = url;
        console.log(`  Found API call: ${url}`);
      }
    }
  });

  if (headless) {
    console.log("Loading kalvium.community/internships (headless)...");
    try {
      await page.goto("https://kalvium.community/internships", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .waitForLoadState("networkidle", { timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(8000);
    } catch {
      // ignore
    }
  } else {
    console.log("\n  ========================================");
    console.log("  Browser opened. Auto-clicking 'Continue with Google'...");
    console.log("  Please complete 2FA if prompted.");
    console.log("  ========================================\n");

    await page.goto("https://kalvium.community/internships", {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    // Auto-click "Continue with Google"
    try {
      const googleBtn = page.locator("text=Continue with Google").first();
      const isVisible = await googleBtn.isVisible().catch(() => false);
      if (isVisible) {
        await googleBtn.click();
        console.log("  Clicked 'Continue with Google'.");
      }
    } catch {
      // ignore
    }

    console.log("  Waiting for login to complete (up to 5 minutes)...");

    for (let i = 0; i < 300; i++) {
      if (captured.token && captured.api_url) break;
      await page.waitForTimeout(1000);
      if (i > 0 && i % 30 === 0) {
        const url = page.url();
        if (
          url.includes("kalvium.community/internships") &&
          !url.includes("error")
        ) {
          await page
            .waitForLoadState("networkidle", { timeout: 5000 })
            .catch(() => {});
        }
      }
    }
  }

  await context.close();
  return captured;
}

function extractPositionId(apiUrl: string): string | null {
  if (!apiUrl) return null;
  const parts = apiUrl.split("/");
  const internshipsIdx = parts.indexOf("internships");
  if (internshipsIdx === -1) return null;

  for (const part of parts.slice(internshipsIdx + 1)) {
    if (part.length === 36 && part.split("-").length === 5) {
      return part;
    }
  }
  return null;
}
