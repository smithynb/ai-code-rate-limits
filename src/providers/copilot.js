// Lazy debug flag — read from argv directly to avoid circular import
const isDebug = process.argv.includes('--debug');

export const name = 'GitHub Copilot';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function formatResetToNextMonthUtc() {
    const now = new Date();
    const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
    const seconds = Math.floor((resetAt.getTime() - Date.now()) / 1000);

    if (seconds <= 0) return 'Resets soon';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `Resets in ${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
    if (minutes > 0) return `Resets in ${minutes}m`;
    return 'Resets soon';
}

function sumPremiumRequests(data) {
    const usageItems = Array.isArray(data?.usageItems)
        ? data.usageItems
        : Array.isArray(data?.usage_items)
            ? data.usage_items
            : [];
    return usageItems.reduce((sum, item) => {
        const quantity = Number(
            item?.netQuantity ??
            item?.net_quantity ??
            item?.grossQuantity ??
            item?.gross_quantity ??
            0
        );
        return Number.isFinite(quantity) ? sum + quantity : sum;
    }, 0);
}

/**
 * Check GitHub Copilot premium request usage via GitHub Billing API.
 * @param {object} config - Config object with copilot.githubUsername and copilot.githubToken
 */
export async function check(config) {
    const { githubUsername, githubToken, monthlyLimit = 300 } = config?.copilot || {};

    if (!githubToken) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: '⚠ Not configured — run with --setup to add GitHub PAT',
        };
    }

    try {
        // Step 1: Validate token and resolve the token owner login
        const userRes = await fetch(`${API_BASE}/user`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': API_VERSION,
            },
            signal: AbortSignal.timeout(15000),
        });

        if (isDebug) {
            const bodyText = await userRes.clone().text().catch(() => '(unreadable)');
            process.stderr.write(
                `\n[Copilot debug] HTTP ${userRes.status} from /user\n` +
                `[Copilot debug] Response body: ${bodyText}\n`
            );
        }

        if (userRes.status === 401) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Auth failed — invalid/expired PAT (run --setup)',
            };
        }

        if (!userRes.ok) {
            throw new Error(`HTTP ${userRes.status} from /user`);
        }

        const userData = await userRes.json().catch(() => ({}));
        const resolvedUsername = userData?.login || githubUsername;
        if (!resolvedUsername) {
            throw new Error('Could not resolve GitHub username from token');
        }

        // Step 2: Fetch premium request usage from official billing endpoint.
        // Docs: GET /users/{username}/settings/billing/premium_request/usage
        const usagePath = `/users/${encodeURIComponent(resolvedUsername)}/settings/billing/premium_request/usage`;
        const filteredUsageUrl = `${API_BASE}${usagePath}?product=Copilot`;
        let usageUrl = filteredUsageUrl;
        let res = await fetch(usageUrl, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${githubToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': API_VERSION,
            },
            signal: AbortSignal.timeout(30000),
        });

        // Backward compatibility if this API variant does not support product filter
        if (res.status === 422) {
            usageUrl = `${API_BASE}${usagePath}`;
            res = await fetch(usageUrl, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${githubToken}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': API_VERSION,
                },
                signal: AbortSignal.timeout(30000),
            });
        }

        if (isDebug) {
            const bodyText = await res.clone().text().catch(() => '(unreadable)');
            process.stderr.write(
                `\n[Copilot debug] HTTP ${res.status} from ${usageUrl}\n` +
                `[Copilot debug] Response body: ${bodyText}\n`
            );
        }

        if (res.status === 401) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Auth failed — invalid/expired PAT (run --setup)',
            };
        }

        if (res.status === 403) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'PAT lacks billing permission — use a fine-grained PAT with User "Plan: Read"',
            };
        }

        if (res.status === 404) {
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'No personal Copilot billing data found (may be billed via org/enterprise)',
            };
        }

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
        }

        const data = await res.json();
        const used = sumPremiumRequests(data);
        const limit = Number(monthlyLimit) > 0 ? Number(monthlyLimit) : 300;
        const remaining = Math.max(0, limit - used);
        const percentRemaining = Math.max(0, Math.min(100, (remaining / limit) * 100));

        return {
            provider: name,
            status: 'ok',
            quotas: [
                {
                    label: 'Premium',
                    percentRemaining,
                    resetText: `${remaining}/${limit} left - ${formatResetToNextMonthUtc()}`,
                },
            ],
            tier: 'Billing API',
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
