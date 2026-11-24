/**
 * Cycle Tracker UI. Stores only what the user entered (period entries, unusual-cycle flags,
 * settings, dismissed notes) and derives everything else through CycleCore on every render.
 * Persistence goes through CycleStore (IndexedDB). Records leave the device only when the user turns
 * on the optional server backup (CycleSync).
 */
const APP_VERSION = "1.6";

(function () {
  'use strict';

  const C = CycleCore;
  const S = CycleStore;

  // Local-only UI conveniences (not part of the exported data)
  const LS_PROMPT_SNOOZE = 'period_end_prompt_snooze';
  const LS_UNSURE_SEEN = 'period_unsure_note_seen';

  const DISCLAIMER = 'Predictions are estimates based on your past cycles. They are not reliable for preventing pregnancy and are not medical advice.';

  const REASON_LABELS = {
    pregnancy: 'Pregnancy',
    miscarriage: 'Miscarriage',
    birth_control_change: 'Starting or stopping birth control',
    illness: 'Illness',
    other: 'Other',
    out_of_range: 'Unusual length'
  };

  const PHASE_LABELS = {
    menstrual: 'Menstrual', follicular: 'Follicular', ovulatory: 'Ovulatory', luteal: 'Luteal'
  };

  // General mood and libido tendencies by phase. These are broad population patterns, not a
  // prediction for one person; the wording is shown with that caveat. `level` drives the badge style.
  const PHASE_MOOD = {
    menstrual: {
      level: 'varies', label: 'Varies',
      text: 'Energy and mood are often lower, and some people feel tired or irritable. Libido varies a lot: some feel less in the mood, others more.'
    },
    follicular: {
      level: 'rising', label: 'Often rising',
      text: 'Mood and energy usually lift as estrogen rises, and libido often builds through this phase.'
    },
    ovulatory: {
      level: 'high', label: 'Often highest',
      text: 'Often the most energetic and social days, and libido is typically at its highest. This is when many people feel most in the mood.'
    },
    luteal: {
      level: 'low', label: 'Often lower, especially late',
      text: 'Early on, mood is often steady with moderate libido. In the week before a period many people feel more irritable, tired or low, and libido is often lower.'
    }
  };

  // Mood note for a phase; none when hormonal birth control is on (phases don't apply) or there is no phase
  function moodFor(phase) {
    if (!phase || bcOn()) return null;
    return PHASE_MOOD[phase] || null;
  }

  // One mood line (badge plus text) for the summary card and day sheet
  function moodBlock(phase) {
    const mood = moodFor(phase);
    if (!mood) return null;
    return el('div', { class: 'mood-line' },
      el('span', { class: 'mood-badge mood-' + mood.level, text: 'Mood & libido: ' + mood.label }),
      el('p', { class: 'muted', text: mood.text + ' Everyone is different.' }));
  }

  // In-memory copy of the stored records, and the model derived from them
  const state = { entries: [], flags: [], settings: null, dismissals: [] };
  let model = null;

  // Calendar and navigation state
  const view = { tab: 'calendar', year: 0, month: 0, focusCycleId: null };

  // First-run wizard answers
  let ob = null;

  // Optional server backup controller (created in init)
  let sync = null;
  // Container of the Settings "Server backup" section while Settings is open
  let backupBox = null;

  /* =============================================================== helpers */

  const $ = sel => document.querySelector(sel);

  // Builds an element: props may hold class, text, dataset, on<event> handlers and attributes
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(k => {
        const v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    kids.flat().forEach(c => {
      if (c === null || c === undefined || c === false) return;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function svgEl(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(k => n.setAttribute(k, attrs[k]));
    return n;
  }

  const today = () => C.localToday();

  // Date formatting from day numbers (UTC based so the device zone never shifts the day)
  function fmtDn(dn, opts) {
    return new Date(dn * 86400000).toLocaleDateString(undefined, Object.assign({ timeZone: 'UTC' }, opts));
  }
  const fmtShort = dn => fmtDn(dn, { month: 'short', day: 'numeric' });
  const fmtLong = dn => fmtDn(dn, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const fmtYear = dn => fmtDn(dn, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtStr = str => fmtYear(C.toDn(str));

  // "Dec 3-6" within one month, "Dec 30 - Jan 2" across months
  function fmtRange(a, b) {
    if (a === b) return fmtShort(a);
    if (C.toStr(a).slice(0, 7) === C.toStr(b).slice(0, 7)) {
      return fmtShort(a) + '–' + fmtDn(b, { day: 'numeric' });
    }
    return fmtShort(a) + ' – ' + fmtShort(b);
  }

  function pluralDays(n) { return n + (n === 1 ? ' day' : ' days'); }

  const bcOn = () => state.settings.hormonal_birth_control === 'yes';

  function phaseLabel(phase) {
    if (!phase) return '';
    return bcOn() ? 'Bleed' : PHASE_LABELS[phase];
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: the prompt simply shows again */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to remove */ } }

  /* ================================================================ storage */

  // Week start from the device locale (0 = Sunday)
  function localeWeekStart() {
    try {
      const loc = new Intl.Locale(navigator.language);
      const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
      if (info && info.firstDay) return info.firstDay % 7;
    } catch (e) { /* older browser: default below */ }
    return 0;
  }

  function newRecord(fields) {
    const t = S.nowIso();
    return Object.assign({ id: S.uuid(), created_at: t, updated_at: t, deleted: false }, fields);
  }

  // A fresh device's default settings carry an epoch updated_at, so settings restored from a server backup
  // always replace them; the first real change (saveSettings) stamps the current time.
  function defaultSettings() {
    const rec = newRecord({
      id: 'settings',
      usual_cycle_length: null,
      usual_period_length: null,
      hormonal_birth_control: 'no',
      show_ovulation: true,
      show_fertile_window: true,
      show_phase_tints: true,
      show_mood_line: true,
      week_starts_on: localeWeekStart(),
      onboarding_completed_at: null,
      disclaimer_acknowledged_at: null,
      last_export_at: null,
      export_nudge_snoozed_until: null,
      schema_version: 1
    });
    rec.updated_at = '1970-01-01T00:00:00.000Z';
    return rec;
  }

  // Loads every record from storage into memory, creating the settings record when missing
  async function loadAll() {
    const [entries, flags, settings, dismissals] = await Promise.all([
      S.getAll('period_entries'), S.getAll('cycle_flags'), S.getAll('settings'), S.getAll('health_note_dismissals')
    ]);
    state.entries = entries;
    state.flags = flags;
    state.dismissals = dismissals;
    state.settings = settings.find(s => s.id === 'settings') || null;
    if (!state.settings) {
      state.settings = defaultSettings();
      await S.put('settings', state.settings);
    }
  }

  // Writes one record (bumping updated_at) and mirrors it into the in-memory list
  async function saveRec(store, list, rec) {
    rec.updated_at = S.nowIso();
    await S.put(store, rec);
    const i = list.findIndex(x => x.id === rec.id);
    if (i < 0) list.push(rec); else list[i] = rec;
    return rec;
  }

  const saveEntry = e => saveRec('period_entries', state.entries, e);
  const saveFlag = f => saveRec('cycle_flags', state.flags, f);
  const saveDismissal = d => saveRec('health_note_dismissals', state.dismissals, d);

  async function saveSettings(patch) {
    Object.assign(state.settings, patch);
    state.settings.updated_at = S.nowIso();
    await S.put('settings', state.settings);
    recompute();
  }

  function newEntry(fields) {
    return newRecord(Object.assign({
      start_precision: 'exact', end_precision: 'exact', end_date: null, source: 'live'
    }, fields));
  }

  const liveEntries = () => state.entries.filter(e => !e.deleted).sort((a, b) => (a.start_date < b.start_date ? -1 : 1));

  /* ================================================================ dialogs */

  // Opens a modal sheet. buttons: [{label, kind, onClick(ctl)}]; onClick may return false to stay open.
  function openSheet(opts) {
    const dialog = el('dialog', { class: 'sheet' });
    const ctl = { dialog: dialog, close: () => { if (dialog.open) dialog.close(); } };
    const foot = el('div', { class: 'sheet-foot' });
    (opts.buttons || []).forEach(b => {
      foot.append(el('button', {
        type: 'button',
        class: 'btn' + (b.kind ? ' btn--' + b.kind : ''),
        text: b.label,
        onclick: async () => {
          const r = b.onClick ? await b.onClick(ctl) : undefined;
          if (r !== false) ctl.close();
        }
      }));
    });
    dialog.append(el('div', { class: 'sheet-head' }, el('h2', { text: opts.title || '' })));
    dialog.append(el('div', { class: 'sheet-body' }, opts.body));
    if (opts.buttons && opts.buttons.length) dialog.append(foot);
    dialog.addEventListener('click', e => { if (e.target === dialog) ctl.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (opts.onClose) opts.onClose(); });
    document.body.append(dialog);
    dialog.showModal();
    return ctl;
  }

  // Asks a question with several answers; resolves the chosen value, or null when cancelled
  function choose(message, options, o) {
    o = o || {};
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const buttons = options.map(opt => ({
        label: opt.label, kind: opt.kind, onClick: () => { finish(opt.value); }
      }));
      if (!o.noCancel) buttons.push({ label: 'Cancel', onClick: () => { finish(null); } });
      openSheet({
        title: o.title || '',
        body: el('div', null, String(message).split('\n').filter(Boolean).map(t => el('p', { text: t }))),
        buttons: buttons,
        onClose: () => finish(null)
      });
    });
  }

  let toastTimer = null;
  // Shows a short message, optionally with an action button such as Undo
  function showToast(message, actionLabel, onAction) {
    const t = $('#toast');
    clear(t).append(el('span', { text: message }));
    if (actionLabel) {
      t.append(el('button', {
        type: 'button', class: 'link-btn', text: actionLabel,
        onclick: () => { t.hidden = true; onAction(); }
      }));
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6500);
  }

  // Two or three exclusive choices; returns { node, get() }
  function segmented(options, value, onChange) {
    let current = value;
    const node = el('div', { class: 'segmented' });
    const buttons = options.map(o => {
      const b = el('button', {
        type: 'button', class: 'seg' + (o.value === current ? ' is-on' : ''), text: o.label,
        onclick: () => {
          current = o.value;
          buttons.forEach(x => x.classList.toggle('is-on', x === b));
          if (onChange) onChange(current);
        }
      });
      return b;
    });
    node.append(...buttons);
    return { node: node, get: () => current };
  }

  function field(label, input) {
    return el('label', { class: 'field' }, el('span', { text: label }), input);
  }

  /* ============================================================== rendering */

  // Rebuilds the model from stored records and redraws everything
  function recompute() {
    model = C.buildModel({ entries: state.entries, flags: state.flags, settings: state.settings }, today());
    renderAll();
  }

  function renderAll() {
    const done = !!state.settings.onboarding_completed_at;
    $('#onboarding').hidden = done;
    $('#appRoot').hidden = !done;
    if (!done) { renderOnboarding(); return; }
    renderSummary();
    renderNotices();
    renderCalendar();
    renderHistory();
    renderStats();
  }

  function switchTab(tab) {
    view.tab = tab;
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.tab === tab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    $('#panelCalendar').hidden = tab !== 'calendar';
    $('#panelHistory').hidden = tab !== 'history';
    $('#panelStats').hidden = tab !== 'stats';
  }

  /* ---------- summary ---------- */

  function renderSummary() {
    const box = clear($('#summary'));
    const m = model;
    if (!m.last) {
      box.append(
        el('div', { class: 'cycle-line', text: 'No periods logged yet' }),
        el('p', { class: 'muted', text: 'Tap today’s date on the calendar to mark when your period starts, or add past periods in Settings to get predictions.' }),
        el('span', { class: 'confidence-label', text: m.confidence.label }),
        el('span', { class: 'muted', text: m.confidence.text })
      );
      return;
    }
    const info = C.dayInfo(m, m.today);
    if (m.today >= m.L) {
      const ph = phaseLabel(info.phase);
      box.append(el('div', { class: 'cycle-line', text: 'Day ' + (m.today - m.L + 1) + (ph ? ' · ' + ph : '') }));
    }
    box.append(moodBlock(info.phase));
    if (m.ongoing) {
      box.append(el('div', { class: 'muted', text: 'Period in progress · day ' + m.ongoingDay }));
    }
    if (m.lateDays > 0) {
      box.append(el('div', { class: 'late-notice', text: 'Period is ' + pluralDays(m.lateDays) + ' late' }));
    }
    const nx = m.next;
    box.append(el('div', {
      class: 'next-line',
      text: (m.n === 0 ? 'Default estimate: ' : '') + 'Next period likely ' + fmtRange(nx.from, nx.to) +
        ', most likely ' + fmtShort(nx.mostLikely) + '.'
    }));
    box.append(
      el('span', { class: 'confidence-label', text: m.confidence.label }),
      el('span', { class: 'muted', text: m.confidence.text })
    );
  }

  /* ---------- notices (end prompt, health note, backup nudge) ---------- */

  function exportNudgeDue() {
    const s = state.settings;
    if (liveEntries().length < 3) return false;
    if (s.export_nudge_snoozed_until && today() <= s.export_nudge_snoozed_until) return false;
    if (s.last_export_at) {
      const ageDays = (Date.now() - Date.parse(s.last_export_at)) / 86400000;
      if (ageDays <= 60) return false;
    }
    const changed = state.entries.concat(state.flags).some(r => !s.last_export_at || r.updated_at > s.last_export_at);
    return changed;
  }

  function renderNotices() {
    const box = clear($('#notices'));
    const m = model;

    // Prompt to end a period that has run longer than expected
    if (m.ongoing && m.ongoingDay >= C.round(m.P) + 3 && lsGet(LS_PROMPT_SNOOZE) !== today()) {
      box.append(el('div', { class: 'card notice' },
        el('h3', { text: 'Has your period ended?' }),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn--primary', text: 'Ended today', onclick: () => logEnd(today()) }),
          el('button', {
            type: 'button', class: 'btn', text: 'Still going',
            onclick: () => { lsSet(LS_PROMPT_SNOOZE, today()); renderNotices(); }
          }))));
    }

    // One health note at a time, most severe first
    const note = C.healthNotes(m, state.dismissals)[0];
    if (note) {
      box.append(el('div', { class: 'card notice notice--health' },
        el('h3', { text: note.title }),
        el('p', { text: note.text }),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn', text: 'Dismiss', onclick: () => dismissNote(note) }))));
    }

    // One-time hint for users unsure about hormonal birth control
    if (state.settings.hormonal_birth_control === 'unsure' && !lsGet(LS_UNSURE_SEEN)) {
      box.append(el('div', { class: 'card notice' },
        el('p', { text: 'If you use hormonal birth control, ovulation and phases may not apply to you. You can change this in Settings.' }),
        el('div', { class: 'row' },
          el('button', {
            type: 'button', class: 'btn', text: 'Dismiss',
            onclick: () => { lsSet(LS_UNSURE_SEEN, '1'); renderNotices(); }
          }))));
    }

    if (exportNudgeDue()) {
      box.append(el('div', { class: 'card notice' },
        el('p', { text: 'Your data lives only on this device. Save a backup?' }),
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn btn--primary', text: 'Export now', onclick: exportData }),
          el('button', {
            type: 'button', class: 'btn', text: 'Not now',
            onclick: async () => {
              await saveSettings({ export_nudge_snoozed_until: C.toStr(C.toDn(today()) + 30) });
            }
          }))));
    }
  }

  // Stores the dismissal so the note returns only if its evidence changes
  async function dismissNote(note) {
    const existing = state.dismissals.find(d => d.note_type === note.type);
    const rec = existing || newRecord({ note_type: note.type, evidence_key: note.key });
    rec.evidence_key = note.key;
    rec.deleted = false;
    await saveDismissal(rec);
    recompute();
  }

  /* ---------- calendar ---------- */

  // CSS classes for one calendar day, following the priority: logged > predicted > phase tint
  function dayClasses(info) {
    const s = state.settings;
    const c = ['day'];
    if (info.isToday) c.push('today');
    if (info.logged) c.push('logged');
    else if (info.predictedEnd) c.push('pp-end');
    else if (info.likely) c.push('pp-likely');
    else if (info.band) c.push('pp-band');
    if (info.phase && s.show_phase_tints !== false) {
      c.push('ph-' + info.phase);
      if (info.phaseKind === 'predicted') c.push('pred');
    }
    if (info.fertile) c.push('fertile');
    return c;
  }

  function weekdayLabels() {
    const ws = state.settings.week_starts_on || 0;
    const out = [];
    for (let i = 0; i < 7; i++) {
      // 2023-01-01 is a Sunday
      const d = new Date(Date.UTC(2023, 0, 1 + ((ws + i) % 7)));
      out.push(d.toLocaleDateString(undefined, { weekday: 'narrow', timeZone: 'UTC' }));
    }
    return out;
  }

  // Builds a month grid; cellFor(dn, dayOfMonth) returns the element for a real day
  function monthGrid(year, month, cellFor) {
    const grid = el('div', { class: 'cal-grid' });
    weekdayLabels().forEach(l => grid.append(el('div', { class: 'cal-dow', text: l })));
    const ws = state.settings.week_starts_on || 0;
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const blanks = (first - ws + 7) % 7;
    for (let i = 0; i < blanks; i++) grid.append(el('div', { class: 'day is-blank' }));
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const prefix = year + '-' + String(month + 1).padStart(2, '0') + '-';
    for (let d = 1; d <= count; d++) {
      grid.append(cellFor(C.toDn(prefix + String(d).padStart(2, '0')), d));
    }
    return grid;
  }

  function dayAriaLabel(info) {
    const bits = [fmtLong(info.dn)];
    if (info.logged) bits.push('period logged');
    else if (info.likely) bits.push('period likely');
    else if (info.predictedEnd) bits.push('period expected');
    else if (info.band) bits.push('period possible');
    if (info.ovulation) bits.push('estimated ovulation');
    if (info.fertile) bits.push('fertile window');
    return bits.join(', ');
  }

  function renderCalendar() {
    $('#calTitle').textContent = new Date(Date.UTC(view.year, view.month, 1))
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const wrap = clear($('#calGrid'));
    const showMood = moodLineOn();
    const moodDays = [];
    wrap.classList.toggle('no-tints', state.settings.show_phase_tints === false);
    wrap.append(monthGrid(view.year, view.month, (dn, d) => {
      const info = C.dayInfo(model, dn);
      const cls = dayClasses(info);
      const btn = el('button', {
        type: 'button', class: cls.join(' '), 'aria-label': dayAriaLabel(info),
        onclick: () => openDaySheet(dn)
      }, el('span', { class: 'num', text: d }));
      if (info.band || info.likely) btn.style.setProperty('--p', info.prob.toFixed(2));
      if (info.ovulation) btn.append(el('i', { class: 'mk ' + (info.ovulation === 'pov' ? 'mk-pov' : 'mk-ov') }));
      if (showMood) moodDays.push({ btn: btn, mood: C.moodLevel(model, dn), before: C.moodLevel(model, dn - 1), after: C.moodLevel(model, dn + 1) });
      return btn;
    }));
    view.moodDays = moodDays;
    drawMoodLine();
    renderLegend();
  }

  /* ---------- typical mood line ---------- */

  // The line is a general pattern, so it is hidden on hormonal birth control, before any period is
  // logged, and when switched off in Settings
  function moodLineOn() {
    return !!model.last && !bcOn() && state.settings.show_mood_line !== false;
  }

  // Catmull-Rom path through pts[i0..i1]; neighbors outside that range only shape the tangents
  function smoothPath(pts, i0, i1) {
    let d = 'M' + pts[i0].x.toFixed(1) + ',' + pts[i0].y.toFixed(1);
    for (let i = i0; i < i1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      d += ' C' + (p1.x + (p2.x - p0.x) / 6).toFixed(1) + ',' + (p1.y + (p2.y - p0.y) / 6).toFixed(1) +
        ' ' + (p2.x - (p3.x - p1.x) / 6).toFixed(1) + ',' + (p2.y - (p3.y - p1.y) / 6).toFixed(1) +
        ' ' + p2.x.toFixed(1) + ',' + p2.y.toFixed(1);
    }
    return d;
  }

  // Draws one smooth line per calendar week over the month grid. Each day's point sits at its
  // cell's horizontal center, higher in the cell for a higher typical mood level. Segments for
  // predicted days are dashed.
  function drawMoodLine() {
    const wrap = $('#calGrid');
    const old = wrap.querySelector('.mood-trend');
    if (old) old.remove();
    // Redraw when the grid is resized or becomes visible after being hidden
    if (!view.moodObserver && window.ResizeObserver) {
      view.moodObserver = new ResizeObserver(() => drawMoodLine());
      view.moodObserver.observe(wrap);
    }

    const days = view.moodDays || [];
    if (!days.length || !wrap.offsetWidth) return;

    const svg = svgEl('svg', {
      class: 'mood-trend', viewBox: '0 0 ' + wrap.offsetWidth + ' ' + wrap.offsetHeight,
      preserveAspectRatio: 'none', 'aria-hidden': 'true'
    });
    // Group consecutive days into week rows by their vertical position in the grid. The line spans
    // each day's full width: its row starts at the first day's left border and ends at the last
    // day's right border, and its height runs from the day's bottom to the very top of its border.
    const rows = [];
    days.forEach(item => {
      if (!item.mood) return;
      const b = item.btn;
      const bottom = b.offsetTop + b.offsetHeight - 5;
      const top = b.offsetTop + 1;
      const yAt = v => bottom - v * (bottom - top);
      const left = b.offsetLeft;
      const right = b.offsetLeft + b.offsetWidth;
      const mid = left + b.offsetWidth / 2;
      // Border points sit halfway between this day's level and its neighbor's so rows meet smoothly
      const edge = (other) => (other ? (item.mood.v + other.v) / 2 : item.mood.v);
      let row = rows[rows.length - 1];
      if (row && row.top === b.offsetTop) {
        // Same week: drop the previous day's right-border point; this day's center replaces it
        row.pts.pop();
      } else {
        row = { top: b.offsetTop, pts: [{ x: left, y: yAt(edge(item.before)), predicted: item.mood.predicted }] };
        rows.push(row);
      }
      row.pts.push({ x: mid, y: yAt(item.mood.v), predicted: item.mood.predicted });
      row.pts.push({ x: right, y: yAt(edge(item.after)), predicted: item.mood.predicted });
    });
    rows.forEach(row => {
      const pts = row.pts;
      // Split into runs of actual and predicted days; each run extends to the next run's first point so the line stays joined
      let start = 0;
      for (let i = 1; i <= pts.length; i++) {
        if (i === pts.length || pts[i].predicted !== pts[start].predicted) {
          const end = Math.min(i, pts.length - 1);
          if (end > start) {
            svg.append(svgEl('path', {
              d: smoothPath(pts, start, end),
              class: 'mood-path' + (pts[start].predicted ? ' mood-pred' : '')
            }));
          }
          start = i;
        }
      }
    });
    wrap.append(svg);
  }

  // Small sample of the mood line for the legend
  function moodSwatch() {
    const svg = svgEl('svg', { class: 'mood-swatch', viewBox: '0 0 30 30', 'aria-hidden': 'true' });
    svg.append(svgEl('path', { d: 'M2,24 C10,24 12,6 16,6 C20,6 22,22 28,24', class: 'mood-path' }));
    return svg;
  }

  function renderLegend() {
    const box = clear($('#legend'));
    const sw = (classes, marker) => {
      const d = el('span', { class: 'day ' + classes }, el('span', { class: 'num', text: '1' }));
      if (marker) d.append(el('i', { class: 'mk ' + marker }));
      return d;
    };
    const item = (swatch, text) => el('div', { class: 'legend-item' }, swatch, el('span', { text: text }));
    box.append(
      item(sw('logged'), 'Logged period'),
      item(sw('pp-likely'), 'Period likely'),
      item(sw('pp-band'), 'Period possible (fades with uncertainty)'),
      item(sw('pp-end'), 'Rest of current period'),
      item(sw('ph-menstrual'), 'Menstrual phase'),
      item(sw('ph-follicular'), 'Follicular phase'),
      item(sw('ph-ovulatory'), 'Ovulatory phase'),
      item(sw('ph-luteal'), 'Luteal phase'),
      item(sw('pred ph-luteal'), 'Softer tint: predicted'),
      item(sw('', 'mk-ov'), 'Estimated ovulation'),
      item(sw('', 'mk-pov'), 'Predicted ovulation'),
      item(sw('fertile'), 'Fertile window (an estimate, not “safe” or “unsafe” days)'),
      item(sw('today'), 'Today'),
      item(moodSwatch(), 'Typical mood pattern (a general trend, not a prediction; everyone is different)'),
      el('p', { class: 'muted legend-note', text: 'Ovulation, the fertile window and phases are estimates from your past cycles.' })
    );
  }

  function shiftMonth(delta) {
    const d = new Date(Date.UTC(view.year, view.month + delta, 1));
    view.year = d.getUTCFullYear();
    view.month = d.getUTCMonth();
    renderCalendar();
  }

  // Points the calendar at the current month
  function setViewToday() {
    const t = today();
    view.year = Number(t.slice(0, 4));
    view.month = Number(t.slice(5, 7)) - 1;
  }

  function goToday() {
    setViewToday();
    renderCalendar();
  }

  /* ---------- history ---------- */

  function renderHistory() {
    const box = clear($('#historyList'));
    const entries = model.entries;
    if (!entries.length) {
      box.append(el('div', { class: 'card' },
        el('p', { text: 'No periods logged yet.' }),
        el('button', { type: 'button', class: 'btn', text: 'Add past periods', onclick: () => openBackfill() })));
      return;
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const cycle = model.cycles.find(c => c.id === e.id);
      const flag = model.flagByEntry[e.id];
      const startDn = C.toDn(e.start_date);
      const periodLen = e.end_date ? C.toDn(e.end_date) - startDn + 1 : null;

      const badges = el('div', { class: 'badges' });
      if (e.start_precision === 'approximate' || (e.end_date && e.end_precision === 'approximate')) {
        badges.append(el('span', { class: 'badge', text: 'Approximate' }));
      }
      if (e.source === 'quick_setup') badges.append(el('span', { class: 'badge', text: 'Estimated' }));
      if (flag) badges.append(el('span', { class: 'badge badge--flag', text: 'Unusual: ' + REASON_LABELS[flag.reason] }));
      else if (cycle && !cycle.eligible) badges.append(el('span', { class: 'badge badge--flag', text: 'Not used for predictions' }));

      const row = el('div', { class: 'card cycle-row' + (view.focusCycleId === e.id ? ' is-focus' : ''), dataset: { id: e.id } },
        el('div', { class: 'top' },
          el('span', { class: 'date', text: fmtStr(e.start_date) }),
          el('span', {
            class: 'len',
            text: cycle ? cycle.length + '-day cycle' : (e.end_date || model.today < startDn ? 'Current cycle' : 'Current cycle · day ' + (model.today - startDn + 1))
          })),
        el('div', { class: 'muted', text: periodLen ? 'Period: ' + pluralDays(periodLen) : 'Period: still going' }),
        badges,
        el('div', { class: 'row-actions' },
          el('button', { type: 'button', class: 'btn', text: 'Edit', onclick: () => openEditEntry(e) }),
          el('button', { type: 'button', class: 'btn', text: flag ? 'Edit unusual flag' : 'Mark as unusual', onclick: () => openFlagSheet(e) }),
          el('button', { type: 'button', class: 'btn btn--danger', text: 'Delete', onclick: () => deleteEntry(e) })));
      box.append(row);
    }
    if (view.focusCycleId) {
      const target = box.querySelector('[data-id="' + view.focusCycleId + '"]');
      if (target && view.tab === 'history') target.scrollIntoView({ block: 'center' });
    }
  }

  /* ---------- stats ---------- */

  function renderStats() {
    const box = clear($('#statsBody'));
    const st = C.stats(model);
    const m = model;
    const unit = v => pluralDays(v);

    box.append(el('div', { class: 'card' },
      el('span', { class: 'confidence-label', text: m.confidence.label }),
      el('span', { class: 'muted', text: m.confidence.text }),
      m.n < 6 ? el('p', { class: 'muted', text: 'Predictions get more reliable after 6 cycles.' }) : null));

    const grid = el('div', { class: 'stat-grid' });
    grid.append(
      statTile(unit(st.avgCycle), 'Average cycle length' + (m.n === 0 ? ' (default)' : '')),
      statTile(unit(st.avgPeriod), 'Average period length' + (m.nP === 0 ? ' (default)' : '')));
    if (m.n >= 3) {
      grid.append(statTile(st.regularity.rating, st.regularity.text, true));
    } else {
      grid.append(statTile('Not yet', 'Log 3 cycles to see your regularity', true));
    }
    box.append(grid);

    if (m.n < 3) {
      box.append(el('button', { type: 'button', class: 'btn btn--block', text: 'Add past periods', onclick: () => openBackfill() }));
    }

    const data = C.chartData(m);
    const card = el('div', { class: 'card' }, el('h2', { text: 'Cycle length' }));
    if (!data.bars.length) {
      card.append(el('p', { class: 'muted', text: 'Your cycle lengths appear here once you have logged two periods.' }));
    } else {
      card.append(buildChart(data));
      card.append(el('p', {
        class: 'muted',
        text: data.band.kind === 'normal'
          ? 'Shaded band: your usual range (' + data.band.lo + '–' + data.band.hi + ' days).'
          : 'Shaded band: the general reference range (21–35 days).'
      }));
      const excluded = data.bars.filter(b => b.excluded);
      if (excluded.length) {
        card.append(el('p', { class: 'muted', text: 'Dashed bars are kept in your history but not used for predictions:' }));
        card.append(el('ul', { class: 'muted' }, excluded.map(b =>
          el('li', { text: fmtShort(b.startDn) + ': ' + (b.length) + ' days – ' + REASON_LABELS[b.reason] }))));
      }
    }
    box.append(card);
  }

  function statTile(big, caption, wide) {
    return el('div', { class: 'stat' + (wide ? ' stat--wide' : '') },
      el('div', { class: 'big', text: big }), el('div', { class: 'cap', text: caption }));
  }

  // Bar chart of the most recent cycle lengths with the shaded range band
  function buildChart(data) {
    const W = 360;
    const H = 200;
    const pl = 30;
    const pr = 8;
    const pt = 14;
    const pb = 26;
    const lens = data.bars.map(b => b.length);
    const maxV = Math.max(data.band.hi, Math.max.apply(null, lens)) + 4;
    const y = v => pt + (H - pt - pb) * (1 - v / maxV);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Cycle length by cycle, in days' });

    svg.append(svgEl('rect', {
      class: data.band.kind === 'normal' ? 'band-normal' : 'band-reference',
      x: pl, width: W - pl - pr, y: y(data.band.hi), height: Math.max(0, y(data.band.lo) - y(data.band.hi))
    }));
    const step = maxV > 60 ? 20 : 10;
    for (let v = 0; v <= maxV; v += step) {
      svg.append(svgEl('line', { class: 'axis', x1: pl, x2: W - pr, y1: y(v), y2: y(v) }));
      const t = svgEl('text', { x: pl - 4, y: y(v) + 3, 'text-anchor': 'end' });
      t.textContent = v;
      svg.append(t);
    }

    const slot = Math.min(40, (W - pl - pr) / data.bars.length);
    data.bars.forEach((b, i) => {
      const x = pl + 4 + i * slot;
      const bw = slot * 0.66;
      const top = y(b.length);
      const bar = svgEl('rect', {
        class: b.excluded ? 'bar-excluded' : 'bar', x: x, y: top, width: bw, height: Math.max(1, y(0) - top), rx: 3
      });
      const tip = svgEl('title');
      tip.textContent = fmtShort(b.startDn) + ': ' + b.length + ' days' + (b.excluded ? ' (' + REASON_LABELS[b.reason] + ')' : '');
      bar.append(tip);
      svg.append(bar);
      const val = svgEl('text', { x: x + bw / 2, y: top - 3, 'text-anchor': 'middle' });
      val.textContent = b.length;
      svg.append(val);
      const lab = svgEl('text', { x: x + bw / 2, y: H - 10, 'text-anchor': 'middle' });
      lab.textContent = fmtDn(b.startDn, { month: 'numeric', day: 'numeric' });
      svg.append(lab);
      // Full-height hit area so narrow bars are easy to tap
      const hit = svgEl('rect', { class: 'bar-hit', x: x - 2, y: pt, width: bw + 4, height: H - pt - pb });
      hit.addEventListener('click', () => { view.focusCycleId = b.id; switchTab('history'); renderHistory(); });
      svg.append(hit);
    });
    return svg;
  }

  /* ============================================================ logging */

  // Starts a period on dStr, applying the sanity prompts. opts: { backfill }
  async function logStart(dStr, opts) {
    opts = opts || {};
    const t = today();
    if (dStr > t) { await SuiteDialog.alert('Future dates can’t be logged.', { title: 'Choose an earlier date' }); return false; }
    const live = liveEntries();
    if (C.entryAt(model, C.toDn(dStr))) {
      await SuiteDialog.alert('A period is already logged on that day. Use Edit to change it.', { title: 'Already logged' });
      return false;
    }

    // A start soon after the previous period's end may be the same period continuing
    const prev = live.filter(e => e.start_date < dStr).pop();
    if (prev && prev.end_date) {
      const gap = C.toDn(dStr) - C.toDn(prev.end_date);
      if (gap >= 1 && gap <= 7) {
        const answer = await choose('The previous period ended ' + pluralDays(gap) + ' before this date.', [
          { value: 'extend', label: 'Yes, extend it', kind: 'primary' },
          { value: 'new', label: 'No, it’s a new period' }
        ], { title: 'Is this part of your last period?' });
        if (answer === null) return false;
        if (answer === 'extend') return extendPeriod(prev, dStr);
      }
    }

    // A very short or long resulting cycle may mean a missed entry
    const check = C.cycleCheck(live, dStr);
    let afterAction = null;
    if (check) {
      const options = [];
      if (!opts.backfill) options.push({ value: 'missed', label: 'Add a missed period' });
      options.push({ value: 'ok', label: 'It’s correct' }, { value: 'flag', label: 'Mark as unusual' });
      const answer = await choose(
        'That makes a ' + check.days + '-day cycle.' + (opts.backfill ? '' : ' Did you miss an entry?'), options,
        { title: 'That’s a ' + check.kind + ' cycle' });
      if (answer === null) return false;
      if (answer === 'missed') afterAction = () => openBackfill();
      if (answer === 'flag') afterAction = { flagTarget: check.target, prev: check.prev };
    }

    // Build the entry
    const fields = {
      start_date: dStr,
      start_precision: opts.backfill ? 'approximate' : 'exact',
      source: opts.backfill ? 'backfill' : 'live'
    };
    if (opts.backfill) {
      const later = live.filter(e => e.start_date > dStr)[0];
      let end = C.toDn(dStr) + C.round(model.P) - 1;
      if (later) end = Math.min(end, C.toDn(later.start_date) - 1);
      fields.end_date = C.toStr(Math.max(C.toDn(dStr), Math.min(end, C.toDn(t))));
      fields.end_precision = 'approximate';
    } else {
      Object.assign(fields, C.suggestEnd(dStr, t, model.P, live));
    }
    const entry = newEntry(fields);
    const err = C.validateEntry(entry, state.entries, t, null);
    if (err) { await SuiteDialog.alert(err, { title: 'Can’t log that period' }); return false; }

    // An unfinished earlier period is closed when a later one starts
    const open = live.filter(e => !e.end_date && e.start_date < dStr)[0];
    if (open) {
      open.end_date = C.toStr(Math.min(C.toDn(open.start_date) + C.round(model.P) - 1, C.toDn(dStr) - 1));
      open.end_precision = 'approximate';
      await saveEntry(open);
    }
    await saveEntry(entry);
    recompute();

    if (typeof afterAction === 'function') afterAction();
    else if (afterAction) {
      const target = afterAction.flagTarget === 'new' ? entry : afterAction.prev;
      if (target) openFlagSheet(target);
    }
    return true;
  }

  // Extends the previous period to cover dStr (ongoing when dStr is recent)
  async function extendPeriod(prev, dStr) {
    const t = today();
    const isLatest = !liveEntries().some(e => e.start_date > prev.start_date);
    const recent = C.toDn(dStr) >= C.toDn(t) - C.round(model.P) + 1;
    const updated = Object.assign({}, prev, {
      end_date: isLatest && recent ? null : dStr,
      end_precision: isLatest && recent ? 'approximate' : 'exact'
    });
    const err = C.validateEntry(updated, state.entries, t, prev.id);
    if (err) { await SuiteDialog.alert(err, { title: 'Can’t extend that period' }); return false; }
    await saveEntry(updated);
    recompute();
    return true;
  }

  // Ends the ongoing period on dStr
  async function logEnd(dStr) {
    const entry = model.ongoing;
    if (!entry) return false;
    return setEnd(entry, dStr);
  }

  // Sets an end date on an entry after validating it
  async function setEnd(entry, dStr) {
    const updated = Object.assign({}, entry, { end_date: dStr, end_precision: 'exact' });
    const err = C.validateEntry(updated, state.entries, today(), entry.id);
    if (err) { await SuiteDialog.alert(err, { title: 'Can’t end the period there' }); return false; }
    await saveEntry(updated);
    lsDel(LS_PROMPT_SNOOZE);
    recompute();
    return true;
  }

  // Soft-deletes an entry with an Undo toast
  async function deleteEntry(entry) {
    entry.deleted = true;
    await saveEntry(entry);
    recompute();
    showToast('Period deleted', 'Undo', async () => {
      entry.deleted = false;
      await saveEntry(entry);
      recompute();
    });
  }

  /* ============================================================= day sheet */

  function openDaySheet(dn) {
    const info = C.dayInfo(model, dn);
    const t = model.today;
    const lines = el('div', { class: 'sheet-section' });
    if (info.cycleDay) {
      const ph = phaseLabel(info.phase);
      lines.append(el('p', { text: 'Cycle day ' + info.cycleDay + (ph ? ' · ' + ph + (info.phaseKind === 'predicted' ? ' (predicted)' : '') : '') }));
    }
    lines.append(moodBlock(info.phase));
    if (info.logged) lines.append(el('p', { text: 'Period logged' }));
    else if (info.predictedEnd) lines.append(el('p', { text: 'Period expected to still be going' }));
    else if (info.likely) lines.append(el('p', { text: 'Period predicted (most likely)' }));
    else if (info.band) lines.append(el('p', { text: 'Period possible (' + Math.round(info.prob * 100) + '% chance)' }));
    if (info.ovulation) lines.append(el('p', { text: (info.ovulation === 'pov' ? 'Predicted' : 'Estimated') + ' ovulation' }));
    if (info.fertile) lines.append(el('p', { text: 'In the estimated fertile window' }));
    if (!lines.children.length) lines.append(el('p', { class: 'muted', text: 'Nothing logged or predicted for this day.' }));

    const stack = el('div', { class: 'btn-stack' });
    let ctl;
    const act = (label, fn, kind) => stack.append(el('button', {
      type: 'button', class: 'btn' + (kind ? ' btn--' + kind : ''), text: label,
      onclick: () => { ctl.close(); fn(); }
    }));

    const dStr = C.toStr(dn);
    const entry = info.entry;
    if (dn <= t) {
      if (!entry) act('Mark period start here', () => logStart(dStr, {}), 'primary');
      if (entry && entry.end_date !== dStr) act('Mark period end here', () => setEnd(entry, dStr));
    }
    if (entry) {
      act('Edit this period', () => openEditEntry(entry));
      act('Delete this period', () => deleteEntry(entry), 'danger');
    }
    ctl = openSheet({
      title: fmtLong(dn),
      body: [lines, stack],
      buttons: [{ label: 'Close' }]
    });
  }

  /* ========================================================== edit / flags */

  // Edit dates and precision of one period
  function openEditEntry(entry, onSaved) {
    const isLatest = !liveEntries().some(e => e.start_date > entry.start_date);
    const startIn = el('input', { type: 'date', value: entry.start_date, max: today() });
    const endIn = el('input', { type: 'date', value: entry.end_date || '', max: today() });
    const ongoing = el('input', { type: 'checkbox' });
    ongoing.checked = !entry.end_date;
    endIn.disabled = ongoing.checked;
    ongoing.addEventListener('change', () => { endIn.disabled = ongoing.checked; });
    const startPrec = segmented([{ value: 'exact', label: 'Exact' }, { value: 'approximate', label: 'Approximate' }], entry.start_precision);
    const endPrec = segmented([{ value: 'exact', label: 'Exact' }, { value: 'approximate', label: 'Approximate' }], entry.end_precision);
    const errBox = el('div', { class: 'error-text', role: 'alert' });

    openSheet({
      title: 'Edit period',
      body: [
        field('Start date', startIn),
        el('div', { class: 'muted', text: 'How sure are you of the start date?' }), startPrec.node,
        isLatest ? el('label', { class: 'check' }, ongoing, el('span', { text: 'Still going' })) : null,
        field('End date', endIn),
        el('div', { class: 'muted', text: 'How sure are you of the end date?' }), endPrec.node,
        errBox
      ],
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Save', kind: 'primary',
          onClick: async () => {
            const stillGoing = isLatest && ongoing.checked;
            const updated = Object.assign({}, entry, {
              start_date: startIn.value,
              end_date: stillGoing ? null : (endIn.value || null),
              start_precision: startPrec.get(),
              end_precision: endPrec.get()
            });
            if (!stillGoing && !updated.end_date) { errBox.textContent = 'Choose an end date, or mark the period as still going.'; return false; }
            const err = C.validateEntry(updated, state.entries, today(), entry.id);
            if (err) { errBox.textContent = err; return false; }
            await saveEntry(updated);
            recompute();
            if (onSaved) onSaved();
          }
        }
      ]
    });
  }

  // Mark (or unmark) the cycle that begins with `entry` as unusual
  function openFlagSheet(entry, presetReason) {
    const existing = state.flags.find(f => !f.deleted && f.period_entry_id === entry.id);
    const reasonSel = el('select', null, C.FLAG_REASONS.map(r => el('option', { value: r, text: REASON_LABELS[r] })));
    reasonSel.value = existing ? existing.reason : (presetReason || 'other');
    const note = el('textarea', { placeholder: 'Optional note' });
    note.value = existing && existing.note ? existing.note : '';
    const buttons = [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary',
        onClick: async () => {
          const rec = existing || newRecord({ period_entry_id: entry.id, exclude_from_stats: true });
          rec.reason = reasonSel.value;
          rec.note = note.value.trim() || null;
          await saveFlag(rec);
          recompute();
        }
      }
    ];
    if (existing) {
      buttons.splice(1, 0, {
        label: 'Remove flag', kind: 'danger',
        onClick: async () => { existing.deleted = true; await saveFlag(existing); recompute(); }
      });
    }
    openSheet({
      title: 'Unusual cycle',
      body: [
        el('p', { class: 'muted', text: 'The cycle that starts ' + fmtStr(entry.start_date) + '. Unusual cycles stay in your history but don’t affect predictions or stats.' }),
        field('Reason', reasonSel),
        field('Note', note)
      ],
      buttons: buttons
    });
  }

  /* ============================================================== backfill */

  // Scrolling month calendars going back from the earliest known period; tap a day to add a period
  function openBackfill() {
    let months = 6;
    const progress = el('p', { class: 'muted' });
    const list = el('div');
    const more = el('button', {
      type: 'button', class: 'btn btn--block', text: 'Load earlier months',
      onclick: () => { months += 6; draw(); }
    });
    const body = el('div', null,
      el('p', { text: 'Tap the first day of each past period. Dates you add here are marked approximate; tap a period to adjust it.' }),
      progress,
      el('button', {
        type: 'button', class: 'btn btn--block', text: 'Fill in from my usual cycle',
        onclick: () => quickFill(draw)
      }),
      list, more);

    function draw() {
      const scroller = ctl.dialog.querySelector('.sheet-body');
      const top = scroller.scrollTop;
      clear(list);
      const count = liveEntries().length;
      progress.textContent = Math.min(count, 12) + ' of 12 added' + (count >= 12 ? ' – you can keep adding more' : '');
      const earliest = model.entries[0];
      const anchor = earliest ? earliest.start_date : today();
      const ay = Number(anchor.slice(0, 4));
      const am = Number(anchor.slice(5, 7)) - 1;
      for (let i = 0; i < months; i++) {
        const d = new Date(Date.UTC(ay, am - i, 1));
        const y = d.getUTCFullYear();
        const mo = d.getUTCMonth();
        list.append(el('div', { class: 'bf-month' },
          el('h3', { text: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) }),
          monthGrid(y, mo, (dn, n) => {
            const logged = C.entryAt(model, dn);
            const future = dn > model.today;
            return el('button', {
              type: 'button', class: 'day' + (logged ? ' logged' : '') + (dn === model.today ? ' today' : ''),
              disabled: future, 'aria-label': fmtLong(dn) + (logged ? ', period logged' : ''),
              onclick: async () => {
                if (logged) openEditEntry(logged, draw);
                else { await logStart(C.toStr(dn), { backfill: true }); draw(); }
              }
            }, el('span', { class: 'num', text: n }));
          })));
      }
      scroller.scrollTop = top;
    }

    const ctl = openSheet({ title: 'Add past periods', body: body, buttons: [{ label: 'Done', kind: 'primary' }] });
    draw();
    return ctl;
  }

  // Proposes up to 12 periods before the earliest known one, spaced by the usual cycle length
  function quickFill(onDone) {
    const earliest = model.entries[0];
    if (!earliest) {
      SuiteDialog.alert('Log at least one period first, then fill in earlier ones from your usual cycle.', { title: 'No starting period' });
      return;
    }
    const cycleLen = state.settings.usual_cycle_length || 28;
    const periodLen = state.settings.usual_period_length || 5;
    const base = C.toDn(earliest.start_date);
    const proposals = [];
    for (let i = 1; i <= 12; i++) {
      const s = base - i * cycleLen;
      const cand = { start_date: C.toStr(s), end_date: C.toStr(s + periodLen - 1) };
      if (!C.validateEntry(cand, state.entries, today(), null)) proposals.push(cand);
    }
    if (!proposals.length) {
      SuiteDialog.alert('There is no room to add more periods before your earliest one.', { title: 'Nothing to add' });
      return;
    }
    openSheet({
      title: 'Review estimated periods',
      body: [
        el('p', { text: 'These ' + proposals.length + ' periods are based on a ' + cycleLen + '-day cycle and a ' + periodLen + '-day period. They count less than dates you enter yourself.' }),
        el('ol', { class: 'review-list' }, proposals.map(p => el('li', { text: fmtStr(p.start_date) + ' – ' + fmtStr(p.end_date) })))
      ],
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Add ' + proposals.length + ' periods', kind: 'primary',
          onClick: async () => {
            for (const p of proposals) {
              await saveEntry(newEntry({
                start_date: p.start_date, end_date: p.end_date,
                start_precision: 'approximate', end_precision: 'approximate', source: 'quick_setup'
              }));
            }
            recompute();
            if (onDone) onDone();
          }
        }
      ]
    });
  }

  /* ============================================================== settings */

  function openSettings() {
    const s = state.settings;
    const intField = (label, key, min, max, hint) => {
      const input = el('input', { type: 'number', inputmode: 'numeric', min: min, max: max, placeholder: hint });
      input.value = s[key] || '';
      input.addEventListener('change', async () => {
        const raw = input.value.trim();
        if (raw === '') { await saveSettings({ [key]: null }); return; }
        const v = Number(raw);
        if (!Number.isInteger(v) || v < min || v > max) {
          await SuiteDialog.alert('Enter a whole number from ' + min + ' to ' + max + ', or leave it blank to use the default.', { title: 'Check that number' });
          input.value = s[key] || '';
          return;
        }
        await saveSettings({ [key]: v });
      });
      return field(label, input);
    };

    const toggle = (label, key) => {
      const input = el('input', { type: 'checkbox' });
      input.checked = s[key] !== false;
      input.addEventListener('change', () => saveSettings({ [key]: input.checked }));
      return { input: input, node: el('label', { class: 'check' }, input, el('span', { text: label })) };
    };
    const ovT = toggle('Show ovulation', 'show_ovulation');
    const fwT = toggle('Show fertile window', 'show_fertile_window');
    const phT = toggle('Show phase tints', 'show_phase_tints');
    const mlT = toggle('Show typical mood line', 'show_mood_line');

    const bcSel = el('select', null,
      el('option', { value: 'yes', text: 'Yes' }), el('option', { value: 'no', text: 'No' }), el('option', { value: 'unsure', text: 'Not sure' }));
    bcSel.value = s.hormonal_birth_control;
    bcSel.addEventListener('change', async () => {
      const wasYes = s.hormonal_birth_control === 'yes';
      const v = bcSel.value;
      const show = v !== 'yes';
      await saveSettings({ hormonal_birth_control: v, show_ovulation: show, show_fertile_window: show });
      ovT.input.checked = show;
      fwT.input.checked = show;
      // Only starting or stopping hormonal birth control suggests flagging the cycle
      if (wasYes === (v === 'yes')) return;
      if (model.last && await SuiteDialog.confirm(
        'Starting or stopping hormonal birth control can change a cycle. Mark your current cycle as unusual so it doesn’t affect predictions?',
        { title: 'Mark this cycle?', confirmLabel: 'Mark as unusual', cancelLabel: 'Not now' })) {
        openFlagSheet(model.last, 'birth_control_change');
      }
    });

    const weekSel = el('select', null, [0, 1, 2, 3, 4, 5, 6].map(i =>
      el('option', {
        value: i,
        text: new Date(Date.UTC(2023, 0, 1 + i)).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' })
      })));
    weekSel.value = String(s.week_starts_on || 0);
    weekSel.addEventListener('change', () => saveSettings({ week_starts_on: Number(weekSel.value) }));

    const fileIn = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) importFile(fileIn.files[0]); fileIn.value = ''; });

    const about = el('details', null,
      el('summary', { class: 'link-btn', text: 'About and how predictions work' }),
      el('p', { class: 'disclaimer', text: DISCLAIMER }),
      el('p', { text: 'Your data stays on this device. Nothing is sent anywhere.' }),
      el('p', { text: 'The app looks at the length of your recent cycles (up to 12) and takes a typical value that isn’t thrown off by one odd cycle. Dates you marked approximate count half as much, and cycles you mark as unusual are ignored.' }),
      el('p', { text: 'With few cycles logged it leans on a typical 28-day cycle (or the length you entered) and says so. The more cycles you log, the more it trusts your own history.' }),
      el('p', { text: 'The shaded days around the next period show uncertainty: the further ahead, the wider and fainter the band. If your period is late, predictions move forward instead of staying stuck in the past.' }),
      el('p', { text: 'Ovulation is estimated about 14 days before the next period. The fertile window is the 5 days before through 1 day after that estimate. These are estimates, not guarantees.' }),
      el('p', { text: 'The mood and libido notes describe general patterns across people for each phase (hormone levels rise and fall through the cycle). They are not a prediction of how you will feel on a given day, and they are hidden when hormonal birth control is on. The typical mood line on the calendar draws the same general pattern: it rises through the follicular phase, peaks around estimated ovulation and eases down before the next period.' }),
      el('p', { text: 'Notes suggesting you talk to a doctor are gentle prompts based on common ranges, not a diagnosis.' }));

    backupBox = el('div');
    openSheet({
      title: 'Settings',
      body: [
        el('div', { class: 'sheet-section' },
          el('h3', { text: 'Your cycle' }),
          intField('Usual cycle length (days)', 'usual_cycle_length', 15, 90, 'Default 28'),
          intField('Usual period length (days)', 'usual_period_length', 1, 15, 'Default 5'),
          field('Hormonal birth control', bcSel),
          ovT.node, fwT.node, phT.node, mlT.node,
          field('Week starts on', weekSel)),
        el('div', { class: 'sheet-section' },
          el('h3', { text: 'Your data' }),
          el('div', { class: 'btn-stack' },
            el('button', { type: 'button', class: 'btn', text: 'Add past periods', onclick: () => openBackfill() }),
            el('button', { type: 'button', class: 'btn', text: 'Export data', onclick: exportData }),
            el('button', { type: 'button', class: 'btn', text: 'Import data', onclick: () => fileIn.click() }),
            el('button', { type: 'button', class: 'btn btn--danger', text: 'Delete all data', onclick: deleteAllData }),
            fileIn)),
        el('div', { class: 'sheet-section' }, el('h3', { text: 'Server backup' }), backupBox),
        el('div', { class: 'sheet-section' }, about)
      ],
      buttons: [{ label: 'Done', kind: 'primary' }]
    });
    renderBackup();
  }

  /* ---------- optional server backup ---------- */

  const sessionUser = () => (window.SuiteProfile ? SuiteProfile.getUser() : null);

  // Draws the Settings "Server backup" section for the current sign-in and sync state
  function renderBackup() {
    if (!backupBox || !backupBox.isConnected) return;
    clear(backupBox);
    const st = sync.getState();
    const user = sessionUser();
    const signedIn = !!(user && user.token);
    backupBox.append(el('p', {
      class: 'muted',
      text: 'Optional. Keep a copy of your data on the server to use the tracker on your other devices. It is stored with your profile and can be read by the site admin. It is off unless you turn it on.'
    }));

    if (!st.enabled) {
      if (st.error) backupBox.append(el('p', { class: 'error-text', text: st.error }));
      if (!signedIn) {
        backupBox.append(el('p', { text: 'Sign in from the app launcher (top right) to turn this on. A profile password keeps the profile yours.' }));
        return;
      }
      if (window.SuiteProfile && !SuiteProfile.canSeeApp('cycle')) {
        backupBox.append(el('p', { text: 'Your profile does not have access to server backup.' }));
        return;
      }
      backupBox.append(
        el('p', { class: 'muted', text: 'Signed in as ' + user.username + '. On a new device, turn this on before entering anything to restore your data.' }),
        el('button', { type: 'button', class: 'btn btn--block', text: 'Turn on server backup', onclick: enableBackup }));
      return;
    }

    let line;
    if (st.status === 'syncing') line = 'Syncing\u2026';
    else if (st.status === 'error') line = 'Couldn\u2019t sync: ' + st.error + ' It will try again.';
    else if (st.status === 'signed-out') line = 'You\u2019re signed out. Sign in again as ' + st.username + ' to keep syncing.';
    else if (st.status === 'no-access') line = st.error;
    else line = 'Backup is on' + (st.lastSyncedAt ? '. Last synced ' + new Date(st.lastSyncedAt).toLocaleString() : '') + '.';
    if (st.pending) line += ' ' + st.pending + (st.pending === 1 ? ' change is' : ' changes are') + ' waiting to be sent.';
    backupBox.append(
      el('p', { class: st.status === 'error' ? 'error-text' : '', text: line }),
      el('div', { class: 'btn-stack' },
        el('button', { type: 'button', class: 'btn', text: 'Sync now', onclick: () => sync.syncNow() }),
        el('button', { type: 'button', class: 'btn', text: 'Turn off backup', onclick: turnOffBackup }),
        el('button', { type: 'button', class: 'btn btn--danger', text: 'Delete server copy', onclick: deleteServerCopy })));
  }

  // Explains what will be stored, then switches backup on and runs the first sync
  async function enableBackup() {
    const ok = await SuiteDialog.confirm(
      'Your periods, flags and settings will be copied to the server, stored with your profile, and kept in sync with your other devices. The site admin can read this data.\nYou can turn this off and delete the server copy at any time.',
      { title: 'Turn on server backup?', confirmLabel: 'Turn on backup', cancelLabel: 'Not now' });
    if (!ok) return;
    const result = await sync.enable();
    if (!result.ok) {
      await SuiteDialog.alert(result.error, { title: 'Couldn\u2019t turn on backup' });
    } else {
      showToast('Server backup is on');
    }
    renderBackup();
  }

  // Stops syncing on this device; asks whether the server copy should go too
  async function turnOffBackup() {
    const choice = await choose('Your data stays on this device either way.', [
      { value: 'keep', label: 'Keep server copy' },
      { value: 'delete', label: 'Delete server copy', kind: 'danger' }
    ], { title: 'Turn off server backup?' });
    if (!choice) return;
    const result = await sync.disable({ deleteServerCopy: choice === 'delete' });
    if (!result.ok) await SuiteDialog.alert(result.error, { title: 'Couldn\u2019t delete the server copy' });
    else showToast(choice === 'delete' ? 'Server copy deleted. Backup is off.' : 'Backup is off.');
    renderBackup();
  }

  // Deletes the server copy and turns backup off; data on this device is untouched
  async function deleteServerCopy() {
    const ok = await SuiteDialog.confirm('The copy on the server is deleted and backup is turned off. Data on this device and on your other devices stays.', {
      title: 'Delete server copy?', confirmLabel: 'Delete server copy', danger: true, defaultCancel: true
    });
    if (!ok) return;
    const result = await sync.disable({ deleteServerCopy: true });
    if (!result.ok) await SuiteDialog.alert(result.error, { title: 'Couldn\u2019t delete the server copy' });
    else showToast('Server copy deleted. Backup is off.');
    renderBackup();
  }

  /* ========================================================= export/import */

  function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // Saves every record, including soft-deleted ones, to a JSON backup file
  async function exportData() {
    const now = S.nowIso();
    await saveSettings({ last_export_at: now });
    const payload = {
      app: 'cycle-tracker',
      schema_version: 1,
      exported_at: now,
      records: {
        period_entries: state.entries,
        cycle_flags: state.flags,
        settings: [state.settings],
        health_note_dismissals: state.dismissals,
        daily_logs: await S.getAll('daily_logs')
      }
    };
    downloadJson('cycle-backup-' + today() + '.json', payload);
    showToast('Backup saved');
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SOURCES = ['live', 'backfill', 'quick_setup', 'import'];
  const PRECISIONS = ['exact', 'approximate'];
  const NOTE_TYPES = ['cycle_length_out_of_range', 'high_variation', 'no_period_60', 'no_period_90', 'long_period'];

  // Checks an imported backup; returns a list of problems (empty when the file is valid)
  function validateImport(obj) {
    const errors = [];
    const bad = msg => { if (errors.length < 10) errors.push(msg); };
    if (!obj || typeof obj !== 'object') { bad('The file is not a backup.'); return errors; }
    if (obj.app !== 'cycle-tracker' && obj.app !== 'period-tracker') bad('This file is not a Cycle Tracker backup.');
    if (!Number.isInteger(obj.schema_version) || obj.schema_version < 1) bad('The backup has no valid version.');
    else if (obj.schema_version > 1) bad('This backup was made by a newer version of the app. Update the app and try again.');
    if (!obj.records || typeof obj.records !== 'object') { bad('The backup has no records.'); return errors; }
    const r = obj.records;
    const common = (rec, label) => {
      if (!rec || typeof rec !== 'object') { bad(label + ': not a record.'); return false; }
      if (rec.id !== 'settings' && !UUID_RE.test(rec.id || '')) bad(label + ': invalid id.');
      if (!(Date.parse(rec.created_at) > 0) || !(Date.parse(rec.updated_at) > 0)) bad(label + ': invalid timestamps.');
      if (typeof rec.deleted !== 'boolean') bad(label + ': missing deleted flag.');
      return true;
    };
    (r.period_entries || []).forEach((e, i) => {
      const label = 'Period ' + (i + 1);
      if (!common(e, label)) return;
      if (!C.isValidDate(e.start_date)) bad(label + ': invalid start date.');
      if (e.end_date !== null && !C.isValidDate(e.end_date)) bad(label + ': invalid end date.');
      if (e.end_date && C.isValidDate(e.start_date) && e.end_date < e.start_date) bad(label + ': ends before it starts.');
      if (PRECISIONS.indexOf(e.start_precision) < 0 || PRECISIONS.indexOf(e.end_precision) < 0) bad(label + ': invalid precision.');
      if (SOURCES.indexOf(e.source) < 0) bad(label + ': invalid source.');
    });
    (r.cycle_flags || []).forEach((f, i) => {
      const label = 'Flag ' + (i + 1);
      if (!common(f, label)) return;
      if (!UUID_RE.test(f.period_entry_id || '')) bad(label + ': invalid period reference.');
      if (C.FLAG_REASONS.indexOf(f.reason) < 0) bad(label + ': invalid reason.');
      if (typeof f.exclude_from_stats !== 'boolean') bad(label + ': invalid exclude setting.');
    });
    (r.settings || []).forEach(st => {
      if (!common(st, 'Settings')) return;
      if (st.id !== 'settings') bad('Settings: invalid id.');
      if (['yes', 'no', 'unsure'].indexOf(st.hormonal_birth_control) < 0) bad('Settings: invalid birth control value.');
    });
    (r.health_note_dismissals || []).forEach((d, i) => {
      const label = 'Dismissed note ' + (i + 1);
      if (!common(d, label)) return;
      if (NOTE_TYPES.indexOf(d.note_type) < 0 || typeof d.evidence_key !== 'string') bad(label + ': invalid note.');
    });
    (r.daily_logs || []).forEach((d, i) => { common(d, 'Daily log ' + (i + 1)); });
    return errors;
  }

  const IMPORT_STORES = ['period_entries', 'cycle_flags', 'settings', 'health_note_dismissals', 'daily_logs'];

  // Reads, validates and imports a backup file (merge or replace)
  async function importFile(file) {
    let obj;
    try {
      obj = JSON.parse(await file.text());
    } catch (e) {
      await SuiteDialog.alert('That file couldn’t be read as a backup.', { title: 'Import failed' });
      return;
    }
    // Older schema versions would be migrated here before merging; only version 1 exists so far
    const errors = validateImport(obj);
    if (errors.length) {
      await SuiteDialog.alert('Nothing was imported.\n' + errors.join('\n'), { title: 'This backup has problems' });
      return;
    }

    // Work out what a merge would do
    const local = {
      period_entries: state.entries, cycle_flags: state.flags, settings: [state.settings],
      health_note_dismissals: state.dismissals, daily_logs: await S.getAll('daily_logs')
    };
    const plan = {};
    IMPORT_STORES.forEach(name => {
      const byId = {};
      local[name].forEach(r => { byId[r.id] = r; });
      plan[name] = { add: [], update: [] };
      (obj.records[name] || []).forEach(rec => {
        const ex = byId[rec.id];
        if (!ex) plan[name].add.push(rec);
        else if (rec.updated_at > ex.updated_at) plan[name].update.push(rec);
      });
    });
    const p = plan.period_entries;
    const otherCount = IMPORT_STORES.filter(n => n !== 'period_entries')
      .reduce((sum, n) => sum + plan[n].add.length + plan[n].update.length, 0);
    const summary = 'Merging adds ' + p.add.length + (p.add.length === 1 ? ' period' : ' periods') +
      ' and updates ' + p.update.length + (otherCount ? ', plus ' + otherCount + ' other records.' : '.');

    const mode = await choose(summary + '\nReplacing deletes everything on this device first.', [
      { value: 'merge', label: 'Merge', kind: 'primary' },
      { value: 'replace', label: 'Replace all', kind: 'danger' }
    ], { title: 'Import backup' });
    if (!mode) return;

    if (mode === 'replace') {
      await S.clearAll();
      for (const name of IMPORT_STORES) await S.putMany(name, obj.records[name] || []);
      // With backup on, the server copy is replaced too so the next sync doesn't bring the old records back
      if (sync.getState().enabled) {
        const result = await sync.replaceServerWithLocal();
        if (!result.ok) await SuiteDialog.alert('The import worked on this device, but the server copy could not be updated: ' + result.error, { title: 'Server backup' });
      }
    } else {
      for (const name of IMPORT_STORES) await S.putMany(name, plan[name].add.concat(plan[name].update));
    }
    await loadAll();
    recompute();
    await resolveOverlaps();
    showToast('Import complete');
  }

  // After an import, asks which of two overlapping periods to keep and closes stray ongoing ones
  async function resolveOverlaps() {
    for (let guard = 0; guard < 50; guard++) {
      const live = liveEntries();
      let conflict = null;
      for (let i = 0; i < live.length - 1; i++) {
        const a = live[i];
        const b = live[i + 1];
        const aEnd = a.end_date ? C.toDn(a.end_date) : Math.max(C.toDn(today()), C.toDn(a.start_date));
        if (C.toDn(b.start_date) <= aEnd) { conflict = [a, b]; break; }
        if (!a.end_date) {
          // Not overlapping, but only the latest period may be ongoing
          a.end_date = C.toStr(Math.min(C.toDn(a.start_date) + C.round(model.P) - 1, C.toDn(b.start_date) - 1));
          a.end_precision = 'approximate';
          await saveEntry(a);
        }
      }
      if (!conflict) break;
      const describe = e => fmtStr(e.start_date) + (e.end_date ? ' – ' + fmtStr(e.end_date) : ' (ongoing)');
      const keep = await choose('These two periods overlap. Which one should be kept?', [
        { value: 0, label: describe(conflict[0]) }, { value: 1, label: describe(conflict[1]) }
      ], { title: 'Overlapping periods', noCancel: true });
      if (keep === null) continue; // dialog dismissed without an answer: ask again
      const drop = conflict[keep === 0 ? 1 : 0];
      drop.deleted = true;
      await saveEntry(drop);
    }
    recompute();
  }

  // Hard-deletes everything after two confirmations and returns to first run
  async function deleteAllData() {
    const first = await SuiteDialog.confirm('Every period, flag and setting on this device will be deleted.', {
      title: 'Delete all data?', confirmLabel: 'Continue', danger: true, defaultCancel: true
    });
    if (!first) return;
    const second = await SuiteDialog.confirm('This can’t be undone. Export a backup first if you might want this data again.', {
      title: 'Really delete everything?', confirmLabel: 'Delete all data', danger: true, defaultCancel: true
    });
    if (!second) return;
    // Backup on: this device stops syncing, and the server copy is kept or deleted as the user chooses
    if (sync.getState().enabled) {
      const keep = await choose('Server backup is on. Delete your copy on the server too?\nIf you keep it, turning backup on again restores it.', [
        { value: 'delete', label: 'Delete server copy', kind: 'danger' },
        { value: 'keep', label: 'Keep server copy' }
      ], { title: 'Server backup' });
      if (keep === null) return;
      const result = await sync.disable({ deleteServerCopy: keep === 'delete' });
      if (!result.ok) {
        await SuiteDialog.alert(result.error, { title: 'Couldn\u2019t delete the server copy' });
        return;
      }
    }
    await S.clearAll();
    lsDel(LS_PROMPT_SNOOZE);
    lsDel(LS_UNSURE_SEEN);
    document.querySelectorAll('dialog.sheet').forEach(d => { if (d.open) d.close(); });
    await loadAll();
    view.focusCycleId = null;
    switchTab('calendar');
    recompute();
  }

  /* ============================================================ onboarding */

  function startOnboarding() {
    ob = {
      step: 1, bc: 'no', lastStart: '', startPrec: 'exact', ongoing: false, end: '', endTouched: false,
      skipped: false, cycleLen: '28', cycleSure: true, periodLen: '5', periodSure: true
    };
  }

  // Draws the current first-run step
  function renderOnboarding() {
    if (!ob) startOnboarding();
    const box = clear($('#onboarding'));
    const card = el('div', { class: 'card' });
    box.append(card);
    const foot = el('div', { class: 'foot' });
    const stepNo = n => card.append(el('div', { class: 'step-count', text: 'Step ' + n + ' of 6' }));
    const go = n => { ob.step = n; renderOnboarding(); };

    if (ob.step === 1) {
      stepNo(1);
      card.append(
        el('h2', { text: 'Your data stays on this device' }),
        el('p', { text: 'This is a private cycle tracker. Nothing you enter leaves your device.' }),
        el('p', { class: 'disclaimer', text: DISCLAIMER }));
      foot.append(
        el('button', {
          type: 'button', class: 'btn btn--primary btn--big', text: 'I understand',
          onclick: async () => { await saveSettings({ disclaimer_acknowledged_at: S.nowIso() }); go(2); }
        }),
        el('button', { type: 'button', class: 'btn', text: 'Restore from server backup', onclick: openSettings }));
    } else if (ob.step === 2) {
      stepNo(2);
      card.append(
        el('h2', { text: 'Hormonal birth control?' }),
        el('p', { text: 'Are you using hormonal birth control (pill, patch, ring, implant, hormonal IUD, shot)?' }),
        el('p', { class: 'muted', text: 'This decides whether we show ovulation. You can change it anytime.' }));
      const pick = (v, label) => el('button', {
        type: 'button', class: 'btn btn--big', text: label,
        onclick: () => { ob.bc = v; go(liveEntries().length ? 4 : 3); }
      });
      foot.append(pick('yes', 'Yes'), pick('no', 'No'), pick('unsure', 'Not sure'));
    } else if (ob.step === 3) {
      stepNo(3);
      card.append(el('h2', { text: 'When did your last period start?' }));
      const startIn = el('input', { type: 'date', max: today(), value: ob.lastStart });
      const endIn = el('input', { type: 'date', max: today(), value: ob.end });
      const prec = segmented([{ value: 'exact', label: 'Exact' }, { value: 'approximate', label: 'Approximate' }], ob.startPrec, v => { ob.startPrec = v; });
      const err = el('div', { class: 'error-text', role: 'alert' });
      const endField = field('When did it end?', endIn);
      const prefillEnd = () => {
        if (ob.endTouched || !startIn.value) return;
        const guess = Math.min(C.toDn(startIn.value) + 4, C.toDn(today()));
        endIn.value = C.toStr(guess);
        ob.end = endIn.value;
      };
      const going = segmented([{ value: 'yes', label: 'Yes, still going' }, { value: 'no', label: 'No, it ended' }],
        ob.ongoing ? 'yes' : 'no', v => { ob.ongoing = v === 'yes'; endField.hidden = ob.ongoing; });
      endField.hidden = ob.ongoing;
      startIn.addEventListener('change', () => { ob.lastStart = startIn.value; prefillEnd(); });
      endIn.addEventListener('change', () => { ob.end = endIn.value; ob.endTouched = true; });
      card.append(field('First day of your last period', startIn), prec.node,
        el('div', { class: 'muted', text: 'Is it still going?' }), going.node, endField, err);
      foot.append(
        el('button', {
          type: 'button', class: 'btn btn--primary', text: 'Next',
          onclick: () => {
            ob.lastStart = startIn.value;
            if (!ob.lastStart) { err.textContent = 'Choose a date, or skip this step.'; return; }
            const cand = { start_date: ob.lastStart, end_date: ob.ongoing ? null : (ob.end || null) };
            if (!ob.ongoing && !cand.end_date) { err.textContent = 'Choose when it ended.'; return; }
            if (ob.ongoing && C.toDn(today()) - C.toDn(ob.lastStart) > 30) { err.textContent = 'That was a while ago. Choose the end date instead.'; return; }
            const problem = C.validateEntry(cand, [], today(), null);
            if (problem) { err.textContent = problem; return; }
            ob.skipped = false;
            go(4);
          }
        }),
        el('button', { type: 'button', class: 'btn', text: 'I don’t remember / skip', onclick: () => { ob.skipped = true; ob.lastStart = ''; go(4); } }));
    } else if (ob.step === 4) {
      stepNo(4);
      card.append(el('h2', { text: 'Your usual lengths' }));
      const cycleIn = el('input', { type: 'number', inputmode: 'numeric', min: 15, max: 90, value: ob.cycleLen });
      const periodIn = el('input', { type: 'number', inputmode: 'numeric', min: 1, max: 15, value: ob.periodLen });
      const cycleSure = el('input', { type: 'checkbox' });
      cycleSure.checked = !ob.cycleSure;
      const periodSure = el('input', { type: 'checkbox' });
      periodSure.checked = !ob.periodSure;
      const err = el('div', { class: 'error-text', role: 'alert' });
      card.append(
        field('How long is your cycle usually? (days)', cycleIn),
        el('label', { class: 'check' }, cycleSure, el('span', { text: 'Not sure (use 28)' })),
        field('How many days does your period usually last?', periodIn),
        el('label', { class: 'check' }, periodSure, el('span', { text: 'Not sure (use 5)' })),
        err);
      foot.append(el('button', {
        type: 'button', class: 'btn btn--primary', text: 'Next',
        onclick: async () => {
          const cl = Number(cycleIn.value);
          const pl = Number(periodIn.value);
          if (!cycleSure.checked && (!Number.isInteger(cl) || cl < 15 || cl > 90)) { err.textContent = 'Cycle length should be a whole number from 15 to 90.'; return; }
          if (!periodSure.checked && (!Number.isInteger(pl) || pl < 1 || pl > 15)) { err.textContent = 'Period length should be a whole number from 1 to 15.'; return; }
          ob.cycleLen = cycleIn.value;
          ob.periodLen = periodIn.value;
          ob.cycleSure = !cycleSure.checked;
          ob.periodSure = !periodSure.checked;
          await commitOnboarding();
          go(5);
        }
      }));
    } else if (ob.step === 5) {
      stepNo(5);
      card.append(
        el('h2', { text: 'Add past periods?' }),
        el('p', { text: 'Add past periods for better predictions. Even 3 helps; 6 makes predictions much more reliable.' }));
      foot.append(
        el('button', { type: 'button', class: 'btn btn--primary', text: 'Add past periods', onclick: () => openBackfill() }),
        el('button', { type: 'button', class: 'btn', text: ob && liveEntries().length > 1 ? 'Continue' : 'Skip for now', onclick: () => go(6) }));
    } else {
      stepNo(6);
      card.append(
        el('h2', { text: 'You’re all set' }),
        el('p', { text: liveEntries().length ? 'Your calendar shows your next predicted period. Everything you entered can be edited later.' : 'Predictions start from a typical cycle. Log a period whenever it starts.' }));
      foot.append(el('button', {
        type: 'button', class: 'btn btn--primary btn--big', text: 'Go to calendar',
        onclick: async () => { ob = null; await saveSettings({ onboarding_completed_at: S.nowIso() }); goToday(); }
      }));
    }
    card.append(foot);
  }

  // Saves the first-run answers: settings, then the last period (when given)
  async function commitOnboarding() {
    const show = ob.bc !== 'yes';
    await saveSettings({
      hormonal_birth_control: ob.bc, show_ovulation: show, show_fertile_window: show,
      usual_cycle_length: ob.cycleSure ? Number(ob.cycleLen) : null,
      usual_period_length: ob.periodSure ? Number(ob.periodLen) : null
    });
    if (ob.lastStart && !liveEntries().length) {
      await saveEntry(newEntry({
        start_date: ob.lastStart,
        start_precision: ob.startPrec,
        end_date: ob.ongoing ? null : ob.end,
        end_precision: ob.ongoing ? 'approximate' : (ob.endTouched ? 'exact' : 'approximate'),
        source: 'live'
      }));
      recompute();
    }
  }

  /* ================================================================== init */

  async function init() {
    $('#appVersion').textContent = APP_VERSION;
    const persistent = await S.open();
    $('#storageWarning').hidden = persistent;
    await loadAll();
    setViewToday();

    // Optional server backup: dirty-tracking starts here; nothing is sent unless the user turned it on
    sync = CycleSync.create({
      store: S,
      fetch: (url, init) => window.fetch(url, init),
      apiUrl: '../api/cycle.php',
      getSession: () => {
        const u = sessionUser();
        return u && u.token ? { username: u.username, token: u.token } : null;
      },
      storage: { getItem: lsGet, setItem: lsSet, removeItem: lsDel },
      // Records arrived from the server: reload them, then resolve periods two devices both logged
      onRemoteApplied: async () => { await loadAll(); recompute(); await resolveOverlaps(); },
      onStatus: renderBackup
    });
    window.addEventListener('suite-profile-changed', () => { sync.sessionChanged(); renderBackup(); });

    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      switchTab(t.dataset.tab);
      if (t.dataset.tab !== 'history') view.focusCycleId = null;
    }));
    $('#calPrev').addEventListener('click', () => shiftMonth(-1));
    $('#calNext').addEventListener('click', () => shiftMonth(1));
    $('#calToday').addEventListener('click', goToday);
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#legendBtn').addEventListener('click', () => {
      const legend = $('#legend');
      legend.hidden = !legend.hidden;
      $('#legendBtn').setAttribute('aria-expanded', String(!legend.hidden));
    });

    // Horizontal swipe on the calendar changes the month
    let touchX = null;
    const gridWrap = $('#calGrid');
    gridWrap.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
    gridWrap.addEventListener('touchend', e => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 60) shiftMonth(dx < 0 ? 1 : -1);
    }, { passive: true });

    // A new day (or returning to the app) changes "today" and everything derived from it
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && model && model.todayStr !== today()) recompute();
    });

    recompute();
    sync.start();
    if (window.SuiteProfile) SuiteProfile.renderFooterIndicator(document.querySelector('.app-footer'));
  }

  window.addEventListener('DOMContentLoaded', init);
})();
