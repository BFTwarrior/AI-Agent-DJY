(() => {
  const key = 'agent-teams-theme-v1:' + location.pathname;
  let saved = null;
  try { saved = localStorage.getItem(key); } catch (error) { /* storage is optional */ }
  const theme = saved === 'light' || saved === 'dark'
    ? saved
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
})();
