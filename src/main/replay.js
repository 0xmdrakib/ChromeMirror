'use strict';

/**
 * Translates a captured leader event into TRUSTED input on the follower page
 * via Playwright. Resolution strategy: try each candidate selector in order;
 * if none match and coordinate-fallback is enabled, act by viewport fraction.
 */

const ACTION_TIMEOUT = 3500;

async function innerSize(page) {
  try {
    return await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  } catch (_) {
    return { w: 1280, h: 800 };
  }
}

function ownerPage(target) {
  return target && typeof target.frameElement === 'function' && typeof target.page === 'function'
    ? target.page()
    : target;
}

async function clickByFraction(target, frac) {
  const s = await innerSize(target);
  const page = ownerPage(target);
  if (target && typeof target.frameElement === 'function') {
    try {
      const owner = await target.frameElement();
      const box = await owner.boundingBox();
      if (box) {
        await page.mouse.click(box.x + frac.x * s.w, box.y + frac.y * s.h);
        return;
      }
    } catch (_) {}
  }
  await page.mouse.click(frac.x * s.w, frac.y * s.h);
}

function diffEdit(before, after) {
  before = String(before == null ? '' : before);
  after = String(after == null ? '' : after);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  return {
    start,
    deleteCount: beforeEnd - start,
    insertText: after.slice(start, afterEnd),
  };
}

function mapEditToCurrent(edit, before, current, selectionBefore) {
  before = String(before == null ? '' : before);
  current = String(current == null ? '' : current);
  const sourceTailStart = edit.start + edit.deleteCount;
  const selectionAtEnd = selectionBefore && selectionBefore.start === before.length && selectionBefore.end === before.length;
  const insertedAtEnd = sourceTailStart === before.length || selectionAtEnd;
  const insertedAtStart = edit.start === 0;
  if (insertedAtEnd) {
    return {
      ...edit,
      start: Math.max(0, current.length - edit.deleteCount),
      deleteCount: Math.min(edit.deleteCount, current.length),
    };
  }
  if (insertedAtStart) {
    return {
      ...edit,
      start: 0,
      deleteCount: Math.min(edit.deleteCount, current.length),
    };
  }
  return {
    ...edit,
    start: Math.min(edit.start, current.length),
    deleteCount: Math.min(edit.deleteCount, Math.max(0, current.length - edit.start)),
  };
}

async function applyTextOperation(target, loc, ev) {
  const page = ownerPage(target);
  const keyboard = page.keyboard;
  const value = ev.value != null ? String(ev.value) : '';
  const before = ev.valueBefore != null ? String(ev.valueBefore) : '';
  const edit = diffEdit(before, value);

  await loc.focus().catch(() => {});

  if (ev.contentEditable) {
    if (ev.inputType === 'deleteContentBackward') {
      await keyboard.press('Backspace').catch(() => {});
    } else if (ev.inputType === 'deleteContentForward') {
      await keyboard.press('Delete').catch(() => {});
    } else {
      await keyboard.insertText(ev.data || edit.insertText || '').catch(() => {});
    }
    return { ok: true, how: 'contenteditable-op' };
  }

  const applied = await loc.evaluate(
    (el, p) => {
      if (typeof el.value !== 'string') return false;
      var current = el.value;
      var edit = p.edit;
      var start = Math.min(Math.max(edit.start, 0), current.length);
      var end = Math.min(Math.max(start + edit.deleteCount, start), current.length);
      el.value = current.slice(0, start) + edit.insertText + current.slice(end);
      var caret = start + edit.insertText.length;
      if (typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(caret, caret); } catch (_) {}
      }
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: p.inputType || 'insertText',
        data: edit.insertText || null,
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    {
      edit: mapEditToCurrent(
        edit,
        before,
        await loc.evaluate((el) => (typeof el.value === 'string' ? el.value : '')).catch(() => ''),
        ev.selectionBefore
      ),
      inputType: ev.inputType,
    }
  ).catch(() => false);

  if (applied) return { ok: true, how: 'delta' };

  if (ev.data) {
    await keyboard.insertText(ev.data).catch(() => {});
    return { ok: true, how: 'keyboard-data' };
  }
  return { ok: false, reason: 'not-applied' };
}

// Return a Locator for the first selector that matches at least one element.
async function resolve(page, selectors) {
  if (!selectors || !selectors.length) return null;
  for (const sel of selectors) {
    try {
      const count = await page.locator(sel).count();
      if (count >= 1) return page.locator(sel).first();
    } catch (_) {
      /* malformed selector — try the next candidate */
    }
  }
  return null;
}

async function replayEvent(page, ev, settings) {
  settings = settings || {};
  switch (ev.kind) {
    case 'click': {
      const loc = await resolve(page, ev.selectors);
      if (loc) {
        await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        try {
          await loc.click({ timeout: ACTION_TIMEOUT });
          return { ok: true, how: 'selector' };
        } catch (e) {
          if (!settings.coordFallback || !ev.frac) throw e;
        }
      }
      if (settings.coordFallback && ev.frac) {
        await clickByFraction(page, ev.frac);
        return { ok: true, how: 'coords' };
      }
      return { ok: false, reason: 'not-found' };
    }

    case 'input': {
      if (ev.isPassword && settings.skipPassword) return { ok: false, reason: 'skip-password' };
      if (!settings.syncFullFieldValues) return { ok: false, reason: 'full-value-sync-disabled' };
      const loc = await resolve(page, ev.selectors);
      if (!loc) return { ok: false, reason: 'not-found' };
      const keyboard = ownerPage(page).keyboard;
      if (ev.contentEditable) {
        await loc.focus().catch(() => {});
        await keyboard.press('Control+A').catch(() => {});
        await keyboard.press('Delete').catch(() => {});
        await keyboard.insertText(ev.value || '').catch(() => {});
      } else {
        const value = ev.value != null ? ev.value : '';
        const filled = await loc.fill(value, { timeout: ACTION_TIMEOUT }).then(() => true).catch(() => false);
        if (!filled) {
          await loc.focus().catch(() => {});
          await keyboard.press('Control+A').catch(() => {});
          await keyboard.press('Delete').catch(() => {});
          await keyboard.insertText(value).catch(() => {});
        }
      }
      return { ok: true };
    }

    case 'text-op': {
      if (ev.isPassword && settings.skipPassword) return { ok: false, reason: 'skip-password' };
      const loc = await resolve(page, ev.selectors);
      if (!loc) return { ok: false, reason: 'not-found' };
      return applyTextOperation(page, loc, ev);
    }

    case 'select': {
      const loc = await resolve(page, ev.selectors);
      if (!loc) return { ok: false, reason: 'not-found' };
      await loc.selectOption(ev.value, { timeout: ACTION_TIMEOUT }).catch(async () => {
        await loc.selectOption({ label: ev.value }, { timeout: ACTION_TIMEOUT }).catch(() => {});
      });
      return { ok: true };
    }

    case 'check': {
      const loc = await resolve(page, ev.selectors);
      if (!loc) return { ok: false, reason: 'not-found' };
      await loc.setChecked(!!ev.checked, { timeout: ACTION_TIMEOUT }).catch(() => {});
      return { ok: true };
    }

    case 'key': {
      const loc = await resolve(page, ev.selectors);
      if (loc) await loc.focus().catch(() => {});
      const mods = [];
      if (ev.ctrl) mods.push('Control');
      if (ev.meta) mods.push('Meta');
      if (ev.alt) mods.push('Alt');
      if (ev.shift) mods.push('Shift');
      const combo = mods.concat([ev.key]).join('+');
      await ownerPage(page).keyboard.press(combo).catch(() => {});
      return { ok: true };
    }

    case 'scroll': {
      const loc = await resolve(page, ev.selectors);
      if (loc) {
        await loc.evaluate((el, p) => {
          el.scrollLeft = p.x;
          el.scrollTop = p.y;
        }, { x: ev.x, y: ev.y }).catch(() => {});
      } else {
        await page
          .evaluate((p) => window.scrollTo(p.x, p.y), { x: ev.x, y: ev.y })
          .catch(() => {});
      }
      return { ok: true };
    }

    default:
      return { ok: false, reason: 'unknown' };
  }
}

module.exports = { replayEvent };
