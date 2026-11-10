/**
 * 客户档案（Client Files）—— 二创新增
 * ------------------------------------------------------------------
 * 读 MVU 变量，把每一位客户（调教对象 / 委托方）的信息收成档案卡：
 * 次数、敏感点、进度、额外癖好、委托方关系……
 *
 * 关键设计：
 *   1. 不硬编码字段名。不同卡的 MVU 变量树结构完全不一样（洗白卡是
 *      「目标角色.训练记录.口交次数」，别的卡可能是「角色.某某.好感」），
 *      所以这里做「结构识别」：先按已知模式抓，抓不到的字段原样平铺显示。
 *   2. 历史归档。MVU 只保存「当前」对象，换人就被覆盖了。所以每次读取都把
 *      当前对象快照一份按名字存档，形成真正的客户档案库。
 *   3. 只读。绝不写 MVU 变量——那是正文的领域，手机只做展示。
 */
import { h, icon, avatar, sheet, toast } from '../render.js';
import { getData, getSettings, getFeed, setFeed, saveNow } from '../store.js';
import { characterAvatar } from '../st.js';
import { flatVariables, mvuAvailable, pickVars, varsToText } from '../mvu.js';

/** 已知的「计数类」字段名模式。命中就把值当次数显示。 */
const COUNT_PATTERN = /(次数|计数|累计|回数|count)/i;
/** 已知的「进度类」字段名。 */
const PROGRESS_PATTERN = /(进度|完成度|百分比|progress|percent)/i;
/** 已知的「列表类」字段名。 */
const LIST_PATTERN = /(敏感|癖|偏好|喜好|标签|清单|点位|list|tags?)/i;
/** 已知的「身份类」字段名。 */
const NAME_PATTERN = /^(姓名|名字|名称|name)$/i;
/** 明显不是人物的分组名——MVU 里「业务详情 / 训练记录」这类子对象不能被当成人。 */
const NOT_PERSON = /^(业务详情|训练记录|基础信息|时间状态|地点信息|委托方信息|目标角色|当前穿着|业务要求|特殊要求|$meta)$/;

/**
 * 从摊平的变量树里识别出「当前对象」，并返回**包含它所有子分组的那一层**。
 *
 * 踩过的坑：洗白卡的结构是
 *   目标角色.基础信息.姓名
 *   目标角色.训练记录.口交次数   ← 和「基础信息」同级，不在它里面
 * 所以只取「含姓名字段的那个节点」（基础信息）会丢掉训练记录。
 * 正确做法是：找到名字字段后，一路往上找到「目标角色」这层——
 * 也就是最后一个「不含姓名、但含姓名的祖先路径」的父节点。
 */
function findSubject(vars) {
    // 先找所有含姓名字段的节点
    const named = [];
    const walk = (node, path, depth) => {
        if (!node || typeof node !== 'object' || depth > 6) return;
        if (Array.isArray(node)) return;
        for (const [key, value] of Object.entries(node)) {
            if (NAME_PATTERN.test(key) && typeof value === 'string' && value.trim()) {
                named.push({ path, name: value.trim(), depth });
                break;
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === '$meta') continue;
            walk(value, path ? path + '.' + key : key, depth + 1);
        }
    };
    walk(vars, '', 0);
    if (!named.length) return null;

    // 取路径最短的那个（最上层的对象），它通常就是「目标角色」这层容器
    named.sort((a, b) => a.path.split('.').length - b.path.split('.').length);
    const target = named[0];

    // 沿着路径往上，找到「再往上就不含姓名」的那一层
    const parts = target.path.split('.');
    let containerPath = target.path;
    for (let i = parts.length; i >= 1; i -= 1) {
        const candidate = parts.slice(0, i).join('.');
        const node = pickVars(vars, candidate);
        if (!node || typeof node !== 'object') continue;
        // 这一层里有没有姓名字段（直接子级）
        const hasName = Object.keys(node).some(key => NAME_PATTERN.test(key) && typeof node[key] === 'string' && node[key].trim());
        if (hasName) {
            // 含姓名的是「基础信息」这类；它的父级才是容器
            containerPath = i > 1 ? parts.slice(0, i - 1).join('.') : candidate;
            break;
        }
    }
    // 如果往上找到的容器还是同一层，就用原名所在层
    const container = pickVars(vars, containerPath) || pickVars(vars, target.path);
    return {
        path: containerPath,
        node: container,
        name: target.name,
        depth: containerPath.split('.').length,
    };
}

/**
 * 把「当前对象」那棵子树拆成 计数 / 进度 / 列表 / 其它 四组。
 * 关键：要一直往下走，不能只停在一层——洗白卡的值在
 * 目标角色.训练记录.口交次数，中间隔了两层分组。
 */
function categorize(node) {
    const counts = [];
    const progress = [];
    const lists = [];
    const others = [];
    const seen = new Set();

    const emit = (target, key, path, value) => {
        const text = Array.isArray(value) ? value.join('、') : String(value);
        if (!text.trim()) return;
        const dedupe = key + '|' + path;
        if (seen.has(dedupe)) return;
        seen.add(dedupe);
        target.push({ key, path, value: text });
    };

    const walk = (value, path, label, depth) => {
        if (value === null || value === undefined || depth > 8) return;
        if (typeof value === 'object' && !Array.isArray(value)) {
            for (const [key, item] of Object.entries(value)) {
                if (key === '$meta') continue;
                walk(item, path ? path + '.' + key : key, key, depth + 1);
            }
            return;
        }
        // 数组：列表类字段按列表收，纯数字数组也当列表
        if (Array.isArray(value)) {
            const cleaned = value.map(item => String(item)).filter(item => item && item !== '$__META_EXTENSIBLE__$');
            if (!cleaned.length) return;
            if (LIST_PATTERN.test(label) || cleaned.some(item => !/^\d+$/.test(item))) {
                emit(lists, label, path, cleaned);
                return;
            }
            // 纯数字数组 → 当成计数
            const sum = cleaned.reduce((acc, item) => acc + (Number(item) || 0), 0);
            emit(counts, label, path, sum);
            return;
        }
        // 标量
        if (PROGRESS_PATTERN.test(label)) {
            const percent = Math.max(0, Math.min(100, Number(value) || 0));
            const item = { key: label, path, value: String(value), percent };
            if (!seen.has(label + '|' + path)) { seen.add(label + '|' + path); progress.push(item); }
            return;
        }
        if (COUNT_PATTERN.test(label) || (typeof value === 'number' && Number.isFinite(value) && /^\d+$/.test(String(value)))) {
            emit(counts, label, path, value);
            return;
        }
        if (LIST_PATTERN.test(label)) {
            emit(lists, label, path, String(value));
            return;
        }
        emit(others, label, path, value);
    };

    walk(node, '', '', 0);
    return { counts, progress, lists, others };
}

/**
 * 从 MVU 变量里读所有「客户」。
 * 除了主对象，还会顺带找「委托方信息」这类可扩展模板（里面每个人是一条）。
 */
export function readClients() {
    const { source, vars } = flatVariables();
    if (!Object.keys(vars).length) {
        return { source, clients: [], vars: {} };
    }
    const clients = [];

    // 1) 主对象（当前目标）
    const subject = findSubject(vars);
    if (subject) {
        const groups = categorize(subject.node);
        clients.push({
            id: 'client-' + subject.name,
            name: subject.name,
            path: subject.path,
            role: '当前目标',
            ...groups,
        });
    }

    // 2) 委托方 / 名册这类「一个 key 一个人」的模板
    for (const [key, value] of Object.entries(vars)) {
        if (!/委托|客户|名册|人物|角色|roster|clients?/i.test(key)) continue;
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        // 如果这一层自己就有名字，说明它就是主对象，跳过
        if (subject && key === subject.path.split('.').pop()) continue;
        for (const [personName, personNode] of Object.entries(value)) {
            if (!personNode || typeof personNode !== 'object' || Array.isArray(personNode)) continue;
            // 「业务详情 / 训练记录」这类分组不是人
            if (NOT_PERSON.test(personName)) continue;
            const nameField = Object.entries(personNode).find(([field, fieldValue]) => NAME_PATTERN.test(field) && typeof fieldValue === 'string' && fieldValue.trim());
            // 没有姓名字段的子对象，只有当它自己有实际内容（非空对象）才当成一个人
            if (!nameField) {
                const rich = Object.values(personNode).some(item => item !== null && item !== undefined && String(item).trim() && typeof item !== 'object');
                if (!rich) continue;
            }
            const name = nameField ? nameField[1].trim() : personName;
            if (NOT_PERSON.test(name)) continue;
            if (clients.some(client => client.name === name)) continue;
            clients.push({
                id: 'client-' + name,
                name,
                path: key + '.' + personName,
                role: key.replace(/信息|列表|$/, '') || '相关人',
                ...categorize(personNode),
            });
        }
    }

    return { source, clients, vars };
}

/** 档案库存在 feeds.clientFiles = { people: { [name]: profile } }。 */
function archiveState() {
    const feed = getFeed('clientFiles');
    if (!feed || typeof feed !== 'object') return { people: {} };
    return { people: feed.people && typeof feed.people === 'object' ? feed.people : {} };
}

function saveArchive(state) {
    setFeed('clientFiles', { people: state.people });
}

/**
 * 把这次读到的客户合并进档案库。
 * 只更新、不删除——MVU 换人之后旧档案要留着，那才是「档案」。
 */
export function syncArchive(clients) {
    const state = archiveState();
    let changed = false;
    for (const client of clients) {
        const previous = state.people[client.name] || {};
        const next = {
            name: client.name,
            role: client.role,
            path: client.path,
            counts: client.counts,
            progress: client.progress,
            lists: client.lists,
            others: client.others,
            firstSeen: previous.firstSeen || Date.now(),
            updatedAt: Date.now(),
            // 记下出现过的次数，换人再换回来也能看出「来过几次」
            visits: (Number(previous.visits) || 0) + (previous.updatedAt && Date.now() - previous.updatedAt < 60000 ? 0 : 1),
        };
        state.people[client.name] = next;
        changed = true;
    }
    if (changed) saveArchive(state);
    return state.people;
}

export function archivePeople() {
    const state = archiveState();
    return Object.values(state.people).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

/* --------------------------------- 界面 --------------------------------- */

export function mountClientFiles(host, { nav, params }) {
    let openName = params?.name || '';
    const body = h('div', { class: 'mp-cf__body' });
    const el = h('div', { class: 'mp-cf' },
        h('div', { class: 'mp-nav' },
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '返回', onclick: () => (openName ? back() : nav.home()) }, icon('back')),
            h('div', { class: 'mp-nav__title', text: '客户档案' }, h('small', { text: 'FILES' })),
            h('div', { class: 'mp-nav__spacer' }),
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '从变量同步', onclick: () => sync() }, icon('refresh')),
        ),
        body,
    );
    host.appendChild(el);

    function back() {
        openName = '';
        render();
    }

    function sync() {
        const { source, clients } = readClients();
        if (!clients.length) {
            toast(mvuAvailable() ? '变量里没找到客户信息' : '没检测到 MVU，先装 MVU 变量框架', 3200);
            return;
        }
        syncArchive(clients);
        toast('已同步 ' + clients.length + ' 位（来自 ' + source + '）');
        render();
    }

    function render() {
        body.innerHTML = '';
        const { source, clients } = readClients();
        if (clients.length) syncArchive(clients);
        const archive = archivePeople();

        if (!clients.length && !archive.length) {
            body.appendChild(h('div', { class: 'mp-empty' },
                h('div', { class: 'mp-empty__icon' }, icon('contacts')),
                h('div', { class: 'mp-empty__title', text: '还没有客户档案' }),
                h('div', { class: 'mp-empty__text', text: mvuAvailable()
                    ? 'MVU 变量里还没有出现客户信息。等正文里接到第一个客户，这里会自动收档。'
                    : '没检测到 MVU 变量框架。装了 MVU（酒馆助手 / MagVarUpdate）之后这里会自动读变量。' }),
                mvuAvailable() ? h('button', { class: 'mp-btn primary', type: 'button', text: '现在读一次', onclick: () => sync() }) : null,
            ));
            return;
        }

        body.appendChild(h('div', { class: 'mp-cf__hint' },
            h('span', { text: '变量来源：' + source }),
            h('span', { text: archive.length + ' 位存档' }),
        ));

        if (openName) {
            const profile = archive.find(item => item.name === openName);
            if (profile) { body.appendChild(renderProfile(profile)); return; }
            openName = '';
        }

        for (const profile of archive) body.appendChild(personCard(profile, clients.some(item => item.name === profile.name)));
    }

    function personCard(profile, isCurrent) {
        const total = profile.counts.reduce((sum, item) => {
            const value = Number(String(item.value).replace(/[^\d.]/g, ''));
            return sum + (Number.isFinite(value) ? value : 0);
        }, 0);
        const progress = profile.progress[0]?.percent ?? null;
        return h('div', {
            class: 'mp-cf__card' + (isCurrent ? ' is-current' : ''),
            onclick: () => { openName = profile.name; render(); },
        },
            avatar({ name: profile.name, src: characterAvatar(profile.name), size: 44, link: false }),
            h('div', { class: 'mp-cf__main' },
                h('div', { class: 'mp-cf__head' },
                    h('span', { class: 'mp-cf__name', text: profile.name }),
                    isCurrent ? h('span', { class: 'mp-cf__tag current', text: '当前' }) : null,
                    profile.role ? h('span', { class: 'mp-cf__tag', text: profile.role }) : null,
                ),
                h('div', { class: 'mp-cf__stats' },
                    h('span', { text: '累计 ' + total + ' 次' }),
                    progress !== null ? h('span', { text: '进度 ' + progress + '%' }) : null,
                    profile.lists.length ? h('span', { text: '标签 ' + profile.lists.reduce((sum, item) => sum + String(item.value).split('、').filter(Boolean).length, 0) }) : null,
                ),
                progress !== null ? h('div', { class: 'mp-cf__bar' }, h('i', { style: { width: Math.max(2, Math.min(100, progress)) + '%' } })) : null,
            ),
            icon('chevron'),
        );
    }

    function renderProfile(profile) {
        const wrap = h('div', { class: 'mp-cf__profile' });
        wrap.appendChild(h('div', { class: 'mp-cf__hero' },
            avatar({ name: profile.name, src: characterAvatar(profile.name), size: 62, link: false }),
            h('div', {},
                h('div', { class: 'mp-cf__heroname', text: profile.name }),
                h('div', { class: 'mp-cf__herometa', text: [profile.role, '首次 ' + new Date(profile.firstSeen).toLocaleDateString('zh-CN')].filter(Boolean).join(' · ') }),
                h('div', { class: 'mp-cf__herometa', text: '变量路径：' + profile.path }),
            ),
        ));

        if (profile.counts.length) {
            wrap.appendChild(h('div', { class: 'mp-cf__sectitle', text: '次数' }));
            const grid = h('div', { class: 'mp-cf__grid' });
            for (const item of profile.counts) {
                grid.appendChild(h('div', { class: 'mp-cf__cell' },
                    h('div', { class: 'mp-cf__celllabel', text: item.key }),
                    h('div', { class: 'mp-cf__cellvalue', text: String(item.value) }),
                ));
            }
            wrap.appendChild(grid);
        }

        if (profile.progress.length) {
            wrap.appendChild(h('div', { class: 'mp-cf__sectitle', text: '进度' }));
            for (const item of profile.progress) {
                wrap.appendChild(h('div', { class: 'mp-cf__progress' },
                    h('div', { class: 'mp-cf__progresshead' },
                        h('span', { text: item.key }),
                        h('span', { text: item.percent + '%' }),
                    ),
                    h('div', { class: 'mp-cf__bar' }, h('i', { style: { width: Math.max(2, Math.min(100, item.percent)) + '%' } })),
                ));
            }
        }

        if (profile.lists.length) {
            wrap.appendChild(h('div', { class: 'mp-cf__sectitle', text: '标记与偏好' }));
            for (const item of profile.lists) {
                const tags = String(item.value).split('、').filter(Boolean);
                wrap.appendChild(h('div', { class: 'mp-cf__listrow' },
                    h('div', { class: 'mp-cf__celllabel', text: item.key }),
                    h('div', { class: 'mp-cf__tags' }, tags.map(tag => h('span', { class: 'mp-cf__tagitem', text: tag }))),
                ));
            }
        }

        if (profile.others.length) {
            wrap.appendChild(h('div', { class: 'mp-cf__sectitle', text: '其它记录' }));
            for (const item of profile.others) {
                wrap.appendChild(h('div', { class: 'mp-cf__field' },
                    h('div', { class: 'mp-cf__celllabel', text: item.key }),
                    h('div', { class: 'mp-cf__celltext', text: String(item.value).slice(0, 400) }),
                ));
            }
        }

        wrap.appendChild(h('div', { class: 'mp-cf__foot', text: '档案是只读快照。要改数据请在正文里推进剧情，MVU 会更新变量，这里再同步。' }));
        return wrap;
    }

    render();
    return { refresh: render };
}
