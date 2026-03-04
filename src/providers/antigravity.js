import { execFileSync, execSync } from 'node:child_process';
import https from 'node:https';

export const name = 'Antigravity';
const isDebug = process.argv.includes('--debug');
const isWSL = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME);

// Custom HTTPS agent that ignores self-signed certs for localhost
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function debugLog(message) {
    if (!isDebug) return;
    process.stderr.write(`[Antigravity debug] ${message}\n`);
}

function maskToken(token) {
    if (!token) return '(missing)';
    if (token.length <= 8) return '***';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function normalizeToken(token) {
    return String(token || '')
        .trim()
        .replace(/^['"]+|['"]+$/g, '');
}

function uniqueNonEmpty(values) {
    return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

function extractFlagValues(commandLine, flagRegex) {
    const values = [];
    const regex = new RegExp(`${flagRegex.source}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`, 'gi');
    let match;
    while ((match = regex.exec(commandLine))) {
        const raw = match[1] ?? match[2] ?? match[3] ?? '';
        const normalized = normalizeToken(raw);
        if (normalized) values.push(normalized);
    }
    return uniqueNonEmpty(values);
}

function parseWindowsProcessListJson(output) {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
}

function errorMessage(err) {
    if (!err) return 'Unknown error';
    const causeCode = err?.cause?.code;
    if (causeCode) return `${err.message} (${causeCode})`;
    return err.message || String(err);
}

function psSingleQuote(value) {
    return String(value).replace(/'/g, "''");
}

function windowsCurlRequest(url, body, csrfToken) {
    try {
        return execFileSync(
            'curl.exe',
            [
                '--silent',
                '--show-error',
                '--max-time',
                '8',
                '--insecure',
                '--header',
                'Content-Type: application/json',
                '--header',
                `X-Codeium-Csrf-Token: ${csrfToken}`,
                '--header',
                `X-Exa-Csrf-Token: ${csrfToken}`,
                '--header',
                `X-Csrf-Token: ${csrfToken}`,
                '--header',
                `Cookie: csrf_token=${csrfToken}`,
                '--header',
                'Connect-Protocol-Version: 1',
                '--data-raw',
                body,
                '--request',
                'POST',
                url,
            ],
            { encoding: 'utf-8', timeout: 12000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
    } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim().replace(/\s+/g, ' ') : '';
        if (stderr) {
            debugLog(`request: Windows curl proxy failed: ${stderr.slice(0, 300)}`);
        } else {
            debugLog(`request: Windows curl proxy failed: ${errorMessage(err)}`);
        }
        return null;
    }
}

function windowsHostRequest(url, body, csrfToken) {
    try {
        const safeUrl = psSingleQuote(url);
        const safeToken = psSingleQuote(csrfToken);
        const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
$headers = @{
  'Content-Type' = 'application/json'
  'X-Codeium-Csrf-Token' = '${safeToken}'
  'X-Exa-Csrf-Token' = '${safeToken}'
  'X-Csrf-Token' = '${safeToken}'
  'Cookie' = 'csrf_token=${safeToken}'
  'Connect-Protocol-Version' = '1'
}
$response = Invoke-WebRequest -Uri '${safeUrl}' -Method POST -Headers $headers -Body @'
${body}
'@ -UseBasicParsing -TimeoutSec 8
if ($null -ne $response.Content) {
  [Console]::Out.Write($response.Content)
}
`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        return execSync(
            `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
            { encoding: 'utf-8', timeout: 12000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
    } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim().replace(/\s+/g, ' ') : '';
        if (stderr) {
            debugLog(`request: Windows host proxy failed: ${stderr.slice(0, 300)}`);
        } else {
            debugLog(`request: Windows host proxy failed: ${errorMessage(err)}`);
        }
        return null;
    }
}

/**
 * Detect the Antigravity process running on Windows (from WSL or native).
 * Returns { pid, csrfToken, ports } or null.
 */
function detectProcess() {
    try {
        let output;
        let tokenPortPairs = [];
        debugLog(`detectProcess: platform=${process.platform}, wsl=${Boolean(isWSL)}`);

        if (isWSL) {
            // From WSL, use powershell.exe to query Windows processes
            debugLog('detectProcess: querying Windows process list via PowerShell');
            output = execSync(
                `powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { \\$_.Name -match 'language_server' -or \\$_.Name -match 'antigravity' } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"`,
                { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
            );

            const rows = parseWindowsProcessListJson(output);
            const tokens = [];
            const ports = [];
            const pids = [];

            for (const row of rows) {
                const pid = Number(row?.ProcessId);
                if (Number.isFinite(pid) && pid > 0) pids.push(pid);

                const commandLine = String(row?.CommandLine || '');
                if (!commandLine) continue;

                const rowTokens = extractFlagValues(commandLine, /--csrf(?:[_-]?token)?/i);
                const rowPorts = extractFlagValues(commandLine, /--extension(?:[_-]?server)?[_-]?port/i)
                    .map((v) => Number(v))
                    .filter((v) => Number.isFinite(v) && v > 0);

                for (const token of rowTokens) tokens.push(token);
                for (const port of rowPorts) ports.push(port);

                if (rowTokens.length > 0) {
                    if (rowPorts.length > 0) {
                        for (const token of rowTokens) {
                            for (const port of rowPorts) {
                                tokenPortPairs.push({ pid: Number.isFinite(pid) ? pid : null, csrfToken: token, port });
                            }
                        }
                    } else {
                        for (const token of rowTokens) {
                            tokenPortPairs.push({ pid: Number.isFinite(pid) ? pid : null, csrfToken: token, port: null });
                        }
                    }
                }
            }

            const uniquePids = uniqueNonEmpty(pids);
            const uniquePorts = uniqueNonEmpty(ports);
            const uniqueTokens = uniqueNonEmpty(tokens);
            output = [
                `ProcessIds: ${uniquePids.join(', ')}`,
                `ExtensionPorts: ${uniquePorts.join(', ')}`,
                ...uniqueTokens.map((t) => `--csrf_token ${t}`),
            ].join('\n');
        } else if (process.platform === 'win32') {
            // Native Windows
            debugLog('detectProcess: querying process list via wmic');
            output = execSync(
                'wmic process where "name like \'%language_server%\' or name like \'%antigravity%\'" get processid,commandline /format:list',
                { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
        } else {
            // macOS/Linux native
            try {
                debugLog('detectProcess: querying process list via pgrep');
                output = execSync('pgrep -lf language_server_macos', {
                    encoding: 'utf-8',
                    timeout: 10000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (err) {
                debugLog(`detectProcess: pgrep failed: ${errorMessage(err)}`);
                return null;
            }
        }

        if (!output || !output.trim()) {
            debugLog('detectProcess: process lookup returned no output');
            return null;
        }

        // Extract CSRF tokens (can include multiple processes/tokens)
        const csrfTokens = uniqueNonEmpty(
            [...output.matchAll(/--csrf_token[=\s]+([^\s]+)/g)].map((m) => normalizeToken(m[1]))
        );
        const csrfToken = csrfTokens[0] || null;
        if (!csrfToken) {
            debugLog('detectProcess: found process output, but no --csrf_token');
            return null;
        }

        // Extract extension port if available
        const portMatch = output.match(/--extension_server_port[=\s]+(\d+)/);
        const extensionPort =
            tokenPortPairs.find((p) => Number.isFinite(p.port) && p.port > 0)?.port ||
            (portMatch ? parseInt(portMatch[1], 10) : null);

        // Extract PID
        let pid = null;
        const pidMatch = output.match(/ProcessId\s*:\s*(\d+)/i) || output.match(/^(\d+)\s/m);
        if (pidMatch) pid = parseInt(pidMatch[1], 10);
        if (!pid) {
            const pidFromPair = tokenPortPairs.find((p) => Number.isFinite(p.pid) && p.pid > 0)?.pid;
            if (pidFromPair) pid = pidFromPair;
        }

        debugLog(
            `detectProcess: found pid=${pid ?? 'unknown'}, extensionPort=${extensionPort ?? 'unknown'}, csrf=${maskToken(csrfToken)}, csrfCandidates=${csrfTokens.length}, tokenPortPairs=${tokenPortPairs.length}`
        );
        return { pid, csrfToken, csrfTokens, tokenPortPairs, extensionPort };
    } catch (err) {
        debugLog(`detectProcess: failed: ${errorMessage(err)}`);
        return null;
    }
}

/**
 * Discover listening ports for the Antigravity process.
 * Returns an array of port numbers.
 */
function discoverPorts(processInfo) {
    const ports = new Set();
    debugLog(
        `discoverPorts: start pid=${processInfo.pid ?? 'unknown'}, extensionPort=${processInfo.extensionPort ?? 'none'}`
    );

    // Always include the extension port if known
    if (processInfo.extensionPort) {
        ports.add(processInfo.extensionPort);
    }

    // Try to find more ports via lsof/netstat
    try {
        const isWSL = process.platform === 'linux' && process.env.WSL_DISTRO_NAME;

        if (isWSL && processInfo.pid) {
            // From WSL, use powershell to get listening ports
            const output = execSync(
                `powershell.exe -NoProfile -NonInteractive -Command "Get-NetTCPConnection -State Listen -OwningProcess ${processInfo.pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort"`,
                { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            for (const line of output.split('\n')) {
                const port = parseInt(line.trim(), 10);
                if (port > 0) ports.add(port);
            }
        } else if (processInfo.pid) {
            try {
                const output = execSync(
                    `lsof -nP -iTCP -sTCP:LISTEN -a -p ${processInfo.pid}`,
                    { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
                );
                const regex = /:(\d+)\s+\(LISTEN\)/g;
                let match;
                while ((match = regex.exec(output))) {
                    ports.add(parseInt(match[1], 10));
                }
            } catch (err) {
                debugLog(`discoverPorts: lsof unavailable/failed: ${errorMessage(err)}`);
                // lsof not available
            }
        }
    } catch (err) {
        debugLog(`discoverPorts: dynamic discovery failed: ${errorMessage(err)}`);
        // Port discovery failed, rely on extension port
    }

    // Common Antigravity ports as fallback
    if (ports.size === 0) {
        debugLog('discoverPorts: using fallback range 42100-42110');
        for (let p = 42100; p <= 42110; p++) ports.add(p);
    }

    const discovered = [...ports];
    debugLog(`discoverPorts: final ports=[${discovered.join(', ')}]`);
    return discovered;
}

/**
 * Make an API request to the Antigravity local server.
 */
async function makeRequest(scheme, port, apiPath, csrfToken) {
    const url = `${scheme}://127.0.0.1:${port}${apiPath}`;
    debugLog(`request: POST ${url}`);

    const body = JSON.stringify({
        metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            ideVersion: 'unknown',
            locale: 'en',
        },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Codeium-Csrf-Token': csrfToken,
                'X-Exa-Csrf-Token': csrfToken,
                'X-Csrf-Token': csrfToken,
                Cookie: `csrf_token=${csrfToken}`,
                'Connect-Protocol-Version': '1',
            },
            body,
            signal: controller.signal,
        };

        // For HTTPS with self-signed certs, we need the custom agent
        if (scheme === 'https') {
            // Node's native fetch doesn't support custom agents directly,
            // so we use the node:https module for this case
            const result = await new Promise((resolve, reject) => {
                try {
                    const urlObj = new URL(url);
                    const req = https.request(
                        {
                            hostname: urlObj.hostname,
                            port: urlObj.port,
                            path: urlObj.pathname,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Codeium-Csrf-Token': csrfToken,
                                'X-Exa-Csrf-Token': csrfToken,
                                'X-Csrf-Token': csrfToken,
                                Cookie: `csrf_token=${csrfToken}`,
                                'Connect-Protocol-Version': '1',
                            },
                            agent: insecureAgent,
                            timeout: 8000,
                        },
                        (res) => {
                            const chunks = [];
                            res.on('data', (chunk) => chunks.push(chunk));
                            res.on('end', () => {
                                const responseText = Buffer.concat(chunks).toString('utf-8');
                                if (res.statusCode === 200) {
                                    debugLog(`request: success ${url} (${responseText.length} bytes)`);
                                    resolve(responseText);
                                } else {
                                    const preview = responseText.slice(0, 200).replace(/\s+/g, ' ');
                                    debugLog(`request: HTTP ${res.statusCode} from ${url}, body=${preview}`);
                                    reject(new Error(`HTTP ${res.statusCode}`));
                                }
                            });
                        }
                    );
                    req.on('error', (err) => {
                        debugLog(`request: socket error for ${url}: ${errorMessage(err)}`);
                        reject(err);
                    });
                    req.on('timeout', () => {
                        req.destroy();
                        debugLog(`request: timeout for ${url}`);
                        reject(new Error('Timeout'));
                    });
                    req.write(body);
                    req.end();
                } catch (err) {
                    reject(err);
                }
            });
            return result;
        } else {
            const res = await fetch(url, options);
            if (!res.ok) {
                const bodyText = await res.text().catch(() => '(unreadable)');
                const preview = bodyText.slice(0, 200).replace(/\s+/g, ' ');
                debugLog(`request: HTTP ${res.status} from ${url}, body=${preview}`);
                throw new Error(`HTTP ${res.status}`);
            }
            const responseText = await res.text();
            debugLog(`request: success ${url} (${responseText.length} bytes)`);
            return responseText;
        }
    } catch (err) {
        debugLog(`request: failed ${url}: ${errorMessage(err)}`);
        if (isWSL) {
            debugLog(`request: retrying via Windows curl proxy for ${url}`);
            const curlProxied = windowsCurlRequest(url, body, csrfToken);
            if (curlProxied != null) {
                debugLog(`request: Windows curl proxy success ${url} (${curlProxied.length} bytes)`);
                return curlProxied;
            }

            debugLog(`request: retrying via Windows host PowerShell for ${url}`);
            const psProxied = windowsHostRequest(url, body, csrfToken);
            if (psProxied != null) {
                debugLog(`request: Windows host proxy success ${url} (${psProxied.length} bytes)`);
                return psProxied;
            }
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Fetch quota data from the Antigravity local API.
 */
async function fetchQuota(ports, csrfTokenOrTokens, extensionPort, tokenPortPairs = []) {
    const paths = [
        '/exa.language_server_pb.LanguageServerService/GetUserStatus',
        '/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs',
    ];
    const csrfTokens = uniqueNonEmpty(
        Array.isArray(csrfTokenOrTokens) ? csrfTokenOrTokens : [csrfTokenOrTokens]
    );
    const pairs = Array.isArray(tokenPortPairs) ? tokenPortPairs : [];
    debugLog(`fetchQuota: trying ${csrfTokens.length} csrf token candidate(s)`);
    debugLog(`fetchQuota: trying HTTPS on ports=[${ports.join(', ')}]`);

    const tokenCandidates = [];
    const seenTokens = new Set();
    for (const pair of pairs) {
        const token = normalizeToken(pair?.csrfToken);
        if (!token || seenTokens.has(token)) continue;
        tokenCandidates.push({ csrfToken: token, preferredPort: Number(pair?.port) || null });
        seenTokens.add(token);
    }
    for (const token of csrfTokens) {
        if (seenTokens.has(token)) continue;
        tokenCandidates.push({ csrfToken: token, preferredPort: null });
        seenTokens.add(token);
    }

    for (const candidate of tokenCandidates) {
        const csrfToken = candidate.csrfToken;
        debugLog(`fetchQuota: trying csrf=${maskToken(csrfToken)}`);
        const orderedPorts = uniqueNonEmpty(
            [candidate.preferredPort, ...ports].map((p) => (Number(p) > 0 ? String(Number(p)) : ''))
        ).map((p) => Number(p));
        if (candidate.preferredPort) {
            debugLog(`fetchQuota: preferring paired port ${candidate.preferredPort} for csrf=${maskToken(csrfToken)}`);
        }

        // Try HTTPS first on discovered ports
        for (const port of orderedPorts) {
            for (const apiPath of paths) {
                const result = await makeRequest('https', port, apiPath, csrfToken);
                if (result) {
                    if (/invalid csrf token/i.test(result)) {
                        debugLog(`fetchQuota: csrf rejected by https://127.0.0.1:${port}${apiPath}`);
                        continue;
                    }
                    debugLog(`fetchQuota: success via https://127.0.0.1:${port}${apiPath}`);
                    return result;
                }
            }
        }

        // Fallback to HTTP on extension port
        if (extensionPort) {
            debugLog(`fetchQuota: HTTPS probe failed, trying HTTP on extensionPort=${extensionPort}`);
            for (const apiPath of paths) {
                const result = await makeRequest('http', extensionPort, apiPath, csrfToken);
                if (result) {
                    if (/invalid csrf token/i.test(result)) {
                        debugLog(`fetchQuota: csrf rejected by http://127.0.0.1:${extensionPort}${apiPath}`);
                        continue;
                    }
                    debugLog(`fetchQuota: success via http://127.0.0.1:${extensionPort}${apiPath}`);
                    return result;
                }
            }
        }
    }

    debugLog('fetchQuota: all connection attempts failed');
    return null;
}

/**
 * Parse the user status response from Antigravity.
 */
function parseResponse(responseText) {
    let data;
    try {
        data = JSON.parse(responseText);
    } catch (err) {
        const preview = responseText.slice(0, 240).replace(/\s+/g, ' ');
        debugLog(`parseResponse: invalid JSON, preview=${preview}`);
        throw err;
    }

    // Navigate to model configs
    const modelConfigs =
        data.userStatus?.cascadeModelConfigData?.clientModelConfigs ||
        data.user_status?.cascade_model_config_data?.client_model_configs ||
        [];
    debugLog(`parseResponse: modelConfigs=${modelConfigs.length}`);

    const quotas = [];
    for (const config of modelConfigs) {
        const quotaInfo = config.quotaInfo || config.quota_info;
        if (!quotaInfo) continue;

        const remainingFraction =
            quotaInfo.remainingFraction ?? quotaInfo.remaining_fraction ?? 0;
        const resetTime = quotaInfo.resetTime || quotaInfo.reset_time;

        let resetText = null;
        if (resetTime) {
            const date = new Date(resetTime);
            const seconds = (date - Date.now()) / 1000;
            if (seconds > 0) {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                if (hours > 0) resetText = `Resets in ${hours}h ${minutes}m`;
                else if (minutes > 0) resetText = `Resets in ${minutes}m`;
                else resetText = 'Resets soon';
            }
        }

        const label = config.label || config.modelName || config.model_name || 'Unknown';

        quotas.push({
            label,
            percentRemaining: remainingFraction * 100,
            resetText,
        });
    }
    debugLog(`parseResponse: parsed quotas=${quotas.length}`);

    return quotas;
}

/**
 * Check Antigravity rate limits.
 */
export async function check() {
    const processInfo = detectProcess();

    if (!processInfo) {
        debugLog('check: Antigravity process not found');
        return {
            provider: name,
            status: 'not_installed',
            quotas: [],
            tier: null,
            error: null,
        };
    }

    try {
        debugLog(
            `check: process pid=${processInfo.pid ?? 'unknown'}, extensionPort=${processInfo.extensionPort ?? 'unknown'}, csrf=${maskToken(processInfo.csrfToken)}`
        );
        const ports = discoverPorts(processInfo);
        const responseText = await fetchQuota(
            ports,
            processInfo.csrfTokens || processInfo.csrfToken,
            processInfo.extensionPort,
            processInfo.tokenPortPairs
        );

        if (!responseText) {
            debugLog('check: failed to connect to API after probing all candidates');
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'Could not connect to Antigravity API',
            };
        }

        debugLog(`check: received response (${responseText.length} bytes)`);
        const quotas = parseResponse(responseText);

        if (quotas.length === 0) {
            debugLog('check: API response parsed but returned zero quotas');
            return {
                provider: name,
                status: 'error',
                quotas: [],
                tier: null,
                error: 'No quota data in response',
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
        debugLog(`check: unexpected error: ${errorMessage(err)}`);
        return {
            provider: name,
            status: 'error',
            quotas: [],
            tier: null,
            error: `Error: ${errorMessage(err)}`,
        };
    }
}
