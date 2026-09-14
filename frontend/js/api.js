/**
 * Rakshak 112 — api.js
 * Shared helpers: Haversine distance, state/status, capabilities,
 * hospital ranking, DOM helpers. Kept independent of app logic.
 */

const $ = id => document.getElementById(id);

const esc = v =>
  String(v ?? '—').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#039;'
  }[c]));

const pc = p => p?.code === 'L1' ? 'critical' : 'standard';

/* ---------- Haversine (km) ---------- */
const km = (a, b, c, d) => {
  const r = 6371;
  const x = (c - a) * Math.PI / 180;
  const y = (d - b) * Math.PI / 180;
  const z = Math.sin(x / 2) ** 2 +
            Math.cos(a * Math.PI / 180) *
            Math.cos(c * Math.PI / 180) *
            Math.sin(y / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(z));
};

/* ---------- capability status ---------- */
const state = (v, kind = 'capability') => {
  if (v === true || v === 1) return ['ok', '✓ Verified'];
  if (v === false || v === 0) return ['bad', kind === 'resource' ? '✕ Unavailable' : '✕ Unavailable'];
  return ['unknown', '? Unknown'];
};

const capStatus = (v, label) => {
  const isOk = (v === true || v === 1);
  return `<span class="cap ${isOk ? 'ok' : 'off'}">${isOk ? '✓' : '✕'} ${label}</span>`;
};

/* ---------- priority required capabilities ---------- */
const needs = () =>
  selected?.priority?.code === 'L1'
    ? ['Trauma Level 1', 'Emergency Department', 'ICU bed', 'Emergency Surgery', 'Orthopedics']
    : ['Emergency Department', 'Emergency bed'];

/* ---------- requirement status ---------- */
const reqStatus = h => {
  const c = h.capabilities || {}, l = h.live_status || {};
  const checks = [
    c.trauma_level === 1, c.emergency_department, c.icu,
    c.emergency_surgery, c.orthopedics, l.icu_beds_available
  ];
  const unavailable = checks.some(v => v === false || v === 0);
  const unknown = checks.some(v => v == null);
  return unavailable ? 2 : unknown ? 1 : 0;
};

/* ---------- ranking engine ---------- */
const ranks = () => {
  if (!selected) return [];
  return hospitals.map(h => {
    const d = km(selected.location.latitude, selected.location.longitude, h.latitude, h.longitude);
    const l = h.live_status || {}, c = h.capabilities || {}, t = reqStatus(h);
    const verified = [c.trauma_level === 1, c.emergency_department === true, c.icu === true, c.emergency_surgery === true, c.orthopedics === true].filter(Boolean).length;
    const resources = [l.icu_beds_available > 0, l.emergency_beds_available > 0, l.operation_theatre_available === true, l.ventilators_available > 0].filter(Boolean).length;
    const raw = verified * 12 + resources * 7 + 10 + Math.max(0, 15 - d * .7) + Math.max(0, 7 - Math.max(4, Math.round(d / .55 + 3)) * .3);
    const score = Math.max(0, Math.min(100, Math.round(raw)));
    return { h, d, t, score, eta: Math.max(4, Math.round(d / .55 + 3)) };
  }).sort((a, b) => a.t - b.t || b.score - a.score || a.d - b.d);
};

/* ---------- resource row ---------- */
const resource = (label, v) => {
  const s = state(v, 'resource');
  const text = v == null ? '—' : typeof v === 'number' ? `${v} available` : v === true ? 'Available' : 'Unavailable';
  return `<div class="resource"><span class="status ${s[0]}">${s[1]}</span><b>${text}</b><small>${label}</small></div>`;
};

/* ---------- capability chip ---------- */
const cap = (n, v) => {
  const isOk = (v === true || v === 1);
  return `<span class="cap ${isOk ? '' : 'off'}">${isOk ? '✓ ' : '✕ '}${n}</span>`;
};

/* ---------- status badge ---------- */
const status = (label, v, kind) => {
  const s = state(v, kind);
  return `<span class="status ${s[0]}">${s[1]} · ${label}</span>`;
};
