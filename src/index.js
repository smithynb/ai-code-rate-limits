#!/usr/bin/env node

import { loadConfig, needsSetup, runSetup } from './config.js';
import { renderResults, renderLoading, clearLoading } from './ui.js';
import { runConfigMenu } from './interactive.js';
import * as claude from './providers/claude.js';
import * as codex from './providers/codex.js';
import * as copilot from './providers/copilot.js';
import * as gemini from './providers/gemini.js';
import * as antigravity from './providers/antigravity.js';

const args = process.argv.slice(2);
const wantSetup = args.includes('--setup');
const wantConfig = args.includes('--config') || args.includes('-config');
const wantJson = args.includes('--json');
const wantHelp = args.includes('--help') || args.includes('-h');
export const debug = args.includes('--debug');

if (wantHelp) {
    console.log(`
  \x1b[1mai-limits\x1b[0m — Check rate limits across AI coding tools

  \x1b[1mUsage:\x1b[0m
    node src/index.js             Check all providers
    node src/index.js --config    Open interactive settings (toggle providers, re-auth)
    node src/index.js --setup     Configure Copilot PAT / re-run setup
    node src/index.js --json      Output results as JSON
    node src/index.js --help      Show this help

  \x1b[1mProviders:\x1b[0m
    Claude Code    Auto-detected from ~/.claude/.credentials.json
    Codex          Auto-detected from ~/.codex/auth.json
    Gemini CLI     Auto-detected from ~/.gemini/oauth_creds.json
    Copilot        Requires GitHub PAT (configure via --setup or --config)
    Antigravity    Auto-detected from running process

  \x1b[1mSettings:\x1b[0m
    Use \x1b[1m--config\x1b[0m to hide providers you don't use and manage credentials.
`);
    process.exit(0);
}

// ── Interactive config menu ────────────────────────────────────────────────────
if (wantConfig) {
    await runConfigMenu();
    process.exit(0);
}

// ── First-time setup ──────────────────────────────────────────────────────────
if (wantSetup || needsSetup()) {
    await runSetup();
    if (wantSetup) process.exit(0);
}

const config = loadConfig();
const hiddenProviders = config.hiddenProviders || [];

// ── Check providers ───────────────────────────────────────────────────────────
if (!wantJson) renderLoading();

// Map provider name → check function (pass config where needed)
const allProviders = [
    { name: 'Claude Code', fn: () => claude.check() },
    { name: 'Codex', fn: () => codex.check() },
    { name: 'GitHub Copilot', fn: () => copilot.check(config) },
    { name: 'Gemini CLI', fn: () => gemini.check() },
    { name: 'Antigravity', fn: () => antigravity.check() },
];

const visibleProviders = allProviders.filter(
    (p) => !hiddenProviders.includes(p.name)
);

const results = await Promise.all(visibleProviders.map((p) => p.fn()));

if (!wantJson) clearLoading();

// ── Output ────────────────────────────────────────────────────────────────────
if (wantJson) {
    console.log(JSON.stringify(results, null, 2));
} else {
    if (hiddenProviders.length > 0) {
        const dimmed = `\x1b[2m`;
        const reset = `\x1b[0m`;
        process.stderr.write(`  ${dimmed}(${hiddenProviders.length} provider${hiddenProviders.length > 1 ? 's' : ''} hidden — run --config to change)${reset}\n`);
    }
    renderResults(results);
}
