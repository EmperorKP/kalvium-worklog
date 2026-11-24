#!/usr/bin/env node

/**
 * Daily auto-submit entry point (used by launchd/Task Scheduler/cron).
 * Skips weekends. Auto re-logins if token expired.
 */
import { dailySubmit } from "./submit.js";

dailySubmit().then((ok) => {
  process.exit(ok ? 0 : 1);
});
