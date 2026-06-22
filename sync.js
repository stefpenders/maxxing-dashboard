// ============================================================
// MAXXING DASHBOARD — Supabase sync
// Synchroniseert localStorage automatisch tussen apparaten.
// Elke pagina gebruikt zijn eigen sleutel in de app_state tabel.
// ============================================================
(function () {
  const SUPABASE_URL = 'https://teouxpndvftcswyybfxp.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Ogzh4cjZuJ2RUATM-lsOqA_-R0LzRRW';

  // Keys die gesynchroniseerd worden per pagina
  const SYNC_KEYS = [
    'maxx_checklist_v1',
    'maxx_gym_v1',
    'maxx_measure_v1',
    'po_coach_workout_done',
  ];

  let pushTimer = null;
  let lastSyncedJson = {};
  let suppress = false;

  // ---------- API helpers ----------
  async function supaFetch(method, body) {
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/app_state', {
        method,
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal'
        },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.ok;
    } catch (e) { return false; }
  }

  async function supaGet(key) {
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/app_state?key=eq.' + encodeURIComponent(key) + '&select=data',
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY
          }
        }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      return rows && rows[0] ? rows[0].data : null;
    } catch (e) { return null; }
  }

  // ---------- Push local → Supabase ----------
  function collectState() {
    const out = {};
    SYNC_KEYS.forEach(k => {
      const v = localStorage.getItem(k);
      if (v != null) {
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
    });
    return out;
  }

  async function pushNow() {
    const state = collectState();
    const json = JSON.stringify(state);
    if (json === lastSyncedJson['__all']) return;
    const ok = await supaFetch('POST', [{ key: 'maxxing-dashboard', data: state, updated_at: new Date().toISOString() }]);
    if (ok) lastSyncedJson['__all'] = json;
  }

  function schedulePush() {
    if (suppress) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 500);
  }

  // ---------- Pull Supabase → local ----------
  async function pullAndApply() {
    const remote = await supaGet('maxxing-dashboard');
    if (!remote || typeof remote !== 'object') return;
    suppress = true;
    let changed = false;
    SYNC_KEYS.forEach(k => {
      if (k in remote) {
        const incoming = JSON.stringify(remote[k]);
        const local = localStorage.getItem(k);
        if (local !== incoming) {
          localStorage.setItem(k, incoming);
          changed = true;
        }
      }
    });
    suppress = false;
    lastSyncedJson['__all'] = JSON.stringify(collectState());
    if (changed) {
      // Re-render the page if it has a render/renderAll function
      setTimeout(() => {
        if (typeof renderAll === 'function') renderAll();
        else if (typeof render === 'function') render();
      }, 50);
    }
  }

  // ---------- Hook into localStorage ----------
  const _origSet = localStorage.setItem.bind(localStorage);
  const _origRemove = localStorage.removeItem.bind(localStorage);

  localStorage.setItem = function (k, v) {
    _origSet(k, v);
    if (!suppress && SYNC_KEYS.includes(k)) schedulePush();
  };
  localStorage.removeItem = function (k) {
    _origRemove(k);
    if (!suppress && SYNC_KEYS.includes(k)) schedulePush();
  };

  // ---------- Boot ----------
  // Pull on load, then push any local changes that are newer
  window.addEventListener('DOMContentLoaded', async () => {
    await pullAndApply();
    schedulePush();
  });

  // Pull when switching back to this tab
  window.addEventListener('focus', pullAndApply);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pullAndApply();
  });

  // Push on close
  window.addEventListener('pagehide', () => {
    const state = collectState();
    const json = JSON.stringify(state);
    if (json === lastSyncedJson['__all']) return;
    fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify([{ key: 'maxxing-dashboard', data: state, updated_at: new Date().toISOString() }]),
      keepalive: true
    }).catch(() => {});
  });

  console.log('[Maxxing] Sync actief — verbonden met Supabase');
})();
