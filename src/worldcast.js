/**
 * 世界书人物扫描（二创）
 * ------------------------------------------------------------------
 * 为什么需要这一层：
 *   手机通讯录的人来自 `extractCast()`，而它原来只把「聊天记录 + 角色卡简介」
 *   喂给模型。客户、助理、名册这些人**全都写在世界书里**，一条都没读到，
 *   所以通讯录里搜不到客户。
 *
 * 世界书里人物有六种形态（都是真实卡里见到的）：
 *   A. `<林小雨>` 包裹的 YAML 式人物卡（角色基础信息 / 相貌特征 / 职业…）
 *   B. `<林婉儿>` 包裹的一行简写：`林婉儿/女/B88/W60/H90/洗白业务`
 *   C. Markdown 表格行（重要人物表-1 …），表头有 姓名/性别/身份/人际关系/过往经历
 *   D. JSON 档案（客户档案-林婉儿）：`{"archives":[{"student_name":...}]}`
 *   E. YAML 关系表（关系表 / 工作室关系表）：`女员工团队: 秋穗: 职位: …`
 *   F. `<basic_info>` 里的角色列表：`- 林婉儿 (网名: Alicia Lin)`
 *
 * 这一层**纯规则解析，不花 token**，所以再长的世界书也能扫。
 * AI 只在「补充聊天里出现但世界书没写的人」时才用。
 */
import { worldBookFull } from './st.js';
import { readClients } from './apps/clientfiles.js';

/** 这些不是人名，是条目标题里的结构词。 */
const NOT_NAME = /^(姓名|性别|年龄|职业|身份|昵称|中文名|英文名|代号|角色|人物|用户|主角|关系|列表|信息|基础信息|身体数据|相貌特征|身材特征|性格|经历|备注|说明|表头|表头行|核心人物|女员工团队|工作层级|血缘关系|人员背景|角色列表|用户信息|角色名)$/;

/**
 * 世界书条目里大量「2-6 个字的功能标题」长得很像人名（输出规则、收费标准、
 * 性爱流程、快感存储技能…）。靠一张后缀黑名单挡掉，比逐条硬编码可靠。
 */
const NOT_NAME_SUFFIX = /(规则|流程|技能|列表|详解|收费|机制|指导|保证|数据|人设|处理|笔记|说明|提醒|格式|设定|清单|索引|表|名|价|度|信息|要求|原则|技巧|方法|结构|模板|示例|警告|注意|建议|约束|限制|禁止|判断|逻辑|概念|分类|统计|进度|关系|内容|版本|更新|变量|条目|世界|背景|开场|结局|阶段|选项|按钮|界面|菜单|功能|系统|模块|参数|配置|设置|标准|范围|方式|类型|项目|服务|业务|方案|策略|思路|要点|重点|核心|基础|进阶|高阶|入门|总结|摘要|记录|档案|目录|大纲|索引)$/;

/** 判断一个字符串像不像人名。 */
export function looksLikeName(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 16) return false;
    if (NOT_NAME.test(text)) return false;
    if (NOT_NAME_SUFFIX.test(text) && text.length >= 3) return false;
    if (/\{\{|\}\}|\$|[:：,，。、|<>\/\\]/.test(text)) return false;
    // 中文名 2-6 字，或英文名
    if (/^[\u4e00-\u9fa5·]{2,6}$/.test(text)) return true;
    if (/^[A-Za-z][A-Za-z .'-]{1,20}$/.test(text)) return true;
    return false;
}

function clean(text, max = 300) {
    return String(text || '').replace(/\{\{user\}\}/g, '你').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 从一段 YAML 式文本里取某个键的值（支持 `键: 值` 与 `键:\n  子键: 值`）。 */
function yamlValue(text, key) {
    const match = String(text || '').match(new RegExp('(?:^|\\n)\\s*' + key + '\\s*:\\s*(.+?)\\s*(?:\\n|$)'));
    if (!match) return '';
    return match[1].replace(/^["']|["']$/g, '').trim();
}

/* ------------------------- A / B：<名字> 包裹的块 ------------------------- */

/**
 * 扫出所有 `<标签>…</标签>` 块。
 * 标签就是人名（可能是 `<林小雨>` 或 `<character_林婉儿>`）。
 *
 * 注意：世界书里还有很多**功能标签**也长这样（`<收费标准>`、`<业务类型>`、
 * `<basic_info>`…）。所以不能只看标签名像人名，还要看**内容里有没有人的特征**
 * （性别 / 年龄 / 职业 / 姓名 / 三围 / 相貌），否则「负责业务」里的
 * `<收费标准>` 会被当成一个人。
 */
export function parseTaggedPeople(text) {
    const out = [];
    const source = String(text || '');
    const blockPattern = /<([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]{0,20})>([\s\S]*?)<\/\1>/g;
    let match;
    while ((match = blockPattern.exec(source)) !== null) {
        const rawTag = match[1];
        const body = match[2];
        // 排除结构标签
        if (/^(basic_info|UpdateVariable|status_current_variables|student_profile|Student_Profile|插图|Important_Rule|收费标准|业务类型|业务范围|价格|流程|规则|说明|注意事项)$/i.test(rawTag)) continue;
        // 先剥掉 character_ / char_ 前缀，再判断是不是程序标签
        const tag = rawTag.replace(/^character_/, '').replace(/^char_/, '');
        // 剩下的还有下划线/冒号/数字，或者是大写驼峰（TavernDB / auto_message），就是程序标签
        if (/[_:\d]/.test(tag) || /^[A-Z]/.test(tag)) continue;
        if (!looksLikeName(tag)) continue;

        // 形态 B：一行简写 `名字/女/B88/W60/H90/洗白业务`
        const compact = body.trim().split('\n').map(line => line.trim()).find(line => line.includes('/') && line.split('/').length >= 3);
        const hasPersonTraits = /性别|年龄|职业|职位|姓名|三围|相貌|身高|体重|整体印象|社会地位|昵称/.test(body);
        const compactIsPerson = !!compact && /[男女]/.test(compact.split('/')[1] || '');

        // 既不是人物卡，也不是「名字/性别/…」简写 → 不是人
        if (!hasPersonTraits && !compactIsPerson) continue;

        const person = { name: tag, source: 'tag' };

        if (compact && !body.includes('角色基础信息') && compactIsPerson) {
            // 一行简写：`名字/性别/三围/业务`
            // 三围自己就带斜杠（B88/W60/H90），所以不能简单按 / 切——
            // 策略：第一个是名字，第二个是性别，最后一个是业务，中间全归三围。
            const parts = compact.split('/').map(item => item.trim()).filter(Boolean);
            if (parts[0] && looksLikeName(parts[0])) person.name = parts[0];
            person.gender = parts[1] || '';
            person.role = parts.length > 3 ? parts[parts.length - 1] : '';
            person.measurements = parts.length > 3 ? parts.slice(2, parts.length - 1).join('/') : (parts[2] || '');
            person.desc = compact;
            out.push(person);
            continue;
        }

        // 形态 A：YAML 式
        const cnName = (body.match(/中文名\s*:\s*(.+)/) || [])[1];
        if (cnName && looksLikeName(cnName.replace(/["']/g, '').trim())) {
            person.name = cnName.replace(/["']/g, '').trim();
        }
        person.gender = yamlValue(body, '性别');
        person.age = yamlValue(body, '年龄');
        person.role = yamlValue(body, '职业') || yamlValue(body, '职位');
        person.status = yamlValue(body, '社会地位');
        const nickname = (body.match(/昵称\s*:\s*\[(.+?)\]/) || [])[1];
        if (nickname) person.nickname = nickname.split(',').map(item => item.trim()).filter(Boolean).slice(0, 3);

        // 描述：优先「整体印象」，其次人物卡里较靠前的一段
        const impression = yamlValue(body, '整体印象');
        const background = yamlValue(body, '过往经历') || yamlValue(body, '背景');
        const parts = [];
        if (impression) parts.push(impression);
        if (person.role) parts.push('身份：' + clean(person.role, 60));
        if (background) parts.push(clean(background, 120));
        person.desc = clean(parts.join('。'), 400) || clean(body, 200);

        // 说话方式：卡里常常没有，有就取
        person.style = yamlValue(body, '说话方式') || yamlValue(body, '口吻') || yamlValue(body, '语气');
        out.push(person);
    }
    return out;
}

/* ---------------------------- C：Markdown 表格 ---------------------------- */

/**
 * 解析人物表格：表头 + 数据行。
 * 只认表头里同时有「姓名」和（身份/介绍/关系 之类）的表格，
 * 免得把「插图列表」「剧情大纲」这种表也当成人。
 */
export function parseTablePeople(text) {
    const out = [];
    const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
    let header = null;
    for (const line of lines) {
        if (!line.startsWith('|')) { header = null; continue; }
        const cells = line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
        // 分隔行 |---|---|
        if (cells.every(cell => /^:?-{2,}:?$/.test(cell))) continue;
        if (cells.includes('姓名')) {
            // 人物表必须还有别的身份/描述列，否则可能是别的东西
            const hasPersonColumn = cells.some(cell => /身份|介绍|外貌|关系|经历|职业|年龄/.test(cell));
            header = hasPersonColumn ? cells : null;
            continue;
        }
        if (!header) continue;
        const row = cells;
        // 列数不能比表头多（多出来说明是别的表串进来了）；
        // 少几列是正常的——真实表里末尾空单元格经常被省略。
        if (row.length > header.length) continue;
        const nameIndex = header.indexOf('姓名');
        if (nameIndex < 0 || nameIndex >= row.length) continue;
        const name = row[nameIndex];
        if (!looksLikeName(name)) continue;

        const pick = key => {
            const index = header.indexOf(key);
            return index >= 0 ? String(row[index] || '').trim() : '';
        };
        const intro = pick('一句话介绍');
        const looks = pick('外貌特征');
        const identity = pick('身份');
        const relation = pick('人际关系');
        const history = pick('过往经历');
        const descParts = [];
        if (intro) descParts.push(intro);
        if (looks) descParts.push('外貌：' + clean(looks, 80));
        if (history) descParts.push(clean(history, 160));
        out.push({
            name,
            gender: pick('性别'),
            age: pick('年龄'),
            role: identity,
            relation: relation,
            desc: clean(descParts.join('。'), 400),
            source: 'table',
        });
    }
    return out;
}

/* ------------------------------ D：JSON 档案 ------------------------------ */

/**
 * 客户档案 JSON：`{"archives":[{"student_name":"林婉儿","business_type":"洗白业务",...}]}`
 * 字段名可能变（student_name / name / 姓名），所以按一组候选键取。
 */
export function parseJsonPeople(text) {
    const out = [];
    const source = String(text || '').trim();
    if (!source.startsWith('{') && !source.startsWith('[')) return out;
    let json = null;
    try { json = JSON.parse(source); } catch { return out; }

    const nameKeys = ['student_name', 'name', '姓名', '名字', '中文名'];
    const walk = node => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const nameKey = nameKeys.find(key => typeof node[key] === 'string' && looksLikeName(node[key]));
        if (nameKey) {
            const name = node[nameKey].trim();
            const descParts = [];
            for (const key of ['background_info', '背景', 'current_condition', '当前状态', 'target_goals', '目标']) {
                if (typeof node[key] === 'string' && node[key].trim()) descParts.push(clean(node[key], 140));
            }
            out.push({
                name,
                gender: String(node.gender || node['性别'] || '').trim(),
                age: String(node.age || node['年龄'] || '').trim(),
                role: String(node.business_type || node['业务类型'] || '').trim(),
                measurements: String(node.measurements || '').trim(),
                desc: clean(descParts.join('。'), 400),
                source: 'json',
            });
            return;
        }
        for (const value of Object.values(node)) walk(value);
    };
    walk(json);
    return out;
}

/* --------------------------- E：YAML 关系表 --------------------------- */

/**
 * 关系表：`女员工团队:\n  秋穗:\n    性别: 女\n    职位: …`
 * 只认「值是一个对象、对象里有性别/职位/年龄」的键。
 */
export function parseRelationTable(text) {
    const out = [];
    const lines = String(text || '').split('\n');
    let pending = null;      // 待确认的人名
    let buffer = [];
    const flush = () => {
        if (!pending) return;
        const body = buffer.join('\n');
        const gender = (body.match(/性别\s*:\s*(\S+)/) || [])[1] || '';
        const age = (body.match(/年龄\s*:\s*(\S+)/) || [])[1] || '';
        const role = (body.match(/职位\s*:\s*(.+)/) || [])[1] || '';
        const level = (body.match(/层级\s*:\s*(.+)/) || [])[1] || '';
        // 至少要有一样实际信息，否则只是分组标题
        if (gender || age || role) {
            out.push({
                name: pending,
                gender,
                age,
                role: clean(role, 60),
                desc: clean([role && '身份：' + role, level && '层级：' + level].filter(Boolean).join('；'), 200),
                source: 'relation',
            });
        }
        pending = null;
        buffer = [];
    };
    for (const line of lines) {
        const personMatch = line.match(/^(\s{2,6})([\u4e00-\u9fa5A-Za-z·]{2,10})\s*:\s*$/);
        if (personMatch && looksLikeName(personMatch[2])) {
            flush();
            pending = personMatch[2];
            continue;
        }
        if (pending) buffer.push(line);
    }
    flush();
    return out;
}

/* ------------------------- F：basic_info 角色列表 ------------------------- */

/**
 * `<basic_info>` 里的：
 *   角色列表:
 *     - 林婉儿 (网名: Alicia Lin)
 */
export function parseBasicInfoList(text) {
    const out = [];
    const source = String(text || '');
    const block = (source.match(/<basic_info>([\s\S]*?)<\/basic_info>/) || [])[1] || source;
    if (!/角色列表|人物列表|名册/.test(block)) return out;
    const lines = block.split('\n');
    let inList = false;
    for (const line of lines) {
        if (/角色列表|人物列表|名册/.test(line)) { inList = true; continue; }
        if (!inList) continue;
        const item = line.match(/^\s*-\s*([\u4e00-\u9fa5A-Za-z·]{2,10})\s*(?:\(网名\s*[:：]\s*(.+?)\))?\s*$/);
        if (!item) {
            if (/^\s*[^\s-]/.test(line) && !line.includes(':')) inList = false;
            continue;
        }
        const name = item[1];
        if (!looksLikeName(name)) continue;
        out.push({
            name,
            nickname: item[2] ? [item[2].trim()] : [],
            desc: item[2] ? '网名：' + item[2].trim() : '',
            source: 'basic_info',
        });
    }
    return out;
}

/* ------------------------------ 汇总 ------------------------------ */

/** 人名归一化：去括号注释、去空白。 */
function normalizeName(name) {
    return String(name || '')
        .replace(/[（(].*?[）)]/g, '')
        .replace(/\s+/g, '')
        .trim();
}

/**
 * 描述质量打分：用来在同名合并时挑更好的那份。
 * 不能只看长度——`林婉儿/女/B88/W60/H90/洗白业务` 比
 * `律师事务所合伙人，过往经历复杂。` 还长，但它不是人话描述。
 */
function descScore(desc) {
    const text = String(desc || '').trim();
    if (!text) return 0;
    let score = Math.min(60, text.length / 4);
    // 紧凑格式（大量斜杠、几乎没有中文标点）降权
    const slashes = (text.match(/\//g) || []).length;
    if (slashes >= 3) score -= 40;
    // 有句子感（句号、逗号）加权
    if (/[。，；！？]/.test(text)) score += 25;
    // 全是尺寸/标签这种短词串也降权
    if (/^(?:[A-Za-z0-9:\s\/]+)$/.test(text)) score -= 30;
    return score;
}

/**
 * 扫一本世界书（或任意一组条目），把所有能认出来的人凑成通讯录条目。
 * @param {Array<{title:string,content:string}>} entries
 */
export function scanEntriesForPeople(entries = []) {
    const list = Array.isArray(entries) ? entries : [];
    const found = [];
    for (const entry of list) {
        const content = String(entry?.content || '');
        const title = String(entry?.title || '');
        if (!content.trim()) continue;
        // 标题本身就是人名（如「林小雨」「雨桐」），内容里也常带 <名字> 块
        found.push(...parseTaggedPeople(content));
        found.push(...parseTablePeople(content));
        found.push(...parseJsonPeople(content));
        found.push(...parseRelationTable(content));
        found.push(...parseBasicInfoList(content));

        // 标题是人名 + 内容里有姓名/角色基础信息 → 也算一个人
        // 注意：`[auto_message:private_chat,...]主动发消息指令` 这类标题以方括号开头，
        // 方括号里是程序标识；剥掉后剩下的半截「主动发消」会误判成人名。
        // 所以只要标题以 [ 开头，就整条跳过——真实的人名条目不会这样写。
        const isProgramTitle = /^\s*\[/.test(title);
        const cleanTitle = title.replace(/^character_/, '').replace(/^char_/, '').trim();
        if (!isProgramTitle && cleanTitle && looksLikeName(cleanTitle) && /姓名|角色基础信息|性别/.test(content) && !found.some(item => normalizeName(item.name) === cleanTitle)) {
            const gender = yamlValue(content, '性别');
            const role = yamlValue(content, '职业') || yamlValue(content, '职位');
            found.push({
                name: cleanTitle,
                gender,
                role,
                desc: clean(yamlValue(content, '整体印象') || content, 300),
                source: 'entry-title',
            });
        }
    }

    // 按名字合并，留信息最多的那份，其余字段补齐
    const byName = new Map();
    for (const person of found) {
        const name = normalizeName(person.name);
        if (!name || !looksLikeName(name)) continue;
        const previous = byName.get(name);
        if (!previous) {
            byName.set(name, { ...person, name });
            continue;
        }
        // 描述挑「更像人话」的那份：紧凑格式（名字/女/B88/…）虽然更长但信息量低，
        // 所以按形态打分，不按长度。
        const betterDesc = descScore(person.desc) > descScore(previous.desc) ? person.desc : previous.desc;
        byName.set(name, {
            ...previous,
            ...person,
            name,
            role: person.role || previous.role,
            relation: person.relation || previous.relation,
            desc: betterDesc,
            style: person.style || previous.style,
            gender: person.gender || previous.gender,
            age: person.age || previous.age,
            measurements: person.measurements || previous.measurements,
            nickname: (person.nickname?.length ? person.nickname : previous.nickname || []).slice(0, 3),
        });
    }
    return [...byName.values()];
}

/** 从 MVU 变量里取人（当前目标 + 委托方），这些往往不在世界书里。 */
export function peopleFromMvu() {
    try {
        const { clients } = readClients();
        return clients.map(client => ({
            name: client.name,
            role: client.role || '',
            desc: (client.others || []).slice(0, 2).map(item => item.key + '：' + item.value).join('；').slice(0, 300),
            source: 'mvu',
        })).filter(person => looksLikeName(person.name));
    } catch {
        return [];
    }
}

/**
 * 从世界书 + MVU 变量里收人。
 * 这是通讯录的主要来源，纯规则、不花 token。
 */
export async function worldBookPeople({ limit = 80 } = {}) {
    let entries = [];
    try {
        entries = await worldBookFull();
    } catch {
        entries = [];
    }
    const fromBook = scanEntriesForPeople(entries);
    const fromMvu = peopleFromMvu();
    const merged = new Map();
    for (const person of [...fromBook, ...fromMvu]) {
        const name = normalizeName(person.name);
        if (!name) continue;
        const previous = merged.get(name);
        if (!previous) { merged.set(name, { ...person, name }); continue; }
        merged.set(name, {
            ...previous,
            ...person,
            name,
            desc: person.desc || previous.desc,
            role: person.role || previous.role,
        });
    }
    // 统一做一遍宏替换：世界书里到处是 {{user}}，不能让它原样进通讯录
    return [...merged.values()]
        .map(person => ({
            ...person,
            role: person.role.replace(/\{\{user\}\}/gi, '你'),
            desc: String(person.desc || '').replace(/\{\{user\}\}/gi, '你'),
            relation: String(person.relation || '').replace(/\{\{user\}\}/gi, '你'),
            style: String(person.style || '').replace(/\{\{user\}\}/gi, '你'),
        }))
        .slice(0, limit);
}
