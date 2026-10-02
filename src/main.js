import Chart from 'chart.js/auto';
import './style.css';
import scheduleData from './data/schedule.json';
import { sb } from './supabase.js';

window.Chart = Chart;

/* =========================================================
   Utilidades
   ========================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
function todayISO() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function dateToISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(iso, n) { const d = isoToDate(iso); d.setDate(d.getDate() + n); return dateToISO(d); }
function isISODate(s) { if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false; return dateToISO(isoToDate(s)) === s; }
function fmtDate(iso) { if (!iso) return '—'; return isoToDate(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }); }
function fmtDateShort(iso) { return isoToDate(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }); }
function weekStart(iso) { const d = isoToDate(iso); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return dateToISO(d); }
function newId() { return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
const ID_RE = /^[A-Za-z0-9_\-~:@+]{1,80}$/;
function norm(s) { return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }

/* =========================================================
   Cálculos (todo el dinero se maneja en centavos enteros)
   ========================================================= */
// CALC-START
const STATUSES = ['pendiente', 'ganada', 'perdida', 'anulada', 'cashout'];
const STATUS_LABEL = { pendiente: 'Pendiente', ganada: 'Ganada', perdida: 'Perdida', anulada: 'Anulada', cashout: 'Cash out' };

function parseMoneyToCents(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/^'/, '').replace(/MXN|USD/gi, '').replace(/[\s$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [i, d] = s.split('.');
  return parseInt(i, 10) * 100 + (d ? parseInt((d + '0').slice(0, 2), 10) : 0);
}

function parseOdds(format, input) {
  const s = String(input ?? '').trim().replace(/^'/, '').replace(/\s/g, '').replace(',', '.').replace('−', '-');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, error: 'Escribe el momio como número, por ejemplo ' + (format === 'american' ? '+150 o -110.' : '1.80.') };
  }
  const n = Number(s);
  if (format === 'american') {
    if (!(n <= -100 || n >= 100)) return { ok: false, error: 'El momio americano debe ser ≤ −100 o ≥ +100.' };
    return { ok: true, value: n };
  }
  if (format === 'decimal') {
    if (!(n > 1)) return { ok: false, error: 'El momio decimal debe ser mayor que 1.' };
    return { ok: true, value: n };
  }
  return { ok: false, error: 'Elige el formato del momio.' };
}

// Ganancia potencial (sin incluir lo apostado), en centavos.
function potentialProfitCents(stakeC, format, odds) {
  if (format === 'american') {
    return odds > 0 ? Math.round(stakeC * odds / 100) : Math.round(stakeC * 100 / Math.abs(odds));
  }
  const k = Math.round(odds * 10000); // momio decimal escalado a entero
  return Math.round(stakeC * (k - 10000) / 10000);
}

function betOutcome(b) {
  const pot = potentialProfitCents(b.stakeC, b.oddsFormat, b.odds);
  const o = { potProfitC: pot, potReturnC: b.stakeC + pot, settled: b.status !== 'pendiente', returnC: null, netC: null };
  switch (b.status) {
    case 'ganada': o.returnC = b.stakeC + pot; o.netC = pot; break;
    case 'perdida': o.returnC = 0; o.netC = -b.stakeC; break;
    case 'anulada': o.returnC = b.stakeC; o.netC = 0; break;
    case 'cashout': o.returnC = b.cashoutC || 0; o.netC = (b.cashoutC || 0) - b.stakeC; break;
  }
  return o;
}

function computeMetrics(staked, realized) {
  const m = { totalStakeC: 0, pendingC: 0, returnedC: 0, gainsC: 0, lossesC: 0,
    counts: { pendiente: 0, ganada: 0, perdida: 0, anulada: 0, cashout: 0 }, roiStakeC: 0, roiNetC: 0 };
  for (const b of staked) {
    m.totalStakeC += b.stakeC;
    if (b.status === 'pendiente') { m.pendingC += b.stakeC; m.counts.pendiente++; }
  }
  for (const b of realized) {
    const o = betOutcome(b);
    m.returnedC += o.returnC;
    if (o.netC > 0) m.gainsC += o.netC; else if (o.netC < 0) m.lossesC += -o.netC;
    m.counts[b.status]++;
    if (b.status !== 'anulada') { m.roiStakeC += b.stakeC; m.roiNetC += o.netC; }
  }
  m.balanceC = m.gainsC - m.lossesC;
  const wl = m.counts.ganada + m.counts.perdida;
  m.hitRate = wl > 0 ? m.counts.ganada / wl * 100 : null;
  m.roi = m.roiStakeC > 0 ? m.roiNetC / m.roiStakeC * 100 : null;
  m.settledCount = realized.length;
  return m;
}
// CALC-END

/* =========================================================
   Estado y almacenamiento
   ========================================================= */
const LS = { real: 'apuestas:bets:real:v1', demo: 'apuestas:bets:demo:v1', settings: 'apuestas:settings:v1' };
function lsGet(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

let settings = Object.assign({ currency: 'MXN', mode: 'real' }, lsGet(LS.settings, {}));
if (!['MXN', 'USD'].includes(settings.currency)) settings.currency = 'MXN';
if (!['real', 'demo'].includes(settings.mode)) settings.mode = 'real';

const data = {
  real: (lsGet(LS.real, []) || []).map(normalizeBet).filter(Boolean),
  demo: (lsGet(LS.demo, []) || []).map(normalizeBet).filter(Boolean),
};
const remote = { user: null, on: false, channel: null, downloads: null, checked: false, loading: false };
const bets = () => data[settings.mode];

function normalizeBet(r) {
  if (!r || typeof r !== 'object') return null;
  const b = {
    id: String(r.id || newId()),
    date: String(r.date || ''),
    settledDate: r.settledDate ? String(r.settledDate) : '',
    sport: String(r.sport || '').trim(),
    league: String(r.league || '').trim(),
    event: String(r.event || '').trim(),
    selection: String(r.selection || '').trim(),
    type: r.type === 'parlay' ? 'parlay' : 'simple',
    legs: Array.isArray(r.legs) ? r.legs.map(l => ({ event: String(l?.event || '').trim(), selection: String(l?.selection || '').trim() })) : [],
    book: String(r.book || '').trim(),
    stakeC: Number.isInteger(r.stakeC) ? r.stakeC : Math.round(Number(r.stakeC) || 0),
    oddsFormat: r.oddsFormat === 'decimal' ? 'decimal' : 'american',
    odds: Number(r.odds),
    status: STATUSES.includes(r.status) ? r.status : 'pendiente',
    cashoutC: r.cashoutC == null ? null : Math.round(Number(r.cashoutC)),
    notes: String(r.notes || ''),
    createdAt: String(r.createdAt || new Date().toISOString()),
    updatedAt: String(r.updatedAt || r.createdAt || new Date().toISOString()),
  };
  if (b.status !== 'cashout') b.cashoutC = null;
  if (b.status === 'pendiente') b.settledDate = '';
  if (!isISODate(b.date) || !(b.stakeC > 0) || !Number.isFinite(b.odds)) return null;
  return b;
}

function validateBet(b) {
  const e = {};
  if (!isISODate(b.date)) e.date = 'Elige una fecha válida.';
  if (!b.sport) e.sport = 'Elige una liga o escribe el deporte.';
  if (!b.book) e.book = 'Escribe la casa de apuestas.';
  if (b.type === 'simple') {
    if (!b.event) e.event = 'Escribe el evento o partido.';
    if (!b.selection) e.selection = 'Escribe a qué apostaste.';
  } else {
    if (b.legs.length < 2) e.legs = 'Un parlay necesita al menos 2 selecciones.';
    else if (b.legs.some(l => !l.event || !l.selection)) e.legs = 'Completa el evento y la selección de cada línea del parlay.';
  }
  if (!(Number.isInteger(b.stakeC) && b.stakeC > 0)) e.stake = 'El monto debe ser mayor que cero (ej. 100 o 250.50).';
  const od = parseOdds(b.oddsFormat, b.oddsRaw ?? String(b.odds));
  if (!od.ok) e.odds = od.error;
  if (!STATUSES.includes(b.status)) e.status = 'Elige un estado.';
  if (b.status === 'cashout' && !(Number.isInteger(b.cashoutC) && b.cashoutC >= 0)) e.cashout = 'Escribe el importe recibido por cash out (puede ser 0).';
  if (b.status !== 'pendiente') {
    if (!isISODate(b.settledDate)) e.settledDate = 'Elige la fecha de liquidación.';
    else if (isISODate(b.date) && b.settledDate < b.date) e.settledDate = 'No puede ser anterior a la fecha de la apuesta.';
  }
  return e;
}

function fingerprint(b) {
  const sel = b.type === 'parlay' ? b.legs.map(l => norm(l.event) + '>' + norm(l.selection)).join('+') : norm(b.event) + '>' + norm(b.selection);
  return [b.date, b.type, sel, b.stakeC, b.oddsFormat, Number(b.odds), norm(b.book)].join('|');
}

/* ---------------- Supabase ---------------- */
const cacheKey = uid => 'apuestas:bets:sb:' + uid;
function cacheLocal(mode) {
  if (mode === 'real' && remote.user) lsSet(cacheKey(remote.user.id), data.real);
  else lsSet(LS[mode], data[mode]);
}
function stripForStore(b) { const c = { ...b }; delete c.oddsRaw; delete c.dudas; return c; }
function toRow(b) {
  return {
    user_id: remote.user.id, id: b.id, bet_date: b.date, settled_date: b.settledDate || null,
    sport: b.sport, league: b.league, event: b.event, selection: b.selection, type: b.type, legs: b.legs,
    book: b.book, stake_cents: b.stakeC, odds_format: b.oddsFormat, odds: b.odds, status: b.status,
    cashout_cents: b.cashoutC, notes: b.notes, created_at: b.createdAt, updated_at: b.updatedAt,
  };
}
function fromRow(r) {
  return normalizeBet({
    id: r.id, date: r.bet_date, settledDate: r.settled_date || '', sport: r.sport, league: r.league, event: r.event,
    selection: r.selection, type: r.type, legs: r.legs, book: r.book, stakeC: Number(r.stake_cents),
    oddsFormat: r.odds_format, odds: Number(r.odds), status: r.status,
    cashoutC: r.cashout_cents == null ? null : Number(r.cashout_cents), notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
}
const useCloud = mode => mode === 'real' && remote.on && remote.user;
function sbError(e, what) {
  console.warn('supabase', e);
  toast((what || 'No se pudo guardar en Supabase') + (e && e.message ? ': ' + e.message : '.'));
}
function saveSettings() {
  lsSet(LS.settings, settings);
  if (sb && remote.user) sb.from('user_settings').upsert({ user_id: remote.user.id, currency: settings.currency, updated_at: new Date().toISOString() }).then(({ error }) => { if (error) sbError(error, 'No se guardó la moneda'); });
}
async function persistBet(bet) {
  const mode = settings.mode, list = data[mode];
  const i = list.findIndex(x => x.id === bet.id);
  if (i >= 0) list[i] = bet; else list.push(bet);
  cacheLocal(mode);
  if (useCloud(mode)) {
    const { error } = await sb.from('bets').upsert(toRow(bet), { onConflict: 'user_id,id' });
    if (error) sbError(error);
  }
}
async function removeBet(id) {
  const mode = settings.mode;
  data[mode] = data[mode].filter(b => b.id !== id);
  cacheLocal(mode);
  if (useCloud(mode)) {
    const { error } = await sb.from('bets').delete().eq('user_id', remote.user.id).eq('id', id);
    if (error) sbError(error, 'No se pudo eliminar en Supabase');
  }
}
async function persistMany(list, progress) {
  const mode = settings.mode;
  for (const b of list) { const i = data[mode].findIndex(x => x.id === b.id); if (i >= 0) data[mode][i] = b; else data[mode].push(b); }
  cacheLocal(mode);
  if (useCloud(mode)) {
    for (let k = 0; k < list.length; k += 200) {
      const chunk = list.slice(k, k + 200).map(toRow);
      const { error } = await sb.from('bets').upsert(chunk, { onConflict: 'user_id,id' });
      if (error) { sbError(error); return; }
      if (progress) progress(Math.min(k + 200, list.length), list.length);
    }
  }
}
async function clearMode(mode) {
  data[mode] = []; cacheLocal(mode);
  if (useCloud(mode)) {
    const { error } = await sb.from('bets').delete().eq('user_id', remote.user.id);
    if (error) sbError(error, 'No se pudieron borrar en Supabase');
  }
}
async function fetchAllBets(uid) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data: rows, error } = await sb.from('bets').select('*').eq('user_id', uid).order('bet_date', { ascending: true }).range(from, from + 999);
    if (error) throw error;
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
let _sessionSeq = 0;
async function onSession(session) {
  const seq = ++_sessionSeq;
  if (remote.channel) { sb.removeChannel(remote.channel); remote.channel = null; }
  remote.user = session ? session.user : null;
  remote.on = false;
  if (!remote.user) { data.real = []; remote.checked = true; render(); return; }
  authMode = 'login';
  const uid = remote.user.id;
  data.real = (lsGet(cacheKey(uid), []) || []).map(normalizeBet).filter(Boolean);
  remote.checked = true; remote.loading = true;
  if (location.hash.startsWith('#/login')) location.hash = '#/dashboard'; else render();
  try {
    const { data: st, error: e1 } = await sb.from('user_settings').select('currency').eq('user_id', uid).maybeSingle();
    if (e1) throw e1;
    if (st && ['MXN', 'USD'].includes(st.currency)) settings.currency = st.currency;
    else await sb.from('user_settings').upsert({ user_id: uid, currency: settings.currency });
    lsSet(LS.settings, settings);
    const rows = await fetchAllBets(uid);
    if (seq !== _sessionSeq) return;
    data.real = rows.map(fromRow).filter(Boolean);
    remote.on = true; remote.loading = false;
    cacheLocal('real');
    // Apuestas que estaban solo en este navegador (antes de usar Supabase)
    const localOnly = (lsGet(LS.real, []) || []).map(normalizeBet).filter(Boolean);
    if (localOnly.length) {
      const have = new Set(data.real.map(b => b.id));
      const fps = new Set(data.real.map(fingerprint));
      const toUpload = localOnly.filter(b => !have.has(b.id) && !fps.has(fingerprint(b)));
      if (toUpload.length && await confirmModal({ title: 'Subir apuestas a Supabase', body: `Encontré ${toUpload.length} apuesta${toUpload.length === 1 ? '' : 's'} guardada${toUpload.length === 1 ? '' : 's'} solo en este navegador. ¿Quieres subirlas a tu cuenta?`, confirmText: 'Subir a mi cuenta' })) {
        const prevMode = settings.mode; settings.mode = 'real';
        await persistMany(toUpload); settings.mode = prevMode;
        toast(toUpload.length + ' apuestas subidas a Supabase');
      }
      if (!toUpload.length || remote.on) lsSet(LS.real, []);
    }
    remote.channel = sb.channel('bets-' + uid)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bets', filter: 'user_id=eq.' + uid }, payload => {
        if (payload.eventType === 'DELETE') {
          const id = payload.old && payload.old.id; if (!id) return;
          data.real = data.real.filter(b => b.id !== id);
        } else {
          const b = fromRow(payload.new); if (!b) return;
          const i = data.real.findIndex(x => x.id === b.id);
          if (i >= 0) data.real[i] = b; else data.real.push(b);
        }
        cacheLocal('real');
        if (settings.mode === 'real') softRender();
      })
      .subscribe();
    softRender(true);
  } catch (e) {
    remote.loading = false;
    sbError(e, 'No se pudieron cargar tus apuestas de Supabase');
    softRender(true);
  }
}
async function initRemote() {
  if (!sb) { remote.checked = true; if (route().name === 'config') render(); return; }
  const { data: { session } } = await sb.auth.getSession();
  await onSession(session);
  sb.auth.onAuthStateChange((event, session) => {
    // No llamar a Supabase directamente dentro de este callback.
    if (event === 'PASSWORD_RECOVERY') { setTimeout(openRecovery, 0); return; }
    if (event === 'SIGNED_IN' && session && (!remote.user || remote.user.id !== session.user.id)) setTimeout(() => onSession(session), 0);
    if (event === 'SIGNED_OUT') setTimeout(() => onSession(null), 0);
  });
}

/* ---------------- Inicio de sesión ---------------- */
let authMode = 'login';
function viewAuth() {
  document.body.classList.add('auth-mode');
  const v = $('#view');
  if (!remote.checked) { v.innerHTML = '<div class="auth"><p class="view-sub">Conectando…</p></div>'; return; }
  const signup = authMode === 'signup';
  v.innerHTML = `<div class="auth"><div class="panel auth-card">
    <div class="brand" style="padding:0;margin-bottom:18px"><span class="brand-mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16l5-5 4 4 7-8"/><path d="M15 7h5v5"/></svg></span>Mis Apuestas</div>
    <h1 class="view-title">${signup ? 'Crea tu cuenta' : 'Inicia sesión'}</h1>
    <p class="view-sub">${signup ? 'Tus apuestas se guardarán en tu base de datos de Supabase y las verás en todos tus dispositivos.' : 'Entra para ver tus apuestas desde cualquier dispositivo.'}</p>
    <form id="authForm" novalidate>
      <label class="field"><span>Correo</span><input type="email" name="email" autocomplete="email" required placeholder="tu@correo.com"></label>
      <label class="field"><span>Contraseña</span><input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required placeholder="Mínimo 6 caracteres"></label>
      <p class="err" id="authErr" role="alert"></p>
      <p class="scan-msg ok hidden" id="authOk" role="status"></p>
      <button type="submit" class="btn primary" style="width:100%;min-height:48px;margin-top:6px">${signup ? 'Crear cuenta' : 'Entrar'}</button>
    </form>
    <div class="auth-links">
      <button type="button" class="link-btn" id="authSwitch">${signup ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Crea una'}</button>
      ${signup ? '' : '<button type="button" class="link-btn" id="authForgot">Olvidé mi contraseña</button>'}
    </div>
  </div></div>`;
  const f = $('#authForm'), err = $('#authErr'), ok = $('#authOk');
  $('#authSwitch').onclick = () => { authMode = signup ? 'login' : 'signup'; viewAuth(); };
  $('#authForgot')?.addEventListener('click', async () => {
    const email = f.elements.email.value.trim();
    if (!email) { err.textContent = 'Escribe tu correo y vuelve a tocar "Olvidé mi contraseña".'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    err.textContent = error ? error.message : '';
    if (!error) { ok.textContent = 'Te mandé un correo para restablecer tu contraseña.'; ok.classList.remove('hidden'); }
  });
  f.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = ''; ok.classList.add('hidden');
    const email = f.elements.email.value.trim(), password = f.elements.password.value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = 'Escribe un correo válido.'; return; }
    if (password.length < 6) { err.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      if (signup) {
        const { data: d, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (!d.session) { ok.textContent = 'Cuenta creada. Revisa tu correo y confirma tu cuenta para poder entrar.'; ok.classList.remove('hidden'); authMode = 'login'; }
        else await onSession(d.session);
      } else {
        const { data: d, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await onSession(d.session);
      }
    } catch (e2) {
      const m = String(e2.message || e2);
      err.textContent = /Invalid login/i.test(m) ? 'Correo o contraseña incorrectos.' : /not confirmed/i.test(m) ? 'Primero confirma tu cuenta con el enlace que llegó a tu correo.' : /already registered/i.test(m) ? 'Ese correo ya tiene cuenta. Inicia sesión.' : m;
    } finally { btn.disabled = false; }
  });
}
function openRecovery() {
  openModal(`<h2 id="modalTitle">Nueva contraseña</h2><p class="sub">Escribe tu nueva contraseña.</p>
    <label class="field"><span>Contraseña</span><input type="password" id="newPw" minlength="6" autocomplete="new-password"></label><p class="err" id="pwErr"></p>
    <div class="modal-actions"><button class="btn primary" id="pwSave">Guardar contraseña</button></div>`);
  $('#pwSave').onclick = async () => {
    const pw = $('#newPw').value;
    if (pw.length < 6) { $('#pwErr').textContent = 'Mínimo 6 caracteres.'; return; }
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) { $('#pwErr').textContent = error.message; return; }
    closeModal(); toast('Contraseña actualizada');
  };
}

/* =========================================================
   Formato
   ========================================================= */
let _nf = null, _nfCur = null;
function moneyNF() {
  if (_nfCur !== settings.currency) {
    _nf = new Intl.NumberFormat('es-MX', { style: 'currency', currency: settings.currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    _nfCur = settings.currency;
  }
  return _nf;
}
function fmtMoney(c, opts = {}) {
  if (c === null || c === undefined || Number.isNaN(c)) return '—';
  const s = moneyNF().format(Math.abs(c) / 100);
  if (c < 0) return '−' + s;
  if (opts.sign && c > 0) return '+' + s;
  return s;
}
function fmtPct(v) { return v === null ? 'Sin datos' : v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%'; }
function fmtOdds(b) { return b.oddsFormat === 'american' ? (b.odds > 0 ? '+' : '') + b.odds : Number(b.odds).toFixed(2); }
function signClass(c) { return c > 0 ? 'gain' : c < 0 ? 'loss' : 'neutral'; }
function netHTML(c) {
  if (c === null) return '<span class="money neutral">—<small>Sin liquidar</small></span>';
  if (c > 0) return `<span class="money gain num">▲ ${fmtMoney(c, { sign: true })}<small>Ganancia</small></span>`;
  if (c < 0) return `<span class="money loss num">▼ ${fmtMoney(c)}<small>Pérdida</small></span>`;
  return `<span class="money neutral num">${fmtMoney(0)}<small>Sin ganancia ni pérdida</small></span>`;
}
function chipHTML(status, asButton, id) {
  const label = STATUS_LABEL[status] || status;
  return asButton
    ? `<button type="button" class="chip ${status}" data-act="status" data-id="${esc(id)}" title="Cambiar estado">${label}</button>`
    : `<span class="chip ${status}">${label}</span>`;
}
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

/* =========================================================
   Filtros
   ========================================================= */
let filters = { period: 'all', from: '', to: '', sport: '', league: '', book: '', type: '', status: '', q: '' };
let filtersOpen = false;
const PERIODS = [['all', 'Todo'], ['7d', 'Últimos 7 días'], ['30d', 'Últimos 30 días'], ['month', 'Este mes'], ['prevmonth', 'Mes pasado'], ['year', 'Este año'], ['custom', 'Personalizado']];

function periodRange() {
  const t = todayISO();
  switch (filters.period) {
    case '7d': return { from: addDays(t, -6), to: t };
    case '30d': return { from: addDays(t, -29), to: t };
    case 'month': return { from: t.slice(0, 8) + '01', to: t };
    case 'prevmonth': { const d = isoToDate(t); return { from: dateToISO(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: dateToISO(new Date(d.getFullYear(), d.getMonth(), 0)) }; }
    case 'year': return { from: t.slice(0, 4) + '-01-01', to: t };
    case 'custom': return { from: filters.from || null, to: filters.to || null };
    default: return { from: null, to: null };
  }
}
function inRange(d, r) { return !!d && (!r.from || d >= r.from) && (!r.to || d <= r.to); }
function matchBase(b) {
  return (!filters.sport || b.sport === filters.sport) && (!filters.league || b.league === filters.league) &&
    (!filters.book || b.book === filters.book) && (!filters.type || b.type === filters.type) && (!filters.status || b.status === filters.status);
}
function applyFilters(list) {
  const r = periodRange();
  const base = list.filter(matchBase);
  return {
    staked: base.filter(b => inRange(b.date, r)),
    realized: base.filter(b => b.status !== 'pendiente' && inRange(b.settledDate || b.date, r)),
    base, range: r,
  };
}
function uniq(list, key) { return [...new Set(list.map(b => b[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')); }
function activeFilterCount() { return ['sport', 'league', 'book', 'type', 'status'].filter(k => filters[k]).length + (filters.period !== 'all' ? 1 : 0); }

function filterBarHTML(forHistory) {
  const list = bets();
  const opt = (arr, v) => arr.map(x => `<option value="${esc(x)}"${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('');
  const n = ['sport', 'league', 'book', 'type', 'status'].filter(k => filters[k]).length;
  return `<div class="filters${filtersOpen ? ' open' : ''}" id="filters">
    <div class="filter-top">
      ${forHistory ? `<label class="search"><span class="vh">Buscar</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="search" id="fq" value="${esc(filters.q)}" placeholder="Buscar equipo, selección o nota…"></label>` : ''}
      <div class="period-chips" role="group" aria-label="Periodo">${PERIODS.map(([v, l]) => `<button type="button" data-period="${v}" aria-pressed="${v === filters.period}">${l}</button>`).join('')}</div>
      <button type="button" class="btn sm filters-toggle" id="filtersToggle" aria-expanded="${filtersOpen}">${n ? '<span class="dot"></span>' : ''}Filtros${n ? ' (' + n + ')' : ''}</button>
    </div>
    ${filters.period === 'custom' ? `<div class="custom-range"><label>Desde<input type="date" data-f="from" value="${esc(filters.from)}"></label><label>Hasta<input type="date" data-f="to" value="${esc(filters.to)}"></label></div>` : ''}
    <div class="filters-grid">
      <label>Deporte<select data-f="sport"><option value="">Todos</option>${opt(uniq(list, 'sport'), filters.sport)}</select></label>
      <label>Liga<select data-f="league"><option value="">Todas</option>${opt(uniq(list.filter(b => !filters.sport || b.sport === filters.sport), 'league'), filters.league)}</select></label>
      <label>Casa de apuestas<select data-f="book"><option value="">Todas</option>${opt(uniq(list, 'book'), filters.book)}</select></label>
      <label>Tipo<select data-f="type"><option value="">Todos</option><option value="simple"${filters.type === 'simple' ? ' selected' : ''}>Simple</option><option value="parlay"${filters.type === 'parlay' ? ' selected' : ''}>Parlay</option></select></label>
      <label>Estado<select data-f="status"><option value="">Todos</option>${STATUSES.map(s => `<option value="${s}"${s === filters.status ? ' selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select></label>
      <button type="button" class="btn ghost clear" id="clearFilters"${activeFilterCount() || filters.q ? '' : ' disabled'}>Limpiar filtros</button>
    </div>
    ${filtersOpen || filters.period !== 'all' ? `<p class="filter-note">${forHistory
      ? 'En el historial, el periodo se aplica a la fecha de la apuesta.'
      : 'Resultados por fecha de liquidación; total apostado y pendientes por fecha de la apuesta.'}</p>` : ''}
  </div>`;
}
function bindFilters(onChange) {
  $('#filtersToggle')?.addEventListener('click', () => { filtersOpen = !filtersOpen; onChange(); });
  $$('#filters [data-period]').forEach(b => b.addEventListener('click', () => { filters.period = b.dataset.period; onChange(); }));
  $$('#filters [data-f]').forEach(el => el.addEventListener('change', () => {
    filters[el.dataset.f] = el.value;
    if (el.dataset.f === 'sport') filters.league = '';
    onChange();
  }));
  $('#clearFilters')?.addEventListener('click', () => { filters = { period: 'all', from: '', to: '', sport: '', league: '', book: '', type: '', status: '', q: '' }; onChange(); });
}

/* =========================================================
   Router y vistas
   ========================================================= */
function route() { const h = location.hash.replace(/^#\/?/, ''); const [name, arg] = h.split('/'); return { name: name || 'dashboard', arg: arg ? decodeURIComponent(arg) : '' }; }
function setNav(name) {
  const key = name === 'editar' ? 'nueva' : name;
  $$('[data-nav]').forEach(a => a.toggleAttribute('aria-current', false));
  $$('[data-nav="' + key + '"]').forEach(a => a.setAttribute('aria-current', 'page'));
  $('#curBadge').textContent = settings.currency;
  $('#modeBanner').classList.toggle('hidden', settings.mode !== 'demo');
}
let lastRoute = '';
function render() {
  if (sb && !remote.user) { setNav(''); viewAuth(); return; }
  document.body.classList.remove('auth-mode');
  const r = route();
  setNav(r.name);
  const key = r.name + '/' + r.arg;
  const changed = key !== lastRoute; lastRoute = key;
  switch (r.name) {
    case 'nueva': viewForm(null); break;
    case 'editar': viewForm(r.arg); break;
    case 'historial': viewHistory(); break;
    case 'config': viewConfig(); break;
    default: viewDashboard();
  }
  if (changed) { window.scrollTo(0, 0); }
}
// Re-render tras cambios de datos sin interrumpir un formulario en curso.
function softRender(force) {
  const n = route().name;
  if (n === 'nueva' || n === 'editar') return;
  if ($('#modal').open && !force) return;
  const y = window.scrollY; render(); window.scrollTo(0, y);
}
window.addEventListener('hashchange', render);

function emptyHTML(title, text, extra = '') {
  return `<div class="empty"><h2>${title}</h2><p>${text}</p><div class="actions"><a class="btn primary" href="#/nueva">+ Agregar apuesta</a>${extra}</div></div>`;
}

/* ---------------- Dashboard ---------------- */
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; }
function pendingHTML() {
  const pend = bets().filter(b => b.status === 'pendiente').sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const head = `<div class="sec-head"><h2>Por resolver</h2><span class="count">${pend.length}</span>${pend.length > 6 ? '<a href="#/historial" id="seeAllPend">Ver todas</a>' : ''}</div>`;
  if (!pend.length) return `<section class="pending">${head}<div class="pend-empty">No tienes apuestas pendientes. Cuando registres una sin resultado, aparecerá aquí para marcarla con un toque.</div></section>`;
  return `<section class="pending">${head}<ul class="pend-list">${pend.slice(0, 6).map(b => {
    const o = betOutcome(b);
    return `<li class="pend"><div class="pend-info"><strong>${esc(b.event)}</strong><span class="sel">${esc(b.type === 'parlay' ? b.legs.length + ' selecciones: ' + b.selection : b.selection)}</span>
      <span class="meta">${fmtDateShort(b.date)} · ${esc(b.book)} · ${fmtMoney(b.stakeC)} a ${fmtOdds(b)} · si gana cobras ${fmtMoney(o.potReturnC)}</span></div>
      <div class="pend-acts"><button class="qa win" data-q="ganada" data-id="${esc(b.id)}">✓ Ganó</button><button class="qa lose" data-q="perdida" data-id="${esc(b.id)}">✕ Perdió</button><button class="qa" data-act="status" data-id="${esc(b.id)}" aria-label="Otro resultado: anulada o cash out">Otro</button></div></li>`;
  }).join('')}</ul></section>`;
}
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-q]'); if (!t) return;
  const b = bets().find(x => x.id === t.dataset.id); if (!b) return;
  const prev = { ...b };
  const today = todayISO();
  const nb = { ...b, status: t.dataset.q, cashoutC: null, settledDate: today >= b.date ? today : b.date, updatedAt: new Date().toISOString() };
  await persistBet(nb); softRender(true);
  const o = betOutcome(nb);
  toast(`${STATUS_LABEL[nb.status]}: ${fmtMoney(o.netC, { sign: true })}`, { label: 'Deshacer', fn: async () => { await persistBet(prev); softRender(true); } });
});
document.addEventListener('click', e => { if (e.target.id === 'seeAllPend') { filters = { period: 'all', from: '', to: '', sport: '', league: '', book: '', type: '', status: 'pendiente', q: '' }; } });

const charts = {};
let granularity = 'week';
function viewDashboard() {
  const v = $('#view');
  const list = bets();
  if (!list.length) {
    v.innerHTML = `<h1 class="view-title">Bienvenido</h1><p class="view-sub">Tu balance, ROI y gráficos aparecen aquí en cuanto registres tu primera apuesta.</p>` +
      emptyHTML('Aún no hay apuestas', settings.mode === 'demo' ? 'Carga los datos de demostración desde Configuración para explorar el dashboard.' : 'Registra una apuesta con su monto y momio. Cuando le pongas resultado, el dashboard se calcula solo.',
        settings.mode === 'real' ? '<button class="btn" id="tryDemo">Ver con datos de demostración</button>' : '<a class="btn" href="#/config">Ir a Configuración</a>');
    $('#tryDemo')?.addEventListener('click', () => switchMode('demo'));
    destroyCharts();
    return;
  }
  const { staked, realized } = applyFilters(list);
  const m = computeMetrics(staked, realized);
  const bal = m.settledCount ? m.balanceC : null;
  v.innerHTML = `
    <div class="view-head"><div class="grow"><h1 class="view-title">${greeting()}</h1>
      <p class="view-sub">${filters.period === 'all' ? 'Todo tu historial' : 'Periodo: ' + PERIODS.find(p => p[0] === filters.period)[1].toLowerCase()} · ${staked.length} apuesta${staked.length === 1 ? '' : 's'} registrada${staked.length === 1 ? '' : 's'}, ${m.settledCount} liquidada${m.settledCount === 1 ? '' : 's'}.</p></div></div>
    ${filterBarHTML(false)}
    <section class="slip" aria-label="Resumen">
      <div class="slip-main">
        <p class="slip-label">Balance neto</p>
        <p class="slip-balance ${bal === null ? 'zero' : bal > 0 ? 'gain' : bal < 0 ? 'loss' : 'zero'}">${bal === null ? 'Sin datos' : (bal > 0 ? '▲ ' : bal < 0 ? '▼ ' : '') + fmtMoney(bal, { sign: true })}</p>
        <p class="slip-explain">Ganancias netas menos pérdidas netas de las apuestas liquidadas en el periodo. ${bal === null ? 'Aún no hay apuestas liquidadas.' : bal > 0 ? 'Vas en positivo.' : bal < 0 ? 'Vas en negativo.' : 'Estás en cero.'}</p>
      </div>
      <div class="slip-side">
        <div class="slip-stat"><p class="k">ROI</p><p class="v ${m.roi === null ? '' : m.roi > 0 ? 'gain' : m.roi < 0 ? 'loss' : ''}">${m.roi === null ? 'Sin datos' : (m.roi > 0 ? '+' : '') + fmtPct(m.roi)}</p><p class="e">Resultado neto ÷ monto apostado, en liquidadas sin contar anuladas.</p></div>
        <div class="slip-stat"><p class="k">% de aciertos</p><p class="v">${fmtPct(m.hitRate)}</p><p class="e">Ganadas ÷ (ganadas + perdidas).</p></div>
        <div class="slip-stat"><p class="k">Total apostado</p><p class="v">${fmtMoney(m.totalStakeC)}</p><p class="e">Suma de montos según la fecha de la apuesta.</p></div>
        <div class="slip-stat"><p class="k">En apuestas pendientes</p><p class="v">${fmtMoney(m.pendingC)}</p><p class="e">Dinero que todavía no tiene resultado.</p></div>
      </div>
    </section>
    ${pendingHTML()}
    <div class="sec-head"><h2>Resumen del periodo</h2></div>
    <section class="cards" aria-label="Indicadores">
      <div class="card"><p class="k">Total retornado</p><p class="v">${m.settledCount ? fmtMoney(m.returnedC) : 'Sin datos'}</p><p class="e">Dinero recibido de apuestas liquidadas, incluido lo apostado.</p></div>
      <div class="card"><p class="k">Ganancias netas</p><p class="v gain">${m.settledCount ? '▲ ' + fmtMoney(m.gainsC) : 'Sin datos'}</p><p class="e">Suma de resultados positivos (ganadas y cash out con ganancia).</p></div>
      <div class="card"><p class="k">Pérdidas netas</p><p class="v loss">${m.settledCount ? '▼ ' + fmtMoney(m.lossesC) : 'Sin datos'}</p><p class="e">Suma de resultados negativos, mostrada como importe positivo.</p></div>
      <div class="card"><p class="k">Apuestas liquidadas</p><p class="v">${m.settledCount}</p><p class="e">Con resultado capturado: ganada, perdida, anulada o cash out.</p></div>
      <div class="card"><p class="k">Ganancia media por apuesta</p><p class="v ${m.roiStakeC ? signClass(m.roiNetC) : ''}">${m.roiStakeC ? fmtMoney(Math.round(m.roiNetC / (m.settledCount - m.counts.anulada)), { sign: true }) : 'Sin datos'}</p><p class="e">Resultado neto ÷ apuestas liquidadas no anuladas.</p></div>
    </section>
    <div class="status-row" aria-label="Apuestas por estado">
      ${STATUSES.map(s => `<span class="status-count">${chipHTML(s)}<b class="num">${m.counts[s]}</b></span>`).join('')}
    </div>
    <div class="sec-head"><h2>Gráficos</h2></div>
    <section class="charts" aria-label="Gráficos">
      <div class="chart-card wide"><div class="chart-head"><h3>Ganancia o pérdida neta acumulada</h3><span class="crit">Por fecha de liquidación</span></div><div class="chart-box tall"><canvas id="chCum" aria-label="Resultado neto acumulado"></canvas></div></div>
      <div class="chart-card wide"><div class="chart-head"><h3>Resultado neto por periodo</h3><span class="crit">Resultado: fecha de liquidación · Apostado: fecha de la apuesta</span>
        <div class="seg sm" role="group" aria-label="Agrupar por">${[['day', 'Día'], ['week', 'Semana'], ['month', 'Mes']].map(([k, l]) => `<button type="button" data-gran="${k}" aria-pressed="${granularity === k}">${l}</button>`).join('')}</div></div>
        <div class="chart-box"><canvas id="chPeriod" aria-label="Resultado neto por periodo"></canvas></div></div>
      <div class="chart-card third half-md"><div class="chart-head"><h3>Por deporte</h3><span class="crit">Resultado neto, fecha de liquidación</span></div><div class="chart-box"><canvas id="chSport"></canvas></div></div>
      <div class="chart-card third half-md"><div class="chart-head"><h3>Por casa de apuestas</h3><span class="crit">Resultado neto, fecha de liquidación</span></div><div class="chart-box"><canvas id="chBook"></canvas></div></div>
      <div class="chart-card third"><div class="chart-head"><h3>Distribución de estados</h3><span class="crit">Número de apuestas</span></div><div class="chart-box"><canvas id="chStatus"></canvas></div></div>
    </section>`;
  bindFilters(() => { const y = scrollY; render(); scrollTo(0, y); });
  $$('[data-gran]').forEach(b => b.addEventListener('click', () => { granularity = b.dataset.gran; $$('[data-gran]').forEach(x => x.setAttribute('aria-pressed', x === b)); drawPeriodChart(staked, realized); }));
  drawCharts(staked, realized, m);
}

function destroyCharts() { for (const k in charts) { charts[k].destroy(); delete charts[k]; } }
function emptyChart(id, text) {
  const c = document.getElementById(id); if (!c) return;
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  c.parentElement.innerHTML = `<div class="chart-empty">${text}</div>`;
}
function mkChart(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!window.Chart) { el.parentElement.innerHTML = '<div class="chart-empty">No se pudieron cargar los gráficos. Revisa tu conexión y recarga la página.</div>'; return; }
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(el, cfg);
}
const moneyTick = v => fmtMoney(Math.round(v * 100));
function baseOpts(extra = {}) {
  return Object.assign({
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#E7EDF4', titleColor: '#0E1621', bodyColor: '#0E1621', padding: 10, displayColors: true } },
  }, extra);
}
function drawCharts(staked, realized, m) {
  if (window.Chart) {
    Chart.defaults.color = cssVar('--muted');
    Chart.defaults.font.family = cssVar('--font-body');
    Chart.defaults.borderColor = cssVar('--line-soft');
  }
  const gain = cssVar('--gain'), loss = cssVar('--loss');
  const byDate = (a, b) => (a.settledDate || a.date).localeCompare(b.settledDate || b.date) || a.createdAt.localeCompare(b.createdAt);

  // Acumulado
  if (!realized.length) emptyChart('chCum', 'Sin datos: aún no hay apuestas liquidadas en este periodo.');
  else {
    const days = new Map();
    [...realized].sort(byDate).forEach(b => { const d = b.settledDate || b.date; days.set(d, (days.get(d) || 0) + betOutcome(b).netC); });
    let acc = 0; const labels = [], vals = [];
    for (const [d, v] of days) { acc += v; labels.push(fmtDateShort(d)); vals.push(acc / 100); }
    mkChart('chCum', {
      type: 'line',
      data: { labels, datasets: [{ label: 'Acumulado', data: vals, borderWidth: 2.5, pointRadius: vals.length > 40 ? 0 : 2.5, tension: .25,
        segment: { borderColor: c => c.p1.parsed.y >= 0 ? gain : loss }, pointBackgroundColor: vals.map(v => v >= 0 ? gain : loss), borderColor: gain }] },
      options: baseOpts({
        scales: { y: { ticks: { callback: moneyTick }, grid: { color: c => c.tick.value === 0 ? cssVar('--line') : cssVar('--line-soft') } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 14 } } },
        plugins: { legend: { display: false }, tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: c => 'Acumulado: ' + fmtMoney(Math.round(c.parsed.y * 100), { sign: true }) } } },
      }),
    });
  }
  drawPeriodChart(staked, realized);

  const groupNet = key => { const g = new Map(); realized.forEach(b => { const k = b[key] || 'Sin dato'; g.set(k, (g.get(k) || 0) + betOutcome(b).netC); }); return [...g.entries()].sort((a, b) => b[1] - a[1]); };
  const hbar = (id, entries, what) => {
    if (!entries.length) return emptyChart(id, 'Sin datos: aún no hay apuestas liquidadas en este periodo.');
    mkChart(id, {
      type: 'bar',
      data: { labels: entries.map(e => e[0]), datasets: [{ label: 'Resultado neto', data: entries.map(e => e[1] / 100), backgroundColor: entries.map(e => e[1] >= 0 ? gain : loss), borderRadius: 4, maxBarThickness: 26 }] },
      options: baseOpts({ indexAxis: 'y', scales: { x: { ticks: { callback: moneyTick, maxTicksLimit: 5 } }, y: { grid: { display: false } } },
        plugins: { legend: { display: false }, tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: c => (c.parsed.x >= 0 ? 'Ganancia: ' : 'Pérdida: ') + fmtMoney(Math.round(c.parsed.x * 100), { sign: true }) } } } }),
    });
  };
  hbar('chSport', groupNet('sport'));
  hbar('chBook', groupNet('book'));

  const counts = STATUSES.map(s => m.counts[s]);
  if (!counts.some(Boolean)) emptyChart('chStatus', 'Sin datos en este periodo.');
  else mkChart('chStatus', {
    type: 'doughnut',
    data: { labels: STATUSES.map(s => STATUS_LABEL[s] + ' (' + m.counts[s] + ')'), datasets: [{ data: counts, backgroundColor: [cssVar('--neutral'), gain, loss, '#55657A', cssVar('--cash')], borderColor: cssVar('--surface'), borderWidth: 2 }] },
    options: baseOpts({ cutout: '62%', plugins: { legend: { display: true, position: 'right', labels: { boxWidth: 10, boxHeight: 10, padding: 10 } }, tooltip: baseOpts().plugins.tooltip } }),
  });
}
function periodKey(iso) { return granularity === 'day' ? iso : granularity === 'week' ? weekStart(iso) : iso.slice(0, 7); }
function periodLabel(k) {
  if (granularity === 'month') return isoToDate(k + '-01').toLocaleDateString('es-MX', { month: 'short', year: 'numeric' });
  return (granularity === 'week' ? 'Sem. ' : '') + fmtDateShort(k);
}
function drawPeriodChart(staked, realized) {
  if (!staked.length && !realized.length) return emptyChart('chPeriod', 'Sin datos en este periodo.');
  const net = new Map(), stk = new Map();
  realized.forEach(b => { const k = periodKey(b.settledDate || b.date); net.set(k, (net.get(k) || 0) + betOutcome(b).netC); });
  staked.forEach(b => { const k = periodKey(b.date); stk.set(k, (stk.get(k) || 0) + b.stakeC); });
  const keys = [...new Set([...net.keys(), ...stk.keys()])].sort();
  const gain = cssVar('--gain'), loss = cssVar('--loss');
  const nv = keys.map(k => (net.get(k) || 0) / 100);
  mkChart('chPeriod', {
    type: 'bar',
    data: { labels: keys.map(periodLabel), datasets: [
      { label: 'Resultado neto (fecha de liquidación)', data: nv, backgroundColor: nv.map(v => v >= 0 ? gain : loss), borderRadius: 3, maxBarThickness: 30 },
      { label: 'Apostado (fecha de la apuesta)', data: keys.map(k => (stk.get(k) || 0) / 100), backgroundColor: 'rgba(154,168,187,.28)', borderRadius: 3, maxBarThickness: 30 },
    ] },
    options: baseOpts({
      scales: { y: { ticks: { callback: moneyTick } }, x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 10 } } },
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
        tooltip: { ...baseOpts().plugins.tooltip, callbacks: { label: c => c.datasetIndex === 0 ? (c.parsed.y >= 0 ? 'Ganancia neta: ' : 'Pérdida neta: ') + fmtMoney(Math.round(c.parsed.y * 100), { sign: true }) : 'Apostado: ' + fmtMoney(Math.round(c.parsed.y * 100)) } } },
    }),
  });
}

/* ---------------- Historial ---------------- */
let sort = { key: 'date', dir: 'desc' };
const SORTERS = {
  date: b => b.date + b.createdAt, event: b => norm(b.event), selection: b => norm(b.selection), stake: b => b.stakeC,
  odds: b => b.oddsFormat === 'decimal' ? b.odds : (b.odds > 0 ? 1 + b.odds / 100 : 1 + 100 / Math.abs(b.odds)),
  status: b => STATUSES.indexOf(b.status), ret: b => { const o = betOutcome(b); return o.returnC ?? -Infinity; }, net: b => { const o = betOutcome(b); return o.netC ?? -Infinity; },
};
function historyRows() {
  const r = periodRange(); const q = norm(filters.q);
  let rows = bets().filter(b => matchBase(b) && inRange(b.date, r));
  if (q) rows = rows.filter(b => norm([b.event, b.selection, b.sport, b.league, b.book, b.notes, ...b.legs.map(l => l.event + ' ' + l.selection)].join(' ')).includes(q));
  const f = SORTERS[sort.key];
  rows.sort((a, b) => { const x = f(a), y = f(b); const c = x < y ? -1 : x > y ? 1 : 0; return sort.dir === 'asc' ? c : -c; });
  return rows;
}
function viewHistory() {
  const v = $('#view');
  const list = bets();
  const head = `<div class="view-head"><div class="grow"><h1 class="view-title">Historial</h1><p class="view-sub">Toca el estado de una apuesta para cambiarlo; el retorno y el resultado se recalculan solos.</p></div>
    <div class="btn-row"><button class="btn" id="expBtn"${list.length ? '' : ' disabled'}>Exportar CSV</button><button class="btn" id="impBtn">Importar CSV</button></div></div>`;
  if (!list.length) { v.innerHTML = head + emptyHTML('Tu historial está vacío', 'Agrega tu primera apuesta o importa un CSV exportado antes desde esta app.'); bindIO(); return; }
  const th = (k, l, r) => `<th class="${r ? 'r' : ''}" aria-sort="${sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}">${l}${sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>`;
  v.innerHTML = head + filterBarHTML(true) + `
    <div class="table-wrap"><table class="hist">
      <thead><tr>${th('date', 'Fecha')}${th('event', 'Evento')}${th('selection', 'Selección')}${th('stake', 'Monto', 1)}${th('odds', 'Momio', 1)}${th('status', 'Estado')}${th('ret', 'Retorno', 1)}${th('net', 'Resultado neto', 1)}<th class="r"><span class="hidden">Acciones</span></th></tr></thead>
      <tbody id="histBody"></tbody></table></div>
    <div class="hist-foot" id="histFoot"></div>`;
  bindFilters(() => render());
  $('#fq').addEventListener('input', e => { filters.q = e.target.value; fillHistory(); $('#clearFilters').disabled = !(activeFilterCount() || filters.q); });
  $$('[data-sort]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.sort; sort = { key: k, dir: sort.key === k && sort.dir === 'desc' ? 'asc' : 'desc' }; render(); }));
  bindIO();
  fillHistory();
}
function fillHistory() {
  const rows = historyRows();
  const body = $('#histBody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="full" style="text-align:center;padding:28px;color:var(--muted)">Ninguna apuesta coincide con la búsqueda o los filtros. Prueba con “Limpiar filtros”.</td></tr>`;
  } else body.innerHTML = rows.map(b => {
    const o = betOutcome(b);
    const sel = b.type === 'parlay'
      ? `<span class="chip pendiente" style="margin-bottom:3px">Parlay · ${b.legs.length}</span><br><button type="button" class="link-btn" data-act="detail" data-id="${esc(b.id)}">Ver selecciones</button>`
      : esc(b.selection);
    return `<tr>
      <td data-l="Fecha" class="num">${fmtDate(b.date)}${b.settledDate && b.settledDate !== b.date ? `<div class="meta">Liquidada ${fmtDateShort(b.settledDate)}</div>` : ''}</td>
      <td data-l="Evento" class="full"><div class="ev">${esc(b.event)}</div><div class="meta">${esc([b.sport, b.league].filter(Boolean).join(' / '))} · ${esc(b.book)}</div></td>
      <td data-l="Selección" class="sel full">${sel}</td>
      <td data-l="Monto" class="r num">${fmtMoney(b.stakeC)}</td>
      <td data-l="Momio" class="r num">${fmtOdds(b)}</td>
      <td data-l="Estado">${chipHTML(b.status, true, b.id)}</td>
      <td data-l="Retorno" class="r num">${o.settled ? fmtMoney(o.returnC) : `<span class="money neutral">${fmtMoney(o.potReturnC)}<small>Potencial</small></span>`}</td>
      <td data-l="Resultado neto" class="r">${netHTML(o.netC)}</td>
      <td class="acts full"><button class="icon-btn" data-act="detail" data-id="${esc(b.id)}">Detalle</button><a class="icon-btn" href="#/editar/${encodeURIComponent(b.id)}" style="text-decoration:none">Editar</a><button class="icon-btn del" data-act="delete" data-id="${esc(b.id)}">Eliminar</button></td>
    </tr>`;
  }).join('');
  let net = 0, stake = 0; rows.forEach(b => { stake += b.stakeC; const o = betOutcome(b); if (o.netC !== null) net += o.netC; });
  $('#histFoot').innerHTML = `<span>${rows.length} de ${bets().length} apuestas</span><span class="num">Apostado: ${fmtMoney(stake)} · Resultado neto: <span class="money ${signClass(net)}">${fmtMoney(net, { sign: true })}</span></span>`;
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const b = bets().find(x => x.id === t.dataset.id); if (!b) return;
  if (t.dataset.act === 'status') openStatusModal(b);
  if (t.dataset.act === 'detail') openDetailModal(b);
  if (t.dataset.act === 'delete') confirmDelete(b);
});

/* ---------------- Modales ---------------- */
const modal = $('#modal');
function openModal(html) { $('#modalBody').innerHTML = html; if (!modal.open) modal.showModal(); }
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
modal.addEventListener('close', () => { $('#modalBody').innerHTML = ''; });
function confirmModal({ title, body, confirmText, danger }) {
  return new Promise(res => {
    openModal(`<h2 id="modalTitle">${title}</h2><p class="sub">${body}</p><div class="modal-actions"><button class="btn ghost" id="mNo">Cancelar</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="mYes">${confirmText}</button></div>`);
    let done = false; const fin = v => { if (done) return; done = true; closeModal(); res(v); };
    $('#mNo').onclick = () => fin(false); $('#mYes').onclick = () => fin(true);
    modal.addEventListener('close', () => fin(false), { once: true });
  });
}
async function confirmDelete(b) {
  const ok = await confirmModal({ title: 'Eliminar apuesta', body: `Se eliminará “${esc(b.event)}” de ${fmtMoney(b.stakeC)} del ${fmtDate(b.date)}. Esta acción no se puede deshacer.`, confirmText: 'Eliminar apuesta', danger: true });
  if (!ok) return;
  await removeBet(b.id); toast('Apuesta eliminada'); softRender(true);
}
function openDetailModal(b) {
  const o = betOutcome(b);
  openModal(`<h2 id="modalTitle">${esc(b.event)}</h2><p class="sub">${esc([b.sport, b.league].filter(Boolean).join(' / '))} · ${esc(b.book)} · ${b.type === 'parlay' ? 'Parlay' : 'Simple'}</p>
    <dl class="dl">
      <dt>Estado</dt><dd>${chipHTML(b.status)}</dd>
      <dt>Fecha de la apuesta</dt><dd>${fmtDate(b.date)}</dd>
      ${b.settledDate ? `<dt>Fecha de liquidación</dt><dd>${fmtDate(b.settledDate)}</dd>` : ''}
      ${b.type === 'simple' ? `<dt>Selección</dt><dd>${esc(b.selection)}</dd>` : ''}
      <dt>Monto</dt><dd class="num">${fmtMoney(b.stakeC)}</dd>
      <dt>Momio${b.type === 'parlay' ? ' combinado' : ''}</dt><dd class="num">${fmtOdds(b)} (${b.oddsFormat === 'american' ? 'americano' : 'decimal'})</dd>
      <dt>Ganancia potencial</dt><dd class="num">${fmtMoney(o.potProfitC)}</dd>
      <dt>Retorno potencial</dt><dd class="num">${fmtMoney(o.potReturnC)}</dd>
      ${b.status === 'cashout' ? `<dt>Cash out recibido</dt><dd class="num">${fmtMoney(b.cashoutC)}</dd>` : ''}
      <dt>Retorno total</dt><dd class="num">${o.settled ? fmtMoney(o.returnC) : 'Sin liquidar'}</dd>
      <dt>Resultado neto</dt><dd>${netHTML(o.netC)}</dd>
    </dl>
    ${b.type === 'parlay' ? `<ul class="legs-list">${b.legs.map((l, i) => `<li><span class="n">${i + 1}</span><span><strong>${esc(l.selection)}</strong><br><span style="color:var(--muted)">${esc(l.event)}</span></span></li>`).join('')}</ul>` : ''}
    ${b.notes ? `<p class="sub" style="margin-top:14px;white-space:pre-wrap"><strong style="color:var(--text)">Notas:</strong> ${esc(b.notes)}</p>` : ''}
    <div class="modal-actions"><button class="btn ghost" id="mClose">Cerrar</button><a class="btn" href="#/editar/${encodeURIComponent(b.id)}" id="mEdit">Editar</a><button class="btn primary" id="mStatus">Cambiar estado</button></div>`);
  $('#mClose').onclick = closeModal; $('#mEdit').onclick = closeModal; $('#mStatus').onclick = () => openStatusModal(b);
}
function openStatusModal(b) {
  openModal(`<h2 id="modalTitle">Cambiar estado</h2><p class="sub">${esc(b.event)} · ${fmtMoney(b.stakeC)} a ${fmtOdds(b)}</p>
    <div class="status-options" role="radiogroup">${STATUSES.map(s => `<label><input type="radio" name="mst" value="${s}"${s === b.status ? ' checked' : ''}> ${STATUS_LABEL[s]}</label>`).join('')}</div>
    <label class="field" id="mCashF"><span>Importe recibido por cash out</span><input id="mCash" inputmode="decimal" value="${b.cashoutC != null ? (b.cashoutC / 100).toFixed(2) : ''}" placeholder="0.00"><p class="err" id="mCashE"></p></label>
    <label class="field" id="mDateF"><span>Fecha de liquidación</span><input type="date" id="mDate" value="${esc(b.settledDate || todayISO())}"><p class="err" id="mDateE"></p></label>
    <div class="preview" id="mPrev"></div>
    <div class="modal-actions"><button class="btn ghost" id="mNo">Cancelar</button><button class="btn primary" id="mSave">Guardar estado</button></div>`);
  const upd = () => {
    const st = $('input[name="mst"]:checked').value;
    $('#mCashF').classList.toggle('hidden', st !== 'cashout');
    $('#mDateF').classList.toggle('hidden', st === 'pendiente');
    const tmp = { ...b, status: st, cashoutC: parseMoneyToCents($('#mCash').value) };
    const o = betOutcome(tmp);
    $('#mPrev').innerHTML = st === 'pendiente'
      ? `<p class="wait">Pendiente: retorno potencial ${fmtMoney(o.potReturnC)}, ganancia potencial ${fmtMoney(o.potProfitC)}. No cuenta en ganancias ni pérdidas.</p>`
      : (st === 'cashout' && tmp.cashoutC === null) ? '<p class="wait">Escribe el importe del cash out para ver el resultado.</p>'
      : `<div class="preview-grid"><div><p class="k">Retorno total</p><p class="v">${fmtMoney(o.returnC)}</p></div><div><p class="k">Resultado neto</p><p class="v">${netHTML(o.netC)}</p></div></div>`;
  };
  $$('input[name="mst"]').forEach(r => r.addEventListener('change', upd));
  $('#mCash').addEventListener('input', upd);
  upd();
  $('#mNo').onclick = closeModal;
  $('#mSave').onclick = async () => {
    const st = $('input[name="mst"]:checked').value;
    const nb = { ...b, status: st, updatedAt: new Date().toISOString() };
    nb.cashoutC = st === 'cashout' ? parseMoneyToCents($('#mCash').value) : null;
    nb.settledDate = st === 'pendiente' ? '' : $('#mDate').value;
    const errs = validateBet(nb);
    $('#mCashE').textContent = errs.cashout || ''; $('#mDateE').textContent = errs.settledDate || '';
    if (errs.cashout || errs.settledDate) return;
    closeModal();
    await persistBet(nb); toast('Estado actualizado: ' + STATUS_LABEL[st]); softRender(true);
  };
}

/* ---------------- Formulario ---------------- */
function viewForm(editId) {
  const v = $('#view');
  let b = null;
  if (editId) { b = bets().find(x => x.id === editId); if (!b) { toast('No se encontró esa apuesta'); location.hash = '#/historial'; return; } }
  const list = bets();
  const dl = (id, key) => `<datalist id="${id}">${uniq(list, key).map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
  const st = b ? b.status : 'pendiente';
  const type = b ? b.type : 'simple', fmt = b ? b.oddsFormat : 'american';
  const legs = b && b.type === 'parlay' ? b.legs : [{ event: '', selection: '' }, { event: '', selection: '' }];
  v.innerHTML = `<div class="view-head"><div class="grow"><h1 class="view-title">${b ? 'Editar apuesta' : 'Nueva apuesta'}</h1>
    <p class="view-sub">${b ? 'Cualquier cambio recalcula el retorno y el resultado.' : 'Captura el boleto tal como lo hiciste. Puedes dejarla pendiente y ponerle resultado después.'}</p></div></div>
  <div class="form-wrap">
  ${b || !window.claude ? '' : `<section class="scan" id="scanBox" aria-label="Llenar desde captura">
      <img class="scan-thumb hidden" id="scanThumb" alt="Captura del boleto">
      <div class="scan-txt"><strong>Llenar desde una captura</strong><span id="scanHint">Sube, pega o arrastra la captura del boleto y lleno el formulario por ti. Tú revisas antes de guardar.</span></div>
      <label class="btn primary" id="scanBtn" for="scanFile">Subir captura</label>
      <input type="file" id="scanFile" class="vh" accept="image/*">
    </section><div id="scanMsg"></div><div class="or-sep">o llénala a mano</div>`}
  ${dl('dl-sport', 'sport')}${dl('dl-league', 'league')}${dl('dl-book', 'book')}
  <form id="betForm" class="form-wrap" novalidate>
    <div id="errSummary"></div>
      <section class="panel">
        <h2><span class="step">1</span>¿Qué apostaste?</h2>
        <div class="row2">
          <label class="field"><span>Fecha de la apuesta</span><input type="date" name="date" value="${esc(b ? b.date : todayISO())}"><p class="err" data-err="date"></p></label>
          <div class="field"><span>Tipo</span><div class="seg" data-seg="type">${[['simple', 'Simple'], ['parlay', 'Parlay']].map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${type === k}">${l}</button>`).join('')}</div></div>
        </div>
        <div class="field"><span>Liga</span>
          <div class="pick-chips" id="leagueChips"></div>
          <select id="leagueSel" aria-label="Todas las ligas"><option value="">Más ligas…</option>${LEAGUES.map(([sp, ls]) => `<optgroup label="${esc(sp)}">${ls.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join('')}</optgroup>`).join('')}<option value="__otra">Otra liga (escribir)</option></select>
          <p class="err" data-err="sport"></p>
        </div>
        <div class="row2" id="customLeague" hidden>
          <label class="field"><span>Deporte</span><input name="sport" list="dl-sport" autocomplete="off" value="${esc(b?.sport)}" placeholder="Fútbol americano"></label>
          <label class="field"><span>Liga</span><input name="league" list="dl-league" autocomplete="off" value="${esc(b?.league)}" placeholder="NFL"></label>
        </div>
        <div id="gamesBox"></div>
        <div id="simpleFields"${type === 'parlay' ? ' hidden' : ''}>
          <label class="field"><span>Evento o partido</span><input name="event" value="${esc(type === 'simple' ? b?.event : '')}" placeholder="Bengals vs Steelers"><p class="err" data-err="event"></p></label>
          <label class="field"><span>Selección</span><input name="selection" value="${esc(type === 'simple' ? b?.selection : '')}" placeholder="Bengals gana · Más de 250.5 yardas de Joe Burrow"><p class="err" data-err="selection"></p></label>
          <div class="pick-chips" id="selChips"></div>
        </div>
        <div id="parlayFields"${type === 'simple' ? ' hidden' : ''}>
          <label class="field"><span>Nombre del boleto (opcional)</span><input name="parlayName" value="${esc(type === 'parlay' && !/^Parlay de \d+ selecciones$/.test(b?.event || '') ? b?.event : '')}" placeholder="Parlay domingo NFL"></label>
          <p class="field" style="margin-bottom:8px"><span>Selecciones del parlay</span></p>
          <div id="legs"></div>
          <div class="pick-chips" id="legChips"></div>
          <p class="legs-err" data-err="legs"></p>
          <button type="button" class="btn ghost sm" id="addLeg">+ Agregar selección</button>
          <p class="hint" style="color:var(--faint);font-size:12.5px;margin:8px 0 14px">El monto se cuenta una sola vez y se usa el momio combinado del boleto.</p>
        </div>
        <label class="field"><span>Casa de apuestas</span><input name="book" list="dl-book" autocomplete="off" value="${esc(b ? b.book : lastBook())}" placeholder="Caliente"><p class="err" data-err="book"></p></label>
        <div class="pick-chips" id="bookChips"></div>
      </section>
      <section class="panel">
        <h2><span class="step">2</span>¿Cuánto y a qué momio?</h2>
        <label class="field"><span>Monto apostado (${settings.currency})</span><input name="stake" inputmode="decimal" autocomplete="off" value="${b ? (b.stakeC / 100).toFixed(2) : ''}" placeholder="100.00"><p class="err" data-err="stake"></p></label>
        <div class="pick-chips" id="stakeChips"></div>
        <div class="field"><span>Formato del momio</span><div class="seg" data-seg="fmt">${[['american', 'Americano'], ['decimal', 'Decimal']].map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${fmt === k}">${l}</button>`).join('')}</div></div>
        <label class="field"><span id="oddsLabel">Momio</span><div class="odds-wrap"><button type="button" class="btn sign" id="signBtn" title="Cambiar signo (+/−)" aria-label="Cambiar signo">±</button><input name="odds" id="oddsIn" autocomplete="off" value="${b ? (b.oddsFormat === 'american' && b.odds > 0 ? '+' : '') + b.odds : ''}"></div><p class="err" data-err="odds"></p><p class="hint" id="oddsHint"></p></label>
        <div class="preview" id="preview" aria-live="polite"></div>
      </section>
      <section class="panel">
        <h2><span class="step">3</span>¿Ya tiene resultado?</h2>
        <div class="status-pick" role="radiogroup" aria-label="Estado">${STATUSES.map(s => `<label class="s-${s}"><input type="radio" name="status" value="${s}"${s === st ? ' checked' : ''}><span>${STATUS_LABEL[s]}</span></label>`).join('')}</div>
        <label class="field" id="cashF"><span>Importe recibido por cash out</span><input name="cashout" inputmode="decimal" autocomplete="off" value="${b && b.cashoutC != null ? (b.cashoutC / 100).toFixed(2) : ''}" placeholder="0.00"><p class="err" data-err="cashout"></p></label>
        <label class="field" id="settledF"><span>Fecha de liquidación</span><input type="date" name="settledDate" value="${esc(b && b.settledDate ? b.settledDate : todayISO())}"><p class="err" data-err="settledDate"></p><p class="hint">Se usa para ubicar el resultado en los gráficos.</p></label>
        <label class="field"><span>Notas (opcional)</span><textarea name="notes" placeholder="Por qué la tomaste, lesiones, clima…">${esc(b?.notes)}</textarea></label>
      </section>
      <div class="savebar"><div class="sum" id="saveSum"></div><a class="btn ghost" href="${b ? '#/historial' : '#/dashboard'}">Cancelar</a><button type="submit" class="btn primary">${b ? 'Guardar cambios' : 'Guardar'}</button></div>
  </form>
  </div>`;

  const form = $('#betForm');
  const state = { type, fmt };
  const legsEl = $('#legs');
  const renderLegs = arr => {
    legsEl.innerHTML = arr.map((l, i) => `<div class="leg"><span class="n">${i + 1}</span>
      <input class="ev-in" placeholder="Evento" aria-label="Evento ${i + 1}" value="${esc(l.event)}">
      <input class="sel-in" placeholder="Selección" aria-label="Selección ${i + 1}" value="${esc(l.selection)}">
      <button type="button" class="icon-btn del" data-rm="${i}" aria-label="Quitar selección ${i + 1}">Quitar</button></div>`).join('');
  };
  const readLegs = () => $$('.leg', legsEl).map(r => ({ event: $('.ev-in', r).value.trim(), selection: $('.sel-in', r).value.trim() }));
  renderLegs(legs);

  /* ---- Liga, próximos partidos y opciones rápidas ---- */
  const leagueSel = $('#leagueSel');
  const freq = (key, arr = bets()) => { const m = new Map(); arr.forEach(x => { const k = typeof key === 'function' ? key(x) : x[key]; if (k) m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); };
  const topLeagues = [...new Set([...freq('league').filter(l => LEAGUE_SPORT[l]), 'NFL', 'Liga MX', 'Premier League', 'LaLiga', 'NBA', 'MLB'])].slice(0, 7);
  $('#leagueChips').innerHTML = topLeagues.map(l => `<button type="button" data-l="${esc(l)}">${esc(l)}</button>`).join('');
  $('#leagueChips').addEventListener('click', e => { const x = e.target.closest('[data-l]'); if (x) setLeague(x.dataset.l, true); });
  leagueSel.addEventListener('change', () => setLeague(leagueSel.value, true));
  state.gameDays = 7; state.league = ''; state.game = null;

  function setLeague(name, fromUser) {
    state.league = name;
    const cl = $('#customLeague');
    if (LEAGUE_SPORT[name]) {
      form.elements.sport.value = LEAGUE_SPORT[name]; form.elements.league.value = name; cl.hidden = true; leagueSel.value = name;
    } else if (name === '__otra') {
      cl.hidden = false; leagueSel.value = '__otra';
      if (fromUser) { form.elements.sport.value = ''; form.elements.league.value = ''; form.elements.sport.focus(); }
    } else { leagueSel.value = ''; cl.hidden = true; }
    $$('#leagueChips button').forEach(x => x.setAttribute('aria-pressed', x.dataset.l === name));
    state.gameDays = 7; state.game = null;
    renderGames(); upd();
  }

  function renderGames() {
    const box = $('#gamesBox'), lg = state.league;
    if (!lg) { box.innerHTML = '<p class="games-note">Elige una liga para ver sus próximos partidos.</p>'; return; }
    if (lg === '__otra') { box.innerHTML = ''; return; }
    const games = SCHEDULE[lg];
    if (!games) { box.innerHTML = `<p class="games-note">No tengo cargado el calendario de ${esc(lg)}. Escribe el partido abajo.</p>`; return; }
    const from = isISODate(form.elements.date.value) ? form.elements.date.value : todayISO();
    const to = addDays(from, state.gameDays - 1);
    let list = games.filter(g => g[0] >= from && g[0] <= to), note = '';
    if (!list.length) { list = games.filter(g => g[0] >= from).slice(0, 10); if (list.length) note = `No hay partidos del ${fmtDateShort(from)} al ${fmtDateShort(to)}; estos son los siguientes.`; }
    if (!list.length) { box.innerHTML = `<p class="games-note">No tengo partidos de ${esc(lg)} después del ${fmtDate(from)}. Escribe el partido abajo.</p>`; return; }
    state.gameList = list;
    const us = US_STYLE.has(lg);
    const days = [...new Set(list.map(g => g[0]))];
    const dayLbl = d => { const t = isoToDate(d).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' }); return t.charAt(0).toUpperCase() + t.slice(1); };
    const more = games.some(g => g[0] > to);
    box.innerHTML = `<div class="games"><div class="games-head"><strong>Próximos partidos · ${esc(lg)}</strong><span>${state.type === 'parlay' ? 'Toca un partido para agregarlo al parlay' : 'Toca un partido para llenarlo'}</span></div>
      ${note ? `<p class="games-note">${note}</p>` : ''}
      <div class="games-scroll">${days.map(d => `<div class="gday">${dayLbl(d)}</div><div class="glist">${list.map((g, i) => g[0] !== d ? '' : (() => {
        const gm = gameObj(lg, g);
        const time = g[1] ? g[1] + (us ? ' ET' : ' hora local') : '';
        return `<button type="button" class="game" data-gi="${i}" aria-pressed="${state.game && state.game.event === gm.event}"><span class="t">${esc(gm.event)}</span><span class="m">${[time, g[4] ? (us ? 'Semana ' + g[4].replace('S', '') : 'Jornada ' + g[4].replace('J', '')) : ''].filter(Boolean).join(' · ')}</span></button>`;
      })()).join('')}</div>`).join('')}</div>
      <div class="games-foot"><p class="games-src">Calendario cargado el ${fmtDate(SCHEDULE_UPDATED)}${SCHEDULE_NOTE[lg] ? ' · ' + SCHEDULE_NOTE[lg] : ''}.</p>${more ? '<button type="button" class="btn ghost sm" id="moreGames">Ver 7 días más</button>' : ''}</div></div>`;
    $('#moreGames')?.addEventListener('click', () => { state.gameDays += 7; renderGames(); });
    $$('.game', box).forEach(btn => btn.addEventListener('click', () => pickGame(state.gameList[+btn.dataset.gi])));
  }

  function pickGame(g) {
    const gm = gameObj(state.league, g);
    state.game = gm;
    if (state.type === 'simple') {
      form.elements.event.value = gm.event;
      form.elements.selection.value = '';
      state.pickTarget = form.elements.selection;
      renderPicks(gm);
      $('#selChips').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      const a = readLegs();
      let i = a.findIndex(l => !l.event && !l.selection);
      if (i < 0) { a.push({ event: '', selection: '' }); i = a.length - 1; }
      a[i].event = gm.event; renderLegs(a);
      state.pickTarget = $$('.sel-in', legsEl)[i];
      renderPicks(gm, i + 1);
    }
    $$('#gamesBox .game').forEach(x => x.setAttribute('aria-pressed', x.querySelector('.t').textContent === gm.event));
    upd();
  }

  function renderPicks(gm, legNo) {
    const box = state.type === 'simple' ? $('#selChips') : $('#legChips');
    $('#selChips').innerHTML = ''; $('#legChips').innerHTML = '';
    if (!gm) return;
    const opts = quickPicks(gm);
    box.innerHTML = (legNo ? `<span class="games-src" style="align-self:center">Selección ${legNo}:</span>` : '') +
      opts.map(o => `<button type="button" data-pick="${esc(o)}">${esc(o.trim())}${/[\s+−]$/.test(o) ? '…' : ''}</button>`).join('');
  }
  $('#selChips').addEventListener('click', onPick); $('#legChips').addEventListener('click', onPick);
  function onPick(e) {
    const x = e.target.closest('[data-pick]'); if (!x || !state.pickTarget) return;
    const t = state.pickTarget, v = x.dataset.pick;
    t.value = v;
    if (/[\s+−]$/.test(v)) { t.focus(); t.setSelectionRange(v.length, v.length); }
    $$('button', x.parentElement).forEach(b => b.setAttribute('aria-pressed', b === x));
    upd();
  }
  // Opciones rápidas también cuando escribes el partido a mano
  form.elements.event.addEventListener('input', () => { const gm = parseEvent(form.elements.event.value, form.elements.sport.value); state.pickTarget = form.elements.selection; renderPicks(gm); });
  legsEl.addEventListener('focusin', e => {
    const sel = e.target.closest('.sel-in'); if (!sel) return;
    const row = sel.closest('.leg'); const gm = parseEvent($('.ev-in', row).value, form.elements.sport.value);
    state.pickTarget = sel; renderPicks(gm, $$('.leg', legsEl).indexOf(row) + 1);
  });

  // Casa y monto: tus valores más usados
  const books = [...new Set([...freq('book'), ...DEFAULT_BOOKS])].slice(0, 6);
  $('#bookChips').innerHTML = books.map(x => `<button type="button" data-v="${esc(x)}" aria-pressed="${x === form.elements.book.value}">${esc(x)}</button>`).join('');
  $('#bookChips').addEventListener('click', e => { const x = e.target.closest('[data-v]'); if (!x) return; form.elements.book.value = x.dataset.v; $$('#bookChips button').forEach(y => y.setAttribute('aria-pressed', y === x)); upd(); });
  const stakes = [...new Set([...freq(x => String(x.stakeC)).map(Number), 10000, 20000, 50000])].slice(0, 5).sort((a, b) => a - b);
  $('#stakeChips').innerHTML = stakes.map(c => `<button type="button" data-c="${c}">${fmtMoney(c)}</button>`).join('');
  $('#stakeChips').addEventListener('click', e => { const x = e.target.closest('[data-c]'); if (!x) return; form.elements.stake.value = (+x.dataset.c / 100).toFixed(2); upd(); });
  form.elements.date.addEventListener('change', () => { state.gameDays = 7; renderGames(); });
  $('#addLeg').onclick = () => { const a = readLegs(); a.push({ event: '', selection: '' }); renderLegs(a); $$('.ev-in', legsEl).pop().focus(); };
  legsEl.addEventListener('click', e => { const r = e.target.closest('[data-rm]'); if (!r) return; const a = readLegs(); a.splice(+r.dataset.rm, 1); renderLegs(a.length ? a : [{ event: '', selection: '' }]); upd(); });

  $$('[data-seg]').forEach(seg => seg.addEventListener('click', e => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    $$('button', seg).forEach(x => x.setAttribute('aria-pressed', x === btn));
    if (seg.dataset.seg === 'type') { state.type = btn.dataset.v; $('#simpleFields').hidden = state.type !== 'simple'; $('#parlayFields').hidden = state.type !== 'parlay'; renderGames(); renderPicks(null); }
    else state.fmt = btn.dataset.v;
    upd();
  }));
  $('#signBtn').onclick = () => {
    const i = $('#oddsIn'); let s = i.value.trim();
    if (s.startsWith('-') || s.startsWith('−')) s = '+' + s.slice(1); else if (s.startsWith('+')) s = '-' + s.slice(1); else s = '-' + s;
    i.value = s; upd(); i.focus();
  };

  const read = () => {
    const f = new FormData(form);
    const status = f.get('status');
    const legsNow = readLegs().filter(l => l.event || l.selection);
    const isP = state.type === 'parlay';
    const name = String(f.get('parlayName') || '').trim();
    const od = parseOdds(state.fmt, f.get('odds'));
    return {
      id: b ? b.id : newId(),
      date: f.get('date'), sport: String(f.get('sport')).trim(), league: String(f.get('league')).trim(),
      type: state.type,
      event: isP ? (name || 'Parlay de ' + legsNow.length + ' selecciones') : String(f.get('event')).trim(),
      selection: isP ? legsNow.map(l => l.selection).join(' + ') : String(f.get('selection')).trim(),
      legs: isP ? legsNow : [],
      book: String(f.get('book')).trim(),
      stakeC: parseMoneyToCents(f.get('stake')),
      oddsFormat: state.fmt, oddsRaw: f.get('odds'), odds: od.ok ? od.value : NaN,
      status, cashoutC: status === 'cashout' ? parseMoneyToCents(f.get('cashout')) : null,
      settledDate: status === 'pendiente' ? '' : f.get('settledDate'),
      notes: String(f.get('notes') || '').trim(),
      createdAt: b ? b.createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  };
  const upd = () => {
    const isAm = state.fmt === 'american';
    $('#signBtn').classList.toggle('hidden', !isAm);
    $('#oddsIn').placeholder = isAm ? '+150 o -110' : '1.80';
    $('#oddsIn').setAttribute('inputmode', 'decimal');
    $('#oddsLabel').textContent = state.type === 'parlay' ? 'Momio combinado del boleto' : 'Momio';
    $('#oddsHint').textContent = isAm ? 'Americano: ≤ −100 o ≥ +100. Usa ± para el signo.' : 'Decimal: mayor que 1, por ejemplo 1.80 o 3.25.';
    const x = read();
    $('#cashF').classList.toggle('hidden', x.status !== 'cashout');
    $('#settledF').classList.toggle('hidden', x.status === 'pendiente');
    const p = $('#preview');
    if (!(x.stakeC > 0) || !Number.isFinite(x.odds)) {
      p.innerHTML = `<p class="wait">Escribe el monto y el momio para ver cuánto ganarías.</p>`;
      $('#saveSum').innerHTML = '<span>Falta monto y momio</span><b>—</b>'; return;
    }
    const o = betOutcome(x);
    let outcome = '';
    if (x.status === 'pendiente') outcome = 'Pendiente: no cuenta en ganancias ni pérdidas hasta que captures el resultado.';
    else if (x.status === 'cashout' && x.cashoutC === null) outcome = 'Escribe el importe del cash out para ver el resultado.';
    else outcome = `Con estado <strong style="color:var(--text)">${STATUS_LABEL[x.status]}</strong>: retorno ${fmtMoney(o.returnC)}, resultado neto <span class="money ${signClass(o.netC)}">${o.netC > 0 ? '▲ ' : o.netC < 0 ? '▼ ' : ''}${fmtMoney(o.netC, { sign: true })}</span>.`;
    p.innerHTML = `<div class="preview-grid">
      <div><p class="k">Ganancia neta potencial</p><p class="v" style="color:var(--gain)">${fmtMoney(o.potProfitC, { sign: true })}</p></div>
      <div><p class="k">Retorno total potencial</p><p class="v">${fmtMoney(o.potReturnC)}</p></div>
      <div class="outcome">${outcome}</div></div>`;
    const settled = x.status !== 'pendiente' && !(x.status === 'cashout' && x.cashoutC === null);
    $('#saveSum').innerHTML = settled
      ? `<span>Resultado (${STATUS_LABEL[x.status].toLowerCase()})</span><b class="money ${signClass(o.netC)}">${o.netC > 0 ? '▲ ' : o.netC < 0 ? '▼ ' : ''}${fmtMoney(o.netC, { sign: true })}</b>`
      : `<span>Si gana cobras</span><b>${fmtMoney(o.potReturnC)} <span style="color:var(--gain);font-size:13px">(${fmtMoney(o.potProfitC, { sign: true })})</span></b>`;
  };
  form.addEventListener('input', upd);
  form.addEventListener('change', upd);
  if (b) setLeague(LEAGUE_SPORT[b.league] ? b.league : '__otra', false);
  else setLeague('', false);
  if (b && b.type === 'simple') { state.pickTarget = form.elements.selection; renderPicks(parseEvent(b.event, b.sport)); }

  /* ---- Llenar desde captura ---- */
  function applyDraft(x) {
    form.elements.date.value = x.date;
    $(`[data-seg="type"] [data-v="${x.type}"]`).click();
    if (LEAGUE_SPORT[x.league]) setLeague(x.league, false);
    else { setLeague(x.sport || x.league ? '__otra' : '', false); form.elements.sport.value = x.sport || ''; form.elements.league.value = x.league || ''; }
    if (x.type === 'simple') {
      form.elements.event.value = x.event; form.elements.selection.value = x.selection;
      state.pickTarget = form.elements.selection; renderPicks(parseEvent(x.event, x.sport));
    } else {
      form.elements.parlayName.value = '';
      renderLegs(x.legs.length ? x.legs : [{ event: '', selection: '' }, { event: '', selection: '' }]);
    }
    form.elements.book.value = x.book || '';
    $$('#bookChips button').forEach(y => y.setAttribute('aria-pressed', y.dataset.v === x.book));
    form.elements.stake.value = x.stakeC > 0 ? (x.stakeC / 100).toFixed(2) : '';
    $(`[data-seg="fmt"] [data-v="${x.oddsFormat}"]`).click();
    form.elements.odds.value = Number.isFinite(x.odds) ? (x.oddsFormat === 'american' && x.odds > 0 ? '+' : '') + x.odds : '';
    form.elements.status.value = x.status;
    form.elements.cashout.value = x.cashoutC != null ? (x.cashoutC / 100).toFixed(2) : '';
    if (x.settledDate) form.elements.settledDate.value = x.settledDate;
    renderGames(); upd();
  }
  function scanMsg(kind, html) { const m = $('#scanMsg'); if (m) m.innerHTML = kind ? `<div class="scan-msg ${kind}" role="status">${html}</div>` : ''; }
  function dudasHTML(x) { return x.dudas && x.dudas.length ? `<ul>${x.dudas.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''; }

  async function runScan(file) {
    const btn = $('#scanBtn'), thumb = $('#scanThumb');
    scanMsg('warn', 'Preparando la imagen…');
    const cap = await getSampler();
    if (!cap.ok) { scanMsg('bad', cap.reason + '<br>Mientras tanto, puedes mandarme la captura en el chat de Claude y yo registro la apuesta por ti.'); return; }
    let img;
    try { img = await toJpeg(file); }
    catch (e) { scanMsg('bad', 'No pude abrir esa imagen. Si es una foto del iPhone (HEIC), mejor toma una captura de pantalla del boleto y súbela.'); return; }
    try { thumb.src = URL.createObjectURL(img); thumb.classList.remove('hidden'); } catch (e) {}
    btn.classList.add('disabled'); btn.style.pointerEvents = 'none'; btn.textContent = 'Leyendo boleto…';
    scanMsg('warn', 'Leyendo la captura. Puede tardar unos segundos.');
    try {
      const out = await cap.s.json(scanPrompt(), { images: [img], modelTier: 'default' });
      const list = (out && Array.isArray(out.apuestas) ? out.apuestas : []).map(draftToBet);
      if (!list.length) { scanMsg('bad', 'No encontré una apuesta en esa imagen. Sube la captura del boleto o del detalle de la apuesta.'); return; }
      if (list.length === 1) {
        applyDraft(list[0]);
        scanMsg(list[0].dudas.length ? 'warn' : 'ok', `<strong>Listo, llené el formulario con tu boleto.</strong> Revisa los datos y toca “Guardar apuesta”.${list[0].dudas.length ? '<br>Revisa en especial:' + dudasHTML(list[0]) : ''}`);
        return;
      }
      openScanList(list);
      scanMsg('ok', `Encontré ${list.length} apuestas en la captura.`);
    } catch (e) {
      const c = e && e.code;
      const msg = c === 'not_granted' || c === 'sampling_disabled' ? 'No se dio permiso para que la app use Claude. Puedes llenar el formulario a mano.'
        : c === 'rate_limited' ? 'Llegaste al límite de uso por ahora. Intenta más tarde o llena el formulario a mano.'
        : c === 'image_rejected' ? 'No pude abrir esa imagen. Prueba con otra captura (JPG, PNG o WebP).'
        : c === 'session_expired' ? 'Tu sesión de Claude expiró. Vuelve a iniciar sesión e intenta de nuevo.'
        : 'No pude leer el boleto. Intenta con una captura más nítida, sin recortar el monto ni el momio.';
      scanMsg('bad', msg);
    } finally { btn.style.pointerEvents = ''; btn.classList.remove('disabled'); btn.textContent = 'Subir otra captura'; }
  }

  function openScanList(list) {
    const valid = list.map(x => !Object.keys(validateBet(x)).length);
    const nOk = valid.filter(Boolean).length;
    openModal(`<h2 id="modalTitle">${list.length} apuestas en la captura</h2><p class="sub">Puedes guardar las que están completas o revisar cada una en el formulario.</p>
      <ul class="scan-list">${list.map((x, i) => { const o = Number.isFinite(x.odds) && x.stakeC > 0 ? betOutcome(x) : null; return `<li><div class="grow"><strong>${esc(x.event || 'Sin evento')}</strong><br>${esc(x.selection || '—')}<div class="meta">${x.stakeC > 0 ? fmtMoney(x.stakeC) : 'Sin monto'} · ${Number.isFinite(x.odds) ? fmtOdds(x) : 'sin momio'} · ${STATUS_LABEL[x.status]}${o ? ' · gana ' + fmtMoney(o.potProfitC) : ''}</div>${valid[i] ? '' : '<div class="meta bad">Le faltan datos</div>'}${x.dudas.length ? `<div class="meta" style="color:#F7D48A">${esc(x.dudas.join(' '))}</div>` : ''}</div><button class="btn sm" data-rev="${i}">Revisar</button></li>`; }).join('')}</ul>
      <div class="modal-actions"><button class="btn ghost" id="mNo">Cancelar</button><button class="btn primary" id="mYes"${nOk ? '' : ' disabled'}>Guardar ${nOk} completa${nOk === 1 ? '' : 's'}</button></div>`);
    $('#mNo').onclick = closeModal;
    $$('[data-rev]').forEach(bt => bt.onclick = () => { const x = list[+bt.dataset.rev]; closeModal(); applyDraft(x); scanMsg(x.dudas.length ? 'warn' : 'ok', '<strong>Llené el formulario con esta apuesta.</strong> Revisa y guarda.' + dudasHTML(x)); });
    $('#mYes').onclick = async () => {
      const ok = list.filter((x, i) => valid[i]).map(x => normalizeBet(stripForStore(x)));
      closeModal(); await persistMany(ok); toast(ok.length + ' apuestas guardadas'); location.hash = '#/historial';
    };
  }

  if (!b && $('#scanBox')) {
    const box = $('#scanBox'), fileIn = $('#scanFile');
    fileIn.addEventListener('change', () => { const f = fileIn.files && fileIn.files[0]; if (f) runScan(f); fileIn.value = ''; });
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', e => { e.preventDefault(); box.classList.remove('drag'); const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/') || /\.(heic|jpe?g|png|webp)$/i.test(f.name)); if (f) runScan(f); });
    const onPaste = e => {
      if (!document.body.contains(box)) { document.removeEventListener('paste', onPaste); return; }
      const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/'));
      if (f) { e.preventDefault(); runScan(f); }
    };
    document.addEventListener('paste', onPaste);
    getSampler().then(cap => {
      if (!cap.ok && document.body.contains(box)) $('#scanHint').textContent = cap.reason + ' También puedes mandarme la captura en el chat de Claude.';
    });
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const x = read();
    const errs = validateBet(x);
    $$('[data-err]', form).forEach(el => { el.textContent = errs[el.dataset.err] || ''; });
    $$('input,select', form).forEach(el => el.removeAttribute('aria-invalid'));
    ['date', 'sport', 'event', 'selection', 'book', 'stake', 'odds', 'cashout', 'settledDate'].forEach(k => { if (errs[k]) form.elements[k]?.setAttribute('aria-invalid', 'true'); });
    if (errs.legs) $$('.leg input', legsEl).forEach(i => { if (!i.value.trim()) i.setAttribute('aria-invalid', 'true'); });
    const n = Object.keys(errs).length;
    $('#errSummary').innerHTML = n ? `<div class="form-error-summary" role="alert">Revisa ${n === 1 ? 'el campo marcado' : 'los ' + n + ' campos marcados'} antes de guardar.</div>` : '';
    if (n) { const first = form.querySelector('[aria-invalid="true"]') || $('#errSummary'); first.focus?.(); first.scrollIntoView({ block: 'center' }); return; }
    const bet = normalizeBet(stripForStore(x));
    await persistBet(bet);
    toast(b ? 'Cambios guardados' : 'Apuesta guardada');
    location.hash = '#/historial';
  });
}

/* ---------------- Ligas y calendario ---------------- */
const LEAGUES = [
  ['Fútbol americano', ['NFL', 'NCAA Football']],
  ['Fútbol', ['Liga MX', 'Premier League', 'LaLiga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League', 'MLS', 'Liga MX Femenil']],
  ['Básquetbol', ['NBA', 'NCAA Basketball', 'WNBA', 'LNBP']],
  ['Béisbol', ['MLB', 'LMP', 'LMB']],
  ['Hockey', ['NHL']],
  ['Combate', ['UFC', 'Box']],
  ['Tenis', ['ATP', 'WTA']],
  ['Golf', ['PGA Tour']],
  ['Automovilismo', ['Fórmula 1', 'NASCAR']],
];
const LEAGUE_SPORT = {}; LEAGUES.forEach(([sp, ls]) => ls.forEach(l => { LEAGUE_SPORT[l] = sp; }));
const US_STYLE = new Set(['NFL', 'NCAA Football', 'NBA', 'NCAA Basketball', 'WNBA', 'LNBP', 'MLB', 'LMP', 'LMB', 'NHL']);
const DEFAULT_BOOKS = ['Caliente', 'Codere', 'bet365', 'Strendus', 'Playdoit', 'DraftKings'];
// Calendario incluido en la app: [fecha, hora, equipo1, equipo2, ronda]. En ligas de EE. UU. equipo1 = visitante.
const SCHEDULE_UPDATED = '2026-10-01';
const SCHEDULE_NOTE = { 'Liga MX': 'por ahora jornadas 11 y 12', 'NFL': 'hora del Este (ET)' };
const SCHEDULE = scheduleData;
function shortTeam(lg, name) { return lg === 'NFL' ? name.split(' ').pop() : name; }
function gameObj(lg, g) {
  const us = US_STYLE.has(lg);
  const home = us ? g[3] : g[2], away = us ? g[2] : g[3];
  return { home, away, event: us ? `${away} @ ${home}` : `${home} vs ${away}`, sport: LEAGUE_SPORT[lg], lg };
}
function parseEvent(ev, sport) {
  const m = String(ev || '').match(/^(.+?)\s+(@|vs\.?|v|-)\s+(.+)$/i);
  if (!m) return null;
  const at = m[2] === '@';
  return { home: (at ? m[3] : m[1]).trim(), away: (at ? m[1] : m[3]).trim(), event: ev, sport, lg: '' };
}
function quickPicks(gm) {
  const h = shortTeam(gm.lg, gm.home), a = shortTeam(gm.lg, gm.away);
  if (gm.sport === 'Fútbol') return [`${h} gana`, 'Empate', `${a} gana`, 'Ambos anotan', 'Más de 2.5 goles', 'Menos de 2.5 goles', `${h} o empate`];
  if (gm.sport === 'Combate' || gm.sport === 'Tenis') return [`${h} gana`, `${a} gana`, 'Más de ', 'Menos de '];
  return [`${a} gana`, `${h} gana`, `${a} +`, `${h} −`, 'Más de ', 'Menos de '];
}
let _samplerP = null;
function getSampler() {
  if (!_samplerP) _samplerP = (async () => {
    if (!window.claude || typeof window.claude.use !== 'function') return { ok: false, reason: 'Leer capturas solo funciona al abrir la app dentro de Claude (claude.ai o la app de Claude).' };
    const s = await claude.use('sample');
    if (!s) return { ok: false, reason: 'En esta vista no está disponible el lector de capturas.' };
    const lim = await s.limits().catch(() => null);
    if (!lim || !lim.images) return { ok: false, reason: 'En esta vista de Claude todavía no se pueden enviar imágenes a la app.' };
    return { ok: true, s, lim };
  })().catch(() => ({ ok: false, reason: 'No se pudo iniciar el lector de capturas.' }));
  return _samplerP;
}
// Convierte cualquier imagen que el navegador pueda abrir a JPEG de tamaño razonable.
function toJpeg(file, maxSide = 2000) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      try {
        const k = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(im, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(bl => bl ? resolve(bl) : reject(new Error('toBlob')), 'image/jpeg', 0.9);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    im.src = url;
  });
}
function scanPrompt() {
  const leagues = LEAGUES.map(([sp, ls]) => sp + ': ' + ls.join(', ')).join('\n');
  const books = [...new Set([...bets().map(b => b.book).filter(Boolean), ...DEFAULT_BOOKS])].join(', ');
  return `La imagen es una captura de pantalla de un boleto de apuesta deportiva (de una casa de apuestas o app). Extrae los datos para registrarlos en una bitácora personal. Hoy es ${todayISO()}. La moneda de la cuenta es ${settings.currency}.

Responde SOLO con JSON con esta forma:
{"no_es_boleto": false, "apuestas": [{
  "fecha": "YYYY-MM-DD o null",
  "casa": "nombre de la casa de apuestas o null",
  "tipo": "simple" | "parlay",
  "deporte": "deporte en español",
  "liga": "liga",
  "evento": "partido (solo en simple)",
  "seleccion": "a qué se apostó (solo en simple)",
  "selecciones": [{"evento": "...", "seleccion": "..."}],
  "monto": número o null,
  "formato_momio": "americano" | "decimal" | null,
  "momio": número o null,
  "retorno_potencial": número o null,
  "estado": "pendiente" | "ganada" | "perdida" | "anulada" | "cashout",
  "cash_out": número o null,
  "fecha_liquidacion": "YYYY-MM-DD o null",
  "moneda": "MXN" | "USD" | null,
  "dudas": ["frases cortas en español sobre lo que no se ve claro"]
}]}

Reglas:
- Una entrada por boleto. Si hay varias apuestas separadas en la imagen, una entrada por cada una. Si no es un boleto, {"no_es_boleto": true, "apuestas": []}.
- Parlay/combinada/multiapuesta: "tipo": "parlay", cada pierna en "selecciones", y "momio" es el momio COMBINADO del boleto. El monto se cuenta una vez.
- "monto" es lo apostado; "retorno_potencial" es el pago total posible (incluye lo apostado). Números sin símbolos ni comas.
- Momio: copia el que aparece. Americano lleva signo (+150, -110); decimal es como 1.85. Si no aparece, null.
- Estado: abierta/en juego/pendiente → "pendiente"; ganada/pagada → "ganada"; perdida → "perdida"; anulada/void/reembolsada → "anulada"; cash out/cobrada anticipada → "cashout" con el importe recibido en "cash_out".
- Liga: usa exactamente uno de estos nombres si corresponde: ${leagues.replace(/\n/g, '; ')}. Deporte: el del grupo de esa liga.
- Evento: nombres completos de los equipos. En ligas de EE. UU. (NFL, NBA, MLB, NHL, NCAA) escribe "Visitante @ Local"; en fútbol, "Local vs Visitante".
- Selección: texto corto en español, por ejemplo "Bengals gana", "Chiefs −3.5", "Más de 47.5 puntos", "Joe Burrow más de 250.5 yardas", "Ambos anotan".
- Casa: si se reconoce, usa uno de estos nombres: ${books}.
- Si falta el año, usa el del día de hoy. No inventes datos: si algo no se lee, pon null y agrégalo en "dudas".`;
}
function draftToBet(d) {
  d = d || {};
  const str = v => (v === null || v === undefined) ? '' : String(v).trim();
  const num = v => { if (typeof v === 'number') return v; const n = Number(String(v ?? '').replace(/[^\d.+\-−]/g, '').replace('−', '-')); return String(v ?? '').trim() === '' ? NaN : n; };
  const cents = v => { const n = num(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
  const dudas = Array.isArray(d.dudas) ? d.dudas.map(str).filter(Boolean) : [];
  const legs = (Array.isArray(d.selecciones) ? d.selecciones : []).map(l => ({ event: str(l && l.evento), selection: str(l && l.seleccion) })).filter(l => l.event || l.selection);
  const type = d.tipo === 'parlay' || legs.length > 1 ? 'parlay' : 'simple';
  const stakeC = cents(d.monto);
  let oddsFormat = norm(d.formato_momio) === 'decimal' ? 'decimal' : 'american';
  let odds = num(d.momio);
  if (Number.isFinite(odds) && oddsFormat === 'american' && Math.abs(odds) < 100 && odds > 1) oddsFormat = 'decimal';
  const ret = cents(d.retorno_potencial);
  if (!Number.isFinite(odds) && stakeC > 0 && ret > stakeC) { odds = Math.round(ret / stakeC * 100) / 100; oddsFormat = 'decimal'; dudas.push('El boleto no mostraba el momio; lo calculé con el retorno potencial.'); }
  const stMap = { pendiente: 'pendiente', ganada: 'ganada', perdida: 'perdida', anulada: 'anulada', cashout: 'cashout', 'cash out': 'cashout' };
  const status = stMap[norm(d.estado)] || 'pendiente';
  const lgRaw = str(d.liga);
  const league = Object.keys(LEAGUE_SPORT).find(l => norm(l) === norm(lgRaw)) || lgRaw;
  const sport = LEAGUE_SPORT[league] || str(d.deporte);
  const t = todayISO();
  const date = isISODate(d.fecha) && d.fecha <= addDays(t, 1) ? d.fecha : t;
  let settledDate = '';
  if (status !== 'pendiente') { settledDate = isISODate(d.fecha_liquidacion) ? d.fecha_liquidacion : t; if (settledDate < date) settledDate = date; }
  const bookRaw = str(d.casa);
  const book = [...new Set([...bets().map(b => b.book), ...DEFAULT_BOOKS])].find(x => x && norm(x) === norm(bookRaw)) || bookRaw;
  if (d.moneda && ['MXN', 'USD'].includes(d.moneda) && d.moneda !== settings.currency) dudas.push(`El boleto parece estar en ${d.moneda} y tu cuenta usa ${settings.currency}; los importes no se convirtieron.`);
  const x = {
    id: newId(), date, settledDate, sport, league, type, legs: type === 'parlay' ? legs : [],
    event: type === 'parlay' ? 'Parlay de ' + legs.length + ' selecciones' : str(d.evento),
    selection: type === 'parlay' ? legs.map(l => l.selection).join(' + ') : str(d.seleccion),
    book, stakeC, oddsFormat, odds, oddsRaw: Number.isFinite(odds) ? String(odds) : '',
    status, cashoutC: status === 'cashout' ? cents(d.cash_out) : null,
    notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dudas,
  };
  if (stakeC > 0 && Number.isFinite(odds) && bets().some(b => fingerprint(b) === fingerprint(x))) x.dudas.push('Parece que esta apuesta ya está registrada en tu historial.');
  return x;
}
function lastBook() { const l = [...bets()].sort((x, y) => y.createdAt.localeCompare(x.createdAt)); return l[0] ? l[0].book : ''; }

/* ---------------- CSV ---------------- */
const CSV_HEADERS = ['id', 'fecha', 'fecha_liquidacion', 'deporte', 'liga', 'evento', 'seleccion', 'tipo', 'selecciones_parlay', 'casa', 'monto', 'formato_momio', 'momio', 'estado', 'cash_out', 'notas', 'registrado'];
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // evita fórmulas en Excel
  return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(list) {
  const rows = list.map(b => [
    b.id, b.date, b.settledDate, b.sport, b.league, b.event, b.selection, b.type,
    b.type === 'parlay' ? b.legs.map(l => l.event + ' :: ' + l.selection).join(' || ') : '',
    b.book, (b.stakeC / 100).toFixed(2), b.oddsFormat === 'american' ? 'americano' : 'decimal',
    String(b.odds), b.status === 'cashout' ? 'cash out' : b.status, b.cashoutC != null ? (b.cashoutC / 100).toFixed(2) : '', b.notes, b.createdAt,
  ].map(csvCell).join(','));
  return '\uFEFF' + [CSV_HEADERS.join(','), ...rows].join('\r\n');
}
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = first.split(';').length > first.split(',').length ? ';' : ',';
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
function parseDateLoose(s) {
  s = String(s || '').trim();
  if (isISODate(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) { const iso = m[3] + '-' + pad(m[2]) + '-' + pad(m[1]); if (isISODate(iso)) return iso; }
  return '';
}
function buildImport(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { error: 'El archivo no tiene filas de apuestas.' };
  const head = rows[0].map(h => norm(h).replace(/\s+/g, '_'));
  const idx = k => head.indexOf(k);
  const required = ['fecha', 'evento', 'seleccion', 'tipo', 'casa', 'monto', 'formato_momio', 'momio', 'estado'];
  const missing = required.filter(k => idx(k) < 0);
  if (missing.length) return { error: 'Faltan columnas: ' + missing.join(', ') + '. Usa un CSV exportado desde esta app como plantilla.' };
  const get = (r, k) => { const i = idx(k); return i < 0 ? '' : String(r[i] ?? '').trim().replace(/^'/, ''); };
  const existingIds = new Set(bets().map(b => b.id));
  const existingFp = new Set(bets().map(fingerprint));
  const seenIds = new Set(), seenFp = new Set();
  const ok = [], errors = []; let dups = 0;
  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const stRaw = norm(get(r, 'estado')).replace(/[\s_-]/g, '');
    const status = { pendiente: 'pendiente', ganada: 'ganada', perdida: 'perdida', anulada: 'anulada', cashout: 'cashout' }[stRaw];
    const fmtRaw = norm(get(r, 'formato_momio'));
    const oddsFormat = fmtRaw.startsWith('amer') ? 'american' : fmtRaw === 'decimal' ? 'decimal' : '';
    const type = norm(get(r, 'tipo')) === 'parlay' ? 'parlay' : norm(get(r, 'tipo')) === 'simple' ? 'simple' : '';
    const legs = type === 'parlay' ? get(r, 'selecciones_parlay').split('||').map(x => x.trim()).filter(Boolean).map(x => { const [e, ...s] = x.split('::'); return { event: (e || '').trim(), selection: s.join('::').trim() }; }) : [];
    const od = oddsFormat ? parseOdds(oddsFormat, get(r, 'momio')) : { ok: false };
    let id = get(r, 'id'); if (!ID_RE.test(id)) id = newId();
    const date = parseDateLoose(get(r, 'fecha'));
    let settledDate = status && status !== 'pendiente' ? (parseDateLoose(get(r, 'fecha_liquidacion')) || date) : '';
    const cand = {
      id, date, settledDate, sport: get(r, 'deporte'), league: get(r, 'liga'), event: get(r, 'evento'), selection: get(r, 'seleccion'),
      type: type || 'simple', legs, book: get(r, 'casa'), stakeC: parseMoneyToCents(get(r, 'monto')),
      oddsFormat: oddsFormat || 'american', oddsRaw: get(r, 'momio'), odds: od.ok ? od.value : NaN,
      status: status || '', cashoutC: status === 'cashout' ? parseMoneyToCents(get(r, 'cash_out')) : null,
      notes: get(r, 'notas'), createdAt: get(r, 'registrado') || new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    if (cand.type === 'parlay' && !cand.event) cand.event = 'Parlay de ' + legs.length + ' selecciones';
    if (cand.type === 'parlay' && !cand.selection) cand.selection = legs.map(l => l.selection).join(' + ');
    const errs = validateBet(cand);
    if (!type) errs.type = 'Tipo debe ser “simple” o “parlay”.';
    if (!oddsFormat) errs.odds = 'Formato de momio debe ser “americano” o “decimal”.';
    if (!status) errs.status = 'Estado no reconocido (pendiente, ganada, perdida, anulada o cash out).';
    if (Object.keys(errs).length) { errors.push('Fila ' + line + ': ' + Object.values(errs).join(' ')); return; }
    const fp = fingerprint(cand);
    if (existingIds.has(cand.id) || existingFp.has(fp) || seenIds.has(cand.id) || seenFp.has(fp)) { dups++; return; }
    seenIds.add(cand.id); seenFp.add(fp);
    ok.push(normalizeBet(stripForStore(cand)));
  });
  return { ok, errors, dups, total: rows.length - 1 };
}
async function exportCSV() {
  const list = bets();
  if (!list.length) return toast('No hay apuestas para exportar');
  const name = 'apuestas-' + (settings.mode === 'demo' ? 'demo-' : '') + todayISO() + '.csv';
  const csv = toCSV([...list].sort((a, b) => a.date.localeCompare(b.date)));
  if (remote.downloads) {
    try { await remote.downloads.save({ filename: name, data: csv }); toast('CSV exportado'); }
    catch (e) { if (e && e.code !== 'declined') toast('No se pudo exportar el archivo.'); }
    return;
  }
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function bindIO() {
  $('#expBtn')?.addEventListener('click', exportCSV);
  $('#impBtn')?.addEventListener('click', () => { $('#csvFile').value = ''; $('#csvFile').click(); });
}
$('#csvFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 5 * 1024 * 1024) return toast('El archivo es demasiado grande (máx. 5 MB).');
  const res = buildImport(await f.text());
  if (res.error) { openModal(`<h2 id="modalTitle">No se pudo importar</h2><p class="sub">${esc(res.error)}</p><div class="modal-actions"><button class="btn primary" id="mNo">Entendido</button></div>`); $('#mNo').onclick = closeModal; return; }
  openModal(`<h2 id="modalTitle">Importar apuestas</h2>
    <p class="sub">Se leyeron ${res.total} filas de “${esc(f.name)}”. Se importarán a <strong>${settings.mode === 'demo' ? 'datos de demostración' : 'tus apuestas reales'}</strong>.</p>
    <dl class="dl"><dt>Listas para importar</dt><dd class="ok">${res.ok.length}</dd><dt>Duplicadas (se omiten)</dt><dd>${res.dups}</dd><dt>Con errores (se omiten)</dt><dd class="${res.errors.length ? 'bad' : ''}">${res.errors.length}</dd></dl>
    ${res.errors.length ? `<ul class="import-errors">${res.errors.slice(0, 50).map(x => `<li>${esc(x)}</li>`).join('')}${res.errors.length > 50 ? `<li>… y ${res.errors.length - 50} más</li>` : ''}</ul>` : ''}
    <div class="modal-actions"><button class="btn ghost" id="mNo">Cancelar</button><button class="btn primary" id="mYes"${res.ok.length ? '' : ' disabled'}>Importar ${res.ok.length} apuesta${res.ok.length === 1 ? '' : 's'}</button></div>`);
  $('#mNo').onclick = closeModal;
  $('#mYes').onclick = async () => {
    $('#mYes').disabled = true; $('#mYes').textContent = 'Importando…';
    await persistMany(res.ok, (n, t) => { const b = $('#mYes'); if (b) b.textContent = `Importando ${n}/${t}…`; });
    closeModal(); toast(res.ok.length + ' apuestas importadas'); softRender(true);
  };
});

/* ---------------- Configuración ---------------- */
const FORMULA_TESTS = [
  { label: '$100 a +150, ganada', bet: { stakeC: 10000, oddsFormat: 'american', odds: 150, status: 'ganada' }, ret: 25000, net: 15000 },
  { label: '$100 a −200, ganada', bet: { stakeC: 10000, oddsFormat: 'american', odds: -200, status: 'ganada' }, ret: 15000, net: 5000 },
  { label: '$100 a 1.80, ganada', bet: { stakeC: 10000, oddsFormat: 'decimal', odds: 1.8, status: 'ganada' }, ret: 18000, net: 8000 },
  { label: '$100, perdida', bet: { stakeC: 10000, oddsFormat: 'american', odds: 150, status: 'perdida' }, ret: 0, net: -10000 },
  { label: '$100 con cash out de $70', bet: { stakeC: 10000, oddsFormat: 'american', odds: 150, status: 'cashout', cashoutC: 7000 }, ret: 7000, net: -3000 },
  { label: '$100, anulada', bet: { stakeC: 10000, oddsFormat: 'american', odds: -110, status: 'anulada' }, ret: 10000, net: 0 },
];
function viewConfig() {
  const v = $('#view');
  const tests = FORMULA_TESTS.map(t => { const o = betOutcome(t.bet); return { ...t, gotR: o.returnC, gotN: o.netC, pass: o.returnC === t.ret && o.netC === t.net }; });
  const storeHTML = sb && remote.user
    ? `<div class="store-state"><span class="dot" style="background:${remote.on ? 'var(--gain)' : 'var(--accent)'}"></span><div><strong>${remote.on ? 'Guardado en Supabase.' : remote.loading ? 'Cargando desde Supabase…' : 'Sin conexión con Supabase.'}</strong><br><span style="color:var(--muted)">Cuenta: ${esc(remote.user.email || '')}. Tus apuestas reales viven en tu base de datos y se sincronizan entre celular y computadora.</span></div></div>
       <button class="btn" id="logoutBtn">Cerrar sesión</button>`
    : `<div class="store-state"><span class="dot" style="background:var(--accent)"></span><div><strong>Guardado solo en este navegador.</strong><br><span style="color:var(--muted)">Supabase no está configurado. Agrega VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en el archivo .env (ver README) para guardar tus datos en tu base de datos.</span></div></div>`;
  v.innerHTML = `<h1 class="view-title">Configuración</h1><p class="view-sub">Moneda, datos de demostración, respaldo y verificación de fórmulas.</p>
  <div class="settings">
    <section class="panel">
      <h2>Moneda de la cuenta</h2>
      <p>Todas las cantidades se muestran en esta moneda. Cambiarla no convierte importes: solo cambia el símbolo, así que elige la que usas al apostar.</p>
      <div class="seg" id="curSeg">${['MXN', 'USD'].map(c => `<button type="button" data-v="${c}" aria-pressed="${settings.currency === c}">${c === 'MXN' ? 'MXN · Peso mexicano' : 'USD · Dólar'}</button>`).join('')}</div>
      <h2>Almacenamiento</h2>
      ${storeHTML}
      <p class="small">Los datos de demostración se guardan aparte y solo en este navegador; nunca se mezclan con tus apuestas reales.</p>
    </section>
    <section class="panel">
      <h2>Datos de demostración</h2>
      <p>${settings.mode === 'demo' ? 'Estás en modo demostración. Todo lo que agregues, edites o importes aquí afecta solo a los datos de demostración.' : 'Explora la app con apuestas de ejemplo sin tocar tus datos reales.'}</p>
      <div class="btn-row">
        ${settings.mode === 'demo'
          ? `<button class="btn primary" id="toReal">Volver a mis apuestas</button><button class="btn" id="reloadDemo">Regenerar demostración</button><button class="btn danger" id="clearDemo">Borrar demostración</button>`
          : `<button class="btn" id="toDemo">Ver datos de demostración</button>`}
      </div>
      <h2>Respaldo en CSV</h2>
      <p>Exporta ${settings.mode === 'demo' ? 'los datos de demostración' : 'tus apuestas'} para guardarlas o abrirlas en Excel. Al importar se validan las filas y se omiten duplicados y errores.</p>
      <div class="btn-row"><button class="btn" id="expBtn"${bets().length ? '' : ' disabled'}>Exportar CSV</button><button class="btn" id="impBtn">Importar CSV</button></div>
    </section>
    <section class="panel">
      <h2>Verificación de fórmulas</h2>
      <p>Se calculan en vivo con el mismo código que usa la app.</p>
      <div style="overflow-x:auto"><table class="tests"><thead><tr><th>Caso</th><th class="r">Retorno</th><th class="r">Neto</th><th></th></tr></thead><tbody>
      ${tests.map(t => `<tr><td>${t.label}</td><td class="r num">${fmtMoney(t.gotR)}</td><td class="r num">${fmtMoney(t.gotN, { sign: true })}</td><td class="${t.pass ? 'ok' : 'bad'}">${t.pass ? '✓ Correcto' : '✗ Falla'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small" style="margin-top:10px">Ganada: retorno = monto + ganancia. Perdida: retorno 0. Anulada: se devuelve el monto. Cash out: retorno = importe recibido.</p>
    </section>
    <section class="panel">
      <h2>Borrar datos</h2>
      <p>Elimina ${settings.mode === 'demo' ? 'todas las apuestas de demostración' : 'todas tus apuestas reales'}. Exporta un CSV antes si quieres conservarlas.</p>
      <button class="btn danger" id="wipe"${bets().length ? '' : ' disabled'}>Borrar ${settings.mode === 'demo' ? 'demostración' : 'todas mis apuestas'}</button>
    </section>
  </div>`;
  $('#curSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b || b.dataset.v === settings.currency) return;
    settings.currency = b.dataset.v; saveSettings(); toast('Moneda: ' + settings.currency + '. Los importes no se convirtieron.'); render();
  });
  $('#toDemo')?.addEventListener('click', () => switchMode('demo'));
  $('#toReal')?.addEventListener('click', () => switchMode('real'));
  $('#reloadDemo')?.addEventListener('click', async () => { data.demo = makeDemo(); cacheLocal('demo'); toast('Demostración regenerada'); render(); });
  $('#clearDemo')?.addEventListener('click', async () => { if (await confirmModal({ title: 'Borrar demostración', body: 'Se eliminan solo los datos de demostración. Tus apuestas reales no cambian.', confirmText: 'Borrar demostración', danger: true })) { await clearMode('demo'); switchMode('real'); } });
  $('#wipe')?.addEventListener('click', async () => {
    const mode = settings.mode;
    if (!await confirmModal({ title: mode === 'demo' ? 'Borrar demostración' : 'Borrar todas tus apuestas', body: `Se eliminarán ${bets().length} apuestas${mode === 'real' ? (remote.on ? ' de tu cuenta, en todos tus dispositivos' : ' de este navegador') : ''}. No se puede deshacer.`, confirmText: 'Borrar definitivamente', danger: true })) return;
    await clearMode(mode); toast('Datos borrados'); render();
  });
  $('#logoutBtn')?.addEventListener('click', async () => {
    if (!await confirmModal({ title: 'Cerrar sesión', body: 'Tus apuestas siguen guardadas en Supabase. Podrás verlas al volver a entrar.', confirmText: 'Cerrar sesión' })) return;
    if (remote.user) localStorage.removeItem(cacheKey(remote.user.id));
    await sb.auth.signOut();
  });
  bindIO();
}
function switchMode(mode) {
  settings.mode = mode; lsSet(LS.settings, settings);
  if (mode === 'demo' && !data.demo.length) { data.demo = makeDemo(); cacheLocal('demo'); }
  filters = { period: 'all', from: '', to: '', sport: '', league: '', book: '', type: '', status: '', q: '' };
  toast(mode === 'demo' ? 'Modo demostración' : 'Mostrando tus apuestas reales');
  if (route().name === 'dashboard') render(); else location.hash = '#/dashboard';
}
$('#exitDemo').addEventListener('click', () => switchMode('real'));

/* ---------------- Datos de demostración ---------------- */
function makeDemo() {
  let seed = 7319;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const pool = [
    { sport: 'Fútbol americano', league: 'NFL', ev: [['Bengals vs Steelers', ['Bengals gana', 'Más de 250.5 yardas de Joe Burrow', "Ja'Marr Chase anota TD"]], ['Chiefs vs Raiders', ['Chiefs −6.5', 'Más de 47.5 puntos']], ['Cowboys vs Eagles', ['Eagles gana', 'Menos de 44.5 puntos']], ['Bills vs Dolphins', ['Bills −3.5', 'Josh Allen más de 1.5 TD de pase']]] },
    { sport: 'Fútbol', league: 'Liga MX', ev: [['América vs Chivas', ['América gana', 'Ambos anotan']], ['Tigres vs Monterrey', ['Empate', 'Más de 2.5 goles']], ['Cruz Azul vs Pumas', ['Cruz Azul gana', 'Menos de 2.5 goles']], ['Toluca vs Santos', ['Toluca −1', 'Más de 9.5 tiros de esquina']]] },
    { sport: 'Béisbol', league: 'MLB', ev: [['Dodgers vs Padres', ['Dodgers gana', 'Más de 8.5 carreras']], ['Yankees vs Red Sox', ['Yankees −1.5', 'Aaron Judge conecta HR']], ['Astros vs Rangers', ['Astros gana', 'Menos de 7.5 carreras']]] },
    { sport: 'Básquetbol', league: 'NBA', ev: [['Lakers vs Warriors', ['Warriors +4.5', 'Más de 228.5 puntos']], ['Celtics vs Knicks', ['Celtics gana', 'Jayson Tatum más de 27.5 puntos']]] },
    { sport: 'Fútbol', league: 'Premier League', ev: [['Arsenal vs Liverpool', ['Liverpool gana', 'Ambos anotan']], ['Man City vs Chelsea', ['Man City −1.5', 'Más de 3.5 goles']]] },
  ];
  const books = ['Caliente', 'Codere', 'bet365', 'Strendus', 'Playdoit'];
  const amOdds = [-250, -200, -160, -130, -115, -110, 100, 110, 125, 150, 180, 220, 300];
  const stakes = [100, 150, 200, 250, 300, 500];
  const t = todayISO(), out = [];
  for (let i = 0; i < 52; i++) {
    const daysAgo = i < 5 ? Math.floor(rnd() * 3) : Math.floor(rnd() * 110);
    const date = addDays(t, -daysAgo);
    const parlay = rnd() < 0.2;
    const g = pick(pool);
    const stakeC = pick(stakes) * 100;
    let b;
    if (parlay) {
      const n = 2 + Math.floor(rnd() * 3);
      const legs = Array.from({ length: n }, () => { const p = pick(pool), e = pick(p.ev); return { event: e[0], selection: pick(e[1]) }; });
      b = { type: 'parlay', sport: g.sport, league: g.league, event: 'Parlay de ' + n + ' selecciones', selection: legs.map(l => l.selection).join(' + '), legs, oddsFormat: 'decimal', odds: Math.round((2.2 + rnd() * (n * 2.2)) * 100) / 100 };
    } else {
      const e = pick(g.ev);
      const dec = rnd() < 0.25;
      b = { type: 'simple', sport: g.sport, league: g.league, event: e[0], selection: pick(e[1]), legs: [], oddsFormat: dec ? 'decimal' : 'american', odds: dec ? Math.round((1.4 + rnd() * 2.1) * 100) / 100 : pick(amOdds) };
    }
    let status;
    if (daysAgo <= 2 && rnd() < 0.75) status = 'pendiente';
    else { const r = rnd(); const winP = parlay ? 0.22 : 0.45; status = r < winP ? 'ganada' : r < 0.88 ? 'perdida' : r < 0.93 ? 'anulada' : 'cashout'; }
    let settledDate = '';
    if (status !== 'pendiente') { settledDate = addDays(date, Math.floor(rnd() * 3)); if (settledDate > t) settledDate = t; }
    out.push(normalizeBet({ ...b, id: 'demo_' + i, date, settledDate, book: pick(books), stakeC, status,
      cashoutC: status === 'cashout' ? Math.round(stakeC * (0.45 + rnd() * 0.9) / 100) * 100 : null,
      notes: i % 9 === 0 ? 'Apuesta de ejemplo.' : '', createdAt: date + 'T12:' + pad(i % 60) + ':00.000Z' }));
  }
  return out.filter(Boolean);
}

/* ---------------- Aviso ---------------- */
let toastT;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2800);
}

/* ---------------- Inicio ---------------- */
if (!location.hash) history.replaceState(null, '', '#/dashboard');
render();
initRemote();
