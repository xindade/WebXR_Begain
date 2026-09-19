// 云端关卡配置加载器：解密 /api/content 返回的 AES-256-CBC 加密包，注入到各 content 模块。
// 配合 tools/license-server/server.js 的 /api/content 端点（与激活服务同一进程）。
//
// 设计要点：
//   1. 真实关卡数据仅在「开发态」作为 fallback 存在于各 content 模块（__PROD__ 未定义时）。
//      生产构建（terser global_defs __PROD__=true）会把 fallback 折叠为空数组/对象 →
//      没有云端配置，游戏就「无关卡/无敌人定义」，无法初始化（这是防「删授权代码且离线」的关键）。
//   2. 纯网页非银弹：密钥内置于此处（构建混淆后难提取），攻击者需逆向混淆 + 抓包才能把配置本地化；
//      且配置可随时在云端热更新，无需重新分发游戏。
//   3. 开发态允许本地 fallback（即使云端拉取失败也能跑，方便调试）。

import { SERVER_URL } from './license.js';
import { installCloudLevels } from '../content/levels.js';
import { installCloudLevelEnemy } from '../content/spawnPlans.js';
import { installCloudEnemyTypes } from '../content/enemies.js';

// 与 tools/license-server/server.js 的 CONTENT_KEY 完全一致（AES-256-CBC，32 字节）
const CONTENT_KEY_HEX = '9bc78bbf5e2eca1be52c1f142cf41d7b46d947ea49307a45351c05189c08d074';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 是否开发态：localhost / 127.0.0.1 / 带 ?dev 时允许本地 fallback（即使云端拉取失败也能跑）。
export function isDevMode() {
  try {
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1' ||
      new URLSearchParams(location.search).has('dev');
  } catch (_) { return false; }
}

async function decryptContent(enc) {
  if (!enc || !enc.iv || !enc.data) throw new Error('content 格式错误');
  const key = await globalThis.crypto.subtle.importKey(
    'raw', hexToBytes(CONTENT_KEY_HEX), { name: 'AES-CBC' }, false, ['decrypt']
  );
  const iv = b64ToBytes(enc.iv);
  const plainBuf = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, key, b64ToBytes(enc.data)
  );
  const text = new TextDecoder().decode(plainBuf);
  return JSON.parse(text);
}

// 持有效 license 向 /api/content 拉取并注入云端关卡配置。返回是否成功。
// 同时处理「未授权 / 伪造」请求：server 端会验签 license，非法请求拿不到加密包。
export async function loadCloudContent(license) {
  if (!license || !license.signature) {
    console.warn('[contentLoader] 无 license，跳过云端配置');
    return false;
  }
  try {
    const res = await fetch(SERVER_URL + '/api/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license }),
    });
    if (!res.ok) { console.warn('[contentLoader] /api/content 返回', res.status); return false; }
    const data = await res.json();
    if (!data || !data.content) { console.warn('[contentLoader] 响应缺少 content'); return false; }
    const cfg = await decryptContent(data.content);
    installCloudLevels(cfg.LEVELS);
    installCloudLevelEnemy(cfg.LEVEL_ENEMY);
    installCloudEnemyTypes(cfg.ENEMY_TYPES);
    console.log('[contentLoader] 云端关卡配置已注入（LEVELS / LEVEL_ENEMY / ENEMY_TYPES）');
    return true;
  } catch (e) {
    console.warn('[contentLoader] 加载云端配置失败：', e && e.message);
    return false;
  }
}
