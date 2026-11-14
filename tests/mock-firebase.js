// In-page stand-in for the Firebase SDK, loaded by tests/flows.py before the app.
// window.__seed (optional) is the initial database; window.__db exposes state for assertions.
(() => {
  const root = window.__seed || {};
  const listeners = [];
  const state = window.__db = { root, writes: [], failNext: false };
  const get = path => path.split('/').filter(Boolean).reduce((node, key) => (node == null ? null : node[key]), root) ?? null;
  const put = (path, value) => {
    const keys = path.split('/').filter(Boolean);
    const last = keys.pop();
    let node = root;
    for (const key of keys) node = node[key] ??= {};
    if (value === null) delete node[last]; else node[last] = value;
  };
  const snapshot = path => ({ val: () => JSON.parse(JSON.stringify(get(path))), exists: () => get(path) !== null });
  const notify = () => listeners.forEach(l => l.callback(snapshot(l.path)));
  const commit = (path, changes) => {
    if (state.failNext) { state.failNext = false; return Promise.reject(new Error('write failed')); }
    state.writes.push({ path, changes });
    for (const [key, value] of Object.entries(changes)) put(`${path}/${key}`, value);
    notify();
    return Promise.resolve();
  };
  const ref = path => ({
    on(_event, callback) {
      if (path === '.info/connected') { callback({ val: () => true }); return; }
      listeners.push({ path, callback });
      callback(snapshot(path));
    },
    off() { for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].path === path) listeners.splice(i, 1); },
    update: changes => commit(path, changes),
    set: value => commit(path.split('/').slice(0, -1).join('/'), { [path.split('/').pop()]: value })
  });
  window.firebase = { apps: [], initializeApp() { this.apps.push({}); }, database: () => ({ ref }) };
})();
