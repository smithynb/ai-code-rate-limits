import fs from 'node:fs';
import path from 'node:path';

const CREDS_PATH = path.join(process.env.HOME || '~', '.claude', '.credentials.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const name = 'Claude Code';

/**
 * Load OAuth credentials from ~/.claude/.credentials.json
 */
function loadCredentials() {
    try {
        if (!fs.existsSync(CREDS_PATH)) return null;
        const raw = fs.readFileSync(CREDS_PATH, 'utf-8');
        const data = JSON.parse(raw);

        // The file may contain a top-level object or nested under "oauth"
        const oauth = data.claudeAiOauth || data;
        return {
            accessToken: oauth.accessToken || oauth.access_token,
            refreshToken: oauth.refreshToken || oauth.refresh_token,
            expiresAt: oauth.expiresAt || oauth.expires_at,
            subscriptionType: oauth.subscriptionType || oauth.subscription_type,
            raw: data,
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

    const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: creds.refreshToken,
            client_id: CLIENT_ID,
            scope: 'user:profile user:inference user:sessions:claude_code',
        }),
        signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.access_token) return null;

    // Update credentials file
    creds.accessToken = data.access_token;
    if (data.refresh_token) creds.refreshToken = data.refresh_token;
    if (data.expires_in) {
        creds.expiresAt = Date.now() + data.expires_in * 1000;
    }

    try {
        const fileData = creds.raw || {};
        const oauth = fileData.claudeAiOauth || fileData;
        oauth.accessToken = oauth.access_token = creds.accessToken;
        if (data.refresh_token) oauth.refreshToken = oauth.refresh_token = creds.refreshToken;
        if (creds.expiresAt) oauth.expiresAt = oauth.expires_at = creds.expiresAt;
        fs.writeFileSync(CREDS_PATH, JSON.stringify(fileData, null, 2));
    } catch {
        // Non-critical
    }

    return creds;
}

/**
 * Fetch usage data from the Claude API.
 */
async function fetchUsage(accessToken) {
    const res = await fetch(USAGE_URL, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'ai-rate-limit-checker',
        },
        signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401 || res.status === 403) {
        return { authError: true };
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    return await res.json();
}

/**
 * Parse ISO date and format relative reset time.
 */
function formatReset(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    const seconds = (date - Date.now()) / 1000;
    if (seconds <= 0) return null;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
    if (minutes > 0) return `Resets in ${minutes}m`;
    return 'Resets soon';
}

/**
 * Parse subscription type to a tier label.
 */
function parseTier(type) {
    if (!type) return null;
    const lower = type.toLowerCase();
    if (lower.includes('max')) return 'Max';
    if (lower.includes('pro')) return 'Pro';
    if (lower.includes('api')) return 'API';
    return type;
}

/**
 * Check Claude Code rate limits.
 */
export async function check() {
    const creds = loadCredentials();
    if (!creds || !creds.accessToken) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: '⚠ Not authenticated — run `claude` to sign in',
        };
    }

    try {
        // Check if token needs refresh
        const needsRefresh = creds.expiresAt && Date.now() > creds.expiresAt - 300000;
        if (needsRefresh && creds.refreshToken) {
            const refreshed = await refreshToken(creds);
            if (refreshed) Object.assign(creds, refreshed);
        }

        let usage = await fetchUsage(creds.accessToken);

        // If auth failed, try refreshing once
        if (usage.authError && creds.refreshToken) {
            const refreshed = await refreshToken(creds);
            if (refreshed) {
                Object.assign(creds, refreshed);
                usage = await fetchUsage(creds.accessToken);
            }
        }

        if (usage.authError) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Session expired — run `claude` to re-authenticate',
            };
        }

        const quotas = [];

        // 5-hour session quota
        if (usage.five_hour?.utilization != null) {
            quotas.push({
                label: 'Session (5h)',
                percentRemaining: 100 - usage.five_hour.utilization,
                resetText: formatReset(usage.five_hour.resets_at),
            });
        }

        // 7-day weekly quota
        if (usage.seven_day?.utilization != null) {
            quotas.push({
                label: 'Weekly (7d)',
                percentRemaining: 100 - usage.seven_day.utilization,
                resetText: formatReset(usage.seven_day.resets_at),
            });
        }

        // Model-specific quotas
        if (usage.seven_day_sonnet?.utilization != null) {
            quotas.push({
                label: 'Sonnet (7d)',
                percentRemaining: 100 - usage.seven_day_sonnet.utilization,
                resetText: formatReset(usage.seven_day_sonnet.resets_at),
            });
        }
        if (usage.seven_day_opus?.utilization != null) {
            quotas.push({
                label: 'Opus (7d)',
                percentRemaining: 100 - usage.seven_day_opus.utilization,
                resetText: formatReset(usage.seven_day_opus.resets_at),
            });
        }

        // Extra usage / cost
        let costUsage = null;
        if (usage.extra_usage?.is_enabled && usage.extra_usage.used_credits != null) {
            const used = (usage.extra_usage.used_credits / 100).toFixed(2);
            const limit = usage.extra_usage.monthly_limit
                ? `/$${(usage.extra_usage.monthly_limit / 100).toFixed(2)}`
                : '';
            costUsage = `$${used}${limit} extra usage`;
        }

        return {
            provider: name,
            status: 'ok',
            quotas,
            tier: parseTier(creds.subscriptionType),
            costUsage,
            error: null,
        };
    } catch (err) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: `API error: ${err.message}`,
        };
    }
}
