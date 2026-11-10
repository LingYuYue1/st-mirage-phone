import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mvuApi, mvuAvailable, readVariables, unwrap, flattenVars, flatVariables,
    pickVars, varsToText,
} from '../src/mvu.js';

/** 卡里的真实 MVU 结构：[值, 说明] 二元组 + $meta。 */
function cardVars() {
    return {
        时间状态: {
            $meta: { extensible: false },
            当前时间: ['2024年1月15日 14:30', '具体的日期和时间'],
        },
        地点信息: {
            当前地址: ['市中心高级公寓2801室', '详细的地点描述'],
        },
        目标角色: {
            基础信息: {
                姓名: ['秋穗', '当前调教对象的姓名'],
                性别: ['女', '角色性别'],
                性格特征: ['', '详细的性格描述'],
            },
            业务详情: {
                业务要求: ['让她学会主动', '目标'],
                敏感点位: [['$__META_EXTENSIBLE__$'], '列表'],
            },
            训练记录: {
                口交次数: [3, '累计'],
                业务进度: [42, '完成度'],
                额外性癖: [['$__META_EXTENSIBLE__$', '怕痒'], '列表'],
            },
        },
        委托方信息: {
            $meta: { extensible: true },
            张总: { 姓名: ['张总', 'n'], 与目标关系: ['上司', 'r'] },
        },
    };
}

function withMvu(api, fn) {
    const previous = globalThis.Mvu;
    globalThis.Mvu = api;
    try { return fn(); } finally {
        if (previous === undefined) delete globalThis.Mvu;
        else globalThis.Mvu = previous;
    }
}

test('没装 MVU 时安全降级', () => {
    assert.equal(mvuApi(), null);
    assert.equal(mvuAvailable(), false);
    assert.equal(readVariables(), null);
    assert.deepEqual(flatVariables(), { source: 'none', vars: {} });
});

test('unwrap 拆 [值, 说明] 二元组', () => {
    assert.equal(unwrap(['秋穗', '当前调教对象的姓名']), '秋穗');
    assert.equal(unwrap([3, '累计']), 3);
    assert.deepEqual(unwrap(['$__META_EXTENSIBLE__$', '列表']), []);
    // 不是二元组的原样返回
    assert.deepEqual(unwrap(['a', 'b', 'c']), ['a', 'b', 'c']);
    assert.equal(unwrap('plain'), 'plain');
    assert.equal(unwrap(42), 42);
    assert.equal(unwrap([]), undefined);
});

test('flattenVars 摊平整棵树，去掉 $meta 与空值', () => {
    const flat = flattenVars(cardVars());
    assert.equal(flat.时间状态.当前时间, '2024年1月15日 14:30');
    assert.equal(flat.地点信息.当前地址, '市中心高级公寓2801室');
    assert.equal(flat.目标角色.基础信息.姓名, '秋穗');
    assert.equal(flat.目标角色.基础信息.性别, '女');
    assert.equal(flat.目标角色.训练记录.口交次数, 3);
    assert.equal(flat.目标角色.训练记录.业务进度, 42);
    // $meta 不能出现
    assert.equal(flat.时间状态.$meta, undefined);
    assert.equal(flat.委托方信息.$meta, undefined);
    // 空字符串的字段被丢掉
    assert.equal(flat.目标角色.基础信息.性格特征, undefined);
    // 可扩展空列表变成空数组后被丢掉
    assert.equal(flat.目标角色.业务详情.敏感点位, undefined);
    // 有内容的可扩展列表保留
    assert.deepEqual(flat.目标角色.训练记录.额外性癖, ['怕痒']);
    // 可扩展模板（委托方）
    assert.equal(flat.委托方信息.张总.与目标关系, '上司');
});

test('pickVars 支持点号与下标', () => {
    const flat = flattenVars(cardVars());
    assert.equal(pickVars(flat, '目标角色.基础信息.姓名'), '秋穗');
    assert.equal(pickVars(flat, '目标角色.训练记录.口交次数'), 3);
    assert.deepEqual(pickVars(flat, '目标角色.训练记录.额外性癖'), ['怕痒']);
    assert.equal(pickVars(flat, '目标角色.训练记录.额外性癖[0]'), '怕痒');
    assert.equal(pickVars(flat, '不存在的.路径'), undefined);
});

test('readVariables 优先用 Mvu 官方入口', () => {
    const calls = [];
    withMvu({
        getMvuData: options => {
            calls.push(options.type);
            return { stat_data: options.type === 'chat' ? cardVars() : {} };
        },
    }, () => {
        const result = readVariables();
        assert.equal(result.source, 'Mvu:chat');
        assert.equal(result.data.目标角色.基础信息.姓名[0], '秋穗');
        assert.deepEqual(calls, ['chat']);
    });
});

test('Mvu 的 chat 为空时回退到最新消息楼层', () => {
    const calls = [];
    withMvu({
        getMvuData: options => {
            calls.push(options.type + ':' + (options.message_id || ''));
            return options.type === 'message' ? { stat_data: cardVars() } : { stat_data: {} };
        },
    }, () => {
        const result = readVariables();
        assert.equal(result.source, 'Mvu:message');
        assert.deepEqual(calls, ['chat:', 'message:latest']);
    });
});

test('Mvu 抛错时回退到 chatMetadata', () => {
    withMvu({ getMvuData: () => { throw new Error('boom'); } }, () => {
        const previous = globalThis.SillyTavern;
        globalThis.SillyTavern = { getContext: () => ({ chatMetadata: { variables: { stat_data: cardVars() } } }) };
        try {
            const result = readVariables();
            assert.equal(result.source, 'chatMetadata.variables');
            assert.equal(result.data.目标角色.基础信息.姓名[0], '秋穗');
        } finally {
            if (previous === undefined) delete globalThis.SillyTavern;
            else globalThis.SillyTavern = previous;
        }
    });
});

test('flatVariables 一步到摊平结果', () => {
    withMvu({ getMvuData: () => ({ stat_data: cardVars() }) }, () => {
        const { source, vars } = flatVariables();
        assert.equal(source, 'Mvu:chat');
        assert.equal(vars.目标角色.训练记录.业务进度, 42);
    });
});

test('varsToText 压成有行数与字数上限的文本', () => {
    const flat = flattenVars(cardVars());
    const text = varsToText(flat);
    assert.match(text, /时间状态·当前时间：2024年1月15日 14:30/);
    assert.match(text, /目标角色·基础信息·姓名：秋穗/);
    assert.doesNotMatch(text, /\$meta/);
    assert.doesNotMatch(text, /\$__META_EXTENSIBLE__\$/);

    const short = varsToText(flat, { maxLines: 2 });
    assert.equal(short.split('\n').length, 2);

    const clipped = varsToText(flat, { maxChars: 30 });
    assert.ok(clipped.length <= 31, '超长要截断加省略号');
});

test('数组里的对象也能进文本', () => {
    const flat = flattenVars({ 列表: [['a', 'x'], ['b', 'y']] });
    assert.deepEqual(flat.列表, ['a', 'b']);
    assert.match(varsToText(flat), /列表：a、b/);
});
