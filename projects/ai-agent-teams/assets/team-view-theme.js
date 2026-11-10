(() => {
      const root = document.querySelector('#agent-teams-ui');
      const button = document.querySelector('#theme-toggle');
      if (!root || !button) return;
      const key = `agent-teams-theme-v1:${location.pathname}`;
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const effective = () => document.documentElement.dataset.theme || (media.matches ? 'dark' : 'light');
      const sync = () => {
        const dark = effective() === 'dark';
        document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
        const label = dark ? '切换到白色模式' : '切换到黑色模式';
        button.setAttribute('aria-label', label);
        button.title = label;
        const icon = button.querySelector('[data-lucide]');
        if (icon) icon.dataset.lucide = dark ? 'sun' : 'moon';
      };
      let manualChoice = false;
      const apply = (theme, persist) => {
        manualChoice = true;
        document.documentElement.dataset.theme = theme;
        if (persist) {
          try { localStorage.setItem(key, theme); } catch {}
        }
        sync();
        // The graph is inline SVG; reinsert it so every themed fill repaints
        // together with the surrounding glass surfaces.
        requestAnimationFrame(() => {
          const canvas = document.querySelector('#dag-canvas');
          const svg = canvas?.querySelector('svg');
          if (!svg) return;
          const { scrollLeft, scrollTop } = canvas;
          canvas.replaceChild(svg, svg);
          canvas.scrollLeft = scrollLeft;
          canvas.scrollTop = scrollTop;
        });
      };
      button.addEventListener('click', () => apply(effective() === 'dark' ? 'light' : 'dark', true));
      const savedTheme = () => {
        try {
          const value = localStorage.getItem(key);
          return value === 'light' || value === 'dark' ? value : null;
        } catch (error) { return null; }
      };
      const followSystem = () => {
        if (!manualChoice && !savedTheme()) document.documentElement.dataset.theme = media.matches ? 'dark' : 'light';
        sync();
      };
      if (typeof media.addEventListener === 'function') media.addEventListener('change', followSystem);
      sync();
      // Let the saved theme paint before enabling hover/selection transitions.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.documentElement.removeAttribute('data-ui-booting');
      }));
    })();
