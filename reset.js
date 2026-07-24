// Supprime tous les événements stockés dans KV. Protégé par la même clé secrète
// que /api/v1/stats. Action destructive et irréversible : à utiliser avec précaution.

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');

  if (!env.STATS_SECRET || key !== env.STATS_SECRET) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!env.SRACTIVE_EVENTS) {
    return json({ ok: false, error: 'kv_not_bound' }, 500);
  }

  let deleted = 0;
  let cursor;
  do {
    const list = await env.SRACTIVE_EVENTS.list({ prefix: 'evt:', cursor, limit: 1000 });
    await Promise.all(list.keys.map(k => env.SRACTIVE_EVENTS.delete(k.name)));
    deleted += list.keys.length;
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return json({ ok: true, deleted });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
