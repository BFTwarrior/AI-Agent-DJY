(() => {
      const formatSource = (source, values) => {
        if (values == null) return String(source);
        const list = Array.isArray(values) ? values : [values];
        return String(source).replace(/\{(\d+)\}/g, (token, index) => (
          Number(index) < list.length ? String(list[Number(index)]) : token
        ));
      };
      const tr = (source, values) => {
        try {
          if (typeof window !== 'undefined' && window.AGT_I18N) return window.AGT_I18N.t(source, values);
        } catch (error) { /* fall through to the Chinese source */ }
        return formatSource(source, values);
      };
      const localizeRoot = (scope = root) => {
        try {
          if (typeof window !== 'undefined' && window.AGT_I18N) window.AGT_I18N.localize(scope);
        } catch (error) { /* localization is best-effort */ }
        return scope;
      };
      const root = document.getElementById('agent-teams-ui');
      const LIVE_MODEL = window.__AGENT_TEAMS_LIVE_MODEL__ ?? null;
      const localeSelect = root.querySelector('#locale-select');
      const syncLocaleSelect = () => {
        if (localeSelect && window.AGT_I18N) localeSelect.value = window.AGT_I18N.locale;
      };
      localeSelect?.addEventListener('change', (event) => {
        const next = event.target.value;
        if (!window.AGT_I18N?.setLocale(next)) syncLocaleSelect();
      });
      syncLocaleSelect();
      // Single source of truth for the live read-only guard. Read-only view
      // buttons opt out with data-readonly; everything here is a write action.
      const READ_ONLY_HIDDEN_SELECTOR = '[data-open-task], [data-run-mode], .toggle, #max-worker-slots, #pause-toggle, #hard-stop, #merge-approve, #merge-reject, #change-badge, #task-create, [data-mail-approve], [data-mail-reject], [data-toast]:not([data-readonly])';
      // The team count is chosen at install time and never switched at runtime.
      const singleTeam = LIVE_MODEL?.teamCount === 1;
      if (singleTeam) {
        root.dataset.teamMode = 'single';
        document.title = tr('Ai-Agent-Teams-Zcode · 单队运行控制台');
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        for (const node of textNodes) {
          if (!node.nodeValue || node.parentElement?.closest('script, style')) continue;
          node.nodeValue = node.nodeValue
            .replaceAll('双队', '单队')
            .replaceAll('B队', 'A队')
            .replace(/A队\s*\+\s*A队/gu, 'A队')
            .replace(/A队\s*(\d+)\s*\/\s*A队\s*\d+/gu, 'A队 $1')
            .replace(/同时指挥\s*2\s*队/u, '同时指挥 1 队');
        }
        root.querySelectorAll('#page-dual .team-summary').forEach((card, index) => {
          if (index > 0) card.hidden = true;
        });
        root.querySelectorAll('#page-dual .stats .stat').forEach((card, index) => {
          if (index === 1 || index === 3) card.hidden = true;
        });
        const captainJudgment = root.querySelector('#dual-captain-judgment');
        if (captainJudgment) captainJudgment.textContent = tr('A队正在推进；共享池不需要扩容');
        root.querySelectorAll('#page-dual .dual-captain-signal').forEach((signal, index) => {
          if (index === 1) signal.hidden = true;
        });
        root.querySelector('#page-dual .dual-grid')?.classList.add('single-team-grid');
        root.querySelector('#page-dual .mailbox-panel')?.setAttribute('hidden', '');
        root.querySelector('#page-dual .dual-utility-note .action-row:nth-child(2)')?.setAttribute('hidden', '');
        root.querySelector('#page-settings #risk-mail-row')?.setAttribute('hidden', '');
        const taskLegend = root.querySelector('#task-dependency-legend');
        if (taskLegend) taskLegend.textContent = tr('实线为队内依赖；虚线为队内等待依赖；拖动只调整布局，不改变任务关系');
      }
      const livePill = root.querySelector('#live-pill');
      if (livePill) {
        if (LIVE_MODEL) {
          livePill.textContent = tr('实时');
          livePill.classList.add('live');
          livePill.title = tr('实时快照 v{0}', [LIVE_MODEL.version || '']);
        } else {
          livePill.textContent = tr('静态示例');
          livePill.title = tr('未连接 daemon，显示内置示例');
        }
      }
      const pages = [...root.querySelectorAll('.page')];
      const navItems = [...root.querySelectorAll('[data-nav]')];
      const crumb = root.querySelector('#crumb-current');
      const titles = {
        overview: tr('总览'), dual: singleTeam ? tr('单队') : tr('双队'), tasks: tr('任务'), members: tr('成员'), merge: tr('审核与合并'),
        patrol: tr('巡检'), audit: tr('审计'), settings: tr('设置'),
      };
      const go = (name) => {
        if (!titles[name]) return;
        pages.forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
        navItems.forEach((item) => item.classList.toggle('active', item.dataset.nav === name));
        crumb.textContent = titles[name];
        history.replaceState(null, '', `#${name}`);
        if (name === 'tasks') {
          // The task page may have been display:none during a resize; let it
          // reposition the open detail panel once it is measurable again.
          root.dispatchEvent(new CustomEvent('agent-teams:tasks-shown'));
        }
      };
      navItems.forEach((item) => {
        const label = item.querySelector('span:not(.icon):not(.nav-badge)')?.textContent;
        if (label) { item.setAttribute('aria-label', label); item.title = label; }
        item.addEventListener('click', () => go(item.dataset.nav));
      });
      const initial = location.hash.replace('#', '');
      if (titles[initial]) go(initial);

      root.querySelectorAll('.task[data-task], tr[data-member]').forEach((item) => {
        item.tabIndex = 0;
        item.setAttribute('role', 'button');
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); item.click(); }
        });
      });

      const toast = root.querySelector('#toast');
      let toastTimer;
      const notify = (text, values) => {
        toast.textContent = tr(text, values);
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
      };
      document.addEventListener('agent-teams:patrol-result', (event) => {
        const { message, values } = event.detail ?? {};
        if (typeof message === 'string') notify(message, values);
      });
      root.querySelectorAll('[data-toast]').forEach((button) => {
        button.addEventListener('click', () => notify(button.dataset.toast));
      });

      let paused = false;
      let hardStopped = false;
      let hardStopArmed = false;
      const setPaused = (next) => {
        if (hardStopped) return;
        paused = next;
        const pill = root.querySelector('#run-pill');
        const text = root.querySelector('#run-text');
        const pauseText = root.querySelector('#pause-text');
        if (pill && text) {
          pill.classList.toggle('live', !paused);
          text.textContent = paused ? tr('已暂停') : tr('运行中');
        }
        if (pauseText) pauseText.textContent = paused ? tr('继续') : tr('暂停');
        notify(paused ? '团队已暂停，正在跑的任务会完成当前回合' : '团队已恢复运行');
      };
      const pauseToggle = root.querySelector('#pause-toggle');
      if (pauseToggle) pauseToggle.addEventListener('click', () => setPaused(!paused));

      document.addEventListener('agent-teams:patrol-result', (event) => {
        if (typeof event.detail?.message === 'string') notify(event.detail.message);
      });

      const modal = root.querySelector('#task-modal');
      const subject = root.querySelector('#task-subject');
      let modalTrigger = null;
      const openTask = () => {
        modalTrigger = document.activeElement;
        modal.hidden = false;
        setTimeout(() => subject?.focus(), 30);
      };
      const closeTask = () => {
        modal.hidden = true;
        if (modalTrigger?.isConnected) modalTrigger.focus();
        modalTrigger = null;
      };
      root.querySelectorAll('[data-open-task]').forEach((button) => button.addEventListener('click', openTask));
      root.querySelector('#task-cancel')?.addEventListener('click', closeTask);
      root.querySelector('#task-create')?.addEventListener('click', () => {
        const title = subject?.value.trim();
        const role = root.querySelector('#task-role')?.value || '工程师';
        const scope = root.querySelector('#task-scope')?.value.trim() || tr('待补充');
        const acceptance = root.querySelector('#task-acceptance')?.value.trim() || tr('待队长拆解');
        closeTask();
        if (title) addTaskNode(title, role, scope, acceptance);
        else notify('请输入任务标题');
        if (subject) subject.value = '';
        const scopeInput = root.querySelector('#task-scope');
        const acceptanceInput = root.querySelector('#task-acceptance');
        if (scopeInput) scopeInput.value = '';
        if (acceptanceInput) acceptanceInput.value = '';
      });
      modal?.addEventListener('click', (event) => { if (event.target === modal) closeTask(); });
      modal?.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab' || modal.hidden) return;
        const focusables = [...modal.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
          .filter((element) => !element.disabled && element.offsetParent !== null);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
      root.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || modal?.hidden) return;
        closeTask();
        event.stopImmediatePropagation();
      });

      const syncPendingMailUI = () => {
        const pendingLabels = ['待批准', tr('待批准')];
        const pending = [...root.querySelectorAll('[data-mail-state]')]
          .filter((state) => pendingLabels.some((label) => state.textContent.includes(label))).length;
        const count = root.querySelector('#mail-pending-count');
        if (count) count.textContent = tr('{0} 待批', [pending]);
      };
      root.querySelectorAll('[data-mail-approve], [data-mail-reject]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.mailApprove ?? button.dataset.mailReject;
          const row = root.querySelector(`[data-mail-row="${id}"]`);
          const state = row?.querySelector(`[data-mail-state="${id}"]`);
          const approved = Boolean(button.dataset.mailApprove);
          if (state) {
            state.textContent = approved ? tr('已批准 · 对方可读') : tr('已驳回 · 未投递');
            state.className = `badge ${approved ? 'mint' : 'rose'}`;
          }
          row?.querySelectorAll('[data-mail-approve], [data-mail-reject]').forEach((item) => { item.hidden = true; });
          syncPendingMailUI();
          notify(approved ? '已批准，消息已投递到对方邮箱' : '已驳回，消息未投递');
        });
      });
      syncPendingMailUI();

      const memberData = LIVE_MODEL?.memberData ?? {
        order: { initial: 'A', name: 'A-01', code: 'A-01', role: '工程师', residency: '温 · 已结算', context: '已归档 · 可复用', tasks: 'A-T2 · A-T4b · 2/2', tone: 'amber', scope: '实现、修复 · src/v1.88-modular/**', tools: '可写工作区', home: '不展示（隐私）' },
        build: { initial: 'A', name: 'A-02', code: 'A-02', role: '验证', residency: '温 · 已结算', context: '已归档 · 可复用', tasks: 'A-T3a · A-T4c · 2/2', tone: 'mint', scope: '验证 · tests/**', tools: '只读', home: '不展示（隐私）' },
        release: { initial: 'A', name: 'A-03', code: 'A-03', role: '交付', residency: '冷 · 已结算', context: '已归档 · 可复用', tasks: 'A-T7 · 2/2', tone: 'violet', scope: '文档、归档 · docs/**', tools: '只读', home: '不展示（隐私）' },
        review: { initial: 'A', name: 'A-04', code: 'A-04', role: '审核', residency: '温 · 已结算', context: '已归档 · 可复用', tasks: 'A-T4a · A-T6a · 2/2', tone: 'violet', scope: '审核、需求 · 只读', tools: '只读', home: '不展示（隐私）' },
        refactor: { initial: 'A', name: 'A-05', code: 'A-05', role: '工程师', residency: '温 · 已结算', context: '已归档 · 可复用', tasks: 'A-T1 · 1/1', tone: 'indigo', scope: '实现 · src/v1.88/**', tools: '可写工作区', home: '不展示（隐私）' },
        betaDelivery: { initial: 'B', name: 'B-01', code: 'B-01', role: '交付', residency: '温 · 在岗', context: '静态示例 · 在岗', tasks: 'B-T3b', tone: 'violet', scope: '交付', tools: '只读', home: '—' },
        betaEngineer: { initial: 'B', name: 'B-02', code: 'B-02', role: '工程师', residency: '温 · 在岗', context: '静态示例 · 在岗', tasks: 'B-T4', tone: 'indigo', scope: '实现', tools: '可写工作区', home: '—' },
      };
      // A demo scope is “固定文案 · 路径”. The whole cell resolves through a
      // string entry or a “验证 · {0}” pattern; anything left over is split so
      // a bare qualification such as 只读 never rides through untranslated.
      const localizeDemoScope = (value) => {
        const source = String(value ?? '—');
        if (LIVE_MODEL || source === '—') return source;
        const exact = tt(source);
        if (exact !== source) return exact;
        return source.split(' · ').map((part) => tt(part)).join(' · ');
      };
      const applyMember = (id) => {
        const data = memberData[id];
        if (!data) return;
        const { initial, name, code, role, residency, context, tasks, tone, scope, tools, home } = data;
        const roleLine = `${code} · ${tr(role)}`;
        const detailAvatar = root.querySelector('#detail-avatar');
        if (detailAvatar) { detailAvatar.textContent = initial; detailAvatar.className = `avatar ${tone}`; }
        root.querySelector('#detail-name') && (root.querySelector('#detail-name').textContent = name);
        root.querySelector('#detail-role') && (root.querySelector('#detail-role').textContent = roleLine);
        root.querySelector('#detail-residency') && (root.querySelector('#detail-residency').textContent = tr(residency));
        const detailBadge = root.querySelector('#page-members .member-layout > aside .panel-head .badge');
        if (detailBadge) detailBadge.textContent = LIVE_MODEL?.degraded ? tr('系统未提供')
          : data.status === 'removed' ? tr('已移除')
          : residency.startsWith('冷') || residency.includes('已结算') ? (residency.includes('已结算') ? tr('已结算') : tr('冷存'))
            : isControlMember(data) ? tr('控制席')
              : data.hasSession ? tr('在岗') : tr('无会话');
        root.querySelector('#detail-context') && (root.querySelector('#detail-context').textContent = context ? tr(context) : '—');
        root.querySelector('#detail-task') && (root.querySelector('#detail-task').textContent = tasks);
        root.querySelector('#detail-license-name') && (root.querySelector('#detail-license-name').textContent = data.license?.label ?? name);
        root.querySelector('#detail-code') && (root.querySelector('#detail-code').textContent = code);
        root.querySelector('#detail-scope') && (root.querySelector('#detail-scope').textContent = localizeDemoScope(scope));
        root.querySelector('#detail-tools') && (root.querySelector('#detail-tools').textContent = tr('工具：{0}', [tr(tools)]));
        root.querySelector('#detail-home') && (root.querySelector('#detail-home').textContent = tr(home));
      };
      root.querySelector('#change-badge')?.addEventListener('click', () => {
        const row = root.querySelector('tr.selected[data-member]');
        const memberId = row?.dataset.member;
        const data = memberData[memberId];
        if (!data) return;
        const next = window.prompt(tr('输入新的号牌（代号 {0} 不可更改）', [data.code]), data.name);
        if (!next || !next.trim()) { notify('已取消换号牌'); return; }
        const label = next.trim().slice(0, 12);
        data.name = label;
        const rowName = row.querySelector('.member-cell b');
        if (rowName) rowName.textContent = label;
        const rowAvatar = row.querySelector('.member-cell .avatar');
        if (rowAvatar) rowAvatar.textContent = label.slice(0, 1);
        const detailName = root.querySelector('#detail-name');
        const licenseName = root.querySelector('#detail-license-name');
        const detailAvatar = root.querySelector('#detail-avatar');
        if (detailName) detailName.textContent = label;
        if (licenseName) licenseName.textContent = label;
        if (detailAvatar) detailAvatar.textContent = label.slice(0, 1);
        notify(tr('号牌已更换为 {0}，代号 {1} 不变', [label, data.code]));
      });

      root.querySelectorAll('[data-member]').forEach((row) => {
        row.addEventListener('click', () => {
          root.querySelectorAll('[data-member]').forEach((item) => item.classList.toggle('selected', item === row));
          applyMember(row.dataset.member);
        });
      });

      const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[char]));

      const isColdMember = (member) => ['cold', 'unspawned', 'settled', 'removed', 'lost'].includes(String(member.residency ?? '').toLowerCase())
        || ['cold', 'unspawned', 'settled', 'removed', 'lost'].includes(member.status);
      // Kept inside this block because the capacity tests execute the slice in
      // isolation. Without the browser runtime it falls back to the Chinese
      // source, which is also the zh-CN translation.
      const tt = (source, values) => {
        try {
          if (typeof window !== 'undefined' && window.AGT_I18N) return window.AGT_I18N.t(source, values);
        } catch (error) { /* fall through to the Chinese source */ }
        if (values == null) return String(source);
        const list = Array.isArray(values) ? values : [values];
        return String(source).replace(/\{(\d+)\}/g, (token, index) => (
          Number(index) < list.length ? String(list[Number(index)]) : token
        ));
      };
      const timestamp = (value) => {
        try {
          if (typeof window !== 'undefined' && window.AGT_I18N) return window.AGT_I18N.formatTime(value);
        } catch (error) { /* fall through to the Chinese locale */ }
        return new Date(value == null ? Date.now() : value).toLocaleTimeString(undefined, { hour12: false });
      };
      // The live model renders role labels, so a lead arrives as “组长”; fall
      // back to the raw license role key so control seats are never counted as
      // delivery workers or as “no session” seats.
      const CONTROL_MEMBER_ROLES = new Set(['captain', 'lead', 'shadow', '队长', '组长']);
      const isControlMember = (member) => [member.role, member.license?.roleKey].some((role) => (
        CONTROL_MEMBER_ROLES.has(String(role ?? '').trim().toLowerCase())
      ));
      const activeMemberCount = (members) => members.filter((member) => (
        LIVE_MODEL ? member.hasSession && !isControlMember(member) : !isColdMember(member)
      )).length;
      // Off-duty seats are split into exclusive buckets; control sessions stay
      // separate from “no session” and the total still matches offDuty.
      const memberDutyCounts = (members) => {
        const active = activeMemberCount(members);
        const offDuty = members.length - active;
        const cold = members.filter((member) => isColdMember(member)).length;
        const control = LIVE_MODEL
          ? members.filter((member) => isControlMember(member) && !isColdMember(member)).length
          : 0;
        const noSession = Math.max(0, offDuty - cold - control);
        return { active, offDuty, cold, control, noSession };
      };
      const memberDutyFoot = ({ noSession, control, cold }) => [
        tt('无会话 {0}', [noSession]),
        control > 0 ? tt('控制席 {0}', [control]) : '',
        tt('冷存/待创建 {0}', [cold]),
      ].filter(Boolean).join(' · ');
      const capacityKey = `agent-teams-worker-capacity-v1:${location.pathname}`;
      const clampWorkerCapacity = (value, fallback = 6) => {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const numericValue = Number(value);
        return Number.isFinite(numericValue)
          ? Math.max(1, Math.min(32, Math.round(numericValue)))
          : fallback;
      };
      const configuredWorkerCapacity = LIVE_MODEL?.workerCapacity;
      // Live limits are snapshot facts; the demo input keeps its own 1..32 range.
      const snapshotCapacity = typeof configuredWorkerCapacity === 'number'
        ? configuredWorkerCapacity
        : typeof configuredWorkerCapacity === 'string' && configuredWorkerCapacity.trim()
          ? Number(configuredWorkerCapacity) : NaN;
      let workerCapacity = LIVE_MODEL
        ? Number.isInteger(snapshotCapacity) && snapshotCapacity >= 1 && snapshotCapacity <= 64 ? snapshotCapacity : null
        : clampWorkerCapacity(configuredWorkerCapacity);
      if (!LIVE_MODEL) {
        try {
          const rawCapacity = localStorage.getItem(capacityKey);
          const storedCapacity = rawCapacity === null || rawCapacity.trim() === ''
            ? NaN
            : Number(rawCapacity);
          workerCapacity = clampWorkerCapacity(storedCapacity, workerCapacity);
        } catch (error) { /* local storage is optional */ }
      }
      const contractorCardCount = root.querySelectorAll('#page-overview .worker-card.contractor').length;
      const configuredContractorCapacity = LIVE_MODEL?.contractorCapacity
        ?? LIVE_MODEL?.contractorsCapacity
        ?? LIVE_MODEL?.contractorSlots?.total;
      const contractorCapacity = LIVE_MODEL && configuredContractorCapacity == null
        ? null
        : Math.max(
          0,
          Math.min(
            16,
            Math.round(Number(configuredContractorCapacity ?? contractorCardCount) || 0),
          ),
        );
      const contractorData = LIVE_MODEL?.contractors ?? [];
      const activeContractorStatuses = ['starting', 'running', 'cancelling', 'cleanup_error'];
      const activeContractorCount = () => contractorData.filter((contractor) => activeContractorStatuses.includes(contractor.status)).length;
      const contractorSlotCount = (slot) => contractorData.filter((contractor) => contractor.slot === slot && activeContractorStatuses.includes(contractor.status)).length;
      const syncCapacityUI = () => {
        const members = LIVE_MODEL?.memberList ?? [];
        const workerOnDuty = (member) => member.hasSession && !isControlMember(member);
        const activeMembers = LIVE_MODEL
          ? members.filter(workerOnDuty)
          : [...root.querySelectorAll('#page-overview .worker-card:not(.contractor)')];
        const activeCount = activeMembers.length;
        const alpha = LIVE_MODEL ? activeMembers.filter((member) => member.teamKey === 'alpha').length : 4;
        const beta = LIVE_MODEL ? activeMembers.filter((member) => member.teamKey === 'beta').length : 2;
        const assignment = singleTeam ? tt('A队 {0}', [alpha]) : tt('A队 {0} · B队 {1}', [alpha, beta]);
        const setCapacityText = (selector, text) => { const element = root.querySelector(selector); if (element) element.textContent = text; };
        const rosterCount = LIVE_MODEL ? members.length : Object.keys(memberData).length;
        setCapacityText('#settings-worker-capacity', workerCapacity == null ? tt('待快照') : String(workerCapacity));
        setCapacityText('#settings-assignment', assignment);
        const overCapacity = workerCapacity != null && activeCount > workerCapacity;
        setCapacityText('#overview-worker-current', LIVE_MODEL?.degraded ? `— / ${workerCapacity ?? '—'}` : `${activeCount} / ${workerCapacity ?? '—'}`);
        setCapacityText('#overview-worker-badge', workerCapacity == null ? tt('并发上限待快照') : tt('在岗 / 并发上限'));
        const degradedFoot = LIVE_MODEL?.degraded ? ` ${tt('· 快照未提供会话状态')}` : '';
        setCapacityText('#overview-worker-foot', tt('{0} · 名册 {1} 人{2}{3}', [
          assignment,
          rosterCount,
          degradedFoot,
          overCapacity ? ` ${tt('· 超出上限 {0} 人', [activeCount - workerCapacity])}` : '',
        ]));
        const capacityBadge = root.querySelector('#overview-worker-badge');
        capacityBadge?.classList.toggle('amber', overCapacity);
        capacityBadge?.classList.toggle('mint', !overCapacity);
        const activeContractors = LIVE_MODEL ? activeContractorCount() : contractorCardCount;
        const contractorTotal = contractorCapacity ?? contractorData.length;
        const contractorFoot = LIVE_MODEL
          ? tt('合并位 {0} · 巡检位 {1}', [contractorSlotCount('merge'), contractorSlotCount('patrol') + contractorSlotCount('main')])
          : tt('合并位 1/1 · 巡检位 1/1');
        setCapacityText('#overview-contractor-current', `${activeContractors} / ${contractorCapacity == null ? '—' : contractorCapacity}`);
        setCapacityText('#overview-contractor-foot', `${contractorFoot} · ${contractorCapacity == null ? tt('总位待快照') : tt('当前运行 / 总位')}`);
        const contractorBar = root.querySelector('#overview-contractor-bar');
        if (contractorBar) contractorBar.style.width = `${contractorTotal ? Math.min(100, Math.round((activeContractors / contractorTotal) * 100)) : 0}%`;
        const workerCapacityLabel = workerCapacity == null ? tt('队员容量待快照') : tt('{0} 并发', [workerCapacity]);
        const contractorCapacityLabel = contractorCapacity == null ? tt('外包位待快照') : tt('{0} 外包位', [contractorCapacity]);
        setCapacityText('#team-pill', `${workerCapacityLabel} · ${contractorCapacityLabel}`);
        const input = root.querySelector('#max-worker-slots');
        if (input) {
          input.value = workerCapacity == null ? '' : String(workerCapacity);
          input.title = LIVE_MODEL ? workerCapacity == null ? tt('实时快照未提供队员并发上限') : tt('实时快照只读') : tt('静态预览可调整队员并发上限');
        }
        const overviewBar = root.querySelector('#overview-worker-bar');
        if (overviewBar) {
          overviewBar.style.width = `${workerCapacity == null ? 0 : Math.min(100, Math.round((activeCount / workerCapacity) * 100))}%`;
          overviewBar.title = workerCapacity == null ? tt('并发上限待快照') : tt('当前在岗 {0} 人，并发上限 {1} 人', [activeCount, workerCapacity]);
        }
      };
      const setWorkerCapacity = (value) => {
        if (LIVE_MODEL || value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) {
          syncCapacityUI();
          return;
        }
        const next = clampWorkerCapacity(value, workerCapacity);
        workerCapacity = next;
        try { localStorage.setItem(capacityKey, String(next)); } catch (error) { /* local storage is optional */ }
        const input = root.querySelector('#max-worker-slots');
        if (input) input.value = String(next);
        syncCapacityUI();
        notify(tt('队员并发上限已切换为 {0}', [next]));
      };
      root.querySelector('#max-worker-slots')?.addEventListener('change', (event) => setWorkerCapacity(event.target.value));
      syncCapacityUI();

      const demoMemberRows = [...root.querySelectorAll('#page-members tbody tr[data-member]')];
      const demoMemberList = LIVE_MODEL ? [] : Object.entries(memberData).map(([key, data]) => {
        const row = demoMemberRows.find((item) => item.dataset.member === key);
        const cold = data.residency.startsWith('冷');
        return {
          key, get name() { return data.name; }, code: data.code, role: data.role, tone: data.tone,
          teamKey: data.code.startsWith('B-') ? 'beta' : 'alpha',
          team: data.code.startsWith('B-') ? 'B队' : 'A队',
          residency: cold ? 'cold' : 'warm', status: cold ? 'cold' : 'warm',
          hasSession: !cold,
          settled: data.residency.includes('已结算'), readOnly: data.tools === '只读',
          task: row?.cells[3]?.textContent?.trim() || data.tasks,
          progress: Number.parseFloat(row?.querySelector('.mini-track i')?.style.width ?? '0') || 0,
          progressText: row?.querySelector('td:last-child .tiny')?.textContent ?? '—',
        };
      });
      let memberTeamFilter = 'all';
      const renderMembers = () => {
        // Theme changes presentation only; both themes share the same roster/filter.
        const filter = !singleTeam ? memberTeamFilter : 'all';
        root.querySelectorAll('[data-member-team-filter]').forEach((button) => {
          button.setAttribute('aria-pressed', String(button.dataset.memberTeamFilter === filter));
          button.hidden = singleTeam && button.dataset.memberTeamFilter === 'beta';
        });
        const allMembers = LIVE_MODEL?.memberList ?? demoMemberList;
        const members = allMembers.filter((member) => filter === 'all' || member.teamKey === filter);
        const tbody = root.querySelector('#page-members tbody');
        if (!tbody) return;
        const selectedKey = tbody.querySelector('tr.selected[data-member]')?.dataset.member;
        tbody.replaceChildren();
        for (const member of members) {
          const rowEl = document.createElement('tr');
          rowEl.dataset.member = member.key;
          const cold = isColdMember(member);
          const statusColor = cold ? 'var(--faint)' : member.hasSession ? 'var(--mint)' : 'var(--amber)';
          const statusText = LIVE_MODEL?.degraded ? tt('系统未提供')
            : member.residency === 'cold' ? '冷'
            : member.residency === 'settled' || member.status === 'settled' ? tt('已结算')
              : member.residency === 'unspawned' || member.status === 'unspawned' ? tt('待创建')
                : cold ? '冷' : isControlMember(member) ? '控制席' : member.hasSession ? tt('在岗') : tt('无会话');
          const badgeTone = member.teamKey === 'alpha' ? 'indigo' : 'mint';
          rowEl.innerHTML = `<td><div class="member-cell"><div class="avatar ${escapeHtml(member.tone)}" data-i18n-skip>${escapeHtml(member.name.slice(0, 1))}</div><div><b data-i18n-skip>${escapeHtml(member.name)}</b><span class="code">${escapeHtml(member.code)}</span></div></div></td><td><span class="badge ${badgeTone}">${escapeHtml(tt(member.role))}</span><div class="tiny muted">${escapeHtml(tt(member.team))}</div></td><td><span class="dot" style="background:${statusColor}"></span> ${tt(statusText)}</td><td data-i18n-skip>${escapeHtml(member.task)}</td><td><div class="mini-track"><i style="width:${member.progress}%"></i></div><div class="tiny muted" data-i18n-skip>${escapeHtml(member.progressText)}</div></td>`;
          rowEl.tabIndex = 0;
          rowEl.setAttribute('role', 'button');
          rowEl.addEventListener('click', () => {
            tbody.querySelectorAll('tr').forEach((row) => row.classList.toggle('selected', row === rowEl));
            applyMember(member.key);
          });
          rowEl.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            rowEl.click();
          });
          tbody.appendChild(rowEl);
        }
        if (members.length === 0) {
          const rowEl = document.createElement('tr');
          rowEl.innerHTML = `<td colspan="5">${filter === 'beta' ? tt('B队暂无成员') : filter === 'alpha' ? tt('A队暂无成员') : tt('暂无成员')}</td>`;
          tbody.appendChild(rowEl);
          const blank = (selector) => {
            const element = root.querySelector(selector);
            if (element) element.textContent = '—';
          };
          blank('#detail-name');
          blank('#detail-role');
          const role = root.querySelector('#detail-role');
          if (role) role.textContent = tt('暂无成员');
          for (const selector of ['#detail-residency', '#detail-context', '#detail-task', '#detail-license-name', '#detail-code', '#detail-scope', '#detail-home']) blank(selector);
          const tools = root.querySelector('#detail-tools');
          if (tools) tools.textContent = tt('工具：—');
          const avatar = root.querySelector('#detail-avatar');
          if (avatar) { avatar.textContent = '—'; avatar.className = 'avatar'; }
          const badge = root.querySelector('#page-members .panel-head .badge');
          if (badge) badge.textContent = tt('{0} 成员', [0]);
        } else {
          const first = [...tbody.querySelectorAll('tr[data-member]')].find((row) => row.dataset.member === selectedKey) ?? tbody.querySelector('tr');
          if (first) {
            first.classList.add('selected');
            applyMember(first.dataset.member);
          }
        }
        const { active, offDuty, cold, control, noSession } = memberDutyCounts(members);
        const dutyFoot = memberDutyFoot({ noSession, control, cold });
        const settled = members.filter((member) => member.settlement?.settled === true || member.status === 'settled').length;
        const readOnly = members.filter((member) => member.readOnly).length;
        const stats = [...root.querySelectorAll('#page-members .stats .stat')];
        const setStat = (index, value, foot, ratio) => {
          const stat = stats[index];
          if (!stat) return;
          const valueEl = stat.querySelector('.stat-value');
          if (valueEl) valueEl.textContent = String(value);
          const footEl = stat.querySelector('.stat-foot');
          if (footEl) footEl.textContent = foot;
          const bar = stat.querySelector('.stat-track i');
          if (bar) bar.style.width = `${members.length ? Math.round(ratio) : 0}%`;
        };
        const alpha = members.filter((member) => member.teamKey === 'alpha').length;
        const beta = members.filter((member) => member.teamKey === 'beta').length;
        const memberTeamFoot = filter === 'alpha' || singleTeam ? tt('A队 {0} 人', [alpha]) : filter === 'beta' ? tt('B队 {0} 人', [beta]) : tt('A队 {0} 人 · B队 {1} 人', [alpha, beta]);
        const sourceLabel = LIVE_MODEL ? tt('实时') : tt('静态示例');
        const degraded = LIVE_MODEL?.degraded === true;
        const scopeLabel = filter === 'all' ? (singleTeam ? tt('A队') : tt('双队')) : filter === 'alpha' ? tt('A队') : tt('B队');
        setStat(0, members.length, tt('{0}（{1}）', [memberTeamFoot, sourceLabel]), 100);
        setStat(1, degraded ? '— / —' : `${active} / ${offDuty}`, degraded
          ? `${scopeLabel}${tt('当前状态 · 系统未提供会话状态')}`
          : tt(`${scopeLabel}当前状态 · ${dutyFoot}`), degraded ? 0 : (active / Math.max(members.length, 1)) * 100);
        const activeCountEl = stats[1]?.querySelector('[data-member-active]');
        const coldCountEl = stats[1]?.querySelector('[data-member-cold]');
        if (activeCountEl) activeCountEl.textContent = degraded ? '—' : String(active);
        if (coldCountEl) coldCountEl.textContent = degraded ? '—' : String(offDuty);
        setStat(2, settled, tt('系统按结算状态处理'), (settled / Math.max(members.length, 1)) * 100);
        setStat(3, readOnly, tt('验证 / 审核 / 交付'), (readOnly / Math.max(members.length, 1)) * 100);
        const navBadge = root.querySelector('[data-nav="members"] .nav-badge');
        if (navBadge) navBadge.textContent = String(allMembers.length);
        const headP = root.querySelector('#page-members .page-head p');
        if (headP) headP.textContent = degraded
          ? tt('{0} · {1} · 系统未提供会话状态', [sourceLabel, memberTeamFoot])
          : tt(`${sourceLabel} · ${memberTeamFoot} · 在岗 ${active} 人 · 未在岗 ${offDuty} 人（${dutyFoot}）`);
      };

      const renderLiveWorkforce = () => {
        if (!LIVE_MODEL) return;
        const members = LIVE_MODEL.memberList ?? [];
        const grid = root.querySelector('#page-overview .workforce-grid');
        if (!grid) return;
        const contractorCards = [...grid.querySelectorAll('.worker-card.contractor')];
        const slotActive = (slot) => contractorSlotCount(slot);
        const slotQueued = (slot) => contractorData.filter((contractor) => contractor.slot === slot && contractor.status === 'queued').length;
        contractorCards.forEach((card, index) => {
          const slot = index === 0 ? 'merge' : 'patrol';
          // The default config names the patrol slot `main`; `patrol` is the
          // public alias. Count both so the card matches the slot footer.
          const active = index === 0 ? slotActive('merge') : slotActive('patrol') + slotActive('main');
          const queued = index === 0
            ? slotQueued('merge')
            : slotQueued('patrol') + slotQueued('main');
          const title = card.querySelector('.worker-main b');
          if (title) title.textContent = index === 0 ? tt('外包 01 · 合并位') : tt('外包 02 · 巡检位');
          const spans = card.querySelectorAll('.worker-main span');
          if (spans[0]) spans[0].textContent = active ? `${tt('{0} 个运行中', [active])}${queued ? ` · ${tt('{0} 排队', [queued])}` : ''}` : (queued ? tt('{0} 排队', [queued]) : tt('预留位 · 当前空闲'));
          if (spans[1]) spans[1].textContent = `${tt('实时')} · ${slot === 'merge' ? tt('合并位') : tt('巡检位')}`;
        });
        const anchor = contractorCards[0] ?? null;
        grid.querySelectorAll('.worker-card:not(.contractor)').forEach((card) => card.remove());
        const visibleMembers = members.filter((member) => member.hasSession || member.status === 'working');
        for (const member of visibleMembers) {
          const cold = isColdMember(member);
          const status = LIVE_MODEL?.degraded ? tt('会话状态未提供')
            : cold
              ? (member.residency === 'unspawned' || member.status === 'unspawned' ? tt('待创建')
                : member.residency === 'settled' || member.status === 'settled' ? tt('已结算') : tt('冷存'))
              : isControlMember(member) ? '控制席'
                : (member.hasSession ? tt('在岗') : tt('无会话'));
          const tone = cold ? 'var(--faint)'
            : member.hasSession ? 'var(--mint)'
              : member.status === 'working' ? 'var(--indigo)' : 'var(--amber)';
          const card = document.createElement('div');
          card.className = 'worker-card';
          card.innerHTML = `<div class="avatar ${escapeHtml(member.tone)}" data-i18n-skip>${escapeHtml(member.name.slice(0, 1))}</div><div class="worker-main"><b data-i18n-skip>${escapeHtml(member.name)} <i class="code">${escapeHtml(member.code)}</i></b><span>${escapeHtml(tt(member.team))} · ${escapeHtml(tt(member.role))} · ${tt(status)}</span><span class="worker-task" data-i18n-skip>${escapeHtml(member.task)}</span></div><span class="dot" style="background:${tone}"></span>`;
          if (anchor) grid.insertBefore(card, anchor);
          else grid.appendChild(card);
        }
        const mailbox = LIVE_MODEL.mailbox ?? [];
        const mailboxUnknown = LIVE_MODEL.mailbox == null;
        const approvalNote = root.querySelector('#approval-note');
        if (approvalNote) approvalNote.textContent = mailboxUnknown ? tt('系统未提供待审批状态')
          : mailbox.length ? tt('系统待审批 {0} 条跨队消息', [mailbox.length]) : tt('当前没有待审批的跨队消息');
        const approvalCount = root.querySelector('#approval-count');
        if (approvalCount) {
          approvalCount.textContent = mailboxUnknown ? tt('系统未提供') : mailbox.length ? tt('{0} 条', [mailbox.length]) : tt('正常');
          approvalCount.className = `badge ${mailboxUnknown ? 'faint' : mailbox.length ? 'amber' : 'mint'}`;
        }
        const approvalList = root.querySelector('#page-overview .action-list');
        if (approvalList) {
          approvalList.innerHTML = mailboxUnknown
            ? `<div class="action-row" id="approval-empty-row"><div class="icon" style="color:var(--faint)"><span class="icon" data-lucide="mail"></span></div><div class="action-main"><b>${tt('系统未提供待审批状态')}</b><span>${tt('快照不包含邮箱数据，控制台不做“没有消息”的推断。')}</span></div><span class="badge faint">${tt('未知')}</span></div>`
            : mailbox.length
              ? mailbox.slice(0, 4).map((message) => `<div class="action-row"><div class="icon" style="color:var(--amber)"><span class="icon" data-lucide="mail"></span></div><div class="action-main"><b data-i18n-skip>${escapeHtml(message.from ?? '—')} → ${escapeHtml(message.to ?? '—')} · ${escapeHtml((message.content ?? '').slice(0, 80))}</b><span>${escapeHtml(message.fromTeamId ?? '—')} → ${escapeHtml(message.toTeamId ?? '—')} · ${tt('系统待审批')}</span></div><span class="badge amber">${tt('系统处理中')}</span></div>`).join('')
              : `<div class="action-row" id="approval-empty-row"><div class="icon" style="color:var(--mint)"><span class="icon" data-lucide="check-circle-2"></span></div><div class="action-main"><b>${tt('当前没有待审批的跨队消息')}</b><span>${tt('系统会在需要队长判断时自动进入邮箱。')}</span></div><span class="badge mint">${tt('正常')}</span></div>`;
        }
        const mailboxBadge = root.querySelector('#mailbox-mode-badge');
        if (mailboxBadge) mailboxBadge.textContent = mailboxUnknown ? tt('系统未提供') : tt('系统自动');
        const mailboxCount = root.querySelector('#mail-pending-count');
        if (mailboxCount) mailboxCount.textContent = mailboxUnknown ? '—' : mailbox.length ? tt('{0} 待批', [mailbox.length]) : tt('无待批');
        const mailboxHint = root.querySelector('#mail-mode-hint');
        if (mailboxHint) mailboxHint.textContent = tt('规则：A/B 只能通过邮箱联系；跨队消息由系统提交队长判断，未批准的消息对方不可见。控制台只展示状态，不提供人工审批。');
        const mailboxContent = root.querySelector('#page-dual .mailbox-content .action-list');
        if (mailboxContent) {
          mailboxContent.innerHTML = mailboxUnknown
            ? `<div class="action-row"><div class="icon" style="color:var(--faint)"><span data-lucide="mail"></span></div><div class="action-main"><b>${tt('系统未提供邮箱状态')}</b><span>${tt('快照不包含待审批消息。')}</span></div><span class="badge faint">${tt('未知')}</span></div>`
            : mailbox.length
              ? mailbox.slice(0, 6).map((message) => `<div class="action-row"><div class="icon" style="color:var(--indigo)"><span data-lucide="message-square"></span></div><div class="action-main"><b data-i18n-skip>${escapeHtml(message.fromTeamId ?? '—')} → ${escapeHtml(message.toTeamId ?? '—')} · ${escapeHtml((message.content ?? '').slice(0, 80))}</b><span>${escapeHtml(message.from ?? '—')} → ${escapeHtml(message.to ?? '—')} · ${tt('系统待审批')}</span></div><span class="badge amber">${tt('系统处理中')}</span></div>`).join('')
              : `<div class="action-row"><div class="icon" style="color:var(--mint)"><span data-lucide="check-circle-2"></span></div><div class="action-main"><b>${tt('当前没有待审批消息')}</b><span>${tt('跨队消息由系统自动提交队长判断。')}</span></div><span class="badge mint">${tt('正常')}</span></div>`;
        }
        const activityBadge = root.querySelector('#captain-activity-badge');
        if (activityBadge) activityBadge.textContent = tt('实时事件');
        const activityHead = activityBadge?.closest('.panel-head');
        const activityMuted = activityHead?.querySelector('.muted');
        if (activityMuted) activityMuted.textContent = tt('最近 4 条 · 来自系统事件');
        const captainBadge = root.querySelector('#captain-signal-badge');
        if (captainBadge) captainBadge.textContent = LIVE_MODEL.shadow?.active ? tt('shadow 协助中') : tt('系统自动判断');
        const activityList = root.querySelector('#captain-activity-list');
        if (activityList) {
          const events = (LIVE_MODEL.events ?? []).slice(-4).reverse();
          const eventsUnknown = LIVE_MODEL.events == null;
          const labels = {
            'team.created': '队伍创建', 'task.created': '任务创建', 'task.completed': '任务完成',
            'task.failed': '任务失败', 'member.relicensed': '号牌变更', 'member.added': '成员加入',
            'message.cross_team_pending': '跨队消息待审', 'patrol.finding': '巡检发现',
            'merge.clean': '合并完成', 'merge.conflict': '合并冲突',
          };
          const statusLabels = { completed: '完成', settled: '已结算', pending: '待处理', failed: '失败' };
          const displayByTaskId = new Map((LIVE_MODEL.dagTasks ?? []).map((task) => [task.id, task.displayId]));
          activityList.innerHTML = eventsUnknown
            ? `<div class="tl-row"><span class="tl-dot"></span><div><b>${tt('系统未提供事件数据')}</b><span>${tt('快照不包含审计事件，控制台不做“没有事件”的推断。')}</span></div><span class="badge faint">${tt('未知')}</span></div>`
            : events.length
            ? events.map((event) => {
              const object = displayByTaskId.get(event.data?.taskId)
                ?? (LIVE_MODEL.memberList ?? []).find((member) => member.id === event.data?.memberId)?.name
                ?? '—';
              const result = statusLabels[event.data?.status] ?? event.data?.status ?? '记录';
              return `<div class="tl-row"><span class="tl-dot done"></span><div><b>${escapeHtml(tt(labels[event.type] ?? event.type ?? '事件'))}${object !== '—' ? ` · ${escapeHtml(object)}` : ''}</b><span>${timestamp(event.createdAt ?? Date.now())} · ${tt('系统事件')}</span></div><span class="badge">${escapeHtml(tt(String(result)))}</span></div>`;
            }).join('')
            : `<div class="tl-row"><span class="tl-dot"></span><div><b>${tt('暂无实时事件')}</b><span>${tt('系统事件会出现在这里。')}</span></div><span class="badge">—</span></div>`;
        }
        const pool = root.querySelector('#dual-pool-list');
        if (pool) {
          const poolRows = members.map((member) => {
            const status = LIVE_MODEL?.degraded ? tt('会话状态未提供')
              : isColdMember(member)
                ? (member.residency === 'unspawned' || member.status === 'unspawned' ? tt('待创建') : tt('冷存'))
                : isControlMember(member) ? tt('控制席')
                  : (member.hasSession ? tt('在岗') : tt('无会话'));
            const tone = escapeHtml(member.tone ?? 'indigo');
            const dot = LIVE_MODEL?.degraded ? 'var(--faint)' : isColdMember(member) ? 'var(--faint)' : (member.hasSession ? 'var(--mint)' : 'var(--amber)');
            return `<div class="pool-row"><div class="avatar ${tone}" data-i18n-skip>${escapeHtml(String(member.name ?? '').slice(0, 1))}</div><div class="pool-main"><b data-i18n-skip>${escapeHtml(member.name)} <i class="code">${escapeHtml(member.code)}</i></b><span>${escapeHtml(tt(member.team))} · ${escapeHtml(tt(member.role))} · ${escapeHtml(status)}</span></div><span class="dot" style="background:${dot}"></span></div>`;
          });
          const contractors = contractorData.map((contractor, index) => `<div class="pool-row contractor"><div class="avatar ${index % 2 ? 'mint' : 'violet'}" data-i18n-skip>外</div><div class="pool-main"><b>${tt('外包 {0} · {1}', [String(index + 1).padStart(2, '0'), contractor.slot === 'merge' ? tt('合并位') : tt('巡检位')])}</b><span>${escapeHtml(tt(contractor.status ?? '实时'))} · ${tt('一次性')}</span></div><span class="badge amber">${tt('外包')}</span></div>`);
          pool.innerHTML = [...poolRows, ...contractors].join('') || `<div class="pool-note">${tt('实时快照暂无共享池成员。')}</div>`;
        }
      };

      const renderLiveTeamCards = () => {
        if (!LIVE_MODEL) return;
        const cards = [...root.querySelectorAll('#page-dual .team-summary')];
        const taskStatus = { done: '已完成', active: '进行中', waiting: '等待', queued: '排队', failed: '失败', cancelled: '已取消' };
        const phaseLabel = { staged: '待审核', running: '运行中', archived: '已归档', halted: '已暂停' };
        const meta = LIVE_MODEL.teamMeta ?? [];
        const setText = (selector, value) => { const element = root.querySelector(selector); if (element) element.textContent = value; };
        const setBar = (selector, value, denominator) => {
          const element = root.querySelector(selector);
          if (element) element.style.width = `${denominator > 0 ? Math.min(100, Math.round((value / denominator) * 100)) : 0}%`;
        };
        cards.forEach((card, index) => {
          const teamKey = index === 0 ? 'alpha' : 'beta';
          const tasks = (LIVE_MODEL.dagTasks ?? []).filter((task) => task.team === teamKey);
          const teamMeta = meta[index] ?? null;
          const rows = [...card.querySelectorAll('.mini-task')];
          const subtitle = card.querySelector('.team-title span');
          if (subtitle) {
            // Rebuild the full line on every refresh; appending the truncation
            // suffix here would duplicate it when the live model repaints.
            const phase = tt(phaseLabel[teamMeta?.phase] ?? teamMeta?.phase ?? '未知阶段');
            const control = tt(teamMeta?.control === 'halted' ? '调度已暂停' : '调度正常');
            const base = teamMeta
              ? `${phase} · ${control} · ${tt('{0} 名在岗', [teamMeta.capacity?.activeWorkers ?? '—'])}`
              : tt('实时任务列表 · 按需借调');
            subtitle.textContent = tasks.length > rows.length
              ? tt(`${base} · 仅显示前 ${rows.length} 条`)
              : base;
          }
          const titleBadge = card.querySelector('.team-title .badge');
          if (titleBadge && teamMeta) {
            titleBadge.textContent = tt(phaseLabel[teamMeta.phase] ?? teamMeta.phase ?? '—');
            titleBadge.className = `badge ${teamMeta.phase === 'running' ? 'mint' : teamMeta.phase === 'halted' ? 'amber' : ''}`.trim();
          }
          rows.forEach((row, rowIndex) => {
            const task = tasks[rowIndex];
            if (!task) { row.style.display = 'none'; return; }
            row.style.display = '';
            const title = row.querySelector('.mini-task-main b');
            const owner = row.querySelector('.mini-task-main span');
            const badge = row.querySelector('.badge');
            if (title) { title.setAttribute('data-i18n-skip', ''); title.textContent = `${task.displayId} ${task.subject}`; }
            if (owner) { owner.setAttribute('data-i18n-skip', ''); owner.textContent = task.owner; }
            if (badge) badge.textContent = tt(taskStatus[task.status] ?? '等待');
          });
        });
        const allTasks = LIVE_MODEL.dagTasks ?? [];
        const total = allTasks.length;
        const done = allTasks.filter((task) => task.status === 'done').length;
        const waiting = allTasks.filter((task) => task.status === 'waiting').length;
        setText('#dual-total', String(total));
        setText('#dual-total-foot', tt('A队 {0} · B队 {1}', [allTasks.filter((task) => task.team === 'alpha').length, allTasks.filter((task) => task.team === 'beta').length]));
        setText('#cross-team-link-count', String((LIVE_MODEL.crossLinks ?? []).length || '—'));
        setText('#cross-team-link-foot', LIVE_MODEL.crossLinks?.length ? tt('后端提供的跨队依赖') : tt('系统未提供跨队连线'));
        const alphaTasks = allTasks.filter((task) => task.team === 'alpha');
        const betaTasks = allTasks.filter((task) => task.team === 'beta');
        setText('#dual-alpha-summary', String(alphaTasks.filter((task) => task.status === 'waiting').length));
        setText('#dual-beta-summary', String(betaTasks.filter((task) => task.status === 'waiting').length));
        setText('#dual-alpha-progress', `${alphaTasks.filter((task) => task.status === 'done').length}/${alphaTasks.length}`);
        setText('#dual-beta-progress', `${betaTasks.filter((task) => task.status === 'done').length}/${betaTasks.length}`);
        setBar('#dual-alpha-bar', alphaTasks.filter((task) => task.status === 'done').length, alphaTasks.length);
        setBar('#dual-beta-bar', betaTasks.filter((task) => task.status === 'done').length, betaTasks.length);
        const judgment = root.querySelector('#dual-captain-judgment');
        if (judgment) {
          judgment.textContent = meta.length
            ? tt('系统调度：共 {0} 个任务，{1} 个完成，{2} 个等待依赖；并发上限 {3}。', [total, done, waiting, LIVE_MODEL.workerCapacity ?? '—'])
            : tt('系统未提供队伍阶段数据。');
        }
        const signals = [...root.querySelectorAll('#page-dual .dual-captain-signal b')];
        if (signals[0]) signals[0].textContent = meta[0] ? tt(phaseLabel[meta[0].phase] ?? meta[0].phase ?? '—') : '—';
        if (signals[1]) signals[1].textContent = meta[1] ? tt(phaseLabel[meta[1].phase] ?? meta[1].phase ?? '—') : '—';
        if (signals[2]) {
          const active = (meta[0]?.capacity?.activeWorkers ?? 0) + (meta[1]?.capacity?.activeWorkers ?? 0);
          const cap = LIVE_MODEL.workerCapacity;
          signals[2].textContent = cap == null ? tt('系统未提供') : active >= cap ? tt('已满载') : tt('可用 {0}', [cap - active]);
        }
      };

      const renderLiveStaticPanels = () => {
        if (!LIVE_MODEL) return;
        const meta = LIVE_MODEL.teamMeta ?? [];
        const primary = meta[0] ?? null;
        const patrol = primary?.patrol ?? null;
        const findings = LIVE_MODEL.findings ?? [];
        const findingsUnknown = LIVE_MODEL.findings == null;
        const events = LIVE_MODEL.events ?? [];
        const eventsUnknown = LIVE_MODEL.events == null;
        const tasks = LIVE_MODEL.dagTasks ?? [];
        const members = LIVE_MODEL.memberList ?? [];
        const mergeQueue = LIVE_MODEL.mergeQueue ?? [];
        const mergeQueueUnknown = LIVE_MODEL.mergeQueue == null;
        const patrolState = root.querySelector('#patrol-state');
        if (patrolState) {
          const label = patrol?.inFlight ? tt('巡检中') : patrol?.pending ? tt('排队中') : patrol?.enabled ? tt('待运行') : tt('已关闭');
          patrolState.textContent = label;
          patrolState.className = `badge ${patrol?.inFlight ? 'indigo' : patrol?.enabled ? 'mint' : 'faint'}`;
        }
        const patrolHeading = root.querySelector('#page-patrol .patrol-hero h2');
        if (patrolHeading) {
          patrolHeading.textContent = patrol?.inFlight ? tt('队长巡检中') : patrol?.enabled ? tt('等待下次巡检') : tt('巡检已关闭');
        }
        const patrolSub = root.querySelector('#page-patrol .patrol-hero p');
        if (patrolSub) {
          if (!patrol) patrolSub.textContent = tt('系统未提供巡检调度数据');
          else {
            const last = patrol.lastAt ? timestamp(patrol.lastAt) : '—';
            const next = patrol.nextAt ? timestamp(patrol.nextAt) : '—';
            patrolSub.textContent = tt('上次 {0} · 下次 {1} · 每 {2} 分钟 · {3}', [
              last,
              next,
              patrol.intervalMinutes,
              patrol.pending ? tt('排队 {0} 条', [patrol.backlogCount]) : tt('当前无积压'),
            ]);
          }
        }
        const timeline = root.querySelector('#page-patrol .timeline');
        if (timeline) {
          const waiting = tasks.filter((task) => task.status === 'waiting').length;
          const activeSessions = members.filter((member) => member.hasSession).length;
          timeline.innerHTML = [
            `<div class="tl-row"><span class="tl-dot done"></span><div><b>${tt('成员与会话')}</b><span>${tt('{0} 名成员 · {1}', [members.length, LIVE_MODEL.degraded ? tt('会话状态未提供') : tt('{0} 个活动会话', [activeSessions])])}</span></div><span class="badge ${LIVE_MODEL.degraded ? 'faint' : activeSessions ? 'mint' : ''}">${LIVE_MODEL.degraded ? tt('未知') : activeSessions ? tt('正常') : tt('空闲')}</span></div>`,
            `<div class="tl-row"><span class="tl-dot done"></span><div><b>${tt('任务与依赖')}</b><span>${tt('{0} 个任务 · {1} 个等待依赖', [tasks.length, waiting])}</span></div><span class="badge ${waiting ? 'amber' : 'mint'}">${waiting ? tt('待推进') : tt('正常')}</span></div>`,
            `<div class="tl-row"><span class="tl-dot ${mergeQueueUnknown ? '' : mergeQueue.length ? 'active' : ''}"></span><div><b>${tt('合并队列')}</b><span>${mergeQueueUnknown ? tt('系统未提供合并队列') : tt('{0} 个任务进入合并视图', [mergeQueue.length])}</span></div><span class="badge ${mergeQueueUnknown ? 'faint' : mergeQueue.length ? 'indigo' : ''}">${mergeQueueUnknown ? tt('未知') : mergeQueue.length ? tt('监控中') : tt('空')}</span></div>`,
            `<div class="tl-row"><span class="tl-dot ${findingsUnknown ? '' : findings.length ? 'active' : ''}"></span><div><b>${tt('巡检发现')}</b><span>${findingsUnknown ? tt('系统未提供巡检发现') : tt('{0} 条未关闭发现', [findings.length])}</span></div><span class="badge ${findingsUnknown ? 'faint' : findings.length ? 'amber' : 'mint'}">${findingsUnknown ? tt('未知') : findings.length ? tt('待处理') : tt('正常')}</span></div>`,
          ].join('');
        }
        const findingsPanel = root.querySelector('#page-patrol .findings');
        if (findingsPanel) {
          findingsPanel.innerHTML = findingsUnknown
            ? `<div class="finding"><b>${tt('系统未提供巡检发现')}</b><span>${tt('快照不包含发现数据，控制台不做“没有发现”的推断。')}</span></div>`
            : findings.length
              ? findings.slice(0, 8).map((finding) => `<div class="finding"><b data-i18n-skip>${escapeHtml(finding.problem ?? finding.id ?? '发现')}</b><span>${escapeHtml(tt(finding.severity ?? '—'))} · <span data-i18n-skip>${escapeHtml(finding.memberId ?? '—')}</span> · ${tt('系统记录')}</span></div>`).join('')
              : `<div class="finding"><b>${tt('暂无未关闭发现')}</b><span>${tt('系统会在巡检发现异常时写入这里。')}</span></div>`;
        }
        const findingsBadge = root.querySelector('#page-patrol aside .panel-head .badge');
        if (findingsBadge) findingsBadge.textContent = findingsUnknown ? tt('系统未提供') : tt('{0} 条', [findings.length]);
        const auditBody = root.querySelector('#audit-body');
        if (auditBody) {
          const rows = events.slice().sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0)).slice(0, 30);
          const displayByTaskId = new Map((LIVE_MODEL.dagTasks ?? []).map((task) => [task.id, task.displayId]));
          const memberById = new Map((LIVE_MODEL.memberList ?? []).map((member) => [member.id, member.name]));
          const teamById = new Map((LIVE_MODEL.teamMeta ?? []).map((team) => [team.id, team.name]));
          const eventLabels = {
            'team.created': '队伍创建', 'task.created': '任务创建', 'task.completed': '任务完成',
            'task.failed': '任务失败', 'task.updated': '任务更新', 'member.relicensed': '号牌变更',
            'member.added': '成员加入', 'member.removed': '成员移除', 'message.cross_team_pending': '跨队消息待审',
            'message.cross_team_approved': '跨队消息批准', 'message.cross_team_rejected': '跨队消息驳回',
            'patrol.finding': '巡检发现', 'merge.clean': '合并完成', 'merge.conflict': '合并冲突',
            'model.followed': '模型跟随', 'model.policy_changed': '模型策略变更',
          };
          const resultLabels = {
            completed: '完成', settled: '已结算', pending: '待处理', failed: '失败',
            approved: '已批准', rejected: '已驳回', running: '进行中',
          };
          auditBody.innerHTML = eventsUnknown
            ? `<tr><td colspan="4">${tt('系统未提供审计事件')}</td></tr>`
            : rows.length
              ? rows.map((event) => {
                const taskId = event.data?.taskId;
                const memberId = event.data?.memberId;
                const object = displayByTaskId.get(taskId)
                  ?? memberById.get(memberId)
                  ?? (event.teamId ? teamById.get(event.teamId) : null)
                  ?? '—';
                const rawResult = event.data?.status ?? event.data?.result ?? event.data?.reason ?? '记录';
                const result = resultLabels[rawResult] ?? String(rawResult);
                const label = eventLabels[event.type] ?? event.type ?? '事件';
                return `<tr><td data-i18n-skip>${timestamp(event.createdAt ?? Date.now())}</td><td>${escapeHtml(tt(label))}</td><td data-i18n-skip>${escapeHtml(object)}</td><td><span class="badge">${escapeHtml(tt(result))}</span></td></tr>`;
              }).join('')
              : `<tr><td colspan="4">${tt('暂无审计事件')}</td></tr>`;
          const count = root.querySelector('#audit-count');
          if (count) count.textContent = eventsUnknown ? tt('系统未提供') : tt('{0} 条（最近）', [rows.length]);
        }
        const assignment = root.querySelector('#settings-assignment');
        if (assignment) {
          const alpha = members.filter((member) => member.teamKey === 'alpha' && member.hasSession).length;
          const beta = members.filter((member) => member.teamKey === 'beta' && member.hasSession).length;
          assignment.textContent = tt('A队 {0} · B队 {1}', [alpha, beta]);
        }
        const contractorCapacity = root.querySelector('#settings-contractor-capacity');
        if (contractorCapacity) {
          const slots = LIVE_MODEL.contractorSlots ?? [];
          contractorCapacity.textContent = slots.length
            ? slots.map((slot) => {
              const label = slot.slot === 'merge' ? tt('合并位') : slot.slot === 'patrol' || slot.slot === 'main' ? tt('巡检位') : slot.slot ?? '—';
              return `${label} ${slot.active ?? 0}/${slot.cap ?? '—'}`;
            }).join(' · ')
            : tt('系统未提供');
        }
        const modeBadge = root.querySelector('#mode-badge');
        if (modeBadge) modeBadge.textContent = tt('系统自动');
        const settingsSub = root.querySelector('#page-settings .page-head p');
        if (settingsSub) settingsSub.textContent = tt('以下为系统当前策略；控制台只读，业务动作由 captain/daemon 自动判断。');
        const advanced = [...root.querySelectorAll('#page-settings details .setting-row')];
        const limits = LIVE_MODEL.limits ?? null;
        if (advanced[0]) {
          const badge = advanced[0].querySelector('.badge');
          if (badge) badge.textContent = limits?.maxTurnsPerTask == null ? tt('系统未提供') : tt('{0} 步', [limits.maxTurnsPerTask]);
        }
        if (advanced[1]) {
          const badge = advanced[1].querySelector('.badge');
          if (badge) badge.textContent = limits?.taskTimeoutMinutes == null ? tt('系统未提供') : tt('{0} 分钟', [limits.taskTimeoutMinutes]);
        }
        const accessPill = root.querySelector('#access-pill');
        if (accessPill) accessPill.textContent = tt('系统自动判断');
        const runText = root.querySelector('#run-text');
        if (runText) {
          const halted = meta.some((team) => team.control === 'halted' || team.phase === 'halted');
          runText.textContent = halted ? tt('已暂停') : tt('运行中');
        }
        const riskMerge = root.querySelector('#risk-merge');
        if (riskMerge) riskMerge.textContent = tt('系统门禁');
        const riskMail = root.querySelector('#risk-mail');
        if (riskMail) riskMail.textContent = tt('系统审批');
        const advancedPanel = root.querySelector('#page-settings details');
        if (advancedPanel && !advancedPanel.querySelector('[data-live-runtime]')) {
          const capacity = LIVE_MODEL.teamMeta?.[0]?.capacity ?? null;
          const policy = LIVE_MODEL.model?.policy ?? null;
          const host = LIVE_MODEL.model?.host ?? null;
          const shadow = LIVE_MODEL.shadow ?? null;
          const shadowLabel = tt({
            stopped: '已停止', starting: '启动中', active: '工作中',
            stopping: '停止中', stop_failed: '停止失败',
          }[shadow?.status] ?? shadow?.status ?? '系统未提供');
          const runtime = document.createElement('div');
          runtime.dataset.liveRuntime = '1';
          runtime.setAttribute('data-i18n-skip', '');
          const row = (label, value) => `<div class="setting-row"><span>${escapeHtml(label)}</span><span class="badge">${escapeHtml(value)}</span></div>`;
          runtime.innerHTML = [
            row(tt('最大会话'), capacity?.maxTotalSessions == null ? tt('系统未提供') : String(capacity.maxTotalSessions)),
            row(tt('空闲会话'), LIVE_MODEL.limits?.idleSessionMinutes == null ? tt('系统未提供') : tt('{0} 分钟', [LIVE_MODEL.limits.idleSessionMinutes])),
            row(tt('请求速率'), LIVE_MODEL.limits?.maxRequestsPerMinute === 0 ? tt('不限速') : LIVE_MODEL.limits?.maxRequestsPerMinute == null ? tt('系统未提供') : `${LIVE_MODEL.limits.maxRequestsPerMinute} RPM`),
            row(tt('模型策略'), policy?.mode === 'fixed' ? tt('固定 · {0}', [policy.model ?? '—']) : policy?.mode === 'follow-host' ? tt('跟随宿主{0}', [host?.model ? ` · ${host.model}` : '']) : tt('系统未提供')),
            row(tt('影子席位'), !shadow ? tt('系统未提供') : shadow.exists === false ? tt('未启用') : `${shadowLabel}${shadow.active ? ` ${tt('· 工作中')}` : ''}`),
          ].join('');
          advancedPanel.appendChild(runtime);
        }
      };

      root.querySelector('#theme-toggle')?.addEventListener('click', () => {
        queueMicrotask(() => localizeRoot(root));
      });
      root.querySelectorAll('[data-member-team-filter]').forEach((button) => button.addEventListener('click', () => {
        memberTeamFilter = button.dataset.memberTeamFilter;
        renderMembers();
      }));
      new MutationObserver(() => renderMembers()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      renderMembers();
      renderLiveWorkforce();
      renderLiveTeamCards();
      renderLiveStaticPanels();
      localizeRoot(root);
      if (LIVE_MODEL) {
        root.dataset.live = 'true';
        root.querySelectorAll(READ_ONLY_HIDDEN_SELECTOR).forEach((button) => {
          button.disabled = true;
          button.hidden = true;
          button.title = tt('控制台只读；系统自动判断');
          button.setAttribute('aria-label', tt('系统自动判断，控制台只读'));
        });
        if (livePill) livePill.title = tt('实时快照（只读）');
      }

      const taskData = LIVE_MODEL?.taskData ?? {
        t1: ['t1', 'A队 A-T1 · 项目基线对齐', 'A队 · 仓库、约束与验收基线', 'mint', '已完成'],
        t2: ['t2', 'A队 A-T2 · 跨队输入汇总', 'A队 · 接收B队基线包后冻结输入', 'indigo', '进行中'],
        t3: ['t3', 'A队 A-T3a · 接口契约冻结', 'A队 · 输出跨队接口契约', 'amber', '等待依赖'],
        t4: ['t4', 'A队 A-T3b · 风险模型建立', 'A队 · 建立正常与异常风险模型', 'amber', '等待依赖'],
        t5: ['t5', 'A队 A-T4a · 核心流程实现', 'A队 · 主业务流程编码', 'amber', '等待依赖'],
        t6: ['t6', 'A队 A-T4b · 兼容适配', 'A队 · 旧版本与边界兼容', 'amber', '等待依赖'],
        t7: ['t7', 'A队 A-T4c · 自动化测试搭建', 'A队 · 构建可重复验证入口', 'amber', '等待依赖'],
        t8: ['t8', 'A队 A-T5 · 集成回归', 'A队 · 合并三条并行实现分支', 'amber', '等待依赖'],
        t9: ['t9', 'A队 A-T6a · 性能与安全门禁', 'A队 · 接收B队回归证据', 'amber', '等待依赖'],
        t10: ['t10', 'A队 A-T6b · 发布候选构建', 'A队 · 生成候选制品与哈希', 'amber', '等待依赖'],
        t11: ['t11', 'A队 A-T7 · 文档与证据链', 'A队 · 同步构建说明与验收材料', 'amber', '等待依赖'],
        t12: ['t12', 'A队 A-T8 · 最终验收', 'A队 · 等待B队最终审计回流', 'amber', '等待依赖'],
        b1: ['b1', 'B队 B-T1 · 需求与资产盘点', 'B队 · 建立可验收输入清单', 'mint', '已完成'],
        b2: ['b2', 'B队 B-T2a · 数据与样例抽取', 'B队 · 生成稳定复查样本', 'mint', '已完成'],
        b3: ['b3', 'B队 B-T2b · 业务规则拆解', 'B队 · 形成规则映射表', 'mint', '已完成'],
        b4: ['b4', 'B队 B-T2c · 异常场景清单', 'B队 · 汇总边界与故障假设', 'mint', '已完成'],
        b5: ['b5', 'B队 B-T3a · 契约一致性检查', 'B队 · 检查A队契约草案', 'mint', '已完成'],
        b6: ['b6', 'B队 B-T3b · 基线交付包', 'B队 · 向A队交付启动基线', 'mint', '已完成'],
        b7: ['b7', 'B队 B-T4 · 影子联调', 'B队 · 接A队主流程进行旁路联调', 'amber', '等待依赖'],
        b8: ['b8', 'B队 B-T5a · 故障注入与回放', 'B队 · 对候选实现进行异常回放', 'amber', '等待依赖'],
        b9: ['b9', 'B队 B-T5b · 回归证据复核', 'B队 · 固化可审计回归证据', 'amber', '等待依赖'],
        b10: ['b10', 'B队 B-T6 · 问题清单回流', 'B队 · 将缺陷与风险送回A队', 'amber', '等待依赖'],
        b11: ['b11', 'B队 B-T7 · 验收材料归档', 'B队 · 接收A队候选构建材料', 'amber', '等待依赖'],
        b12: ['b12', 'B队 B-T8 · 最终审计封存', 'B队 · 完成跨队闭环审计', 'amber', '等待依赖'],
      };
      const demoTaskCopy = {
        t1: { title: '项目基线对齐', sub: '仓库、约束与验收基线' },
        t2: { title: '跨队输入汇总', sub: '接收B队基线包后冻结输入' },
        t3: { title: '接口契约冻结', sub: '输出跨队接口契约' },
        t4: { title: '风险模型建立', sub: '建立正常与异常风险模型' },
        t5: { title: '核心流程实现', sub: '主业务流程编码' },
        t6: { title: '兼容适配', sub: '旧版本与边界兼容' },
        t7: { title: '自动化测试搭建', sub: '构建可重复验证入口' },
        t8: { title: '集成回归', sub: '合并三条并行实现分支' },
        t9: { title: '性能与安全门禁', sub: '接收B队回归证据' },
        t10: { title: '发布候选构建', sub: '生成候选制品与哈希' },
        t11: { title: '文档与证据链', sub: '同步构建说明与验收材料' },
        t12: { title: '最终验收', sub: '等待B队最终审计回流' },
        b1: { title: '需求与资产盘点', sub: '建立可验收输入清单' },
        b2: { title: '数据与样例抽取', sub: '生成稳定复查样本' },
        b3: { title: '业务规则拆解', sub: '形成规则映射表' },
        b4: { title: '异常场景清单', sub: '汇总边界与故障假设' },
        b5: { title: '契约一致性检查', sub: '检查A队契约草案' },
        b6: { title: '基线交付包', sub: '向A队交付启动基线' },
        b7: { title: '影子联调', sub: '接A队主流程进行旁路联调' },
        b8: { title: '故障注入与回放', sub: '对候选实现进行异常回放' },
        b9: { title: '回归证据复核', sub: '固化可审计回归证据' },
        b10: { title: '问题清单回流', sub: '将缺陷与风险送回A队' },
        b11: { title: '验收材料归档', sub: '接收A队候选构建材料' },
        b12: { title: '最终审计封存', sub: '完成跨队闭环审计' },
      };
      const demoTaskTeam = (id) => String(id).startsWith('b') ? tt('B队') : tt('A队');
      // Demo merge rows carry a stable id plus a translatable title key; a live
      // row has no titleKey, so its subject stays verbatim in every locale.
      const mergeTitle = (item) => (item?.titleKey ? `${item.titleId} ${tt(item.titleKey)}` : (item?.title ?? ''));
      /* Demo assignees are seat codes, so they read the same in every locale. */
      const demoTaskAssignee = {
        t2: 'A-01', t3: 'A-02', t4: 'A-04',
        b6: 'B-01', b7: 'B-02', b9: 'B-01',
      };
      const demoTaskRole = {
        t2: '进行中', t3: '验证', t4: '审核',
        b6: '交付', b7: '工程师', b9: '交付',
      };
      const demoTaskText = (id, field, fallback) => {
        const copy = demoTaskCopy[id];
        if (!copy) return fallback;
        return tt(copy[field] ?? fallback);
      };
      const demoTaskTitle = (id, fallback) => {
        const copy = demoTaskCopy[id];
        return copy ? `${demoTaskTeam(id)} · ${demoTaskText(id, 'title', fallback)}` : fallback;
      };
      const displayTaskSubject = (task) => {
        if (!task || LIVE_MODEL || !demoTaskCopy[task.id]) return task?.subject ?? '';
        return demoTaskTitle(task.id, task.subject);
      };
      // Demo detail cells are hand-authored Chinese phrases such as
      // “等待A队 A-T3a 契约”. They are demo data, but their fixed words are UI
      // copy, so each segment resolves through the catalog: task ids and the
      // “ · ” separator pass through, every other token translates.
      const localizeDemoWords = (value) => String(value)
        .split(/(\s+)/u)
        .map((token) => (token.trim() ? tt(token) : token))
        .join('');
      const localizeDemoSegment = (segment) => {
        const wait = /^等待\s*(?=\S)/u.exec(segment);
        if (wait) {
          const rest = segment.slice(wait[0].length);
          const words = localizeDemoWords(rest).trim();
          // “等待A队 A-T4a” also matches the generic 等待 {0} pattern, so a plain
          // exact lookup would return "Waiting <untranslated capture>". Only
          // trust an exact hit that differs from that trivial interpolation —
          // that is a dedicated entry such as 等待输入冻结 or a note-bearing cell.
          const trivial = tt('等待 {0}', [rest.trim()]);
          const exact = tt(segment);
          if (exact !== segment && exact !== trivial) return exact;
          return tt('等待 {0}', [words]);
        }
        // A whole-segment entry (已完成, 已递送) wins outright.
        const exact = tt(segment);
        if (exact !== segment) return exact;
        return localizeDemoWords(segment);
      };
      const localizeDemoDetail = (value) => {
        const source = String(value ?? '—');
        if (LIVE_MODEL || source === '—') return source;
        return source.split(' · ').map(localizeDemoSegment).join(' · ');
      };
      // Kept as concatenation, not a template, so the wait verb stays a
      // standalone catalog key instead of an unscannable "等待{0}" fragment.
      const demoWait = (ref) => '等待' + ref;
      const taskDetails = LIVE_MODEL?.taskDetails ?? {
        t1: { scope: 'A队 A-T1', acceptance: '基线、约束和验收口径确认', worktree: '—', merge: '已完成', upstream: '—', downstream: 'A队 A-T2' },
        t2: { scope: 'A队 A-T2', acceptance: '接收B队 B-T3b 基线包并冻结输入', worktree: '—', merge: '等待输入冻结', upstream: 'A队 A-T1 · B队 B-T3b', downstream: 'A队 A-T3a · A-T3b' },
        t3: { scope: 'A队 A-T3a', acceptance: '跨队接口契约冻结', worktree: '—', merge: demoWait('A队 A-T4a'), upstream: 'A队 A-T2', downstream: 'A队 A-T4a · B队 B-T4' },
        t4: { scope: 'A队 A-T3b', acceptance: '风险模型覆盖主要故障面', worktree: '—', merge: demoWait('A队 A-T4a'), upstream: 'A队 A-T2', downstream: 'A队 A-T4a' },
        t5: { scope: 'A队 A-T4a', acceptance: '主流程实现与回滚路径完成', worktree: '—', merge: demoWait('A队 A-T5'), upstream: 'A队 A-T3a · A-T3b', downstream: 'A队 A-T5 · B队 B-T5a' },
        t6: { scope: 'A队 A-T4b', acceptance: '兼容矩阵全部通过', worktree: '—', merge: demoWait('A队 A-T5'), upstream: 'A队 A-T3a', downstream: 'A队 A-T5' },
        t7: { scope: 'A队 A-T4c', acceptance: '自动化入口可重复执行', worktree: '—', merge: demoWait('A队 A-T5'), upstream: 'A队 A-T3b', downstream: 'A队 A-T5' },
        t8: { scope: 'A队 A-T5', acceptance: '三条实现分支集成回归通过', worktree: '—', merge: '等待 A-T4a · A-T4b · A-T4c', upstream: 'A队 A-T4a · A-T4b · A-T4c · B队 B-T6', downstream: 'A队 A-T6a · A-T6b' },
        t9: { scope: 'A队 A-T6a', acceptance: '性能与安全门禁通过', worktree: '—', merge: '等待B队 B-T5b 证据', upstream: 'A队 A-T5 · B队 B-T5b', downstream: 'A队 A-T7' },
        t10: { scope: 'A队 A-T6b', acceptance: '候选制品和哈希一致', worktree: '—', merge: demoWait('A队 A-T7'), upstream: 'A队 A-T5', downstream: 'A队 A-T7 · B队 B-T7' },
        t11: { scope: 'A队 A-T7', acceptance: '文档、证据链和制品编号一致', worktree: '—', merge: '等待 A-T6a · A-T6b', upstream: 'A队 A-T6a · A-T6b', downstream: 'A队 A-T8' },
        t12: { scope: 'A队 A-T8', acceptance: '所有跨队证据闭环并验收通过', worktree: '—', merge: '等待B队 B-T8 审计', upstream: 'A队 A-T7 · B队 B-T8', downstream: '—' },
        b1: { scope: 'B队 B-T1', acceptance: '输入资产与验收范围清晰', worktree: '—', merge: '已完成', upstream: '—', downstream: 'B队 B-T2a · B-T2b · B-T2c' },
        b2: { scope: 'B队 B-T2a', acceptance: '复查样本稳定且可追溯', worktree: '—', merge: '已完成', upstream: 'B队 B-T1', downstream: 'B队 B-T3a' },
        b3: { scope: 'B队 B-T2b', acceptance: '规则映射无遗漏', worktree: '—', merge: '已完成', upstream: 'B队 B-T1', downstream: 'B队 B-T3a' },
        b4: { scope: 'B队 B-T2c', acceptance: '异常与边界场景清单完成', worktree: '—', merge: '已完成', upstream: 'B队 B-T1', downstream: 'B队 B-T3b' },
        b5: { scope: 'B队 B-T3a', acceptance: '契约一致性检查通过', worktree: '—', merge: '已完成', upstream: 'B队 B-T2a · B-T2b', downstream: 'B队 B-T3b' },
        b6: { scope: 'B队 B-T3b', acceptance: '基线交付包可被A队直接消费', worktree: '—', merge: '已递送', upstream: 'B队 B-T2c · B-T3a', downstream: 'B队 B-T4 · A队 A-T2' },
        b7: { scope: 'B队 B-T4', acceptance: '影子联调无阻断问题', worktree: '—', merge: '等待A队 A-T3a 契约', upstream: 'B队 B-T3b · A队 A-T3a', downstream: 'B队 B-T5a · B-T5b' },
        b8: { scope: 'B队 B-T5a', acceptance: '故障注入与回放结果可复现', worktree: '—', merge: demoWait('B队 B-T4'), upstream: 'B队 B-T4 · A队 A-T4a', downstream: 'B队 B-T6' },
        b9: { scope: 'B队 B-T5b', acceptance: '回归证据完整且可审计', worktree: '—', merge: demoWait('B队 B-T4'), upstream: 'B队 B-T4', downstream: 'B队 B-T6 · A队 A-T6a' },
        b10: { scope: 'B队 B-T6', acceptance: '缺陷与风险已回流A队', worktree: '—', merge: '等待 B-T5a · B-T5b', upstream: 'B队 B-T5a · B-T5b', downstream: 'B队 B-T7 · A队 A-T5' },
        b11: { scope: 'B队 B-T7', acceptance: '验收材料和A队候选制品对应', worktree: '—', merge: demoWait('B队 B-T6 · A队 A-T6b'), upstream: 'B队 B-T6 · A队 A-T6b', downstream: 'B队 B-T8' },
        b12: { scope: 'B队 B-T8', acceptance: '最终审计完成并回流A队验收', worktree: '—', merge: demoWait('B队 B-T7'), upstream: 'B队 B-T7', downstream: 'A队 A-T8' },
      };
      const applyTask = (id) => {
        const data = taskData[id];
        if (!data) return;
        const [fallbackId, fallbackTitle, sub, tone, status] = data;
        const graphTask = dagById.get(id);
        const taskId = graphTask?.displayId ?? fallbackId;
        const title = graphTask?.subject ?? fallbackTitle;
        // Live task subjects are user data and remain verbatim. Only built-in
        // demo copies are keyed by stable task id and may be localized.
        const titleText = graphTask ? (LIVE_MODEL ? title : displayTaskSubject(graphTask)) : demoTaskTitle(id, fallbackTitle);
        const shortId = taskId.replace(/^[AB]-/u, '');
        const avatar = root.querySelector('#task-detail-avatar');
        if (avatar) { avatar.textContent = shortId; avatar.className = `avatar ${tone}`; }
        root.querySelector('#task-detail-title') && (root.querySelector('#task-detail-title').textContent = `${taskId} · ${titleText}`);
        const subText = graphTask && !LIVE_MODEL
          ? `${demoTaskTeam(id)} · ${demoTaskText(id, 'sub', sub)}`
          : tt(sub);
        root.querySelector('#task-detail-sub') && (root.querySelector('#task-detail-sub').textContent = subText);
        const statusEl = root.querySelector('#task-detail-status');
        if (statusEl) { statusEl.textContent = tt(status); statusEl.className = `badge ${['mint', 'amber', 'rose', 'faint'].includes(tone) ? tone : 'indigo'}`; }
        const detail = taskDetails[id] ?? {};
        const teamLabel = graphTask?.team === 'beta' ? 'B队' : 'A队';
        const upstream = graphTask
          ? (predecessors.get(id) ?? []).map((edge) => dagById.get(edge.from)?.displayId).filter(Boolean).join(' · ') || '—'
          : detail.upstream ?? '—';
        const downstream = graphTask
          ? (successors.get(id) ?? []).map((edge) => dagById.get(edge.to)?.displayId).filter(Boolean).join(' · ') || '—'
          : detail.downstream ?? '—';
        const qualifyTaskRefs = (value) => String(value ?? '—')
          .replace(/A队\s+T(?=\d)/gu, 'A队 A-T')
          .replace(/B队\s+T(?=\d)/gu, 'B队 B-T')
          .replace(/(?<![A-Z-])T(?=\d)/gu, `${graphTask?.team === 'beta' ? 'B' : 'A'}-T`);
        const statusKey = graphTask?.status ?? 'waiting';
        // Session content is streamed by the daemon later. Until the snapshot
        // actually carries it, show an explicit "not connected" state instead
        // of synthesizing fake conversation text.
        const hasSession = Boolean(graphTask?.sessionContent ?? detail.sessionContent);
        const sessionState = graphTask?.sessionState ?? detail.sessionState ?? (hasSession ? '已接入' : '系统未提供');
        const sessionOwner = graphTask?.sessionOwner ?? detail.sessionOwner ?? '—';
        const runtimeValue = graphTask?.runtimeMs ?? detail.runtime;
        const runtimeText = runtimeValue != null && Number.isFinite(Number(runtimeValue))
          ? tt('{0} 分钟', [Math.max(0, Math.round(Number(runtimeValue) / 60000))])
          : (statusKey === 'done' ? tt('已完成') : statusKey === 'waiting' ? tt('未开始') : tt('待实时快照'));
        const progressText = graphTask?.progressText ?? detail.progress
          ?? (statusKey === 'done' ? tt('已完成') : statusKey === 'failed' ? tt('失败') : statusKey === 'cancelled' ? tt('已取消') : tt('待实时快照'));
        const ownerText = graphTask?.owner ?? detail.owner ?? tt('未分配');
        const detailValue = (value) => LIVE_MODEL ? String(value ?? '—') : localizeDemoDetail(value);
        const acceptanceSource = qualifyTaskRefs(detail.acceptance);
        const acceptanceText = detailValue(acceptanceSource);
        const scopeText = detail.scope
          ? detailValue(detail.scope)
          : (graphTask ? `${demoTaskTeam(id)} ${graphTask.displayId}` : '—');
        const cleanTitle = LIVE_MODEL
          ? title.replace(/^(A队|B队)\s*·\s*/u, '')
          : demoTaskText(id, 'title', title);
        const goalText = detail.objective && detail.objective !== '—'
          ? detailValue(detail.objective)
          : detail.goal
            ? detailValue(detail.goal)
            : tt('在 {0} 范围内完成「{1}」，以“{2}”作为验收口径。', [scopeText, cleanTitle, acceptanceText]);
        const deliverablesText = detail.deliverables != null
          ? detailValue(detail.deliverables)
          : detail.evidence != null
            ? detailValue(detail.evidence)
            : tt('系统未提供');
        const risksText = detail.risks != null
          ? detailValue(detail.risks)
          : (detail.hold?.reason ? (LIVE_MODEL ? `系统 hold：${detail.hold.reason}` : tt('系统 hold：{0}', [detail.hold.reason])) : tt('系统未提供'));
        const collabText = detail.collab != null ? detailValue(detail.collab) : tt('系统未提供');
        const descText = detail.description != null ? detailValue(detail.description) : goalText;
        const displayedOwner = graphTask
          ? (LIVE_MODEL ? graphTask.owner : demoTaskTeam(id))
          : (LIVE_MODEL ? ownerText : tt(ownerText));
        for (const [field, value] of Object.entries({
          scope: scopeText,
          acceptance: acceptanceText,
          deliverables: deliverablesText,
          risks: risksText,
          worktree: detail.worktree ?? '—',
          merge: LIVE_MODEL ? qualifyTaskRefs(detail.merge) : detailValue(qualifyTaskRefs(detail.merge)),
          upstream: LIVE_MODEL ? upstream : detailValue(upstream),
          downstream: LIVE_MODEL ? downstream : detailValue(downstream),
          runtime: runtimeText,
          progress: LIVE_MODEL ? (progressText ?? '—') : progressText,
          owner: displayedOwner,
          collab: collabText,
        })) {
          const el = root.querySelector(`#task-detail-${field}`);
          if (el) el.textContent = value;
        }
        const descEl = root.querySelector('#task-detail-desc');
        if (descEl) descEl.textContent = descText;
        const sessionStateEl = root.querySelector('#task-session-state');
        if (sessionStateEl) {
          sessionStateEl.textContent = tt(sessionState);
          sessionStateEl.className = `badge ${hasSession ? 'mint' : 'faint'}`;
        }
        const sessionOwnerEl = root.querySelector('#task-session-owner');
        if (sessionOwnerEl) sessionOwnerEl.textContent = tt('会话负责人 · {0}', [sessionOwner]);
        const sessionContentEl = root.querySelector('#task-session-content');
        if (sessionContentEl) {
          sessionContentEl.textContent = hasSession
            ? (graphTask?.sessionContent ?? detail.sessionContent)
            : tt('系统未提供该任务的会话内容；控制台只展示任务与事件数据。');
          sessionContentEl.classList.toggle('empty', !hasSession);
        }
      };
      /*
       * `id` (t1/b1...) is an internal stable key used by dependency arrays.
       * `displayId` is the human-facing team-qualified label: A-Tn for A队
       * and B-Tn for B队. T numbers are local labels;
       * A-T3 and B-T3 do not establish a global cross-team order. The focus
       * stroke may use the smaller numeric tier only as visual emphasis, per
       * the user's selection-priority rule. Coordinates and vertical lanes are
       * visual layout, not flow direction or a rule for reversing an edge.
       */
      const dagTasks = LIVE_MODEL?.dagTasks ?? [
        { id: 't1', displayId: 'A-T1', subject: 'A队 · 项目基线对齐', owner: 'A队', deps: [], status: 'done', team: 'alpha' },
        { id: 't2', displayId: 'A-T2', subject: 'A队 · 跨队输入汇总', owner: 'A队', deps: ['t1'], status: 'active', team: 'alpha' },
        { id: 't3', displayId: 'A-T3a', subject: 'A队 · 接口契约冻结', owner: 'A队', deps: ['t2'], status: 'waiting', team: 'alpha' },
        { id: 't4', displayId: 'A-T3b', subject: 'A队 · 风险模型建立', owner: 'A队', deps: ['t2'], status: 'waiting', team: 'alpha' },
        { id: 't5', displayId: 'A-T4a', subject: 'A队 · 核心流程实现', owner: 'A队', deps: ['t3', 't4'], status: 'waiting', team: 'alpha' },
        { id: 't6', displayId: 'A-T4b', subject: 'A队 · 兼容适配', owner: 'A队', deps: ['t3'], status: 'waiting', team: 'alpha' },
        { id: 't7', displayId: 'A-T4c', subject: 'A队 · 自动化测试搭建', owner: 'A队', deps: ['t4'], status: 'waiting', team: 'alpha' },
        { id: 't8', displayId: 'A-T5', subject: 'A队 · 集成回归', owner: 'A队', deps: ['t5', 't6', 't7'], status: 'waiting', team: 'alpha' },
        { id: 't9', displayId: 'A-T6a', subject: 'A队 · 性能与安全门禁', owner: 'A队', deps: ['t8'], status: 'waiting', team: 'alpha' },
        { id: 't10', displayId: 'A-T6b', subject: 'A队 · 发布候选构建', owner: 'A队', deps: ['t8'], status: 'waiting', team: 'alpha' },
        { id: 't11', displayId: 'A-T7', subject: 'A队 · 文档与证据链', owner: 'A队', deps: ['t9', 't10'], status: 'waiting', team: 'alpha' },
        { id: 't12', displayId: 'A-T8', subject: 'A队 · 最终验收', owner: 'A队', deps: ['t11'], status: 'waiting', team: 'alpha' },
        { id: 'b1', displayId: 'B-T1', subject: 'B队 · 需求与资产盘点', owner: 'B队', deps: [], status: 'done', team: 'beta' },
        { id: 'b2', displayId: 'B-T2a', subject: 'B队 · 数据与样例抽取', owner: 'B队', deps: ['b1'], status: 'done', team: 'beta' },
        { id: 'b3', displayId: 'B-T2b', subject: 'B队 · 业务规则拆解', owner: 'B队', deps: ['b1'], status: 'done', team: 'beta' },
        { id: 'b4', displayId: 'B-T2c', subject: 'B队 · 异常场景清单', owner: 'B队', deps: ['b1'], status: 'done', team: 'beta' },
        { id: 'b5', displayId: 'B-T3a', subject: 'B队 · 契约一致性检查', owner: 'B队', deps: ['b2', 'b3'], status: 'done', team: 'beta' },
        { id: 'b6', displayId: 'B-T3b', subject: 'B队 · 基线交付包', owner: 'B队', deps: ['b4', 'b5'], status: 'done', team: 'beta' },
        { id: 'b7', displayId: 'B-T4', subject: 'B队 · 影子联调', owner: 'B队', deps: ['b6'], status: 'waiting', team: 'beta' },
        { id: 'b8', displayId: 'B-T5a', subject: 'B队 · 故障注入与回放', owner: 'B队', deps: ['b7'], status: 'waiting', team: 'beta' },
        { id: 'b9', displayId: 'B-T5b', subject: 'B队 · 回归证据复核', owner: 'B队', deps: ['b7'], status: 'waiting', team: 'beta' },
        { id: 'b10', displayId: 'B-T6', subject: 'B队 · 问题清单回流', owner: 'B队', deps: ['b8', 'b9'], status: 'waiting', team: 'beta' },
        { id: 'b11', displayId: 'B-T7', subject: 'B队 · 验收材料归档', owner: 'B队', deps: ['b10'], status: 'waiting', team: 'beta' },
        { id: 'b12', displayId: 'B-T8', subject: 'B队 · 最终审计封存', owner: 'B队', deps: ['b11'], status: 'waiting', team: 'beta' },
      ];
      const defaultTaskId = LIVE_MODEL ? (dagTasks[0]?.id ?? 't2') : 't2';
      /*
       * These arrows are hand-authored dependency/handoff directions. The list
       * intentionally contains A→B and B→A links, including links whose
       * team-local T numbers decrease or stay equal. This is the
       * agreed sample flow; do not sort, flip, or reject a link based only on
       * A-Tn/B-Tn numeric values or on which team lane appears higher on screen.
       * Numeric T priority is only a stroke/draw-order cue during selection.
       */
      const crossLinks = LIVE_MODEL
        ? (Array.isArray(LIVE_MODEL.crossLinks) ? LIVE_MODEL.crossLinks : [])
        : [
          { from: 'b6', to: 't2', label: '基线交付' },
          { from: 't3', to: 'b7', label: '接口契约' },
          { from: 'b10', to: 't8', label: '风险回流' },
          { from: 't5', to: 'b8', label: '候选主流程' },
          { from: 'b9', to: 't9', label: '回归证据' },
          { from: 't10', to: 'b11', label: '候选制品' },
          { from: 'b12', to: 't12', label: '最终审计' },
        ];
      const dagById = new Map(dagTasks.map((task) => [task.id, task]));
      const depthCache = new Map();
      const taskDepth = (id, seen = new Set()) => {
        if (depthCache.has(id)) return depthCache.get(id);
        if (seen.has(id)) return 0;
        seen.add(id);
        const task = dagById.get(id);
        const depth = !task || task.deps.length === 0
          ? 0
          : Math.max(...task.deps.map((dep) => taskDepth(dep, seen) + 1));
        depthCache.set(id, depth);
        return depth;
      };
      const nodeW = 124;
      const nodeH = 52;
      // Eight dots sit on a 3x3 grid around the status dot's center, clockwise
      // from the top. The center cell stays empty so the status dot and the
      // running animation share the same anchor point.
      const runDotOffsets = [[0, -5], [5, -5], [5, 0], [5, 5], [0, 5], [-5, 5], [-5, 0], [-5, -5]];
      const statusInsetX = 14;
      const statusInsetY = 14;
      const colGap = 18;
      const rowGap = 16;
      // Drag snapping uses the same grid as the generated layout.
      const topPad = 54;
      const handoffGap = 120;
      const handoffTargets = new Set(crossLinks.map((link) => link.to));
      const handoffSources = new Set(crossLinks.map((link) => link.from));
      const layoutTeam = (team, direction = 'down') => {
        const stages = new Map();
        for (const task of dagTasks.filter((item) => item.team === team)) {
          const depth = taskDepth(task.id);
          if (!stages.has(depth)) stages.set(depth, []);
          stages.get(depth).push(task);
        }
        const stageList = [...stages.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, list] of stageList) {
          list.sort((a, b) => {
            // Keep the bridge on the near bank: A's handoff target sits at the
            // bottom of its column (nearest B), B's handoff source at the top
            // (nearest A). Everything else keeps the stable id order.
            const targetFirst = team === 'alpha' && direction === 'up';
            const pa = team === 'alpha'
              ? (handoffTargets.has(a.id) === targetFirst ? 0 : 1)
              : (handoffSources.has(a.id) ? 0 : 1);
            const pb = team === 'alpha'
              ? (handoffTargets.has(b.id) === targetFirst ? 0 : 1)
              : (handoffSources.has(b.id) ? 0 : 1);
            if (pa !== pb) return pa - pb;
            return a.id.localeCompare(b.id, undefined, { numeric: true });
          });
        }
        const positions = new Map();
        let maxRows = 1;
        stageList.forEach(([, list], column) => {
          maxRows = Math.max(maxRows, list.length);
          list.forEach((task, row) => positions.set(task.id, {
            x: column * (nodeW + colGap),
            y: row * (nodeH + rowGap),
          }));
        });
        const width = stageList.length === 0 ? 1 : stageList.length * nodeW + (stageList.length - 1) * colGap;
        const height = stageList.length === 0 ? 1 : maxRows * nodeH + (maxRows - 1) * rowGap;
        if (direction === 'up') {
          for (const pos of positions.values()) pos.y = height - nodeH - pos.y;
        }
        return { positions, width, height };
      };
      // Back-to-back: A sits above the shared boundary and grows upward, B sits
      // below and grows downward, so their roots face each other at the left
      // bank and their branches grow away from the boundary. Horizontally both
      // read left-to-right (A is not mirrored). The handoff bridges the
      // downstream right ends across the gap, never root-to-root.
      const alphaUp = layoutTeam('alpha', 'up');
      const betaDown = layoutTeam('beta', 'down');
      const alphaTop = topPad;
      const alphaBottom = alphaTop + alphaUp.height;
      const betaTop = alphaBottom + handoffGap;
      const betaBottom = betaTop + betaDown.height;
      const graphH = betaBottom;
      const offsetLayout = (layout, dy) => new Map(
        [...layout.positions.entries()].map(([id, pos]) => [id, { x: pos.x, y: pos.y + dy }]),
      );
      const alphaPositions = offsetLayout(alphaUp, alphaTop);
      const betaPositions = offsetLayout(betaDown, betaTop);
      const positions = new Map([...alphaPositions, ...betaPositions]);
      const graphW = Math.max(alphaUp.width, betaDown.width);
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${graphW} ${graphH + 80}`);
      svg.setAttribute('role', 'group');
      svg.setAttribute('aria-label', tt('任务依赖图，按依赖深度从左到右排列'));
      const defs = document.createElementNS(svgNS, 'defs');
      const addArrowMarker = (id, color) => {
        const marker = document.createElementNS(svgNS, 'marker');
        marker.setAttribute('id', id);
        marker.setAttribute('markerWidth', '6');
        marker.setAttribute('markerHeight', '6');
        marker.setAttribute('refX', '5');
        marker.setAttribute('refY', '3');
        marker.setAttribute('orient', 'auto');
        const arrow = document.createElementNS(svgNS, 'path');
        arrow.setAttribute('d', 'M0,0 L6,3 L0,6 z');
        arrow.setAttribute('fill', color);
        marker.appendChild(arrow);
        defs.appendChild(marker);
      };
      addArrowMarker('dag-arrow-alpha', 'var(--tree-edge-alpha)');
      addArrowMarker('dag-arrow-beta', 'var(--tree-edge-beta)');
      svg.appendChild(defs);
      const viewport = document.createElementNS(svgNS, 'g');
      svg.appendChild(viewport);
      const flowEls = new Map();
      const flowStates = new WeakMap();
      // Distance integrates linear acceleration, cruise, then linear braking.
      const flowEasing = 'linear(0, 0.02381 10%, 0.095238 20%, 0.214286 30%, 0.357143 40%, 0.5 50%, 0.642857 60%, 0.785714 70%, 0.904762 80%, 0.97619 90%, 1)';
      const scheduleFlow = (flow) => {
        const state = flowStates.get(flow);
        if (!state?.enabled || state.timer) return;
        state.timer = setTimeout(() => {
          state.timer = null;
          if (state.enabled) {
            const length = flow.getTotalLength();
            flow.style.strokeDasharray = `14px ${length}px`;
            flow.style.strokeDashoffset = '0px';
            flow.style.opacity = '.9';
            state.anim?.cancel();
            const animation = flow.animate(
              [{ strokeDashoffset: '0px' }, { strokeDashoffset: `${-(length + 14)}px` }],
              {
                duration: Math.min(5200, Math.max(1500, Math.round(length / 160 * 1000))),
                easing: flowEasing,
                fill: 'forwards',
              },
            );
            state.anim = animation;
            animation.onfinish = () => {
              animation.cancel();
              state.anim = null;
              flow.style.opacity = '0';
              flow.style.strokeDashoffset = '0px';
              if (state.enabled) scheduleFlow(flow);
            };
          }
        }, 1000 + Math.random() * 2000);
      };
      const updateFlowGeometry = (flow, d) => {
        if (flow.getAttribute('d') === d) return;
        flow.setAttribute('d', d);
        const length = flow.getTotalLength();
        flow.style.strokeDasharray = `14px ${length}px`;
        const state = flowStates.get(flow);
        if (state?.anim) {
          state.anim.cancel();
          state.anim = null;
          flow.style.opacity = '0';
          flow.style.strokeDashoffset = '0px';
          if (state.enabled) scheduleFlow(flow);
        } else if (!state?.enabled) {
          flow.style.opacity = '0';
        }
      };
      const setEdgeFlow = (on) => {
        for (const flow of flowEls.values()) {
          const state = flowStates.get(flow);
          if (!state) continue;
          state.enabled = on;
          clearTimeout(state.timer);
          state.timer = null;
          if (on) {
            state.anim?.cancel();
            state.anim = null;
            flow.style.opacity = '0';
            flow.style.strokeDashoffset = '0px';
            scheduleFlow(flow);
          } else if (!state.anim) {
            flow.style.opacity = '0';
          }
        }
      };
      root.__setEdgeFlow = setEdgeFlow;
      let zoom = 1;
      let panX = 0;
      let panY = 0;
      const updateViewport = () => viewport.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
      // Both teams read left-to-right: parent's right edge to child's left edge.
      const edgePath = (x1, y1, x2, y2, laneY, forceLane = false) => {
        const outX = x1 + 12;
        if (x2 > x1 + 6) {
          const long = x2 - x1 > nodeW + colGap * 1.5;
          if (long || forceLane) return `M${x1} ${y1} H${outX} V${laneY} H${x2 - 12} V${y2} H${x2}`;
          if (Math.abs(y2 - y1) < 1) return `M${x1} ${y1} H${x2}`;
          const midX = x1 + (x2 - x1) / 2;
          const dy = y2 >= y1 ? 1 : -1;
          const r = Math.min(5, Math.abs(y2 - y1) / 2);
          return `M${x1} ${y1} H${midX - r} Q${midX} ${y1} ${midX} ${y1 + dy * r} V${y2 - dy * r} Q${midX} ${y2} ${midX + r} ${y2} H${x2}`;
        }
        // The target is behind the source; exit right, drop to the lane, come back.
        return `M${x1} ${y1} H${outX} V${laneY} H${x2 - 12} V${y2} H${x2}`;
      };
      // Cross-team handoffs must never cut through a node. Every handoff leaves
      // its source on the right edge, drops into the empty gutter between
      // columns, runs along the shared middle corridor, then enters the target
      // from the left gutter. Each handoff gets its own corridor lane.
      const handoffPath = (source, target, laneIndex = 0) => {
        const laneY = alphaBottom + 18 + (laneIndex % 8) * 11;
        const sourceGapX = source.x + nodeW + colGap / 2;
        const targetGapX = Math.max(colGap / 2, target.x - colGap / 2);
        // Enter/leave slightly below the vertical center so a handoff never
        // shares its first or last segment with an in-team dependency edge.
        const sourceY = source.y + nodeH / 2;
        const targetY = target.y + nodeH / 2;
        return `M${source.x + nodeW} ${sourceY} H${sourceGapX} V${laneY} H${targetGapX} V${targetY} H${target.x}`;
      };
      // Route a long in-team edge just below (beta) or above (alpha) the rows
      // that actually block it instead of dropping to the far edge of the lane.
      // This keeps detours short and stops them from wrapping the whole band.
      const laneYFor = (team, fromId, toId, source, target, x1, x2) => {
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        if (team === 'beta') {
          let lowest = Math.max(source.y + nodeH, target.y + nodeH);
          for (const [id, pos] of positions) {
            if (id === fromId || id === toId) continue;
            if (pos.x + nodeW <= left || pos.x >= right) continue;
            lowest = Math.max(lowest, pos.y + nodeH);
          }
          return Math.min(betaBottom + 18, lowest + 14);
        }
        let highest = Math.min(source.y, target.y);
        for (const [id, pos] of positions) {
          if (id === fromId || id === toId) continue;
          if (pos.x + nodeW <= left || pos.x >= right) continue;
          highest = Math.min(highest, pos.y);
        }
        return Math.max(alphaTop - 18, highest - 14);
      };
      // A horizontal run is allowed whenever it does not cross a node row in
      // the columns it spans. Only blocked runs fall back to a corridor lane.
      const segmentBlocked = (leftX, rightX, y, fromId, toId) => {
        const lo = Math.min(leftX, rightX);
        const hi = Math.max(leftX, rightX);
        for (const [id, pos] of positions) {
          if (id === fromId || id === toId) continue;
          if (pos.x + nodeW <= lo || pos.x >= hi) continue;
          if (y > pos.y - 2 && y < pos.y + nodeH + 2) return true;
        }
        return false;
      };
      const inTeamPath = (fromId, toId, source, target, team) => {
        const x1 = source.x + nodeW;
        const y1 = source.y + nodeH / 2;
        const x2 = target.x;
        const y2 = target.y + nodeH / 2;
        const forward = x2 > x1 + 6;
        const long = x2 - x1 > nodeW + colGap * 1.5;
        const gutterX = Math.max(colGap / 2, x2 - colGap / 2);
        if (long && !segmentBlocked(x1, gutterX, y1, fromId, toId)) {
          return `M${x1} ${y1} H${gutterX} V${y2} H${x2}`;
        }
        if (long && !segmentBlocked(x1, x2, y2, fromId, toId)) {
          return `M${x1} ${y1} H${x1 + colGap / 2} V${y2} H${x2}`;
        }
        const laneY = laneYFor(team, fromId, toId, source, target, x1, x2);
        return edgePath(x1, y1, x2, y2, laneY, !forward);
      };
      // The generated route is preferred while it is clear. When a dragged
      // node blocks it, A* on a visibility grid routes around the node sides
      // instead of letting the line disappear under an opaque card.
      const routeClearance = 6;
      const routeStub = 8;
      const pathBlockedByNodes = (edge, d, fromId, toId) => {
        edge.setAttribute('d', d);
        const length = edge.getTotalLength();
        if (!length) return false;
        const boxes = [];
        for (const [id, pos] of positions) {
          boxes.push({ id, left: pos.x, top: pos.y, right: pos.x + nodeW, bottom: pos.y + nodeH });
        }
        for (let distance = 2; distance < length - 2; distance += 3) {
          const point = edge.getPointAtLength(distance);
          const atStart = distance < 14;
          const atEnd = distance > length - 14;
          for (const box of boxes) {
            if (box.id === fromId && atStart) continue;
            if (box.id === toId && atEnd) continue;
            if (point.x > box.left + 1 && point.x < box.right - 1
              && point.y > box.top + 1 && point.y < box.bottom - 1) return true;
          }
        }
        return false;
      };
      const buildDetour = (fromId, toId, source, target) => {
        const obstacles = [];
        for (const [id, pos] of positions) {
          obstacles.push({
            left: pos.x - routeClearance,
            top: pos.y - routeClearance,
            right: pos.x + nodeW + routeClearance,
            bottom: pos.y + nodeH + routeClearance,
          });
        }
        const start = { x: source.x + nodeW + routeStub, y: source.y + nodeH / 2 };
        const end = { x: target.x - routeStub, y: target.y + nodeH / 2 };
        const xs = new Set([start.x, end.x, 0, graphW + 40]);
        const ys = new Set([start.y, end.y, 0, graphH + 40, alphaBottom + handoffGap / 2]);
        for (const obstacle of obstacles) {
          xs.add(obstacle.left);
          xs.add(obstacle.right);
          ys.add(obstacle.top);
          ys.add(obstacle.bottom);
        }
        const xList = [...xs].filter((x) => x >= -20 && x <= graphW + 80).sort((a, b) => a - b);
        const yList = [...ys].filter((y) => y >= -20 && y <= graphH + 80).sort((a, b) => a - b);
        const H = yList.length;
        const inside = (x, y, obstacle) => x > obstacle.left && x < obstacle.right && y > obstacle.top && y < obstacle.bottom;
        const pointBlocked = (x, y) => {
          if (Math.abs(x - start.x) < .01 && Math.abs(y - start.y) < .01) return false;
          if (Math.abs(x - end.x) < .01 && Math.abs(y - end.y) < .01) return false;
          return obstacles.some((obstacle) => inside(x, y, obstacle));
        };
        const segmentClear = (x1, y1, x2, y2) => {
          if (Math.abs(y1 - y2) < .01) {
            const left = Math.min(x1, x2);
            const right = Math.max(x1, x2);
            return !obstacles.some((obstacle) => y1 > obstacle.top && y1 < obstacle.bottom
              && right > obstacle.left + .01 && left < obstacle.right - .01);
          }
          if (Math.abs(x1 - x2) < .01) {
            const top = Math.min(y1, y2);
            const bottom = Math.max(y1, y2);
            return !obstacles.some((obstacle) => x1 > obstacle.left && x1 < obstacle.right
              && bottom > obstacle.top + .01 && top < obstacle.bottom - .01);
          }
          return false;
        };
        const xiOf = (x) => xList.indexOf(x);
        const yiOf = (y) => yList.indexOf(y);
        const sx = xiOf(start.x), sy = yiOf(start.y), ex = xiOf(end.x), ey = yiOf(end.y);
        if (sx < 0 || sy < 0 || ex < 0 || ey < 0) return null;
        const stateId = (xi, yi, dir) => ((xi * H + yi) * 3 + dir);
        const startId = stateId(sx, sy, 0);
        const goalBase = ex * H + ey;
        const best = new Map([[startId, 0]]);
        const parent = new Map();
        const heap = [];
        const push = (entry) => {
          heap.push(entry);
          let index = heap.length - 1;
          while (index > 0) {
            const parentIndex = (index - 1) >> 1;
            if (heap[parentIndex].f <= entry.f) break;
            heap[index] = heap[parentIndex];
            index = parentIndex;
          }
          heap[index] = entry;
        };
        const pop = () => {
          const top = heap[0];
          const last = heap.pop();
          if (heap.length && last) {
            let index = 0;
            while (true) {
              const left = index * 2 + 1;
              const right = left + 1;
              if (left >= heap.length) break;
              let child = left;
              if (right < heap.length && heap[right].f < heap[left].f) child = right;
              if (heap[child].f >= last.f) break;
              heap[index] = heap[child];
              index = child;
            }
            heap[index] = last;
          }
          return top;
        };
        const heuristic = (x, y) => Math.abs(x - end.x) + Math.abs(y - end.y);
        push({ id: startId, xi: sx, yi: sy, dir: 0, g: 0, f: heuristic(start.x, start.y) });
        let goalId = null;
        let expanded = 0;
        while (heap.length && expanded < 12000) {
          const current = pop();
          if (current.g !== best.get(current.id)) continue;
          expanded += 1;
          if (current.xi === ex && current.yi === ey) { goalId = current.id; break; }
          const x = xList[current.xi];
          const y = yList[current.yi];
          const neighbors = [];
          if (current.xi > 0) neighbors.push([current.xi - 1, current.yi, 1]);
          if (current.xi + 1 < xList.length) neighbors.push([current.xi + 1, current.yi, 1]);
          if (current.yi > 0) neighbors.push([current.xi, current.yi - 1, 2]);
          if (current.yi + 1 < H) neighbors.push([current.xi, current.yi + 1, 2]);
          for (const [nx, ny, dir] of neighbors) {
            const nxValue = xList[nx];
            const nyValue = yList[ny];
            if (pointBlocked(nxValue, nyValue)) continue;
            if (!segmentClear(x, y, nxValue, nyValue)) continue;
            const step = Math.abs(nxValue - x) + Math.abs(nyValue - y);
            const turn = current.dir && current.dir !== dir ? 10 : 0;
            const g = current.g + step + turn;
            const id = stateId(nx, ny, dir);
            if (best.has(id) && best.get(id) <= g) continue;
            best.set(id, g);
            parent.set(id, current.id);
            push({ id, xi: nx, yi: ny, dir, g, f: g + heuristic(nxValue, nyValue) });
          }
        }
        if (goalId === null) return null;
        const points = [];
        let cursor = goalId;
        while (cursor !== undefined) {
          const base = Math.floor(cursor / 3);
          const yi = base % H;
          const xi = Math.floor(base / H);
          points.push({ x: xList[xi], y: yList[yi] });
          cursor = parent.get(cursor);
        }
        points.reverse();
        points.unshift({ x: source.x + nodeW, y: source.y + nodeH / 2 });
        points.push({ x: target.x, y: target.y + nodeH / 2 });
        const compact = [];
        for (const point of points) {
          const last = compact[compact.length - 1];
          if (last && Math.abs(last.x - point.x) < .01 && Math.abs(last.y - point.y) < .01) continue;
          while (compact.length >= 2) {
            const before = compact[compact.length - 2];
            const middle = compact[compact.length - 1];
            const collinearX = Math.abs(before.x - middle.x) < .01 && Math.abs(middle.x - point.x) < .01;
            const collinearY = Math.abs(before.y - middle.y) < .01 && Math.abs(middle.y - point.y) < .01;
            if (!collinearX && !collinearY) break;
            compact.pop();
          }
          compact.push(point);
        }
        let d = `M${compact[0].x} ${compact[0].y}`;
        for (let index = 1; index < compact.length; index += 1) {
          const point = compact[index];
          const previous = compact[index - 1];
          if (Math.abs(point.y - previous.y) < .01) d += ` H${point.x}`;
          else if (Math.abs(point.x - previous.x) < .01) d += ` V${point.y}`;
          else d += ` L${point.x} ${point.y}`;
        }
        return d;
      };
      const routedPath = (edge, fromId, toId, source, target, team, handoff) => {
        const free = handoff
          ? handoffPath(source, target, Number(edge.dataset.lane || 0))
          : inTeamPath(fromId, toId, source, target, team);
        if (!pathBlockedByNodes(edge, free, fromId, toId)) {
          delete edge.dataset.detoured;
          return free;
        }
        const detour = buildDetour(fromId, toId, source, target);
        if (detour) {
          edge.dataset.detoured = '1';
          return detour;
        }
        delete edge.dataset.detoured;
        return free;
      };
      for (const task of dagTasks) {
        const target = positions.get(task.id);
        if (!target) continue;
        for (const dep of task.deps) {
          const source = positions.get(dep);
          if (!source) continue;
          const sourceTask = dagById.get(dep);
          const targetTask = dagById.get(task.id);
          const team = sourceTask?.team ?? 'alpha';
          const path = document.createElementNS(svgNS, 'path');
          const statusClass = targetTask?.status === 'done' ? 'done' : targetTask?.status === 'active' ? 'in-progress' : 'waiting';
          path.setAttribute('class', `gedge team-${team} ${statusClass}`);
          path.setAttribute('d', inTeamPath(dep, task.id, source, target, team));
          path.setAttribute('marker-end', `url(#dag-arrow-${team})`);
          path.dataset.from = dep;
          path.dataset.to = task.id;
          viewport.appendChild(path);
          const flow = document.createElementNS(svgNS, 'path');
          flow.setAttribute('class', `gedge-flow team-${team}`);
          flow.setAttribute('d', path.getAttribute('d'));
          flow.setAttribute('aria-hidden', 'true');
          flow.dataset.source = dep;
          flowEls.set(path, flow);
          viewport.appendChild(flow);
          const length = flow.getTotalLength();
          flow.style.strokeDasharray = `14px ${length}px`;
          flow.style.strokeDashoffset = '0px';
          flow.style.opacity = '0';
          flowStates.set(flow, { enabled: false, timer: null, anim: null });
        }
      }
      for (const [linkIndex, link] of crossLinks.entries()) {
        const source = positions.get(link.from);
        const target = positions.get(link.to);
        if (!source || !target) continue;
        const sourceTask = dagById.get(link.from);
        const path = document.createElementNS(svgNS, 'path');
        const handoffStatus = sourceTask?.status === 'done' ? 'done' : sourceTask?.status === 'active' ? 'in-progress' : 'waiting';
        const handoffTeam = sourceTask?.team ?? 'alpha';
        path.setAttribute('class', `gedge handoff cross-team team-${handoffTeam} ${handoffStatus}`);
        path.setAttribute('d', handoffPath(source, target, linkIndex));
        path.setAttribute('marker-end', `url(#dag-arrow-${handoffTeam})`);
        path.setAttribute('aria-label', `${sourceTask?.displayId ?? link.from} → ${dagById.get(link.to)?.displayId ?? link.to} ${LIVE_MODEL ? link.label : tt(link.label)}`);
        path.dataset.from = link.from;
        path.dataset.to = link.to;
        path.dataset.handoff = '1';
        path.dataset.lane = String(linkIndex);
        viewport.appendChild(path);
        const flow = document.createElementNS(svgNS, 'path');
        flow.setAttribute('class', `gedge-flow team-${handoffTeam}`);
        flow.setAttribute('d', path.getAttribute('d'));
        flow.setAttribute('aria-hidden', 'true');
        flow.dataset.source = link.from;
        flowEls.set(path, flow);
        viewport.appendChild(flow);
        const length = flow.getTotalLength();
        flow.style.strokeDasharray = `14px ${length}px`;
        flow.style.strokeDashoffset = '0px';
        flow.style.opacity = '0';
        flowStates.set(flow, { enabled: false, timer: null, anim: null });
      }
      const nodeEls = new Map();
      const edgeEls = [...viewport.querySelectorAll('.gedge')];
      for (const link of crossLinks) {
        for (const edge of edgeEls) {
          if (edge.dataset.handoff) continue;
          if (edge.dataset.to === link.to || edge.dataset.from === link.from) {
            edge.classList.add('handoff-linked');
          }
        }
      }
      const autoPositions = new Map([...positions.entries()].map(([id, pos]) => [id, { ...pos }]));
      const basePositions = new Map([...autoPositions.entries()].map(([id, pos]) => [id, { ...pos }]));
      const graphStateKey = `agent-teams-task-graph-v1:${location.pathname}`;
      // Saved drag coordinates only make sense for the node grid that produced
      // them. A size or gap change discards them so every gap stays uniform.
      const layoutSignature = `${nodeW}x${nodeH}:${colGap}x${rowGap}`;
      const graphState = (() => {
        try {
          const raw = localStorage.getItem(graphStateKey);
          const parsed = raw ? JSON.parse(raw) : {};
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
          return {};
        }
      })();
      const savedLayoutMatches = graphState.layout === layoutSignature;
      const savedViewportValid = savedLayoutMatches && Number.isFinite(graphState.zoom)
        && graphState.zoom >= 0.35 && graphState.zoom <= 3;
      let graphScrollLeft = savedViewportValid && Number.isFinite(graphState.scrollLeft) ? Math.max(0, graphState.scrollLeft) : 0;
      let graphScrollTop = savedViewportValid && Number.isFinite(graphState.scrollTop) ? Math.max(0, graphState.scrollTop) : 0;
      let graphSaveTimer = null;
      let graphStateDirty = false;
      const saveGraphState = (immediate = false) => {
        graphStateDirty = true;
        const write = () => {
          graphSaveTimer = null;
          try {
            localStorage.setItem(graphStateKey, JSON.stringify({
              layout: layoutSignature,
              zoom, panX, panY,
              scrollLeft: graphScrollLeft, scrollTop: graphScrollTop,
              positions: Object.fromEntries([...positions.entries()].map(([id, pos]) => [id, pos])),
            }));
            graphStateDirty = false;
          } catch (error) {
            notify?.('任务树布局无法保存');
          }
        };
        if (immediate) {
          if (graphSaveTimer) clearTimeout(graphSaveTimer);
          write();
          return;
        }
        if (!graphSaveTimer) graphSaveTimer = setTimeout(write, 120);
      };
      const flushGraphState = () => {
        if (graphStateDirty) saveGraphState(true);
      };
      if (savedLayoutMatches && graphState.positions && typeof graphState.positions === 'object') {
        for (const [id, saved] of Object.entries(graphState.positions)) {
          if (!positions.has(id) || !Number.isFinite(saved?.x) || !Number.isFinite(saved?.y)) continue;
          const savedPosition = {
            x: Math.max(0, saved.x),
            y: Math.max(0, saved.y),
          };
          positions.set(id, savedPosition);
          basePositions.set(id, { ...savedPosition });
        }
      }
      // Refresh resumes a valid saved view. Only an explicit reset returns to 1:1.
      zoom = savedViewportValid ? graphState.zoom : 1;
      panX = savedViewportValid && Number.isFinite(graphState.panX) ? graphState.panX : 0;
      panY = savedViewportValid && Number.isFinite(graphState.panY) ? graphState.panY : 0;
      updateViewport();
      let dragging = null;
      let lastDrag = { id: null, at: 0 };
      // Node titles sit in a fixed-width box, so the visible prefix has to
      // depend on the script: CJK/Korean glyphs are roughly twice as wide as
      // Latin ones and a single codepoint budget clipped "Project baseline" to
      // "Projec…" in en-US. The budget mirrors .gnode .gtitle inside the 124px
      // node box; a canvas measurement is used when the browser has one, and
      // the per-script estimate is the fallback for tests and exotic hosts.
      const NODE_TITLE_FONT_PX = 13;
      const NODE_TITLE_FONT_WEIGHT = 500;
      const NODE_TITLE_BUDGET_PX = nodeW - 20;
      const NODE_TITLE_NARROW_PX = NODE_TITLE_FONT_PX * 0.56;
      const NODE_TITLE_WIDE_PX = NODE_TITLE_FONT_PX;
      const NODE_TITLE_FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
      const isWideGlyph = (char) => /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char);
      const glyphWidth = (char) => (isWideGlyph(char) ? NODE_TITLE_WIDE_PX : NODE_TITLE_NARROW_PX);
      let titleMeasureContext = null;
      const titleCanvas = () => {
        if (titleMeasureContext !== null) return titleMeasureContext;
        try {
          const canvas = typeof document !== 'undefined' && document.createElement
            ? document.createElement('canvas')
            : null;
          const context = canvas && canvas.getContext ? canvas.getContext('2d') : null;
          if (context) context.font = `${NODE_TITLE_FONT_WEIGHT} ${NODE_TITLE_FONT_PX}px ${NODE_TITLE_FONT_FAMILY}`;
          titleMeasureContext = context && context.measureText ? context : false;
        } catch (error) {
          titleMeasureContext = false;
        }
        return titleMeasureContext;
      };
      const textWidth = (text) => {
        const context = titleCanvas();
        if (context) {
          try {
            return context.measureText(String(text)).width;
          } catch (error) { /* fall through to the estimate */ }
        }
        return [...String(text)].reduce((total, char) => total + glyphWidth(char), 0);
      };
      const truncateTitle = (text) => {
        const source = String(text);
        if (textWidth(source) <= NODE_TITLE_BUDGET_PX) return source;
        const glyphs = [...source];
        const ellipsisWidth = textWidth('…');
        let end = glyphs.length;
        while (end > 1 && textWidth(`${glyphs.slice(0, end).join('')}…`) > NODE_TITLE_BUDGET_PX) end -= 1;
        // Drop trailing whitespace so the ellipsis never floats after a space.
        while (end > 1 && /^\s$/u.test(glyphs[end - 1])) end -= 1;
        if (ellipsisWidth > NODE_TITLE_BUDGET_PX) return '…';
        return `${glyphs.slice(0, end).join('')}…`;
      };
      // Demo team prefixes arrive already localized (A team / Aチーム / A팀), so
      // the strip list covers the rendered labels and not only the zh-CN source.
      const stripTeamPrefix = (value) => String(value)
        .replace(/^v1\.88\s*/u, '')
        .replace(/^完成\s*/u, '')
        .replace(/^(A队|B队|A team|B team|Aチーム|Bチーム|A팀|B팀)\s*·\s*/u, '');
      const shortTitle = (task) => {
        const subject = displayTaskSubject(task);
        const clean = (!LIVE_MODEL && demoTaskCopy[task?.id])
          ? demoTaskText(task.id, 'title', subject)
          : stripTeamPrefix(subject);
        return truncateTitle(clean);
      };
      const placeNode = (id, pos) => {
        positions.set(id, { ...pos });
        const node = nodeEls.get(id);
        if (!node) return;
        const rect = node.querySelector('rect');
        if (rect) {
          rect.setAttribute('x', String(pos.x));
          rect.setAttribute('y', String(pos.y));
        }
        const dot = node.querySelector('.gdot');
        if (dot) {
          dot.setAttribute('cx', String(pos.x + nodeW - statusInsetX));
          dot.setAttribute('cy', String(pos.y + statusInsetY));
        }
        node.querySelectorAll('.run-dot').forEach((runDot, index) => {
          const [offsetX, offsetY] = runDotOffsets[index] ?? [0, 0];
          runDot.setAttribute('cx', String(pos.x + nodeW - statusInsetX + offsetX));
          runDot.setAttribute('cy', String(pos.y + statusInsetY + offsetY));
        });
        const texts = node.querySelectorAll('text');
        if (texts[0]) {
          texts[0].setAttribute('x', String(pos.x + 10));
          texts[0].setAttribute('y', String(pos.y + 17));
        }
        if (texts[1]) {
          texts[1].setAttribute('x', String(pos.x + 10));
          texts[1].setAttribute('y', String(pos.y + 38));
        }
        node.removeAttribute('transform');
      };
      const expandViewBox = () => {
        const visible = [...positions.entries()];
        const maxRight = Math.max(...visible.map(([, pos]) => pos.x + nodeW), graphW);
        const maxBottom = Math.max(...visible.map(([, pos]) => pos.y + nodeH), graphH + 48);
        const contentW = maxRight + 40;
        const contentH = maxBottom + 40;
        const viewW = Math.max(contentW, 1200);
        const viewH = Math.max(contentH, 760);
        const x = -Math.max(0, (viewW - contentW) / 2);
        const y = -Math.max(0, (viewH - contentH) / 2);
        svg.setAttribute('viewBox', `${x} ${y} ${viewW} ${viewH}`);
        // Keep one SVG unit equal to one CSS pixel so the fixed node font size
        // never shrinks with the panel width; narrower screens scroll instead.
        svg.style.minWidth = `${Math.round(viewW)}px`;
      };
      const routeEdges = (movedId) => {
        for (const edge of edgeEls) {
          const from = positions.get(edge.dataset.from);
          const to = positions.get(edge.dataset.to);
          if (!from || !to) continue;
          const ownEdge = edge.dataset.from === movedId || edge.dataset.to === movedId;
          if (movedId && !ownEdge && edge.dataset.detoured !== '1') {
            const moved = positions.get(movedId);
            if (moved) {
              const box = edge.getBBox();
              const touchesMoved = box.x < moved.x + nodeW + routeClearance
                && box.x + box.width > moved.x - routeClearance
                && box.y < moved.y + nodeH + routeClearance
                && box.y + box.height > moved.y - routeClearance;
              if (!touchesMoved) continue;
            }
          }
          const isHandoff = edge.dataset.handoff === '1';
          const team = edge.classList.contains('team-beta') ? 'beta' : 'alpha';
          const d = routedPath(edge, edge.dataset.from, edge.dataset.to, from, to, team, isHandoff);
          edge.setAttribute('d', d);
          const flow = flowEls.get(edge);
          if (flow) updateFlowGeometry(flow, d);
        }
      };
      const refreshEdges = (movedId) => routeEdges(movedId);
      const finishDrag = (event) => {
        if (!dragging) return;
        if (dragging.moved) {
          lastDrag = { id: dragging.id, at: Date.now() };
          saveGraphState();
        }
        try { dragging.group.releasePointerCapture(event.pointerId); } catch {}
        dragging = null;
        if (selectedTask) repositionTaskDetail();
      };
      const createNodeGroup = (task) => {
        const pos = positions.get(task.id);
        if (!pos) return null;
        const group = document.createElementNS(svgNS, 'g');
        group.setAttribute('class', `gnode team-${task.team ?? 'alpha'} ${task.status || 'done'}`);
        group.dataset.task = task.id;
        group.setAttribute('tabindex', '0');
        group.setAttribute('role', 'button');
        const taskStatusLabel = { done: '已完成', active: '进行中', waiting: '等待依赖', queued: '排队', failed: '失败', cancelled: '已取消' };
        const displaySubject = displayTaskSubject(task);
        group.setAttribute('aria-label', tt('{0} {1}，{2}', [task.displayId ?? task.id, displaySubject, tt(taskStatusLabel[task.status] ?? '等待依赖')]));
        group.setAttribute('aria-pressed', 'false');
        group.style.touchAction = 'none';
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('class', 'node-bg');
        rect.setAttribute('x', String(pos.x));
        rect.setAttribute('y', String(pos.y));
        rect.setAttribute('width', String(nodeW));
        rect.setAttribute('height', String(nodeH));
        rect.setAttribute('rx', '10');
        group.appendChild(rect);
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('class', 'gdot');
        dot.setAttribute('cx', String(pos.x + nodeW - statusInsetX));
        dot.setAttribute('cy', String(pos.y + statusInsetY));
        dot.setAttribute('r', '3');
        group.appendChild(dot);
        if (task.status === 'active') {
          group.setAttribute('aria-label', tt('{0} {1}，正在运行', [task.displayId ?? task.id, displaySubject]));
          runDotOffsets.forEach(([offsetX, offsetY], index) => {
            const runDot = document.createElementNS(svgNS, 'circle');
            runDot.setAttribute('class', 'run-dot');
            runDot.setAttribute('cx', String(pos.x + nodeW - statusInsetX + offsetX));
            runDot.setAttribute('cy', String(pos.y + statusInsetY + offsetY));
            runDot.setAttribute('r', '1.7');
            runDot.style.setProperty('--i', String(index));
            group.appendChild(runDot);
          });
        }
        const idText = document.createElementNS(svgNS, 'text');
        idText.setAttribute('class', 'gid');
        idText.setAttribute('x', String(pos.x + 10));
        idText.setAttribute('y', String(pos.y + 17));
        idText.textContent = task.displayId ?? task.id;
        group.appendChild(idText);
        const titleText = document.createElementNS(svgNS, 'text');
        titleText.setAttribute('class', 'gtitle');
        titleText.setAttribute('x', String(pos.x + 10));
        titleText.setAttribute('y', String(pos.y + 38));
        titleText.textContent = shortTitle(task);
        group.appendChild(titleText);
        group.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          const box = svg.getBoundingClientRect();
          const scale = box.width > 0 ? svg.viewBox.baseVal.width / (box.width * zoom) : 1;
          dragging = {
            id: task.id,
            startX: event.clientX,
            startY: event.clientY,
            orig: { ...positions.get(task.id) },
            base: { ...basePositions.get(task.id) },
            scale,
            group,
            moved: false,
          };
          try { group.setPointerCapture(event.pointerId); } catch {}
          event.preventDefault();
        });
        group.addEventListener('pointermove', (event) => {
          if (!dragging || dragging.id !== task.id) return;
          const dx = (event.clientX - dragging.startX) * dragging.scale;
          const dy = (event.clientY - dragging.startY) * dragging.scale;
          if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
          const gridX = nodeW + colGap;
          const gridY = nodeH + rowGap;
          // Snap movement relative to this node's generated/current anchor.
          // Absolute snapping shifts roots such as B-T1 because their
          // intentional lane offset is not a multiple of the grid spacing.
          const next = {
            x: Math.max(0, dragging.orig.x + Math.round(dx / gridX) * gridX),
            y: Math.max(0, dragging.orig.y + Math.round(dy / gridY) * gridY),
          };
          const overlaps = [...positions.entries()].some(([otherId, other]) => otherId !== task.id
            && !nodeEls.get(otherId)?.classList.contains('is-hidden')
            && next.x < other.x + nodeW && next.x + nodeW > other.x
            && next.y < other.y + nodeH && next.y + nodeH > other.y);
          if (overlaps) return;
          positions.set(task.id, next);
          graphStateDirty = true;
          group.setAttribute('transform', `translate(${next.x - dragging.base.x} ${next.y - dragging.base.y})`);
          refreshEdges(task.id);
          expandViewBox();
          if (selectedTask) repositionTaskDetail();
          event.preventDefault();
        });
        group.addEventListener('pointerup', finishDrag);
        group.addEventListener('pointercancel', finishDrag);
        viewport.appendChild(group);
        nodeEls.set(task.id, group);
        return group;
      };
      for (const task of dagTasks) createNodeGroup(task);
      refreshEdges();
      expandViewBox();
      const canvas = root.querySelector('#dag-canvas');
      canvas.replaceChildren(svg);
      let graphScrollRestorePending = savedViewportValid;
      const restoreGraphScroll = () => {
        // A hidden page has zero scroll geometry; wait until Tasks is visible.
        if (!graphScrollRestorePending || !canvas.clientWidth || !canvas.clientHeight) return;
        graphScrollRestorePending = false;
        canvas.scrollLeft = graphScrollLeft;
        canvas.scrollTop = graphScrollTop;
        graphScrollLeft = canvas.scrollLeft;
        graphScrollTop = canvas.scrollTop;
      };
      const captureGraphScroll = () => {
        if (graphScrollRestorePending || !canvas.clientWidth || !canvas.clientHeight) return;
        graphScrollLeft = canvas.scrollLeft;
        graphScrollTop = canvas.scrollTop;
        saveGraphState();
      };
      const resetGraphViewport = () => {
        graphScrollRestorePending = false;
        graphScrollLeft = 0;
        graphScrollTop = 0;
        canvas.scrollLeft = 0;
        canvas.scrollTop = 0;
        zoom = 1;
        panX = 0;
        panY = 0;
        updateViewport();
      };
      requestAnimationFrame(restoreGraphScroll);
      let panning = null;
      const svgPoint = (event) => {
        const box = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        return {
          x: (event.clientX - box.left) * vb.width / Math.max(1, box.width),
          y: (event.clientY - box.top) * vb.height / Math.max(1, box.height),
        };
      };
      svg.addEventListener('wheel', (event) => {
        event.preventDefault();
        const point = svgPoint(event);
        const beforeX = (point.x - panX) / zoom;
        const beforeY = (point.y - panY) / zoom;
        const next = Math.max(0.35, Math.min(3, zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
        panX = point.x - beforeX * next;
        panY = point.y - beforeY * next;
        zoom = next;
        updateViewport();
        if (selectedTask) positionTaskDetail(selectedTask);
        saveGraphState();
      }, { passive: false });
      svg.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.target.closest?.('.gnode')) return;
        panning = { startX: event.clientX, startY: event.clientY, panX, panY };
        try { svg.setPointerCapture(event.pointerId); } catch {}
        event.preventDefault();
      });
      svg.addEventListener('pointermove', (event) => {
        if (!panning) return;
        const box = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        panX = panning.panX + (event.clientX - panning.startX) * vb.width / Math.max(1, box.width);
        panY = panning.panY + (event.clientY - panning.startY) * vb.height / Math.max(1, box.height);
        graphStateDirty = true;
        updateViewport();
        if (selectedTask) positionTaskDetail(selectedTask);
        event.preventDefault();
      });
      const finishPan = () => {
        if (panning) saveGraphState();
        panning = null;
        if (selectedTask) positionTaskDetail(selectedTask);
      };
      svg.addEventListener('pointerup', finishPan);
      svg.addEventListener('pointercancel', finishPan);
      let hoverTask = null;
      let keyboardTask = null;
      const relationKey = (from, to) => `${from}->${to}`;
      const predecessors = new Map(dagTasks.map((task) => [task.id, []]));
      const successors = new Map(dagTasks.map((task) => [task.id, []]));
      const addRelation = (from, to) => {
        predecessors.get(to)?.push({ from, to });
        successors.get(from)?.push({ from, to });
      };
      for (const task of dagTasks) for (const dep of task.deps) addRelation(dep, task.id);
      for (const link of crossLinks) addRelation(link.from, link.to);
      /*
       * Selection intentionally lights the complete upstream and downstream
       * reachability of the selected task, including every branch and cross-
       * team handoff on those routes. It is not meant to isolate one local
       * chain. Because the sample graph deliberately cross-links both teams,
       * selecting a central task can correctly light almost the whole graph;
       * do not narrow this to a single path unless the user changes that rule.
       */
      const relatedIds = (id) => {
        const nodes = new Set();
        const edges = new Set();
        const upSeen = new Set();
        const downSeen = new Set();
        const up = (current) => {
          if (upSeen.has(current)) return;
          upSeen.add(current);
          nodes.add(current);
          for (const edge of predecessors.get(current) ?? []) {
            edges.add(relationKey(edge.from, edge.to));
            up(edge.from);
          }
        };
        const down = (current) => {
          if (downSeen.has(current)) return;
          downSeen.add(current);
          nodes.add(current);
          for (const edge of successors.get(current) ?? []) {
            edges.add(relationKey(edge.from, edge.to));
            down(edge.to);
          }
        };
        up(id);
        down(id);
        return { nodes, edges };
      };
      let selectedTask = null;
      let selectedListTask = null;
      const focusDag = (id) => {
        const related = id ? relatedIds(id) : null;
        const relatedNodes = related?.nodes ?? null;
        const relatedEdges = related?.edges ?? null;
        for (const [taskId, node] of nodeEls) {
          const isRelated = relatedNodes === null || relatedNodes.has(taskId);
          node.classList.toggle('dimmed', relatedNodes !== null && !isRelated);
          node.classList.toggle('focused', relatedNodes !== null && isRelated);
          const selected = selectedTask === taskId;
          node.classList.toggle('selected', selected);
          node.setAttribute('aria-pressed', String(selected));
        }
        const activeEdges = [];
        for (const edge of edgeEls) {
          const key = relationKey(edge.dataset.from, edge.dataset.to);
          const active = relatedEdges !== null && relatedEdges.has(key);
          edge.classList.toggle('active', active);
          edge.classList.toggle('dimmed', relatedEdges !== null && !active);
          flowEls.get(edge)?.classList.toggle('dimmed', relatedEdges !== null && !active);
          if (active) {
            const fromStage = Number(dagById.get(edge.dataset.from)?.displayId.match(/^[AB]-T(\d+)/u)?.[1] ?? 99);
            const toStage = Number(dagById.get(edge.dataset.to)?.displayId.match(/^[AB]-T(\d+)/u)?.[1] ?? 99);
            const priorityStage = Math.min(fromStage, toStage);
            edge.dataset.priorityStage = String(priorityStage);
            activeEdges.push({ edge, priorityStage });
          } else {
            delete edge.dataset.priorityStage;
          }
        }
        const firstNode = nodeEls.values().next().value;
        if (firstNode) {
          // Restore the base order on every focus change, then paint selected
          // links above unrelated ones while keeping every edge behind nodes.
          for (const edge of edgeEls) viewport.insertBefore(edge, firstNode);
          // Paint later stages first so T1/T2 links sit above overlapping lines.
          activeEdges.sort((a, b) => b.priorityStage - a.priorityStage);
          for (const { edge } of activeEdges) viewport.insertBefore(edge, firstNode);
        }
      };
      const taskDetailPanel = root.querySelector('#task-detail-panel');
      let detailTrigger = null;
      let suppressKeyboardFocus = false;
      const syncTaskListSelection = (id) => {
        root.querySelectorAll('#task-list .task-list-row').forEach((item) => {
          const selected = Boolean(id) && item.dataset.taskListId === id;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', String(selected));
          if (selected) item.scrollIntoView({ block: 'nearest' });
        });
      };
      const positionTaskDetail = (id) => {
        if (!taskDetailPanel || taskDetailPanel.hidden) return;
        const node = nodeEls.get(id);
        const graphPanel = root.querySelector('#task-tree-view');
        if (!node || !graphPanel) return;
        const graphRect = graphPanel.getBoundingClientRect();
        const nodeRect = node.getBoundingClientRect();
        const panelWidth = taskDetailPanel.offsetWidth;
        const panelHeight = taskDetailPanel.offsetHeight;
        if (!panelWidth || !panelHeight) return;
        const related = relatedIds(id).nodes;
        const protectedNodes = new Set([id]);
        for (const edge of predecessors.get(id) ?? []) protectedNodes.add(edge.from);
        for (const edge of successors.get(id) ?? []) protectedNodes.add(edge.to);
        const gap = 12;
        const candidates = [
          { name: 'right', x: nodeRect.right + gap, y: nodeRect.top },
          { name: 'left', x: nodeRect.left - panelWidth - gap, y: nodeRect.top },
          { name: 'bottom', x: nodeRect.left, y: nodeRect.bottom + gap },
          { name: 'top', x: nodeRect.left, y: nodeRect.top - panelHeight - gap },
        ];
        const overlapArea = (a, b) => {
          const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          return width * height;
        };
        const minLeft = graphRect.left + gap;
        const maxLeft = Math.max(minLeft, graphRect.right - panelWidth - gap);
        const minTop = graphRect.top + 52;
        const maxTop = Math.max(minTop, graphRect.bottom - panelHeight - gap);
        const scored = candidates.map((candidate) => {
          const left = Math.max(minLeft, Math.min(candidate.x, maxLeft));
          const top = Math.max(minTop, Math.min(candidate.y, maxTop));
          const panelRect = { left, top, right: left + panelWidth, bottom: top + panelHeight };
          let score = 0;
          for (const [taskId, taskNode] of nodeEls) {
            const nodeRect = taskNode.getBoundingClientRect();
            const overlap = overlapArea(panelRect, nodeRect);
            if (!overlap) continue;
            const weight = protectedNodes.has(taskId) ? 100000 : related.has(taskId) ? 1000 : 1;
            score += weight * overlap;
          }
          return { ...candidate, left, top, score };
        }).sort((a, b) => a.score - b.score)[0];
        if (!scored) return;
        taskDetailPanel.dataset.side = scored.name;
        taskDetailPanel.style.left = `${Math.round(scored.left - graphRect.left)}px`;
        taskDetailPanel.style.right = 'auto';
        taskDetailPanel.style.top = `${Math.round(scored.top - graphRect.top)}px`;
      };
      const openTaskDetail = (id) => {
        applyTask(id);
        setTaskDetailTab('summary');
        if (taskDetailPanel) {
          taskDetailPanel.hidden = false;
          taskDetailPanel.setAttribute('aria-hidden', 'false');
          positionTaskDetail(id);
        }
        taskDetailPanel?.querySelector('[data-task-detail-close]')?.focus();
      };
      const closeTaskDetail = () => {
        const trigger = detailTrigger;
        selectedTask = null;
        selectedListTask = null;
        detailTrigger = null;
        keyboardTask = null;
        hoverTask = null;
        syncTaskListSelection(null);
        if (taskDetailPanel) {
          taskDetailPanel.hidden = true;
          taskDetailPanel.setAttribute('aria-hidden', 'true');
        }
        focusDag(null);
        if (trigger?.isConnected) {
          const isTreeTrigger = trigger.matches?.('.gnode');
          if (isTreeTrigger) suppressKeyboardFocus = true;
          trigger.focus();
          if (isTreeTrigger) setTimeout(() => { suppressKeyboardFocus = false; }, 0);
        }
      };
      const selectTask = (id, trigger = null) => {
        selectedTask = id;
        selectedListTask = id;
        detailTrigger = trigger ?? nodeEls.get(id) ?? null;
        syncTaskListSelection(id);
        openTaskDetail(id);
        focusDag(id);
      };
      root.querySelector('#task-list')?.addEventListener('click', (event) => {
        const row = event.target.closest('[data-task-list-id]');
        if (!row) return;
        const id = row.dataset.taskListId;
        // Clicking the row that already owns the open panel closes it again.
        if (id === selectedListTask && taskDetailPanel && !taskDetailPanel.hidden) {
          closeTaskDetail();
          return;
        }
        selectTask(id, row);
      });
      root.querySelector('[data-task-detail-close]')?.addEventListener('click', closeTaskDetail);
      const currentTask = () => hoverTask ?? keyboardTask ?? selectedTask ?? null;
      const bindNodeInteractions = (id, node) => {
        node.addEventListener('mouseenter', () => { hoverTask = id; focusDag(currentTask()); });
        node.addEventListener('mouseleave', () => { hoverTask = null; focusDag(currentTask()); });
        node.addEventListener('focus', () => {
          if (suppressKeyboardFocus) { suppressKeyboardFocus = false; return; }
          keyboardTask = id;
          focusDag(currentTask());
        });
        node.addEventListener('blur', () => { keyboardTask = null; focusDag(currentTask()); });
        node.addEventListener('click', () => {
          if (lastDrag.id === id && Date.now() - lastDrag.at < 280) return;
          selectTask(id, node);
        });
        node.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectTask(id, node);
          }
        });
      };
      for (const [id, node] of nodeEls) bindNodeInteractions(id, node);
      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          keyboardTask = null;
          hoverTask = null;
          closeTaskDetail();
          focusDag(null);
        }
      });
      const taskOverviewToggles = root.querySelectorAll('[data-task-overview-toggle]');
      const taskWorkspace = root.querySelector('#task-workspace');
      const overviewStateKey = `agent-teams-task-overview-collapsed-v1:${location.pathname}`;
      let overviewCollapsed = false;
      try { overviewCollapsed = localStorage.getItem(overviewStateKey) === 'true'; } catch (error) { overviewCollapsed = false; }
      const applyOverviewState = () => {
        taskWorkspace?.classList.toggle('overview-collapsed', overviewCollapsed);
        const overviewLabel = overviewCollapsed ? tt('展开任务总览') : tt('收起任务总览');
        taskOverviewToggles.forEach((button) => {
          button.setAttribute('aria-expanded', String(!overviewCollapsed));
          button.setAttribute('aria-label', overviewLabel);
          button.setAttribute('title', overviewLabel);
          if (button.dataset.overviewLabel === 'text') {
            button.textContent = overviewLabel;
          }
        });
      };
      let repositionFrame = 0;
      const repositionTaskDetail = () => {
        if (!selectedTask) return;
        if (repositionFrame) cancelAnimationFrame(repositionFrame);
        repositionFrame = requestAnimationFrame(() => {
          repositionFrame = 0;
          positionTaskDetail(selectedTask);
        });
      };
      taskOverviewToggles.forEach((button) => button.addEventListener('click', () => {
        overviewCollapsed = !overviewCollapsed;
        try { localStorage.setItem(overviewStateKey, String(overviewCollapsed)); } catch (error) { /* storage is optional */ }
        applyOverviewState();
        // Keep keyboard focus on a visible toggle when its panel is hidden.
        if (!button.getClientRects().length) {
          [...taskOverviewToggles].find((toggle) => toggle.getClientRects().length)?.focus();
        }
        repositionTaskDetail();
      }));
      applyOverviewState();
      root.addEventListener('agent-teams:tasks-shown', repositionTaskDetail);
      root.addEventListener('agent-teams:tasks-shown', () => requestAnimationFrame(restoreGraphScroll));
      canvas.addEventListener('scroll', () => { captureGraphScroll(); repositionTaskDetail(); }, { passive: true });
      window.addEventListener('resize', () => {
        if (selectedTask) repositionTaskDetail();
      });
      window.addEventListener('pagehide', flushGraphState);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushGraphState();
      });
      const setTaskDetailTab = (name) => {
        root.querySelectorAll('[data-task-detail-tab]').forEach((tab) => {
          const active = tab.dataset.taskDetailTab === name;
          tab.classList.toggle('active', active);
          tab.setAttribute('aria-selected', String(active));
          tab.setAttribute('tabindex', active ? '0' : '-1');
        });
        root.querySelectorAll('[data-task-detail-view]').forEach((view) => {
          view.hidden = view.dataset.taskDetailView !== name;
        });
        repositionTaskDetail();
      };
      root.querySelectorAll('[data-task-detail-tab]').forEach((tab) => {
        tab.addEventListener('click', () => setTaskDetailTab(tab.dataset.taskDetailTab));
        tab.addEventListener('keydown', (event) => {
          const tabs = [...root.querySelectorAll('[data-task-detail-tab]')];
          const current = tabs.indexOf(tab);
          let nextIndex = -1;
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (current + 1) % tabs.length;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (current - 1 + tabs.length) % tabs.length;
          if (event.key === 'Home') nextIndex = 0;
          if (event.key === 'End') nextIndex = tabs.length - 1;
          if (nextIndex < 0) return;
          event.preventDefault();
          const next = tabs[nextIndex];
          setTaskDetailTab(next.dataset.taskDetailTab);
          next.focus();
        });
      });
      /*
       * One task-list row. `subject` and `owner` are user data, so they are
       * escaped and printed verbatim; only the fixed labels ("Owner · {0}",
       * "Upstream {0}") go through `tt`. `tt` is passed in because this helper
       * is exercised directly by test/ui-i18n.test.mjs.
       */
      const taskListRowHtml = ({ task, deps, selected, tt, displaySubject = task.subject, displayOwner = task.owner }) => {
        const statusText = { done: '已完成', active: '进行中', waiting: '等待依赖', queued: '排队', failed: '失败', cancelled: '已取消' };
        const tone = { done: 'mint', active: 'indigo', waiting: 'amber', queued: 'amber', failed: 'rose', cancelled: 'faint' };
        return '<button class="task-list-row' + (selected ? ' selected' : '') + '" type="button" aria-pressed="' + String(Boolean(selected)) + '" data-task-list-id="' + escapeHtml(task.id) + '">' 
          + '<span class="mono">' + escapeHtml(task.displayId) + '</span>'
          + '<span class="task-list-title"><b data-i18n-skip>' + escapeHtml(displaySubject) + '</b></span>'
          + '<small class="task-list-owner" data-i18n-skip>' + tt('负责人 · {0}', [displayOwner ? escapeHtml(displayOwner) : tt('未分配')]) + '</small>'
          + '<span class="badge ' + (tone[task.status] ?? '') + '">' + tt(statusText[task.status] ?? '等待') + '</span>'
          + '<span class="tiny muted" data-i18n-skip>' + tt('上游 {0}', [escapeHtml(deps)]) + '</span></button>';
      };
      const renderDemoTaskCards = () => {
        if (LIVE_MODEL) return;
        const teamCards = [...root.querySelectorAll('#page-dual .team-summary')];
        const rowsByTeam = [['t2', 't3', 't4'], ['b6', 'b7', 'b9']];
        teamCards.forEach((card, teamIndex) => {
          const rows = [...card.querySelectorAll('.mini-task')];
          rows.forEach((row, rowIndex) => {
            const id = rowsByTeam[teamIndex]?.[rowIndex];
            const task = id ? dagById.get(id) : null;
            if (!task) return;
            const title = row.querySelector('.mini-task-main b');
            const owner = row.querySelector('.mini-task-main > span');
            const ownerName = row.querySelector('.mini-task-main > span > [data-i18n-skip]');
            const badge = row.querySelector('.badge');
            if (title) {
              title.setAttribute('data-i18n-skip', '');
              title.textContent = `${task.displayId} ${displayTaskSubject(task)}`;
            }
            if (owner) {
              const name = demoTaskAssignee[id] ?? task.owner;
              if (ownerName) {
                ownerName.textContent = name;
                owner.textContent = '';
                owner.append(ownerName, document.createTextNode(' · '), document.createTextNode(tt(demoTaskRole[id] ?? '工程师')));
              } else {
                owner.textContent = `${name} · ${tt(demoTaskRole[id] ?? '工程师')}`;
                const nameNode = document.createElement('span');
                nameNode.setAttribute('data-i18n-skip', '');
                nameNode.textContent = name;
                owner.textContent = '';
                owner.append(nameNode, document.createTextNode(' · '), document.createTextNode(tt(demoTaskRole[id] ?? '工程师')));
              }
            }
            if (badge) badge.textContent = tt({ done: '已完成', active: '进行中', waiting: '等待' }[task.status] ?? '等待');
          });
        });
        const workers = [...root.querySelectorAll('#page-overview .worker-card:not(.contractor)')];
        const workerTasks = ['t2', 't3', 't4', 'b6', 'b7', 't1'];
        workers.forEach((card, index) => {
          const task = dagById.get(workerTasks[index]);
          if (!task) return;
          const taskEl = card.querySelector('.worker-task');
          if (taskEl) {
            taskEl.setAttribute('data-i18n-skip', '');
            taskEl.textContent = `${task.displayId} ${displayTaskSubject(task)}`;
          }
        });
      };
      const refreshDemoGraphLabels = () => {
        if (LIVE_MODEL) return;
        for (const task of dagTasks) {
          const node = nodeEls.get(task.id);
          if (!node) continue;
          const displaySubject = displayTaskSubject(task);
          const title = node.querySelector('.gtitle');
          if (title) title.textContent = shortTitle(task);
          const statusLabel = { done: '已完成', active: '进行中', waiting: '等待依赖', queued: '排队', failed: '失败', cancelled: '已取消' }[task.status] ?? '等待依赖';
          node.setAttribute('aria-label', tt(task.status === 'active' ? '{0} {1}，正在运行' : '{0} {1}，{2}', task.status === 'active'
            ? [task.displayId ?? task.id, displaySubject]
            : [task.displayId ?? task.id, displaySubject, tt(statusLabel)]));
        }
      };
      const updateTaskMeta = () => {
        /*
         * The task graph (`dagTasks` and `crossLinks`) is the source of truth
         * for every task count and completion bar. Keep these views derived
         * here so a task added to the graph cannot leave overview totals stale.
         * Worker-to-task examples elsewhere are static prototype content; they
         * are not a backend assignment feed and must not be used to infer edges.
         */
        const total = dagTasks.length;
        const done = dagTasks.filter((task) => task.status === 'done').length;
        const active = dagTasks.filter((task) => task.status === 'active').length;
        const waiting = dagTasks.filter((task) => task.status === 'waiting').length;
        const queued = dagTasks.filter((task) => task.status === 'queued').length;
        const failed = dagTasks.filter((task) => task.status === 'failed' || task.status === 'cancelled').length;
        const alphaTasks = dagTasks.filter((task) => (task.team ?? 'alpha') === 'alpha');
        const betaTasks = dagTasks.filter((task) => task.team === 'beta');
        const alphaDone = alphaTasks.filter((task) => task.status === 'done').length;
        const betaDone = betaTasks.filter((task) => task.status === 'done').length;
        const activeTasks = dagTasks.filter((task) => task.status === 'active');
        const waitingTasks = dagTasks.filter((task) => task.status === 'waiting');
        const setText = (selector, text) => {
          const element = root.querySelector(selector);
          if (element) element.textContent = text;
        };
        const setBar = (selector, value, denominator) => {
          const element = root.querySelector(selector);
          if (element) element.style.width = `${denominator ? Math.round((value / denominator) * 100) : 0}%`;
        };
        const shortSubject = (task) => {
          if (!LIVE_MODEL && demoTaskCopy[task.id]) return demoTaskText(task.id, 'title', task.subject);
          return task.subject;
        };
        const sub = root.querySelector('#task-page-sub');
        const modeText = window.__AGENT_TEAMS_LIVE_MODEL__?.teamCount === 1 ? tt('单队') : tt('双队');
        if (sub) sub.textContent = tt('{0} · {1} 个任务 · {2} 进行中 · {3} 等待依赖{4} · {5} 已完成{6} · 依赖树可拖动', [
          modeText,
          total,
          active,
          waiting,
          queued ? ` ${tt('{0} 排队', [queued])}` : '',
          done,
          failed ? ` ${tt('· {0} 失败/取消', [failed])}` : '',
        ]);
        const modeBadge = root.querySelector('#team-mode-badge');
        if (modeBadge) modeBadge.textContent = modeText;
        const panelBadge = root.querySelector('#task-panel-badge');
        if (panelBadge) panelBadge.textContent = tt('{0}/{1} 已交付', [done, total]);
        const navBadge = root.querySelector('[data-nav="tasks"] .nav-badge');
        const listBody = root.querySelector('#task-list');
        const listCount = root.querySelector('#task-list-count');
        if (listCount) listCount.textContent = String(total);
        if (listBody) {
          listBody.innerHTML = total > 0
            ? dagTasks.map((task) => {
              const deps = (predecessors.get(task.id) ?? []).map((edge) => dagById.get(edge.from)?.displayId).filter(Boolean).join(' · ') || '—';
              return taskListRowHtml({
                task,
                deps,
                selected: task.id === selectedListTask,
                tt,
                displaySubject: displayTaskSubject(task),
                displayOwner: LIVE_MODEL ? task.owner : demoTaskTeam(task.id),
              });
            }).join('')
            : `<div class="task-list-empty">${tt('暂无任务 · 通过 /agent-teams 创建')}</div>`;
        }
        if (navBadge) navBadge.textContent = String(dagTasks.length);
        setText('#overview-active', String(activeTasks.length));
        setText('#overview-active-foot', activeTasks.slice(0, 2).map((task) => `${task.displayId} · ${shortSubject(task)}`).join(' · ') || tt('暂无进行中任务'));
        setBar('#overview-active-bar', activeTasks.length, dagTasks.length);
        setText('#overview-waiting', String(waitingTasks.length));
        const waitingLabels = waitingTasks.slice(0, 4).map((task) => task.displayId);
        if (waitingTasks.length > waitingLabels.length) waitingLabels.push(`+${waitingTasks.length - waitingLabels.length}`);
        const queuedTasks = dagTasks.filter((task) => task.status === 'queued');
        const queuedLabels = queuedTasks.slice(0, 4).map((task) => task.displayId);
        if (queuedTasks.length > queuedLabels.length) queuedLabels.push(`+${queuedTasks.length - queuedLabels.length}`);
        // The value counts dependency waits only; the footnote names both
        // buckets so queued work is visible without inflating “等待依赖”.
        const waitingFoot = [
          waitingTasks.length ? tt(`等待 ${waitingTasks.length}`) + (waitingLabels.length ? ` · ${waitingLabels.join(' · ')}` : '') : '',
          queuedTasks.length ? tt(`排队 ${queuedTasks.length}`) + (queuedLabels.length ? ` · ${queuedLabels.join(' · ')}` : '') : '',
        ].filter(Boolean).join(' · ') || tt('暂无等待任务');
        setText('#overview-waiting-foot', waitingFoot);
        setBar('#overview-waiting-bar', waitingTasks.length, dagTasks.length);
        setText('#dual-total', String(dagTasks.length));
        setText('#dual-total-foot', singleTeam ? tt('A队 {0}', [alphaTasks.length]) : tt('A队 {0} · B队 {1}', [alphaTasks.length, betaTasks.length]));
        setBar('#dual-total-bar', dagTasks.length, dagTasks.length);
        const noCrossLinks = LIVE_MODEL && crossLinks.length === 0;
        setText('#cross-team-link-count', noCrossLinks ? '—' : String(crossLinks.length));
        setText('#cross-team-link-foot', noCrossLinks ? tt('实时快照未提供跨队连线') : tt('A/B双向交付与回流连线'));
        setBar('#cross-team-link-bar', crossLinks.length, crossLinks.length);
        setText('#dual-alpha-progress', `${alphaDone}/${alphaTasks.length}`);
        setBar('#dual-alpha-bar', alphaDone, alphaTasks.length);
        setText('#dual-beta-progress', `${betaDone}/${betaTasks.length}`);
        setBar('#dual-beta-bar', betaDone, betaTasks.length);
        const alphaWaiting = alphaTasks.filter((task) => task.status === 'waiting').length;
        const betaWaiting = betaTasks.filter((task) => task.status === 'waiting').length;
        setText('#dual-alpha-summary', String(alphaWaiting));
        setBar('#dual-alpha-summary-bar', alphaWaiting, alphaTasks.length);
        setText('#dual-beta-summary', String(betaWaiting));
        setBar('#dual-beta-summary-bar', betaWaiting, betaTasks.length);
        setText('#dual-alpha-summary-badge', alphaWaiting ? tt('等待') : tt('无等待'));
        setText('#dual-beta-summary-badge', betaWaiting ? tt('等待') : tt('无等待'));
      };
      renderDemoTaskCards();
      updateTaskMeta();
      refreshDemoGraphLabels();
      applyTask(defaultTaskId);
      focusDag(null);
      if (LIVE_MODEL && dagTasks.length === 0) {
        const setText = (selector, text) => {
          const element = root.querySelector(selector);
          if (element) element.textContent = text;
        };
        setText('#task-detail-avatar', '—');
        setText('#task-detail-title', tt('暂无任务'));
        setText('#task-detail-sub', tt('实时快照 · 在对话中让队长创建任务'));
        setText('#task-detail-scope', '—');
        setText('#task-detail-acceptance', '—');
        setText('#task-detail-worktree', '—');
        setText('#task-detail-merge', '—');
        setText('#task-detail-upstream', '—');
        setText('#task-detail-downstream', '—');
        const status = root.querySelector('#task-detail-status');
        if (status) { status.textContent = tt('等待依赖'); status.className = 'badge amber'; }
        const canvas = root.querySelector('#dag-canvas');
        if (canvas && !canvas.querySelector('.live-empty')) {
          const empty = document.createElement('div');
          empty.className = 'live-empty';
          empty.textContent = tt('暂无任务 · 通过 /agent-teams 创建');
          empty.style.cssText = 'display:grid;place-items:center;min-height:320px;color:var(--muted);font-size:12px';
          canvas.appendChild(empty);
        }
      }
      const addTaskNode = (subjectText, role = '工程师', scope = '待补充', acceptance = '待队长拆解') => {
        const id = `t${dagTasks.length + 1}`;
        const alphaTaskNumber = dagTasks.filter((item) => (item.team ?? 'alpha') === 'alpha').length + 1;
        const task = { id, displayId: `A-T${alphaTaskNumber}`, subject: subjectText, owner: '—', deps: [], status: 'waiting', team: 'alpha' };
        dagTasks.push(task);
        dagById.set(id, task);
        // Place the new task in its own column at the top of the A lane so it
        // never lands below the B lane or collides with an existing node.
        const alphaXs = dagTasks
          .filter((item) => item.id !== id && (item.team ?? 'alpha') === 'alpha')
          .map((item) => positions.get(item.id)?.x)
          .filter((value) => Number.isFinite(value));
        const pos = {
          x: (alphaXs.length ? Math.max(...alphaXs) : 0) + nodeW + colGap,
          y: alphaTop,
        };
        positions.set(id, pos);
        autoPositions.set(id, { ...pos });
        basePositions.set(id, { ...pos });
        taskData[id] = [task.displayId, subjectText, `未规划 · ${role} · 等待队长拆解`, 'amber', '等待依赖'];
        taskDetails[id] = { scope, acceptance, worktree: '—', merge: '—', upstream: '—', downstream: '—' };
        const group = createNodeGroup(task);
        bindNodeInteractions(id, group);
        refreshEdges();
        expandViewBox();
        updateTaskMeta();
        selectTask(id, group);
        notify(tt('任务已创建：{0}', [subjectText]));
      };

      const resetLayout = () => {
        for (const [id, pos] of autoPositions) {
          basePositions.set(id, { ...pos });
          placeNode(id, pos);
        }
        refreshEdges();
        expandViewBox();
        resetGraphViewport();
        saveGraphState(true);
        focusDag(currentTask());
        repositionTaskDetail();
        notify('已恢复自动布局');
      };
      root.querySelectorAll('[data-dag-action]').forEach((button) => {
        button.addEventListener('click', () => {
          if (button.dataset.dagAction === 'reset-view') {
            resetGraphViewport();
            saveGraphState(true);
            repositionTaskDetail();
            notify('视图已复位');
          } else resetLayout();
        });
      });

      root.querySelector('#hard-stop')?.addEventListener('click', () => {
        if (hardStopped) return;
        const button = root.querySelector('#hard-stop');
        const label = root.querySelector('#hard-stop-text');
        if (!hardStopArmed) {
          hardStopArmed = true;
          button?.classList.add('armed');
          button?.setAttribute('aria-label', tt('硬停已解锁，0.5 秒后再次点击确认'));
          button?.setAttribute('title', tt('已解锁，0.5 秒后可再次点击确认'));
          if (label) label.textContent = tt('解锁中');
          if (button) button.disabled = true;
          notify(tt('硬停已解锁，0.5 秒后可再次点击确认'));
          window.setTimeout(() => {
            if (hardStopped) return;
            if (button) button.disabled = false;
            if (label) label.textContent = tt('确认硬停');
            button?.setAttribute('aria-label', tt('再次点击确认硬停'));
            button?.setAttribute('title', tt('再次点击立即硬停所有会话'));
          }, 500);
          return;
        }
        hardStopped = true;
        paused = false;
        const runText = root.querySelector('#run-text');
        if (runText) runText.textContent = tt('已硬停');
        const runPill = root.querySelector('#run-pill');
        if (runPill) runPill.classList.remove('live');
        const pauseButton = root.querySelector('#pause-toggle');
        if (pauseButton) {
          pauseButton.disabled = true;
          pauseButton.title = tt('团队已硬停');
        }
        if (button) {
          button.disabled = true;
          button.classList.remove('armed');
          button.setAttribute('aria-label', tt('已硬停所有会话'));
          button.setAttribute('title', tt('团队已硬停'));
        }
        if (label) label.textContent = tt('已硬停');
        notify(tt('已硬停所有会话'));
      });

      const mergeLabel = (state) => ({
        none: '未进入合并', pending: '排队中', review_pending: '审核中',
        review_pending_internal: '内部审核', ff_failed: '快进失败', ff_exhausted: '快进重试耗尽',
        merged: '已合并', conflict: '冲突', failed: '失败', rejected: '已驳回',
        revert_failed: '回滚失败', blocked: '阻断',
      }[String(state ?? '')] ?? (state || '—'));
      const mergeKindLabel = {
        work: '工作', requirements: '需求', implementation: '实现', verification: '验证',
        review: '审核', repair: '修复', integration: '集成', audit: '审计',
      };
      const liveMergeData = LIVE_MODEL
        ? Object.fromEntries((LIVE_MODEL.mergeQueue ?? []).map((task) => {
          const reviewPassed = task.review?.verdict === 'pass';
          const commands = Array.isArray(task.commandsRun) ? task.commandsRun : [];
          const commandsPassed = commands.length > 0 && commands.every((item) => item.status === 'passed');
          const merged = task.mergeState === 'merged' || Boolean(task.mergedCommit);
          const graphTask = (LIVE_MODEL.dagTasks ?? []).find((item) => item.id === task.id);
          return [task.id, {
            title: `${graphTask?.displayId ?? task.id} ${task.subject}`,
            sub: `${task.assignee ?? tt('未分配')} · ${tt(mergeKindLabel[task.kind] ?? task.kind ?? '工作')} · ${tt('系统自动判断')}`,
            commit: task.mergeCommit ?? task.mergedCommit ?? task.integrationCommit ?? '—',
            branch: task.integrationBranch ?? '—',
            verdict: task.review?.verdict ?? mergeLabel(task.mergeState),
            status: mergeLabel(task.mergeState),
            canApprove: false,
            rowBadge: mergeLabel(task.mergeState),
            rowClass: merged ? 'mint' : task.mergeState === 'failed' || task.mergeState === 'rejected' ? 'rose' : 'amber',
            checks: [
              [tt('独立审查通过'), reviewPassed],
              [tt('验证命令通过'), commandsPassed],
              [tt('合并状态完成'), merged],
            ],
          }];
        }))
        : null;
      const mergeData = liveMergeData ?? {
        'T-099': {
          titleId: 'T-099', titleKey: '优惠券金额格式化', sub: 'A-04 → 合并执行员 → 外包审查员',
          commit: '7f3a2c1', branch: 'integration/alpha/T-099/7f3a2c1',
          verdict: '独立审核通过', status: '待你批准', canApprove: true,
          rowBadge: '审核通过', rowClass: 'mint',
          checks: [['patch 与批准 commit 一致', true], ['没有多改文件或夹带提交', true], ['必需测试通过', true], ['语义/安全审查通过', true]],
        },
        'T-101': {
          titleId: 'T-101', titleKey: '订单列表空状态', sub: 'A-04 → 审核中 · 等待审核',
          commit: 'pending', branch: 'integration/alpha/T-101/pending',
          verdict: '审核中', status: '审核中', canApprove: false,
          rowBadge: 'pending', rowClass: 'amber',
          checks: [['patch 与批准 commit 一致', true], ['没有多改文件或夹带提交', true], ['必需测试通过', false], ['语义/安全审查通过', false]],
        },
        'T-108': {
          titleId: 'T-108', titleKey: '支付回调幂等性回归', sub: 'A-02 → 验证完成 · 等待合并',
          commit: 'queued', branch: 'integration/alpha/T-108/queued',
          verdict: '验证完成', status: '排队中', canApprove: false,
          rowBadge: 'queued', rowClass: '',
          checks: [['patch 与批准 commit 一致', true], ['没有多改文件或夹带提交', true], ['必需测试通过', true], ['语义/安全审查通过', false]],
        },
      };
      let selectedMerge = LIVE_MODEL ? (Object.keys(mergeData)[0] ?? '') : 'T-099';
      let mergeQueueCount = 0;
      const mergeQueueList = root.querySelector('#merge-queue-list');
      const mergeQueueEmpty = root.querySelector('#merge-queue-empty');
      const pendingMergeEntries = () => Object.entries(mergeData).filter(([, item]) => item.canApprove);
      const setText = (selector, value) => { const el = root.querySelector(selector); if (el) el.textContent = value; };
      const renderMerge = (id) => {
        const data = mergeData[id];
        if (!data) {
          if (LIVE_MODEL) {
            setText('#merge-hero-title', tt('暂无合并任务'));
            setText('#merge-hero-sub', tt('系统尚未把任务推进到合并阶段'));
            setText('#merge-commit', '—');
            setText('#merge-branch', '—');
            const verdict = root.querySelector('#merge-verdict');
            if (verdict) {
              verdict.textContent = tt('系统未提供');
              verdict.className = 'badge faint';
            }
            const status = root.querySelector('#merge-panel-status');
            if (status) {
              status.textContent = tt('系统未提供');
              status.className = 'badge faint';
            }
            const checkCount = root.querySelector('#merge-check-count');
            if (checkCount) {
              checkCount.textContent = '—';
              checkCount.className = 'badge';
            }
            const checklist = root.querySelector('#merge-checklist');
            if (checklist) checklist.innerHTML = '';
          }
          return;
        }
        setText('#merge-hero-title', mergeTitle(data));
        setText('#merge-hero-sub', tt(data.sub));
        setText('#merge-commit', data.commit);
        setText('#merge-branch', data.branch);
        const verdict = root.querySelector('#merge-verdict');
        if (verdict) {
          const tone = data.verdict === '已合并' ? 'mint'
            : data.verdict === '已驳回' ? 'rose'
              : data.canApprove ? 'mint'
                : data.verdict === '审核中' ? 'indigo'
                  : data.verdict === '验证完成' ? '' : 'amber';
          verdict.textContent = tt(data.verdict);
          verdict.className = `badge ${tone}`.trim();
        }
        const status = root.querySelector('#merge-panel-status');
        if (status) {
          const tone = data.status.startsWith('已合并') ? 'mint'
            : data.status === '已驳回' ? 'rose'
              : data.status === '审核中' ? 'indigo'
                : data.status === '排队中' ? '' : 'amber';
          status.textContent = tt(data.status);
          status.className = `badge ${tone}`.trim();
        }
        const checklist = root.querySelector('#merge-checklist');
        if (checklist) {
          checklist.innerHTML = data.checks.map(([label, ok]) => `<div class="check-row${ok ? '' : ' pending'}"><span class="icon" data-lucide="${ok ? 'check' : 'clock-3'}"></span>${tt(label)}</div>`).join('');
          const passed = data.checks.filter(([, ok]) => ok).length;
          const checkCount = root.querySelector('#merge-check-count');
          if (checkCount) {
            checkCount.textContent = tt('{0}/{1} 通过', [passed, data.checks.length]);
            checkCount.className = `badge ${passed === data.checks.length ? 'mint' : 'amber'}`;
          }
        }
        const reject = root.querySelector('#merge-reject');
        const approve = root.querySelector('#merge-approve');
        const readOnly = Boolean(LIVE_MODEL);
        if (reject) {
          reject.disabled = readOnly || !data.canApprove;
          reject.title = readOnly ? tt('实时视图只读') : '';
        }
        if (approve) {
          approve.disabled = readOnly || !data.canApprove;
          approve.title = readOnly ? tt('实时视图只读') : '';
          const label = readOnly ? tt('系统自动判断') : data.status.startsWith('已合并') ? tt('已合并') : data.status === '已驳回' ? tt('已驳回') : data.canApprove ? tt('通过并进主分支') : tt('等待审查通过');
          approve.innerHTML = `<span class="icon" data-lucide="git-merge"></span>${label}`;
        }
      };
      const renderMergeQueue = () => {
        const pending = pendingMergeEntries();
        const all = Object.entries(mergeData);
        if (mergeQueueList) {
          mergeQueueList.replaceChildren();
          for (const [id, item] of all) {
            const tone = item.canApprove ? 'amber'
              : item.status === '审核中' ? 'indigo'
                : item.status === '排队中' ? 'muted'
                  : item.status === '已驳回' ? 'rose' : 'mint';
            const label = item.canApprove ? tt('待你批准')
              : item.status === '已合并 · 待后置审查' ? tt('已合并') : tt(item.status);
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `queue-row${id === selectedMerge ? ' selected' : ''}`;
            row.dataset.merge = id;
            row.innerHTML = `<span class="dot tone-${tone}"></span><div class="queue-main"><b data-i18n-skip>${escapeHtml(mergeTitle(item))}</b><span data-i18n-skip>${escapeHtml(tt(item.sub))}</span></div><span class="badge ${tone === 'muted' ? '' : tone}">${escapeHtml(label)}</span>`;
            row.addEventListener('click', () => selectMerge(row));
            mergeQueueList.appendChild(row);
          }
        }
        if (mergeQueueEmpty) mergeQueueEmpty.hidden = all.length > 0;
        mergeQueueCount = LIVE_MODEL ? all.length : pending.length;
        const count = root.querySelector('#merge-queue-count');
        if (count) {
          count.textContent = LIVE_MODEL ? tt('系统队列 · 共 {0}', [all.length]) : tt('{0} 待批准 · 共 {1}', [pending.length, all.length]);
          count.className = `badge ${all.length ? 'amber' : 'faint'}`;
        }
        const nav = root.querySelector('[data-nav="merge"] .nav-badge');
        if (nav) nav.textContent = String(mergeQueueCount);
      };
      const auditBody = root.querySelector('#audit-body');
      const auditCount = root.querySelector('#audit-count');
      const syncAuditCount = () => {
        if (LIVE_MODEL) return; // the live panel sets its own "最近 N 条" label
        if (auditBody && auditCount) auditCount.textContent = tt('{0} 条（历史）', [auditBody.children.length]);
      };
      const appendAudit = (eventName, object, result, tone) => {
        if (!auditBody) return;
        const rowEl = document.createElement('tr');
        rowEl.innerHTML = `<td data-i18n-skip>${timestamp()}</td><td>${eventName}</td><td data-i18n-skip>${object}</td><td><span class="badge ${tone}">${tt(result)}</span></td>`;
        auditBody.prepend(rowEl);
        syncAuditCount();
      };
      syncAuditCount();
      const selectMerge = (row) => {
        selectedMerge = row.dataset.merge;
        mergeQueueList?.querySelectorAll('[data-merge]').forEach((item) => item.classList.toggle('selected', item === row));
        renderMerge(selectedMerge);
        notify(tt('已选择 {0}', [selectedMerge]));
      };
      const markMerge = (next, eventName, result, tone) => {
        if (LIVE_MODEL) { notify(tt('实时视图只读，不能合并')); return; }
        const data = mergeData[selectedMerge];
        if (!data || !data.canApprove) { notify(tt('后置审查未通过，暂不能合并')); return; }
        data.canApprove = false;
        data.status = next === '已合并' ? '已合并 · 待后置审查' : next;
        data.verdict = next;
        data.checks = data.checks.map(([label]) => [label, true]);
        if (next === '已合并') data.checks = [...data.checks, ['外包审查员复核中', false]];
        renderMergeQueue();
        renderMerge(selectedMerge);
        appendAudit(eventName, `${selectedMerge} · ${tt('合并执行员')}`, result, tone);
        if (next === '已合并') appendAudit('merge.post_review_pending', `${selectedMerge} · ${tt('外包审查员')}`, 'pending', 'amber');
        notify(`${selectedMerge} ${tt(next)}`);
      };
      root.querySelector('#merge-approve')?.addEventListener('click', () => markMerge('已合并', 'task.merged', 'main', 'mint'));
      root.querySelector('#merge-reject')?.addEventListener('click', () => markMerge('已驳回', 'task.merge_rejected', 'rollback', 'rose'));
      renderMergeQueue();
      renderMerge(selectedMerge);

      const modeCards = [...root.querySelectorAll('[data-run-mode]')];
      const accessPill = root.querySelector('#access-pill');
      const modeBadge = root.querySelector('#mode-badge');
      const fullWarning = root.querySelector('#full-access-warning');
      const runModeKey = `agent-teams-run-mode-v1:${location.pathname}`;
      const readRunMode = () => {
        try { return localStorage.getItem(runModeKey) === 'full' ? 'full' : 'standard'; } catch (error) { return 'standard'; }
      };
      const persistRunMode = (full) => {
        try { localStorage.setItem(runModeKey, full ? 'full' : 'standard'); } catch (error) { /* storage is optional */ }
      };
      const confirmFullAccess = () => {
        if (window.confirm(tr('完全访问会关闭所有审批并锁定设置。确定开启吗？'))) return true;
        notify(tr('已取消完全访问'));
        return false;
      };
      let fullAccessSnapshot = null;
      const captureFullAccessState = () => ({
        mailStates: [...root.querySelectorAll('[data-mail-state]')].map((el) => ({ el, text: el.textContent, className: el.className })),
        mailDetails: [...root.querySelectorAll('[data-mail-row] .action-main span')].map((el) => ({ el, text: el.textContent })),
        mailButtons: [...root.querySelectorAll('[data-mail-approve], [data-mail-reject]')].map((el) => ({ el, hidden: el.hidden })),
        approvalCount: root.querySelector('#approval-count')?.textContent ?? null,
        mailCount: root.querySelector('#mail-pending-count')?.textContent ?? null,
        mailHint: root.querySelector('#mail-mode-hint')?.textContent ?? null,
        riskBadges: ['#risk-merge', '#risk-mail'].map((selector) => {
          const el = root.querySelector(selector);
          return el ? { el, text: el.textContent, className: el.className } : null;
        }).filter(Boolean),
      });
      const restoreFullAccessState = () => {
        if (!fullAccessSnapshot) return;
        const snapshot = fullAccessSnapshot;
        fullAccessSnapshot = null;
        snapshot.mailStates.forEach(({ el, text, className }) => { el.textContent = text; el.className = className; });
        snapshot.mailDetails.forEach(({ el, text }) => { el.textContent = text; });
        snapshot.mailButtons.forEach(({ el, hidden }) => { el.hidden = hidden; });
        const restoreText = (selector, text) => {
          if (text === null) return;
          const el = root.querySelector(selector);
          if (el) el.textContent = text;
        };
        restoreText('#approval-count', snapshot.approvalCount);
        restoreText('#mail-pending-count', snapshot.mailCount);
        restoreText('#mail-mode-hint', snapshot.mailHint);
        snapshot.riskBadges.forEach(({ el, text, className }) => { el.textContent = text; el.className = className; });
      };
      const setRunMode = (mode) => {
        if (LIVE_MODEL) {
          if (modeBadge) {
            modeBadge.textContent = tr('系统自动');
            modeBadge.className = 'badge indigo';
          }
          if (accessPill) accessPill.hidden = true;
          if (fullWarning) fullWarning.hidden = true;
          modeCards.forEach((card) => {
            card.classList.remove('selected');
            card.disabled = true;
          });
          return;
        }
        const full = mode === 'full';
        const alreadyFull = root.classList.contains('full-access');
        if (full && !alreadyFull) fullAccessSnapshot = captureFullAccessState();
        root.classList.toggle('full-access', full);
        if (accessPill) accessPill.hidden = !full;
        if (modeBadge) {
          modeBadge.textContent = full ? tr('完全访问') : tr('标准');
          modeBadge.className = `badge ${full ? 'rose' : 'indigo'}`;
        }
        if (fullWarning) fullWarning.hidden = !full;
        modeCards.forEach((card) => card.classList.toggle('selected', card.dataset.runMode === mode));
        persistRunMode(full);
        if (full) {
          root.querySelectorAll('[data-mail-state]').forEach((state) => {
            state.textContent = tr('已批准 · 完全访问');
            state.className = 'badge mint';
            const row = state.closest('[data-mail-row]');
            const detail = row?.querySelector('.action-main span');
            if (detail) detail.textContent = tr('完全访问已自动批准，对方邮箱可见');
          });
          root.querySelectorAll('[data-mail-approve], [data-mail-reject]').forEach((button) => { button.hidden = true; });
          const approvalCount = root.querySelector('#approval-count');
          if (approvalCount) approvalCount.textContent = '0';
          const mailCount = root.querySelector('#mail-pending-count');
          if (mailCount) mailCount.textContent = tr('{0} 待批', [0]);
          const mailHint = root.querySelector('#mail-mode-hint');
          if (mailHint) mailHint.textContent = tr('完全访问：跨队消息已自动批准并投递。审计、预算硬上限和硬停仍然有效。');
          for (const [id, text] of [['#risk-merge', tr('自动通过')], ['#risk-mail', tr('自动通过')]]) {
            const badge = root.querySelector(id);
            if (badge) { badge.textContent = text; badge.className = 'badge mint'; }
          }
        } else {
          restoreFullAccessState();
        }
      };
      modeCards.forEach((card) => card.addEventListener('click', () => {
        if (card.dataset.runMode === 'full') {
          if (root.classList.contains('full-access')) { notify(tr('当前已是完全访问')); return; }
          if (!confirmFullAccess()) return;
          setRunMode('full');
          notify(tr('完全访问已开启，设置已锁定'));
          return;
        }
        setRunMode('standard');
        notify(tr('已回到标准模式：只有高风险需要确认'));
      }));

      root.querySelectorAll('.toggle').forEach((toggle) => {
        toggle.addEventListener('click', () => {
          const next = toggle.getAttribute('aria-checked') !== 'true';
          if (toggle.getAttribute('aria-label') === tr('完全访问')) {
            if (next && !confirmFullAccess()) return;
            setRunMode(next ? 'full' : 'standard');
          }
          toggle.setAttribute('aria-checked', String(next));
        });
      });
      setRunMode(readRunMode());
      document.addEventListener('agent-teams:locale-changed', () => {
        try {
          const nextTitles = {
            overview: tr('总览'), dual: singleTeam ? tr('单队') : tr('双队'), tasks: tr('任务'), members: tr('成员'),
            merge: tr('审核与合并'), patrol: tr('巡检'), audit: tr('审计'), settings: tr('设置'),
          };
          Object.assign(titles, nextTitles);
          const activeNav = root.querySelector('.nav-item.active')?.dataset.nav;
          if (activeNav && titles[activeNav] && crumb) crumb.textContent = titles[activeNav];
          if (livePill) {
            livePill.textContent = LIVE_MODEL ? tr('实时') : tr('静态示例');
            livePill.title = LIVE_MODEL ? tr('实时快照 v{0}', [LIVE_MODEL.version || '']) : tr('未连接 daemon，显示内置示例');
          }
          renderMembers();
          renderLiveWorkforce();
          renderLiveTeamCards();
          renderLiveStaticPanels();
          renderDemoTaskCards();
          updateTaskMeta();
          refreshDemoGraphLabels();
          applyTask(defaultTaskId);
          renderMergeQueue();
          renderMerge(selectedMerge);
          setRunMode(readRunMode());
          applyOverviewState();
          localizeRoot(root);
        } catch (error) { /* a locale switch must not break the console */ }
      });

      const flowToggle = root.querySelector('#edge-flow-toggle');
      if (flowToggle) {
        const applyFlow = (on) => {
          root.classList.toggle('edge-flow-off', !on);
          flowToggle.setAttribute('aria-checked', String(on));
          root.__setEdgeFlow?.(on);
        };
        // Flow is opt-in for every page load; a refresh never starts it.
        applyFlow(false);
        root.classList.remove('edge-flow-booting');
        flowToggle.addEventListener('click', () => {
          applyFlow(flowToggle.getAttribute('aria-checked') !== 'true');
        });
      }
    })();
