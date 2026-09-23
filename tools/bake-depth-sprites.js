import * as THREE from 'three';
import { ENEMY_TYPES } from '../src/content/enemies.js';
import { DEPTH_SPRITE_TYPES, DEPTH_SPRITE_FRAMES as frames, DEPTH_SPRITE_SWING as swing, FACE_BOSS } from '../src/core/constants.js';
import { captureGLB } from '../src/game/glbCapture.js';
import { loadGLB } from '../src/game/glbCache.js';
const status = document.getElementById('status');
const button = document.getElementById('bake');
const blob = canvas => new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG编码失败')), 'image/png'));
async function save(name, body) {
  const response = await fetch(`/__bake/${name}`, { method: 'POST', body });
  if (!response.ok) throw new Error(`保存 ${name} 失败 ${response.status}，请使用 bake-server.py`);
}
button.onclick = async () => {
  button.disabled = true;
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setSize(512, 512); renderer.toneMapping = THREE.NoToneMapping;
  const entries = new Map();
  for (const id of DEPTH_SPRITE_TYPES) {
    const enemy = ENEMY_TYPES[id];
    const url = id === 'blackMaskClone' ? FACE_BOSS.BLACK_CLONE_MODEL : enemy?.model;
    if (url) entries.set(`${url}:${enemy.radius}:${frames}:${swing}`, { url, radius: enemy.radius });
  }
  const manifest = {};
  try {
    let index = 0;
    for (const [key, { url, radius }] of entries) {
      status.textContent = `生成 ${++index}/${entries.size}：${url}`;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const gltf = await loadGLB(url);
      const sheet = await captureGLB(renderer, gltf.scene, { radius, frames, swing });
      const albedo = `sprite-${index}-albedo.png`, depth = `sprite-${index}-depth.png`;
      try {
        await save(albedo, await blob(sheet.albedo.image));
        await save(depth, await blob(sheet.depth.image));
        manifest[key] = { albedo: `assets/depth-sprites/${albedo}`, depth: `assets/depth-sprites/${depth}`, frameCount: sheet.frameCount, cols: sheet.cols, rows: sheet.rows };
      } finally { sheet.albedo.dispose(); sheet.depth.dispose(); }
    }
    await save('manifest.json', JSON.stringify(manifest, null, 2));
    status.textContent = `完成：已保存 ${entries.size} 套图集和 manifest.json。`;
  } catch (error) { status.textContent = error.stack || error.message; }
  finally { renderer.dispose(); button.disabled = false; }
};
