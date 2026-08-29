/* BIA 2027 — rappel du soir.
 * Chaque soir de semaine (~19 h Paris), lit la progression de Léo dans Supabase
 * et envoie AU PLUS une notification, seulement si utile :
 *   - s'il prend du retard sur le planning Lecture 1  → rappel "retard"
 *   - sinon s'il n'a rien fait de la journée          → rappel "jour vide"
 *   - sinon (a travaillé + dans les temps)            → rien
 * Ne tourne pas le week-end ni pendant les vacances.
 *
 * Lancé par .github/workflows/evening-nudge.yml. Même secret que le quiz du
 * matin : VAPID_PRIVATE.
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

const SEC_TOTAL = 65;
/* mêmes jalons que CURVE dans index.html */
const CURVE = [
  ['2026-09-01', 0], ['2026-09-30', 13], ['2026-10-31', 24], ['2026-11-30', 32],
  ['2026-12-31', 42], ['2027-01-31', 55], ['2027-02-10', 65],
];
const VAC = [['2026-10-17', '2026-11-02'], ['2026-12-19', '2027-01-04']];
const EXAM = '2027-05-19';

function todayISO() { return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function isoToUTC(iso) { const p = (iso || '').split('-'); return Date.UTC(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function daysAgo(iso) { return iso ? Math.round((isoToUTC(todayISO()) - isoToUTC(iso)) / 86400000) : 999; }
function between(iso, a, b) { const t = isoToUTC(iso); return t >= isoToUTC(a) && t <= isoToUTC(b); }
function weekday(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); } // 0=dim … 6=sam

function phaseOf(iso) {
  if (iso === EXAM) return 'exam';
  if (between(iso, '2026-09-01', '2027-02-10')) return 'p1';
  if (between(iso, '2027-02-16', '2027-04-12')) return 'p2';
  if (between(iso, '2027-04-13', EXAM)) return 'p3';
  return 'off';
}
function isVac(iso) { return VAC.some(([a, b]) => between(iso, a, b)); }
function isStudyDay(iso) {
  const d = weekday(iso);
  return d >= 1 && d <= 5 && phaseOf(iso) !== 'off' && !isVac(iso);
}
function expectedSections(iso) {
  const t = isoToUTC(iso);
  if (t <= isoToUTC(CURVE[0][0])) return 0;
  if (t >= isoToUTC(CURVE[CURVE.length - 1][0])) return SEC_TOTAL;
  for (let i = 1; i < CURVE.length; i++) {
    const [ai, av] = CURVE[i - 1], [bi, bv] = CURVE[i];
    if (t <= isoToUTC(bi)) {
      const f = (t - isoToUTC(ai)) / (isoToUTC(bi) - isoToUTC(ai));
      return av + f * (bv - av);
    }
  }
  return SEC_TOTAL;
}
function countSec(state) {
  let n = 0;
  for (const k of Object.keys(state.sec || {})) if (state.sec[k]) n++;
  return n;
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
  const t = todayISO();
  if (!FORCE && !isStudyDay(t)) { console.log(`${t}: pas un jour de révision, on ne fait rien.`); return; }

  const rows = await getRows();
  let pushed = 0, updated = 0;

  for (const row of rows || []) {
    const state = row.data || {};
    const subs = Array.isArray(state.subs) ? state.subs : [];
    if (!subs.length || !state.dailyOn) continue;
    if (state.eveningLast === t && !FORCE) { console.log(`${row.code}: déjà rappelé ce soir`); continue; }

    const didToday = !!(state.act && state.act[t]);
    const behind = Math.round(countSec(state) - expectedSections(t)); // < 0 = en retard
    const inP1 = phaseOf(t) === 'p1';

    let msg = null;
    if (inP1 && behind <= -3) {
      msg = {
        title: '📚 BIA — tu prends du retard',
        body: `En retard de ${-behind} sections. Objectif du jour : ${Math.round(expectedSections(t))}/65. Il te reste la soirée.`,
      };
    } else if (!didToday) {
      msg = {
        title: '📖 BIA — pas encore aujourd’hui',
        body: 'Tu n’as pas ouvert le BIA aujourd’hui. 30 min avant ce soir ?',
      };
    }

    if (!msg) { console.log(`${row.code}: rien à signaler (travaillé + dans les temps)`); continue; }

    const live = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({ ...msg, url: './' }));
        live.push(sub); pushed++;
      } catch (e) {
        const code = e && e.statusCode;
        if (code === 404 || code === 410) console.log(`${row.code}: abonnement expiré, retiré`);
        else { console.log(`${row.code}: push échoué (${code || (e && e.message)})`); live.push(sub); }
      }
    }
    state.subs = live;
    state.eveningLast = t;

    try { await upsertRow(row.code, state); updated++; }
    catch (e) { console.error(String(e)); }
  }

  console.log(`Terminé — ${pushed} rappel(s) du soir envoyé(s), ${updated} ligne(s) mise(s) à jour.`);
}

run().catch((e) => { console.error(e); process.exit(1); });
