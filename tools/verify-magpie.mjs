/**
 * 真浏览器端到端验证：在真实酒馆页面里跑一遍 magpie 链路。
 * 用法：node tools/verify-magpie.mjs [tavernUrl]
 */
import { chromium } from 'playwright';

const TAVERN = process.argv[2] || 'http://127.0.0.1:8099/';
const KEY = process.env.MAGPIE_KEY || '';
const BASE = process.env.MAGPIE_BASE || 'http://192.168.101.13:3425';
const MODEL = process.env.MAGPIE_MODEL || 'trae-cn/deepseek-v4.1-flash-max';

if (!KEY) {
    console.error('缺少 MAGPIE_KEY');
    process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
const errors = [];
page.on('pageerror', error => errors.push('pageerror: ' + error.message));
page.on('console', message => {
    if (message.type() === 'error') errors.push('console: ' + message.text().slice(0, 200));
});

await page.goto(TAVERN, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => globalThis.SillyTavern?.getContext?.()?.extensionSettings, null, { timeout: 60000 });

// 1) 扩展是否被酒馆加载
const loaded = await page.evaluate(() => ({
    version: globalThis.MiragePhone?.version || null,
    hasMagpieMenu: !!document.getElementById('mp_menu_item'),
}));
console.log('extension:', JSON.stringify(loaded));

// 2) 写入 magpie 配置
await page.evaluate(({ base, key, model }) => {
    const ctx = globalThis.SillyTavern.getContext();
    const settings = ctx.extensionSettings.mirage_phone || (ctx.extensionSettings.mirage_phone = {});
    settings.ai = settings.ai || {};
    settings.ai.magpie = {
        enabled: true,
        mode: 'proxy',
        baseUrl: base,
        apiKey: key,
        model,
        reasoning: 'none',
        temperature: 0.9,
        proxyPath: '/api/backends/chat-completions',
    };
}, { base: BASE, key: KEY, model: MODEL });

// 3) 用扩展自己的模块跑一次生成（走的是页面里的 fetch，带 CSRF 头）
const result = await page.evaluate(async () => {
    const mod = await import('/scripts/extensions/third-party/st-mirage-phone/src/st.js');
    try {
        const text = await mod.generateText({ system: '你是手机里的角色。', prompt: '只回答两个字：收到', length: 256 });
        return { ok: true, text };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
});
console.log('generateText:', JSON.stringify(result));

// 4) 模型列表
const models = await page.evaluate(async () => {
    const mod = await import('/scripts/extensions/third-party/st-mirage-phone/src/st.js');
    try {
        const list = await mod.magpieListModels();
        return { ok: true, count: list.length, first: list.slice(0, 3).map(m => m.id) };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
});
console.log('models:', JSON.stringify(models));

await browser.close();

const failed = !result.ok || !models.ok;
if (errors.length) console.log('browser errors:', errors.slice(0, 5).join(' | '));
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
