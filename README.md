# AI Code Tool Rate Limit Checker

A zero-dependency CLI tool that checks the remaining rate limits / quota across your AI coding tools — all at once, from a single command.

```
  AI Code Tool Rate Limits  8:42:31 PM

╭─ Claude Code (Pro) ────────────────────────────────────────────╮
│ Session (5h):  ████████░░  82% remaining  (Resets in 1h 7m)    │
│ Weekly (7d):   ██████░░░░  63% remaining  (Resets in 4d 2h)    │
╰────────────────────────────────────────────────────────────────╯

╭─ Codex (Pro) ──────────────────────────────────────────────────╮
│ Session:       ██████████  97% remaining  (Resets in 3h 12m)   │
│ Weekly:        ████████░░  78% remaining  (Resets in 5d 18h)   │
╰────────────────────────────────────────────────────────────────╯

╭─ GitHub Copilot (Billing API) ─────────────────────────────────╮
│ Premium:       ██████░░░░  187/300 left  (Resets in 14d 3h)    │
╰────────────────────────────────────────────────────────────────╯
```

## Features

- **Multi-provider** — checks Claude Code, OpenAI Codex, GitHub Copilot, Gemini CLI, and Antigravity in parallel
- **Auto-discovery** — most providers are detected automatically from their local credential files; no manual config required
- **Token refresh** — automatically refreshes expired OAuth tokens for Claude Code and Codex when possible
- **Interactive settings** — hide providers you don't use, re-configure Copilot credentials, all from a TUI menu
- **JSON output** — pipe results into other tools with `--json`
- **Debug mode** — `--debug` flag prints raw API responses for troubleshooting
- **WSL support** — falls back to Windows `curl.exe` / PowerShell for providers that don't respond correctly from inside WSL

## Requirements

- Node.js 18+ (uses native `fetch` and ES modules)
- No npm install needed — zero runtime dependencies

## Usage

```sh
node src/index.js              # Check all (visible) providers
node src/index.js --config     # Open interactive settings (toggle providers, re-auth)
node src/index.js --setup      # Re-run GitHub Copilot setup wizard
node src/index.js --json       # Output results as JSON
node src/index.js --debug      # Show raw API responses for troubleshooting
node src/index.js --help       # Show help
```

You can also link it globally so you can run `ai-limits` from anywhere:

```sh
npm link
ai-limits
```

## Providers

### Auto-discovered (no setup needed)

| Provider | Credential file read | Proven working |
|---|---|---|
| **Claude Code** | `~/.claude/.credentials.json` | ⚠️ Not confirmed |
| **Codex** (OpenAI) | `~/.codex/auth.json` | ✅ Yes |
| **Gemini CLI** | `~/.gemini/oauth_creds.json` | ✅ Yes |
| **Antigravity** | Running process (CSRF token from CLI args) | ⚠️ Partial |

> These providers require no configuration — just make sure you're already signed in to the corresponding CLI tool.

> **Antigravity note:** Only tested with `ai-limits` running inside WSL while Antigravity is running on the Windows host. Native Windows and macOS/Linux configurations are implemented but unconfirmed.

### Requires manual setup

| Provider | How | Proven working |
|---|---|---|
| **GitHub Copilot** | GitHub Personal Access Token (PAT) | ⚠️ Partial — see note below |

#### GitHub Copilot Setup

Run the setup wizard to enter your credentials:

```sh
node src/index.js --setup
```

You will be prompted for:

1. **GitHub username** — your GitHub login (e.g. `octocat`)
2. **GitHub PAT** — a Personal Access Token with billing read permissions
3. **Monthly limit** — your monthly premium request quota (default: `300` for Copilot Pro)

**Recommended PAT type:** Fine-grained PAT with the `Plan: Read` permission under **User** permissions.

- Create a fine-grained PAT: https://github.com/settings/personal-access-tokens/new
- Create a classic PAT: https://github.com/settings/tokens/new

Credentials are stored locally at `~/.ratelimit-checker/config.json` and are never transmitted anywhere except to the official GitHub Billing API.

> **Note on Copilot API availability:** The GitHub Billing API endpoint used (`/users/{username}/settings/billing/premium_request/usage`) is not consistently available for all account types. Accounts billed through an organization or enterprise, or accounts on certain plans, may receive 404 errors. This is a GitHub API limitation, not a tool bug.

## Configuration

Config is stored at `~/.ratelimit-checker/config.json`. It is created automatically on first run or after running `--setup`.

```json
{
  "copilot": {
    "githubUsername": "your-username",
    "githubToken": "github_pat_...",
    "monthlyLimit": 300
  },
  "hiddenProviders": []
}
```

- **`hiddenProviders`** — list of provider names to skip during checks (managed via `--config` TUI)
- **`monthlyLimit`** — your Copilot monthly premium request cap (300 for Pro, adjust if on a higher plan)

### Interactive Settings (`--config`)

The `--config` flag opens a terminal UI for managing settings without editing the JSON file:

- **↑ / ↓** — navigate
- **Space** or **Enter** — toggle provider visibility
- **Enter** — confirm selection / trigger action
- **q** or **Esc** — exit without saving

## How it works

Each provider module reads credentials from the same local files used by the official CLI tools, then calls the provider's usage/quota API. Credentials are never sent anywhere except the provider's own official endpoints.

| Provider | Data source |
|---|---|
| Claude Code | `~/.claude/.credentials.json` → `api.anthropic.com/api/oauth/usage` |
| Codex | `~/.codex/auth.json` → `chatgpt.com/backend-api/wham/usage` |
| Gemini CLI | `~/.gemini/oauth_creds.json` → `cloudcode-pa.googleapis.com` |
| GitHub Copilot | PAT from config → `api.github.com/users/{username}/settings/billing/premium_request/usage` |
| Antigravity | CSRF token from live process args → localhost language server API |

## License

MIT
