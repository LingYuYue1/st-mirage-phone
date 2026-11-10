/**
 * 终端（Terminal）—— 二创新增
 * ------------------------------------------------------------------
 * 一个「业务终端」：读世界书，把里面写的项目平铺成一栏栏，会员点单。
 *
 * 为什么这么设计：
 *   世界书里的项目（洗白 / 恶堕 / 调教 / VIP 档位…）本来是给正文看的文字，
 *   在手机里没法「点」。这里让 AI 先把它解析成结构化清单（名字/档位/说明/价格/时长），
 *   再平铺成可点的卡片。点单后写进手机的私聊线程，正文那边也能看到。
 *
 * 可扩展：
 *   CATEGORIES 是分类模板，世界书里出现什么业务就归到哪类；解析结果存在
 *   feeds.terminal.projects，以后加「会员卡 / 预约日历 / 消费记录」都往这个结构上挂。
 */
import { h, icon, avatar, sheet, toast } from '../render.js';
import { getData, getSettings, getFeed, setFeed, getCast, saveNow, ensureThread, appendMessages, findThread } from '../store.js';
import { characterAvatar, userName, worldBookFull, currentCharacter, generateText, importantStoryContext } from '../st.js';
import { extractJson } from '../prompts.js';

/** 分类模板：解析结果里的 category 落不到这些值上时归到 other。 */
export const CATEGORIES = [
    { id: 'wash', name: '洗白', tone: '#4fc3a1' },
    { id: 'fall', name: '恶堕', tone: '#c05f8a' },
    { id: 'train', name: '调教', tone: '#f0a35e' },
    { id: 'vip', name: 'VIP 档位', tone: '#d4af37' },
    { id: 'extra', name: '专项', tone: '#5b8def' },
    { id: 'other', name: '其它', tone: '#8a8a8e' },
];

const CATEGORY_HINTS = {
    wash: '洗白、回归正常、重新做人',
    fall: '恶堕、堕落、彻底转变',
    train: '调教、训练、塑造',
    vip: 'VIP / 白金 / 钻石 / 黑卡档位',
    extra: '犒赏、破壁、繁衍、男娘、榨取等专项',
};

/** 终端数据：feeds.terminal = { projects: [], at: 0, orders: [] }。 */
function terminalState() {
    const feed = getFeed('terminal');
    if (!feed || typeof feed !== 'object') return { projects: [], at: 0, orders: [] };
    return {
        projects: Array.isArray(feed.projects) ? feed.projects : [],
        at: Number(feed.at) || 0,
        orders: Array.isArray(feed.orders) ? feed.orders : [],
    };
}

function saveTerminal(state) {
    setFeed('terminal', {
        projects: (state.projects || []).slice(0, 120),
        orders: (state.orders || []).slice(-120),
        at: Number(state.at) || 0,
    });
}

/**
 * 把世界书里的项目解析成结构化清单。
 * 只喂「看起来像项目/业务/价格」的条目，省 token 也更准。
 */
export async function parseProjectsFromWorldBook({ force = false } = {}) {
    const state = terminalState();
    if (!force && state.projects.length) return state.projects;

    const entries = await worldBookFull();
    const relevant = entries.filter(entry => {
        const text = entry.title + entry.content;
        return /项目|业务|套餐|价格|费用|档位|VIP|白金|钻石|黑卡|洗白|恶堕|调教|犒赏|破壁|繁衍|男娘|榨取|流程|服务/i.test(text);
    });
    const source = (relevant.length ? relevant : entries).slice(0, 24);
    if (!source.length) throw new Error('没读到世界书，先把角色卡的世界书挂上');

    const book = source.map(entry => '【' + entry.title + '】\n' + entry.content.slice(0, 900)).join('\n\n');
    const card = currentCharacter();
    const worldName = card?.group ? card.name : (card?.name || '');

    const system = [
        '你在把一个角色扮演世界书里的「业务项目」整理成一份终端菜单。',
        worldName ? '世界：' + worldName : '',
        '只提取世界书里真实写了的项目，不要编造；世界书没写价格就留空，不要猜。',
        '分类只能用这些 id：' + CATEGORIES.map(item => item.id + '（' + item.name + '：' + (CATEGORY_HINTS[item.id] || '') + '）').join('，'),
        '只输出 JSON。',
    ].filter(Boolean).join('\n');

    const prompt = [
        '世界书内容：\n' + book,
        '整理成项目清单，每个项目包含：',
        '{"projects":[{"category":"wash","name":"项目名","desc":"一句话说明","price":"价格原文或空串","duration":"时长或流程原文或空串","tier":"档位或空串"}]}',
        '项目名要短（8 字内），desc 要具体（写清楚做什么、效果是什么）。',
        '最多 20 个，按世界书里的顺序。',
    ].join('\n');

    const raw = await generateText({ system, prompt, length: 1800, json: true });
    const json = extractJson(raw);
    const list = Array.isArray(json?.projects) ? json.projects : [];
    if (!list.length) throw new Error('没能从世界书里解析出项目');

    const projects = list.slice(0, 20).map((item, index) => ({
        id: 'pj-' + index + '-' + Date.now().toString(36),
        category: CATEGORIES.some(cat => cat.id === item?.category) ? item.category : 'other',
        name: String(item?.name || '项目').slice(0, 20),
        desc: String(item?.desc || '').slice(0, 160),
        price: String(item?.price || '').slice(0, 40),
        duration: String(item?.duration || '').slice(0, 60),
        tier: String(item?.tier || '').slice(0, 24),
    }));
    saveTerminal({ ...state, projects, at: Date.now() });
    return projects;
}

/* --------------------------------- 界面 --------------------------------- */

export function mountTerminal(host, { nav, params }) {
    const state = terminalState();
    let category = params?.category || '';
    const body = h('div', { class: 'mp-tm__body' });
    const bar = h('div', { class: 'mp-tm__bar' });
    const el = h('div', { class: 'mp-tm' },
        h('div', { class: 'mp-nav' },
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '返回', onclick: () => nav.home() }, icon('back')),
            h('div', { class: 'mp-nav__title', text: '终端' }, h('small', { text: 'TERMINAL' })),
            h('div', { class: 'mp-nav__spacer' }),
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '重新读取世界书', onclick: () => reload() }, icon('refresh')),
        ),
        bar,
        body,
    );
    host.appendChild(el);

    let busy = false;

    async function reload() {
        if (busy) return;
        busy = true;
        toast('正在读世界书…');
        try {
            await parseProjectsFromWorldBook({ force: true });
            toast('已更新项目清单');
            render();
        } catch (error) {
            toast(String(error?.message || '解析失败'), 3200);
        } finally {
            busy = false;
        }
    }

    function paintBar() {
        bar.innerHTML = '';
        const list = terminalState().projects;
        if (!list.length) return;
        const used = new Set(list.map(item => item.category));
        bar.appendChild(h('button', {
            type: 'button', class: 'mp-tm__chip' + (category === '' ? ' on' : ''), text: '全部（' + list.length + '）',
            onclick: () => { category = ''; render(); },
        }));
        for (const cat of CATEGORIES) {
            if (!used.has(cat.id)) continue;
            const count = list.filter(item => item.category === cat.id).length;
            bar.appendChild(h('button', {
                type: 'button', class: 'mp-tm__chip' + (category === cat.id ? ' on' : ''), text: cat.name + '（' + count + '）',
                onclick: () => { category = cat.id; render(); },
            }));
        }
    }

    function render() {
        paintBar();
        body.innerHTML = '';
        const current = terminalState();
        if (!current.projects.length) {
            body.appendChild(h('div', { class: 'mp-empty' },
                h('div', { class: 'mp-empty__icon' }, icon('grid')),
                h('div', { class: 'mp-empty__title', text: '终端还没读到项目' }),
                h('div', { class: 'mp-empty__text', text: '读一遍角色卡挂的世界书，把里面的业务整理成可点的清单。' }),
                h('button', { class: 'mp-btn primary', type: 'button', text: busy ? '读取中…' : '读取世界书', onclick: () => reload() }),
            ));
            return;
        }

        const list = category ? current.projects.filter(item => item.category === category) : current.projects;
        // 按分类分组平铺
        for (const cat of CATEGORIES) {
            const items = list.filter(item => item.category === cat.id);
            if (!items.length) continue;
            body.appendChild(h('div', { class: 'mp-tm__sectitle' },
                h('span', { class: 'mp-tm__dotmark', style: { background: cat.tone } }),
                h('span', { text: cat.name }),
                h('span', { class: 'mp-tm__count', text: items.length + ' 项' }),
            ));
            const grid = h('div', { class: 'mp-tm__grid' });
            for (const item of items) grid.appendChild(projectCard(item));
            body.appendChild(grid);
        }

        const orders = current.orders.slice(-6).reverse();
        if (orders.length) {
            body.appendChild(h('div', { class: 'mp-tm__sectitle' }, h('span', { text: '最近点单' })));
            for (const order of orders) {
                body.appendChild(h('div', { class: 'mp-tm__order' },
                    h('span', { class: 'mp-tm__ordername', text: order.name }),
                    h('span', { class: 'mp-tm__ordermeta', text: order.target + ' · ' + new Date(order.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
                ));
            }
        }
    }

    function projectCard(item) {
        const cat = CATEGORIES.find(c => c.id === item.category) || CATEGORIES[CATEGORIES.length - 1];
        return h('button', {
            class: 'mp-tm__card', type: 'button',
            onclick: () => openOrder(item),
        },
            h('span', { class: 'mp-tm__cardmark', style: { background: cat.tone } }),
            h('div', { class: 'mp-tm__cardname', text: item.name }),
            item.tier ? h('div', { class: 'mp-tm__cardtier', text: item.tier }) : null,
            item.desc ? h('div', { class: 'mp-tm__carddesc', text: item.desc }) : null,
            h('div', { class: 'mp-tm__cardfoot' },
                item.price ? h('span', { class: 'mp-tm__price', text: item.price }) : h('span', { class: 'mp-tm__price', text: '面议' }),
                item.duration ? h('span', { class: 'mp-tm__dur', text: item.duration }) : null,
            ),
        );
    }

    function openOrder(item) {
        const cast = getCast();
        const picked = new Set();
        const chips = h('div', { class: 'mp-wx__pick' });
        for (const person of cast) {
            chips.appendChild(h('button', {
                class: 'mp-wx__chip', type: 'button', text: person.name,
                onclick: event => {
                    const node = event.currentTarget;
                    if (picked.has(person.name)) { picked.delete(person.name); node.classList.remove('on'); }
                    else { picked.add(person.name); node.classList.add('on'); }
                },
            }));
        }
        const note = h('input', { class: 'mp-input', type: 'text', placeholder: '备注，例如：今晚 / 加急' });
        const dialog = sheet({
            title: item.name,
            content: h('div', { class: 'mp-field-list' },
                h('div', { class: 'mp-tm__sheethead' },
                    h('span', { class: 'mp-tm__price', text: item.price || '面议' }),
                    item.duration ? h('span', { class: 'mp-tm__dur', text: item.duration }) : null,
                ),
                item.desc ? h('div', { class: 'mp-st-hint', text: item.desc }) : null,
                h('div', {}, h('label', { text: '给谁点（可多选）' }), chips),
                h('div', {}, h('label', { text: '备注' }), note),
                h('div', { class: 'mp-st-hint', text: '点单会写进对应人物的私聊，正文那边也能接上。' }),
            ),
            actions: h('button', {
                class: 'mp-btn primary small', type: 'button', text: '下单',
                onclick: () => {
                    if (!picked.size) { toast('先选一个人'); return; }
                    placeOrder(item, [...picked], note.value.trim());
                    dialog.close();
                    render();
                },
            }),
        });
    }

    function placeOrder(item, targets, note) {
        const state = terminalState();
        const me = userName();
        for (const target of targets) {
            const thread = ensureThread([target]);
            if (!thread) continue;
            const text = [
                '【' + item.name + '】',
                item.price ? '价格：' + item.price : '',
                item.duration ? '时长：' + item.duration : '',
                item.desc || '',
                note ? '备注：' + note : '',
            ].filter(Boolean).join('\n');
            appendMessages(thread.id, [{ from: 'me', sender: me, type: 'text', text, ts: Date.now() }]);
            thread.updated = Date.now();
            state.orders.push({ id: 'od-' + Date.now().toString(36), name: item.name, target, price: item.price, note, ts: Date.now() });
        }
        saveTerminal(state);
        saveNow('data');
        toast('已下单：' + item.name);
    }

    render();
    return { refresh: render };
}
