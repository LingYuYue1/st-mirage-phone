/**
 * 微信（WeChat）—— 二创新增
 * ------------------------------------------------------------------
 * 和内置「消息」的区别：
 *   内置消息是「手机里的私聊」，微信是「一部完整的微信」——
 *   底部四个 tab：微信 / 通讯录 / 发现（朋友圈）/ 我。
 *   群聊、私聊共用手机已有的 threads 数据结构（不另起一套，避免两处数据打架），
 *   但多了微信的样子：绿色气泡、群公告、红包、朋友圈入口。
 *
 * 设计上刻意做成「壳 + 可扩展 tab」：
 *   以后要加「微信支付 / 小程序 / 视频号」，往 TABS 里塞一项就行，
 *   不用改主结构。
 */
import { h, icon, avatar, relativeText, sheet, toast } from '../render.js';
import {
    getData, getSettings, saveNow, findThread, ensureThread, appendMessages,
    markRead, saveNow as flush, getCast,
} from '../store.js';
import { characterAvatar, personaAvatarUrl, userName } from '../st.js';
import { replyToThread, isBusy, aiEvents, friendlyError, generateMoments, commentOnMoment } from '../ai.js';
import { mountChat } from './chat.js';
import { parseLine } from '../prompts.js';

/** 微信的底部 tab。以后加功能往这里加一项即可。 */
const TABS = [
    { id: 'chats', label: '微信', icon: 'message' },
    { id: 'contacts', label: '通讯录', icon: 'contacts' },
    { id: 'discover', label: '发现', icon: 'moments' },
    { id: 'me', label: '我', icon: 'user' },
];

export function mountWeChat(host, { nav, params }) {
    // 打开某个会话：直接复用内置聊天页（它已经处理了语音/图片/红包/生成/输入框）
    if (params?.threadId) {
        return mountChat(host, { nav: { ...nav, home: () => nav.go('wechat') }, params });
    }

    let tab = params?.tab && TABS.some(item => item.id === params.tab) ? params.tab : 'chats';
    const body = h('div', { class: 'mp-wx__body' });
    const tabbar = h('div', { class: 'mp-wx__tabbar' });
    const el = h('div', { class: 'mp-wx' },
        h('div', { class: 'mp-wx__nav' },
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '返回', onclick: () => nav.home() }, icon('back')),
            h('div', { class: 'mp-wx__title', text: '微信' }),
            h('button', { class: 'mp-nav__btn', type: 'button', 'aria-label': '更多', onclick: () => openMore() }, icon('more')),
        ),
        body,
        tabbar,
    );
    host.appendChild(el);

    function paintTabs() {
        tabbar.innerHTML = '';
        for (const item of TABS) {
            tabbar.appendChild(h('button', {
                type: 'button',
                class: 'mp-wx__tab' + (tab === item.id ? ' on' : ''),
                onclick: () => { tab = item.id; render(); },
            },
                h('span', { class: 'mp-wx__tabicon' }, icon(item.icon, '', 22)),
                h('span', { class: 'mp-wx__tablabel', text: item.label }),
                item.id === 'chats' ? unreadBadge() : null,
            ));
        }
    }

    function unreadBadge() {
        const total = (getData().threads || []).reduce((sum, thread) => sum + (Number(thread.unread) || 0), 0);
        if (!total) return null;
        return h('span', { class: 'mp-wx__badge', text: total > 99 ? '99+' : String(total) });
    }

    function render() {
        paintTabs();
        body.innerHTML = '';
        const keep = body.scrollTop;
        if (tab === 'chats') body.appendChild(renderChats());
        else if (tab === 'contacts') body.appendChild(renderContacts());
        else if (tab === 'discover') body.appendChild(renderDiscover());
        else body.appendChild(renderMe());
        body.scrollTop = keep;
    }

    /* ------------------------------ 微信（会话） ------------------------------ */

    function renderChats() {
        const wrap = h('div', { class: 'mp-wx__pane' });
        const threads = [...(getData().threads || [])]
            .filter(thread => thread && Array.isArray(thread.members) && thread.members.length)
            .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0));

        if (!threads.length) {
            wrap.appendChild(h('div', { class: 'mp-empty' },
                h('div', { class: 'mp-empty__icon' }, icon('message')),
                h('div', { class: 'mp-empty__title', text: '还没有聊天' }),
                h('div', { class: 'mp-empty__text', text: '去通讯录找个人说句话，或者新建一个群。' }),
                h('button', { class: 'mp-btn primary', type: 'button', text: '新建群聊', onclick: () => createGroup() }),
            ));
            return wrap;
        }

        for (const thread of threads) wrap.appendChild(chatRow(thread));
        return wrap;
    }

    function chatRow(thread) {
        const last = [...(thread.msgs || [])].reverse().find(msg => msg && msg.text);
        const preview = last ? previewText(last) : '（还没有消息）';
        const group = (thread.members || []).length > 1;
        const name = thread.name || thread.members[0];
        const unread = Number(thread.unread) || 0;
        return h('div', {
            class: 'mp-wx__row',
            onclick: () => nav.go('wechat', { threadId: thread.id }),
        },
            group
                ? h('div', { class: 'mp-wx__avatar mp-wx__avatar--group' },
                    ...(thread.members || []).slice(0, 4).map(member => avatar({ name: member, src: characterAvatar(member), size: 22, link: false })))
                : avatar({ name, src: characterAvatar(name), size: 46, link: false }),
            h('div', { class: 'mp-wx__main' },
                h('div', { class: 'mp-wx__rowhead' },
                    h('span', { class: 'mp-wx__name', text: group ? name + '（' + thread.members.length + '）' : name }),
                    h('span', { class: 'mp-wx__time', text: last ? relativeText(Number(last.ts) || thread.updated) : '' }),
                ),
                h('div', { class: 'mp-wx__preview' },
                    h('span', { class: 'mp-wx__previewtext', text: preview }),
                    unread ? h('span', { class: 'mp-wx__badge', text: unread > 99 ? '99+' : String(unread) }) : null,
                ),
            ),
        );
    }

    function previewText(msg) {
        if (msg.type === 'voice') return '[语音]';
        if (msg.type === 'photo') return '[图片]';
        if (msg.type === 'redpacket') return '[红包] ' + (msg.text || '');
        if (msg.type === 'transfer') return '[转账] ' + (msg.text || '');
        if (msg.type === 'location') return '[位置] ' + (msg.text || '');
        return String(msg.text || '').replace(/\s+/g, ' ').slice(0, 40);
    }

    /* ------------------------------ 通讯录 ------------------------------ */

    function renderContacts() {
        const wrap = h('div', { class: 'mp-wx__pane' });
        const cast = getCast();
        wrap.appendChild(h('div', { class: 'mp-wx__group' },
            h('button', {
                class: 'mp-wx__cell', type: 'button',
                onclick: () => createGroup(),
            },
                h('span', { class: 'mp-wx__cellicon', style: { background: '#07c160' } }, icon('group', '', 20)),
                h('span', { text: '发起群聊' }),
                icon('chevron'),
            ),
        ));

        const list = h('div', { class: 'mp-wx__group' });
        list.appendChild(h('div', { class: 'mp-wx__grouptitle', text: '联系人（' + cast.length + '）' }));
        if (!cast.length) {
            list.appendChild(h('div', { class: 'mp-st-hint', style: { padding: '12px 14px' }, text: '通讯录还是空的。去「通讯录」应用里从角色卡提取人物。' }));
        }
        for (const person of cast) {
            list.appendChild(h('div', {
                class: 'mp-wx__row', onclick: () => openWith(person.name),
            },
                avatar({ name: person.name, src: characterAvatar(person.name), size: 40, link: false }),
                h('div', { class: 'mp-wx__main' },
                    h('div', { class: 'mp-wx__rowhead' }, h('span', { class: 'mp-wx__name', text: person.name })),
                    person.role || person.relation
                        ? h('div', { class: 'mp-wx__preview' }, h('span', { class: 'mp-wx__previewtext', text: [person.role, person.relation].filter(Boolean).join(' · ') }))
                        : null,
                ),
            ));
        }
        wrap.appendChild(list);
        return wrap;
    }

    function openWith(name) {
        const thread = ensureThread([name]);
        if (thread) {
            saveNow('data');
            nav.go('wechat', { threadId: thread.id });
        }
    }

    function createGroup() {
        const name = h('input', { class: 'mp-input', type: 'text', placeholder: '群名，例如：公司项目组' });
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
        const dialog = sheet({
            title: '发起群聊',
            content: h('div', { class: 'mp-field-list' },
                h('div', {}, h('label', { text: '群名' }), name),
                h('div', {}, h('label', { text: '选成员（' + cast.length + ' 人可选）' }), chips),
                h('div', { class: 'mp-st-hint', text: '群成员之间会互相接话，说话方式按各自的人设。' }),
            ),
            actions: h('button', {
                class: 'mp-btn primary small', type: 'button', text: '创建',
                onclick: () => {
                    const value = name.value.trim() || '群聊';
                    if (picked.size < 1) { toast('至少选一个人'); return; }
                    const thread = ensureThread([...picked], { name: value, kind: 'group' });
                    if (thread) {
                        saveNow('data');
                        dialog.close();
                        nav.go('wechat', { threadId: thread.id });
                    }
                },
            }),
        });
    }

    /* ------------------------------ 发现（朋友圈） ------------------------------ */

    function renderDiscover() {
        const wrap = h('div', { class: 'mp-wx__pane' });
        const moments = (getData().moments || []).slice(0, 20);
        wrap.appendChild(h('div', { class: 'mp-wx__group' },
            h('div', {
                class: 'mp-wx__cell',
                onclick: () => nav.openMoments(),
            },
                h('span', { class: 'mp-wx__cellicon', style: { background: '#ff9f0a' } }, icon('moments', '', 20)),
                h('span', { text: '朋友圈' }),
                h('span', { class: 'mp-wx__cellbadge' },
                    moments.length ? h('i', { class: 'mp-wx__dot' }) : null,
                    icon('chevron')),
            ),
        ));

        // 朋友圈最新几条直接铺在发现页，不用跳来跳去
        const preview = h('div', { class: 'mp-wx__group' });
        preview.appendChild(h('div', { class: 'mp-wx__grouptitle', text: '最新动态' }));
        if (!moments.length) {
            preview.appendChild(h('div', { class: 'mp-st-hint', style: { padding: '12px 14px' }, text: '还没有动态。点上面进朋友圈生成几条。' }));
        }
        for (const moment of moments.slice(0, 5)) {
            preview.appendChild(h('div', {
                class: 'mp-wx__moment',
                onclick: () => nav.openMoments(),
            },
                avatar({ name: moment.author, src: characterAvatar(moment.author), size: 34, link: false }),
                h('div', { class: 'mp-wx__momentmain' },
                    h('div', { class: 'mp-wx__name', text: moment.author }),
                    h('div', { class: 'mp-wx__previewtext', text: String(moment.text || '').slice(0, 80) }),
                    h('div', { class: 'mp-wx__momentmeta', text: (moment.likes || []).length + ' 赞 · ' + (moment.comments || []).length + ' 评论' }),
                ),
            ));
        }
        wrap.appendChild(preview);
        return wrap;
    }

    /* ------------------------------ 我 ------------------------------ */

    function renderMe() {
        const wrap = h('div', { class: 'mp-wx__pane' });
        const settings = getSettings();
        wrap.appendChild(h('div', { class: 'mp-wx__me' },
            avatar({ name: userName(), src: personaAvatarUrl(), size: 62, link: false }),
            h('div', {},
                h('div', { class: 'mp-wx__mename', text: userName() }),
                h('div', { class: 'mp-wx__mesig', text: settings.signature || '把手机放进剧情里' }),
            ),
        ));
        wrap.appendChild(h('div', { class: 'mp-wx__group' },
            h('div', { class: 'mp-wx__cell', onclick: () => nav.go('me') },
                h('span', { class: 'mp-wx__cellicon', style: { background: '#5b8def' } }, icon('user', '', 20)),
                h('span', { text: '我的主页' }), icon('chevron')),
            h('div', { class: 'mp-wx__cell', onclick: () => nav.go('settings') },
                h('span', { class: 'mp-wx__cellicon', style: { background: '#8a8a8e' } }, icon('settings', '', 20)),
                h('span', { text: '设置' }), icon('chevron')),
        ));
        return wrap;
    }

    /* ------------------------------ 更多 ------------------------------ */

    function openMore() {
        sheet({
            title: '微信',
            content: h('div', { class: 'mp-field-list' },
                h('button', { class: 'mp-btn small block', type: 'button', text: '发起群聊', onclick: () => { createGroup(); } }),
                h('button', { class: 'mp-btn small block', type: 'button', text: '生成朋友圈动态', onclick: async () => {
                    toast('正在生成…');
                    try {
                        const list = await generateMoments(4);
                        toast('生成了 ' + (list?.length || 0) + ' 条');
                        render();
                    } catch (error) { toast(friendlyError(error), 3000); }
                } }),
                h('div', { class: 'mp-st-hint', text: '微信和「消息」共用同一份会话数据——在微信里发的，消息里也能看到。' }),
            ),
        });
    }

    // AI 回复时刷新列表
    const onReply = () => { if (tab === 'chats') render(); };
    aiEvents.addEventListener('reply', onReply);

    render();
    return {
        refresh: render,
        destroy: () => aiEvents.removeEventListener('reply', onReply),
    };
}
