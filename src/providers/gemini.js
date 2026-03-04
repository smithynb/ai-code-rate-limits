import fs from 'node:fs';
import path from 'node:path';

const isDebug = process.argv.includes('--debug');

const CREDS_PATH = path.join(process.env.HOME || '~', '.gemini', 'oauth_creds.json');
const QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';

export const name = 'Gemini CLI';

/**
 * Load OAuth credentials from ~/.gemini/oauth_creds.json
 */
function loadCredentials() {
    try {
        if (!fs.existsSync(CREDS_PATH)) return null;
        const raw = fs.readFileSync(CREDS_PATH, 'utf-8');
        const data = JSON.parse(raw);
        return {
            accessToken: data.access_token || data.accessToken,
            refreshToken: data.refresh_token || data.refreshToken,
            expiryDate: data.expiry_date || data.expiryDate,
        };
    } catch {
        return null;
    }
}

/**
 * Format reset time from ISO string.
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
 * Discover a Gemini project ID for more accurate quota data.
 */
async function discoverProject(accessToken) {
    try {
        const url = 'https://cloudcode-pa.googleapis.com/v1internal:findGeminiCLIProject';
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.projectId || data.project_id || null;
    } catch {
        return null;
    }
}

/**
 * Check Gemini CLI rate limits.
 */
export async function check() {
    const creds = loadCredentials();
    if (!creds || !creds.accessToken) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: '⚠ Not authenticated — run `gemini` to sign in',
        };
    }

    // Check if token is expired
    if (creds.expiryDate) {
        const expiry = typeof creds.expiryDate === 'number'
            ? creds.expiryDate
            : new Date(creds.expiryDate).getTime();
        if (Date.now() > expiry) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Token expired — run `gemini` to re-authenticate',
            };
        }
    }

    try {
        // Try to discover project for more accurate data
        const projectId = await discoverProject(creds.accessToken);

        const body = projectId ? JSON.stringify({ project: projectId }) : '{}';

        const res = await fetch(QUOTA_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${creds.accessToken}`,
                'Content-Type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(15000),
        });

        if (res.status === 401) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Token expired — run `gemini` to re-authenticate',
            };
        }

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const buckets = data.buckets || [];

        if (isDebug) {
            process.stderr.write('\n[Gemini debug] Raw bucket model IDs:\n');
            for (const b of buckets) {
                const id = b.modelId || b.model_id || '(none)';
                const frac = b.remainingFraction ?? b.remaining_fraction ?? '?';
                process.stderr.write(`  ${id}  →  ${frac}\n`);
            }
        }

        if (buckets.length === 0) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'No quota data returned',
            };
        }

        // Normalize model ID to a clean display name matching Gemini CLI's stats
        function normalizeModelName(rawId) {
            return rawId
                .replace(/^models\//, '')           // strip "models/" prefix
                .replace(/_[a-z]+$/i, '')           // strip _vertex, _vertexai, etc.
                .replace(/-\d{4}-\d{2}-\d{2}$/, '') // strip date suffixes like -2025-04-17
                .replace(/-\d{3,}$/, '')             // strip version suffixes like -001
                .replace(/-latest$/, '')             // strip -latest
                .replace(/-exp$/, '');               // strip -exp
        }

        // Group by normalized name, keep lowest remaining fraction per model
        const modelMap = new Map();
        for (const bucket of buckets) {
            const rawId = bucket.modelId || bucket.model_id || 'unknown';
            const fraction = bucket.remainingFraction ?? bucket.remaining_fraction;
            if (fraction == null) continue;

            const normalizedName = normalizeModelName(rawId);
            const existing = modelMap.get(normalizedName);
            if (!existing || fraction < existing.fraction) {
                modelMap.set(normalizedName, {
                    fraction,
                    resetTime: bucket.resetTime || bucket.reset_time,
                });
            }
        }

        const quotas = [];
        for (const [label, data] of [...modelMap.entries()].sort()) {
            quotas.push({
                label,
                percentRemaining: data.fraction * 100,
                resetText: formatReset(data.resetTime),
            });
        }

        if (quotas.length === 0) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'No valid quota data found',
            };
        }

        return {
            provider: name,
            status: 'ok',
            quotas,
            tier: null,
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
