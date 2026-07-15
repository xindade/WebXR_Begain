// 2D HUD 覆盖层：分数、飞船血量、关卡、准星、提示信息
export class HUD {
  constructor() {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;font-family:sans-serif;color:#fff;z-index:10;';
    document.body.appendChild(this.root);

    this.top = document.createElement('div');
    this.top.style.cssText = 'position:absolute;top:14px;left:16px;font-size:15px;line-height:1.5;text-shadow:0 1px 3px #000;';
    this.root.appendChild(this.top);

    this.hpWrap = document.createElement('div');
    this.hpWrap.style.cssText = 'position:absolute;top:14px;right:16px;width:180px;';
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

    this.startBtn = document.createElement('button');
    this.startBtn.textContent = '开始游戏';
    this.startBtn.style.cssText = 'pointer-events:auto;position:absolute;top:55%;left:50%;transform:translate(-50%,-50%);padding:14px 34px;font-size:20px;border:none;border-radius:12px;background:#ff7675;color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);';
    this.root.appendChild(this.startBtn);
    this.startBtn.onclick = () => this._onStart && this._onStart(0);

    // 测试用：直接跳到第三关（激光气球躲避关）
    this.testBtn = document.createElement('button');
    this.testBtn.textContent = '🎯 第三关（激光）测试';
    this.testBtn.style.cssText = 'pointer-events:auto;position:absolute;top:calc(55% + 50px);left:50%;transform:translateX(-50%);padding:10px 22px;font-size:15px;border:none;border-radius:10px;background:#e17055;color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);';
    this.root.appendChild(this.testBtn);
    this.testBtn.onclick = () => this._onStart && this._onStart(2);
  }

  onStart(cb) { this._onStart = cb; }
  hideStart() { this.startBtn.style.display = 'none'; this.testBtn.style.display = 'none'; }
  showStart() { this.startBtn.style.display = 'block'; this.testBtn.style.display = 'block'; }

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
}
