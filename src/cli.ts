#!/usr/bin/env node

import { Command } from "commander";
import { captureToken } from "./capture-token.js";
import { discoverPosition } from "./discover-position.js";
import { submitWorklog, checkStatus, dailySubmit, catchUpSubmit } from "./submit.js";
import { setupScheduler, removeScheduler } from "./scheduler.js";
import { loadToken, saveConfig, getPositionIdFromToken } from "./config.js";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { cloudInit, cloudMonitorRemove, cloudRun, cloudStatus, cloudSync, cloudTest } from "./cloud.js";

// Read version from package.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = pkg.version;

const program = new Command();

program
  .name("kalvium-worklog")
  .description("Auto-submit your daily Kalvium worklog")
  .version(VERSION);

// ─── login ─────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Log in to Kalvium and capture refresh token (opens browser)")
  .option("--email <email>", "Google account to select when the account chooser appears")
  .action(async (opts: { email?: string }) => {
    const ok = await captureToken({ email: opts.email });
    if (!ok) process.exit(1);
  });

// ─── discover ──────────────────────────────────────────────────────────────

program
  .command("discover")
  .description("Auto-discover your internship position ID")
  .action(async () => {
    const ok = await discoverPosition();
    if (!ok) process.exit(1);
  });

// ─── submit ────────────────────────────────────────────────────────────────

program
  .command("submit [text]")
  .description("Submit worklog (default text: 'Working on assigned task')")
  .option("--dry-run", "Test without submitting")
  .action(async (text: string | undefined, opts: { dryRun?: boolean }) => {
    // Skip weekends (unless dry run)
    const day = new Date().getDay();
    if ((day === 0 || day === 6) && !opts.dryRun) {
      console.log("It's a weekend — skipping.");
      return;
    }

    const result = await submitWorklog({
      text: text ?? "Working on assigned task",
      dryRun: opts.dryRun,
    });

    if (!result.success) {
      console.log(`ERROR: ${result.message}`);
      process.exit(1);
    }
  });

// ─── status ────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Check recent worklog entries")
  .action(async () => {
    await checkStatus();
  });

// ─── daily ─────────────────────────────────────────────────────────────────

program
  .command("daily")
  .description("Run daily auto-submit (used by scheduler — skips weekends, retries on network failure)")
  .action(async () => {
    const ok = await dailySubmit();
    if (!ok) process.exit(1);
  });

// ─── catchup ───────────────────────────────────────────────────────────────

program
  .command("catchup")
  .description("Check if today's worklog is missing and submit if needed (runs on login/wake)")
  .action(async () => {
    const ok = await catchUpSubmit();
    if (!ok) process.exit(1);
  });

// ─── trigger ───────────────────────────────────────────────────────────────

program
  .command("trigger")
  .description("Run the safe catch-up check now (submits only if today's worklog is missing)")
  .action(async () => {
    const ok = await catchUpSubmit();
    if (!ok) process.exit(1);
  });

// ─── cloud ────────────────────────────────────────────────────────────────

program
  .command("cloud <action>")
  .description("Run worklog automation from GitHub Actions while your Mac is off")
  .option("--repo <name>", "private GitHub repository name or owner/name")
  .option("--email <email>", "Google account for unattended account-chooser selection")
  .option("--reuse", "reuse the separately saved cloud login")
  .option("--login", "refresh the separate cloud login during sync")
  .option("--remove", "remove the local cloud recovery monitor (for cloud monitor)")
  .action(async (action: string, opts: { repo?: string; email?: string; reuse?: boolean; login?: boolean; remove?: boolean }) => {
    const cliPath = join(__dirname, "cli.js");
    switch (action) {
      case "init":
        await cloudInit({ cliPath, version: VERSION, repoName: opts.repo, reuse: opts.reuse, email: opts.email });
        return;
      case "run":
        await cloudRun();
        return;
      case "sync":
        await cloudSync({ cliPath, version: VERSION, login: opts.login, email: opts.email });
        return;
      case "status":
        cloudStatus();
        return;
      case "test":
        cloudTest();
        return;
      case "monitor":
        if (opts.remove) cloudMonitorRemove();
        else await cloudSync({ cliPath, version: VERSION, email: opts.email });
        return;
      default:
        console.error("Use: kalvium-worklog cloud init | run | sync [--login] | status | test | monitor [--remove]");
        process.exitCode = 1;
    }
  });

// ─── schedule ──────────────────────────────────────────────────────────────

program
  .command("schedule [time]")
  .description("Set up daily auto-submit (e.g. '14:00' for 2 PM)")
  .option("--remove", "Remove the scheduled task")
  .action(async (time: string | undefined, opts: { remove?: boolean }) => {
    if (opts.remove) {
      await removeScheduler();
      return;
    }

    let hour = 14;
    let minute = 0;

    if (time) {
      const match = time.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        console.log("Invalid time format. Use HH:MM (e.g. 14:00 for 2 PM)");
        process.exit(1);
      }
      hour = parseInt(match[1], 10);
      minute = parseInt(match[2], 10);

      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        console.log("Invalid time. Hour: 0-23, Minute: 0-59");
        process.exit(1);
      }
    } else {
      // Interactive prompt
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      const hourInput = await ask("Enter hour (24-hour, e.g. 14 for 2 PM) [14]: ");
      const minuteInput = await ask("Enter minute [0]: ");
      rl.close();

      hour = parseInt(hourInput || "14", 10);
      minute = parseInt(minuteInput || "0", 10);

      if (isNaN(hour) || hour < 0 || hour > 23) {
        console.log("Invalid hour, defaulting to 14 (2 PM)");
        hour = 14;
      }
      if (isNaN(minute) || minute < 0 || minute > 59) {
        console.log("Invalid minute, defaulting to 0");
        minute = 0;
      }
    }

    const ok = await setupScheduler({ hour, minute });
    if (!ok) process.exit(1);
  });

// ─── install (full setup) ──────────────────────────────────────────────────

program
  .command("install")
  .description("Full setup: login + discover + schedule")
  .action(async () => {
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (q: string): Promise<string> =>
      new Promise((resolve) => rl.question(q, resolve));

    console.log("\n🚀 Kalvium Worklog — Full Setup\n");

    // Step 1: Login
    console.log("── Step 1: Log in ──");
    console.log("A browser will open. Log in with Google + 2FA if needed.\n");
    const loginOk = await captureToken();
    if (!loginOk) {
      console.log("Login failed. Try again with `kalvium-worklog login`");
      rl.close();
      process.exit(1);
    }

    // Step 2: Discover position ID from the token we just captured
    // (No need to open browser again — the position ID is in the JWT)
    console.log("\n── Step 2: Discover position ID ──");
    const token = loadToken();
    if (!token) {
      console.log("ERROR: No token found after login.");
      rl.close();
      process.exit(1);
    }

    const positionId = getPositionIdFromToken(token);
    if (!positionId) {
      // Fallback: try browser-based discovery if JWT doesn't have it
      console.log("Could not extract from token. Trying browser discovery...");
      const discoverOk = await discoverPosition();
      if (!discoverOk) {
        console.log("Discovery failed. Try again with `kalvium-worklog discover`");
        rl.close();
        process.exit(1);
      }
    } else {
      const worklogUrl = `https://student-api.kalvium.community/api/internships/worklogs/${positionId}`;
      saveConfig({ position_id: positionId, worklog_api_url: worklogUrl });
      console.log(`Position ID: ${positionId}`);
      console.log(`Worklog API: ${worklogUrl}`);
    }

    // Step 3: Schedule
    console.log("\n── Step 3: Set up daily auto-submit ──");
    const timeInput = await ask("What time? (HH:MM, e.g. 14:00 for 2 PM) [14:00]: ");
    rl.close();

    let hour = 14;
    let minute = 0;
    if (timeInput.trim()) {
      const match = timeInput.trim().match(/^(\d{1,2}):(\d{2})$/);
      if (match) {
        hour = parseInt(match[1], 10);
        minute = parseInt(match[2], 10);
      }
    }

    await setupScheduler({ hour, minute });

    console.log("\n✅ Setup complete!\n");
    console.log("Commands:");
    console.log("  kalvium-worklog submit              # submit with default text");
    console.log("  kalvium-worklog submit 'my update'  # custom text");
    console.log("  kalvium-worklog status              # check status");
    console.log("  kalvium-worklog schedule --remove   # stop automation");
    console.log("");
  });

// ─── Default: show help ────────────────────────────────────────────────────

if (process.argv.length <= 2) {
  // Check if already set up
  const tokenExists = existsSync(join(homedir(), ".kalvium", "refresh_token.json"));
  const configExists = existsSync(join(homedir(), ".kalvium", "config.json"));

  if (!tokenExists || !configExists) {
    console.log("");
    console.log("  Welcome to Kalvium Worklog!");
    console.log("");
    console.log("  You haven't set up yet. Run:");
    console.log("");
    console.log("    kalvium-worklog install");
    console.log("");
    console.log("  This will log you in, discover your position ID,");
    console.log("  and set up daily auto-submit.");
    console.log("");
    console.log("  Or run kalvium-worklog --help to see all commands.");
    console.log("");
  } else {
    program.help();
  }
  process.exit(0);
}

program.parse();
