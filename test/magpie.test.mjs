import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeBase, magpieConfig, explainError, textFromCompletion,
    reasoningFromCompletion, jsonFromReasoning, magpieGenerate, magpieListModels,
} from '../src/magpie.js';

test('normalizeBase 补协议、补 /v1、剥掉 /chat/completions', () => {
    assert.equal(normalizeBase('192.168.1.20:3425'), 'http://192.168.1.20:3425/v1');
    assert.equal(normalizeBase('http://192.168.1.20:3425/'), 'http://192.168.1.20:3425/v1');
    assert.equal(normalizeBase('http://192.168.1.20:3425/v1'), 'http://192.168.1.20:3425/v1');
    assert.equal(normalizeBase('http://h:3425/v1/chat/completions'), 'http://h:3425/v1');
    assert.equal(normalizeBase('https://gw.example.com/v1/'), 'https://gw.example.com/v1');
    assert.equal(normalizeBase(''), '');
});

test('magpieConfig 没启用就返回 null', () => {
    assert.equal(magpieConfig({ ai: { magpie: { enabled: false } } }), null);
    assert.equal(magpieConfig({}), null);
    assert.equal(magpieConfig({ ai: { magpie: { enabled: true, baseUrl: 'h:1' } } }), null, '缺模型时也算没配好');
});

test('magpieConfig 归一化字段与默认值', () => {
    const cfg = magpieConfig({
        ai: { magpie: { enabled: true, baseUrl: '192.168.1.20:3425', apiKey: 'sk-x', model: 'trae-cn/deepseek-v4.1-flash-max' } },
    });
    assert.equal(cfg.baseUrl, 'http://192.168.1.20:3425/v1');
    assert.equal(cfg.apiKey, 'sk-x');
    assert.equal(cfg.mode, 'proxy');
    assert.equal(cfg.reasoning, 'low');
    assert.equal(cfg.temperature, 0.9);
    assert.equal(cfg.proxyPath, '/api/backends/chat-completions');
});

test('magpieConfig 认 direct 模式与非法推理档位', () => {
    const cfg = magpieConfig({
        ai: { magpie: { enabled: true, mode: 'direct', baseUrl: 'h:1', model: 'm', reasoning: '超高' } },
    });
    assert.equal(cfg.mode, 'direct');
    assert.equal(cfg.reasoning, 'low', '非法档位回落 low');
});

test('explainError 把 magpie 的三种典型拒绝翻成人话', () => {
    assert.match(explainError(403, 'refused OPTIONS /v1/models from the web page http://x:8000: not one listed in Settings'), /网页来源|转发/);
    assert.match(explainError(401, 'no API key was sent: send a magpie gateway key'), /gateway key/);
    assert.match(explainError(401, 'the API key ending in 1dd6 is not an enabled magpie gateway key'), /失效/);
    assert.match(explainError(404, 'Not Found'), /404/);
    assert.match(explainError(502, 'fetch failed'), /酒馆转发失败|转发/);
});

test('textFromCompletion 兼容字符串、数组与 text 字段', () => {
    assert.equal(textFromCompletion({ choices: [{ message: { content: '  hi  ' } }] }), 'hi');
    assert.equal(textFromCompletion({ choices: [{ message: { content: [{ text: 'a' }, 'b'] } }] }), 'ab');
    assert.equal(textFromCompletion({ choices: [{ text: 'plain' }] }), 'plain');
    assert.equal(textFromCompletion({}), '');
});

test('reasoningFromCompletion / jsonFromReasoning', () => {
    const data = { choices: [{ message: { reasoning_content: '想好了：{"a":1}' } }] };
    assert.equal(reasoningFromCompletion(data), '想好了：{"a":1}');
    assert.equal(jsonFromReasoning(reasoningFromCompletion(data)), '{"a":1}');
    assert.equal(jsonFromReasoning('没有花括号'), '');
});

/* ------------------------- 用假 fetch 跑转发链路 ------------------------- */

function stubTavern(calls) {
    globalThis.SillyTavern = { getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'tok' }) }) };
    return calls;
}

test('magpieGenerate 走酒馆 /generate，并带 CSRF 头与 proxy_password', async () => {
    const calls = stubTavern([]);
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: '收到' } }] }), { status: 200 });
    };
    const cfg = magpieConfig({ ai: { magpie: { enabled: true, baseUrl: '192.168.1.20:3425', apiKey: 'sk-x', model: 'm1' } } });
    const text = await magpieGenerate({ system: 'sys', prompt: 'hi', length: 320 }, cfg);
    assert.equal(text, '收到');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/backends/chat-completions/generate');
    assert.equal(calls[0].init.headers['X-CSRF-Token'], 'tok');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.chat_completion_source, 'openai');
    assert.equal(body.reverse_proxy, 'http://192.168.1.20:3425/v1');
    assert.equal(body.proxy_password, 'sk-x');
    assert.equal(body.model, 'm1');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, 'low');
    assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }]);
    delete globalThis.fetch;
});

test('magpieGenerate 正文空、只有 reasoning 时降档重试一次', async () => {
    const calls = stubTavern([]);
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        const body = JSON.parse(init.body);
        if (body.reasoning_effort !== 'none') {
            return new Response(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '想了很久...' } }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '补上了' } }] }), { status: 200 });
    };
    const cfg = magpieConfig({ ai: { magpie: { enabled: true, baseUrl: 'h:1', model: 'm', reasoning: 'max' } } });
    const text = await magpieGenerate({ prompt: 'hi', length: 512 }, cfg);
    assert.equal(text, '补上了');
    assert.equal(calls.length, 2, '第一次空正文 → 第二次降档');
    assert.equal(JSON.parse(calls[0].init.body).reasoning_effort, 'max');
    assert.equal(JSON.parse(calls[1].init.body).reasoning_effort, 'none');
    delete globalThis.fetch;
});

test('magpieGenerate json 模式能从 reasoning 里救回 JSON', async () => {
    stubTavern([]);
    globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: '思考{"list":[1,2]}结束' } }],
    }), { status: 200 });
    const cfg = magpieConfig({ ai: { magpie: { enabled: true, baseUrl: 'h:1', model: 'm', reasoning: 'none' } } });
    const text = await magpieGenerate({ prompt: 'give json', json: true }, cfg);
    assert.equal(text, '{"list":[1,2]}');
    delete globalThis.fetch;
});

test('magpieGenerate 把 403 转成可读错误', async () => {
    stubTavern([]);
    globalThis.fetch = async () => new Response('refused OPTIONS /v1/chat/completions: not one listed in Settings', { status: 403 });
    const cfg = magpieConfig({ ai: { magpie: { enabled: true, baseUrl: 'h:1', model: 'm' } } });
    await assert.rejects(() => magpieGenerate({ prompt: 'hi' }, cfg), /网页来源|转发/);
    delete globalThis.fetch;
});

test('magpieGenerate 没配置时报错而不是静默走主 API', async () => {
    await assert.rejects(() => magpieGenerate({ prompt: 'hi' }, null), /没有配置 magpie/);
});

test('direct 模式直接打 magpie 的 /chat/completions', async () => {
    const calls = stubTavern([]);
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ choices: [{ message: { content: '直连ok' } }] }), { status: 200 });
    };
    const cfg = magpieConfig({ ai: { magpie: { enabled: true, mode: 'direct', baseUrl: '192.168.1.20:3425', apiKey: 'sk-x', model: 'm' } } });
    const text = await magpieGenerate({ prompt: 'hi' }, cfg);
    assert.equal(text, '直连ok');
    assert.equal(calls[0].url, 'http://192.168.1.20:3425/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-x');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.reverse_proxy, undefined, '直连不该带酒馆转发字段');
    assert.equal(body.model, 'm');
    delete globalThis.fetch;
});

test('magpieListModels 归一化并排序', async () => {
    stubTavern([]);
    globalThis.fetch = async () => new Response(JSON.stringify({
        data: [
            { id: 'trae-cn/x', display_name: 'X 模型', context_length: 1000, reasoning: true },
            { id: 'auto/y', magpie_label: 'Y', context_window: 2000 },
            { nope: true },
        ],
    }), { status: 200 });
    const list = await magpieListModels(magpieConfig({ ai: { magpie: { enabled: true, baseUrl: 'h:1', model: 'm' } } }));
    assert.deepEqual(list.map(m => m.id), ['auto/y', 'trae-cn/x']);
    assert.equal(list[1].label, 'X 模型');
    assert.equal(list[1].context, 1000);
    assert.equal(list[1].reasoning, true);
    assert.equal(list[0].context, 2000);
    delete globalThis.fetch;
});

test('normalizeSettings 清洗模型缓存：只留 id/label/context', async () => {
    const { normalizeSettings } = await import('../src/state.js');
    const settings = normalizeSettings({
        ai: {
            magpie: {
                enabled: true,
                baseUrl: 'h:1',
                model: 'm',
                models: [
                    { id: 'a/b', label: 'B', context: 1000, secret: 'x', junk: [1, 2] },
                    { id: 'c/d', context: '2000' },
                    { noId: true },
                    'garbage',
                ],
                modelsAt: '12345',
            },
        },
    });
    const models = settings.ai.magpie.models;
    assert.equal(models.length, 2, '没有 id 的条目要丢掉');
    assert.deepEqual(Object.keys(models[0]).sort(), ['context', 'id', 'label'], '多余字段不能进设置');
    assert.equal(models[1].label, 'c/d', '缺 label 时回退成 id');
    assert.equal(models[1].context, 2000, 'context 转成数字');
    assert.equal(settings.ai.magpie.modelsAt, 12345);
});

test('normalizeSettings 模型缓存上限与非法值', async () => {
    const { normalizeSettings } = await import('../src/state.js');
    const many = Array.from({ length: 300 }, (_, i) => ({ id: 'm' + i, label: 'L' + i }));
    const settings = normalizeSettings({ ai: { magpie: { enabled: true, baseUrl: 'h:1', model: 'm', models: many, modelsAt: -5 } } });
    assert.equal(settings.ai.magpie.models.length, 200, '最多留 200 个');
    assert.equal(settings.ai.magpie.modelsAt, 0, '负数归零');

    const broken = normalizeSettings({ ai: { magpie: { enabled: true, baseUrl: 'h:1', model: 'm', models: 'not-an-array' } } });
    assert.deepEqual(broken.ai.magpie.models, []);
});
