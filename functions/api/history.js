/**
 * Cloudflare Pages Function: /api/history
 *
 * GET /api/history?date=YYYY-MM-DD  → tasas de ese día (desde KV)
 * GET /api/history                  → lista de fechas disponibles (últimas 14)
 *
 * Binding KV requerido: RATES_HISTORY
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (!env.RATES_HISTORY) {
        return new Response(
            JSON.stringify({ error: 'KV binding RATES_HISTORY no configurado' }),
            { status: 503, headers: CORS_HEADERS }
        );
    }

    const url = new URL(request.url);
    const date = url.searchParams.get('date'); // 'YYYY-MM-DD'

    try {
        if (date) {
            // ── Modo: obtener tasa de una fecha específica ──
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return new Response(
                    JSON.stringify({ error: 'Formato de fecha inválido. Usa YYYY-MM-DD.' }),
                    { status: 400, headers: CORS_HEADERS }
                );
            }

            const raw = await env.RATES_HISTORY.get(date);
            if (!raw) {
                return new Response(
                    JSON.stringify({ error: 'Sin datos para esa fecha', date }),
                    { status: 404, headers: CORS_HEADERS }
                );
            }

            const entry = JSON.parse(raw);
            return new Response(
                JSON.stringify({ date, ...entry }),
                { status: 200, headers: CORS_HEADERS }
            );

        } else {
            // ── Modo: listar fechas disponibles (últimas 14) ──
            // Genera las últimas 14 fechas y verifica cuáles existen en KV
            const dates = [];
            const today = new Date();
            for (let i = 0; i < 14; i++) {
                const d = new Date(today);
                d.setDate(today.getDate() - i);
                dates.push(d.toISOString().slice(0, 10));
            }

            const checks = await Promise.all(
                dates.map(async (d) => {
                    const val = await env.RATES_HISTORY.get(d);
                    return val ? d : null;
                })
            );

            const available = checks.filter(Boolean);
            return new Response(
                JSON.stringify({ available, total: available.length }),
                { status: 200, headers: CORS_HEADERS }
            );
        }

    } catch (err) {
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: CORS_HEADERS }
        );
    }
}
