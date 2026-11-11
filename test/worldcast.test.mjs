import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    looksLikeName, parseTaggedPeople, parseTablePeople, parseJsonPeople,
    parseRelationTable, parseBasicInfoList, scanEntriesForPeople,
} from '../src/worldcast.js';

/* ============ 全部样本取自真实的「恶堕、洗白、调教大师」世界书 ============ */

test('looksLikeName 认人名，挡掉功能标题', () => {
    for (const name of ['林小雨', '林婉儿', '秋穗', '雨桐', '雨梧', 'Alicia']) {
        assert.equal(looksLikeName(name), true, name + ' 应该算人名');
    }
    for (const notName of ['输出规则', '收费标准', '性爱流程', '快感存储技能', '业务类型详解',
        '角色基础信息', '{{user}}', '', '这是一段很长的说明文字超过限制', '姓名', '关系表']) {
        assert.equal(looksLikeName(notName), false, notName + ' 不该算人名');
    }
});

test('形态 A：<林小雨> YAML 式人物卡', () => {
    const text = `<林小雨>
角色基础信息:
  姓名:
    中文名: 林小雨
    昵称: [小雨, 雨雨]
  性别: 女
  年龄: "21"
  职业: {{user}}的初级助理
  社会地位: 刚毕业的职场萌新
相貌特征:
  整体印象: 娃娃脸女孩，五官清秀，带着稚气。
</林小雨>`;
    const people = parseTaggedPeople(text);
    assert.equal(people.length, 1);
    const person = people[0];
    assert.equal(person.name, '林小雨');
    assert.equal(person.gender, '女');
    assert.equal(person.age, '21');
    assert.match(person.role, /初级助理/);
    assert.match(person.desc, /娃娃脸/);
    assert.deepEqual(person.nickname, ['小雨', '雨雨']);
});

test('形态 A：<character_林婉儿> 前缀要去掉', () => {
    const text = `<character_林婉儿>
角色基础信息:
  姓名:
    中文名: 林婉儿
    英文名: Alicia Lin
  性别: 女
  职业: 凌工作室首席法律顾问
  整体印象: 冰冷禁欲的律政精英。
</character_林婉儿>`;
    const people = parseTaggedPeople(text);
    assert.equal(people.length, 1);
    assert.equal(people[0].name, '林婉儿');
    assert.match(people[0].role, /法律顾问/);
});

test('形态 B：<林婉儿> 一行简写', () => {
    const text = `<林婉儿>
林婉儿/女/B88/W60/H90/洗白业务
</林婉儿>`;
    const people = parseTaggedPeople(text);
    assert.equal(people.length, 1);
    assert.equal(people[0].name, '林婉儿');
    assert.equal(people[0].gender, '女');
    assert.equal(people[0].measurements, 'B88/W60/H90');
    assert.equal(people[0].role, '洗白业务');
});

test('🔴 回归：<收费标准> 这种功能标签不能当成人', () => {
    const text = `负责业务:
  <收费标准>
  洗白业务: 3-5万
  调教业务: 2-4万
  </收费标准>`;
    assert.equal(parseTaggedPeople(text).length, 0, '功能标签要挡掉');
});

test('🔴 回归：<basic_info> 这类结构标签不能当成人', () => {
    const text = `<basic_info>
角色列表:
  - 林婉儿 (网名: Alicia Lin)
</basic_info>`;
    // basic_info 本身被排除，但里面的角色列表要能读出来
    assert.equal(parseTaggedPeople(text).length, 0);
    const list = parseBasicInfoList(text);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, '林婉儿');
    assert.deepEqual(list[0].nickname, ['Alicia Lin']);
});

test('形态 C：重要人物表（表格，与真实卡同结构）', () => {
    // 真实卡里表头和数据行都是 13 列，这里照抄
    const text = `# 重要人物表

| 姓名 | 性别 | 年龄 | 一句话介绍 | 外貌特征 | 身份 | 基础属性 | 特有属性 | 所在地点 | 在场状态 | 人际关系 | 交互选项 | 过往经历 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 雨桐 | 女 | 28 | 精致成熟，娇小玲珑。 | 深栗色短发 | 高级生活助理,营养师 | 智力:82 | 营养支持:92 | 凌的私人工作室 | 别墅厨房 | 主角:老婆; 秋穗:姐妹 |  | 凌的高级生活助理。 |`;
    const people = parseTablePeople(text);
    assert.equal(people.length, 1);
    const person = people[0];
    assert.equal(person.name, '雨桐');
    assert.equal(person.gender, '女');
    assert.equal(person.age, '28');
    assert.match(person.role, /生活助理/);
    assert.match(person.relation, /老婆/);
    assert.match(person.desc, /精致成熟/);
});

test('🔴 回归：剧情大纲表不能当人物表', () => {
    const text = `| 编码索引 | 时间跨度 | 大纲 |
|---|---|---|
| AM0001 | 2026-02-11 | 凌通过多轮引导帮林婉儿完成回档。 |
| AM0002 | 2026-02-12 | 凌确立雨桐女友地位。 |`;
    assert.equal(parseTablePeople(text).length, 0, '没有姓名列的表要跳过');
});

test('🔴 回归：列数比表头多的行要跳过（串表了）', () => {
    const text = `| 姓名 | 性别 | 身份 |
|---|---|---|
| 雨桐 | 女 | 助理 |
| 秋穗 | 女 |
| 雨梧 | 女 | 助理 | 多出来一列 |`;
    const people = parseTablePeople(text);
    const names = people.map(person => person.name);
    // 雨桐完整；秋穗少了末尾空列（真实表里很常见）也算人；雨梧多一列说明串表，跳过
    assert.ok(names.includes('雨桐'));
    assert.ok(names.includes('秋穗'), '缺末尾空单元格是正常的');
    assert.ok(!names.includes('雨梧'), '多出列说明不是这张表');
});

test('形态 D：客户档案 JSON', () => {
    const text = JSON.stringify({
        archives: [{
            photo_filename: 'wfo8bo.png',
            student_name: '林婉儿',
            gender: '女',
            age: '29',
            measurements: 'B88/W60/H90',
            business_type: '洗白业务',
            background_info: '律师事务所合伙人。',
            current_condition: '目前单身，与男友关系稳定。',
            target_goals: '彻底洗去风尘气质。',
        }],
    });
    const people = parseJsonPeople(text);
    assert.equal(people.length, 1);
    const person = people[0];
    assert.equal(person.name, '林婉儿');
    assert.equal(person.gender, '女');
    assert.equal(person.age, '29');
    assert.equal(person.role, '洗白业务');
    assert.match(person.desc, /律师事务所合伙人/);
});

test('形态 D：不是 JSON 就安静返回空', () => {
    assert.deepEqual(parseJsonPeople('这不是 JSON'), []);
    assert.deepEqual(parseJsonPeople(''), []);
});

test('形态 E：关系表', () => {
    const text = `工作室关系表:
  女员工团队:
    秋穗:
      性别: 女
      年龄: 29
      职位: 首席助理 / 私人声音疗愈师
      层级: 高级
    雨桐:
      性别: 女
      年龄: 28
      职位: 高级生活助理 / 专业营养师
      层级: 高级`;
    const people = parseRelationTable(text);
    assert.equal(people.length, 2);
    const names = people.map(person => person.name);
    assert.deepEqual(names.sort(), ['秋穗', '雨桐'].sort());
    const qiusui = people.find(person => person.name === '秋穗');
    assert.equal(qiusui.gender, '女');
    assert.equal(qiusui.age, '29');
    assert.match(qiusui.role, /首席助理/);
});

test('形态 E：只有分组标题、没有实际信息的不算人', () => {
    const text = `工作层级:
  老板: "{{user}}"
  首席助理: 秋穗
  初级助理:
    - 林小雨`;
    assert.deepEqual(parseRelationTable(text), []);
});

test('形态 F：basic_info 角色列表', () => {
    const text = `<basic_info>
角色列表:
  - 林婉儿 (网名: Alicia Lin)
  - 雨桐 (网名: 昵称)

用户信息:
  - 凌
</basic_info>`;
    const people = parseBasicInfoList(text);
    assert.equal(people.length, 2);
    assert.deepEqual(people.map(person => person.name), ['林婉儿', '雨桐']);
});

test('scanEntriesForPeople 把五种形态汇总并按名字去重', () => {
    const entries = [
        { title: '林小雨', content: '<林小雨>\n角色基础信息:\n  中文名: 林小雨\n  性别: 女\n  职业: 初级助理\n  整体印象: 娃娃脸女孩。\n</林小雨>' },
        { title: '客户档案-林婉儿', content: JSON.stringify({ archives: [{ student_name: '林婉儿', gender: '女', business_type: '洗白业务', background_info: '律师。' }] }) },
        { title: '重要人物表-1', content: '| 姓名 | 性别 | 身份 |\n|---|---|---|\n| 雨桐 | 女 | 生活助理 |' },
        { title: '关系表', content: '工作室关系表:\n  女员工团队:\n    秋穗:\n      性别: 女\n      年龄: 29\n      职位: 首席助理' },
        { title: '[basic_info]角色与群聊信息', content: '<basic_info>\n角色列表:\n  - 雨梧 (网名: 小雨)\n</basic_info>' },
        { title: '负责业务', content: '<收费标准>\n洗白业务: 3-5万\n</收费标准>' },
        { title: '总结条目1', content: '凌通过多轮引导帮林婉儿完成回档。' },
    ];
    const people = scanEntriesForPeople(entries);
    const names = people.map(person => person.name).sort();
    assert.deepEqual(names, ['林婉儿', '林小雨', '秋穗', '雨桐', '雨梧'].sort());
    // 功能标签和总结条目都不能混进来
    assert.ok(!names.includes('收费标准'));
    assert.ok(!names.includes('凌'));
});

test('scanEntriesForPeople 同名合并时留信息最全的那份', () => {
    const entries = [
        { title: 'a', content: '<林婉儿>\n林婉儿/女/B88/W60/H90/洗白业务\n</林婉儿>' },
        { title: '客户档案-林婉儿', content: JSON.stringify({ archives: [{ student_name: '林婉儿', gender: '女', age: '29', business_type: '洗白业务', background_info: '律所合伙人，过往经历复杂。', current_condition: '目前单身。' }] }) },
    ];
    const people = scanEntriesForPeople(entries);
    assert.equal(people.length, 1);
    const person = people[0];
    assert.equal(person.name, '林婉儿');
    assert.equal(person.age, '29', '应保留信息更全那份的年龄');
    assert.match(person.desc, /律所合伙人/);
});

test('空输入不炸', () => {
    assert.deepEqual(scanEntriesForPeople([]), []);
    assert.deepEqual(scanEntriesForPeople(null), []);
    assert.deepEqual(scanEntriesForPeople([{ title: '', content: '' }]), []);
});
