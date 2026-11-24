import { homedir } from "os";
import { join } from "path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";

export const INSTALL_DIR = process.env.KWORKLOG_HOME || join(homedir(), ".kalvium");
export const PROFILE_DIR =
  process.env.KWORKLOG_PROFILE_DIR ||
  (process.env.KWORKLOG_HOME
    ? join(INSTALL_DIR, "browser-profile")
    : join(homedir(), ".kalvium_profile"));
export const TOKEN_FILE = join(INSTALL_DIR, "refresh_token.json");
export const CONFIG_FILE = join(INSTALL_DIR, "config.json");
export const LOG_FILE = join(INSTALL_DIR, "worklog.log");
export const SCHEDULE_FILE = join(INSTALL_DIR, "schedule.json");
export const CATCHUP_STATE_FILE = join(INSTALL_DIR, "catchup-state.json");

export const KEYCLOAK_URL =
  "https://auth.kalvium.community/auth/realms/kalvium/protocol/openid-connect/token";
export const CLIENT_ID = "login_client";
export const API_BASE =
  "https://student-api.kalvium.community/api/internships/worklogs";

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
  session_state?: string;
}

export interface ConfigData {
  position_id: string;
  worklog_api_url: string;
}

export function ensureInstallDir(): void {
  if (!existsSync(INSTALL_DIR)) {
    mkdirSync(INSTALL_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(INSTALL_DIR, 0o700);
  } catch {
    // Permissions are best effort on platforms without POSIX file modes.
  }
}

export function loadToken(): TokenData | null {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveToken(data: TokenData): void {
  ensureInstallDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2));
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Permissions are best effort on platforms without POSIX file modes.
  }
}

export function loadConfig(): ConfigData | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

export function saveConfig(config: ConfigData): void {
  ensureInstallDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Permissions are best effort on platforms without POSIX file modes.
  }
}

export function getLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface ScheduleData {
  hour: number;
  minute: number;
}

export function loadSchedule(): ScheduleData | null {
  try {
    return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8")) as ScheduleData;
  } catch {
    return null;
  }
}

export function saveSchedule(schedule: ScheduleData): void {
  ensureInstallDir();
  writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), { mode: 0o600 });
}

export function getCatchupDate(): string | null {
  try {
    const state = JSON.parse(readFileSync(CATCHUP_STATE_FILE, "utf-8")) as { date?: string };
    return state.date ?? null;
  } catch {
    return null;
  }
}

export function setCatchupDate(date: string): void {
  ensureInstallDir();
  writeFileSync(CATCHUP_STATE_FILE, JSON.stringify({ date }), { mode: 0o600 });
}

export function getWorklogApi(): string | null {
  const config = loadConfig();
  return config?.worklog_api_url ?? null;
}

export function log(message: string): void {
  ensureInstallDir();
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `${timestamp} ${message}\n`;
  try {
    writeFileSync(LOG_FILE, line, { flag: "a" });
  } catch {
    // ignore log errors
  }
  console.log(message);
}

// ─── JWT decode ──────────────────────────────────────────────────────────

export function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    const decoded = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function getPositionIdFromToken(token: TokenData): string | null {
  const payload = decodeJwt(token.access_token);
  return (payload?.sub as string) ?? null;
}
