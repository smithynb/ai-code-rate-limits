import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.ratelimit-checker');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  copilot: {
    githubUsername: '',
    githubToken: '',
    monthlyLimit: 300,
  },
  // Provider names listed here will be skipped during checks
  hiddenProviders: [],
};

/**
 * Load config from disk, or return defaults if not found.
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {
    // Corrupted config, fall through to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to disk.
 */
export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Check if initial setup is needed (no config file or missing Copilot creds).
 */
export function needsSetup() {
  return !fs.existsSync(CONFIG_FILE);
}

/**
 * Interactive setup prompt.
 */
export async function runSetup() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // Use stderr so stdout stays clean for piping
  });

  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });

  console.error('\n\x1b[1m🔧 AI Rate Limit Checker — First-Time Setup\x1b[0m\n');
  console.error('This tool checks rate limits for Claude Code, Codex, Gemini CLI,');
  console.error('GitHub Copilot, and Antigravity. Most providers auto-discover credentials.');
  console.error('Only GitHub Copilot requires manual configuration.\n');

  const config = loadConfig();

  console.error('\x1b[1m── GitHub Copilot Setup ──\x1b[0m');
  console.error('To check Copilot premium request usage, create a GitHub PAT with billing read access.');
  console.error('Recommended: fine-grained PAT with User permission `Plan: Read`.');
  console.error('Tip: Copilot Pro includes 300 premium requests/month, so set your monthly limit accordingly.');
  console.error('Token pages:');
  console.error('  \x1b[36mhttps://github.com/settings/personal-access-tokens/new\x1b[0m');
  console.error('  \x1b[36mhttps://github.com/settings/tokens/new\x1b[0m\n');

  const username = await ask('GitHub username (leave blank to skip Copilot): ');
  if (username) {
    config.copilot.githubUsername = username;
    const token = await ask('GitHub PAT (recommended fine-grained, Plan: Read): ');
    config.copilot.githubToken = token;
    const limitStr = await ask('Monthly premium request limit [300] (tip: Pro is 300): ');
    config.copilot.monthlyLimit = limitStr ? parseInt(limitStr, 10) : 300;
  }

  rl.close();

  saveConfig(config);
  console.error('\n\x1b[32m✓ Config saved to ' + CONFIG_FILE + '\x1b[0m\n');
  return config;
}
