import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import {
  CONFIG_FILE,
  INSTALL_DIR,
  TOKEN_FILE,
  ensureInstallDir,
  loadConfig,
  loadSchedule,
  log,
} from "./config.js";
import { dailySubmit } from "./submit.js";
import { setupCloudRepairScheduler, removeCloudRepairScheduler } from "./scheduler.js";

// Reuse the browser profile already created by kalvium-attendance, but keep
// Worklog's rotated refresh token in its own file to avoid token races.
const CLOUD_HOME = path.join(os.homedir(), ".kalvium-attendance-cloud");
const CLOUD_CONFIG = path.join(INSTALL_DIR, "cloud.json");
const WORKFLOW_PATH = ".github/workflows/attendance.yml";
const SECRET_TOKEN = "KATTEND_TOKEN";
const SECRET_CONFIG = "KATTEND_CONFIG";
const SECRET_PAT = "KATTEND_PAT";

interface CloudConfig {
  position_id: string;
  worklog_api_url: string;
  time: string;
  timezone: string;
  cloudRepo: string;
  email?: string;
}

interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

function gh(args: string[], input?: string): GhResult {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    windowsHide: true,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error("GitHub CLI is required. Install gh, then run: gh auth login");
  }
  return result;
}

function requireGh(): void {
  if (gh(["auth", "status"]).status !== 0) {
    throw new Error("Not logged in to GitHub. Run: gh auth login");
  }
}

function runGh(args: string[], input?: string): string {
  const result = gh(args, input);
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "GitHub CLI command failed").trim());
  }
  return result.stdout.trim();
}

async function ask(prompt: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    return (await rl.question(`${prompt}${suffix}: `)).trim() || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question("")).trim();
    } finally {
      rl.close();
    }
  }
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") process.exit(130);
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function readCloudConfig(): CloudConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CLOUD_CONFIG, "utf8")) as CloudConfig;
  } catch {
    return null;
  }
}

function saveCloudMetadata(repo: string, email?: string): void {
  fs.mkdirSync(INSTALL_DIR, { recursive: true, mode: 0o700 });
  const previous = readCloudConfig();
  const value = { ...previous, cloudRepo: repo, ...(email ? { email } : {}) };
  fs.writeFileSync(CLOUD_CONFIG, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function requireRepo(): string {
  const repo = readCloudConfig()?.cloudRepo;
  if (!repo) throw new Error("Cloud mode is not set up. Run: kalvium-worklog cloud init");
  return repo;
}

function cloudLogin(cliPath: string, email?: string): void {
  fs.mkdirSync(CLOUD_HOME, { recursive: true, mode: 0o700 });
  console.log("Opening a separate Kalvium login for GitHub Actions.");
  const args = [cliPath, "login"];
  if (email) args.push("--email", email);
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      KWORKLOG_HOME: CLOUD_HOME,
      KWORKLOG_PROFILE_DIR: path.join(CLOUD_HOME, "browser-profile"),
    },
  });
  if (result.status !== 0 || !fs.existsSync(path.join(CLOUD_HOME, "refresh_token.json"))) {
    throw new Error("Cloud login did not complete.");
  }
}

/** Minutes to wait after the chosen time so checks land 5-25 minutes past each half hour. */
export function offPeakDelay(minute: number): number {
  for (let delay = 2; delay < 30; delay++) {
    const mark = (minute + delay) % 30;
    if (mark >= 5 && mark <= 25) return delay;
  }
  return 7;
}

export function cronFor(
  time: string,
  offsetMin = new Date().getTimezoneOffset(),
  delayMin = 0
): string[] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid time "${time}". Use HH:MM, e.g. 12:30`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${time}".`);
  const hoursByMinuteAndWeekday = new Map<number, Map<number, Set<number>>>();
  for (let offset = 0; offset <= 300; offset += 30) {
    const localMinutes = hour * 60 + minute + delayMin + offset;
    const utcAbsoluteMinutes = localMinutes + offsetMin;
    const utcDayOffset = Math.floor(utcAbsoluteMinutes / 1440);
    const utcMinutes = ((utcAbsoluteMinutes % 1440) + 1440) % 1440;
    const utcHour = Math.floor(utcMinutes / 60);
    const utcMinute = utcMinutes % 60;
    for (let localWeekday = 1; localWeekday <= 5; localWeekday++) {
      const utcWeekday = ((localWeekday + utcDayOffset) % 7 + 7) % 7;
      const weekdays = hoursByMinuteAndWeekday.get(utcMinute) ?? new Map<number, Set<number>>();
      const hours = weekdays.get(utcWeekday) ?? new Set<number>();
      hours.add(utcHour);
      weekdays.set(utcWeekday, hours);
      hoursByMinuteAndWeekday.set(utcMinute, weekdays);
    }
  }
  return [...hoursByMinuteAndWeekday.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([minuteValue, weekdays]) => {
      const weekdaysByHours = new Map<string, number[]>();
      for (const [weekday, hours] of weekdays) {
        const hourList = [...hours].sort((a, b) => a - b).join(",");
        const days = weekdaysByHours.get(hourList) ?? [];
        days.push(weekday);
        weekdaysByHours.set(hourList, days);
      }
      return [...weekdaysByHours.entries()].map(([hours, days]) =>
        `${minuteValue} ${hours} * * ${days.sort((a, b) => a - b).join(",")}`
      );
    });
}

const PACKAGE_NAME = "kalvium-worklog";

/**
 * The workflow installs this package from npm, so it must pin a version that
 * is actually published. A local/unpublished build falls back to the latest
 * release instead of generating a workflow that can never install.
 */
async function publishedVersion(version: string): Promise<string> {
  const registry = `https://registry.npmjs.org/${PACKAGE_NAME}`;
  try {
    const exact = await fetch(`${registry}/${version}`, { signal: AbortSignal.timeout(15000) });
    if (exact.ok) return version;
    if (exact.status !== 404) return version;
    const latest = await fetch(`${registry}/latest`, { signal: AbortSignal.timeout(15000) });
    const data = (await latest.json()) as { version?: unknown };
    if (latest.ok && typeof data.version === "string") {
      console.log(
        `Note: ${PACKAGE_NAME}@${version} is not published on npm; the cloud workflow will use ${data.version}.`
      );
      return data.version;
    }
  } catch {
    // Offline or registry hiccup: keep the local version.
  }
  return version;
}

function workflowYaml(config: CloudConfig, version: string): string {
  // Keep the exact requested time, then retry away from GitHub's busy :00/:30
  // boundaries if that scheduled event is delayed or dropped.
  const minute = Number(/^\d{1,2}:(\d{2})$/.exec(config.time)?.[1] ?? 0);
  const schedules = [
    ...cronFor(config.time),
    ...cronFor(config.time, undefined, offPeakDelay(minute)),
  ];
  return `# Generated by kalvium-worklog. Run kalvium-worklog cloud sync to update.
name: Kalvium worklog
on:
  schedule:
${schedules.map((cron) => `    - cron: "${cron}"`).join("\n")}
  workflow_dispatch:
concurrency:
  group: kalvium-worklog
  cancel-in-progress: false
permissions: {}
jobs:
  submit:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      TZ: ${config.timezone}
      KWORKLOG_HOME: /tmp/kalvium-worklog
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      # Installing is retried on its own so a flaky download never re-runs the
      # submit step with an already-rotated token.
      - name: Install kalvium-worklog
        run: |
          for attempt in 1 2 3; do
            npm install --global --no-audit --no-fund ${PACKAGE_NAME}@${version} && exit 0
            echo "Install attempt $attempt failed; retrying in 20s..."
            sleep 20
          done
          exit 1
      - name: Submit daily worklog
        env:
          KATTEND_TOKEN_JSON: \${{ secrets.${SECRET_TOKEN} }}
          KATTEND_CONFIG_JSON: \${{ secrets.${SECRET_CONFIG} }}
          GH_TOKEN: \${{ secrets.${SECRET_PAT} }}
        run: kalvium-worklog cloud run
`;
}

function putWorkflow(repo: string, content: string): void {
  const api = `repos/${repo}/contents/${WORKFLOW_PATH}`;
  const existing = gh(["api", api, "--jq", "[.sha, .content] | @tsv"]);
  const args = [
    "api", "-X", "PUT", api,
    "-f", "message=Update Kalvium worklog workflow",
    "-f", `content=${Buffer.from(content).toString("base64")}`,
  ];
  if (existing.status === 0 && existing.stdout.trim()) {
    const [sha, encoded = ""] = existing.stdout.trim().split("\t");
    const current = Buffer.from(encoded.replace(/\\n/g, ""), "base64").toString("utf8");
    if (current === content) return; // unchanged: avoid a pointless commit
    args.push("-f", `sha=${sha}`);
  }
  const result = gh(args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    const hint = /workflow/i.test(detail) && /scope/i.test(detail)
      ? "\nYour GitHub CLI login cannot edit workflow files. Run: gh auth refresh -s workflow"
      : "";
    throw new Error(`Could not write ${WORKFLOW_PATH} to ${repo}: ${detail}${hint}`);
  }
}

function setSecret(repo: string, name: string, value: string): void {
  runGh(["secret", "set", name, "--repo", repo], value);
}

function currentCloudConfig(repo: string): CloudConfig {
  const local = loadConfig();
  if (!local?.position_id || !local.worklog_api_url) {
    throw new Error("Run kalvium-worklog discover before setting up cloud mode.");
  }
  const schedule = loadSchedule() ?? { hour: 12, minute: 30 };
  return {
    position_id: local.position_id,
    worklog_api_url: local.worklog_api_url,
    time: `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cloudRepo: repo,
  };
}

function secretConfig(config: CloudConfig): string {
  return JSON.stringify({
    position_id: config.position_id,
    worklog_api_url: config.worklog_api_url,
    time: config.time,
    timezone: config.timezone,
  });
}

export async function cloudInit(options: {
  cliPath: string;
  version: string;
  repoName?: string;
  reuse?: boolean;
  email?: string;
}): Promise<void> {
  requireGh();
  const owner = runGh(["api", "user", "--jq", ".login"]);
  const requested = options.repoName || await ask("Private GitHub repo name", "kalvium-attendance-cloud");
  const repo = requested.includes("/") ? requested : `${owner}/${requested}`;
  const cloudTokenFile = path.join(CLOUD_HOME, "refresh_token.json");
  if (!(options.reuse && fs.existsSync(cloudTokenFile))) cloudLogin(options.cliPath, options.email);

  const config = currentCloudConfig(repo);
  console.log(`This will configure the private repo ${repo} to run at ${config.time} ${config.timezone}.`);
  if ((await ask("Continue? (yes/no)", "no")).toLowerCase() !== "yes") throw new Error("Cancelled.");

  const created = gh(["repo", "create", repo, "--private", "--description", "Daily Kalvium worklog automation"]);
  if (created.status !== 0 && !/already exists/i.test(created.stderr)) {
    throw new Error((created.stderr || "Could not create the GitHub repository.").trim());
  }
  const pat = process.env.KATTEND_PAT || await askHidden("Fine-grained PAT (repo Secrets: read/write; input hidden): ");
  if (!pat) throw new Error("A GitHub token is required to save rotated refresh tokens.");

  setSecret(repo, SECRET_TOKEN, fs.readFileSync(cloudTokenFile, "utf8"));
  setSecret(repo, SECRET_CONFIG, secretConfig(config));
  setSecret(repo, SECRET_PAT, pat);
  putWorkflow(repo, workflowYaml(config, await publishedVersion(options.version)));
  saveCloudMetadata(repo, options.email);
  setupCloudRepairScheduler(options.cliPath, options.version);
  console.log(`Cloud worklog enabled for ${repo} at ${config.time} ${config.timezone}.`);
}

export async function cloudSync(options: {
  cliPath: string;
  version: string;
  login?: boolean;
  pat?: boolean;
  email?: string;
}): Promise<void> {
  requireGh();
  const repo = requireRepo();
  if (options.login) {
    cloudLogin(options.cliPath, options.email || readCloudConfig()?.email);
    const tokenFile = path.join(CLOUD_HOME, "refresh_token.json");
    setSecret(repo, SECRET_TOKEN, fs.readFileSync(tokenFile, "utf8"));
  }
  if (options.pat || process.env.KATTEND_PAT) {
    const pat = process.env.KATTEND_PAT || await askHidden("Fine-grained PAT (repo Secrets: read/write; input hidden): ");
    if (!pat) throw new Error("No GitHub token entered.");
    setSecret(repo, SECRET_PAT, pat);
    console.log(`Updated ${SECRET_PAT}.`);
  }
  const config = currentCloudConfig(repo);
  setSecret(repo, SECRET_CONFIG, secretConfig(config));
  putWorkflow(repo, workflowYaml(config, await publishedVersion(options.version)));
  saveCloudMetadata(repo, options.email);
  setupCloudRepairScheduler(options.cliPath, options.version);
  console.log(`Synced cloud worklog settings${options.login ? " and refreshed its login" : ""}.`);
}

export function cloudStatus(): void {
  requireGh();
  const repo = requireRepo();
  console.log(`Repo: https://github.com/${repo}`);
  const result = gh(["run", "list", "--repo", repo, "--limit", "8"]);
  if (result.status !== 0) throw new Error((result.stderr || "Could not read workflow runs.").trim());
  console.log(result.stdout.trim() || "No runs yet.");
}

export function cloudTest(): void {
  requireGh();
  const repo = requireRepo();
  runGh(["workflow", "run", "attendance.yml", "--repo", repo]);
  console.log(`Started a run. Check https://github.com/${repo}/actions`);
}

interface RecoveryState {
  attemptedRunId?: number;
  attemptedAt?: string;
  dispatchDate?: string;
  dispatchCount?: number;
  lastDispatchAt?: string;
}

function recoveryStatePath(): string {
  return path.join(INSTALL_DIR, "cloud-recovery.json");
}

function readRecoveryState(): RecoveryState {
  try {
    return JSON.parse(fs.readFileSync(recoveryStatePath(), "utf8")) as RecoveryState;
  } catch {
    return {};
  }
}

function saveRecoveryState(state: RecoveryState): void {
  ensureInstallDir();
  fs.writeFileSync(recoveryStatePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Called by the Mac LaunchAgent. It catches missing or failed cloud runs and
 * repairs expired login tokens using the saved Google browser session.
 */
export async function cloudMonitor(options: { cliPath: string; version: string }): Promise<void> {
  const cloudConfig = readCloudConfig();
  const repo = cloudConfig?.cloudRepo;
  if (!repo) return;
  requireGh();

  const list = gh([
    "run", "list", "--repo", repo, "--workflow", "attendance.yml", "--limit", "20",
    "--json", "databaseId,event,status,conclusion,createdAt",
  ]);
  if (list.status !== 0) throw new Error((list.stderr || "Could not read recent cloud runs.").trim());
  const runs = JSON.parse(list.stdout || "[]") as Array<{
    databaseId: number;
    event: string;
    status: string;
    conclusion: string | null;
    createdAt: string;
  }>;
  const config = currentCloudConfig(repo);
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const datePart = (type: string) => dateParts.find((item) => item.type === type)?.value;
  const date = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
  const localParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => localParts.find((item) => item.type === type)?.value;
  const weekday = part("weekday");
  if (weekday === "Sat" || weekday === "Sun") return;
  const currentMinutes = Number(part("hour")) * 60 + Number(part("minute"));
  const scheduled = /^(\d{1,2}):(\d{2})$/.exec(config.time);
  if (!scheduled || currentMinutes < Number(scheduled[1]) * 60 + Number(scheduled[2])) return;

  const todaysRuns = runs.filter((run) => {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: config.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(run.createdAt));
      const runDate = `${parts.find((item) => item.type === "year")?.value}-${parts.find((item) => item.type === "month")?.value}-${parts.find((item) => item.type === "day")?.value}`;
      return runDate === date;
    } catch {
      return false;
    }
  });
  const latest = todaysRuns[0];
  if (todaysRuns.some((run) => run.status !== "completed")) return;
  if (latest?.conclusion === "success") return;

  const state = readRecoveryState();
  const attempts = state.dispatchDate === date ? (state.dispatchCount ?? 0) : 0;
  const lastDispatch = state.lastDispatchAt ? Date.parse(state.lastDispatchAt) : 0;
  const dispatchRetry = (reason: string) => {
    if (attempts >= 10 || Date.now() - lastDispatch < 25 * 60 * 1000) return;
    runGh(["workflow", "run", "attendance.yml", "--repo", repo]);
    saveRecoveryState({
      ...state,
      dispatchDate: date,
      dispatchCount: attempts + 1,
      lastDispatchAt: new Date().toISOString(),
    });
    log(`${reason}; dispatched cloud run ${attempts + 1}/10 for ${date}.`);
  };

  if (!latest) {
    dispatchRetry("No cloud run exists for today after the scheduled time");
    return;
  }
  if (latest.conclusion === "success") return;

  const runLog = gh(["run", "view", String(latest.databaseId), "--repo", repo, "--log-failed"]);
  if (runLog.status !== 0) return;
  const authFailure = /authentication expired|session expired or invalid|refresh token.{0,40}(invalid|expired)|HTTP 401|HTTP 403/i.test(runLog.stdout);
  if (new RegExp(SECRET_PAT).test(runLog.stdout)) {
    // Re-running cannot fix a dead GitHub token, and each retry risks losing a rotated login.
    log(`Cloud run ${latest.databaseId} failed because ${SECRET_PAT} is missing, expired or lacks Secrets access. Run: kalvium-worklog cloud sync --pat`);
    return;
  }
  if (!authFailure) {
    dispatchRetry(`Cloud run ${latest.databaseId} failed without an authentication error`);
    return;
  }

  const attemptedAt = state.attemptedAt ? Date.parse(state.attemptedAt) : 0;
  if (state.attemptedRunId === latest.databaseId || Date.now() - attemptedAt < 6 * 60 * 60 * 1000) {
    return;
  }

  saveRecoveryState({ ...state, attemptedRunId: latest.databaseId, attemptedAt: new Date().toISOString() });
  log(`Cloud login failed in GitHub run ${latest.databaseId}; attempting browser re-login.`);
  try {
    cloudLogin(options.cliPath, readCloudConfig()?.email);
    const tokenFile = path.join(CLOUD_HOME, "refresh_token.json");
    const token = fs.readFileSync(tokenFile, "utf8");
    setSecret(repo, SECRET_TOKEN, token);
    const config = currentCloudConfig(repo);
    setSecret(repo, SECRET_CONFIG, secretConfig(config));
    putWorkflow(repo, workflowYaml(config, await publishedVersion(options.version)));
    saveRecoveryState({ dispatchDate: date, dispatchCount: attempts, lastDispatchAt: state.lastDispatchAt });
    log("Cloud login refreshed and saved; retrying the failed cloud run.");
    dispatchRetry(`Cloud login recovered from run ${latest.databaseId}`);
  } catch (error) {
    log(`Cloud re-login could not complete: ${error instanceof Error ? error.message : String(error)}. Google may need you to finish sign-in in the browser.`);
  }
}

export function cloudMonitorRemove(): void {
  removeCloudRepairScheduler();
}

/** Minutes since midnight and weekday in the configured timezone. */
function localClock(timezone?: string): { minutes: number; weekend: boolean } {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || undefined,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    return {
      minutes: Number(part("hour")) * 60 + Number(part("minute")),
      weekend: part("weekday") === "Sat" || part("weekday") === "Sun",
    };
  } catch {
    return {
      minutes: now.getHours() * 60 + now.getMinutes(),
      weekend: now.getDay() === 0 || now.getDay() === 6,
    };
  }
}

function saveRotatedToken(repo: string, token: string): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      setSecret(repo, SECRET_TOKEN, token);
      console.log("Saved rotated Kalvium token.");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) spawnSync("sleep", ["5"]);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `The Kalvium token rotated but could not be saved to ${SECRET_TOKEN} (${detail}). ` +
    `The stored login is now stale: run \`kalvium-worklog cloud sync --login\` (and \`--pat\` if ${SECRET_PAT} expired).`
  );
}

export async function cloudRun(): Promise<void> {
  const tokenJson = process.env.KATTEND_TOKEN_JSON;
  const configJson = process.env.KATTEND_CONFIG_JSON;
  if (!tokenJson || !configJson) throw new Error("Cloud token/config secrets are missing. Run cloud sync --login.");
  let config: Partial<CloudConfig>;
  try {
    config = JSON.parse(configJson) as Partial<CloudConfig>;
    JSON.parse(tokenJson);
  } catch {
    throw new Error("Cloud token/config secrets are not valid JSON. Run cloud sync --login.");
  }
  const mappedConfig = {
    position_id: config.position_id,
    worklog_api_url: config.worklog_api_url,
  };
  if (!mappedConfig.position_id || !mappedConfig.worklog_api_url) {
    throw new Error("Cloud config is missing the internship position or worklog URL.");
  }

  // All date logic below (weekend, "today", due time) follows the user's timezone.
  if (config.timezone) process.env.TZ = config.timezone;
  const clock = localClock(config.timezone);
  if (clock.weekend) {
    console.log("Weekend - skipping.");
    return;
  }
  // Manual runs (cloud test, recovery dispatches) are never held back.
  const manual = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const scheduled = /^(\d{1,2}):(\d{2})$/.exec(config.time || "12:30");
  if (scheduled && !manual && clock.minutes < Number(scheduled[1]) * 60 + Number(scheduled[2])) {
    console.log("Not due yet; the next scheduled check will retry.");
    return;
  }

  // Prove the rotated token can be saved BEFORE anything rotates it. A dead
  // PAT would otherwise burn the refresh token and break every later run.
  const repo = process.env.GITHUB_REPOSITORY || requireRepo();
  if (!process.env.GH_TOKEN) {
    throw new Error(`${SECRET_PAT} is not configured, so a rotated token could not be saved. Run: kalvium-worklog cloud sync --pat`);
  }
  const probe = gh(["api", `repos/${repo}/actions/secrets/public-key`, "--jq", ".key_id"]);
  if (probe.status !== 0) {
    throw new Error(
      `${SECRET_PAT} cannot write secrets in ${repo} (${(probe.stderr || probe.stdout).trim()}). ` +
      `Nothing was rotated. Create a fine-grained token with "Secrets: read and write" for this repo, then run: kalvium-worklog cloud sync --pat`
    );
  }

  ensureInstallDir();
  fs.writeFileSync(TOKEN_FILE, tokenJson, { mode: 0o600 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(mappedConfig), { mode: 0o600 });

  let submitted = false;
  try {
    submitted = await dailySubmit({ allowInteractiveLogin: false, skipIfSubmitted: true });
  } finally {
    // Always persist a rotated token, even when the submit itself blew up.
    const updatedToken = fs.readFileSync(TOKEN_FILE, "utf8");
    if (updatedToken !== tokenJson) saveRotatedToken(repo, updatedToken);
  }
  if (!submitted) throw new Error("Worklog cloud run failed; see the log output above.");
}
