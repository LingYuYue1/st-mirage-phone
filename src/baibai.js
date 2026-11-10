/**
 * 柏宝书（ST-BaiBai-Book）兼容层（二创）
 * ------------------------------------------------------------------
 * 柏宝书把「剧情记忆」做成了结构化状态 + 分层压缩历史，并提供只读公开接口
 * `globalThis.STBaiBaiBook`（API v1）。手机插件自己的 summarizeMemory 是
 * 另一套独立实现——两边同时跑会重复总结同一段剧情，白烧 token，还会互相打架。
 *
 * 所以这里的策略是「借用，不重复」：
 *   1. 检测到柏宝书 → 手机不再自己总结（summarizeDue 直接返回 false）
 *   2. 注入正文时改用柏宝书的快照 + getInjectedHistory()（它已经跳过滑动窗口内
 *      还在发送全文的楼层，正是「该被记住的那部分」）
 *   3. 手机内部的 AI 提示词也吃同一份历史，不再各记一套
 *
 * 接口约定见 https://github.com/baibai-git/ST-BaiBai-Book/blob/main/PUBLIC_API.md
 * 所有调用都包在 try/catch 里：柏宝书没装、没开、版本不兼容都不能拖垮手机。
 */

/** 柏宝书就绪事件名（来自它的 PUBLIC_READY_EVENT）。 */
const READY_EVENT = 'st-baibai-book:ready';

/** 缓存的快照，按 revision 失效。 */
let cachedSnapshot = null;
let cachedRevision = -1;
let cachedAt = 0;
const SNAPSHOT_TTL = 1500;

/** 拿到柏宝书 API；没装 / 没就绪就返回 null。 */
export function baiBaiApi() {
    try {
        const api = globalThis.STBaiBaiBook;
        if (!api || typeof api.getSnapshot !== 'function') return null;
        // 只认 v1；以后它升大版本，这里要重新对一遍字段
        if (Number(api.apiVersion) !== 1) return null;
        return api;
    } catch {
        return null;
    }
}

export function baiBaiAvailable() {
    return !!baiBaiApi();
}

/** 版本与能力，给设置页显示。 */
export function baiBaiInfo() {
    const api = baiBaiApi();
    if (!api) return { available: false };
    return {
        available: true,
        pluginVersion: String(api.pluginVersion || '?'),
        apiVersion: Number(api.apiVersion) || 0,
        capabilities: api.capabilities || {},
    };
}

/**
 * 等柏宝书就绪。插件加载顺序不固定，所以手机这边也可能先起来。
 * 返回取消函数。
 */
export function onBaiBaiReady(callback) {
    if (baiBaiAvailable()) {
        callback(baiBaiApi());
        return () => {};
    }
    const handler = () => callback(baiBaiApi());
    try {
        globalThis.addEventListener?.(READY_EVENT, handler, { once: true });
    } catch { /* ignore */ }
    return () => {
        try { globalThis.removeEventListener?.(READY_EVENT, handler); } catch { /* ignore */ }
    };
}

/** 读快照，带短缓存（同一 revision 不重复取）。 */
export function baiBaiSnapshot({ floor, at } = {}) {
    const api = baiBaiApi();
    if (!api) return null;
    const options = {};
    if (Number.isInteger(floor)) options.floor = floor;
    if (at === 'before' || at === 'after') options.at = at;
    const cacheable = options.floor === undefined;
    if (cacheable && cachedSnapshot && Date.now() - cachedAt < SNAPSHOT_TTL) return cachedSnapshot;
    try {
        const snapshot = api.getSnapshot(options);
        if (!snapshot || snapshot.apiVersion !== 1) return null;
        if (cacheable) {
            // revision 变了才换对象，避免上层拿到半新半旧的数据
            if (Number(snapshot.revision) !== cachedRevision) cachedRevision = Number(snapshot.revision) || 0;
            cachedSnapshot = snapshot;
            cachedAt = Date.now();
        }
        return snapshot;
    } catch (error) {
        console.warn('[幻镜手机] 读柏宝书快照失败', error);
        return null;
    }
}

/** 正常注入口径的压缩历史（已跳过滑动窗口内仍发全文的楼层）。 */
export function baiBaiInjectedHistory() {
    const api = baiBaiApi();
    if (!api || typeof api.getInjectedHistory !== 'function') return null;
    try {
        const history = api.getInjectedHistory();
        if (!history || history.apiVersion !== 1) return null;
        return history;
    } catch (error) {
        console.warn('[幻镜手机] 读柏宝书注入历史失败', error);
        return null;
    }
}

/** 指定楼层之前的完整压缩历史。 */
export function baiBaiHistory({ before } = {}) {
    const api = baiBaiApi();
    if (!api || typeof api.getHistory !== 'function') return null;
    try {
        const options = {};
        if (Number.isInteger(before)) options.before = before;
        const history = api.getHistory(options);
        return history && history.apiVersion === 1 ? history : null;
    } catch {
        return null;
    }
}

/* --------------------------- 把 DTO 翻译成人话 --------------------------- */

const INNER_LABELS = { '-2': '强烈反感', '-1': '不喜欢', '0': '无明显好恶', '1': '有好感', '2': '感情深厚' };
const OUTER_LABELS = { '-2': '明显敌对', '-1': '冷淡疏远', '0': '不明显亲近或排斥', '1': '友善亲近', '2': '明显亲近、积极表达' };

function affinityText(npc) {
    const inner = npc?.affinityInner;
    const outer = npc?.affinityOuter;
    const parts = [];
    // 注意：null 表示「未知」，不能当成 0
    if (inner !== null && inner !== undefined && INNER_LABELS[String(inner)]) parts.push('内心' + INNER_LABELS[String(inner)]);
    if (outer !== null && outer !== undefined && OUTER_LABELS[String(outer)]) parts.push('外在' + OUTER_LABELS[String(outer)]);
    const note = String(npc?.affinityNote || '').trim();
    if (note) parts.push(note.slice(0, 60));
    return parts.join('，');
}

function clip(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? value.slice(0, max) + '…' : value;
}

/**
 * 把柏宝书快照压成一段给模型看的设定块。
 * 只挑「会改变手机里对话内容」的字段：时间地点、主角状态、在办的计划、关键物品、人物好感、生活细节。
 */
export function snapshotBlock(snapshot, { parts = {}, budget = 900 } = {}) {
    if (!snapshot) return '';
    const want = {
        state: true, protagonist: true, plans: true, items: true, npcs: true, lifeDetails: true, vars: false,
        ...parts,
    };
    const lines = [];

    if (want.state) {
        const state = snapshot.state || {};
        const where = Array.isArray(state.locationPath) && state.locationPath.length
            ? state.locationPath.join(' · ')
            : String(state.location || '').trim();
        const bits = [String(state.time || '').trim(), where].filter(Boolean);
        if (bits.length) lines.push('现在：' + bits.join('｜'));
    }

    if (want.protagonist) {
        const hero = snapshot.protagonist || {};
        const bits = [hero.gender, hero.identity, hero.outfit, hero.condition]
            .map(item => String(item || '').trim())
            .filter(Boolean);
        if (bits.length) lines.push('主角：' + bits.join('，'));
        const look = String(hero.appearance || '').trim();
        if (look) lines.push('外形：' + clip(look, 80));
    }

    if (want.plans && Array.isArray(snapshot.plans) && snapshot.plans.length) {
        const list = snapshot.plans
            .map(plan => clip(plan?.text || plan?.title || plan?.name || '', 60))
            .filter(Boolean)
            .slice(0, 4);
        if (list.length) lines.push('在办的事：' + list.join('；'));
    }

    if (want.items && Array.isArray(snapshot.items) && snapshot.items.length) {
        const list = snapshot.items
            .filter(item => item && item.name)
            .map(item => {
                const qty = Number(item.qty);
                return String(item.name) + (Number.isFinite(qty) && qty > 1 ? '×' + qty : '');
            })
            .slice(0, 8);
        if (list.length) lines.push('随身物品：' + list.join('、'));
    }

    if (want.npcs && Array.isArray(snapshot.npcs) && snapshot.npcs.length) {
        const list = snapshot.npcs
            .filter(npc => npc && npc.name)
            .map(npc => {
                const mood = affinityText(npc);
                return String(npc.name) + (mood ? '（' + mood + '）' : '');
            })
            .slice(0, 6);
        if (list.length) lines.push('人物态度：' + list.join('；'));
    }

    if (want.lifeDetails && Array.isArray(snapshot.lifeDetails) && snapshot.lifeDetails.length) {
        const list = snapshot.lifeDetails
            .map(detail => {
                const text = String(detail?.text || '').trim();
                if (!text) return '';
                const who = detail?.subject === 'user' || !detail?.subject ? '主角' : String(detail.subject);
                return who + '：' + clip(text, 50);
            })
            .filter(Boolean)
            .slice(0, 6);
        if (list.length) lines.push('生活细节：' + list.join('；'));
    }

    if (want.vars && snapshot.vars && typeof snapshot.vars === 'object') {
        try {
            const json = JSON.stringify(snapshot.vars);
            if (json && json !== '{}') lines.push('变量：' + clip(json, 220));
        } catch { /* 循环引用之类，忽略 */ }
    }

    if (!lines.length) return '';
    let text = '【柏宝书记忆 · 现状】\n' + lines.join('\n');
    if (text.length > budget) text = text.slice(0, budget) + '…';
    return text;
}

/**
 * 手机注入正文用的整块记忆：现状 + 压缩历史。
 * 这是「不重复产生记忆内容」的关键——历史直接用柏宝书已经压好的那份。
 */
export function baiBaiMemoryBlock({ parts = {}, budget = 1600, historyBudget = 1200, includeHistory = true } = {}) {
    if (!baiBaiAvailable()) return '';
    const snapshot = baiBaiSnapshot();
    const head = snapshotBlock(snapshot, { parts, budget: Math.max(200, budget - historyBudget) });
    let tail = '';
    if (includeHistory) {
        const history = baiBaiInjectedHistory();
        const text = String(history?.relativeText || history?.text || '').trim();
        if (text) tail = '【柏宝书 · 之前发生过的】\n' + clip(text, historyBudget);
    }
    const merged = [head, tail].filter(Boolean).join('\n\n');
    if (!merged) return '';
    // 覆盖不全时提醒一句，别让模型把缺的那段当成没发生
    const coverage = snapshot?.coverage || historyCoverage();
    if (coverage && coverage.complete === false && Array.isArray(coverage.missingAiFloors) && coverage.missingAiFloors.length) {
        return merged + '\n（注：第 ' + coverage.missingAiFloors.slice(0, 6).join('、') + ' 层还没生成摘要，那几段可能记不全）';
    }
    return merged;
}

function historyCoverage() {
    try {
        return baiBaiInjectedHistory()?.coverage || null;
    } catch {
        return null;
    }
}

/** 给手机内部 AI 提示词用的一段纯文本历史。 */
export function baiBaiHistoryText(limit = 1200) {
    const history = baiBaiInjectedHistory();
    const text = String(history?.relativeText || history?.text || '').trim();
    return text ? clip(text, limit) : '';
}

/** 手机记忆 App 里展示用：柏宝书当前记了多少条。 */
export function baiBaiStats() {
    const snapshot = baiBaiSnapshot();
    if (!snapshot) return null;
    return {
        revision: Number(snapshot.revision) || 0,
        floors: Number(snapshot.chat?.length) || 0,
        npcs: Array.isArray(snapshot.npcs) ? snapshot.npcs.length : 0,
        items: Array.isArray(snapshot.items) ? snapshot.items.length : 0,
        plans: Array.isArray(snapshot.plans) ? snapshot.plans.length : 0,
        lifeDetails: Array.isArray(snapshot.lifeDetails) ? snapshot.lifeDetails.length : 0,
        historyNodes: (() => {
            const history = baiBaiInjectedHistory();
            return Array.isArray(history?.nodes) ? history.nodes.length : 0;
        })(),
        complete: snapshot.coverage?.complete !== false,
        missing: Array.isArray(snapshot.coverage?.missingAiFloors) ? snapshot.coverage.missingAiFloors : [],
    };
}

/** 清掉缓存（切聊天时用）。 */
export function resetBaiBaiCache() {
    cachedSnapshot = null;
    cachedRevision = -1;
    cachedAt = 0;
}

/**
 * 给 memoryContext 用的条目数组（{text, tag}）。
 * 拆成两条而不是一条：现状和历史在提示词里的作用不同，模型更容易分清楚。
 */
export function baiBaiContextItems(settings) {
    if (!baiBaiAvailable()) return [];
    const mode = String(settings?.baibai?.mode || 'detect');
    if (mode === 'off') return [];
    const out = [];
    const snapshot = baiBaiSnapshot();
    if (settings?.baibai?.injectSnapshot !== false) {
        const parts = {};
        const head = snapshotBlock(snapshot, { parts, budget: 700 });
        if (head) out.push({ text: head, tag: 'baibai-state' });
    }
    if (settings?.baibai?.injectHistory !== false) {
        const history = baiBaiInjectedHistory();
        const text = String(history?.relativeText || history?.text || '').trim();
        if (text) {
            out.push({ text: '【柏宝书 · 之前发生过的】\n' + text.slice(0, Number(settings?.baibai?.historyBudget) || 1200), tag: 'baibai-history' });
        }
    }
    return out;
}
