# kalvium-worklog

Auto-submit your daily [Kalvium](https://kalvium.community) worklog without opening the website.

## Install

```bash
npm install -g kalvium-worklog
```

## Quick Start

```bash
# Full setup (login + discover position + schedule)
kalvium-worklog install

# Or step by step:
kalvium-worklog login       # log in via browser (Google + 2FA)
kalvium-worklog login --email you@example.com  # select an account at Google's chooser
kalvium-worklog discover    # auto-discover your position ID
kalvium-worklog schedule 14:00  # daily auto-submit at 2 PM
```

## Commands

| Command | Description |
|---------|-------------|
| `kalvium-worklog install` | Full setup: login + discover + schedule |
| `kalvium-worklog login` | Log in to Kalvium (opens browser, waits for Google + 2FA) |
| `kalvium-worklog discover` | Auto-discover your internship position ID |
| `kalvium-worklog submit [text]` | Submit worklog (default: "Working on assigned task") |
| `kalvium-worklog submit "built a feature"` | Submit with custom text |
| `kalvium-worklog submit --dry-run` | Test without submitting |
| `kalvium-worklog status` | Check recent worklog entries |
| `kalvium-worklog schedule 14:00` | Set up daily auto-submit at 2 PM |
| `kalvium-worklog schedule --remove` | Remove daily auto-submit |
| `kalvium-worklog daily` | Run daily submit (used by scheduler) |
| `kalvium-worklog catchup` | Check if today's worklog is missing and submit if needed |
| `kalvium-worklog trigger` | Run the safe catch-up check immediately |
| `kalvium-worklog cloud init` | Set up the GitHub Actions runner in a private repo |
| `kalvium-worklog cloud sync [--login]` | Update cloud settings; `--login` captures a fresh cloud token |
| `kalvium-worklog cloud status` | Show recent GitHub Actions runs |
| `kalvium-worklog cloud test` | Start a manual cloud run |
| `kalvium-worklog cloud monitor --remove` | Remove the macOS cloud-login recovery monitor |

## Features

- **Cross-platform**: macOS (launchd), Windows (Task Scheduler), Linux (cron)
- **Automatic re-login attempt**: If a refresh token expires, the scheduled task opens the persistent browser profile and retries automatically when the existing Google session is still valid
- **Token auto-refresh**: Refresh token rotates on each use, lasts 6 days
- **Auto-discovers position ID**: Works for any user, no hardcoded IDs
- **Weekend skipping**: Auto-submit skips Saturdays and Sundays
- **Network retry**: Retries up to 5 times on network failure (covers laptop waking up, internet reconnecting)
- **Catch-up on wake**: If the scheduled time was missed (laptop asleep/offline), submits when the device wakes up
- **GitHub Actions mode**: Runs while your Mac is off and saves rotated refresh tokens back to GitHub Secrets
- **Cloud login recovery**: A macOS LaunchAgent checks failed cloud runs every 30 minutes and attempts a browser re-login when the refresh token is rejected

## How It Works

```
One-time setup:
  Browser login → capture refresh token → discover position ID

Daily auto-submit (scheduler):
  Refresh token → PUT worklog API → done
  If token expired → open persistent browser → capture a new token → retry
  If network fails → retry up to 5 times (1 min apart)

Catch-up (on login/wake, every 30 min):
  Check if today's worklog is submitted → if not, submit it

Cloud mode (optional):
  GitHub Actions checks every 30 min around the chosen time
  Transient network failures retry up to 5 times (1 min apart)
  Rotated refresh token is written back to the private repo's KATTEND_TOKEN secret
```

## GitHub Actions mode

Install and configure the local login, position, and schedule first. Then authenticate the GitHub CLI and run:

```bash
gh auth login
kalvium-worklog cloud init --repo owner/kalvium-attendance-cloud
```

Cloud setup performs a separate Kalvium login and creates or updates a private repository workflow. It prompts for a fine-grained GitHub token restricted to that repository with **Secrets: read and write** permission. The token is entered in a hidden prompt and stored as `KATTEND_PAT`; the Kalvium refresh token and worklog configuration are stored as `KATTEND_TOKEN` and `KATTEND_CONFIG`.

Use `kalvium-worklog cloud sync` after changing the local schedule or configuration. Use `kalvium-worklog cloud sync --login` to refresh the cloud login and replace its token secret. When you sync, macOS installs a local monitor that watches for failed cloud authentication and attempts a browser re-login with the saved Google session. If Google requires a password, two-step verification, or consent, finish that in the opened browser window. Remove the monitor with `kalvium-worklog cloud monitor --remove`.

## Token Lifecycle

- **Access token**: 3 days
- **Refresh token**: 6 days, rotates on each use
- As long as you submit at least once every 6 days, the token never expires
- If expired: `kalvium-worklog login` (or it auto-triggers)

## Files

```
~/.kalvium/
├── refresh_token.json    # Current token (auto-rotates)
├── config.json           # Position ID + API URL
├── daily_submit.js       # Scheduler entry point
├── catchup_submit.js     # Catch-up entry point
└── worklog.log           # Log file

~/.kalvium_profile/       # Browser profile (saved login)
```

## Uninstall

```bash
kalvium-worklog schedule --remove
npm uninstall -g kalvium-worklog
rm -rf ~/.kalvium ~/.kalvium_profile
```

## Requirements

- Node.js 18+
- npm

## License

MIT
