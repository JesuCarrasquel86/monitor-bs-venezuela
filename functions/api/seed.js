/**
 * Cloudflare Pages Function: /api/seed
 * ─────────────────────────────────────────────────────────────────
 * Uso único: rellena el KV (RATES_HISTORY) con datos históricos
 * reales obtenidos de brecha-cambiaria.com/api/history.
 *
 * Llama a este endpoint UNA sola vez desde el navegador o cURL:
 *   GET https://tu-app.pages.dev/api/seed
 *   GET https://tu-app.pages.dev/api/seed?force=1  ← sobrescribe días existentes
 *
 * Protegido con un token secreto para evitar uso no autorizado.
 * Configura la variable de entorno SECRET_SEED_TOKEN en CF Pages.
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
};

// Cuántos registros pedir a brecha-cambiaria (máx disponible: ~20.000)
const BATCH_SIZE = 10000;

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // ── Protección básica con token ──────────────────────────────
    // Configura SECRET_SEED_TOKEN en CF Pages > Settings > Environment Variables
    const token = url.searchParams.get('token');
    if (env.SECRET_SEED_TOKEN && token !== env.SECRET_SEED_TOKEN) {
        return new Response(
            JSON.stringify({ error: 'Acceso denegado. Pasa ?token=TU_TOKEN' }),
            { status: 401, headers: CORS }
        );
    }

    const force = url.searchParams.get('force') === '1';

    if (!env.RATES_HISTORY) {
        return new Response(
            JSON.stringify({ error: 'KV binding RATES_HISTORY no configurado' }),
            { status: 503, headers: CORS }
        );
    }

    try {
        // ── 1. Obtener datos de brecha-cambiaria.com ─────────────
        console.log(`[seed] Fetching ${BATCH_SIZE} records from brecha-cambiaria.com...`);
        const res = await fetch(
            `https://brecha-cambiaria.com/api/history?limit=${BATCH_SIZE}`,
            { signal: AbortSignal.timeout(30000) }
        );
        if (!res.ok) throw new Error(`brecha-cambiaria HTTP ${res.status}`);
        const json = await res.json();
        const records = json?.data ?? [];

        console.log(`[seed] Got ${records.length} records (total available: ${json.total})`);

        if (!records.length) throw new Error('brecha-cambiaria devolvió 0 registros');

        // ── 2. Agrupar por fecha YYYY-MM-DD ──────────────────────
        const byDay = {};
        for (const r of records) {
            if (!r.timestamp || !r.bcv_usd || !r.usdt_avg) continue;
            // timestamp es UTC, convertir a fecha VE (UTC-4)
            const utcDate = new Date(r.timestamp);
            const veDate = new Date(utcDate.getTime() - 4 * 60 * 60 * 1000);
            const dayKey = veDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'

            if (!byDay[dayKey]) byDay[dayKey] = [];
            byDay[dayKey].push({
                bcv: r.bcv_usd,
                binance: r.usdt_avg,
                euro: r.bcv_eur,
            });
        }

        const days = Object.keys(byDay).sort();
        console.log(`[seed] Days found in data: ${days.join(', ')}`);

        // ── 3. Calcular promedio por día y guardar en KV ─────────
        const results = [];
        for (const day of days) {
            // Si ya existe y no forzamos, saltar
            if (!force) {
                const existing = await env.RATES_HISTORY.get(day);
                if (existing) {
                    results.push({ day, status: 'skipped (already exists)' });
                    continue;
                }
            }

            const recs = byDay[day];
            const avg = (arr, key) =>
                Math.round((arr.reduce((s, r) => s + r[key], 0) / arr.length) * 100) / 100;

            const entry = {
                bcv: avg(recs, 'bcv'),
                binance: avg(recs, 'binance'),
                euro: avg(recs, 'euro'),
                savedAt: new Date().toISOString(),
                source: `seed:brecha-cambiaria (${recs.length} records)`,
            };

            await env.RATES_HISTORY.put(
                day,
                JSON.stringify(entry),
                { expirationTtl: 60 * 60 * 24 * 60 } // 60 días
            );

            results.push({ day, status: 'saved', records: recs.length, ...entry });
            console.log(`[seed] Saved ${day}: BCV=${entry.bcv} Binance=${entry.binance} EUR=${entry.euro}`);
        }

        return new Response(
            JSON.stringify({
                success: true,
                totalRecordsFetched: records.length,
                daysProcessed: results.length,
                daysAvailable: days,
                results,
            }, null, 2),
            { status: 200, headers: CORS }
        );

    } catch (err) {
        console.error('[seed]', err.message);
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: CORS }
        );
    }
}
