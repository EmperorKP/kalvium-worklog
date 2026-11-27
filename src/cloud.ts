import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import {
  CONFIG_FILE,
  INSTALL_DIR,
  SCHEDULE_FILE,
  TOKEN_FILE,
  ensureInstallDir,
  loadConfig,
  loadSchedule,
  saveConfig,
} from "./config.js";
import { dailySubmit } from "./submit.js";
import { log } from "./config.js";
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

export function cronFor(time: string, offsetMin = new Date().getTimezoneOffset()): string[] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid time "${time}". Use HH:MM, e.g. 12:30`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${time}".`);
  const hoursByMinuteAndWeekday = new Map<number, Map<number, Set<number>>>();
  for (let offset = 0; offset <= 300; offset += 30) {
    const localMinutes = hour * 60 + minute + offset;
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

function shiftTime(time: string, minutes: number): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid time "${time}". Use HH:MM, e.g. 12:30`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${time}".`);
  const shifted = (hour * 60 + minute + minutes + 1440) % 1440;
  return `${String(Math.floor(shifted / 60)).padStart(2, "0")}:${String(shifted % 60).padStart(2, "0")}`;
}

function workflowYaml(config: CloudConfig, version: string): string {
  const primarySchedules = cronFor(config.time);
  // GitHub can delay or drop scheduled events at busy times. The one-minute
  // fallback keeps this cloud-only and lets cloudRun's due check handle it.
  const fallbackSchedules = cronFor(shiftTime(config.time, 1));
  return `# Generated by kalvium-worklog. Run kalvium-worklog cloud sync to update.
name: Kalvium worklog
on:
  schedule:
${[...primarySchedules, ...fallbackSchedules].map((cron) => `    - cron: "${cron}"`).join("\n")}
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
      KATTEND_TOKEN_JSON: \${{ secrets.${SECRET_TOKEN} }}
      KATTEND_CONFIG_JSON: \${{ secrets.${SECRET_CONFIG} }}
      GH_TOKEN: \${{ secrets.${SECRET_PAT} }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Submit daily worklog
        run: npx --yes kalvium-worklog@${version} cloud run
`;
}

function putWorkflow(repo: string, content: string): void {
  const api = `repos/${repo}/contents/${WORKFLOW_PATH}`;
  const existingSha = gh(["api", api, "--jq", ".sha"]);
  const args = [
    "api", "-X", "PUT", api,
    "-f", "message=Update Kalvium worklog workflow",
    "-f", `content=${Buffer.from(content).toString("base64")}`,
  ];
  if (existingSha.status === 0 && existingSha.stdout.trim()) {
    args.push("-f", `sha=${existingSha.stdout.trim()}`);
  }
  runGh(args);
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
  putWorkflow(repo, workflowYaml(config, options.version));
  saveCloudMetadata(repo, options.email);
  setupCloudRepairScheduler(options.cliPath, options.version);
  console.log(`Cloud worklog enabled for ${repo} at ${config.time} ${config.timezone}.`);
}

export async function cloudSync(options: {
  cliPath: string;
  version: string;
  login?: boolean;
  email?: string;
}): Promise<void> {
  requireGh();
  const repo = requireRepo();
  if (options.login) {
    cloudLogin(options.cliPath, options.email || readCloudConfig()?.email);
    const tokenFile = path.join(CLOUD_HOME, "refresh_token.json");
    setSecret(repo, SECRET_TOKEN, fs.readFileSync(tokenFile, "utf8"));
  }
  const config = currentCloudConfig(repo);
  setSecret(repo, SECRET_CONFIG, secretConfig(config));
  putWorkflow(repo, workflowYaml(config, options.version));
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
  if (!authFailure) {
    dispatchRetry(`Cloud run ${latest.databaseId} failed without an authentication error`);
    return;
  }

  const attemptedAt = state.attemptedAt ? Date.parse(state.attemptedAt) : 0;
  if (state.attemptedRunId === latest.databaseId || Date.now() - attemptedAt < 6 * 60 * 60 * 1000) {
    return;
  }

  ensureInstallDir();
  saveRecoveryState({ ...state, attemptedRunId: latest.databaseId, attemptedAt: new Date().toISOString() });
  log(`Cloud login failed in GitHub run ${latest.databaseId}; attempting browser re-login.`);
  try {
    cloudLogin(options.cliPath, readCloudConfig()?.email);
    const tokenFile = path.join(CLOUD_HOME, "refresh_token.json");
    const token = fs.readFileSync(tokenFile, "utf8");
    setSecret(repo, SECRET_TOKEN, token);
    const config = currentCloudConfig(repo);
    setSecret(repo, SECRET_CONFIG, secretConfig(config));
    putWorkflow(repo, workflowYaml(config, options.version));
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

export async function cloudRun(): Promise<void> {
  const tokenJson = process.env.KATTEND_TOKEN_JSON;
  const configJson = process.env.KATTEND_CONFIG_JSON;
  if (!tokenJson || !configJson) throw new Error("Cloud token/config secrets are missing. Run cloud sync --login.");
  const config = JSON.parse(configJson) as Partial<CloudConfig>;
  const mappedConfig = {
    position_id: config.position_id,
    worklog_api_url: config.worklog_api_url,
  };
  if (!mappedConfig.position_id || !mappedConfig.worklog_api_url) {
    throw new Error("Cloud config is missing the internship position or worklog URL.");
  }
  ensureInstallDir();
  fs.writeFileSync(TOKEN_FILE, tokenJson, { mode: 0o600 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(mappedConfig), { mode: 0o600 });

  const scheduled = /^(\d{1,2}):(\d{2})$/.exec(config.time || "12:30");
  if (scheduled) {
    const now = new Date();
    const due = Number(scheduled[1]) * 60 + Number(scheduled[2]);
    if (now.getHours() * 60 + now.getMinutes() < due) {
      console.log("Not due yet; the next scheduled check will retry.");
      return;
    }
  }

  const submitted = await dailySubmit({ allowInteractiveLogin: false });
  const updatedToken = fs.readFileSync(TOKEN_FILE, "utf8");
  if (updatedToken !== tokenJson) {
    const repo = process.env.GITHUB_REPOSITORY || requireRepo();
    if (!process.env.GH_TOKEN) throw new Error(`Token rotated but cannot be saved; configure ${SECRET_PAT}.`);
    setSecret(repo, SECRET_TOKEN, updatedToken);
    console.log("Saved rotated Kalvium token.");
  }
  if (!submitted) throw new Error("Worklog cloud run failed; see the log output above.");
}
