export class PerformanceMonitor {
  constructor(limit = 600) {
    this.limit = limit;
    this.samples = [];
    this.elapsed = 0;
    this.frames = [];
    this.updateMs = 0;
    this.renderMs = 0;
  }
  record(dt, updateMs, renderMs, info, context = {}) {
    if (!(dt > 0) || dt > 1) return; // exclude background suspension gaps
    this.frames.push(dt * 1000);
    this.elapsed += dt; this.updateMs += updateMs; this.renderMs += renderMs;
    if (this.elapsed < 1) return;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const count = this.frames.length;
    const sample = {
      time: Date.now(), ...context, fps: count / this.elapsed,
      frameP95Ms: sorted[Math.ceil(count * 0.95) - 1], frameMaxMs: sorted.at(-1),
      updateCpuMs: this.updateMs / count, renderCpuMs: this.renderMs / count,
      calls: info.render.calls, triangles: info.render.triangles, textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
    this.samples.push(sample);
    if (this.samples.length > this.limit) this.samples.shift();
    this.frames.length = 0; this.elapsed = this.updateMs = this.renderMs = 0;
    return sample;
  }
  exportData() {
    return { version: 1, note: '帧间隔与 CPU 提交耗时，非 GPU 计时；后台间隔已排除。', samples: this.samples };
  }
}
