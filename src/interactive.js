import { loadConfig, saveConfig, runSetup } from './config.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bgBlue: '\x1b[44m',
    white: '\x1b[37m',
    red: '\x1b[31m',
};

// All known providers (must match result.provider strings from each checker)
const ALL_PROVIDERS = [
    'Claude Code',
    'Codex',
    'GitHub Copilot',
    'Gemini CLI',
    'Antigravity',
];

// Providers that have a re-auth / onboard action
const REAUTH_ACTIONS = [
    {
        label: 'Re-auth GitHub Copilot',
        description: 'Update GitHub PAT/username (tip: Pro is 300/month)',
        run: async () => {
            process.stdout.write('\x1b[?25h'); // show cursor
            console.log('');
            await runSetup();
        },
    },
];

// ── Menu item types ───────────────────────────────────────────────────────────
// { type: 'separator', label }
// { type: 'provider', name }
// { type: 'action', label, description, run }
// { type: 'confirm', label }

function buildMenuItems() {
    return [
        { type: 'separator', label: 'Visible Providers' },
        ...ALL_PROVIDERS.map((name) => ({ type: 'provider', name })),
        { type: 'separator', label: 'Actions' },
        ...REAUTH_ACTIONS.map((a) => ({ type: 'action', ...a })),
        { type: 'separator', label: '' },
        { type: 'confirm', label: 'Confirm & Exit' },
    ];
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderMenu(items, cursor, hidden) {
    const lines = [];

    lines.push('');
    lines.push(`  ${c.bold}⚙  AI Rate Limit Checker — Settings${c.reset}`);
    lines.push(`  ${c.dim}↑↓ navigate  Space toggle  Enter select  q quit${c.reset}`);
    lines.push('');

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isSelected = i === cursor;
        const selPrefix = isSelected ? `${c.cyan}▶${c.reset} ` : '  ';

        if (item.type === 'separator') {
            const label = item.label ? `  ${c.dim}── ${item.label} ──${c.reset}` : `  ${c.dim}──────────────────────────────────${c.reset}`;
            lines.push(label);
            continue;
        }

        if (item.type === 'provider') {
            const isHidden = hidden.includes(item.name);
            const checkbox = isHidden
                ? `${c.gray}[ ]${c.reset}`
                : `${c.green}[✓]${c.reset}`;
            const nameStr = isSelected
                ? `${c.bold}${item.name}${c.reset}`
                : item.name;
            const statusStr = isHidden
                ? `  ${c.dim}(hidden)${c.reset}`
                : '';
            lines.push(`  ${selPrefix}${checkbox} ${nameStr}${statusStr}`);
            continue;
        }

        if (item.type === 'action') {
            const label = isSelected
                ? `${c.bold}${item.label}${c.reset}`
                : `${c.yellow}${item.label}${c.reset}`;
            const desc = `  ${c.dim}${item.description}${c.reset}`;
            lines.push(`  ${selPrefix}${c.yellow}⚡${c.reset} ${label}${desc}`);
            continue;
        }

        if (item.type === 'confirm') {
            const label = isSelected
                ? `${c.bold}${c.green}${item.label}${c.reset}`
                : `${c.green}${item.label}${c.reset}`;
            lines.push(`  ${selPrefix}${label}`);
            continue;
        }
    }

    lines.push('');
    return lines.join('\n');
}

// Redraw the menu anchored at the top of the alternate screen
function redraw(content) {
    // Move to top-left, then erase everything below
    process.stdout.write('\x1b[H\x1b[J');
    process.stdout.write(content);
}

// ── Interactive loop ──────────────────────────────────────────────────────────
export async function runConfigMenu() {
    // Guard: raw mode requires a real TTY
    if (!process.stdin.isTTY) {
        console.error(`\n  ${c.red}✗ --config requires an interactive terminal (TTY).${c.reset}\n`);
        process.exit(1);
    }

    const config = loadConfig();
    const hidden = [...(config.hiddenProviders || [])];

    const items = buildMenuItems();

    // Find first selectable item index
    const isSelectable = (i) => items[i].type !== 'separator';
    let cursor = items.findIndex((_, i) => isSelectable(i));

    // Enter alternate screen buffer + hide cursor (like vim/less/top)
    process.stdout.write('\x1b[?1049h\x1b[?25l');

    const draw = () => {
        const content = renderMenu(items, cursor, hidden);
        redraw(content);
    };

    draw();

    // Set raw mode
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const moveCursor = (dir) => {
        let next = cursor + dir;
        // Skip separators
        while (next >= 0 && next < items.length && !isSelectable(next)) {
            next += dir;
        }
        if (next >= 0 && next < items.length) {
            cursor = next;
        }
    };

    return new Promise((resolve) => {
        const onData = async (key) => {
            // Ctrl+C
            if (key === '\u0003') {
                cleanup();
                process.exit(0);
            }

            // q or Escape — quit without saving
            if (key === 'q' || key === '\x1b') {
                cleanup();
                console.log(`\n  ${c.dim}Exited without saving.${c.reset}\n`);
                resolve(config);
                return;
            }

            // Up arrow
            if (key === '\x1b[A') {
                moveCursor(-1);
                draw();
                return;
            }

            // Down arrow
            if (key === '\x1b[B') {
                moveCursor(1);
                draw();
                return;
            }

            const item = items[cursor];

            // Space — toggle provider visibility
            if (key === ' ') {
                if (item.type === 'provider') {
                    const idx = hidden.indexOf(item.name);
                    if (idx === -1) {
                        hidden.push(item.name);
                    } else {
                        hidden.splice(idx, 1);
                    }
                    draw();
                }
                return;
            }

            // Enter — confirm or trigger action
            if (key === '\r' || key === '\n') {
                if (item.type === 'confirm') {
                    cleanup();
                    // Save
                    config.hiddenProviders = hidden;
                    saveConfig(config);
                    console.log(`\n  ${c.green}✓ Settings saved.${c.reset}\n`);
                    resolve(config);
                    return;
                }

                if (item.type === 'action') {
                    // Leave alternate screen so the re-auth prompts appear normally
                    cleanup();
                    await item.run();
                    // Re-enter alternate screen and raw mode after re-auth completes
                    process.stdout.write('\x1b[?1049h\x1b[?25l');
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                    process.stdin.setEncoding('utf8');
                    draw();
                    process.stdin.on('data', onData);
                    return;
                }

                if (item.type === 'provider') {
                    // Enter on provider also toggles (convenience)
                    const idx = hidden.indexOf(item.name);
                    if (idx === -1) {
                        hidden.push(item.name);
                    } else {
                        hidden.splice(idx, 1);
                    }
                    draw();
                }
                return;
            }
        };

        const cleanup = () => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
            // Restore normal screen buffer + show cursor
            process.stdout.write('\x1b[?1049l\x1b[?25h');
        };

        process.stdin.on('data', onData);
    });
}
