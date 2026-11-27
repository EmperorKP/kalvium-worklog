import {
  getCatchupDate,
  getLocalDate,
  getWorklogApi,
  loadSchedule,
  log,
  setCatchupDate,
} from "./config.js";
import { getAccessToken } from "./refresh.js";
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
  /** True for network/server hiccups that are worth retrying. */
  retryable?: boolean;
}

const STATUS_KEY = "on_site";
const STATUS_LABEL = "Working on-site (Company location)";

type AuthorizedResponse =
  | { ok: true; res: Response }
  | { ok: false; message: string; retryable: boolean };

/**
 * Call the Kalvium API with a valid access token.
 * Reuses the stored access token when possible, refreshes it when the server
 * rejects it, and (if allowed) falls back to one browser re-login.
 */
async function authorizedFetch(
  url: string,
  init: RequestInit,
  allowInteractiveLogin: boolean
): Promise<AuthorizedResponse> {
  let forceRefresh = false;
  let reloginTried = false;

  const relogin = async (reason: string): Promise<boolean> => {
    if (reloginTried || !allowInteractiveLogin) return false;
    reloginTried = true;
    console.log(`${reason} Auto re-logging in via browser...`);
    return captureToken();
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const auth = await getAccessToken({ forceRefresh });
    if (!auth.success || !auth.accessToken) {
      if (auth.networkError) {
        return {
          ok: false,
          retryable: true,
          message: `Network error while refreshing token: ${auth.error ?? "connection failed"}`,
        };
      }
      if (await relogin("Token expired.")) {
        forceRefresh = false;
        continue;
      }
      return {
        ok: false,
        retryable: false,
        message: authenticationMessage(auth.error),
      };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${auth.accessToken}`,
        },
      });
    } catch (e) {
      return {
        ok: false,
        retryable: true,
        message: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      if (auth.cached) {
        // The stored access token was revoked early; get a fresh one.
        forceRefresh = true;
        continue;
      }
      if (await relogin(`Got HTTP ${res.status}.`)) {
        forceRefresh = false;
        continue;
      }
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return {
        ok: false,
        retryable: false,
        message: `${authenticationMessage(`HTTP ${res.status}`)} ${detail}`.trim(),
      };
    }

    return { ok: true, res };
  }

  return { ok: false, retryable: false, message: "Max retries exceeded" };
}

async function readJson(res: Response): Promise<{ data: unknown; raw: string }> {
  const raw = await res.text().catch(() => "");
  try {
    return { data: raw ? JSON.parse(raw) : null, raw };
  } catch {
    return { data: null, raw };
  }
}

/** True when a worklog entry's date falls on the given local YYYY-MM-DD day. */
function isOnLocalDay(worklogDate: unknown, day: string): boolean {
  if (typeof worklogDate !== "string" || !worklogDate) return false;
  if (worklogDate.slice(0, 10) === day) return true;
  const parsed = new Date(worklogDate);
  return !Number.isNaN(parsed.getTime()) && getLocalDate(parsed) === day;
}

/**
 * Check whether today's worklog is already complete.
 * Returns null when the check itself could not be completed.
 */
export async function isTodaySubmitted(
  options: { allowInteractiveLogin?: boolean } = {}
): Promise<boolean | null> {
  const worklogApi = getWorklogApi();
  if (!worklogApi) return null;
  const response = await authorizedFetch(worklogApi, {}, options.allowInteractiveLogin ?? false);
  if (!response.ok || !response.res.ok) return null;
  const { data } = await readJson(response.res);
  if (!Array.isArray(data)) return null;
  const today = getLocalDate();
  return data.some(
    (w: { worklogDate?: unknown; status?: unknown }) =>
      isOnLocalDay(w?.worklogDate, today) && w?.status === "complete"
  );
}

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

  console.log(`Submitting worklog: '${text}'...`);
  const response = await authorizedFetch(
    worklogApi,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://kalvium.community",
        referer: "https://kalvium.community/",
      },
      body,
    },
    allowInteractiveLogin
  );
  if (!response.ok) {
    return { success: false, message: response.message, retryable: response.retryable };
  }

  const { res } = response;
  // 404 = already submitted today. Checked before parsing: the body may not be JSON.
  if (res.status === 404) {
    console.log("Already submitted today (no pending worklog).");
    return { success: true, message: "Already submitted" };
  }

  const { data, raw } = await readJson(res);
  const result = (data && typeof data === "object" ? data : {}) as {
    worklogId?: string;
    status?: string;
    submittedAt?: string;
  };

  if (res.ok && result.worklogId) {
    console.log(`SUCCESS! Worklog ID: ${result.worklogId}`);
    console.log(`  Status: ${result.status}`);
    console.log(`  Submitted at: ${result.submittedAt}`);
    return { success: true, message: "Submitted", worklogId: result.worklogId };
  }

  return {
    success: false,
    retryable: res.status >= 500 || res.status === 429,
    message: `HTTP ${res.status}: ${raw.slice(0, 300)}`,
  };
}

/**
 * Check recent worklog status with auto-relogin retry.
 */
export async function checkStatus(): Promise<boolean> {
  const worklogApi = getWorklogApi();
  if (!worklogApi) {
    console.log("ERROR: No config found. Run `kalvium-worklog discover` first.");
    return false;
  }

  const response = await authorizedFetch(worklogApi, {}, true);
  if (!response.ok) {
    console.log(`ERROR: ${response.message}`);
    return false;
  }
  const { data: worklogs } = await readJson(response.res);
  if (!response.res.ok || !Array.isArray(worklogs)) {
    console.log(`ERROR: Could not fetch status (HTTP ${response.res.status}).`);
    return false;
  }

  const today = getLocalDate();
  for (const w of worklogs.slice(0, 5)) {
    const isToday = isOnLocalDay(w.worklogDate, today);
    const date = isToday ? today : String(w.worklogDate ?? "").slice(0, 10);
    const status = String(w.status ?? "?");
    let content = "";
    if (w.worklogs) {
      content = String(w.worklogs.content ?? "")
        .replace(/<\/?p>/g, "")
        .replace(/<br>/g, " ");
    }
    const marker = isToday ? " <-- TODAY" : "";
    console.log(`  ${date} | ${status.padEnd(8)} | ${content}${marker}`);
  }
  return true;
}

/**
 * Daily auto-submit (used by scheduler).
 * Skips weekends. Logs to file.
 * Retries on network failure (up to 5 times with 60s delay).
 */
export async function dailySubmit(
  options: { allowInteractiveLogin?: boolean; skipIfSubmitted?: boolean } = {}
): Promise<boolean> {
  const day = new Date().getDay();
  if (day === 0 || day === 6) {
    log("[INFO] Weekend - skipping");
    return true;
  }

  // A persistent Google session can restore an expired Kalvium token
  // without user input. If Google needs a password or 2FA, the browser
  // remains available for the user to complete that security check.
  const allowInteractiveLogin = options.allowInteractiveLogin ?? true;

  if (options.skipIfSubmitted) {
    // Never overwrite a worklog that is already complete for today.
    if (await isTodaySubmitted({ allowInteractiveLogin: false })) {
      log("[INFO] Today's worklog is already submitted. Nothing to do.");
      return true;
    }
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
      allowInteractiveLogin,
    });

    if (result.success) {
      log(`[INFO] SUCCESS: ${result.message}`);
      return true;
    }

    if (result.retryable && attempt < MAX_RETRIES) {
      log(`[WARN] ${result.message}. Retrying in 60s...`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    // Non-retryable error or max retries reached
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

  if (!getWorklogApi()) {
    log("[ERROR] No config found. Run `kalvium-worklog discover` first.");
    return false;
  }

  const alreadySubmitted = await isTodaySubmitted({ allowInteractiveLogin: false });
  if (alreadySubmitted) {
    log("[INFO] Today's worklog already submitted. No catch-up needed.");
    setCatchupDate(today);
    return true;
  }
  if (alreadySubmitted === null) {
    log("[WARN] Could not check status for catch-up. Will try submit directly.");
  }

  // Today's worklog is missing — submit it
  log("[INFO] Today's worklog is missing. Running catch-up submit...");
  const submitted = await dailySubmit();
  if (submitted) setCatchupDate(today);
  return submitted;
}
