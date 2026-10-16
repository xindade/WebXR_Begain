// ============================================================
// 第六十修 · 教学关运行态（第 1 关；脚本数据见 content/tutorial.js）
//
// 与 waves 的关系：教学关里 waves 只负责「光点飞入 + 落地生成」这条既有管线
//   （game/tutorial.js 调 waves._queueSpawn / waves._spawnPos），
//   **不出脚本怪、不开滴流、没有倒计时**（见 waves.startLevel / waves._stopAt 的 isTutorialLevel 分支）。
//
// 推进方式：每段（stage）在 _enter 里做「出怪 + 横幅」，然后按用户稿的判据往下走 ——
//   · first / seed：场上这批怪清空 **或** 超时（超时则残兵原地消失，稿子里写明「敌人全部消失」）
//   · card        ：横幅2 收掉后弹**单张**教学卡，卡被打破（或 12s 自动获得）后继续
//   · elite       ：内圈精英被打死（或自爆结束）后继续，无超时
//   · done        ：横幅6 收掉 + CARD_DELAY 秒后，交回 game._finishTutorial() 走正常三选一
//
// 横幅排队：全场只有一块 Sprite（warningBanner），所以这里不直接 show ——
//   先入队，等上一块自己收掉再弹，避免「横幅2 把横幅1 顶掉」。
// ============================================================

import { TUTORIAL, TUT_DIR_DEG, tutorialSpawnPlan, tutorialTimeout, tutorialWaitsKill, eliteHoldOver } from '../content/tutorial.js';
import { ENEMY_TYPES } from '../content/enemies.js';

export class TutorialRunner {
  constructor(game) {
    this.g = game;
    this.active = true;
    this.index = -1;          // -1 = 还在等关卡名字横幅
    this.t = 0;               // 本段已进行秒数
    this.wave = 0;            // 本段怪的批次号（打在气球上，用来数「这批还剩几只」）
    this.cardDone = false;    // 教学卡是否已经拿走
    this.done = false;        // 教学流程是否走完（已交回 game）
    this._waited = 0;
    this._queued = null;      // 待弹横幅（等上一块收掉）
    this._hintAt = -1;
    this._cardOpened = false;
    // 第六十二修 · 精英暂停移动（现场「玩家来不及思考，精英已经撞上场地了」）
    this._elite = null;          // 当前冻着的精英（Balloon 实例）
    this._holdT = 0;             // 已经冻了多少秒
    this._castsAtHold = 0;       // 冻住那一刻的技能释放计数（game._skillCasts）
  }

  // ---- 对外接口（game 调用）----
  onCardDone() { this.cardDone = true; }

  update(dt) {
    if (!this.active || this.done) return;

    // ① 等「关卡名字显示完」：稿子第 0 条的前提。名字横幅与后面的提示共用一块 Sprite，
    //    所以还要等它自己收掉；没开标题卡时用 TITLE_WAIT 兜底，绝不软锁。
    if (this.index < 0) {
      this._waited += dt;
      if (!(this.g._levelTitleDone || this._waited >= TUTORIAL.TITLE_WAIT)) return;
      if (this._bannerBusy()) return;
      this._enter(0);
      return;
    }

    this._flushBanner();
    this.t += dt;
    const stage = TUTORIAL.STAGES[this.index];

    // ② 单卡段：等横幅2 收掉再弹卡（同一块 Sprite 会压住卡面）
    if (stage === 'card' && !this._cardOpened) {
      if (this._queued || this._bannerBusy()) return;
      this._cardOpened = true;
      this.g._enterTutorialCard();
      return;
    }

    // ③ 精英段：横幅「前方精英来袭」收掉后再提示用散射（全场只有一块 Sprite，不能重叠）
    if (stage === 'elite' && this._hintAt > 0 && this.t >= this._hintAt) {
      this._hintAt = -1;
      this._queueBanner(TUTORIAL.BANNER.SKILL);
    }

    // ③b 精英段：出现后**先暂停移动**，等玩家读完提示再放它走（第六十二修 · 现场）
    //     解除判据见 eliteHoldOver()：玩家放过技能（教学段只有散射能秒它）或等够 HOLD_SECONDS。
    //     ⚠ 被普通子弹打中**不算**解除 —— 那正是要教的反例（4000 HP 打不完），
    //       玩家一边试枪一边看提示是对的，精英该继续等着让他试。
    if (stage === 'elite' && this._elite) {
      if (!this._elite.alive) {
        this._elite = null;                       // 已经被秒了，不用再管
      } else if (this._elite.moveFrozen) {
        this._holdT += dt;
        const used = (this.g._skillCasts || 0) > this._castsAtHold;
        if (eliteHoldOver(this._holdT, used)) {
          this._elite.moveFrozen = false;
          this.g.log && this.g.log('[教学] 精英解除暂停（' + (used ? '玩家已放技能' : '等够 ' + this._holdT.toFixed(1) + 's') + '）→ 开始飘向玩家');
        }
      }
    }

    // ④ 各段的推进判据
    const alive = this._aliveOf(this.wave);
    const limit = tutorialTimeout(stage);
    const timedOut = limit > 0 && this.t >= limit;
    let advance = false;
    if (stage === 'card') advance = this.cardDone;
    else if (tutorialWaitsKill(stage)) advance = alive === 0 || timedOut;
    else if (stage === 'done') {
      advance = this.t >= TUTORIAL.DONE.CARD_DELAY && !this._queued && !this._bannerBusy();
    }
    if (!advance) return;

    // ⑤ 超时推进 → 残兵原地消失（稿子：横幅1 后超过 10 秒则「敌人全部消失」）
    if (timedOut && tutorialWaitsKill(stage)) {
      const n = this._clearWave(this.wave);
      this.g.log && this.g.log('[教学] ' + stage + ' 段超时 ' + limit + 's → 残兵 ' + n + ' 只消失');
    }
    this._enter(this.index + 1);
  }

  // ---- 内部 ----
  _enter(i) {
    this.index = i;
    this.t = 0;
    this._hintAt = -1;
    this.cardDone = false;
    this._cardOpened = false;
    this._elite = null;          // 第六十二修：换段就丢掉上一段的精英暂停状态
    this._holdT = 0;
    if (i >= TUTORIAL.STAGES.length) { this._finish(); return; }
    const stage = TUTORIAL.STAGES[i];
    switch (stage) {
      case 'first':
        this._spawn('first');
        this._queueBanner(TUTORIAL.BANNER.KILL);
        break;
      case 'card':
        this._queueBanner(TUTORIAL.BANNER.CARD);
        break;
      case 'seed':
        this._seedStreak();
        this._spawn('seed');
        this._queueBanner(TUTORIAL.BANNER.RAPID);
        break;
      case 'elite':
        // 「精英出现后散射技能无消耗、无冷却，直到精英被杀死」→ 进段即生效（稿子第 5 条）
        this._freeSkill(true);
        this._queueBanner(TUTORIAL.BANNER.ELITE);
        this._spawnElite();
        this._hintAt = TUTORIAL.ELITE.HINT_DELAY;   // 等「前方精英来袭」播完(2s)再提示用技能
        break;
      case 'done':
        this._freeSkill(false);
        this._queueBanner(TUTORIAL.BANNER.DONE);
        break;
    }
  }

  /** 按段落计划出杂鱼（each 一只一批：同一个 wave 号，便于整段一起数/一起清） */
  _spawn(stage) {
    const plan = tutorialSpawnPlan(stage);
    if (!plan.length) return;
    const wave = ++this.wave;
    for (const item of plan) {
      const cfg = item.cfg;
      const radius = (ENEMY_TYPES[item.type] && ENEMY_TYPES[item.type].radius) || 0.5;
      const pos = this.g.waves._spawnPos(radius, {
        dist: cfg.DIST, spread: cfg.SPREAD, centerDeg: TUT_DIR_DEG[item.dir] || 0,
      });
      this.g.waves._queueSpawn(item.type, pos, {
        onSpawn: (b) => { b.tutorialWave = wave; },
      });
    }
    this.g.log && this.g.log('[教学] ' + stage + ' 段：' + plan.map((p) => p.type + '@' + p.dir).join(' + '));
  }

  /** 内圈精英（铁甲兵 Boss 档）：血量/速度/体型全部走 TUTORIAL.ELITE，不套末尾精英的 DPS 公式 */
  _spawnElite() {
    const E = TUTORIAL.ELITE;
    const t = ENEMY_TYPES[E.TYPE];
    const radius = (t && t.radius) || 0.5;
    const wave = ++this.wave;
    const pos = this.g.waves._spawnPos(radius * E.SIZE_MUL, { dist: E.DIST, spread: E.SPREAD, centerDeg: 0 });
    this.g.waves._queueSpawn(E.TYPE, pos, {
      balloon: { isElite: true, hp: E.HP, sizeMul: E.SIZE_MUL, speed: E.SPEED, climax: true },
      onSpawn: (b) => {
        b.tutorialWave = wave;
        b.selfDamage = E.SELF_DAMAGE;
        // 第六十二修：落地就**冻在原地**（HOLD_SECONDS <= 0 等于不冻 = 旧行为）
        b.moveFrozen = E.HOLD_SECONDS > 0;
        this._elite = b;
        this._holdT = 0;
        this._castsAtHold = this.g._skillCasts || 0;
      },
    });
    this.g.log && this.g.log('[教学] 精英段：' + E.TYPE + ' hp=' + E.HP + ' 内圈 ' + E.DIST + 'm');
  }

  /** 把连杀数种到 8：再杀 2 只（RAPID_FIRE.KILLS=10）就触发一次射速加倍 */
  _seedStreak() {
    const g = this.g;
    g._bulletStreak = TUTORIAL.SEED.STREAK;
    g._bulletStreakAt = g._gameTime;   // 时间戳必须刷新：否则 _tickRapidFire 会按断连清零
    g._rapidUntil = 0;
    g._setRapidMul(1);
    g.log && g.log('[教学] 连杀数种到 ' + TUTORIAL.SEED.STREAK + '（再杀 2 只 → 射速加倍）');
  }

  /** 教学期的散射技能免费（无消耗 / 无冷却）：只影响本局这一小段，由 game 读取 */
  _freeSkill(on) {
    this.g._tutorialFreeSkill = !!on;
    this.g.log && this.g.log('[教学] 散射技能免费：' + (on ? '开' : '关'));
  }

  /** 教学关自己会出的敌种（认领「还在飞的光点」与清残兵都用它，不误伤别的系统） */
  _mineTypes() {
    if (!this._mine) {
      this._mine = new Set([...tutorialSpawnPlan('first'), ...tutorialSpawnPlan('seed')].map((p) => p.type));
      this._mine.add(TUTORIAL.ELITE.TYPE);
    }
    return this._mine;
  }

  /**
   * 本批还活着几只。
   * 光点飞在半空的那几只也要算 —— tutorialWave 是落地才挂上的，
   * 否则「出怪那一帧」场上还是空的，会立刻被判「已清空」，横幅1 直接被横幅2 顶掉。
   */
  _aliveOf(wave) {
    let n = 0;
    for (const b of this.g.balloons.list) if (b.alive && b.tutorialWave === wave) n++;
    const mine = this._mineTypes();
    for (const it of this.g.waves._pendingSpawns || []) if (it && mine.has(it.type)) n++;
    return n;
  }

  /** 本批残兵原地消失（不结算能量）：场上的清掉，还在飞的光点撤掉 */
  _clearWave(wave) {
    const list = this.g.balloons.list;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b.alive && b.tutorialWave === wave) { this.g.balloons.remove(b); n++; }
    }
    const mine = this._mineTypes();
    const keep = [];
    for (const it of this.g.waves._pendingSpawns || []) {
      if (it && mine.has(it.type)) { if (it.mesh) this.g.waves._removeBeam(it.mesh); continue; }
      keep.push(it);
    }
    this.g.waves._pendingSpawns.length = 0;
    for (const it of keep) this.g.waves._pendingSpawns.push(it);
    return n;
  }

  _finish() {
    this.done = true;
    this._freeSkill(false);
    this.g._hideTutorialHint && this.g._hideTutorialHint();   // 第六十二修：出教学关就收起常驻提示板
    this.g.log && this.g.log('[教学] 教学关流程结束 → 正常三选一');
    this.g._finishTutorial();
  }

  _bannerBusy() {
    const m = this.g.midWarning;
    return !!(m && m.showing);
  }

  _queueBanner(text) {
    if (!text) return;
    this._queued = text;
    this._flushBanner();
  }

  _flushBanner() {
    if (!this._queued || this._bannerBusy()) return;
    const text = this._queued;
    this._queued = null;
    this.g._showBanner(text);
    // 第六十二修：同一句文案也钉到「场地前上方」的常驻提示板上 —— 一次性横幅 2s 太短来不及读，
    //   板上一直留着，直到下一块横幅把它换掉（现场口径）。
    this.g._showTutorialHint && this.g._showTutorialHint(text);
  }
}
