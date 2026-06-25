// ============================================================
// MAXXING DASHBOARD — Supabase sync
// Werkt samen met localStorage. Bij verandering op een ander
// apparaat herlaadt de pagina automatisch.
// ============================================================
(function () {
  const SUPABASE_URL = 'https://teouxpndvftcswyybfxp.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Ogzh4cjZuJ2RUATM-lsOqA_-R0LzRRW';
  const APP_KEY = 'maxxing-dashboard';

  const SYNC_KEYS = [
    'maxx_checklist_v1',
    'maxx_gym_v1',
    'maxx_measure_v1',
    'po_coach_workout_done',
  ];

  let pushTimer = null;
  let lastJson = null;
  let suppress = false;
  let booting = true;

  function collectAll() {
    const out = {};
    SYNC_KEYS.forEach(k => {
      const v = localStorage.getItem(k);
      if (v != null) try { out[k] = JSON.parse(v); } catch(e) { out[k] = v; }
    });
    return out;
  }

  function applyRemote(remote) {
    if (!remote || typeof remote !== 'object') return;
    suppress = true;
    let changed = false;
    SYNC_KEYS.forEach(k => {
      if (!(k in remote)) return;
      const incoming = JSON.stringify(remote[k]);
      const local = localStorage.getItem(k);
      if (local !== incoming) {
        localStorage.setItem(k, incoming);
        changed = true;
      }
    });
    suppress = false;
    lastJson = JSON.stringify(collectAll());
    // Herlaad de pagina als data veranderd is (alleen na boot, niet tijdens typen)
    if (changed && !booting) {
      window.location.reload();
    }
  }

  async function push() {
    const data = collectAll();
    const json = JSON.stringify(data);
    if (json === lastJson) return;
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/app_state', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([{ key: APP_KEY, data, updated_at: new Date().toISOString() }])
      });
      if (res.ok) lastJson = json;
    } catch(e) {}
  }

  async function pull() {
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/app_state?key=eq.' + APP_KEY + '&select=data',
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (rows && rows[0] && rows[0].data) applyRemote(rows[0].data);
    } catch(e) {}
  }

  function schedulePush() {
    if (suppress) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 800);
  }

  // Hook localStorage
  const _set = localStorage.setItem.bind(localStorage);
  const _del = localStorage.removeItem.bind(localStorage);

  localStorage.setItem = function(k, v) {
    _set(k, v);
    if (!suppress && SYNC_KEYS.includes(k)) schedulePush();
  };
  localStorage.removeItem = function(k) {
    _del(k);
    if (!suppress && SYNC_KEYS.includes(k)) schedulePush();
  };

  // Boot: pull remote data eerst, dan pas pagina laten werken
  window.addEventListener('DOMContentLoaded', async () => {
    await pull();
    booting = false;
    // Push lokale data die mogelijk nieuwer is
    setTimeout(schedulePush, 500);
  });

  // Sync bij terugkeren naar tab
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  window.addEventListener('focus', pull);

  // Push bij sluiten
  window.addEventListener('pagehide', () => {
    const data = collectAll();
    const json = JSON.stringify(data);
    if (json === lastJson) return;
    fetch(SUPABASE_URL + '/rest/v1/app_state', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify([{ key: APP_KEY, data, updated_at: new Date().toISOString() }]),
      keepalive: true
    }).catch(() => {});
  });
})();
