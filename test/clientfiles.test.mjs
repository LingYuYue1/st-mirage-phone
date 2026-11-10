import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 这些测试只测纯逻辑：用假 Mvu 注入变量，不碰酒馆。 */

const META = '$meta';

function withMvu(stat, fn) {
    const previous = globalThis.Mvu;
    globalThis.Mvu = { getMvuData: () => ({ stat_data: stat }) };
    try {
        return fn();
    } finally {
        if (previous === undefined) delete globalThis.Mvu;
        else globalThis.Mvu = previous;
    }
}

/** 洗白卡 [InitVar] 的真实结构。 */
function xibaiStat() {
    return {
        时间状态: { [META]: { extensible: false }, 当前时间: ['2024年1月15日 14:30', '时间'] },
        地点信息: { 当前地址: ['市中心高级公寓2801室', '地点'] },
        目标角色: {
            基础信息: { 姓名: ['林美雪', 'n'], 性别: ['女', 'g'], 性格特征: ['清纯甜美，内心渴望回归正常生活', 'p'] },
            业务详情: {
                业务要求: ['彻底洗去风尘气息', 'r'],
                当前穿着: ['白色衬衫与黑色A字裙', 'c'],
                敏感点位: [['后颈', '耳后', '腰侧'], 'l'],
            },
            训练记录: {
                口交次数: [3, 'c'], 性交次数: [7, 'c'], 肛交次数: [0, 'c'], 乳交次数: [2, 'c'],
                业务进度: [42, 'p'],
                额外性癖: [['怕痒', '喜欢被命令'], 'l'],
            },
        },
        委托方信息: {
            [META]: { extensible: true },
            张总: { 姓名: ['张总', 'n'], 性别: ['男', 'g'], 与目标关系: ['上司', 'r'], 特殊要求: ['不留书面记录', 'x'] },
        },
    };
}

test('readClients 认出主对象与委托方', async () => {
    const { readClients } = await import('../src/apps/clientfiles.js');
    withMvu(xibaiStat(), () => {
        const { clients } = readClients();
        const names = clients.map(c => c.name);
        assert.ok(names.includes('林美雪'), '主对象要认出来');
        assert.ok(names.includes('张总'), '委托方要认出来');
        // 分组名不能当成人
        assert.ok(!names.includes('业务详情'));
        assert.ok(!names.includes('训练记录'));
        assert.ok(!names.includes('基础信息'));
    });
});

test('主对象的次数跨分组收齐（关键回归）', async () => {
    const { readClients } = await import('../src/apps/clientfiles.js');
    withMvu(xibaiStat(), () => {
        const main = readClients().clients.find(c => c.name === '林美雪');
        assert.ok(main, '要有林美雪');
        const keys = main.counts.map(item => item.key);
        // 训练记录 和 基础信息 同级，不能被漏掉
        for (const key of ['口交次数', '性交次数', '肛交次数', '乳交次数']) {
            assert.ok(keys.includes(key), '缺了 ' + key);
        }
        assert.equal(main.counts.find(item => item.key === '口交次数').value, '3');
        assert.equal(main.counts.find(item => item.key === '性交次数').value, '7');
    });
});

test('进度与列表正确归类', async () => {
    const { readClients } = await import('../src/apps/clientfiles.js');
    withMvu(xibaiStat(), () => {
        const main = readClients().clients.find(c => c.name === '林美雪');
        assert.equal(main.progress.length, 1);
        assert.equal(main.progress[0].key, '业务进度');
        assert.equal(main.progress[0].percent, 42);
        const listKeys = main.lists.map(item => item.key);
        assert.ok(listKeys.includes('敏感点位'));
        assert.ok(listKeys.includes('额外性癖'));
        assert.ok(main.lists.find(item => item.key === '敏感点位').value.includes('后颈'));
        // 哨兵不能漏出来
        assert.ok(!JSON.stringify(main).includes('$__META_EXTENSIBLE__$'));
    });
});

test('委托方字段也能读出来', async () => {
    const { readClients } = await import('../src/apps/clientfiles.js');
    withMvu(xibaiStat(), () => {
        const client = readClients().clients.find(c => c.name === '张总');
        const keys = client.others.map(item => item.key);
        assert.ok(keys.includes('与目标关系'));
        assert.equal(client.others.find(item => item.key === '与目标关系').value, '上司');
    });
});

test('没有 MVU 时安全返回空', async () => {
    const { readClients } = await import('../src/apps/clientfiles.js');
    const previous = globalThis.Mvu;
    delete globalThis.Mvu;
    try {
        const result = readClients();
        assert.deepEqual(result.clients, []);
    } finally {
        if (previous !== undefined) globalThis.Mvu = previous;
    }
});

test('进度会被夹在 0-100', async () => {
    const { readClients } = await import('../src/apps/clientfiles.js');
    const stat = {
        目标角色: {
            基础信息: { 姓名: ['测试', 'n'] },
            训练记录: { 业务进度: [180, 'p'] },
        },
    };
    withMvu(stat, () => {
        const main = readClients().clients.find(c => c.name === '测试');
        assert.equal(main.progress[0].percent, 100);
    });
});

/* ------------------------------ 论坛 ------------------------------ */

test('论坛版块定义完整', async () => {
    const { BOARDS } = await import('../src/apps/forum.js');
    assert.ok(BOARDS.length >= 4);
    for (const board of BOARDS) {
        assert.ok(board.id && board.name && board.prompt);
    }
});

/* ------------------------------ 终端 ------------------------------ */

test('终端分类定义完整', async () => {
    const { CATEGORIES } = await import('../src/apps/terminal.js');
    assert.ok(CATEGORIES.length >= 5);
    for (const cat of CATEGORIES) {
        assert.ok(cat.id && cat.name);
    }
    // 洗白卡的业务都要有地方落
    const ids = CATEGORIES.map(cat => cat.id);
    for (const id of ['wash', 'fall', 'train', 'vip']) {
        assert.ok(ids.includes(id), '缺分类 ' + id);
    }
});
