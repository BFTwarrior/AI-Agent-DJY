(() => {
      try {
        // The UI token lives in an HttpOnly cookie issued by GET /ui; the page
        // must never read it or put it in a URL.
        if (!/^https?:$/.test(location.protocol)) return;
        const stream = new EventSource('/api/v1/ui/stream');
        // The daemon emits store events continuously while a team is running.
        // Reloading on every event makes the page unusable, so coalesce events,
        // wait for 15s of user idle, and cap full reloads at one per 30s.
        const RELOAD_KEY = 'agent-teams-ui-last-reload';
        const INPUT_KEY = 'agent-teams-ui-last-input';
        let lastReloadAt = Number(sessionStorage.getItem(RELOAD_KEY) || Date.now());
        let lastInputAt = Number(sessionStorage.getItem(INPUT_KEY) || 0);
        for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
          window.addEventListener(name, () => {
            lastInputAt = Date.now();
            sessionStorage.setItem(INPUT_KEY, String(lastInputAt));
          }, { passive: true, capture: true });
        }
        let timer = null;
        const scheduleRefresh = () => {
          // Throttle, not debounce: a burst of store events must not reset the
          // timer forever. The first event schedules; later events are ignored
          // until the timer fires.
          if (timer) return;
          const now = Date.now();
          const idleFor = now - lastInputAt;
          const wait = idleFor < 15000
            ? 15000 - idleFor + 100
            : Math.max(300, 30000 - (now - lastReloadAt));
          timer = setTimeout(() => {
            timer = null;
            if (document.hidden) {
              timer = setTimeout(() => {
                timer = null;
                scheduleRefresh();
              }, 5000);
              return;
            }
            if (Date.now() - lastInputAt < 15000) {
              scheduleRefresh();
              return;
            }
            sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
            location.reload();
          }, wait);
        };
        stream.addEventListener('refresh', scheduleRefresh);
      } catch {
        // Static file mode has no EventSource endpoint; keep the snapshot.
      }
    })();
