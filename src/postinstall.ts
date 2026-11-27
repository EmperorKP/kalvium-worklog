/**
 * Postinstall script — runs automatically after `npm install kalvium-worklog`.
 *
 * If the package is installed globally, prompts the user to run setup.
 * If installed locally (as a dependency), just prints info.
 *
 * IMPORTANT: This must not block or require user input during npm install
 * in CI environments. It only prints guidance.
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TOKEN_FILE = join(homedir(), ".kalvium", "refresh_token.json");
const CONFIG_FILE = join(homedir(), ".kalvium", "config.json");

// Detect if this is a global install
const isGlobal = process.env.npm_config_global === "true";
// Don't run postinstall in CI or during npm publish
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

if (isCI) {
  process.exit(0);
}

// Use stderr for output — npm suppresses stdout from lifecycle scripts
// but stderr is always shown
const log = (msg: string) => console.error(msg);

const GREEN = "\x1b[0;32m";
const CYAN = "\x1b[0;36m";
const YELLOW = "\x1b[1;33m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

log("");
log(CYAN + "==".repeat(25) + NC);
log(CYAN + "   " + BOLD + "Kalvium Worklog" + NC + CYAN + " installed successfully!" + " ".repeat(7) + NC);
log(CYAN + "==".repeat(25) + NC);
log("");

const alreadySetup = existsSync(TOKEN_FILE) && existsSync(CONFIG_FILE);

if (alreadySetup) {
  log(GREEN + "OK" + NC + " You are already set up!");
  log("");
  log("  Quick commands:");
  log("    " + BOLD + "kalvium-worklog submit" + NC + "              submit worklog");
  log("    " + BOLD + "kalvium-worklog status" + NC + "              check status");
  log("");
} else if (isGlobal) {
  log("  To get started, run:");
  log("");
  log("    " + BOLD + "kalvium-worklog install" + NC);
  log("");
  log("  This will:");
  log("    1. Open a browser for you to log in to Kalvium");
  log("    2. Auto-discover your internship position ID");
  log("    3. Set up daily auto-submit at your chosen time");
  log("");
  log("  Or set up step by step:");
  log("    " + BOLD + "kalvium-worklog login" + NC + "       log in");
  log("    " + BOLD + "kalvium-worklog discover" + NC + "    find position ID");
  log("    " + BOLD + "kalvium-worklog schedule 14:00" + NC + "  daily at 2 PM");
  log("");
} else {
  // Local install — use npx
  log("  To get started, run:");
  log("");
  log("    " + BOLD + "npx kalvium-worklog install" + NC);
  log("");
  log("  Or install globally first:");
  log("    " + BOLD + "npm install -g kalvium-worklog" + NC);
  log("    " + BOLD + "kalvium-worklog install" + NC);
  log("");
}

log("  Docs: " + YELLOW + "https://github.com/EmperorKP/kalvium-worklog" + NC);
log("");
