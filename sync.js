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
  let lastPushTime = 0;
  let suppress = false;
  let booting = true;
  let remoteTimestamp = 0;

  function collectAll() {
    const out = {};
    SYNC_KEYS.forEach(k => {
      const v = localStorage.getItem(k);
      if (v != null) try { out[k] = JSON.parse(v); } catch(e) { out[k] = v; }
    });
    return out;
  }

  function applyRemote(remote, remoteTs) {
    if (!remote || typeof remote !== 'object') return;
    
    // CONFLICT RESOLUTION: Only apply remote data if it's newer
    if (remoteTs && remoteTs < lastPushTime) {
      console.log('Remote data is older, skipping apply');
      return;
    }
    
    suppress = true;
    let changed = false;
    
    // Update keys that exist in remote
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
    remoteTimestamp = remoteTs || 0;
    
    // IMPORTANT: Only reload if data changed AND not during boot
    if (changed && !booting) {
      console.log('Remote data changed, reloading...');
      window.location.reload();
    }
  }

  async function push() {
    const data = collectAll();
    try {
      const now = Date.now();
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
      if (res.ok) {
        lastPushTime = now;
        console.log('Pushed to Supabase at', new Date().toISOString());
      }
    } catch(e) {
      console.error('Push failed:', e);
    }
  }

  async function pull() {
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/app_state?key=eq.' + APP_KEY + '&select=data,updated_at',
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      if (!res.ok) {
        console.warn('Pull failed with status', res.status);
        return;
      }
      const rows = await res.json();
      if (rows && rows[0] && rows[0].data) {
        const remoteTs = new Date(rows[0].updated_at).getTime();
        console.log('Pulled from Supabase at', rows[0].updated_at);
        applyRemote(rows[0].data, remoteTs);
      }
    } catch(e) {
      console.error('Pull failed:', e);
    }
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
    if (!suppress && SYNC_KEYS.includes(k)) {
      console.log('Local change detected:', k);
      schedulePush();
    }
  };
  localStorage.removeItem = function(k) {
    _del(k);
    if (!suppress && SYNC_KEYS.includes(k)) {
      console.log('Local delete detected:', k);
      schedulePush();
    }
  };

  // Boot: pull remote data eerst
  window.addEventListener('DOMContentLoaded', async () => {
    console.log('Boot: pulling remote data...');
    await pull();
    booting = false;
    // Push lokale data na boot
    setTimeout(() => {
      console.log('Boot: pushing local data...');
      schedulePush();
    }, 500);
  });

  // Sync bij terugkeren naar tab
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      console.log('Tab visible, pulling...');
      pull();
    }
  });
  window.addEventListener('focus', () => {
    console.log('Window focused, pulling...');
    pull();
  });

  // Push bij sluiten
  window.addEventListener('pagehide', () => {
    const data = collectAll();
    console.log('Page closing, final push...');
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
