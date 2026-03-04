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
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
    if (minutes > 0) return `Resets in ${minutes}m`;
    return 'Resets soon';
}

/**
 * Sum premium request usage from the API response.
 * Handles multiple response shapes:
 *   - { usageItems: [...] }   (camelCase wrapper)
 *   - { usage_items: [...] }  (snake_case wrapper)
 *   - [ ... ]                 (top-level array, no wrapper)
 */
function sumPremiumRequests(data) {
    let items;

    if (Array.isArray(data)) {
        // Response is a top-level array of usage items
        items = data;
    } else {
        items = Array.isArray(data?.usageItems)
            ? data.usageItems
            : Array.isArray(data?.usage_items)
                ? data.usage_items
                : [];
    }

    const total = items.reduce((sum, item) => {
        const quantity = Number(
            item?.netQuantity ??
            item?.net_quantity ??
            item?.grossQuantity ??
            item?.gross_quantity ??
            0
        );
        return Number.isFinite(quantity) ? sum + quantity : sum;
    }, 0);

    if (isDebug) {
        process.stderr.write(
            `[Copilot debug] sumPremiumRequests: ${items.length} usage item(s), total = ${total}\n`
        );
    }

    return total;
}

/**
 * Build common request headers for GitHub API calls.
 */
function githubHeaders(token) {
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
    };
}

/**
 * Attempt to fetch premium request usage from a given URL.
 * Returns { ok, status, data } or throws on network error.
 */
async function fetchUsage(url, token) {
    const res = await fetch(url, {
        method: 'GET',
        headers: githubHeaders(token),
        signal: AbortSignal.timeout(30000),
    });

    if (isDebug) {
        const bodyText = await res.clone().text().catch(() => '(unreadable)');
        process.stderr.write(
            `\n[Copilot debug] HTTP ${res.status} from ${url}\n` +
            `[Copilot debug] Response body: ${bodyText}\n`
        );
    }

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return { ok: false, status: res.status, errBody };
    }

    const data = await res.json();
    return { ok: true, status: res.status, data };
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
            headers: githubHeaders(githubToken),
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
        // IMPORTANT: Include year + month params to scope to current billing period.
        // Without these, the API returns ALL usage for the year, not just this month.
        const now = new Date();
        const year = now.getUTCFullYear();
        const month = now.getUTCMonth() + 1; // 1-indexed

        const usagePath = `/users/${encodeURIComponent(resolvedUsername)}/settings/billing/premium_request/usage`;
        const baseParams = `year=${year}&month=${month}`;

        if (isDebug) {
            process.stderr.write(
                `[Copilot debug] Querying for year=${year}, month=${month}, user=${resolvedUsername}\n`
            );
        }

        // Try with product=Copilot filter first, then without, then fallback to /user/ endpoint
        const urlsToTry = [
            `${API_BASE}${usagePath}?product=Copilot&${baseParams}`,
            `${API_BASE}${usagePath}?${baseParams}`,
            // Fallback: authenticated user endpoint (no username in path)
            `${API_BASE}/user/settings/billing/premium_request/usage?product=Copilot&${baseParams}`,
            `${API_BASE}/user/settings/billing/premium_request/usage?${baseParams}`,
        ];

        let usageData = null;
        let lastStatus = null;
        let lastErrBody = '';

        for (const url of urlsToTry) {
            const result = await fetchUsage(url, githubToken);

            if (result.ok) {
                usageData = result.data;
                break;
            }

            lastStatus = result.status;
            lastErrBody = result.errBody || '';

            // Don't retry on auth errors — they won't change
            if (result.status === 401) {
                return {
                    provider: name,
                    status: 'error',
                    quotas: [],
                    tier: null,
                    error: 'Auth failed — invalid/expired PAT (run --setup)',
                };
            }

            if (result.status === 403) {
                return {
                    provider: name,
                    status: 'error',
                    quotas: [],
                    tier: null,
                    error: 'PAT lacks billing permission — use a fine-grained PAT with User "Plan: Read"',
                };
            }

            // 422 means this URL variant isn't supported, try next
            // 404 also try next (might work with /user/ fallback)
            if (result.status !== 422 && result.status !== 404) {
                // Unexpected error — stop retrying
                break;
            }
        }

        if (!usageData) {
            // All URLs failed
            if (lastStatus === 404) {
                return {
                    provider: name,
                    status: 'error',
                    quotas: [],
                    tier: null,
                    error: 'No personal Copilot billing data found (may be billed via org/enterprise)',
                };
            }
            throw new Error(
                `HTTP ${lastStatus}${lastErrBody ? ': ' + lastErrBody.slice(0, 120) : ''}`
            );
        }

        const used = sumPremiumRequests(usageData);
        const limit = Number(monthlyLimit) > 0 ? Number(monthlyLimit) : 300;
        const remaining = Math.max(0, limit - used);
        const percentRemaining = Math.max(0, Math.min(100, (remaining / limit) * 100));

        if (isDebug) {
            process.stderr.write(
                `[Copilot debug] Used: ${used}, Limit: ${limit}, Remaining: ${remaining}, ` +
                `%Remaining: ${percentRemaining.toFixed(1)}%\n`
            );
        }

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
