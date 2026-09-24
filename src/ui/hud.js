// 2D HUD 覆盖层：分数、飞船血量、关卡、准星、提示信息
// ★ devUI=false（正式包）时不创建桌面「开始游戏」按钮 —— 见构造函数里的说明与
//   src/core/constants.js 的 RELEASE_UI。
export class HUD {
  constructor({ devUI = true } = {}) {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;font-family:sans-serif;color:#fff;z-index:10;';
    document.body.appendChild(this.root);

    this.top = document.createElement('div');
    this.top.style.cssText = 'position:absolute;top:14px;left:16px;font-size:15px;line-height:1.5;text-shadow:0 1px 3px #000;';
    this.root.appendChild(this.top);

    this.hpWrap = document.createElement('div');
    // ★ 第二十三修（2026-09-23）：给这条 2D 船血条一个 id，好让正式包用 CSS 隐藏它
    //   （用户实测：头显 2D 页面上它就是右上角那条绿色长条。VR 里船血看左手腕面板，见 vr/wrist-ui.js）。
    this.hpWrap.id = 'hud-hp';
    this.hpWrap.style.cssText = 'position:absolute;top:78px;right:145px;width:140px;';
    this.root.appendChild(this.hpWrap);
    this.hpBar = document.createElement('div');
    this.hpBar.style.cssText = 'height:16px;background:#2ecc71;border-radius:8px;transition:width .2s,background .2s;box-shadow:0 0 6px #000;';
    this.hpWrap.appendChild(this.hpBar);
    this.hpText = document.createElement('div');
    this.hpText.style.cssText = 'text-align:right;font-size:12px;margin-top:2px;text-shadow:0 1px 3px #000;';
    this.hpWrap.appendChild(this.hpText);

    this.cross = document.createElement('div');
    this.cross.style.cssText = 'position:absolute;top:50%;left:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 4px #000;';
    this.root.appendChild(this.cross);

    this.msg = document.createElement('div');
    this.msg.style.cssText = 'position:absolute;top:42%;left:0;right:0;text-align:center;';
    this.root.appendChild(this.msg);

    // ★ 桌面「开始游戏」按钮（PC 预览模式入口）：**只在调试包创建**。
    //   正式包已去掉（2026-09-23 需求：「进入 VR 按钮上面的开始游戏的 PC 模式也要去掉了」）——
    //   开局只能由平台/主控端驱动（「进入 VR」按钮的门禁见 src/main.js）。
    if (devUI) {
      this.startBtn = document.createElement('button');
      this.startBtn.textContent = '开始游戏';
      this.startBtn.style.cssText = 'pointer-events:auto;position:absolute;top:55%;left:50%;transform:translate(-50%,-50%);padding:14px 34px;font-size:20px;border:none;border-radius:12px;background:#ff7675;color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);';
      this.root.appendChild(this.startBtn);
      this.startBtn.onclick = () => this._onStart && this._onStart(0);
    }

    // 倒计时横幅（第十五关 180s 用，平时隐藏）
    this.timer = document.createElement('div');
    this.timer.style.cssText = 'position:absolute;top:110px;left:16px;font-size:18px;font-weight:bold;text-shadow:0 2px 6px #000;display:none;';
    this.root.appendChild(this.timer);

    // 选中技能 + 冷却（第三关选卡后装备，右手握柄触发）
    this.skill = document.createElement('div');
    this.skill.style.cssText = 'position:absolute;top:74px;left:16px;font-size:14px;line-height:1.5;text-shadow:0 1px 3px #000;';
    this.root.appendChild(this.skill);
  }

  onStart(cb) { this._onStart = cb; }
  hideStart() { if (this.startBtn) this.startBtn.style.display = 'none'; }
  showStart() { if (this.startBtn) this.startBtn.style.display = 'block'; }

  setLevel(text) { this._level = text; this._renderTop(); }
  setScore(s) { this._score = s; this._renderTop(); }
  _renderTop() {
    this.top.innerHTML = `${this._level || ''}<br>分数 ${this._score || 0}`;
  }

  setHp(cur, max) {
    const k = Math.max(0, cur / max);
    this.hpBar.style.width = (k * 100) + '%';
    this.hpBar.style.background = k > 0.5 ? '#2ecc71' : k > 0.25 ? '#f1c40f' : '#e74c3c';
    this.hpText.textContent = `船血 ${Math.ceil(cur)}/${max}`;
  }

  message(title, sub = '', color = '#fff') {
    this.msg.innerHTML = `<div style="font-size:30px;font-weight:bold;text-shadow:0 2px 6px #000;color:${color}">${title}</div>` +
      (sub ? `<div style="font-size:16px;margin-top:8px;text-shadow:0 1px 3px #000;opacity:.9">${sub}</div>` : '');
  }
  clearMessage() { this.msg.innerHTML = ''; }

  // 倒计时横幅（第十五关 180s）
  setCountdown(sec) {
    this.timer.style.display = 'block';
    this.timer.textContent = `⏱ ${sec}s`;
    this.timer.style.color = sec <= 10 ? '#e74c3c' : '#fff';
  }
  clearCountdown() { this.timer.style.display = 'none'; this.timer.textContent = ''; }

  // 选中技能与冷却显示：name 为技能中文名（null 表示未装备），remain/total 为冷却剩余/总时长
  setSkill(name = null, remain = 0, total = 0) {
    if (!name) { this.skill.textContent = '技能：无'; return; }
    const bar = total > 0 ? ` ⏳ ${remain.toFixed(1)}/${total}s` : '';
    this.skill.textContent = `技能：${name}${bar}`;
  }
}
