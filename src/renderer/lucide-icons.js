'use strict';

// Selected Lucide icon nodes, vendored to keep the Electron renderer offline.
const ICONS = {
  'play': [['path', { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' }]],
  'users-round': [['path', { d: 'M18 21a8 8 0 0 0-16 0' }], ['circle', { cx: '10', cy: '8', r: '5' }], ['path', { d: 'M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3' }]],
  'activity': [['path', { d: 'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2' }]],
  'settings': [['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }], ['circle', { cx: '12', cy: '12', r: '3' }]],
  'crosshair': [['circle', { cx: '12', cy: '12', r: '10' }], ['line', { x1: '22', x2: '18', y1: '12', y2: '12' }], ['line', { x1: '6', x2: '2', y1: '12', y2: '12' }], ['line', { x1: '12', x2: '12', y1: '6', y2: '2' }], ['line', { x1: '12', x2: '12', y1: '22', y2: '18' }]],
  'layout-grid': [['rect', { width: '7', height: '7', x: '3', y: '3', rx: '1' }], ['rect', { width: '7', height: '7', x: '14', y: '3', rx: '1' }], ['rect', { width: '7', height: '7', x: '14', y: '14', rx: '1' }], ['rect', { width: '7', height: '7', x: '3', y: '14', rx: '1' }]],
  'plus': [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]],
  'pencil': [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
  'trash-2': [['path', { d: 'M10 11v6' }], ['path', { d: 'M14 11v6' }], ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }], ['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }]],
  'rotate-ccw': [['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }], ['path', { d: 'M3 3v5h5' }]],
  'x': [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  'circle-stop': [['circle', { cx: '12', cy: '12', r: '10' }], ['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1' }]],
  'monitor-up': [['path', { d: 'm9 10 3-3 3 3' }], ['path', { d: 'M12 13V7' }], ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }], ['path', { d: 'M12 17v4' }], ['path', { d: 'M8 21h8' }]],
  'lock-keyhole': [['circle', { cx: '12', cy: '16', r: '1' }], ['rect', { x: '3', y: '10', width: '18', height: '12', rx: '2' }], ['path', { d: 'M7 10V7a5 5 0 0 1 10 0v3' }]],
};

function createIcon(name, size) {
  const nodes = ICONS[name];
  if (!nodes) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const dimension = String(size || 16);
  Object.entries({
    width: dimension,
    height: dimension,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }).forEach(([key, value]) => svg.setAttribute(key, value));
  svg.classList.add('lucide');
  nodes.forEach(([tag, attrs]) => {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => child.setAttribute(key, value));
    svg.appendChild(child);
  });
  return svg;
}

function renderLucideIcons(root) {
  (root || document).querySelectorAll('[data-lucide]').forEach((placeholder) => {
    const icon = createIcon(
      placeholder.getAttribute('data-lucide'),
      placeholder.getAttribute('data-lucide-size'),
    );
    if (icon) placeholder.replaceWith(icon);
  });
}

window.renderLucideIcons = renderLucideIcons;
document.addEventListener('DOMContentLoaded', () => renderLucideIcons(document));
