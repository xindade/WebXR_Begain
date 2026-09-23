const $ = id => document.getElementById(id);
const report = {
  browser: navigator.userAgent, secureContext: isSecureContext, xrAPI: !!navigator.xr,
  stage: '环境检查', frames: 0, poseFrames: 0, nullPoseFrames: 0, renderedFrames: 0,
  views: 0, glErrors: [], events: [],
};
let session, gl, space, layer, timer, starting = false;
function show() { $('report').textContent = JSON.stringify(report, null, 2); }
function event(message) {
  report.events.push({ time: new Date().toISOString(), message });
  if (report.events.length > 60) report.events.shift();
  show();
}
function error(reason) { event(`${reason?.name || 'Error'}: ${reason?.message || reason}`); }
window.addEventListener('error', e => error(e.error || e.message));
window.addEventListener('unhandledrejection', e => error(e.reason));
document.addEventListener('securitypolicyviolation', e => event(`CSP: ${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
$('canvas').addEventListener('webglcontextlost', () => { report.contextLost = true; event('WebGL context lost'); });
async function stop() {
  try { await session?.end(); } catch (e) { error(e); }
}
$('stop').onclick = stop;
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'webxr-diagnostic.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('start').onclick = async () => {
  if (starting || session) return;
  starting = true; $('start').disabled = true; $('api').disabled = true;
  Object.assign(report, { frames: 0, poseFrames: 0, nullPoseFrames: 0, renderedFrames: 0, views: 0, glErrors: [] });
  try {
    report.stage = '创建 WebGL'; report.api = $('api').value; show();
    gl = $('canvas').getContext(report.api, { alpha: false, antialias: false });
    if (!gl) throw new Error(`${report.api} context unavailable`);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    report.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.clearColor(0.03, 0.08, 0.25, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    report.stage = '请求 immersive-vr'; show();
    session = await navigator.xr.requestSession('immersive-vr');
    event('XR session created');
    $('stop').disabled = false;
    session.addEventListener('end', () => {
      session = null; clearInterval(timer); $('stop').disabled = true;
      $('start').disabled = false; report.stage = '会话已结束'; event('XR session ended');
    }, { once: true });
    const visibility = () => { report.visibility = session.visibilityState; event(`visibility=${report.visibility}`); };
    session.addEventListener('visibilitychange', visibility); visibility();
    report.stage = 'makeXRCompatible'; show();
    await gl.makeXRCompatible();
    report.stage = '创建 XRWebGLLayer'; show();
    layer = new XRWebGLLayer(session, gl, { alpha: false, antialias: false, depth: false, stencil: false, framebufferScaleFactor: 0.5 });
    session.updateRenderState({ baseLayer: layer });
    report.framebufferSize = [layer.framebufferWidth, layer.framebufferHeight];
    report.stage = '请求 local 参考空间'; show();
    space = await session.requestReferenceSpace('local');
    report.stage = '等待第一帧'; show();
    timer = setInterval(show, 1000);
    session.requestAnimationFrame(frame);
  } catch (e) {
    error(e); await stop(); $('start').disabled = false;
  } finally { starting = false; }
};
function frame(time, xrFrame) {
  try {
    report.frames++;
    report.stage = 'XR 帧回调运行中';
    report.lastFrameAt = new Date().toISOString();
    report.visibility = xrFrame.session.visibilityState;
    const pose = xrFrame.getViewerPose(space);
    if (!pose) { report.nullPoseFrames++; report.views = 0; }
    else {
      report.poseFrames++; report.views = pose.views.length;
      report.emulatedPosition = pose.emulatedPosition;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.enable(gl.SCISSOR_TEST);
      for (const view of pose.views) {
        const v = layer.getViewport(view);
        gl.viewport(v.x, v.y, v.width, v.height); gl.scissor(v.x, v.y, v.width, v.height);
        gl.clearColor(0.03, 0.08, 0.25, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.scissor(v.x + Math.floor(v.width * 0.35), v.y + Math.floor(v.height * 0.35), Math.floor(v.width * 0.3), Math.floor(v.height * 0.3));
        gl.clearColor(0.05, 0.65, 0.25, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      }
      gl.disable(gl.SCISSOR_TEST);
      const code = gl.getError();
      if (code !== gl.NO_ERROR) {
        if (report.glErrors.length < 20) report.glErrors.push({ frame: report.frames, code: `0x${code.toString(16)}` });
      } else report.renderedFrames++;
    }
    if (report.frames % 90 === 0 || report.frames === 1) show();
    xrFrame.session.requestAnimationFrame(frame);
  } catch (e) { report.stage = '帧回调异常'; error(e); }
}
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then(supported => {
    report.supported = supported; show();
  }).catch(error);
}
show();
