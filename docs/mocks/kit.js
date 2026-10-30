// Artifacts viewer mocks: icons and device chrome. <span data-i="share"></span> becomes an icon;
// every .phone gets an island, status bar (data-time) and home indicator. The viewer is a website,
// so phones show it in Safari: the page sits in .vp above Safari's bottom bar. The bar is full on
// pages seen from the top, and collapsed (scrolled) on canvases, articles and sheets; data-safari
// ("full" or "min") overrides that, and data-url sets the domain. Class "nosb" marks iOS's own
// screens (the Lock Screen), which get no status bar and no Safari.
const I = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>', chevR: '<path d="M9 6l6 6-6 6"/>', chevL: '<path d="M15 6l-6 6 6 6"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  cmt: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
  move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  frames: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 2h6l1-2h5"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  spark: '<path d="M12 4.5l8.5 15h-17z"/>',  // "what changed": a delta, not a sparkle
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  compare: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 3v18"/>',
  outline: '<path d="M4 6h16M8 12h12M8 18h12"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  doc: '<path d="M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6"/>',
  canvas: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="7" y="8" width="4" height="8" rx="1"/><rect x="13.5" y="8" width="4" height="5" rx="1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  approve: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  term: '<path d="M4 6l5 6-5 6M12 18h8"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  homeadd: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 19.5h.01"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9v1.5M15 9v1.5M12 9v4h-1M9.5 16a4 4 0 0 0 5 0"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
};
function ic(n) { return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[n] || ''}</svg>`; }
// Agents sign with initials (data-who, default Claude), never a sparkle.
document.querySelectorAll('.av.agent').forEach(e => { e.removeAttribute('data-i'); if (!e.textContent.trim()) e.textContent = e.dataset.who || 'Cl'; });
// A bare number is a count, the only label that gets a filled badge.
document.querySelectorAll('.pill, .tag').forEach(e => { if (/^\d+$/.test(e.textContent.trim())) e.classList.add('count'); });
document.querySelectorAll('[data-i]').forEach(e => e.insertAdjacentHTML('afterbegin', ic(e.dataset.i)));
const bars = '<svg width="15" height="9" viewBox="0 0 15 9" fill="currentColor"><rect x="0" y="6" width="2.5" height="3" rx=".6"/><rect x="4" y="4" width="2.5" height="5" rx=".6"/><rect x="8" y="2" width="2.5" height="7" rx=".6"/><rect x="12" y="0" width="2.5" height="9" rx=".6"/></svg>';
const safari = (mode, url) => mode === 'min'
  ? `<div class="sf min"><span class="sf-url">${url}</span></div>`
  : `<div class="sf"><span class="sf-btn">${ic('chevL')}</span><span class="sf-url">${url}<i>${ic('undo')}</i></span><span class="sf-btn">${ic('more')}</span></div>`;
document.querySelectorAll('.phone').forEach(p => {
  const kbd = p.querySelector('.kbd');
  if (!p.classList.contains('nosb')) {
    const sb = `<div class="sb${p.querySelector('.cv, .bleed') ? ' over' : ''}"><span>${p.dataset.time || '9:41'}</span><span class="ic">${bars}${ic('wifi')}<i class="bat"></i></span></div>`;
    const vp = document.createElement('div');
    vp.className = 'vp';
    while (p.firstChild) vp.appendChild(p.firstChild);
    vp.insertAdjacentHTML('afterbegin', sb);
    p.appendChild(vp);
    const mode = kbd ? 'kbd' : p.dataset.safari || (p.querySelector('.sheet, .cv, .art') ? 'min' : 'full');
    p.classList.add('sf-' + mode);
    // A sheet keeps its height and rises above Safari's bar, but never under the status bar.
    const cb = { full: 50, min: 32, kbd: 0 }[mode];
    p.querySelectorAll('.sheet').forEach(sh => { if (sh.style.top) sh.style.top = Math.max(36, parseFloat(sh.style.top) - cb) + 'px'; });
    if (!kbd) p.insertAdjacentHTML('beforeend', safari(mode, p.dataset.url || 'art.zahin.ca'));
  }
  p.insertAdjacentHTML('afterbegin', '<div class="island"></div>');
  if (!kbd) p.insertAdjacentHTML('beforeend', '<div class="home"></div>');
});
