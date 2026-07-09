// ============================================================
// MAXXING DASHBOARD — Gedeelde topbalk
// Voeg onderaan de NAV_ITEMS array nieuwe pagina's toe.
// ============================================================
(function () {
  const NAV_ITEMS = [
    { id: 'checklist', label: 'Checklist', href: 'checklist.html' },
    { id: 'gym',       label: 'Gym',       href: 'gym.html' },
  ];

  // Determine which page is active based on current filename
  const currentFile = window.location.pathname.split('/').pop() || 'checklist.html';
  function isActive(item) {
    return currentFile === item.href ||
      (currentFile === '' || currentFile === 'index.html') && item.href === 'checklist.html';
  }

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    .mx-topbar {
      position: sticky;
      top: 0;
      z-index: 200;
      display: flex;
      justify-content: center;
      padding: 10px 12px;
      background: linear-gradient(180deg, rgba(10,10,11,0.96) 0%, rgba(10,10,11,0.88) 100%);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .mx-topbar-inner {
      display: flex;
      width: 100%;
      max-width: 720px;
      gap: 4px;
    }
    .mx-nav-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 9px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: rgba(255,255,255,0.45);
      text-decoration: none;
      background: transparent;
      border: 1px solid transparent;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
      -webkit-tap-highlight-color: transparent;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
      white-space: nowrap;
    }
    .mx-nav-btn:hover {
      color: rgba(255,255,255,0.75);
      background: rgba(255,255,255,0.04);
    }
    .mx-nav-btn.active {
      color: #ffffff;
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.12);
    }
    .mx-nav-icon { font-size: 15px; line-height: 1; }

    /* Push page content below the sticky topbar */
    body { padding-top: 0 !important; }
    .shell, main { padding-top: 16px !important; }

    @media (max-width: 480px) {
      .mx-nav-btn { padding: 8px 4px; font-size: 11px; }
    }
  `;
  document.head.appendChild(style);

  // Build the bar
  const bar = document.createElement('nav');
  bar.className = 'mx-topbar';
  bar.setAttribute('aria-label', 'Hoofdnavigatie');

  const inner = document.createElement('div');
  inner.className = 'mx-topbar-inner';

  NAV_ITEMS.forEach(item => {
    const a = document.createElement('a');
    a.className = 'mx-nav-btn' + (isActive(item) ? ' active' : '');
    a.href = item.href;
    a.setAttribute('aria-current', isActive(item) ? 'page' : 'false');
    a.innerHTML = '<span class="mx-nav-label">' + item.label + '</span>';
    inner.appendChild(a);
  });

  // Alleen zichtbaar als er een vriend is ingelogd (Stef ziet dit nooit).
  const activeUser = localStorage.getItem('maxx_active_user');
  if (activeUser) {
    const out = document.createElement('a');
    out.className = 'mx-nav-btn';
    out.href = '#';
    out.style.flex = '0 0 auto';
    out.style.color = 'rgba(255,255,255,0.35)';
    out.innerHTML = '<span class="mx-nav-label">Uitloggen</span>';
    out.addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('maxx_active_user');
      window.location.href = 'login.html';
    });
    inner.appendChild(out);
  }

  bar.appendChild(inner);

  // Insert as first element in body
  document.body.insertBefore(bar, document.body.firstChild);
})();
