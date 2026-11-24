import {
  getCatchupDate,
  getLocalDate,
  getWorklogApi,
  loadSchedule,
  log,
  setCatchupDate,
} from "./config.js";
import { refreshToken } from "./refresh.js";
import { captureToken } from "./capture-token.js";

export interface SubmitOptions {
  text?: string;
  dryRun?: boolean;
  allowInteractiveLogin?: boolean;
}

export interface SubmitResult {
  success: boolean;
  message: string;
  worklogId?: string;
}

const STATUS_KEY = "on_site";
const STATUS_LABEL = "Working on-site (Company location)";

/**
 * Submit worklog with auto-relogin retry.
 * If the refresh token has expired, automatically opens a browser
 * for re-login and retries the submission.
 */
export async function submitWorklog(
  options: SubmitOptions = {}
): Promise<SubmitResult> {
  const text = options.text ?? "Working on assigned task";
  const dryRun = options.dryRun ?? false;
  const allowInteractiveLogin = options.allowInteractiveLogin ?? true;

  const worklogApi = getWorklogApi();
  if (!worklogApi) {
    return {
      success: false,
      message:
        "No config found. Run `kalvium-worklog discover` first.",
    };
  }

  const body = JSON.stringify({
    title: STATUS_LABEL,
    description: STATUS_LABEL,
    category: STATUS_KEY,
    timeSpent: 0,
    priorityLevel: "medium",
    blockers: "",
    worklogs: JSON.stringify({ content: `<p>${escapeHtml(text)}</p>` }),
  });

  if (dryRun) {
    console.log(`[DRY RUN] Would submit to ${worklogApi}`);
    console.log(`  text='${text}', status=${STATUS_KEY}`);
    console.log(`  Body: ${body}`);
    return { success: true, message: "Dry run" };
  }

  // Try up to 2 times: first with existing token, then after re-login
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.log(`Retry attempt ${attempt + 1} after re-login...`);
    }

    // Step 1: Refresh token
    const refreshResult = await refreshToken();
    if (!refreshResult.success || !refreshResult.accessToken) {
      if (refreshResult.networkError) {
        return {
          success: false,
          message: `Network error while refreshing token: ${refreshResult.error ?? "connection failed"}`,
        };
      }
      if (attempt === 0 && allowInteractiveLogin) {
        console.log("Token expired. Auto re-logging in via browser...");
        const reloginOk = await captureToken();
        if (reloginOk) continue;
        return { success: false, message: "Re-login failed" };
      }
      return { success: false, message: authenticationMessage(refreshResult.error) };
    }

    // Step 2: Submit worklog
    console.log(`Submitting worklog: '${text}'...`);

    try {
      const res = await fetch(worklogApi, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${refreshResult.accessToken}`,
          "content-type": "application/json",
          origin: "https://kalvium.community",
          referer: "https://kalvium.community/",
        },
        body,
      });

      const data = await res.json();

      if (res.ok && data.worklogId) {
        console.log(`SUCCESS! Worklog ID: ${data.worklogId}`);
        console.log(`  Status: ${data.status}`);
        console.log(`  Submitted at: ${data.submittedAt}`);
        return {
          success: true,
          message: "Submitted",
          worklogId: data.worklogId,
        };
      }

      // 401/403 = token invalid — try re-login
      if ((res.status === 401 || res.status === 403) && attempt === 0 && allowInteractiveLogin) {
        console.log(
          `Got HTTP ${res.status}. Token may be invalid. Trying re-login...`
        );
        const reloginOk = await captureToken();
        if (reloginOk) continue;
        return {
          success: false,
          message: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`,
        };
      }

      // 404 = already submitted today
      if (res.status === 404) {
        console.log("Already submitted today (no pending worklog).");
        return { success: true, message: "Already submitted" };
      }

      return {
        success: false,
        message: `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`,
      };
    } catch (e) {
      return { success: false, message: String(e) };
    }
  }

  return { success: false, message: "Max retries exceeded" };
}

/**
 * Check recent worklog status with auto-relogin retry.
 */
export async function checkStatus(): Promise<void> {
  const worklogApi = getWorklogApi();
  if (!worklogApi) {
    console.log("ERROR: No config found. Run `kalvium-worklog discover` first.");
    return;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const refreshResult = await refreshToken();
    if (!refreshResult.success || !refreshResult.accessToken) {
      if (refreshResult.networkError) {
        console.log(`ERROR: Network error while refreshing token: ${refreshResult.error}`);
        return;
      }
      if (attempt === 0) {
        console.log("Token expired. Auto re-logging in via browser...");
        const reloginOk = await captureToken();
        if (reloginOk) continue;
        console.log("ERROR: Re-login failed.");
        return;
      }
      console.log(`ERROR: ${refreshResult.error}`);
      return;
    }

    try {
      const res = await fetch(worklogApi, {
        headers: { authorization: `Bearer ${refreshResult.accessToken}` },
      });

      if (res.status === 401 || res.status === 403) {
        if (attempt === 0) {
          console.log("Token rejected. Trying re-login...");
          const reloginOk = await captureToken();
          if (reloginOk) continue;
        }
        console.log("ERROR: Could not fetch status.");
        return;
      }

      const worklogs = await res.json();
      if (!Array.isArray(worklogs)) {
        console.log("ERROR: Invalid response");
        return;
      }

      const today = getLocalDate();
      for (const w of worklogs.slice(0, 5)) {
        const date = (w.worklogDate ?? "").slice(0, 10);
        const status = w.status ?? "?";
        let content = "";
        if (w.worklogs) {
          content = (w.worklogs.content ?? "")
            .replace(/<\/?p>/g, "")
            .replace(/<br>/g, " ");
        }
        const marker = date === today ? " <-- TODAY" : "";
        console.log(`  ${date} | ${status.padEnd(8)} | ${content}${marker}`);
      }
      return;
    } catch (e) {
      console.log(`ERROR: ${e}`);
      return;
    }
  }
}

/**
 * Daily auto-submit (used by scheduler).
 * Skips weekends. Logs to file.
 * Retries on network failure (up to 5 times with 60s delay).
 */
export async function dailySubmit(
  options: { allowInteractiveLogin?: boolean } = {}
): Promise<boolean> {
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    log("[INFO] Weekend - skipping");
    return true;
  }

  log("[INFO] Starting daily worklog submission...");

  // Retry up to 5 times in case of network failure
  // (covers: laptop waking up, internet reconnecting, etc.)
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 60000; // 1 minute between retries

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      log(`[INFO] Retry ${attempt}/${MAX_RETRIES} (waiting for network...)`);
    }

    const result = await submitWorklog({
      text: "Working on assigned task",
      // A persistent Google session can restore an expired Kalvium token
      // without user input. If Google needs a password or 2FA, the browser
      // remains available for the user to complete that security check.
      allowInteractiveLogin: options.allowInteractiveLogin ?? true,
    });

    if (result.success) {
      log(`[INFO] SUCCESS: ${result.message}`);
      return true;
    }

    // Check if it's a network error (retry) vs a real error (give up)
    const isAuthenticationError = result.message.startsWith("Authentication expired");
    const isNetworkError =
      !isAuthenticationError &&
      (result.message.includes("fetch") ||
      result.message.includes("ECONNREFUSED") ||
      result.message.includes("ENOTFOUND") ||
      result.message.includes("ETIMEDOUT") ||
      result.message.includes("network") ||
      result.message.includes("Failed to fetch") ||
      result.message.includes("refresh failed"));

    // "Already submitted" is a success, not an error
    if (result.message.includes("Already submitted")) {
      log(`[INFO] ${result.message}`);
      return true;
    }

    if (isNetworkError && attempt < MAX_RETRIES) {
      log(`[WARN] Network error: ${result.message}. Retrying in 60s...`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    // Non-network error or max retries reached
    log(`[ERROR] ${result.message}`);
    return false;
  }

  return false;
}

function authenticationMessage(reason?: string): string {
  const detail = reason ? ` (${reason})` : "";
  return `Authentication expired${detail}. Run \`kalvium-worklog login\` while you are at your computer, then retry.`;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>\"']/g, (character) => entities[character]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Catch-up check: if it's a weekday and today's worklog hasn't been
 * submitted yet, submit it. Used on login/wake to handle missed runs.
 */
export async function catchUpSubmit(): Promise<boolean> {
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    return true; // weekend, nothing to do
  }

  const today = getLocalDate();
  if (getCatchupDate() === today) return true;
  const schedule = loadSchedule();
  if (schedule) {
    const now = new Date();
    if (
      now.getHours() * 60 + now.getMinutes() <
      schedule.hour * 60 + schedule.minute
    ) {
      return true;
    }
  }

  log("[INFO] Catch-up check: verifying today's worklog...");

  // Check if today's worklog was already submitted
  const worklogApi = getWorklogApi();
  if (!worklogApi) {
    log("[ERROR] No config found. Run `kalvium-worklog discover` first.");
    return false;
  }

  // Try to refresh token and check status
  const refreshResult = await refreshToken();
  if (!refreshResult.success || !refreshResult.accessToken) {
    log("[WARN] Could not refresh token for catch-up check. Will try submit directly.");
    // Fall through to submit attempt — it has its own retry/relogin logic
  } else {
    try {
      const res = await fetch(worklogApi, {
        headers: { authorization: `Bearer ${refreshResult.accessToken}` },
      });

      if (res.ok) {
        const worklogs = await res.json();
        if (Array.isArray(worklogs)) {
          const todayEntry = worklogs.find(
            (w: { worklogDate?: string; status?: string }) =>
              (w.worklogDate ?? "").slice(0, 10) === today &&
              w.status === "complete"
          );
          if (todayEntry) {
            log("[INFO] Today's worklog already submitted. No catch-up needed.");
            setCatchupDate(today);
            return true;
          }
        }
      }
    } catch {
      // Network error — fall through to submit attempt
      log("[WARN] Could not check status for catch-up. Will try submit directly.");
    }
  }

  // Today's worklog is missing — submit it
  log("[INFO] Today's worklog is missing. Running catch-up submit...");
  const submitted = await dailySubmit();
  if (submitted) setCatchupDate(today);
  return submitted;
}
