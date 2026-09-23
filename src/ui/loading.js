// Startup UI: only completed work advances progress. Failures require retry or explicit fallback.
export function loadStartup(tasks, timeoutMs = 20000) {
  const overlay = document.getElementById('loading-overlay');
  const text = document.getElementById('loading-text');
  const fill = document.getElementById('loading-bar-fill');
  const actions = document.getElementById('loading-actions');
  return new Promise(resolve => {
    let generation = 0;
    const finish = () => { generation++; overlay.style.display = 'none'; resolve(); };
    const run = async () => {
      const current = ++generation;
      let completed = 0;
      actions.replaceChildren(); fill.style.width = '0%';
      text.textContent = `准备首关资源 0/${tasks.length}`;
      const outcomes = await Promise.all(tasks.map(async ({ name, load }) => {
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(load),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('加载超时')), timeoutMs); }),
          ]);
          if (generation !== current) return null;
          completed++;
          fill.style.width = `${completed / tasks.length * 100}%`;
          text.textContent = `准备首关资源 ${completed}/${tasks.length}`;
          return null;
        } catch (error) { return `${name}：${error.message}`; }
        finally { clearTimeout(timer); }
      }));
      if (generation !== current) return;
      const failures = outcomes.filter(Boolean);
      if (!failures.length) { finish(); return; }
      text.textContent = `部分资源未就绪：${failures.join('；')}`;
      for (const [label, action] of [['重试加载', run], ['使用简化外观继续', finish]]) {
        const button = document.createElement('button');
        button.textContent = label; button.onclick = action; actions.appendChild(button);
      }
    };
    run();
  });
}
