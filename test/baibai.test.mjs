import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    baiBaiApi, baiBaiAvailable, baiBaiInfo, baiBaiSnapshot, baiBaiInjectedHistory,
    snapshotBlock, baiBaiMemoryBlock, baiBaiStats, baiBaiContextItems, resetBaiBaiCache,
    onBaiBaiReady,
} from '../src/baibai.js';

/** 造一个符合 PUBLIC_API.md v1 的假柏宝书。 */
function fakeApi(overrides = {}) {
    const snapshot = {
        apiVersion: 1,
        pluginVersion: '1.3.5',
        revision: 7,
        chat: { id: 'c1', characterName: '夏之', groupId: null, length: 86 },
        point: { floor: 85, at: 'after', upToExclusive: 86 },
        coverage: { complete: true, missingAiFloors: [] },
        state: { time: '11月11日 深夜', location: '旧城', locationPath: ['旧城', '修表铺'] },
        protagonist: { gender: '女', identity: '调查员', appearance: '黑色短发，左眉有疤', outfit: '深色风衣', condition: '左臂轻伤' },
        vars: {},
        items: [{ name: '铜钥匙' }, { name: '车票', qty: 2 }],
        plans: [{ text: '去码头找老周' }],
        scenes: [],
        npcs: [
            { name: '夏之', affinityInner: 1, affinityOuter: 1, affinityNote: '说话还是短' },
            { name: '阿澈', affinityInner: null, affinityOuter: -1 },
        ],
        itemLog: [],
        lifeDetails: [
            { subject: 'user', text: '煎饼果子不加脆饼' },
            { subject: '夏之', text: '喝茶不加糖' },
        ],
        ...(overrides.snapshot || {}),
    };
    const history = {
        apiVersion: 1,
        pluginVersion: '1.3.5',
        revision: 7,
        chat: snapshot.chat,
        mode: 'injection',
        coverage: { complete: true, missingAiFloors: [] },
        text: '绝对时间历史',
        relativeText: '三天前，你在修表铺遇见夏之。',
        nodes: [{}, {}, {}],
        ...(overrides.history || {}),
    };
    return {
        apiVersion: 1,
        pluginVersion: '1.3.5',
        capabilities: { globalApi: true, slashCommand: true, macros: true, parameterizedMacros: true, events: true },
        getSnapshot: () => snapshot,
        getInjectedHistory: () => history,
        getHistory: () => history,
        getVar: () => undefined,
        getFloor: () => null,
        getContextAtFloor: () => null,
        query: () => null,
        subscribe: () => () => {},
        ...overrides.api,
    };
}

function withApi(api, fn) {
    const previous = globalThis.STBaiBaiBook;
    globalThis.STBaiBaiBook = api;
    resetBaiBaiCache();
    try {
        return fn();
    } finally {
        if (previous === undefined) delete globalThis.STBaiBaiBook;
        else globalThis.STBaiBaiBook = previous;
        resetBaiBaiCache();
    }
}

test('没装柏宝书时全部安全降级', () => {
    assert.equal(baiBaiApi(), null);
    assert.equal(baiBaiAvailable(), false);
    assert.deepEqual(baiBaiInfo(), { available: false });
    assert.equal(baiBaiSnapshot(), null);
    assert.equal(baiBaiInjectedHistory(), null);
    assert.equal(snapshotBlock(null), '');
    assert.equal(baiBaiMemoryBlock(), '');
    assert.equal(baiBaiStats(), null);
    assert.deepEqual(baiBaiContextItems({}), []);
});

test('apiVersion 不是 1 就当作不可用', () => {
    withApi(fakeApi({ api: { apiVersion: 2 } }), () => {
        assert.equal(baiBaiAvailable(), false);
        assert.equal(baiBaiSnapshot(), null);
    });
});

test('snapshotBlock 把结构化状态翻成人话', () => {
    withApi(fakeApi(), () => {
        const block = snapshotBlock(baiBaiSnapshot());
        assert.match(block, /【柏宝书记忆 · 现状】/);
        assert.match(block, /现在：11月11日 深夜｜旧城 · 修表铺/);
        assert.match(block, /主角：女，调查员，深色风衣，左臂轻伤/);
        assert.match(block, /在办的事：去码头找老周/);
        assert.match(block, /随身物品：铜钥匙、车票×2/);
        assert.match(block, /生活细节：主角：煎饼果子不加脆饼；夏之：喝茶不加糖/);
    });
});

test('好感为 null 表示未知，不能写成「无明显好恶」', () => {
    withApi(fakeApi(), () => {
        const block = snapshotBlock(baiBaiSnapshot());
        // 夏之两侧都有值
        assert.match(block, /夏之（内心有好感，外在友善亲近，说话还是短）/);
        // 阿澈 inner=null outer=-1：只报外在，不能出现「内心无明显好恶」
        assert.match(block, /阿澈（外在冷淡疏远）/);
        assert.doesNotMatch(block, /阿澈（内心/);
    });
});

test('可以按需关掉某些段', () => {
    withApi(fakeApi(), () => {
        const block = snapshotBlock(baiBaiSnapshot(), { parts: { protagonist: false, items: false, lifeDetails: false } });
        assert.doesNotMatch(block, /主角：/);
        assert.doesNotMatch(block, /随身物品：/);
        assert.doesNotMatch(block, /生活细节：/);
        assert.match(block, /现在：/);
        assert.match(block, /在办的事：/);
    });
});

test('memoryBlock 合并现状与压缩历史', () => {
    withApi(fakeApi(), () => {
        const block = baiBaiMemoryBlock();
        assert.match(block, /【柏宝书记忆 · 现状】/);
        assert.match(block, /【柏宝书 · 之前发生过的】/);
        assert.match(block, /三天前，你在修表铺遇见夏之。/);
        assert.doesNotMatch(block, /还没生成摘要/);
    });
});

test('coverage 不全时明确提醒，不假装完整', () => {
    withApi(fakeApi({ snapshot: { coverage: { complete: false, missingAiFloors: [38, 41] } } }), () => {
        const block = baiBaiMemoryBlock();
        assert.match(block, /第 38、41 层还没生成摘要/);
    });
});

test('includeHistory=false 时只给现状', () => {
    withApi(fakeApi(), () => {
        const block = baiBaiMemoryBlock({ includeHistory: false });
        assert.match(block, /【柏宝书记忆 · 现状】/);
        assert.doesNotMatch(block, /之前发生过的/);
    });
});

test('baiBaiStats 汇总条目数', () => {
    withApi(fakeApi(), () => {
        const stats = baiBaiStats();
        assert.equal(stats.revision, 7);
        assert.equal(stats.floors, 86);
        assert.equal(stats.npcs, 2);
        assert.equal(stats.items, 2);
        assert.equal(stats.plans, 1);
        assert.equal(stats.lifeDetails, 2);
        assert.equal(stats.historyNodes, 3);
        assert.equal(stats.complete, true);
    });
});

test('baiBaiContextItems 受 mode 与开关控制', () => {
    withApi(fakeApi(), () => {
        const both = baiBaiContextItems({ baibai: { mode: 'detect', injectHistory: true, injectSnapshot: true } });
        assert.equal(both.length, 2);
        assert.equal(both[0].tag, 'baibai-state');
        assert.equal(both[1].tag, 'baibai-history');

        assert.deepEqual(baiBaiContextItems({ baibai: { mode: 'off' } }), []);
        assert.equal(baiBaiContextItems({ baibai: { mode: 'detect', injectHistory: false } }).length, 1);
        assert.equal(baiBaiContextItems({ baibai: { mode: 'detect', injectSnapshot: false } }).length, 1);
    });
});

test('柏宝书抛错时不影响调用方（部分降级）', () => {
    withApi(fakeApi({ api: { getSnapshot: () => { throw new Error('boom'); } } }), () => {
        // 快照挂了 → 现状段拿不到
        assert.equal(baiBaiSnapshot(), null);
        assert.equal(baiBaiStats(), null);
        assert.equal(snapshotBlock(null), '');
        // 但历史还能读 → 不能整块丢掉，也不能抛错
        const block = baiBaiMemoryBlock();
        assert.match(block, /之前发生过的/);
        assert.doesNotMatch(block, /【柏宝书记忆 · 现状】/);
    });
});

test('柏宝书整个不可用时也不抛错', () => {
    withApi(fakeApi({
        api: {
            getSnapshot: () => { throw new Error('boom'); },
            getInjectedHistory: () => { throw new Error('boom'); },
        },
    }), () => {
        assert.equal(baiBaiMemoryBlock(), '');
        assert.deepEqual(baiBaiContextItems({ baibai: { mode: 'detect' } }), []);
    });
});

test('onBaiBaiReady 在已就绪时立刻回调', () => {
    withApi(fakeApi(), () => {
        let called = 0;
        const off = onBaiBaiReady(() => { called += 1; });
        assert.equal(called, 1);
        off();
    });
});

test('空快照不产生垃圾块', () => {
    withApi(fakeApi({
        snapshot: { state: {}, protagonist: {}, vars: {}, items: [], plans: [], npcs: [], lifeDetails: [] },
        history: { relativeText: '', text: '', nodes: [] },
    }), () => {
        assert.equal(snapshotBlock(baiBaiSnapshot()), '');
        assert.equal(baiBaiMemoryBlock(), '');
    });
});
