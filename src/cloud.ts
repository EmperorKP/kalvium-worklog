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

export function cronFor(time: string, offsetMin = new Date().getTimezoneOffset()): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid time "${time}". Use HH:MM, e.g. 12:30`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time "${time}".`);
  const hours = new Set<number>();
  const base = hour * 60 + minute + offsetMin;
  for (let offset = -30; offset <= 240; offset += 30) {
    const utcMinutes = ((base + offset) % 1440 + 1440) % 1440;
    hours.add(Math.floor(utcMinutes / 60));
  }
  return `7,37 ${[...hours].sort((a, b) => a - b).join(",")} * * *`;
}

function workflowYaml(config: CloudConfig, version: string): string {
  return `# Generated by kalvium-worklog. Run kalvium-worklog cloud sync to update.
name: Kalvium worklog
on:
  schedule:
    - cron: "${cronFor(config.time)}"
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
 * Called by the Mac LaunchAgent. If a cloud run failed specifically because
 * Kalvium rejected its refresh token, reuse the saved Google browser session
 * and replace the cloud token secret. A six-hour cooldown prevents login loops.
 */
export async function cloudMonitor(options: { cliPath: string; version: string }): Promise<void> {
  const repo = readCloudConfig()?.cloudRepo;
  if (!repo) return;
  requireGh();

  const list = gh([
    "run", "list", "--repo", repo, "--workflow", "attendance.yml", "--limit", "1",
    "--json", "databaseId,status,conclusion",
  ]);
  if (list.status !== 0) throw new Error((list.stderr || "Could not read recent cloud runs.").trim());
  const runs = JSON.parse(list.stdout || "[]") as Array<{
    databaseId: number;
    status: string;
    conclusion: string | null;
  }>;
  const latest = runs[0];
  if (!latest || latest.status !== "completed" || latest.conclusion !== "failure") return;

  const runLog = gh(["run", "view", String(latest.databaseId), "--repo", repo, "--log-failed"]);
  if (runLog.status !== 0) return;
  const authFailure = /authentication expired|session expired or invalid|refresh token.{0,40}(invalid|expired)|HTTP 401|HTTP 403/i.test(runLog.stdout);
  if (!authFailure) return;

  const state = readRecoveryState();
  const attemptedAt = state.attemptedAt ? Date.parse(state.attemptedAt) : 0;
  if (state.attemptedRunId === latest.databaseId || Date.now() - attemptedAt < 6 * 60 * 60 * 1000) {
    return;
  }

  ensureInstallDir();
  saveRecoveryState({ attemptedRunId: latest.databaseId, attemptedAt: new Date().toISOString() });
  log(`Cloud login failed in GitHub run ${latest.databaseId}; attempting browser re-login.`);
  try {
    cloudLogin(options.cliPath, readCloudConfig()?.email);
    const tokenFile = path.join(CLOUD_HOME, "refresh_token.json");
    const token = fs.readFileSync(tokenFile, "utf8");
    setSecret(repo, SECRET_TOKEN, token);
    const config = currentCloudConfig(repo);
    setSecret(repo, SECRET_CONFIG, secretConfig(config));
    putWorkflow(repo, workflowYaml(config, options.version));
    saveRecoveryState({});
    log("Cloud login refreshed and saved. GitHub Actions will retry on its next scheduled check.");
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
