// 第九十二修 · 本局结算面板
//
// 锁四条现场口径：
//   ① 最后一击只进结算态，不自动退 VR / 不回菜单 / 不关浏览器；
//   ② 结算面板只弹一次，杀敌分类 / 最高连击 / 技能释放 / 道具 / 强化都要汇总；
//   ③ 结算后清掉仍在飞的金点与出怪队列，不能在面板上再叠抽卡；
//   ④ 平台结算 CMD 7 的上报入口只发一次，真正退出仍由平台 closeGame 驱动。
import test from 'node:test';
import assert from 'node:assert/strict';

let Game;
try {
  ({ Game } = await import('../src/game/game.js'));
} finally {
  // game.js 会在模块级创建材质/贴图；这里不需要额外替换（与其它 game 测试共用运行器）。
}

test('第九十二修 · 杀敌统计按普通 / 精英 / Boss 分类', () => {
  const g = Object.create(Game.prototype);
  Game.prototype._resetRunStats.call(g);

  Game.prototype._recordRunKill.call(g, { isBoss: false, isElite: false });
  Game.prototype._recordRunKill.call(g, { isBoss: false, isElite: true });
  Game.prototype._recordRunKill.call(g, { isBoss: true, isElite: true });

  assert.deepEqual(g._runStats, { kills: 3, basic: 1, elite: 1, boss: 1 });
});

test('第九十二修 · 结算数据汇总角色、关卡、击杀、技能、道具与强化', () => {
  const g = Object.create(Game.prototype);
  Object.assign(g, {
    player: {
      characterKey: 'plague', hp: 80, maxHp: 100,
      skillDamageMul: 2, skillCost: 30, skillCdDown: 1.5,
    },
    levelIndex: 17,
    score: 123,
    shopCoin: 456,
    _maxCombo: 9,
    _runSkillCasts: 4,
    _runStats: { kills: 12, basic: 7, elite: 4, boss: 1 },
    _itemLv: { dogOwner: 2, warFeed: 1 },
    _collectedCards: ['fireRate', 'fireRate', 'atk', 'buddha'],
    selectedSkill: 'buddha',
  });

  const d = Game.prototype._buildRunSummaryData.call(g, '第18关通关（测试）');
  assert.equal(d.title, '第18关 · 本局结算');
  assert.equal(d.subtitle, '第18关通关（测试）');
  assert.equal(d.kills, 12);
  assert.equal(d.basicKills, 7);
  assert.equal(d.eliteKills, 4);
  assert.equal(d.bossKills, 1);
  assert.equal(d.footer, '本局已结束 · 等待平台关闭游戏');
  assert.ok(d.combatLines.some((x) => x.includes('瘟疫医生')));
  assert.ok(d.combatLines.some((x) => x.includes('18 / 18')));
  assert.ok(d.combatLines.some((x) => x.includes('12 只')));
  assert.ok(d.combatLines.some((x) => x.includes('最高连击  9')));
  assert.ok(d.skillLines.some((x) => x.includes('如来神掌')));
  assert.ok(d.skillLines.some((x) => x.includes('释放次数  4')));
  assert.ok(d.itemLines.some((x) => x.includes('打狗还要看主人  Lv.2')));
  assert.ok(d.itemLines.some((x) => x.includes('以战养战  Lv.1')));
  assert.ok(d.upgradeLines.some((x) => x.includes('射速+50%  ×2')));
  assert.ok(d.upgradeLines.some((x) => x.includes('攻击力+100  ×1')));
});

test('第九十二修 · 结算态冻结战场，只弹一次面板且不自动退出', () => {
  const g = Object.create(Game.prototype);
  const calls = { panel: 0, master: 0, banner: 0, clearExtras: 0, clearPending: 0 };
  Object.assign(g, {
    state: 'playing',
    _roundOver: false,
    _runResultShown: false,
    _runResultPanel: null,
    waves: {
      _winBanner: { dispose() { calls.banner++; } },
      clearPending() { calls.clearPending++; },
    },
    balloons: { clear() {} },
    projectiles: { clear() {} },
    vignette: { clear() {} },
    bullets: { clear() {} },
    damageNumbers: { clear() {} },
    fx: { clear() {} },
    midWarning: { hide() {} },
    player: { forceSingleShot: false },
    input: { reset() {} },
    hud: { clearCountdown() {}, showShopCoin() {}, message() {} },
    audio: { stopAllMedia() {}, stopBGM() {} },
    log() {},
    _clearRoundExtras() { calls.clearExtras++; },
    _buildRunSummaryData() {
      return { kills: 12, basicKills: 7, eliteKills: 4, bossKills: 1 };
    },
    _showRunResultPanel() { calls.panel++; },
    _tellMasterRoundEnd() { calls.master++; },
    toMenu() { throw new Error('结算态不能自动回菜单'); },
    _finishRound() { throw new Error('结算态不能自动退出本局'); },
    _reportGameEnd() { throw new Error('结算态不能上报结束'); },
  });

  Game.prototype._showRunSummary.call(g, '第18关通关（测试）');
  Game.prototype._showRunSummary.call(g, '第18关通关（测试）');

  assert.equal(g.state, 'result');
  assert.equal(g._roundOver, true);
  assert.equal(g._runResultShown, true);
  assert.equal(g.player.forceSingleShot, true);
  assert.equal(calls.panel, 1);
  assert.equal(calls.master, 1);
  assert.equal(calls.banner, 1);
  assert.equal(calls.clearExtras, 1);
  assert.equal(calls.clearPending, 1);
});

test('第九十二修 · 最终 Boss 收尾只进结算，不调用旧的 _finishRound', () => {
  const g = Object.create(Game.prototype);
  let summary = null;
  g._showRunSummary = (why) => { summary = why; };
  g._finishRound = () => { throw new Error('不应自动退出'); };

  Game.prototype._onFinalBossClear.call(g);
  assert.match(summary, /第18关通关/);
});

test('第九十二修 · 平台结算上报 CMD 7 只发一次', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  try {
    const g = Object.create(Game.prototype);
    Object.assign(g, {
      _masterRoundEndSent: false,
      levelIndex: 17,
      score: 777,
    });
    const body = () => JSON.parse(calls[0].opts.body);

    Game.prototype._tellMasterRoundEnd.call(g, '第18关通关');
    Game.prototype._tellMasterRoundEnd.call(g, '第18关通关');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/round/end');
    assert.equal(calls[0].opts.keepalive, true);
    assert.equal(body().lvl, 17);
    assert.equal(body().maxLvl, 18);
    assert.equal(body().score, 777);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
