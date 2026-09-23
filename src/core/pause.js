export class PauseState {
  constructor(onChange = () => {}) { this.reasons = new Set(); this.onChange = onChange; }
  get paused() { return this.reasons.size > 0; }
  add(reason) { const before = this.paused; this.reasons.add(reason); if (before !== this.paused) this.onChange(this.paused); }
  remove(reason) { const before = this.paused; this.reasons.delete(reason); if (before !== this.paused) this.onChange(this.paused); }
  clear() { const before = this.paused; this.reasons.clear(); if (before) this.onChange(false); }
}
