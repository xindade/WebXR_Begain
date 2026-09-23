// BGM 试听页生成器
// 作用：把 src/vr/audio.js 的 BGM 引擎原样内嵌进 index.html，
//       生成一个可双击打开、无需服务器的自包含试听页。
// 用法：node sync.js   （改完 src/vr/audio.js 后跑一次即可同步）
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const SRC = path.resolve(HERE, '../../src/vr/audio.js');
const OUT = path.join(HERE, 'index.html');

// 去掉 ES module 的 export，使其可放进普通 <script>
let code = fs.readFileSync(SRC, 'utf8')
  .replace(/^export\s+class\s+AudioManager/m, 'class AudioManager');
if (/^export\s/m.test(code)) {
  console.warn('⚠ audio.js 中仍存在其它 export 语句，内嵌后可能无法运行');
}

const TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebXR 打气球 · BGM 试听台</title>
<style>
  :root{
    --bg:#f4f5f7; --card:#ffffff; --ink:#1e2430; --ink2:#5b6472; --ink3:#8a93a3;
    --line:#e3e5ea; --brand:#4f46e5; --brand-soft:#eef0ff;
    --laser:#0e8f8f; --laser-soft:#e6f6f6;
    --boss:#c0392b; --boss-soft:#fdeeec;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}
  .wrap{max-width:1120px;margin:0 auto;padding:28px 20px 48px}
  h1{font-size:22px;margin:0 0 6px}
  .sub{margin:0;color:var(--ink2);font-size:13px;line-height:1.7}
  .sub code{background:var(--brand-soft);color:var(--brand);padding:1px 5px;border-radius:4px;font-size:12px}
  .gen{margin:8px 0 0;color:var(--ink3);font-size:12px}

  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;
         padding:16px 18px;margin-top:20px;display:flex;align-items:center;
         gap:22px;flex-wrap:wrap}
  .now{display:flex;align-items:center;gap:8px;min-width:190px;font-size:13px;font-weight:600}
  .dot{width:10px;height:10px;border-radius:50%;background:#c9ccd4;flex:none}
  .dot.on{background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.16)}
  .lights{display:flex;gap:4px}
  .cell{width:18px;height:20px;border-radius:4px;background:#e9ebef;border:1px solid var(--line)}
  .cell.on{background:var(--brand);border-color:var(--brand)}
  .cell.beat{background:#d8dbe2}
  .cell.beat.on{background:var(--brand)}
  .bars{display:flex;gap:5px}
  .bar{font-size:11px;color:var(--ink3);border:1px solid var(--line);border-radius:20px;
       padding:2px 9px;background:#fafbfc}
  .bar.on{background:var(--brand);color:#fff;border-color:var(--brand)}
  .spacer{flex:1}
  .vol{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink2)}
  .vol input{width:120px}
  button{font-family:inherit;cursor:pointer}
  .ghost{background:#fff;border:1px solid var(--line);color:var(--ink2);
         border-radius:8px;padding:7px 14px;font-size:13px}
  .ghost:hover{border-color:#c3c7d0;color:var(--ink)}

  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;
        display:flex;flex-direction:column;gap:12px;border-top:3px solid var(--brand)}
  .card.laser{border-top-color:var(--laser)}
  .card.boss{border-top-color:var(--boss)}
  .ctop{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
  .ctitle{font-size:16px;font-weight:700;margin:0}
  .cbpm{font-size:11px;color:var(--ink3);border:1px solid var(--line);border-radius:20px;
        padding:2px 8px;white-space:nowrap;background:#fafbfc}
  .lv{font-size:12px;color:var(--ink2);margin:0}
  .lv b{color:var(--ink);font-weight:600}
  .desc{font-size:12.5px;color:var(--ink2);line-height:1.75;margin:0}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .lbl{font-size:12px;color:var(--ink3);min-width:52px}
  .chip{border:1px solid var(--line);background:#fff;color:var(--ink2);
        border-radius:20px;padding:5px 12px;font-size:12px}
  .chip.active{background:var(--brand);border-color:var(--brand);color:#fff}
  .card.laser .chip.active{background:var(--laser);border-color:var(--laser)}
  .card.boss .chip.active{background:var(--boss);border-color:var(--boss)}
  .play{background:var(--brand);color:#fff;border:none;border-radius:9px;
        padding:10px 20px;font-size:14px;font-weight:600;width:100%}
  .card.laser .play{background:var(--laser)}
  .card.boss .play{background:var(--boss)}
  .play.playing{background:#fff;color:var(--ink);border:1px solid var(--line)}
  .slider{width:100%}
  .hint{font-size:11.5px;color:var(--ink3);margin:0}
  .foot{margin-top:22px;font-size:12px;color:var(--ink3);line-height:1.8}
  .foot code{background:#eef0f3;padding:1px 5px;border-radius:4px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🎈 WebXR 打气球 · BGM 试听台</h1>
  <p class="sub">三套背景音乐全部由 <code>src/vr/audio.js</code> <b>程序化生成</b>（Web Audio API，零音频文件）。
     本页内嵌的是<b>同一份引擎代码</b>，因此这里的听感 = 游戏里的实际听感。</p>
  <p class="gen">生成时间 __GEN_TIME__ · 音源 src/vr/audio.js · 重新同步：node sync.js</p>

  <section class="panel">
    <div class="now"><span class="dot" id="dot"></span><span id="stateText">未播放</span></div>
    <div class="lights" id="lights"></div>
    <div class="bars" id="bars"></div>
    <span class="spacer"></span>
    <label class="vol">主音量
      <input type="range" id="vol" min="0" max="1" step="0.01" value="0.5">
      <span id="volVal">0.50</span>
    </label>
    <button class="ghost" id="stopAll">停止</button>
  </section>

  <div class="grid" id="grid"></div>

  <p class="foot">
    · <b>切轨</b>在游戏里于小节边界生效并做 0.2s 音量 duck，此处直接点另一张卡的「播放」即可听到同样的过渡。<br>
    · <b>强度</b>对应游戏内的阶段推进：机制关生成期 0.2 → 驱赶期 0.5 → 第九关走格子 1.0（第十五关解谜期回落 0.35）；Boss 关由 <code>game.js</code> 按「Boss 血量损失 / 战斗时长」自动升压，起步 0.45 → 终期 1.0（0.6 加密太鼓与十六分镲、0.8 加不协和尖刺、0.85 末尾太鼓滚奏）。<br>
    · 想调音色/速度/调性，改 <code>src/vr/audio.js</code> 后跑 <code>node sync.js</code> 重新生成本页即可。
  </p>
</div>

<script>
/* ===== 以下为 src/vr/audio.js 原样内嵌（仅去掉 export）===== */
__AUDIO_JS__
/* ===== 内嵌结束 ===== */
</script>

<script>
(function(){
  var am = new AudioManager();
  var cur = null;              // {id, variant}
  var state = {};              // 每轨的 UI 状态

  var TRACKS = [
    {
      id:'normal', cls:'', title:'普通关 · 危机关', bpm:'124 / 116',
      levels:'黄昏 <b>1·4·7·10·13·16</b>　｜　黑夜 <b>2·5·8·11·14·17</b>',
      desc:'木琴琶音 + 弹跳鼓点 + 切分拨弦贝斯，轻快街机风、长时间循环不疲劳。和声 C–Am–F–G（黄昏）/ Am–F–Dm–E（黑夜）；黑夜额外叠一层低音弦垫做夜战压迫感，速度也降为 116。',
      variants:[['dusk','黄昏'],['night','黑夜']],
      presets:null, intensityNote:'普通关不随强度变化（该滑块对它无效）'
    },
    {
      id:'laser', cls:'laser', title:'机制关 · 激光 / 走格子 / 九宫格', bpm:'104',
      levels:'第 <b>3</b> · <b>9</b> · <b>15</b> 关',
      desc:'A 小调 drone（A1）+ 四分时钟脉冲 + 16 分锯齿琶音走 A 小七和弦（谐振低通 = 机械感核心），半小节低频脉冲、第 8 步金属 clank。<b>故意去掉军鼓</b>——强调时机而非战斗。',
      variants:null,
      presets:[['0.2','生成期 0.2'],['0.5','驱赶期 0.5'],['0.35','解谜期 0.35 (L15)'],['1.0','走格子 1.0 (L9)']]
    },
    {
      id:'boss', cls:'boss', title:'Boss 关 · 脸谱 / 龙', bpm:'140',
      levels:'第 <b>6</b> · <b>12</b> · <b>18</b> 关',
      desc:'和声 <b>i–i–bII–V（Dm–Dm–E♭–A）</b>：那不勒斯 E♭ 转暗 + 属和弦卡住不解决。压迫感三件套——<b>十六分固定音型 ostinato</b>（马达式推进）、<b>心跳 sub</b>（每半小节「咚-咚」）、<b>铜管 D–E♭ 半音摩擦 stab</b>；配 12~18Hz 高速颤音弦、每两小节低频坠落、循环末两拍留白。',
      variants:null, sting:true,
      presets:[['0.45','进关起步 0.45'],['0.6','加密太鼓+十六分镲 0.6'],['0.8','不协和尖刺 0.8'],['1.0','终期滚奏 1.0']]
    }
  ];

  function el(tag, cls, html){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(html != null) e.innerHTML = html;
    return e;
  }

  var grid = document.getElementById('grid');

  TRACKS.forEach(function(t){
    state[t.id] = { variant:(t.variants ? t.variants[0][0] : 'dusk'), intensity:0.5 };
    var card = el('div','card ' + t.cls);

    var top = el('div','ctop');
    var left = el('div');
    left.appendChild(el('h2','ctitle', t.title));
    top.appendChild(left);
    top.appendChild(el('span','cbpm','BPM ' + t.bpm));
    card.appendChild(top);

    card.appendChild(el('p','lv', t.levels));
    card.appendChild(el('p','desc', t.desc));

    // 变体切换（仅普通关有 黄昏/黑夜）
    if(t.variants){
      var vr = el('div','row');
      vr.appendChild(el('span','lbl','氛围'));
      var chips = [];
      t.variants.forEach(function(v){
        var c = el('button','chip' + (v[0]===state[t.id].variant ? ' active' : ''), v[1]);
        c.onclick = function(){
          state[t.id].variant = v[0];
          chips.forEach(function(x,i){ x.className = 'chip' + (t.variants[i][0]===v[0] ? ' active' : ''); });
          if(cur && cur.id === t.id && am._playing){
            am.setTrack(t.id, v[0]); cur.variant = v[0];
          }
        };
        chips.push(c); vr.appendChild(c);
      });
      card.appendChild(vr);
    }

    // 强度滑块
    var ir = el('div','row');
    ir.appendChild(el('span','lbl','强度'));
    var sl = document.createElement('input');
    sl.type='range'; sl.min=0; sl.max=1; sl.step=0.05; sl.value=0.5; sl.className='slider';
    var sv = el('span','', '0.50'); sv.style.fontSize='12px'; sv.style.color='#8a93a3';
    sl.oninput = function(){
      sv.textContent = Number(sl.value).toFixed(2);
      state[t.id].intensity = Number(sl.value);
      if(cur && cur.id === t.id) am.setIntensity(Number(sl.value));
    };
    var box = el('div'); box.style.flex='1'; box.appendChild(sl);
    ir.appendChild(box); ir.appendChild(sv);
    card.appendChild(ir);

    if(t.intensityNote) card.appendChild(el('p','hint', t.intensityNote));

    // 阶段预设
    if(t.presets){
      var pr = el('div','row');
      pr.appendChild(el('span','lbl','阶段'));
      t.presets.forEach(function(p){
        var b = el('button','chip', p[1]);
        b.onclick = function(){
          sl.value = p[0]; sv.textContent = Number(p[0]).toFixed(2);
          state[t.id].intensity = Number(p[0]);
          if(cur && cur.id === t.id) am.setIntensity(Number(p[0]));
        };
        pr.appendChild(b);
      });
      card.appendChild(pr);
    }

    // Boss 进场 sting
    if(t.sting){
      var sr = el('div','row');
      sr.appendChild(el('span','lbl','进场'));
      var sb = el('button','chip','▶ 播放 Boss 进场铜锣 (playBossSting)');
      sb.onclick = function(){
        am.unlock();
        if(am.ctx && am.ctx.state === 'suspended') am.ctx.resume();
        applyVol();
        am.playBossSting();
      };
      sr.appendChild(sb);
      card.appendChild(sr);
    }

    // 播放 / 停止
    var play = el('button','play','▶ 播放');
    play.onclick = function(){
      if(cur && cur.id === t.id && am._playing){ stop(); return; }
      am.unlock();
      if(!am.ctx){ alert('当前浏览器不支持 Web Audio'); return; }
      if(am.ctx.state === 'suspended') am.ctx.resume();
      applyVol();
      am.setIntensity(state[t.id].intensity);
      if(am._playing){
        am.setTrack(t.id, state[t.id].variant);
      }else{
        am.track = t.id; am.variant = state[t.id].variant;
        am.startBGM();
      }
      cur = { id:t.id, variant:state[t.id].variant };
      syncButtons();
    };
    card.appendChild(play);
    t._playBtn = play;

    grid.appendChild(card);
  });

  function stop(){
    am.stopBGM(); cur = null; syncButtons();
  }

  function syncButtons(){
    TRACKS.forEach(function(t){
      var on = cur && cur.id === t.id && am._playing;
      t._playBtn.textContent = on ? '■ 停止' : '▶ 播放';
      t._playBtn.className = 'play' + (on ? ' playing' : '');
    });
  }

  function applyVol(){
    if(am.master) am.master.gain.value = Number(document.getElementById('vol').value);
  }

  document.getElementById('stopAll').onclick = stop;
  var vol = document.getElementById('vol');
  vol.oninput = function(){
    document.getElementById('volVal').textContent = Number(vol.value).toFixed(2);
    applyVol();
  };

  // 16 分步进灯 + 4 小节指示
  var lights = document.getElementById('lights');
  var cells = [];
  for(var i=0;i<16;i++){
    var c = el('div','cell' + (i%4===0 ? ' beat' : ''));
    lights.appendChild(c); cells.push(c);
  }
  var bars = document.getElementById('bars');
  var barEls = [];
  for(var b=0;b<4;b++){
    var be = el('span','bar', String(b+1));
    bars.appendChild(be); barEls.push(be);
  }

  var LABEL = { normal:'普通关', laser:'机制关', boss:'Boss 关' };
  function tick(){
    var on = !!am._playing;
    document.getElementById('dot').className = 'dot' + (on ? ' on' : '');
    var txt = '未播放';
    if(on && cur){
      txt = '播放中：' + LABEL[cur.id] +
            (cur.id === 'normal' ? '（' + (cur.variant === 'night' ? '黑夜' : '黄昏') + '）' : '') +
            ' · BPM ' + am._bpm() + ' · 强度 ' + am.intensity.toFixed(2);
    }
    document.getElementById('stateText').textContent = txt;
    var s = on ? (am.step % 16) : -1;
    for(var i=0;i<16;i++) cells[i].className = 'cell' + (i%4===0 ? ' beat' : '') + (i===s ? ' on' : '');
    var bb = on ? Math.floor(am.step/16) : -1;
    for(var j=0;j<4;j++) barEls[j].className = 'bar' + (j===bb ? ' on' : '');
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
</script>
</body>
</html>
`;

const html = TEMPLATE
  .replace('__AUDIO_JS__', () => code)
  .replace('__GEN_TIME__', new Date().toLocaleString('zh-CN', { hour12: false }));

fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成 ' + OUT + '  (' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)');
