// Capability checks must never request a session: entering VR requires a user click.
export function watchXRAvailability({ xr, button, windowTarget, documentTarget, isBusy }) {
  let revision = 0;
  function invalidate() { revision++; }
  async function refresh() {
    const current = ++revision;
    if (isBusy()) return;
    if (!xr?.isSessionSupported) {
      button.disabled = true;
      button.textContent = 'WebXR 不可用（需 HTTPS / 支持的浏览器）';
      return;
    }
    let supported = false;
    let failed = false;
    try { supported = await xr.isSessionSupported('immersive-vr'); }
    catch { failed = true; }
    // A previous probe must not overwrite a newer result or an in-flight session.
    if (current !== revision || isBusy()) return;
    button.disabled = false;
    button.textContent = supported ? '🎈 进入 VR'
      : failed ? '重试进入 VR（检测失败）' : '重试进入 VR（暂未检测到设备）';
  }
  xr?.addEventListener('devicechange', refresh);
  windowTarget.addEventListener('focus', refresh);
  documentTarget.addEventListener('visibilitychange', () => {
    if (!documentTarget.hidden) refresh();
  });
  refresh();
  return { refresh, invalidate };
}
