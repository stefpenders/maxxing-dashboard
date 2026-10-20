// ============================================================
// MAXXING DASHBOARD — Supabase sync
// Werkt samen met localStorage. Bij verandering op een ander
// apparaat herlaadt de pagina automatisch.
//
// Bij het openen is de remote rij de bron van waarheid.
// Pagina-scripts schrijven tijdens hun eigen init al naar
// localStorage (checklist maakt de dag van vandaag aan, gym
// normaliseert de sessie) vóór de async pull terug is. Die
// writes mogen niet pushen tot de remote rij toegepast is,
// anders overschrijft een oude lokale kopie nieuwere data.
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
  // Tot de eerste pull klaar is mag niets naar Supabase. Boot-writes
  // landen wel in localStorage, maar zetten dirty niet en pushen niet.
  let hydrating = true;
  let dirty = false; // true = er zijn lokale wijzigingen die nog niet bevestigd zijn weggeschreven
  // False tot deze load een remote rij heeft kunnen lezen. Zolang de
  // fetch mislukt is, mogen boot-writes en pagehide de rij niet alsnog
  // overschrijven. Echte edits ná de boot syncen wel local-first.
  let remoteReadable = false;
  // True tot vlak na window.load, zodat init-writes (ensureDate,
  // snapshotToday, gym-normalisatie) geen gebruikersedit zijn.
  let bootPhase = true;
  // Gezet bij een echte gebruikersedit ná de boot. Blijft staan als de
  // push niet bevestigd is, zodat een latere open die edits niet weggooit.
  const UNSYNCED_PREFIX = 'maxx_sync_unsynced:';

  // Ruwe localStorage-methodes, vóór we setItem/removeItem hooken.
  const _set = localStorage.setItem.bind(localStorage);
  const _del = localStorage.removeItem.bind(localStorage);

  function unsyncedStorageKey() {
    return UNSYNCED_PREFIX + currentAppKey();
  }
  function markUnsynced() {
    try { _set(unsyncedStorageKey(), '1'); } catch (e) {}
  }
  function clearUnsynced() {
    try { _del(unsyncedStorageKey()); } catch (e) {}
  }
  function hasUnsynced() {
    try { return localStorage.getItem(unsyncedStorageKey()) === '1'; } catch (e) { return false; }
  }

  function reloadFlag() {
    let path = '';
    try { path = location.pathname || ''; } catch (e) {}
    return 'maxx_sync_reload:' + path;
  }
  function reloadFlagGet() {
    try { return sessionStorage.getItem(reloadFlag()); } catch (e) { return null; }
  }
  function reloadFlagSet(v) {
    try {
      if (v == null) sessionStorage.removeItem(reloadFlag());
      else sessionStorage.setItem(reloadFlag(), v);
    } catch (e) {}
  }

  function collectAll() {
    const out = {};
    SYNC_KEYS.forEach(k => {
      const v = localStorage.getItem(k);
      if (v != null) try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
    });
    return out;
  }

  // Snapshot van vóór page-scripts draaien. Boot-writes daarna
  // horen niet bij de vergelijking met de remote rij.
  const initialData = collectAll();
  // De remote (of de initiele lokale) snapshot waar de huidige
  // localStorage tegen afgezet wordt na de pull.
  let syncedSnapshot = initialData;

  function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      const out = {};
      Object.keys(v).sort().forEach(k => {
        if (typeof v[k] !== 'undefined') out[k] = stable(v[k]);
      });
      return out;
    }
    return v;
  }
  function stableStringify(v) {
    return JSON.stringify(stable(v));
  }

  function remoteSnapshot(remote) {
    const out = {};
    if (!remote || typeof remote !== 'object') return out;
    SYNC_KEYS.forEach(k => {
      if (!(k in remote) || remote[k] == null) return;
      let v = remote[k];
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e) { /* plain string */ }
      }
      out[k] = v;
    });
    return out;
  }

  function sameData(a, b) {
    return stableStringify(a) === stableStringify(b);
  }

  // true als er echt iets in localStorage veranderd is
  function applyRemote(remote, opts) {
    const force = opts && opts.force;
    if (!remote || typeof remote !== 'object') return false;
    if (dirty && !force) return false;
    suppress = true;
    let changed = false;
    SYNC_KEYS.forEach(k => {
      const has = (k in remote) && remote[k] != null;
      if (!has) {
        if (localStorage.getItem(k) != null) {
          localStorage.removeItem(k);
          changed = true;
        }
        return;
      }
      const incoming = JSON.stringify(remote[k]);
      const local = localStorage.getItem(k);
      if (local !== incoming) {
        localStorage.setItem(k, incoming);
        changed = true;
      }
    });
    suppress = false;
    lastJson = JSON.stringify(collectAll());
    // Herlaad de pagina als data veranderd is (alleen na boot, niet tijdens typen).
    // Tijdens de eerste pull beslist initialSync zelf, één keer, met een lus-guard.
    if (changed && !booting) {
      window.location.reload();
    }
    return changed;
  }

  function confirmPush(json) {
    // Een oudere, tragere push mag dirty/unsynced niet wissen als de
    // gebruiker intussen alweer iets nieuws heeft gezet.
    if (JSON.stringify(collectAll()) !== json) return;
    lastJson = json;
    dirty = false;
    clearUnsynced();
  }

  async function push() {
    if (hydrating) return;
    const data = collectAll();
    const json = JSON.stringify(data);
    if (json === lastJson) { confirmPush(json); return; }
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
      if (res.ok) confirmPush(json);
    } catch (e) {}
  }

  // Directe, betrouwbare save — gebruikt bij backgrounding/sluiten (keepalive blijft
  // doorlopen ook als de pagina meteen daarna verdwijnt).
  function flush() {
    if (hydrating) return;
    clearTimeout(pushTimer);
    const data = collectAll();
    const json = JSON.stringify(data);
    if (json === lastJson) { confirmPush(json); return; }
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
    }).then(res => { if (res && res.ok) confirmPush(json); }).catch(() => {});
  }

  async function fetchRow() {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/app_state?key=eq.' + currentAppKey() + '&select=data',
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    if (!res.ok) throw new Error('status ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('bad payload');
    if (!rows.length || !rows[0] || rows[0].data == null) return null;
    return rows[0].data;
  }

  async function pull() {
    try {
      const remote = await fetchRow();
      if (remote) applyRemote(remote);
    } catch (e) {}
  }

  function schedulePush() {
    if (suppress || hydrating) return;
    // Init-write nadat de pull al klaar is.
    if (bootPhase) {
      if (!remoteReadable) {
        // Fetch mislukt: boot-mutatie niet uploaden en ook niet later
        // via pagehide/flush alsnog meesturen.
        lastJson = JSON.stringify(collectAll());
        dirty = false;
        return;
      }
      clearTimeout(pushTimer);
      dirty = true;
      push();
      return;
    }
    dirty = true;
    markUnsynced();
    clearTimeout(pushTimer);
    // Geen wachttijd meer: verzenden begint meteen. Dit is cruciaal op mobiel,
    // waar het scherm/app binnen een fractie van een seconde kan bevriezen.
    push();
  }

  // Boot-afgeleide writes (dag van vandaag, normalisatie) ná een geslaagde
  // pull. Geen unsynced-vlag: dit is afgeleid van data die al gelijk was
  // aan de remote rij en kan bij een mislukte push opnieuw berekend worden.
  function pushBootDelta() {
    if (hydrating) return;
    clearTimeout(pushTimer);
    dirty = true;
    push();
  }

  function finishHydration() {
    hydrating = false;
    booting = false;
    reloadFlagSet(null);
    const current = collectAll();
    if (!sameData(current, syncedSnapshot)) {
      const baseJson = JSON.stringify(syncedSnapshot);
      lastJson = baseJson === JSON.stringify(current) ? null : baseJson;
      pushBootDelta();
      return;
    }
    lastJson = JSON.stringify(current);
    dirty = false;
    clearUnsynced();
  }

  // Eén reload per pagina-load als de remote rij afweek van wat deze
  // pagina al in memory had geladen. Voorkomt een lus als boot daarna
  // meteen weer schrijft.
  function reloadOnce(changed) {
    if (!changed) return false;
    if (reloadFlagGet() === '1') {
      reloadFlagSet(null);
      return false;
    }
    reloadFlagSet('1');
    window.location.reload();
    return true;
  }

  async function initialSync() {
    let remote = null;
    try {
      remote = await fetchRow();
    } catch (e) {
      // Remote onbereikbaar: niets pushen. Een stale lokale kopie mag
      // de rij niet blind overschrijven. lastJson vastzetten op de
      // huidige lokale stand zodat pagehide/flush ook niets stuurt
      // tot de gebruiker zelf iets wijzigt.
      remoteReadable = false;
      lastJson = JSON.stringify(collectAll());
      dirty = false;
      hydrating = false;
      booting = false;
      return;
    }

    remoteReadable = true;

    if (remote == null) {
      // Nog geen rij voor deze sleutel. Lokale data omhoog sturen zodat
      // het apparaat de rij aanmaakt; er is geen nieuwere remote om te bewaren.
      syncedSnapshot = {};
      finishHydration();
      return;
    }

    const remoteData = remoteSnapshot(remote);
    const preBootDiffers = !sameData(initialData, remoteData);

    // Echte offline edits die nooit bevestigd zijn: niet stil overschrijven.
    if (hasUnsynced() && preBootDiffers) {
      hydrating = false;
      booting = false;
      reloadFlagSet(null);
      lastJson = null;
      schedulePush();
      return;
    }

    if (preBootDiffers) {
      const changed = applyRemote(remote, { force: true });
      if (reloadOnce(changed)) return; // hydrating blijft true tot de reload; niets pushen
      syncedSnapshot = remoteData;
      finishHydration();
      return;
    }

    syncedSnapshot = remoteData;
    finishHydration();
  }

  // Hook localStorage. Snapshot hierboven is al genomen met de ruwe getItem.
  localStorage.setItem = function (k, v) {
    _set(k, v);
    if (!suppress && SYNC_KEYS.includes(k)) schedulePush();
  };
  localStorage.removeItem = function (k) {
    _del(k);
    if (!suppress && SYNC_KEYS.includes(k)) schedulePush();
  };

  // Boot: remote eerst ophalen. Pagina-scripts mogen intussen schrijven;
  // die writes worden pas gepusht nadat de remote rij toegepast is.
  window.addEventListener('DOMContentLoaded', function () {
    initialSync();
  });
  window.addEventListener('load', function () {
    // Na de load-handler van de pagina (checklist boot wacht op load)
    // zijn verdere writes gebruikersedits.
    setTimeout(function () { bootPhase = false; }, 0);
  });

  // Sync bij terugkeren naar tab / weggaan van tab
  document.addEventListener('visibilitychange', () => {
    if (hydrating) return;
    if (document.hidden) {
      // Scherm uit / andere app / tab sluiten — sla nu meteen betrouwbaar op
      flush();
    } else {
      // Terug in beeld — eerst eigen wijzigingen wegschrijven, dan pas ophalen
      if (dirty) { push().then(pull); } else { pull(); }
    }
  });
  window.addEventListener('focus', () => {
    if (hydrating) return;
    if (dirty) { push().then(pull); } else { pull(); }
  });

  // Push bij sluiten/navigeren weg. Niet tijdens hydratie: dat zou de
  // stale lokale kopie alsnog over de remote rij schrijven.
  window.addEventListener('pagehide', () => {
    if (hydrating) return;
    flush();
  });
})();
