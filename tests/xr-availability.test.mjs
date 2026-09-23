import test from 'node:test';
import assert from 'node:assert/strict';
const { watchXRAvailability } = await import('../src/vr/availability.js').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(check) {
  assert.equal(typeof watchXRAvailability, 'function');
  const xr = new EventTarget();
  xr.isSessionSupported = check;
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  documentTarget.hidden = false;
  const button = { disabled: false, textContent: '' };
  let busy = false;
  const watcher = watchXRAvailability({ xr, button, windowTarget, documentTarget, isBusy: () => busy });
  return { xr, windowTarget, documentTarget, button, watcher, setBusy: value => { busy = value; } };
}
test('late device connection restores VR entry without reloading', async () => {
  let supported = false;
  const env = setup(async () => supported);
  await settle();
  assert.equal(env.button.disabled, false);
  assert.match(env.button.textContent, /重试/);
  supported = true;
  env.xr.dispatchEvent(new Event('devicechange'));
  await settle();
  assert.equal(env.button.textContent, '🎈 进入 VR');
});
test('focus and visible page recheck after runtime recovers from an error', async () => {
  let calls = 0;
  const env = setup(async () => { if (++calls === 1) throw new Error('runtime unavailable'); return true; });
  await settle();
  assert.equal(env.button.disabled, false);
  assert.match(env.button.textContent, /重试/);
  env.windowTarget.dispatchEvent(new Event('focus'));
  await settle();
  assert.equal(env.button.textContent, '🎈 进入 VR');
  env.documentTarget.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(calls, 3);
});
test('older detection cannot overwrite a newer device result', async () => {
  let finish;
  let calls = 0;
  const env = setup(() => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(true));
  env.xr.dispatchEvent(new Event('devicechange'));
  await settle();
  finish(false);
  await settle();
  assert.equal(env.button.textContent, '🎈 进入 VR');
});
test('pending detection cannot unlock entry while a session is starting', async () => {
  let finish;
  const env = setup(() => new Promise(resolve => { finish = resolve; }));
  env.setBusy(true);
  env.watcher.invalidate();
  env.button.disabled = true;
  env.button.textContent = '⏳ 启动中...';
  finish(false);
  await settle();
  assert.equal(env.button.disabled, true);
  assert.equal(env.button.textContent, '⏳ 启动中...');
});
test('missing WebXR API gives a distinct disabled state', () => {
  assert.equal(typeof watchXRAvailability, 'function');
  const button = {};
  watchXRAvailability({ xr: undefined, button, windowTarget: new EventTarget(), documentTarget: new EventTarget(), isBusy: () => false });
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /WebXR/);
});
