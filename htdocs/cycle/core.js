/**
 * Cycle core: date math, cycle derivation, prediction, phase, health-note and
 * statistics logic. Pure functions only (no DOM, no storage) so the same file runs in the
 * browser (global `CycleCore`) and in Node (tools/cycle-core-test.js).
 *
 * Dates are `YYYY-MM-DD` strings at the edges and integer "day numbers" (days since
 * 1970-01-01 UTC) inside the math, so month lengths, leap years and DST never matter.
 */
(function (root) {
  'use strict';

  const MS_DAY = 86400000;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const FLAG_REASONS = ['pregnancy', 'miscarriage', 'birth_control_change', 'illness', 'other'];

  /* ------------------------------------------------------------------ dates */

  // "YYYY-MM-DD" -> day number
  function toDn(str) {
    const p = str.split('-').map(Number);
    return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / MS_DAY);
  }

  // day number -> "YYYY-MM-DD"
  function toStr(dn) {
    return new Date(dn * MS_DAY).toISOString().slice(0, 10);
  }

  // True when `str` is a real calendar date written as YYYY-MM-DD (years 1900-2999)
  function isValidDate(str) {
    if (typeof str !== 'string' || !DATE_RE.test(str)) return false;
    const year = Number(str.slice(0, 4));
    if (year < 1900 || year > 2999) return false;
    return toStr(toDn(str)) === str;
  }

  // The device's local calendar date
  function localToday() {
    const n = new Date();
    const pad = v => (v < 10 ? '0' : '') + v;
    return n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate());
  }

  // Round half up to a whole day
  function round(x) {
    return Math.floor(x + 0.5);
  }

  /* ------------------------------------------------------------------ math */

  // Error function (Abramowitz-Stegun 7.1.26)
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t * Math.exp(-ax * ax);
    return sign * y;
  }

  // Standard normal cumulative distribution
  function phi(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  // Weighted median: first value whose cumulative weight reaches half the total; when the
  // cumulative weight lands exactly on half, the mean of that value and the next one.
  function weightedMedian(values, weights) {
    if (!values.length) return null;
    const pairs = values.map((v, i) => ({ v: v, w: weights ? weights[i] : 1 }))
      .sort((a, b) => a.v - b.v);
    const total = pairs.reduce((s, p) => s + p.w, 0);
    const half = total / 2;
    let cum = 0;
    for (let i = 0; i < pairs.length; i++) {
      cum += pairs[i].w;
      if (Math.abs(cum - half) < 1e-9 && i < pairs.length - 1) return (pairs[i].v + pairs[i + 1].v) / 2;
      if (cum >= half - 1e-9) return pairs[i].v;
    }
    return pairs[pairs.length - 1].v;
  }

  // Blend a personal estimate with a prior: full weight on the prior at n=0, none at n>=full
  function blend(n, personal, prior, full) {
    if (n <= 0) return prior;
    if (n >= full) return personal;
    return (n * personal + (full - n) * prior) / full;
  }

  /* ------------------------------------------------------------------ model */

  function byStart(a, b) {
    return a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : 0;
  }

  /**
   * Derives everything the UI needs from the stored records.
   * data: { entries, flags, settings }; todayStr: local "YYYY-MM-DD".
   */
  function buildModel(data, todayStr) {
    const settings = data.settings || {};
    const today = toDn(todayStr);
    const entries = (data.entries || []).filter(e => !e.deleted).sort(byStart);

    const flagByEntry = {};
    (data.flags || []).forEach(f => { if (!f.deleted) flagByEntry[f.period_entry_id] = f; });
    const isExcluded = id => !!(flagByEntry[id] && flagByEntry[id].exclude_from_stats);

    // Complete cycles: each period start to the next period start
    const cycles = [];
    for (let i = 0; i < entries.length - 1; i++) {
      const a = entries[i];
      const b = entries[i + 1];
      const startDn = toDn(a.start_date);
      const nextDn = toDn(b.start_date);
      const c = {
        entry: a,
        id: a.id,
        startDn: startDn,
        nextDn: nextDn,
        length: nextDn - startDn,
        periodLength: a.end_date ? toDn(a.end_date) - startDn + 1 : null,
        weight: (a.start_precision === 'exact' && b.start_precision === 'exact') ? 1.0 : 0.5,
        flag: flagByEntry[a.id] || null,
        flagged: isExcluded(a.id)
      };
      c.eligible = !c.flagged && c.length >= 15 && c.length <= 90;
      cycles.push(c);
    }

    // Prediction window: the 12 most recent eligible cycles
    const win = cycles.filter(c => c.eligible).slice(-12);
    const n = win.length;

    const mu0 = settings.usual_cycle_length || 28;
    const P0 = settings.usual_period_length || 5;
    const sigma0 = 3.0;

    let muP = null;
    let sigmaP = null;
    if (n > 0) {
      const lens = win.map(c => c.length);
      const ws = win.map(c => c.weight);
      muP = weightedMedian(lens, ws);
      const mad = weightedMedian(lens.map(l => Math.abs(l - muP)), ws);
      sigmaP = Math.max(1.0, 1.4826 * mad);
    }
    const mu = n === 0 ? mu0 : blend(n, muP, mu0, 3);
    const sigma = n < 2 ? sigma0 : (n < 6 ? (n * sigmaP + (6 - n) * sigma0) / 6 : sigmaP);

    // Period length window: 12 most recent completed periods outside flagged cycles
    const pEntries = entries.filter(e => e.end_date && !isExcluded(e.id)).slice(-12);
    const nP = pEntries.length;
    let P = P0;
    if (nP > 0) {
      const pl = pEntries.map(e => toDn(e.end_date) - toDn(e.start_date) + 1);
      const pw = pEntries.map(e => (e.start_precision === 'exact' && e.end_precision === 'exact') ? 1.0 : 0.5);
      P = blend(nP, weightedMedian(pl, pw), P0, 3);
    }

    // Confidence label
    let confidence;
    if (n === 0) {
      confidence = {
        level: 'default', label: 'Default',
        text: cycles.some(c => c.flagged) ? 'Recent cycles are marked unusual, so typical values are used.' :
          (settings.usual_cycle_length ?
            'Based on your usual ' + mu0 + '-day cycle until you log more.' :
            'Based on a typical 28-day cycle until you log more.')
      };
    } else if (n <= 2) {
      confidence = { level: 'early', label: 'Early estimate', text: 'Getting to know your cycle.' };
    } else if (n <= 5) {
      confidence = { level: 'personal', label: 'Personal', text: 'Based on your last ' + n + ' cycles.' };
    } else {
      confidence = { level: 'established', label: 'Established', text: 'Based on your last ' + n + ' cycles.' };
    }

    const model = {
      settings: settings,
      todayStr: todayStr,
      today: today,
      entries: entries,
      flagByEntry: flagByEntry,
      cycles: cycles,
      window: win,
      n: n,
      nP: nP,
      muP: muP,
      sigmaP: sigmaP,
      mu: mu,
      sigma: sigma,
      P: P,
      mu0: mu0,
      P0: P0,
      confidence: confidence,
      last: null,
      ongoing: null,
      L: null,
      lateDays: 0,
      predictions: [],
      timeline: []
    };

    if (entries.length) {
      const last = entries[entries.length - 1];
      model.last = last;
      model.L = toDn(last.start_date);
      model.ongoing = last.end_date ? null : last;
      model.ongoingDay = model.ongoing ? today - model.L + 1 : null;

      // Future period predictions, shifted forward when the period is late
      const c1raw = model.L + mu;
      let shift = 0;
      if (today > round(c1raw)) {
        model.lateDays = today - round(c1raw);
        shift = today + 1 - c1raw;
      }
      let horizon = 1;
      while (horizon < 12 && 4 * sigma * Math.sqrt(horizon + 1) <= mu / 2) horizon++;
      model.horizon = horizon;
      for (let k = 1; k <= horizon; k++) {
        model.predictions.push({ k: k, c: model.L + k * mu + shift, s: sigma * Math.sqrt(k) });
      }
      model.next = {
        mostLikely: round(model.predictions[0].c),
        from: round(model.predictions[0].c - model.predictions[0].s),
        to: round(model.predictions[0].c + model.predictions[0].s)
      };
      buildTimeline(model);
    }
    return model;
  }

  // Builds the per-cycle phase / ovulation timeline (past, current and predicted cycles)
  function buildTimeline(model) {
    const entries = model.entries;
    const Pr = round(model.P);
    const tl = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const S = toDn(e.start_date);
      const isLast = i === entries.length - 1;
      const N = isLast ? round(model.predictions[0].c) : toDn(entries[i + 1].start_date);
      const p = e.end_date ? toDn(e.end_date) - S + 1 : Pr;
      tl.push(makeCycle(S, N, p, isLast ? 'current' : 'past'));
    }
    // Predicted cycles that begin at c_j and end at c_{j+1}
    for (let j = 1; j < model.predictions.length; j++) {
      tl.push(makeCycle(round(model.predictions[j - 1].c), round(model.predictions[j].c), Pr, 'predicted'));
    }
    model.timeline = tl;
  }

  // One cycle with start S, next start N, period length p: ovulation and phase ranges
  function makeCycle(S, N, p, kind) {
    const O = N - 14;
    const periodEnd = S + p - 1;
    const ovShown = O > periodEnd;
    const phases = [];
    const add = (phase, from, to) => {
      const f = Math.max(from, S);
      const t = Math.min(to, N - 1);
      if (t >= f) phases.push({ phase: phase, from: f, to: t });
    };
    add('menstrual', S, periodEnd);
    add('follicular', S + p, O - 2);
    add('ovulatory', Math.max(O - 1, S + p), O + 1);
    add('luteal', Math.max(O + 2, S + p), N - 1);
    return { S: S, N: N, p: p, O: O, ovShown: ovShown, kind: kind, phases: phases };
  }

  // Probability (0-1) that a period is under way on day dn, from the predicted cycles
  function periodProbability(model, dn) {
    const P = model.P;
    let sum = 0;
    model.predictions.forEach(pr => {
      sum += phi((dn - pr.c + 0.5) / pr.s) - phi((dn - (P - 1) - pr.c - 0.5) / pr.s);
    });
    return Math.min(1, Math.max(0, sum));
  }

  // The logged entry covering day dn (an ongoing entry covers through today)
  function entryAt(model, dn) {
    for (let i = 0; i < model.entries.length; i++) {
      const e = model.entries[i];
      const s = toDn(e.start_date);
      const end = e.end_date ? toDn(e.end_date) : Math.max(model.today, s);
      if (dn >= s && dn <= end) return e;
    }
    return null;
  }

  /**
   * Everything the calendar shows for one day.
   * Returns { dn, isToday, logged, entry, predictedEnd, prob, likely, band, phase, phaseKind,
   *           cycleDay, ovulation ('ov' | 'pov' | null), fertile }.
   */
  function dayInfo(model, dn) {
    const s = model.settings || {};
    const bc = s.hormonal_birth_control === 'yes';
    const info = {
      dn: dn, isToday: dn === model.today, logged: false, entry: null, predictedEnd: false,
      prob: 0, likely: false, band: false, phase: null, phaseKind: 'actual', cycleDay: null,
      ovulation: null, fertile: false
    };
    if (!model.last) return info;

    const entry = entryAt(model, dn);
    if (entry) {
      info.logged = true;
      info.entry = entry;
    } else if (model.ongoing && dn > model.today && dn <= model.L + round(model.P) - 1) {
      info.predictedEnd = true;
    }

    if (!info.logged && !info.predictedEnd && dn >= model.today) {
      info.prob = periodProbability(model, dn);
      info.likely = info.prob >= 0.5;
      info.band = !info.likely && info.prob >= 0.05;
    }

    for (let i = 0; i < model.timeline.length; i++) {
      const c = model.timeline[i];
      if (dn >= c.S && dn <= c.N - 1) {
        info.cycleDay = dn - c.S + 1;
        for (let j = 0; j < c.phases.length; j++) {
          const ph = c.phases[j];
          if (dn >= ph.from && dn <= ph.to) {
            // On hormonal birth control only the bleed phase applies
            if (!bc || ph.phase === 'menstrual') info.phase = ph.phase;
            break;
          }
        }
        info.phaseKind = (c.kind === 'predicted' || dn > model.today) ? 'predicted' : 'actual';
      }
      if (c.ovShown) {
        if (dn === c.O) info.ovulation = c.kind === 'predicted' ? 'pov' : 'ov';
        if (dn >= c.O - 5 && dn <= c.O + 1) info.fertile = true;
      }
    }
    if (s.show_ovulation === false) info.ovulation = null;
    if (s.show_fertile_window === false) info.fertile = false;
    return info;
  }

  /**
   * Typical mood and energy level (0-1) for day dn, a general pattern across people and not a
   * prediction for one person. The curve is eased between landmarks of the day's cycle:
   * low and flat around the period, rising through the follicular phase to a peak on the
   * estimated ovulation day, steady early in the luteal phase, then falling toward the next period.
   * Returns { v, predicted } or null when no cycle covers the day.
   */
  const MOOD_LOW = 0.15;
  function moodLevel(model, dn) {
    if (!model.last) return null;
    for (let i = 0; i < model.timeline.length; i++) {
      const c = model.timeline[i];
      if (dn < c.S || dn > c.N - 1) continue;
      // Peak sits on ovulation but never inside the period
      const peak = Math.max(c.O, c.S + c.p + 1);
      const raw = [
        [c.S, 0.30], [c.S + c.p - 1, 0.35], [peak, 1], [peak + 2, 0.70],
        [c.N - 8, 0.55], [c.N - 1, MOOD_LOW], [c.N, 0.30]
      ];
      // Keep landmarks strictly increasing so short cycles still give a valid curve
      const pts = [];
      raw.forEach(p => { if (!pts.length || p[0] > pts[pts.length - 1][0]) pts.push(p); });
      let v = pts[pts.length - 1][1];
      for (let k = 1; k < pts.length; k++) {
        if (dn <= pts[k][0]) {
          const a = pts[k - 1];
          const b = pts[k];
          const w = (1 - Math.cos(Math.PI * (dn - a[0]) / (b[0] - a[0]))) / 2;
          v = a[1] + (b[1] - a[1]) * w;
          break;
        }
      }
      return { v: v, predicted: c.kind === 'predicted' || dn > model.today };
    }
    return null;
  }

  /* ------------------------------------------------------------ statistics */

  // Range of eligible cycle lengths, dropping at most one extreme outlier once n >= 6
  function variation(model) {
    if (!model.n) return null;
    let lens = model.window.map(c => c.length);
    if (model.n >= 6) {
      let worst = -1;
      let worstDev = 0;
      lens.forEach((x, i) => {
        const d = Math.abs(x - model.muP);
        if (d > worstDev) { worstDev = d; worst = i; }
      });
      if (worst >= 0 && worstDev > 3 * model.sigmaP) lens = lens.filter((_, i) => i !== worst);
    }
    return Math.max.apply(null, lens) - Math.min.apply(null, lens);
  }

  // Stats screen numbers, with the regularity rating once n >= 3
  function stats(model) {
    const v = variation(model);
    let regularity = null;
    if (model.n >= 3 && v !== null) {
      if (v <= 4) regularity = { rating: 'Regular', text: 'Your cycles stay within a few days of each other.' };
      else if (v <= 8) regularity = { rating: 'Somewhat irregular', text: 'Your cycle length shifts a bit from month to month, which is common.' };
      else regularity = { rating: 'Irregular', text: 'Your cycle length varies quite a lot, so predictions are less certain.' };
    }
    return {
      n: model.n,
      avgCycle: round(model.mu),
      avgPeriod: round(model.P),
      variation: v,
      regularity: regularity,
      confidence: model.confidence
    };
  }

  // Bars for the cycle-length chart: the 12 most recent complete cycles plus the shaded band
  function chartData(model) {
    const bars = model.cycles.slice(-12).map(c => {
      let excluded = false;
      let reason = null;
      if (c.flagged) { excluded = true; reason = c.flag.reason; }
      else if (!c.eligible) { excluded = true; reason = 'out_of_range'; }
      return { id: c.id, length: c.length, startDn: c.startDn, excluded: excluded, reason: reason };
    });
    let band;
    if (model.n >= 3) {
      band = { kind: 'normal', lo: round(model.muP - 2 * model.sigmaP), hi: round(model.muP + 2 * model.sigmaP) };
    } else {
      band = { kind: 'reference', lo: 21, hi: 35 };
    }
    return { bars: bars, band: band };
  }

  /* ---------------------------------------------------------- health notes */

  const NOTE_ORDER = ['no_period_90', 'no_period_60', 'long_period', 'cycle_length_out_of_range', 'high_variation'];

  const NOTE_TEXT = {
    cycle_length_out_of_range: {
      title: 'Cycle length',
      text: 'Your cycles are often shorter than 21 or longer than 35 days. That can be normal for some people, but it’s worth mentioning to a doctor.'
    },
    high_variation: {
      title: 'Cycle variation',
      text: 'Your cycle length varies by more than 9 days. Worth mentioning at your next check-up.'
    },
    no_period_60: {
      title: 'No period for a while',
      text: 'It’s been over 60 days since your last period. If you’re not pregnant, consider checking in with a doctor.'
    },
    no_period_90: {
      title: 'No period for a while',
      text: 'It’s been 90 days or more since your last period. It’s a good idea to talk to a doctor.'
    },
    long_period: {
      title: 'Period length',
      text: 'Some of your periods last longer than 7 days. Worth mentioning to a doctor.'
    }
  };

  // Active "worth mentioning to a doctor" notes, most severe first, minus dismissed ones
  function healthNotes(model, dismissals) {
    const out = [];
    if (!model.last) return out;
    const bc = (model.settings || {}).hormonal_birth_control === 'yes';
    const add = (type, key) => out.push({ type: type, key: key, title: NOTE_TEXT[type].title, text: NOTE_TEXT[type].text });

    // No period for 60 / 90 days (suppressed while ongoing or while the latest cycle is flagged pregnancy)
    const lastFlag = model.flagByEntry[model.last.id];
    const pregnant = !!(lastFlag && lastFlag.reason === 'pregnancy');
    if (!model.ongoing && !pregnant) {
      const gap = model.today - model.L;
      if (gap >= 90) add('no_period_90', model.last.start_date);
      else if (gap >= 60) add('no_period_60', model.last.start_date);
    }

    // Long periods: any >= 10 days, or two of the last six longer than 7 days
    const lens = model.entries
      .filter(e => !(model.flagByEntry[e.id] && model.flagByEntry[e.id].exclude_from_stats))
      .map(e => ({
        id: e.id,
        len: e.end_date ? toDn(e.end_date) - toDn(e.start_date) + 1 : Math.max(1, model.today - toDn(e.start_date) + 1)
      }));
    const veryLong = lens.filter(x => x.len >= 10);
    const recentLong = lens.slice(-6).filter(x => x.len > 7);
    if (veryLong.length) add('long_period', veryLong.map(x => x.id).sort().join(','));
    else if (recentLong.length >= 2) add('long_period', recentLong.map(x => x.id).sort().join(','));

    if (!bc) {
      // Cycle length out of the 21-35 day range (needs 3 usable cycles)
      if (model.n >= 3) {
        const recent = model.cycles.filter(c => !c.flagged).slice(-6);
        const outCount = recent.filter(c => c.length < 21 || c.length > 35).length;
        if (model.muP < 21 || model.muP > 35 || outCount >= 2) {
          add('cycle_length_out_of_range', recent.map(c => c.id).sort().join(','));
        }
      }
      // Large cycle-to-cycle variation (needs 6 usable cycles)
      if (model.n >= 6 && variation(model) > 9) {
        add('high_variation', model.window.map(c => c.id).sort().join(','));
      }
    }

    const dismissed = (dismissals || []).filter(d => !d.deleted);
    return out
      .filter(note => !dismissed.some(d => d.note_type === note.type && d.evidence_key === note.key))
      .sort((a, b) => NOTE_ORDER.indexOf(a.type) - NOTE_ORDER.indexOf(b.type));
  }

  /* ------------------------------------------------------- logging helpers */

  /**
   * Checks a candidate period ({start_date, end_date|null}) against the other entries.
   * Returns an error message, or null when it is acceptable.
   */
  function validateEntry(cand, entries, todayStr, selfId) {
    if (!isValidDate(cand.start_date)) return 'Choose a valid start date.';
    if (cand.end_date !== null && cand.end_date !== undefined && !isValidDate(cand.end_date)) return 'Choose a valid end date.';
    if (cand.start_date > todayStr) return 'Future dates can’t be logged.';
    const hasEnd = !!cand.end_date;
    if (hasEnd && cand.end_date > todayStr) return 'The end date can’t be in the future.';
    if (hasEnd && cand.end_date < cand.start_date) return 'The end date can’t be before the start date.';

    const today = toDn(todayStr);
    const cs = toDn(cand.start_date);
    const ce = hasEnd ? toDn(cand.end_date) : Math.max(today, cs);
    const others = entries.filter(e => !e.deleted && e.id !== selfId);
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      const os = toDn(o.start_date);
      const oe = o.end_date ? toDn(o.end_date) : Math.max(today, os);
      if (cs <= oe && ce >= os) return 'That overlaps a period you already logged.';
      if (!hasEnd && os > cs) return 'Only your most recent period can still be going.';
      if (!hasEnd && !o.end_date && os < cs) return 'Another period is still marked as going. End it first.';
    }
    return null;
  }

  /**
   * Looks for an implausible cycle created by a period start on dStr.
   * Returns { kind: 'short'|'long', days, target: 'prev'|'new', prev } or null.
   */
  function cycleCheck(entries, dStr) {
    const live = entries.filter(e => !e.deleted).sort(byStart);
    const d = toDn(dStr);
    let prev = null;
    let next = null;
    live.forEach(e => {
      if (e.start_date < dStr) prev = e;
      else if (e.start_date > dStr && !next) next = e;
    });
    if (prev) {
      const len = d - toDn(prev.start_date);
      if (len < 15) return { kind: 'short', days: len, target: 'prev', prev: prev };
      if (len > 60) return { kind: 'long', days: len, target: 'prev', prev: prev };
    }
    if (next) {
      const len = toDn(next.start_date) - d;
      if (len < 15) return { kind: 'short', days: len, target: 'new', prev: prev };
      if (len > 60) return { kind: 'long', days: len, target: 'new', prev: prev };
    }
    return null;
  }

  // Default end for a newly logged start: ongoing when recent, otherwise a usual-length period
  function suggestEnd(dStr, todayStr, P, entries) {
    const d = toDn(dStr);
    const today = toDn(todayStr);
    const Pr = round(P);
    const later = entries.filter(e => !e.deleted && e.start_date > dStr).sort(byStart)[0];
    if (!later && d >= today - Pr + 1) return { end_date: null, end_precision: 'approximate' };
    let end = d + Pr - 1;
    if (later) end = Math.min(end, toDn(later.start_date) - 1);
    end = Math.min(end, today);
    return { end_date: toStr(Math.max(end, d)), end_precision: 'approximate' };
  }

  const api = {
    toDn: toDn, toStr: toStr, isValidDate: isValidDate, localToday: localToday, round: round,
    erf: erf, phi: phi, weightedMedian: weightedMedian,
    buildModel: buildModel, dayInfo: dayInfo, moodLevel: moodLevel, entryAt: entryAt, periodProbability: periodProbability,
    variation: variation, stats: stats, chartData: chartData,
    healthNotes: healthNotes, NOTE_ORDER: NOTE_ORDER,
    validateEntry: validateEntry, cycleCheck: cycleCheck, suggestEnd: suggestEnd,
    FLAG_REASONS: FLAG_REASONS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CycleCore = api;
})(typeof self !== 'undefined' ? self : this);
