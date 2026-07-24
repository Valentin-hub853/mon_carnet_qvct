// Reçoit les événements envoyés par track() dans index.html et les stocke dans KV.
// Ne stocke jamais de données personnelles : le front-end ne doit envoyer que des
// événements comportementaux anonymes (page vue, escale ouverte/terminée, quiz, circuit).

export async function onRequestPost({ request, env }) {
  if (!env.SRACTIVE_EVENTS) {
    return json({ ok: false, error: 'kv_not_bound' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const events = Array.isArray(body.events) ? body.events : [body];
  if (events.length === 0) {
    return json({ ok: true, received: 0 });
  }

  const capped = events.slice(0, 100); // limite anti-abus par requête
  const ttlSeconds = 60 * 60 * 24 * 180; // 180 jours de rétention, ajustable
  const key = `evt:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  await env.SRACTIVE_EVENTS.put(key, JSON.stringify(capped), { expirationTtl: ttlSeconds });

  return json({ ok: true, received: capped.length });
}

export async function onRequestGet() {
  return json({ ok: true, service: 'sractive-events' });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
