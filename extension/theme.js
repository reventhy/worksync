/**
 * theme.js — Light/Dark mode toggle for WorkSync popup.
 * Runs as a plain (non-module) script so it applies the saved theme
 * before the rest of the page paints, avoiding a flash of wrong theme.
 */

(function () {
  const STORAGE_KEY = 'wsTheme'; // 'light' | 'dark' (default dark)

  // ── Apply saved theme immediately (sync read from localStorage as fast path) ──
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light') document.body.classList.add('light');

  // ── Also sync with chrome.storage so it persists across devices ──
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      const theme = res[STORAGE_KEY] || 'dark';
      applyTheme(theme, false); // don't re-save, just apply
    });
  }

  function applyTheme(theme, save = true) {
    if (theme === 'light') {
      document.body.classList.add('light');
    } else {
      document.body.classList.remove('light');
    }

    // Sync icons
    const sun  = document.getElementById('theme-icon-sun');
    const moon = document.getElementById('theme-icon-moon');
    if (sun && moon) {
      sun.style.display  = theme === 'light' ? 'none'  : '';
      moon.style.display = theme === 'light' ? ''      : 'none';
    }

    if (save) {
      localStorage.setItem(STORAGE_KEY, theme);
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ [STORAGE_KEY]: theme });
      }
    }
  }

  // ── Wire up button after DOM is ready ──
  document.addEventListener('DOMContentLoaded', () => {
    // Re-apply to sync icons now that DOM exists
    const currentTheme = document.body.classList.contains('light') ? 'light' : 'dark';
    applyTheme(currentTheme, false);

    const btn = document.getElementById('btn-theme');
    if (!btn) return;

    btn.addEventListener('click', () => {
      const isLight = document.body.classList.contains('light');
      applyTheme(isLight ? 'dark' : 'light', true);
    });
  });
})();
