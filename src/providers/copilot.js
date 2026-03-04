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
        items = data;
    } else {
        items = Array.isArray(data?.usageItems)
            ? data.usageItems
            : Array.isArray(data?.usage_items)
                ? data.usage_items
                : [];
    }

    // Use grossQuantity (actual usage) NOT netQuantity.
    // The API models included premium requests (e.g. 300/mo for Pro) as a
    // "discount" — so netQuantity is 0 until you exceed your allowance,
    // while grossQuantity reflects actual premium requests consumed.
    const total = items.reduce((sum, item) => {
        const quantity = Number(
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
 * Attempt to fetch from a URL with debug logging.
 * Returns { ok, status, data, errBody }.
 */
async function fetchWithDebug(url, token) {
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
 * Build all candidate billing URLs to try, in priority order.
 * We try multiple endpoint paths because GitHub has evolved the API over time:
 *   - /users/{user}/settings/billing/premium_request/usage  (current docs, Dec 2025+)
 *   - /users/{user}/billing/copilot/premium-requests         (older/alternative path)
 *   - /user/settings/billing/premium_request/usage           (auth-user variant)
 *   - /user/billing/copilot/premium-requests                 (auth-user older variant)
 * Each path is tried with and without the product=Copilot filter.
 */
function buildUsageUrls(username) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const dateParams = `year=${year}&month=${month}`;

    // Path variants
    const paths = [
        // Current documented path
        `/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage`,
        // Alternative/older documented path
        `/users/${encodeURIComponent(username)}/billing/copilot/premium-requests`,
        // Authenticated-user variants (no username in path)
        `/user/settings/billing/premium_request/usage`,
        `/user/billing/copilot/premium-requests`,
    ];

    const urls = [];
    for (const path of paths) {
        // Try with product filter first, then without
        urls.push(`${API_BASE}${path}?product=Copilot&${dateParams}`);
        urls.push(`${API_BASE}${path}?${dateParams}`);
    }
    return urls;
}

/**
 * Check GitHub Copilot premium request usage via GitHub Billing API.
 * @param {object} config - Config object with copilot.githubUsername and copilot.githubToken
 */
export async function check(config) {
    const { githubUsername, monthlyLimit = 300 } = config?.copilot || {};
    // Trim whitespace/newlines that may sneak in during setup
    const githubToken = (config?.copilot?.githubToken || '').trim();

    if (!githubToken) {
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: '⚠ Not configured — run with --setup to add GitHub PAT',
        };
    }

    if (isDebug) {
        const prefix = githubToken.slice(0, 10);
        const suffix = githubToken.slice(-4);
        const tokenType = githubToken.startsWith('github_pat_')
            ? 'fine-grained'
            : githubToken.startsWith('ghp_')
                ? 'classic'
                : 'unknown-type';
        process.stderr.write(
            `[Copilot debug] Token: ${prefix}...${suffix} (${tokenType}, ${githubToken.length} chars)\n`
        );
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

        // Step 2: Fetch premium request usage.
        // We try multiple endpoint paths + filter combos.
        const now = new Date();
        if (isDebug) {
            process.stderr.write(
                `[Copilot debug] Querying for year=${now.getUTCFullYear()}, ` +
                `month=${now.getUTCMonth() + 1}, user=${resolvedUsername}\n`
            );
        }

        const urls = buildUsageUrls(resolvedUsername);
        let usageData = null;
        let lastStatus = null;
        let lastErrBody = '';
        let got403 = false;

        for (const url of urls) {
            const result = await fetchWithDebug(url, githubToken);

            if (result.ok) {
                usageData = result.data;
                break;
            }

            lastStatus = result.status;
            lastErrBody = result.errBody || '';

            // 401 = bad token, stop immediately
            if (result.status === 401) {
                return {
                    provider: name,
                    status: 'error',
                    quotas: [],
                    tier: null,
                    error: 'Auth failed — invalid/expired PAT (run --setup)',
                };
            }

            // Track if we got a 403 (permission denied) from any URL
            if (result.status === 403) {
                got403 = true;
            }

            // 422 = filter not supported, 404 = path not found — try next URL
            // 403 = permission denied — also try next URL (different path might work)
            if (result.status === 422 || result.status === 404 || result.status === 403) {
                continue;
            }

            // Unexpected error — stop retrying
            break;
        }

        if (!usageData) {
            // All URLs failed — provide actionable error messages
            if (got403) {
                return {
                    provider: name,
                    status: 'error',
                    quotas: [],
                    tier: null,
                    error: 'PAT lacks billing permission — use a fine-grained PAT with "Plan: Read"',
                };
            }
            if (lastStatus === 404) {
                // GitHub returns 404 (not 403) when a classic PAT or a fine-grained
                // PAT without the Plan permission hits the billing endpoint.
                return {
                    provider: name,
                    status: 'error',
                    quotas: [],
                    tier: null,
                    error: 'Billing API returned 404 — ensure you use a fine-grained PAT with "Plan: Read" permission (classic PATs do NOT work for this endpoint)',
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
