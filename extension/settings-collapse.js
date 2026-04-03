/**
 * settings-collapse.js
 * Handles expand/collapse for each settings card.
 * Persists open/closed state per card in localStorage.
 */

(function () {
  const STORAGE_KEY = 'wsCardCollapse'; // JSON object: { cardId: true/false }

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  document.addEventListener('DOMContentLoaded', () => {
    const state = loadState();

    // Apply persisted collapsed state (overrides HTML defaults)
    document.querySelectorAll('.card[id]').forEach(card => {
      const id = card.id;
      if (id in state) {
        // Persisted state wins over HTML class default
        if (state[id]) {
          card.classList.add('collapsed');
        } else {
          card.classList.remove('collapsed');
        }
      }
      // If not in state, keep whatever class is set in HTML (collapsed or not)
    });

    // Wire up click handlers on all toggle headers
    document.querySelectorAll('.card-toggle').forEach(header => {
      header.addEventListener('click', () => {
        const cardId = header.dataset.card;
        const card = document.getElementById(cardId);
        if (!card) return;

        const isNowCollapsed = card.classList.toggle('collapsed');
        const state = loadState();
        state[cardId] = isNowCollapsed;
        saveState(state);
      });
    });
  });
})();
