// Rounded line icons on a 24 × 24 grid. One stroke weight, one style.
const ICONS = {
  star: '<path d="M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.6l-5.2 2.8 1-5.9L3.5 9.4l5.9-.8z" fill="currentColor" stroke-linejoin="round"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  arm: '<path d="M3 18.5h10.5a5.5 5.5 0 0 0 5.5-5.5V6.8a2.6 2.6 0 0 0-5.2 0v3.4c-1.7-1.7-4.6-2-6.8-.6C5.4 10.6 4 11.7 3 12.4"/><path d="M13.8 10.2c.6 1.2.7 2.5.2 3.8"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5a3 3 0 0 0 3.5 4M16 6h3.5a3 3 0 0 1-3.5 4M12 13v4M8.5 20h7M10 17h4v3h-4z"/>',
  up: '<path d="M4 17l6-6 4 4 6-7M14 8h6v6"/>',
  face: '<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01M15 10h.01M8.8 14.5a4 4 0 0 0 6.4 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  camera: '<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3V19H4z" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.4"/>',
  car: '<path d="M4 15.5v-3l2-4.5h12l2 4.5v3zM4 12.5h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/>',
  hand: '<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11.5V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-.5a5.5 5.5 0 0 1-4.6-2.5L4.5 15a1.6 1.6 0 0 1 2.6-1.8L8 14.5"/>',
  bolt: '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor" stroke-linejoin="round"/>',
  people: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 6M17.5 14.5a4.5 4.5 0 0 1 3 5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  crown: '<path d="M4 8l4 4 4-6 4 6 4-4-1.6 10H5.6z" fill="currentColor" stroke-linejoin="round"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  head: '<circle cx="12" cy="9" r="5"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>',
  mouth: '<path d="M4 12c2.5-3 5-3 8-1.5 3-1.5 5.5-1.5 8 1.5-2.5 3.5-5 5-8 5s-5.5-1.5-8-5zM4 12h16"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  map: '<path d="M9 4.5l-5 2v13l5-2 6 2 5-2v-13l-5 2zM9 4.5v13M15 6.5v13"/>',
  chart: '<path d="M4 20h16M7 16v-4M12 16V7M17 16v-6"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="M8.5 11L6 3.5h4L12 9M15.5 11L18 3.5h-4L12 9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3L5.5 5.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5h.01"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke-linejoin="round"/>',
  flame: '<path d="M12 21a6 6 0 0 0 6-6c0-3.5-2.5-5.5-3.5-8.5-1 2-2.5 3-3.5 3 0-2-.5-4-2-6C8 8 6 10.5 6 15a6 6 0 0 0 6 6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  gate: '<path d="M5 20V8M19 20V8M5 10.5h14M8 10.5l2.5-3M13 10.5l2.5-3"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  wifi: '<path d="M3.5 9a12 12 0 0 1 17 0M6.5 12.5a7.5 7.5 0 0 1 11 0M9.5 16a3 3 0 0 1 5 0M12 19.5h.01"/>',
};

export function iconSvg(name) {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.mounted === el.dataset.icon) return;
    el.querySelector(':scope > svg.icon')?.remove();
    el.insertAdjacentHTML('afterbegin', iconSvg(el.dataset.icon));
    el.dataset.mounted = el.dataset.icon;
  });
}
