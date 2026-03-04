// ANSI color helpers
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
};

const DEFAULT_BOX_WIDTH = 64;
const BAR_WIDTH = 10;

/**
 * Build a colored progress bar.
 * @param {number} percent - Percentage remaining (0-100)
 * @returns {string}
 */
function progressBar(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;

    let color;
    if (clamped > 50) color = c.green;
    else if (clamped > 20) color = c.yellow;
    else color = c.red;

    return color + '█'.repeat(filled) + c.gray + '░'.repeat(empty) + c.reset;
}

/**
 * Strip ANSI codes to get visible character length.
 */
function visibleLength(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Pad a string (which may contain ANSI codes) to a visible width.
 */
function padVisible(str, width) {
    const visible = visibleLength(str);
    if (visible >= width) return str;
    return str + ' '.repeat(width - visible);
}

/**
 * Truncate a string (which may contain ANSI codes) to a visible width.
 */
function truncateVisible(str, width) {
    if (width <= 0) return '';
    if (visibleLength(str) <= width) return str;

    let out = '';
    let visible = 0;
    let i = 0;
    let hasAnsi = false;

    while (i < str.length && visible < width) {
        if (str[i] === '\x1b') {
            const m = str.slice(i).match(/^\x1b\[[0-9;]*m/);
            if (m) {
                out += m[0];
                i += m[0].length;
                hasAnsi = true;
                continue;
            }
        }

        const cp = str.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        out += ch;
        i += ch.length;
        visible += 1;
    }

    return hasAnsi ? out + c.reset : out;
}

/**
 * Fit a string (which may contain ANSI codes) to exact visible width.
 */
function fitVisible(str, width) {
    return padVisible(truncateVisible(str, width), width);
}

/**
 * Pad or truncate a plain string (no ANSI codes) to a fixed width.
 */
function pad(str, width) {
    if (str.length >= width) return str.slice(0, width);
    return str + ' '.repeat(width - str.length);
}

/**
 * Render a single provider result as a boxed section.
 * @param {object} result - Provider result object
 * @returns {string}
 */
function renderProvider(result) {
    const lines = [];
    const rows = [];

    // Header title text (used to size the box)
    let title = ` ${result.provider} `;
    if (result.tier) title += `(${result.tier}) `;

    if (result.status === 'error') {
        const msg = result.error || 'Unknown error';
        const errColor = (result.error || '').includes('⚠') ? c.yellow : c.red;
        rows.push(`${errColor}${msg}${c.reset}`);
    } else if (result.status === 'not_installed') {
        rows.push(`${c.yellow}⚠  Not installed / not running${c.reset}`);
    } else {
        const quotas = Array.isArray(result.quotas) ? result.quotas : [];

        // Compute dynamic label width from longest label in this provider
        const maxLabelLen = Math.max(
            ...quotas.map((q) => q.label.length),
            8 // minimum
        );
        const labelWidth = Math.min(maxLabelLen + 1, 22); // +1 for colon, cap at 22

        // Render each quota
        for (const quota of quotas) {
            const bar = progressBar(quota.percentRemaining);
            const pctStr = `${Math.round(quota.percentRemaining)}% remaining`;
            const labelStr = pad(quota.label + ':', labelWidth);
            const finalReset = quota.resetText ? `  ${c.dim}(${quota.resetText})${c.reset}` : '';
            rows.push(`${labelStr} ${bar}  ${pctStr}${finalReset}`);
        }

        // Cost usage if present
        if (result.costUsage) {
            rows.push(`  💰 ${result.costUsage}`);
        }
    }

    const minInnerWidth = DEFAULT_BOX_WIDTH - 4; // "│ " + content + " │"
    const widestRow = rows.reduce((max, row) => Math.max(max, visibleLength(row)), 0);
    const desiredInnerWidth = Math.max(minInnerWidth, widestRow, visibleLength(title));
    const terminalWidth = Number.isInteger(process.stdout?.columns) ? process.stdout.columns : null;
    const maxInnerWidth = terminalWidth && terminalWidth > 4 ? terminalWidth - 4 : desiredInnerWidth;
    const innerWidth = Math.max(1, Math.min(desiredInnerWidth, maxInnerWidth));
    const boxWidth = innerWidth + 4;

    const headerLine = '─'.repeat(Math.max(1, boxWidth - 3 - visibleLength(title)));
    lines.push(`${c.dim}╭─${c.reset}${c.bold}${title}${c.reset}${c.dim}${headerLine}╮${c.reset}`);

    for (const row of rows) {
        const fitted = fitVisible(row, innerWidth);
        lines.push(`${c.dim}│${c.reset} ${fitted} ${c.dim}│${c.reset}`);
    }

    // Footer
    lines.push(`${c.dim}╰${'─'.repeat(boxWidth - 2)}╯${c.reset}`);

    return lines.join('\n');
}

/**
 * Render all provider results.
 * @param {object[]} results - Array of provider result objects
 */
export function renderResults(results) {
    console.log('');
    console.log(`${c.bold}  AI Code Tool Rate Limits${c.reset}  ${c.gray}${new Date().toLocaleTimeString()}${c.reset}`);
    console.log('');

    for (const result of results) {
        console.log(renderProvider(result));
        console.log('');
    }
}

/**
 * Render a spinner/loading message.
 */
export function renderLoading() {
    process.stderr.write(`${c.dim}  Checking rate limits...${c.reset}\r`);
}

/**
 * Clear the loading message.
 */
export function clearLoading() {
    process.stderr.write('                          \r');
}
