/**
 * 局域网 Magpie 网关适配层（二创）
 * ------------------------------------------------------------------
 * 为什么不能像「独立接口」那样在浏览器里直接 fetch：
 *   1. magpie 的 /v1 只接受「列在 Settings → Network and sharing → Web pages
 *      里」的网页来源。浏览器发请求一定会带 Origin，没登记的来源会被
 *      403 挡掉（日志：refused OPTIONS /v1/chat/completions ... not one listed in Settings）。
 *   2. 即使登记了，预检 OPTIONS 也不一定被允许。
 *
 * 所以这里走酒馆（SillyTavern）**服务端**转发：
 *   POST /api/backends/chat-completions/generate
 *   { chat_completion_source: 'openai', reverse_proxy: <magpie 的 /v1 地址>,
 *     proxy_password: <magpie gateway key>, model, messages, ... }
 * 酒馆进程用 node fetch 出网，不带 Origin，magpie 认的是 gateway key，
 * 于是「手机浏览器 → 酒馆 → 本机 magpie」整条链路成立。
 *
 * 本文件刻意不 import ./st.js，避免和 st.js 形成循环依赖。
 */

const DEFAULT_PROXY_PATH = '/api/backends/chat-completions';

/** magpie 的推理档位（实测 trae-cn / opencode-go 支持 low/high/max，workbuddy 还支持 none）。 */
export const REASONING_LEVELS = Object.freeze(['none', 'low', 'high', 'max']);

/** 把用户随手填的地址收拾成 `http://host:port/v1`。 */
export function normalizeBase(input) {
    let text = String(input || '').trim();
    if (!text) return '';
    text = text.replace(/\/+$/, '');
    // 允许只填 IP:端口 或 http://ip:端口/chat/completions
    if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
    text = text.replace(/\/chat\/completions$/i, '');
    text = text.replace(/\/+$/, '');
    // 末尾没有 /v1 且不是某个自定义路径时补上
    if (!/\/v\d+(?:beta)?$/i.test(text)) text += '/v1';
    return text;
}

/** 当前设置里的 magpie 配置；没启用就返回 null。 */
export function magpieConfig(settings) {
    const raw = settings?.ai?.magpie;
    if (!raw || raw.enabled !== true) return null;
    const baseUrl = normalizeBase(raw.baseUrl);
    const model = String(raw.model || '').trim();
    if (!baseUrl || !model) return null;
    return {
        baseUrl,
        apiKey: String(raw.apiKey || '').trim(),
        model,
        mode: raw.mode === 'direct' ? 'direct' : 'proxy',
        reasoning: REASONING_LEVELS.includes(String(raw.reasoning || '')) ? String(raw.reasoning) : 'low',
        temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0.9,
        proxyPath: String(raw.proxyPath || DEFAULT_PROXY_PATH).replace(/\/+$/, ''),
    };
}

/** 酒馆自带的请求头（含 CSRF token），转发请求必须带上。 */
function tavernHeaders() {
    try {
        const ctx = globalThis.SillyTavern?.getContext?.();
        return ctx?.getRequestHeaders?.() || {};
    } catch {
        return {};
    }
}

/** 酒馆服务端转发：一次 chat/completions。 */
async function postProxy(config, path, payload) {
    const response = await fetch(config.proxyPath + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tavernHeaders() },
        body: JSON.stringify(payload),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON，下面按文本处理 */ }
    if (!response.ok) {
        throw new Error(explainError(response.status, text || (data && JSON.stringify(data)) || ''));
    }
    return data;
}

/**
 * 浏览器直连：只在 mode='direct' 用。
 * 前提是酒馆地址已经被登记进 magpie 的 Web pages，否则 403。
 */
async function postDirect(config, path, payload) {
    const url = config.baseUrl + (path === '/status' ? '/models' : '/chat/completions');
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;
    const response = await fetch(url, {
        method: path === '/status' ? 'GET' : 'POST',
        headers,
        ...(path === '/status' ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!response.ok) {
        throw new Error(explainError(response.status, text || (data && JSON.stringify(data)) || ''));
    }
    return data;
}

function send(config, path, payload) {
    return config.mode === 'direct' ? postDirect(config, path, payload) : postProxy(config, path, payload);
}

/** 把 magpie / 酒馆 / 网络层的报错翻译成人话。 */
export function explainError(status, detail) {
    const raw = String(detail || '').slice(0, 400);
    const lower = raw.toLowerCase();
    const code = Number(status) || 0;

    if (lower.includes('not one listed in settings') || lower.includes('doesn\u0027t answer the web page')) {
        return 'magpie 拒绝了这个网页来源。别在浏览器里直连——用「经酒馆转发」模式，或把来源加进 magpie 的 Settings → Network and sharing → Web pages。';
    }
    if (lower.includes('no api key was sent')) {
        return 'magpie 没收到 gateway key：把 Settings 里的 Key 填上（magpie 里 Settings → Network and sharing 可复制）。';
    }
    if (lower.includes('not an enabled magpie gateway key') || lower.includes('disabled, removed or mistyped')) {
        return '这个 magpie gateway key 已失效（被停用/删除/打错字）：去 magpie 重新复制一个，或先确认局域网访问是开着的。';
    }
    if (code === 401) return 'Key 无效或过期（401）。';
    if (code === 403) return '被 magpie 挡住了（403）：多半是网页来源白名单或 Key 权限。' + (raw ? ' 原文：' + raw : '');
    if (code === 404) return '接口地址返回 404：地址要填到 /v1，模型名也要对（可用「拉取模型」按钮核对）。' + (raw ? ' 原文：' + raw : '');
    if (code === 429) return 'magpie 那边限流或额度用完了（429），等一下再试。';
    if (code === 502 || code === 504) return '酒馆转发失败（' + code + '）：确认 magpie 在跑，且这个地址从酒馆所在机器能打开。' + (raw ? ' 原文：' + raw : '');
    if (/econnrefused|connection refused/i.test(raw)) return '连不上 magpie：确认 magpie 在运行、端口对、局域网访问已打开。';
    if (/timeout|aborted|abort/i.test(raw)) return '转发超时：模型可能在长推理，稍等或把推理强度调低。';
    if (/fetch failed|failed to fetch|networkerror/i.test(raw)) return '请求没发出去：检查酒馆地址，以及浏览器能不能打开酒馆页面。';
    if (!raw) return '转发失败（HTTP ' + (code || '?') + '），没有更多信息。';
    return '转发失败（HTTP ' + (code || '?') + '）：' + raw;
}

/** 从酒馆/模型返回里取正文，兼顾推理模型把内容塞进 reasoning_content 的情况。 */
export function textFromCompletion(data) {
    const choice = data?.choices?.[0];
    let text = choice?.message?.content ?? choice?.text ?? '';
    if (Array.isArray(text)) text = text.map(part => (typeof part === 'string' ? part : part?.text || '')).join('');
    return String(text || '').trim();
}

export function reasoningFromCompletion(data) {
    const choice = data?.choices?.[0];
    return String(choice?.message?.reasoning_content || choice?.message?.reasoning || '').trim();
}

/** 推理模型把答案写成 JSON、正文却空着时，从 reasoning 里捞 JSON。 */
export function jsonFromReasoning(reasoning) {
    const text = String(reasoning || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? text.slice(start, end + 1) : '';
}

/**
 * 经酒馆转发到 magpie 生成一段文本。
 * @param {{system?: string, prompt?: string, length?: number, json?: boolean, reasoning?: string}} options
 */
export async function magpieGenerate(options, config) {
    const cfg = config || magpieConfig(options?.settings);
    if (!cfg) throw new Error('没有配置 magpie：设置 → 手机 AI 接口 → 经酒馆转发到 magpie');

    const system = String(options.system || '').trim();
    const prompt = String(options.prompt || '').trim();
    if (!prompt) throw new Error('提示词是空的');
    const maxTokens = Math.max(256, Math.round(Number(options.length) || 320));
    const reasoning = REASONING_LEVELS.includes(String(options.reasoning || '')) ? String(options.reasoning) : cfg.reasoning;

    const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
    ];

    // 经酒馆转发时，酒馆自己拼 chat/completions 请求体；
    // 直连时这里就是完整的请求体。
    const isProxy = cfg.mode !== 'direct';
    const base = isProxy
        ? {
            chat_completion_source: 'openai',
            reverse_proxy: cfg.baseUrl,
            proxy_password: cfg.apiKey,
            model: cfg.model,
            messages,
            max_tokens: maxTokens,
            temperature: cfg.temperature,
            stream: false,
        }
        : {
            model: cfg.model,
            messages,
            max_tokens: maxTokens,
            temperature: cfg.temperature,
            stream: false,
        };
    const withReasoning = reasoning === 'none'
        ? { ...base, reasoning_effort: 'none' }
        : { ...base, reasoning_effort: reasoning };

    const data = await send(cfg, '/generate', withReasoning);
    if (data?.error) {
        const message = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
        throw new Error(explainError(0, message));
    }

    let text = textFromCompletion(data);
    if (!text) {
        const reasoningText = reasoningFromCompletion(data);
        // 推理把 max_tokens 吃光了：降档再要一次
        if (reasoningText && reasoning !== 'none') {
            const retry = await send(cfg, '/generate', { ...base, reasoning_effort: 'none' });
            text = textFromCompletion(retry);
            if (!text) text = options.json ? jsonFromReasoning(reasoningFromCompletion(retry)) : '';
        }
        if (!text && options.json) text = jsonFromReasoning(reasoningText);
        if (!text && reasoningText) text = reasoningText;
    }
    if (!text) throw new Error('模型没有返回内容：把推理强度调成 none，或把回复长度调大一点');
    return text;
}

/** 拉模型列表（转发模式走酒馆的 /status，直连模式打 magpie 的 /v1/models）。 */
export async function magpieListModels(override) {
    const cfg = override || magpieConfig(override?.settings);
    if (!cfg) throw new Error('先把地址和 Key 填上');
    const data = cfg.mode === 'direct'
        ? await postDirect(cfg, '/status', {})
        : await postProxy(cfg, '/status', {
            chat_completion_source: 'openai',
            reverse_proxy: cfg.baseUrl,
            proxy_password: cfg.apiKey,
        });
    if (data?.error) throw new Error(explainError(0, typeof data.error === 'string' ? data.error : JSON.stringify(data.error)));
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
        .filter(item => item && typeof item === 'object' && item.id)
        .map(item => ({
            id: String(item.id),
            label: String(item.display_name || item.magpie_label || item.id),
            context: Number(item.context_length || item.context_window || 0) || 0,
            reasoning: item.reasoning === true || Array.isArray(item.reasoning_levels),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** 测试连接：真的生成一次，返回一段样例文本。 */
export async function magpiePing(override) {
    const cfg = override || magpieConfig(override?.settings);
    if (!cfg) throw new Error('先把地址、Key、模型填上');
    const text = await magpieGenerate(
        { system: '你是连通性测试。只回一句话，不要解释。', prompt: '用不超过八个字确认你在线。', length: 256, reasoning: 'none' },
        cfg,
    );
    return { model: cfg.model, baseUrl: cfg.baseUrl, text };
}
