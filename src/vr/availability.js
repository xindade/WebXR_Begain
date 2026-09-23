// Capability checks must never request a session: entering VR requires a user click.
/**
 * @param {object}  o
 * @param {Element} [o.button]  单按钮（旧形态）
 * @param {Element[]} [o.buttons] 多按钮（第二十二修的「二选一进入 VR」）：只切 disabled，不覆盖各自文案
 * @param {(text:string)=>void} [o.onLabel] 需要提示文案时的出口（多按钮形态用它转到 #status-msg）
 */
export function watchXRAvailability({ xr, button, buttons, windowTarget, documentTarget, isBusy, onLabel }) {
  const list = (buttons && buttons.length) ? buttons : (button ? [button] : []);
  const setDisabled = (v) => { for (const b of list) b.disabled = v; };
  const setLabel = (text) => {
    if (onLabel) { onLabel(text); return; }
    for (const b of list) b.textContent = text;
  };
  let revision = 0;
  function invalidate() { revision++; }
  async function refresh() {
    const current = ++revision;
    if (isBusy()) return;
    if (!xr?.isSessionSupported) {
      setDisabled(true);
      setLabel('WebXR 不可用（需 HTTPS / 支持的浏览器）');
      return;
    }
    let supported = false;
    let failed = false;
    try { supported = await xr.isSessionSupported('immersive-vr'); }
    catch { failed = true; }
    // A previous probe must not overwrite a newer result or an in-flight session.
    if (current !== revision || isBusy()) return;
    setDisabled(false);
    if (onLabel || button) {
      setLabel(supported ? '🎈 进入 VR'
        : failed ? '重试进入 VR（检测失败）' : '重试进入 VR（暂未检测到设备）');
    }
  }
  xr?.addEventListener('devicechange', refresh);
  windowTarget.addEventListener('focus', refresh);
  documentTarget.addEventListener('visibilitychange', () => {
    if (!documentTarget.hidden) refresh();
  });
  refresh();
  return { refresh, invalidate };
}
