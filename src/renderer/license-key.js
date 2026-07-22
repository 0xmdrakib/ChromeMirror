'use strict';

(function exposeLicenseKeyHelpers(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.ChromeMirrorLicenseKey = helpers;
})(typeof globalThis === 'undefined' ? this : globalThis, function createLicenseKeyHelpers() {
  const PREFIX = 'CMIR';
  const BODY_LENGTH = 16;

  function cleanCharacters(raw) {
    return String(raw || '')
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  function compactLicenseKey(raw) {
    const cleaned = cleanCharacters(raw);
    const value = cleaned.startsWith(PREFIX)
      ? cleaned.slice(PREFIX.length)
      : cleaned;
    return value.slice(0, BODY_LENGTH);
  }

  function formatLicenseKey(raw) {
    const cleaned = cleanCharacters(raw);
    if (!cleaned) return '';
    if (cleaned.length < PREFIX.length && PREFIX.startsWith(cleaned)) return cleaned;

    const body = compactLicenseKey(cleaned);
    if (!body) return PREFIX;
    return `${PREFIX}-${body.match(/.{1,4}/g).join('-')}`;
  }

  function isCompleteLicenseKey(raw) {
    return compactLicenseKey(raw).length === BODY_LENGTH;
  }

  function formatLicenseKeyEdit(raw, caret) {
    const input = String(raw || '');
    const offset = Number.isFinite(caret)
      ? Math.max(0, Math.min(input.length, caret))
      : input.length;
    const value = formatLicenseKey(input);
    const formattedBeforeCaret = formatLicenseKey(input.slice(0, offset));
    return {
      value,
      caret: Math.min(formattedBeforeCaret.length, value.length),
    };
  }

  function formatLicenseKeyPaste(currentValue, selectionStart, selectionEnd, pastedValue) {
    const pasted = String(pastedValue || '');
    if (isCompleteLicenseKey(pasted)) {
      const value = formatLicenseKey(pasted);
      return { value, caret: value.length };
    }

    const current = String(currentValue || '');
    const start = Number.isFinite(selectionStart)
      ? Math.max(0, Math.min(current.length, selectionStart))
      : current.length;
    const end = Number.isFinite(selectionEnd)
      ? Math.max(start, Math.min(current.length, selectionEnd))
      : start;
    const combined = current.slice(0, start) + pasted + current.slice(end);
    return formatLicenseKeyEdit(combined, start + pasted.length);
  }

  return {
    compactLicenseKey,
    formatLicenseKey,
    formatLicenseKeyEdit,
    formatLicenseKeyPaste,
    isCompleteLicenseKey,
  };
});
