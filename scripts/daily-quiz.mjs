/* BIA 2027 — routine quotidienne.
 * Chaque matin : lit la progression de Léo dans Supabase (REST, pas de client
 * lourd), choisit 5 questions (pondérées vers ce qu'il a révisé, révision
 * espacée), écrit `data.daily`, et envoie une notification push qui ouvre le
 * quiz du jour. Purge les abonnements expirés.
 *
 * Lancé par .github/workflows/daily-quiz.yml. Rien à builder côté app.
 * Seul secret attendu : VAPID_PRIVATE. (La clé publique et la clé Supabase
 * publiable sont déjà exposées dans index.html — pas des secrets.)
 */
import webpush from 'web-push';

const SUPA = 'https://elyspjsyconovzczmzhm.supabase.co/rest/v1/bia_2027_state';
const KEY = 'sb_publishable_jpQmyTu3lkT65xw0Z6oXmg_7zxkqRXW';
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const VAPID_PUBLIC = 'BC791P1FqS-u4pPpbqvGyGswlPxHW7S4A8-ZwMFUQF2CLynoOv9934TRHboysRXmpmDmHMTKnfm6_9YlNXWbnaQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const FORCE = process.env.FORCE === '1';
if (!VAPID_PRIVATE) { console.error('Secret VAPID_PRIVATE manquant'); process.exit(1); }
webpush.setVapidDetails('https://bia-2027.vercel.app', VAPID_PUBLIC, VAPID_PRIVATE);

/* --- index de la bonne réponse par question, dans l'ordre --- */
const CORRECT = {
  meteo:    [1,2,3,1,0,1,1,2,1,1,2,1,1,2,1,1],
  aero:     [1,2,2,1,2,0,1,1,1,1,1,0,1,1,1,0],
  aeronefs: [1,1,2,1,2,2,1,1,1,2,2,0,0,1,1],
  nav:      [2,2,1,0,0,1,2,1,1,1,0,1,2,1,1,2,3],
  histoire: [1,2,1,1,1,1,1,2,0,2,1,1,1,0,1,0],
};
const EP_NAMES = { meteo:'Météo', aero:'Aérodynamique', aeronefs:'Aéronefs', nav:'Navigation', histoire:'Histoire' };
const CHAP2EP = { '0':'aero', '1':'aeronefs', '2':'meteo', '3':'nav', '4':'histoire' };
const ALL_EPS = Object.keys(CORRECT);

function todayISO() { return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function isoToUTC(iso) { const p = (iso || '').split('-'); return Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function daysAgo(iso) { return iso ? Math.round((isoToUTC(todayISO()) - isoToUTC(iso)) / 86400000) : 999; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }

function activeEps(state) {
  const seen = new Set();
  for (const k of Object.keys(state.sec || {})) if (state.sec[k]) seen.add(String(k).split('.')[0]);
  const ids = [...seen].map((c) => CHAP2EP[c]).filter(Boolean);
  return ids.length ? ids : ALL_EPS;
}

function pickQuiz(state) {
  const qcm = state.qcm || {}, at = state.qcmAt || {};
  const eps = activeEps(state);
  const A = [], B = [], C = [], all = [];
  for (const ep of eps) {
    (CORRECT[ep] || []).forEach((c, i) => {
      const qid = `${ep}.${i}`, v = qcm[qid];
      all.push(qid);
      if (daysAgo(at[qid]) <= 1) return;
      if (v === undefined || v === -1) A.push(qid);
      else if (v !== c) B.push(qid);
      else if (daysAgo(at[qid]) >= 6) C.push(qid);
    });
  }
  shuffle(A); shuffle(B); shuffle(C); shuffle(all);
  const pick = [];
  const take = (arr, n) => { for (const qid of arr) { if (pick.length >= 5 || n <= 0) break; if (!pick.includes(qid)) { pick.push(qid); n--; } } };
  take(A, 3); take(B, 1); take(C, 1); take(A, 5); take(C, 5); take(B, 5); take(all, 5);
  return pick.slice(0, 5);
}

function body(state, qids) {
  const eps = [...new Set(qids.map((q) => q.split('.')[0]))].map((e) => EP_NAMES[e] || e);
  const streak = state.dailyStreak || 0;
  const base = `5 questions — ${eps.join(', ')}`;
  return streak >= 2 ? `${base}. Série : ${streak} jours 🔥` : base;
}

async function getRows() {
  const r = await fetch(`${SUPA}?select=code,data`, { headers: H });
  if (!r.ok) throw new Error(`lecture Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
async function upsertRow(code, data) {
  const r = await fetch(SUPA, {
    method: 'POST',
    headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ code, data }),
  });
  if (!r.ok) throw new Error(`écriture ${code} ${r.status}: ${await r.text()}`);
}

async function run() {
  const rows = await getRows();
  const t = todayISO();
  let pushed = 0, updated = 0;

  for (const row of rows || []) {
    const state = row.data || {};
    const subs = Array.isArray(state.subs) ? state.subs : [];
    if (!subs.length || !state.dailyOn) continue;

    const already = state.daily && state.daily.date === t;
    if (already && state.daily.done && !FORCE) { console.log(`${row.code}: déjà fait aujourd'hui`); continue; }

    let qids;
    if (already && !FORCE) {
      qids = state.daily.qids;                 // quiz déjà généré par l'app → on garde, on relance juste la notif
    } else {
      qids = pickQuiz(state);
      if (!qids.length) { console.log(`${row.code}: aucune question disponible`); continue; }
      state.daily = { date: t, qids, done: false };
    }

    const live = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({
          title: 'Quiz BIA du jour 🎯',
          body: body(state, qids),
          url: './?quiz=1',
        }));
        live.push(sub); pushed++;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) console.log(`${row.code}: abonnement expiré, retiré`);
        else { console.log(`${row.code}: push échoué (${code || (e && e.message)})`); live.push(sub); }
      }
    }
    state.subs = live;

    try { await upsertRow(row.code, state); updated++; }
    catch (e) { console.error(String(e)); }
  }

  console.log(`Terminé — ${pushed} notif(s) envoyée(s), ${updated} ligne(s) mise(s) à jour.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
