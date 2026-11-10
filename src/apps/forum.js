/**
 * 论坛（BBS）—— 二创新增
 * ------------------------------------------------------------------
 * 和贴吧的区别：
 *   贴吧是「按吧刷帖子」，论坛是「一个按洗白/调教业务世界长出来的地下论坛」——
 *   有版块（业务区、求助区、经验区、八卦区），有置顶、精华、楼层、点评，
 *   内容按剧情进度「隔几回合」自动长出来，而不是你点一次才生成一次。
 *
 * 隔几回合更新：
 *   每收到 N 条 AI 回复（settings.forum.every，默认 3），自动长一批新帖；
 *   也可以在页面上手动「长一批」。判断依据是 chat 楼层数，不是定时器——
 *   定时器在后台会乱跑，楼层数才代表剧情真的推进了。
 */
import { h, icon, avatar, relativeText, sheet, toast } from '../render.js';
import { getData, getSettings, getFeed, setFeed, getCast, saveNow } from '../store.js';
import { characterAvatar, userName, worldBookFull, currentCharacter } from '../st.js';
import { generateText, storyContext, importantStoryContext, memoryContext } from '../st.js';
import { extractJson } from '../prompts.js';

/** 版块：版块 id → 名字 / 说明 / 生成提示。加版块往这里加一项。 */
export const BOARDS = [
    { id: 'biz', name: '业务区', desc: '项目、报价、流程', prompt: '讨论业务项目、报价区间、流程细节' },
    { id: 'exp', name: '经验区', desc: '老手的心得', prompt: '老客户和老手分享经验、注意事项、踩过的坑' },
    { id: 'help', name: '求助区', desc: '问问题的地方', prompt: '新人提问、求助、求推荐' },
    { id: 'gossip', name: '八卦区', desc: '传闻与风声', prompt: '传闻、八卦、谁家出了什么事' },
];

/** 首批种子帖（AI 不可用时兜底，保证页面不是空的）。 */
const SEED = [
    { board: 'biz', title: '最近的价格是不是又涨了', text: '上个月问还是那个数，这个月直接翻。有人知道为什么吗？', replies: 26, likes: 41, pinned: true, digest: false },
    { board: 'exp', title: '带新人最容易踩的三个坑', text: '第一，别一上来就上强度；第二，别信「我什么都能接受」；第三，别把承诺当合同。', replies: 63, likes: 128, pinned: false, digest: true },
    { board: 'help', title: '这种情况该找哪一类', text: '朋友介绍来的，说想要「彻底换个活法」，但我拿不准该走哪条线。', replies: 12, likes: 8, pinned: false, digest: false },
    { board: 'gossip', title: '听说城西那家换人了', text: '门口的车牌都换了，里面的人也不一样。有知道的吗？', replies: 34, likes: 19, pinned: false, digest: false },
    { board: 'exp', title: '关于「进度」这件事的实话', text: '进度条不是越高越好。有些人到 60 就到位了，硬推上去反而全崩。', replies: 45, likes: 96, pinned: false, digest: true },
];

/** 论坛数据存在 feeds.forum，结构 { posts: [], cursor: 0, at: 0 }。 */
function forumState() {
    const feed = getFeed('forum');
    if (!feed || !Array.isArray(feed.posts)) return { posts: [], cursor: 0, at: 0 };
    return { posts: feed.posts, cursor: Number(feed.cursor) || 0, at: Number(feed.at) || 0 };
}

function saveForum(state) {
    setFeed('forum', { posts: (state.posts || []).slice(0, 200), cursor: Number(state.cursor) || 0 });
}

/** 世界书里的业务名（洗白 / 恶堕 / 调教…），让论坛话题贴着这个世界走。 */
async function businessLines() {
    try {
        const list = await worldBookFull();
        const text = list.map(entry => entry.title + ' ' + entry.content).join('\n');
        const found = new Set();
        for (const name of ['洗白', '恶堕', '调教', '犒赏', '破壁', '繁衍', '男娘', '榨取', 'VIP', '白金', '钻石', '黑卡']) {
            if (text.includes(name)) found.add(name);
        }
        return [...found];
    } catch {
        return [];
    }
}

async function generateForumBatch({ count = 4, board = '', reason = '' } = {}) {
    const cast = getCast().map(person => person.name);
    const story = importantStoryContext(60, 320).map(line => (line.isUser ? userName() : line.name) + '：' + line.text).join('\n');
    const memory = memoryContext(10).map(item => String(item.text || '').slice(0, 400)).filter(Boolean).join('\n');
    const world = await businessLines();
    const card = currentCharacter();
    const worldName = card?.group ? card.name : (card?.name || '');

    const targets = board ? BOARDS.filter(item => item.id === board) : BOARDS;
    const boardList = targets.map(item => item.id + '（' + item.name + '：' + item.prompt + '）').join('\n');

    const system = [
        '你在为一个故事世界里的地下论坛生成帖子。',
        worldName ? '世界：' + worldName : '',
        '语气要像真实论坛：有标题党、有干货、有阴阳怪气、有装懂的，不要每个人都一个调子。',
        '人物、地点、业务名必须和设定一致，不要编造设定里没有的机构。',
        '只输出 JSON。',
    ].filter(Boolean).join('\n');

    const prompt = [
        story ? '最近的剧情：\n' + story : '',
        memory ? '记忆摘要：\n' + memory : '',
        cast.length ? '世界里的人（作者可以从这里挑）：' + cast.join('、') : '',
        world.length ? '这个世界存在的业务：' + world.join('、') : '',
        reason ? '这次为什么长新帖：' + reason : '',
        '版块（board 字段必须用左边的 id）：\n' + boardList,
        '生成 ' + count + ' 个帖子，每个版块至少一个。',
        '只输出：{"posts":[{"board":"biz","title":"标题","text":"正文 40-120 字","author":"发帖人","replies":18,"likes":7,"pinned":false,"digest":false}]}',
    ].filter(Boolean).join('\n');

    const raw = await generateText({ system, prompt, length: 1400, json: true });
    const json = extractJson(raw);
    const posts = Array.isArray(json?.posts) ? json.posts : [];
    if (!posts.length) throw new Error('论坛这次没生成出内容');
    return posts.slice(0, count);
}

function fallbackBatch(count = 3) {
    const cast = getCast().map(person => person.name);
    return SEED.slice(0, count).map((post, index) => ({
        ...post,
        author: cast[index % Math.max(1, cast.length)] || '路过的人',
        replies: post.replies + Math.floor(Math.random() * 8),
        likes: post.likes + Math.floor(Math.random() * 12),
    }));
}

function normalizePost(raw, index, boardFallback = 'biz') {
    const board = BOARDS.some(item => item.id === raw?.board) ? raw.board : boardFallback;
    return {
        id: 'fo-' + Date.now().toString(36) + '-' + index,
        board,
        title: String(raw?.title || '无题').slice(0, 60),
        text: String(raw?.text || '').slice(0, 600),
        author: String(raw?.author || '').slice(0, 24) || '路过的人',
        replies: Math.max(0, Number(raw?.replies) || 0),
        likes: Math.max(0, Number(raw?.likes) || 0),
        pinned: raw?.pinned === true,
        digest: raw?.digest === true,
        ts: Date.now(),
        comments: [],
    };
}

/**
 * 按剧情进度长帖：只有真的推进了 N 层才动。
 * 由 index.js 在 MESSAGE_RECEIVED 里调。
 */
export async function maybeGrowForum({ force = false } = {}) {
    const settings = getSettings();
    if (!force && settings.forum?.auto === false) return null;
    const every = Math.max(1, Number(settings.forum?.every) || 3);
    const floors = (() => {
        try {
            const c = globalThis.SillyTavern?.getContext?.();
            return Array.isArray(c?.chat) ? c.chat.length : 0;
        } catch { return 0; }
    })();
    const state = forumState();
    const pending = floors - state.cursor;
    if (!force && pending < every) return null;

    try {
        const batch = await generateForumBatch({
            count: 3,
            reason: force ? '手动刷新' : '剧情推进了 ' + pending + ' 层',
        });
        const posts = batch.map((post, index) => normalizePost(post, index));
        saveForum({ posts: [...posts, ...state.posts], cursor: floors, at: Date.now() });
        return posts;
    } catch (error) {
        console.warn('[幻镜手机] 论坛长帖失败', error);
        if (!force) return null;
        const posts = fallbackBatch(3).map((post, index) => normalizePost(post, index));
        saveForum({ posts: [...posts, ...state.posts], cursor: floors, at: Date.now() });
        return posts;
    }
}

/* --------------------------------- 界面 --------------------------------- */

export function mountForum(host, { nav, params }) {
    let board = params?.board && BOARDS.some(item => item.id === params.board) ? params.board : '';
    let openPostId = params?.postId || '';
    const body = h('div', { class: 'mp-fo__body' });
    const tabs = h('div', { class: 'mp-fo__tabs' });
    const el = h('div', { class: 'mp-fo' },
        h('div', { class: 'mp-nav' },
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '返回', onclick: () => (openPostId ? backToList() : nav.home()) }, icon('back')),
            h('div', { class: 'mp-nav__title', text: '论坛' }, h('small', { text: 'BBS' })),
            h('div', { class: 'mp-nav__spacer' }),
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '长一批新帖', onclick: () => grow(true) }, icon('refresh')),
        ),
        tabs,
        body,
    );
    host.appendChild(el);

    let busy = false;

    function backToList() {
        openPostId = '';
        render();
    }

    function paintTabs() {
        tabs.innerHTML = '';
        tabs.appendChild(h('button', {
            type: 'button', class: 'mp-fo__tab' + (board === '' ? ' on' : ''), text: '全部',
            onclick: () => { board = ''; openPostId = ''; render(); },
        }));
        for (const item of BOARDS) {
            tabs.appendChild(h('button', {
                type: 'button', class: 'mp-fo__tab' + (board === item.id ? ' on' : ''), text: item.name,
                onclick: () => { board = item.id; openPostId = ''; render(); },
            }));
        }
    }

    async function grow(manual = false) {
        if (busy) return;
        busy = true;
        toast('正在长新帖…');
        try {
            const posts = await maybeGrowForum({ force: true });
            toast(posts?.length ? '新增 ' + posts.length + ' 帖' : '这次没长出来');
            render();
        } catch (error) {
            toast(String(error?.message || '生成失败'), 3000);
        } finally {
            busy = false;
        }
    }

    function ensureSeed() {
        const state = forumState();
        if (state.posts.length) return state;
        const posts = SEED.map((post, index) => normalizePost(post, index));
        const next = { posts, cursor: 0, at: Date.now() };
        saveForum(next);
        return next;
    }

    function render() {
        paintTabs();
        body.innerHTML = '';
        const state = ensureSeed();
        if (openPostId) {
            const post = state.posts.find(item => item.id === openPostId);
            if (post) { body.appendChild(renderPost(post, state)); return; }
            openPostId = '';
        }
        const list = board ? state.posts.filter(post => post.board === board) : state.posts;
        const pinned = list.filter(post => post.pinned);
        const rest = list.filter(post => !post.pinned);
        const settings = getSettings();
        const every = Math.max(1, Number(settings.forum?.every) || 3);

        body.appendChild(h('div', { class: 'mp-fo__hint' },
            h('span', { text: '每 ' + every + ' 层剧情自动长一批' }),
            h('button', { type: 'button', class: 'mp-fo__grow', text: busy ? '生成中…' : '现在长一批', onclick: () => grow(true) }),
        ));

        if (!list.length) {
            body.appendChild(h('div', { class: 'mp-empty' },
                h('div', { class: 'mp-empty__icon' }, icon('hash')),
                h('div', { class: 'mp-empty__title', text: '这个版块还没有帖子' }),
                h('button', { class: 'mp-btn primary', type: 'button', text: '长一批', onclick: () => grow(true) }),
            ));
            return;
        }

        for (const post of [...pinned, ...rest]) body.appendChild(postRow(post));
    }

    function postRow(post) {
        const meta = BOARDS.find(item => item.id === post.board);
        return h('article', {
            class: 'mp-fo__post' + (post.pinned ? ' is-pinned' : '') + (post.digest ? ' is-digest' : ''),
            onclick: () => { openPostId = post.id; render(); },
        },
            h('div', { class: 'mp-fo__posthead' },
                h('span', { class: 'mp-fo__board', text: meta?.name || '综合' }),
                post.pinned ? h('span', { class: 'mp-fo__flag pinned', text: '置顶' }) : null,
                post.digest ? h('span', { class: 'mp-fo__flag digest', text: '精华' }) : null,
            ),
            h('div', { class: 'mp-fo__title', text: post.title }),
            h('div', { class: 'mp-fo__excerpt', text: post.text }),
            h('div', { class: 'mp-fo__meta' },
                avatar({ name: post.author, size: 18, link: false }),
                h('span', { text: post.author }),
                h('span', { class: 'mp-fo__dot', text: '·' }),
                h('span', { text: post.replies + ' 回复' }),
                h('span', { class: 'mp-fo__dot', text: '·' }),
                h('span', { text: post.likes + ' 赞' }),
            ),
        );
    }

    function renderPost(post, state) {
        const wrap = h('div', { class: 'mp-fo__detail' });
        const meta = BOARDS.find(item => item.id === post.board);
        wrap.appendChild(h('div', { class: 'mp-fo__detailhead' },
            h('div', { class: 'mp-fo__posthead' },
                h('span', { class: 'mp-fo__board', text: meta?.name || '综合' }),
                post.pinned ? h('span', { class: 'mp-fo__flag pinned', text: '置顶' }) : null,
                post.digest ? h('span', { class: 'mp-fo__flag digest', text: '精华' }) : null,
            ),
            h('h1', { class: 'mp-fo__detailtitle', text: post.title }),
            h('div', { class: 'mp-fo__meta' },
                avatar({ name: post.author, size: 20, link: false }),
                h('span', { text: post.author }),
                h('span', { class: 'mp-fo__dot', text: '·' }),
                h('span', { text: post.ts ? relativeText(post.ts) : '刚刚' }),
            ),
        ));
        wrap.appendChild(h('div', { class: 'mp-fo__content', text: post.text }));

        // 楼层：1 楼是楼主，之后是回复
        const comments = Array.isArray(post.comments) ? post.comments : [];
        wrap.appendChild(h('div', { class: 'mp-fo__floor' },
            h('span', { class: 'mp-fo__floorno', text: '1 楼' }),
            h('span', { class: 'mp-fo__floorname', text: post.author }),
            h('span', { class: 'mp-fo__floortext', text: post.text.slice(0, 120) }),
        ));
        comments.forEach((comment, index) => {
            wrap.appendChild(h('div', { class: 'mp-fo__floor' },
                h('span', { class: 'mp-fo__floorno', text: (index + 2) + ' 楼' }),
                h('span', { class: 'mp-fo__floorname', text: comment.author }),
                h('span', { class: 'mp-fo__floortext', text: comment.text }),
            ));
        });

        wrap.appendChild(h('div', { class: 'mp-fo__actions' },
            h('button', {
                class: 'mp-btn primary small', type: 'button', text: '让论坛接着聊',
                onclick: () => replyToPost(post, state),
            }),
        ));
        return wrap;
    }

    async function replyToPost(post, state) {
        if (busy) return;
        busy = true;
        toast('正在生成回复…');
        try {
            const cast = getCast().map(person => person.name);
            const story = storyContext(20, 260).map(line => (line.isUser ? userName() : line.name) + '：' + line.text).join('\n');
            const system = '你在模拟一个故事世界里的论坛。回复要像真人：有认同、有反驳、有跑题、有装懂的。只输出 JSON。';
            const prompt = [
                story ? '最近的剧情：\n' + story : '',
                cast.length ? '可能出现的 ID：' + cast.join('、') : '',
                '帖子标题：' + post.title,
                '帖子正文：' + post.text,
                '已有的回复：' + ((post.comments || []).map(item => item.author + '：' + item.text).join('\n') || '（还没有）'),
                '再生成 3-5 条回复，不要重复已有的。',
                '只输出：{"comments":[{"author":"ID","text":"回复内容"}]}',
            ].filter(Boolean).join('\n');
            const raw = await generateText({ system, prompt, length: 800, json: true });
            const json = extractJson(raw);
            const list = Array.isArray(json?.comments) ? json.comments : [];
            if (!list.length) throw new Error('没生成出回复');
            post.comments = [...(post.comments || []), ...list.slice(0, 5).map(item => ({
                author: String(item.author || '路过的人').slice(0, 24),
                text: String(item.text || '').slice(0, 240),
            }))];
            post.replies = (post.comments || []).length;
            saveForum(state);
            render();
            toast('加了 ' + list.length + ' 条');
        } catch (error) {
            toast(String(error?.message || '生成失败'), 3000);
        } finally {
            busy = false;
        }
    }

    render();
    return { refresh: render };
}
