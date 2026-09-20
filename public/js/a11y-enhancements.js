/* Small progressive enhancements that do not depend on the app's private state. */
(function () {
  const labelIconButtons = () => {
    document.querySelectorAll('button.iconbtn, button.close, button.notifbtn').forEach(button => {
      if (button.getAttribute('aria-label')) return;
      const text = button.textContent.trim();
      button.setAttribute('aria-label', text === '×' ? 'Close' : text || 'Button');
    });
  };
  const installModalFocus = () => {
    const modal = document.querySelector('#modal');
    if (!modal) return;
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
        modal.querySelector('#closeModal')?.click();
        return;
      }
      if (event.key !== 'Tab' || modal.classList.contains('hidden')) return;
      const focusable = [...modal.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(item => !item.disabled);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  };
  document.addEventListener('DOMContentLoaded', () => {
    labelIconButtons();
    installModalFocus();
    new MutationObserver(labelIconButtons).observe(document.body, { childList: true, subtree: true });
  });
})();
