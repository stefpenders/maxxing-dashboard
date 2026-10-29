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
//
// Een al open tab doet hetzelfde als iemand de rij buiten de
// pagina om bijwerkt: vóór elke push lezen we updated_at. Is de
// remote rij nieuwer dan wat deze tab het laatst gezien heeft,
// dan wordt er samengevoegd in plaats van blind overschreven.
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
  // localStorage tegen afgezet wordt na de pull. Wordt bijgewerkt
  // na elke geslaagde sync, zodat een latere merge weet welke
  // kant er sindsdien veranderd is.
  let syncedSnapshot = initialData;
  // updated_at van de rij zoals deze tab die het laatst gezien of
  // zelf geschreven heeft. Null = deze tab heeft nog geen rij gezien.
  let lastSyncedAt = null;
  // True zodra syncedSnapshot echt de laatst geziene remote rij is,
  // niet alleen de lokale kopie van bij het openen.
  let haveBaseline = false;
  let reloading = false;
  let pushQueue = Promise.resolve();
  const PULL_INTERVAL_MS = 45000;

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

  function clone(v) {
    if (typeof v === 'undefined') return undefined;
    return JSON.parse(JSON.stringify(v));
  }

  function isNewer(remoteAt, knownAt) {
    if (!remoteAt) return false;
    if (!knownAt) return true;
    const r = Date.parse(remoteAt);
    const k = Date.parse(knownAt);
    if (isNaN(r) || isNaN(k)) return String(remoteAt) > String(knownAt);
    return r > k;
  }

  function listOf(v) {
    return Array.isArray(v) ? v : [];
  }

  // Zelfde id aan beide kanten: de lokale versie wint als die sinds
  // de laatste sync veranderd is (done/count). Items die maar aan
  // één kant bestaan blijven behouden. Een verwijdering kan daarbij
  // terugkomen; dat is voor nu acceptabel.
  function mergeById(baseList, localList, remoteList) {
    const base = Object.create(null);
    const local = Object.create(null);
    const remote = Object.create(null);
    listOf(baseList).forEach(item => { if (item && item.id != null) base[item.id] = item; });
    listOf(localList).forEach(item => { if (item && item.id != null) local[item.id] = item; });
    listOf(remoteList).forEach(item => { if (item && item.id != null) remote[item.id] = item; });
    const seen = Object.create(null);
    const out = [];
    function take(id) {
      if (seen[id]) return;
      seen[id] = 1;
      const l = local[id];
      const r = remote[id];
      const b = base[id];
      if (l && r) out.push(clone(!sameData(l, b) ? l : r));
      else if (l) out.push(clone(l));
      else if (r) out.push(clone(r));
    }
    listOf(remoteList).forEach(item => { if (item && item.id != null) take(item.id); });
    listOf(localList).forEach(item => { if (item && item.id != null) take(item.id); });
    listOf(remoteList).forEach(item => { if (item && (item.id == null)) out.push(clone(item)); });
    listOf(localList).forEach(item => { if (item && (item.id == null)) out.push(clone(item)); });
    return out;
  }

  // Andere velden: de kant die sinds de laatste sync veranderd is.
  // Veranderden beide, dan wint lokaal zodat een niet-verstuurde edit
  // niet stil verdwijnt.
  function pickChanged(base, local, remote) {
    const localChanged = !sameData(local, base);
    const remoteChanged = !sameData(remote, base);
    if (localChanged && !remoteChanged) return clone(local);
    if (remoteChanged && !localChanged) return clone(remote);
    if (localChanged && remoteChanged) return clone(local);
    if (typeof remote !== 'undefined') return clone(remote);
    return clone(local);
  }

  function mergeDays(baseDays, localDays, remoteDays) {
    const base = baseDays || {};
    const local = localDays || {};
    const remote = remoteDays || {};
    const dates = Object.create(null);
    Object.keys(base).forEach(k => { dates[k] = 1; });
    Object.keys(local).forEach(k => { dates[k] = 1; });
    Object.keys(remote).forEach(k => { dates[k] = 1; });
    const out = {};
    Object.keys(dates).forEach(date => {
      const b = base[date] || {};
      const l = local[date];
      const r = remote[date];
      if (l == null && r == null) return;
      if (l == null) { out[date] = clone(r); return; }
      if (r == null) { out[date] = clone(l); return; }
      if (!r || typeof r !== 'object' || !l || typeof l !== 'object') {
        out[date] = pickChanged(b, l, r);
        return;
      }
      const day = clone(r);
      day.tasks = mergeById(b.tasks, l.tasks, r.tasks);
      Object.keys(l).forEach(k => {
        if (k === 'tasks') return;
        day[k] = pickChanged(b[k], l[k], r[k]);
      });
      out[date] = day;
    });
    return out;
  }

  function mergeChecklist(base, local, remote) {
    const b = base || {};
    const l = local || {};
    const r = remote || {};
    const out = clone(r) || {};
    ['planned', 'recurring', 'categories'].forEach(field => {
      if (b[field] == null && l[field] == null && r[field] == null) return;
      out[field] = mergeById(b[field], l[field], r[field]);
    });
    if (b.days != null || l.days != null || r.days != null) {
      out.days = mergeDays(b.days, l.days, r.days);
    }
    const skip = { planned: 1, recurring: 1, categories: 1, days: 1 };
    const keys = Object.create(null);
    [b, l, r].forEach(obj => {
      Object.keys(obj).forEach(k => { if (!skip[k]) keys[k] = 1; });
    });
    Object.keys(keys).forEach(k => {
      const picked = pickChanged(b[k], l[k], r[k]);
      if (typeof picked === 'undefined') delete out[k];
      else out[k] = picked;
    });
    return out;
  }

  function mergeAll(base, local, remote) {
    const b = base || {};
    const l = local || {};
    const r = remote || {};
    const keys = Object.create(null);
    SYNC_KEYS.forEach(k => { keys[k] = 1; });
    [b, l, r].forEach(obj => Object.keys(obj).forEach(k => { keys[k] = 1; }));
    const out = {};
    Object.keys(keys).forEach(k => {
      if (b[k] == null && l[k] == null && r[k] == null) return;
      const val = k === 'maxx_checklist_v1'
        ? mergeChecklist(b[k], l[k], r[k])
        : pickChanged(b[k], l[k], r[k]);
      if (typeof val !== 'undefined') out[k] = val;
    });
    return out;
  }

  function rememberSync(updatedAt, snapshot) {
    if (updatedAt && (!lastSyncedAt || !isNewer(lastSyncedAt, updatedAt))) lastSyncedAt = updatedAt;
    if (snapshot) {
      syncedSnapshot = clone(snapshot);
      haveBaseline = true;
    }
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
    if (changed && !booting) reloadOnce(true);
    return changed;
  }

  function confirmPush(json, updatedAt, snapshot) {
    // Een oudere, tragere push mag dirty/unsynced niet wissen als de
    // gebruiker intussen alweer iets nieuws heeft gezet.
    if (JSON.stringify(collectAll()) !== json) return false;
    lastJson = json;
    dirty = false;
    clearUnsynced();
    rememberSync(updatedAt, snapshot);
    return true;
  }

  function writeData(data) {
    suppress = true;
    SYNC_KEYS.forEach(k => {
      if (!(k in data) || data[k] == null) {
        if (localStorage.getItem(k) != null) localStorage.removeItem(k);
      } else {
        const incoming = JSON.stringify(data[k]);
        if (localStorage.getItem(k) !== incoming) localStorage.setItem(k, incoming);
      }
    });
    suppress = false;
  }

  async function sendPush(data) {
    const json = JSON.stringify(data);
    const updatedAt = new Date().toISOString();
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/app_state', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify([{ key: currentAppKey(), data: data, updated_at: updatedAt }]),
        keepalive: true
      });
      if (res.ok) return confirmPush(json, updatedAt, data);
    } catch (e) {}
    return false;
  }

  // Lees updated_at vóór we schrijven. Een nieuwere remote rij mag nooit
  // blind vervangen worden door de lokale kopie van deze tab.
  async function guardedPush() {
    if (hydrating || reloading) return;
    let row = null;
    let readable = true;
    try {
      row = await fetchRow();
    } catch (e) {
      readable = false;
    }
    if (hydrating || reloading) return;

    const latest = collectAll();
    const latestJson = JSON.stringify(latest);
    if (!readable) {
      // Onbereikbaar: geen stale boot-kopie uploaden. Een echte edit
      // proberen we nog wel te bewaren.
      if (!hasUnsynced()) return;
      await sendPush(latest);
      return;
    }
    if (!row) {
      if (latestJson === lastJson) { confirmPush(latestJson); return; }
      await sendPush(latest);
      return;
    }

    const remoteData = remoteSnapshot(row.data);
    const remoteUnseen = isNewer(row.updatedAt, lastSyncedAt) || !sameData(remoteData, syncedSnapshot);
    if (sameData(latest, remoteData)) {
      lastJson = latestJson;
      dirty = false;
      clearUnsynced();
      rememberSync(row.updatedAt, remoteData);
      return;
    }
    if (!remoteUnseen) {
      if (latestJson === lastJson) { confirmPush(latestJson); return; }
      await sendPush(latest);
      return;
    }

    // Zonder baseline is elke lokale stand een mogelijke niet-verstuurde
    // edit: samenvoegen, niet de remote rij blind terugschrijven.
    const localChanged = hasUnsynced() || !haveBaseline || !sameData(latest, syncedSnapshot);
    if (!localChanged) {
      // Geen lokale edits: neem de remote rij over en push hem niet terug.
      rememberSync(row.updatedAt, remoteData);
      dirty = false;
      clearUnsynced();
      applyRemote(row.data, { force: true });
      return;
    }

    const merged = mergeAll(haveBaseline ? syncedSnapshot : null, latest, remoteData);
    const before = stableStringify(latest);
    writeData(merged);
    const sent = collectAll();
    const broughtRemote = stableStringify(sent) !== before;
    const ok = await sendPush(sent);
    // De pagina heeft de remote taken nog niet in geheugen. Herladen
    // zodat een latere save() ze niet alsnog wist.
    if (ok && broughtRemote) reloadOnce(true);
  }

  function enqueuePush() {
    const run = pushQueue.then(guardedPush, guardedPush);
    pushQueue = run.then(() => {}, () => {});
    return run;
  }

  // Directe save bij backgrounding/sluiten. Zelfde guard als een gewone
  // push: keepalive blijft op de POST staan, maar pas ná de updated_at-check.
  function flush() {
    if (hydrating || reloading) return;
    clearTimeout(pushTimer);
    enqueuePush();
  }

  async function fetchRow() {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/app_state?key=eq.' + currentAppKey() + '&select=data,updated_at',
      {
        cache: 'no-store',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      }
    );
    if (!res.ok) throw new Error('status ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('bad payload');
    if (!rows.length || !rows[0] || rows[0].data == null) return null;
    return { data: rows[0].data, updatedAt: rows[0].updated_at || null };
  }

  async function pull() {
    if (hydrating || reloading) return;
    try {
      const row = await fetchRow();
      if (!row) return;
      const remoteData = remoteSnapshot(row.data);
      const newer = isNewer(row.updatedAt, lastSyncedAt);
      const differs = !sameData(remoteData, collectAll());
      if (!newer && !differs) {
        rememberSync(row.updatedAt, remoteData);
        return;
      }
      // Lokale edits niet weggooien. De volgende push voegt samen.
      if (dirty || hasUnsynced()) return;
      rememberSync(row.updatedAt, remoteData);
      applyRemote(row.data);
    } catch (e) {}
  }

  function schedulePush() {
    if (suppress || hydrating || reloading) return;
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
      enqueuePush();
      return;
    }
    dirty = true;
    markUnsynced();
    clearTimeout(pushTimer);
    // Geen wachttijd meer: verzenden begint meteen. Dit is cruciaal op mobiel,
    // waar het scherm/app binnen een fractie van een seconde kan bevriezen.
    enqueuePush();
  }

  // Boot-afgeleide writes (dag van vandaag, normalisatie) ná een geslaagde
  // pull. Geen unsynced-vlag: dit is afgeleid van data die al gelijk was
  // aan de remote rij en kan bij een mislukte push opnieuw berekend worden.
  function pushBootDelta() {
    if (hydrating || reloading) return;
    clearTimeout(pushTimer);
    dirty = true;
    enqueuePush();
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
    if (!changed || reloading) return false;
    if (reloadFlagGet() === '1') {
      reloadFlagSet(null);
      return false;
    }
    reloadFlagSet('1');
    reloading = true;
    window.location.reload();
    return true;
  }

  async function initialSync() {
    let remote = null;
    let updatedAt = null;
    try {
      const row = await fetchRow();
      if (row) {
        remote = row.data;
        updatedAt = row.updatedAt;
      }
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
      lastSyncedAt = null;
      finishHydration();
      return;
    }

    const remoteData = remoteSnapshot(remote);
    const preBootDiffers = !sameData(initialData, remoteData);

    // Echte offline edits die nooit bevestigd zijn: niet stil overschrijven.
    // De net opgehaalde rij is dan niet de gemeenschappelijke voorouder;
    // de push hieronder voegt samen.
    if (hasUnsynced() && preBootDiffers) {
      hydrating = false;
      booting = false;
      reloadFlagSet(null);
      lastJson = null;
      schedulePush();
      return;
    }

    rememberSync(updatedAt, remoteData);

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
    if (hydrating || reloading) return;
    if (document.hidden) {
      // Scherm uit / andere app / tab sluiten — sla nu meteen betrouwbaar op
      flush();
    } else if (dirty || hasUnsynced()) {
      enqueuePush().then(pull);
    } else {
      pull();
    }
  });
  window.addEventListener('focus', () => {
    if (hydrating || reloading) return;
    if (dirty || hasUnsynced()) enqueuePush().then(pull);
    else pull();
  });

  // Ook zonder focus: een open tab merkt een schrijfactie van buitenaf.
  setInterval(() => {
    if (hydrating || reloading || document.hidden) return;
    if (dirty || hasUnsynced()) return;
    pull();
  }, PULL_INTERVAL_MS);

  // Push bij sluiten/navigeren weg. Niet tijdens hydratie: dat zou de
  // stale lokale kopie alsnog over de remote rij schrijven.
  window.addEventListener('pagehide', () => {
    if (hydrating || reloading) return;
    flush();
  });
})();
