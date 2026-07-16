'use strict';

/**
 * Computes stable Chrome window bounds for the leader plus its followers.
 * The engine also applies these bounds after launch so the layout can be
 * changed without restarting the mirroring session.
 */

function normalizeDisplay(display) {
  const work = display && display.workArea
    ? display.workArea
    : { x: 0, y: 0, width: 1280, height: 800 };
  return {
    x: Number(work.x) || 0,
    y: Number(work.y) || 0,
    width: Math.max(640, Number(work.width) || 1280),
    height: Math.max(480, Number(work.height) || 800),
  };
}

function splitCount(total, count) {
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function tileDisplay(display, count) {
  if (!count) return [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * (display.width / display.height))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellWidth = Math.floor(display.width / cols);
  const cellHeight = Math.floor(display.height / rows);
  return Array.from({ length: count }, (_, index) => ({
    x: display.x + (index % cols) * cellWidth,
    y: display.y + Math.floor(index / cols) * cellHeight,
    width: index % cols === cols - 1 ? display.width - (cols - 1) * cellWidth : cellWidth,
    height: Math.floor(index / cols) === rows - 1
      ? display.height - (rows - 1) * cellHeight
      : cellHeight,
  }));
}

function createWindowPlan(displays, profileIds, layout = 'minimized') {
  const safeDisplays = (Array.isArray(displays) && displays.length ? displays : [{}]).map(normalizeDisplay);
  const ids = Array.isArray(profileIds) ? profileIds : [];
  const leaderId = ids[0] || null;
  const followerIds = ids.slice(1);
  const bounds = new Map();

  if (!leaderId) return bounds;

  if (layout === 'last-used') {
    ids.forEach((id) => bounds.set(id, { args: [] }));
    return bounds;
  }

  if (layout === 'minimized') {
    const primary = safeDisplays[0];
    const half = Math.max(480, Math.floor(primary.width / 2));
    bounds.set(leaderId, {
      args: [
        `--window-position=${primary.x},${primary.y}`,
        `--window-size=${half},${primary.height}`,
      ],
    });
    followerIds.forEach((id, index) => {
      const display = safeDisplays[index % safeDisplays.length];
      bounds.set(id, {
        args: [
          `--window-position=${display.x},${display.y}`,
          `--window-size=${Math.max(480, Math.floor(display.width / 2))},${display.height}`,
          '--start-minimized',
        ],
      });
    });
    return bounds;
  }

  const allocations = splitCount(ids.length, safeDisplays.length);
  let cursor = 0;
  safeDisplays.forEach((display, displayIndex) => {
    const count = allocations[displayIndex];
    const cells = tileDisplay(display, count);
    for (const cell of cells) {
      const id = ids[cursor++];
      if (!id) break;
      bounds.set(id, {
        args: [
          `--window-position=${cell.x},${cell.y}`,
          `--window-size=${cell.width},${cell.height}`,
        ],
      });
    }
  });

  return bounds;
}

module.exports = { createWindowPlan, normalizeDisplay };
