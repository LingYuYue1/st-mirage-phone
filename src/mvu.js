/**
 * MVU 变量读取层（二创）
 * ------------------------------------------------------------------
 * 酒馆的 MVU（MagVarUpdate）变量有三层落点，不同版本/插件组合下位置不同：
 *   1. `globalThis.Mvu.getMvuData({ type })` —— 官方入口，最准
 *   2. 酒馆助手（JS-Slash-Runner）的 `getVariables` / `TavernHelper`
 *   3. 兜底：直接读 `chatMetadata.variables` / `chatMetadata.MVU`
 *
 * 这里统一成 `readVariables()`，并把「带 [值, 说明] 二元组」的 MVU 结构
 * 摊平成普通值——卡作者写 `"姓名": ["秋穗", "当前调教对象的姓名"]`，
 * 真正的值在 `[0]`。所有下游只处理普通值，不用各自记住这条规则。
 */

/** 取 Mvu 全局对象；没装 MVU 框架就返回 null。 */
export function mvuApi() {
    try {
        const api = globalThis.Mvu;
        return api && typeof api.getMvuData === 'function' ? api : null;
    } catch {
        return null;
    }
}

export function mvuAvailable() {
    return !!mvuApi();
}

/**
 * 读变量树。按可靠性依次尝试几个入口，第一个拿到的就用。
 * @returns {{ source: string, data: object } | null}
 */
export function readVariables({ type = 'chat' } = {}) {
    // 1) 官方 Mvu
    const api = mvuApi();
    if (api) {
        for (const options of [{ type }, { type: 'message', message_id: 'latest' }]) {
            try {
                const data = api.getMvuData(options);
                const stat = data?.stat_data;
                if (stat && typeof stat === 'object' && Object.keys(stat).length) {
                    return { source: 'Mvu:' + options.type, data: stat };
                }
            } catch { /* 试下一个 */ }
        }
    }

    // 2) 酒馆助手 / TavernHelper
    const helper = globalThis.TavernHelper;
    if (helper && typeof helper.getVariables === 'function') {
        try {
            const data = helper.getVariables({ type });
            if (data && typeof data === 'object' && Object.keys(data).length) {
                const stat = data.stat_data && typeof data.stat_data === 'object' ? data.stat_data : data;
                if (Object.keys(stat).length) return { source: 'TavernHelper', data: stat };
            }
        } catch { /* 继续 */ }
    }

    // 3) 直接读聊天元数据
    try {
        const c = globalThis.SillyTavern?.getContext?.();
        const meta = c?.chatMetadata || {};
        for (const key of ['variables', 'MVU', 'mvu', 'stat_data']) {
            const value = meta[key];
            if (!value || typeof value !== 'object') continue;
            const stat = value.stat_data && typeof value.stat_data === 'object' ? value.stat_data : value;
            if (Object.keys(stat).length) return { source: 'chatMetadata.' + key, data: stat };
        }
    } catch { /* ignore */ }

    return null;
}

/** MVU 的 `[值, 说明]` 二元组 → 值。不是二元组就原样返回。 */
export function unwrap(value) {
    if (!Array.isArray(value)) return value;
    if (value.length === 0) return undefined;
    // ["$__META_EXTENSIBLE__$", "说明"] 这种是「空的可扩展列表」
    if (value[0] === '$__META_EXTENSIBLE__$') return [];
    // [值, "说明"]：第二项是字符串说明
    if (value.length === 2 && typeof value[1] === 'string') return value[0];
    return value;
}

/** MVU 用来占位的哨兵字符串，不能出现在给模型看的文本里。 */
const EXTENSIBLE_SENTINEL = '$__META_EXTENSIBLE__$';

/** 递归摊平整棵变量树：二元组取 [0]，$meta 和哨兵去掉。 */
export function flattenVars(value, depth = 0) {
    if (depth > 12) return null;
    const raw = unwrap(value);
    if (raw === null || raw === undefined) return null;
    // 哨兵本身直接丢掉
    if (raw === EXTENSIBLE_SENTINEL) return null;
    if (Array.isArray(raw)) {
        return raw
            .map(item => flattenVars(item, depth + 1))
            .filter(item => item !== null && item !== undefined && item !== '' && item !== EXTENSIBLE_SENTINEL);
    }
    if (typeof raw === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(raw)) {
            if (key === '$meta') continue;
            const flat = flattenVars(item, depth + 1);
            if (flat === null || flat === undefined || flat === '') continue;
            if (Array.isArray(flat) && flat.length === 0) continue;
            if (typeof flat === 'object' && !Array.isArray(flat) && Object.keys(flat).length === 0) continue;
            out[key] = flat;
        }
        return out;
    }
    return raw;
}

/** 摊平后的完整变量树（缓存一次读取结果，调用方自己决定何时重读）。 */
export function flatVariables({ type = 'chat' } = {}) {
    const result = readVariables({ type });
    if (!result) return { source: 'none', vars: {} };
    return { source: result.source, vars: flattenVars(result.data) || {} };
}

/** 按路径取值，路径用点号和 [n]。 */
export function pickVars(vars, path) {
    const parts = String(path || '').split('.').filter(Boolean);
    let node = vars;
    for (const part of parts) {
        const match = part.match(/^([^[\]]+)((\[\d+\])*)$/);
        if (!match) return undefined;
        node = node?.[match[1]];
        if (node === undefined) return undefined;
        for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
            node = node?.[Number(index[1])];
            if (node === undefined) return undefined;
        }
    }
    return node;
}

/** 把摊平后的变量树压成一段给模型看的文本（控制长度）。 */
export function varsToText(vars, { maxLines = 40, maxChars = 1200 } = {}) {
    const lines = [];
    const walk = (node, prefix) => {
        if (lines.length >= maxLines) return;
        if (node === null || node === undefined) return;
        if (Array.isArray(node)) {
            if (!node.length) return;
            const text = node
                .map(item => (typeof item === 'object' ? JSON.stringify(item) : String(item)))
                .filter(item => item && item !== EXTENSIBLE_SENTINEL)
                .join('、');
            if (!text) return;
            lines.push(prefix + '：' + text.slice(0, 160));
            return;
        }
        if (typeof node === 'object') {
            for (const [key, item] of Object.entries(node)) {
                walk(item, prefix ? prefix + '·' + key : key);
                if (lines.length >= maxLines) return;
            }
            return;
        }
        lines.push(prefix + '：' + String(node).slice(0, 120));
    };
    walk(vars, '');
    let text = lines.join('\n');
    if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
    return text;
}
