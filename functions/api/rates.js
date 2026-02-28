/**
 * Cloudflare Pages Function: /api/rates
 * - Obtiene tasas en tiempo real de dolarapi.com
 * - Guarda el snapshot del día en KV (RATES_HISTORY)
 * - Devuelve JSON con headers CORS para el browser
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

    // Preflight CORS
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        // 1. Fetch tasas actuales
        const [resUSD, resEUR] = await Promise.all([
            fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(10000) }),
            fetch('https://ve.dolarapi.com/v1/euros', { signal: AbortSignal.timeout(10000) }),
        ]);

        if (!resUSD.ok || !resEUR.ok) {
            throw new Error(`dolarapi error: USD=${resUSD.status} EUR=${resEUR.status}`);
        }

        const jUSD = await resUSD.json();
        const jEUR = await resEUR.json();

        const bcvEntry = jUSD.find(i => i.fuente === 'oficial');
        const paralelEntry = jUSD.find(i => i.fuente === 'paralelo');

        const bcv = bcvEntry?.promedio ?? 0;
        const binance = paralelEntry?.promedio ?? 0;
        const euro = Array.isArray(jEUR)
            ? (jEUR.find(i => i.fuente === 'oficial')?.promedio ?? 0)
            : (jEUR.promedio ?? 0);

        if (!bcv || !binance || !euro) throw new Error('Datos incompletos de dolarapi');

        // 2. Determinar fecha real de la tasa (puede ser viernes en fin de semana)
        const rawDate = bcvEntry?.fechaActualizacion ?? new Date().toISOString();
        const rateDate = rawDate.slice(0, 10); // 'YYYY-MM-DD'

        // 3. Guardar en KV (solo si el binding está disponible)
        if (env.RATES_HISTORY) {
            const entry = JSON.stringify({ bcv, binance, euro, savedAt: new Date().toISOString() });
            // TTL de 30 días (en segundos)
            await env.RATES_HISTORY.put(rateDate, entry, { expirationTtl: 60 * 60 * 24 * 30 });
        }

        // 4. Responder
        const payload = { bcv, binance, euro, rateDate, updatedAt: new Date().toISOString() };
        return new Response(JSON.stringify(payload), { status: 200, headers: CORS_HEADERS });

    } catch (err) {
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: CORS_HEADERS }
        );
    }
}
