// 通用对象池：避免运行时频繁创建/销毁（性能优化，知识库明确要求）
export class ObjectPool {
  constructor(createFn, resetFn, size = 20) {
    this._create = createFn;
    this._reset = resetFn;
    this._free = [];
    this._active = [];
    for (let i = 0; i < size; i++) {
      const obj = this._create();
      obj._poolActive = false;
      this._free.push(obj);
    }
  }

  acquire() {
    const obj = this._free.pop() || this._create();
    obj._poolActive = true;
    this._active.push(obj);
    return obj;
  }

  release(obj) {
    const i = this._active.indexOf(obj);
    if (i !== -1) this._active.splice(i, 1);
    obj._poolActive = false;
    if (this._reset) this._reset(obj);
    this._free.push(obj);
  }

  releaseAll() {
    while (this._active.length) this.release(this._active[0]);
  }

  get active() { return this._active; }
  get free() { return this._free; }
}
