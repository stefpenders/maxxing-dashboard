// ============================================================
// MAXXING DASHBOARD — Supabase sync
// Werkt samen met localStorage. Bij verandering op een ander
// apparaat herlaadt de pagina automatisch.
// ============================================================
(function () {
  const SUPABASE_URL = 'https://teouxpndvftcswyybfxp.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_Ogzh4cjZuJ2RUATM-lsOqA_-R0LzRRW';

  // Stef zelf (geen login) blijft altijd op deze vaste sleutel — zijn data
  // verandert hierdoor niet. Is er een vriend ingelogd (via login.html), dan
  // krijgt die zijn eigen aparte rij in dezelfde Supabase-tabel.
  function currentAppKey() {
    const u = localStorage.getItem('maxx_active_user');
    return u ? ('friend_' + u) : 'maxxing-dashboard';
  }

  const SYNC_KEYS = [
    'maxx_checklist_v1',
    'maxx_gym_v1',
    'maxx_measure_v1',
    'maxx_timetracker_v1',
    'po_coach_workout_done',
  ];

  let pushTimer = null;
  let lastJson = null;
  let suppress = false;
  let booting = true;
  let dirty = false; // true = er zijn lokale wijzigingen die nog niet bevestigd zijn weggeschreven

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
    if (dirty) return; // nooit onopgeslagen lokale wijzigingen overschrijven
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
    if (json === lastJson) { dirty = false; return; }
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/app_state', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([{ key: currentAppKey(), data, updated_at: new Date().toISOString() }]),
        keepalive: true
      });
      if (res.ok) { lastJson = json; dirty = false; }
    } catch(e) {}
  }

  // Directe, betrouwbare save — gebruikt bij backgrounding/sluiten (keepalive blijft
  // doorlopen ook als de pagina meteen daarna verdwijnt).
  function flush() {
    clearTimeout(pushTimer);
    const data = collectAll();
    const json = JSON.stringify(data);
    if (json === lastJson) { dirty = false; return; }
    fetch(SUPABASE_URL + '/rest/v1/app_state', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify([{ key: currentAppKey(), data, updated_at: new Date().toISOString() }]),
      keepalive: true
    }).then(res => { if (res && res.ok) { lastJson = json; dirty = false; } }).catch(() => {});
  }

  async function pull() {
    try {
      const res = await fetch(
        SUPABASE_URL + '/rest/v1/app_state?key=eq.' + currentAppKey() + '&select=data',
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
      );
      if (!res.ok) return;
      const rows = await res.json();
      if (rows && rows[0] && rows[0].data) applyRemote(rows[0].data);
    } catch(e) {}
  }

  function schedulePush() {
    if (suppress) return;
    dirty = true;
    clearTimeout(pushTimer);
    // Geen wachttijd meer: verzenden begint meteen. Dit is cruciaal op mobiel,
    // waar het scherm/app binnen een fractie van een seconde kan bevriezen.
    push();
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

  // Sync bij terugkeren naar tab / weggaan van tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Scherm uit / andere app / tab sluiten — sla nu meteen betrouwbaar op
      flush();
    } else {
      // Terug in beeld — eerst eigen wijzigingen wegschrijven, dan pas ophalen
      if (dirty) { push().then(pull); } else { pull(); }
    }
  });
  window.addEventListener('focus', () => { if (dirty) { push().then(pull); } else { pull(); } });

  // Push bij sluiten/navigeren weg
  window.addEventListener('pagehide', flush);
})();
