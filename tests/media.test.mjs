import test from 'node:test';
import assert from 'node:assert/strict';
import { IntroVideo } from '../src/game/introVideo.js';
import { AudioManager } from '../src/vr/audio.js';

test('pausing pending video playback does not trigger autoplay retry', async () => {
  const previous = globalThis.window; globalThis.window = new EventTarget();
  let calls = 0;
  const video = new EventTarget();
  video.readyState = 0;
  video.play = () => { calls++; return Promise.reject(Object.assign(new Error('paused'), { name: 'AbortError' })); };
  const intro = Object.create(IntroVideo.prototype);
  Object.assign(intro, { _video: video, _audio: { paused: true }, _say() {}, _onEnded() {}, _onError() {}, _onPlaying() {}, _onMeta() {}, _finish() {} });
  try {
    intro.start(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  } finally { globalThis.window = previous; }
});

test('leaving a paused level cannot resume its discarded voice', () => {
  const audio = new AudioManager();
  const voice = new EventTarget(); let played = 0;
  Object.assign(voice, { paused: false, ended: false, pause() { this.paused = true; }, play() { played++; return Promise.resolve(); } });
  audio.registerMedia(voice); audio.setPaused(true);
  assert.equal(typeof audio.stopAllMedia, 'function');
  audio.stopAllMedia(); audio.setPaused(false);
  assert.equal(played, 0); assert.equal(audio._media.size, 0);
});
