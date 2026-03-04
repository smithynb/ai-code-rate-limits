import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Lazy debug flag — read from argv directly to avoid circular import
const isDebug = process.argv.includes('--debug');
const isWSL = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME);

const CREDS_PATH = path.join(process.env.HOME || '~', '.codex', 'auth.json');
const SESSIONS_PATH = path.join(process.env.HOME || '~', '.codex', 'sessions');
const USAGE_URLS = [
    'https://chatgpt.com/backend-api/wham/usage',
    'https://chat.openai.com/backend-api/wham/usage',
];
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export const name = 'Codex';

function debugLog(message) {
    if (!isDebug) return;
    process.stderr.write(`[Codex debug] ${message}\n`);
}

function errorMessage(err) {
    if (!err) return 'Unknown error';
    const causeCode = err?.cause?.code;
    if (causeCode) return `${err.message} (${causeCode})`;
    return err.message || String(err);
}

function windowsCurlUsage(url, headers) {
    try {
        const marker = '__AI_LIMITS_HTTP_STATUS__:';
        const args = [
            '--silent',
            '--show-error',
            '--location',
            '--max-time',
            '8',
        ];
        for (const [key, value] of Object.entries(headers || {})) {
            if (value == null) continue;
            args.push('--header', `${key}: ${value}`);
        }
        args.push('--write-out', `\n${marker}%{http_code}`);
        args.push(url);

        const output = execFileSync('curl.exe', args, {
            encoding: 'utf-8',
            timeout: 12000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const markerLine = `\n${marker}`;
        const idx = output.lastIndexOf(markerLine);
        if (idx === -1) {
            return { status: 0, body: output };
        }

        const body = output.slice(0, idx);
        const statusText = output.slice(idx + markerLine.length).trim();
        const status = Number.parseInt(statusText, 10);
        return {
            status: Number.isFinite(status) ? status : 0,
            body,
        };
    } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim().replace(/\s+/g, ' ') : '';
        if (stderr) debugLog(`windows curl failed: ${stderr.slice(0, 220)}`);
        else debugLog(`windows curl failed: ${errorMessage(err)}`);
        return null;
    }
}

/**
 * Load OAuth credentials from ~/.codex/auth.json
 */
function loadCredentials() {
    try {
        if (!fs.existsSync(CREDS_PATH)) return null;
        const raw = fs.readFileSync(CREDS_PATH, 'utf-8');
        const data = JSON.parse(raw);

        // The file structure has tokens nested
        const tokens = data.tokens || data;
        return {
            accessToken: tokens.access_token || tokens.accessToken,
            refreshToken: tokens.refresh_token || tokens.refreshToken,
            accountId: data.account_id || data.accountId,
            lastRefresh: data.last_refresh || data.lastRefresh,
            fullData: data,
        };
    } catch {
        return null;
    }
}

/**
 * Refresh an expired access token.
 */
async function refreshToken(creds) {
    if (!creds.refreshToken) return null;

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: creds.refreshToken,
    });

    let res;
    try {
        res = await fetch(REFRESH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(15000),
        });
    } catch (err) {
        debugLog(`refreshToken: request failed: ${errorMessage(err)}`);
        return null;
    }

    if (!res.ok) {
        debugLog(`refreshToken: HTTP ${res.status}`);
        return null;
    }

    const data = await res.json();
    if (!data.access_token) return null;

    creds.accessToken = data.access_token;
    if (data.refresh_token) creds.refreshToken = data.refresh_token;

    // Save updated credentials
    try {
        const fileData = creds.fullData || {};
        if (fileData.tokens) {
            fileData.tokens.access_token = creds.accessToken;
            if (data.refresh_token) fileData.tokens.refresh_token = creds.refreshToken;
            if (data.id_token) fileData.tokens.id_token = data.id_token;
        }
        fileData.last_refresh = new Date().toISOString();
        fs.writeFileSync(CREDS_PATH, JSON.stringify(fileData, null, 2));
    } catch {
        // Non-critical
    }

    return creds;
}

/**
 * Format reset time from seconds offset.
 */
function formatResetFromSeconds(seconds) {
    if (!seconds || seconds <= 0) return null;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `Resets in ${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
    if (minutes > 0) return `Resets in ${minutes}m`;
    return 'Resets soon';
}

/**
 * Parse plan type to readable tier.
 */
function parseTier(planType) {
    if (!planType) return null;
    const lower = planType.toLowerCase();
    if (lower.includes('plus')) return 'Plus';
    if (lower.includes('pro')) return 'Pro';
    if (lower.includes('team')) return 'Team';
    if (lower.includes('enterprise')) return 'Enterprise';
    return planType;
}

function findNewestSessionJsonlFile() {
    if (!fs.existsSync(SESSIONS_PATH)) return null;

    const listDirsDesc = (dir) => {
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name)
                .sort((a, b) => b.localeCompare(a));
        } catch {
            return [];
        }
    };

    for (const year of listDirsDesc(SESSIONS_PATH)) {
        const yearDir = path.join(SESSIONS_PATH, year);
        for (const month of listDirsDesc(yearDir)) {
            const monthDir = path.join(yearDir, month);
            for (const day of listDirsDesc(monthDir)) {
                const dayDir = path.join(monthDir, day);
                let newestPath = null;
                let newestMtime = 0;
                let entries;
                try {
                    entries = fs.readdirSync(dayDir, { withFileTypes: true });
                } catch {
                    continue;
                }

                for (const entry of entries) {
                    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
                    const fullPath = path.join(dayDir, entry.name);
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.mtimeMs > newestMtime) {
                            newestMtime = stat.mtimeMs;
                            newestPath = fullPath;
                        }
                    } catch {
                        // Ignore stat errors
                    }
                }

                if (newestPath) return newestPath;
            }
        }
    }

    return null;
}

function readTailUtf8(filePath, maxBytes = 256 * 1024) {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const fd = fs.openSync(filePath, 'r');

    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        let text = buffer.toString('utf-8');
        if (start > 0) {
            const firstNewline = text.indexOf('\n');
            if (firstNewline >= 0) text = text.slice(firstNewline + 1);
        }
        return text;
    } finally {
        fs.closeSync(fd);
    }
}

function loadLocalRateLimits() {
    const latestPath = findNewestSessionJsonlFile();
    if (!latestPath) return null;

    let raw;
    try {
        raw = readTailUtf8(latestPath);
    } catch {
        return null;
    }

    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            continue;
        }

        const limits = obj?.payload?.rate_limits;
        if (!limits) continue;

        const primary = limits.primary || {};
        const secondary = limits.secondary || {};

        if (primary.used_percent == null && secondary.used_percent == null) continue;

        return {
            sourceFile: latestPath,
            planType: limits.plan_type || null,
            primaryUsedPercent: primary.used_percent,
            secondaryUsedPercent: secondary.used_percent,
            primaryResetsAt: primary.resets_at,
            secondaryResetsAt: secondary.resets_at,
        };
    }

    return null;
}

/**
 * Check Codex rate limits.
 */
export async function check() {
    const creds = loadCredentials();
    if (!creds || !creds.accessToken) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: '⚠ Not authenticated — run `codex` to sign in',
        };
    }

    try {
        // Proactive refresh if last_refresh is old (>8 days)
        if (creds.lastRefresh) {
            const lastRefreshDate = new Date(creds.lastRefresh);
            const daysSince = (Date.now() - lastRefreshDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysSince > 8 && creds.refreshToken) {
                const refreshed = await refreshToken(creds);
                if (refreshed) Object.assign(creds, refreshed);
            }
        }

        // Fetch usage
        const headers = {
            Authorization: `Bearer ${creds.accessToken}`,
            Accept: 'application/json',
            'User-Agent': 'ai-rate-limit-checker',
        };
        if (creds.accountId) {
            headers['ChatGPT-Account-Id'] = creds.accountId;
        }

        let data = null;
        let responseHeaders = null;
        let usedUrl = null;
        let sawAuthFailure = false;
        const endpointErrors = [];

        for (const usageUrl of USAGE_URLS) {
            try {
                debugLog(`requesting ${usageUrl}`);
                let attemptRes = await fetch(usageUrl, {
                    method: 'GET',
                    headers,
                    signal: AbortSignal.timeout(7000),
                });

                // Retry with refresh on 401
                if (attemptRes.status === 401 && creds.refreshToken) {
                    debugLog(`HTTP 401 from ${usageUrl}, attempting token refresh`);
                    const refreshed = await refreshToken(creds);
                    if (refreshed) {
                        Object.assign(creds, refreshed);
                        headers.Authorization = `Bearer ${creds.accessToken}`;
                        attemptRes = await fetch(usageUrl, {
                            method: 'GET',
                            headers,
                            signal: AbortSignal.timeout(7000),
                        });
                    }
                }

                if (attemptRes.status === 401 || attemptRes.status === 403) {
                    sawAuthFailure = true;
                    endpointErrors.push(`${usageUrl}: HTTP ${attemptRes.status}`);
                    debugLog(`auth failure from ${usageUrl}: HTTP ${attemptRes.status}`);
                    continue;
                }

                if (!attemptRes.ok) {
                    endpointErrors.push(`${usageUrl}: HTTP ${attemptRes.status}`);
                    debugLog(`non-ok response from ${usageUrl}: HTTP ${attemptRes.status}`);
                    continue;
                }

                responseHeaders = attemptRes.headers;
                usedUrl = usageUrl;
                data = await attemptRes.json();
                break;
            } catch (err) {
                const msg = `${usageUrl}: ${errorMessage(err)}`;
                endpointErrors.push(msg);
                debugLog(`request failed ${msg}`);

                // WSL sometimes fails DNS/TLS in Node fetch while Windows network stack works.
                if (isWSL) {
                    debugLog(`trying Windows curl proxy for ${usageUrl}`);
                    let proxied = windowsCurlUsage(usageUrl, headers);

                    // Retry once through refresh flow if proxy reports auth failure.
                    if (proxied && proxied.status === 401 && creds.refreshToken) {
                        debugLog(`proxy HTTP 401 from ${usageUrl}, attempting token refresh`);
                        const refreshed = await refreshToken(creds);
                        if (refreshed) {
                            Object.assign(creds, refreshed);
                            headers.Authorization = `Bearer ${creds.accessToken}`;
                            proxied = windowsCurlUsage(usageUrl, headers);
                        }
                    }

                    if (proxied) {
                        if (proxied.status === 401 || proxied.status === 403) {
                            sawAuthFailure = true;
                            endpointErrors.push(`${usageUrl} (windows-proxy): HTTP ${proxied.status}`);
                            debugLog(`auth failure from windows proxy ${usageUrl}: HTTP ${proxied.status}`);
                            continue;
                        }

                        if (proxied.status < 200 || proxied.status >= 300) {
                            endpointErrors.push(`${usageUrl} (windows-proxy): HTTP ${proxied.status}`);
                            debugLog(`non-ok response from windows proxy ${usageUrl}: HTTP ${proxied.status}`);
                            continue;
                        }

                        try {
                            data = JSON.parse(proxied.body);
                            usedUrl = `${usageUrl} (windows-proxy)`;
                            responseHeaders = null;
                            break;
                        } catch (parseErr) {
                            endpointErrors.push(
                                `${usageUrl} (windows-proxy): invalid JSON: ${errorMessage(parseErr)}`
                            );
                            debugLog(`invalid JSON from windows proxy ${usageUrl}: ${errorMessage(parseErr)}`);
                        }
                    }
                }
            }
        }

        if (!data && sawAuthFailure) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Session expired — run `codex` to re-authenticate',
            };
        }

        if (!data) {
            const local = loadLocalRateLimits();
            if (local) {
                debugLog(`using local fallback from ${local.sourceFile}`);
                const nowSeconds = Date.now() / 1000;
                const quotas = [];

                if (local.primaryUsedPercent != null) {
                    quotas.push({
                        label: 'Session',
                        percentRemaining: Math.max(0, 100 - Number(local.primaryUsedPercent)),
                        resetText: formatResetFromSeconds(
                            local.primaryResetsAt != null ? local.primaryResetsAt - nowSeconds : null
                        ),
                    });
                }

                if (local.secondaryUsedPercent != null) {
                    quotas.push({
                        label: 'Weekly',
                        percentRemaining: Math.max(0, 100 - Number(local.secondaryUsedPercent)),
                        resetText: formatResetFromSeconds(
                            local.secondaryResetsAt != null ? local.secondaryResetsAt - nowSeconds : null
                        ),
                    });
                }

                if (quotas.length > 0) {
                    return {
                        provider: name,
                        status: 'ok',
                        quotas,
                        tier: parseTier(local.planType),
                        error: null,
                    };
                }
            }

            throw new Error(`All usage endpoints failed: ${endpointErrors.join(' | ')}`);
        }
        const quotas = [];
        const nowSeconds = Date.now() / 1000;

        if (isDebug) {
            process.stderr.write(`\n[Codex debug] Usage URL: ${usedUrl}\n`);
            process.stderr.write('\n[Codex debug] rate_limit: ' + JSON.stringify(data.rate_limit, null, 2) + '\n');
        }

        // Try headers first, then body
        const headerPrimary = responseHeaders
            ? parseFloat(responseHeaders.get('x-codex-primary-used-percent'))
            : NaN;
        const headerSecondary = responseHeaders
            ? parseFloat(responseHeaders.get('x-codex-secondary-used-percent'))
            : NaN;

        const rateLimit = data.rate_limit || {};
        const primaryWindow = rateLimit.primary_window || {};
        const secondaryWindow = rateLimit.secondary_window || {};

        /**
         * Compute reset time from a window object.
         * The API provides either reset_at (absolute Unix timestamp)
         * or reset_after_seconds (relative to now).
         */
        function windowResetText(window) {
            let resetSeconds = null;
            if (window.reset_at != null) {
                resetSeconds = window.reset_at - nowSeconds;
            } else if (window.reset_after_seconds != null) {
                resetSeconds = window.reset_after_seconds;
            }
            return formatResetFromSeconds(resetSeconds);
        }

        // Session quota
        const primaryPercent = !isNaN(headerPrimary)
            ? headerPrimary
            : primaryWindow.used_percent;
        if (primaryPercent != null) {
            quotas.push({
                label: 'Session',
                percentRemaining: Math.max(0, 100 - primaryPercent),
                resetText: windowResetText(primaryWindow),
            });
        }

        // Weekly quota
        const secondaryPercent = !isNaN(headerSecondary)
            ? headerSecondary
            : secondaryWindow.used_percent;
        if (secondaryPercent != null) {
            quotas.push({
                label: 'Weekly',
                percentRemaining: Math.max(0, 100 - secondaryPercent),
                resetText: windowResetText(secondaryWindow),
            });
        }

        return {
            provider: name,
            status: 'ok',
            quotas,
            tier: parseTier(data.plan_type),
            error: null,
        };
    } catch (err) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: `API error: ${errorMessage(err)}`,
        };
    }
}
