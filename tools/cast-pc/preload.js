// 暴露一个最小 IPC 接口给 renderer：游戏目录配置（GET/SET）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('castCfg', {
  get: () => ipcRenderer.invoke('cfg:get'),
  set: (patch) => ipcRenderer.invoke('cfg:set', patch || {}),
  // 接收端渲染进程通过此钩子订阅「推流端发来的 JPEG 帧」：主进程收到帧后用 IPC 'cast:frame' 直推，
  // 免去 HTTP 轮询的空帧/重复帧抖动（卡顿根因）。
  onFrame: (cb) => { if (typeof cb === 'function') ipcRenderer.on('cast:frame', (_e, buf) => cb(buf)); },
  // 启动授权（LaunchGuard）：secret / 白名单 / 自动登记 + 实时授权日志
  guardGet: () => ipcRenderer.invoke('guard:get'),
  guardSet: (patch) => ipcRenderer.invoke('guard:set', patch || {}),
  onGuardLog: (cb) => { if (typeof cb === 'function') ipcRenderer.on('guard:log', (_e, entry) => cb(entry)); },
  // 授权（License）：状态快照 / 激活（激活码）/ 手动续期 / 热载 license.json。
  // ⚠ 渲染进程只能「读状态 + 触发动作」，判定逻辑全在 main.js —— 界面改不了门禁结果。
  // 平台参数（文档第 4 条）：界面顶部显示平台带了什么参数（房间号 / 平台 IP / 游戏名）
  platformGet: () => ipcRenderer.invoke('platform:get'),
  // 本局放行（第十八修）：PC 大屏上的「开始本局 / 结束本局」= 平台「开始游戏 / 结束游戏」信号。
  // 头显页面（src/main.js 的主控门禁）每 2 秒问一次 /api/master/allow，只有 armed=true 才给
  // 「进入 VR」按钮 —— 故这个按钮就是现场唯一可靠的开局信号源（平台对我们零「开始」下行）。
  roundGet: () => ipcRenderer.invoke('round:get'),
  roundSet: (patch) => ipcRenderer.invoke('round:set', patch || {}),
  onRoundChanged: (cb) => { if (typeof cb === 'function') ipcRenderer.on('round:changed', (_e, r) => cb(r)); },
  licenseGet: () => ipcRenderer.invoke('license:get'),
  licenseSet: (patch) => ipcRenderer.invoke('license:set', patch || {}),
});
