// Agrège les événements stockés dans KV et renvoie des statistiques anonymes.
// Protégé par une clé secrète (variable d'environnement STATS_SECRET) passée en
// paramètre d'URL : /api/v1/stats?key=VOTRE_CLE

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!env.STATS_SECRET || key !== env.STATS_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SRACTIVE_EVENTS) {
    return json({ ok: false, error: 'kv_not_bound' }, 500);
  }

  const sessions = new Set();
  const bySite = {};
  const views = {};
  const chaptersOpened = {};
  const chaptersCompleted = {};
  const quiz = {}; // chapter_id -> { count, sumPercent }
  let circuitsStarted = 0;
  let totalEvents = 0;

  let cursor;
  do {
    const list = await env.SRACTIVE_EVENTS.list({ prefix: 'evt:', cursor, limit: 1000 });
    for (const k of list.keys) {
      const raw = await env.SRACTIVE_EVENTS.get(k.name);
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { continue; }
      // Chaque entrée peut contenir soit un paquet d'événements (nouveau format),
      // soit un seul événement (ancien format, avant le regroupement par paquets).
      const evts = Array.isArray(parsed) ? parsed : [parsed];

      for (const evt of evts) {
        totalEvents++;
        if (evt.session_id) sessions.add(evt.session_id);
        const site = evt.site_code || 'inconnu';
        bySite[site] = (bySite[site] || 0) + 1;

        const d = evt.data || {};
        if (evt.event_name === 'view_change') {
          const v = d.view || 'inconnu';
          views[v] = (views[v] || 0) + 1;
        }
        if (evt.event_name === 'chapter_open') {
          const c = d.chapter_id || 'inconnu';
          chaptersOpened[c] = (chaptersOpened[c] || 0) + 1;
        }
        if (evt.event_name === 'chapter_complete') {
          const c = d.chapter_id || 'inconnu';
          chaptersCompleted[c] = (chaptersCompleted[c] || 0) + 1;
        }
        if (evt.event_name === 'quiz_complete') {
          const c = d.chapter_id || 'inconnu';
          if (!quiz[c]) quiz[c] = { count: 0, sumPercent: 0 };
          quiz[c].count++;
          quiz[c].sumPercent += (d.percent || 0);
        }
        if (evt.event_name === 'circuit_start') {
          circuitsStarted++;
        }
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  const quizAveragePercent = {};
  for (const [c, v] of Object.entries(quiz)) {
    quizAveragePercent[c] = Math.round(v.sumPercent / v.count);
  }

  return json({
    ok: true,
    total_events: totalEvents,
    unique_sessions: sessions.size,
    by_site: bySite,
    views,
    chapters_opened: chaptersOpened,
    chapters_completed: chaptersCompleted,
    quiz_average_percent: quizAveragePercent,
    circuits_started: circuitsStarted
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
