/**
 * _worker.js — Cloudflare Worker para monitor-bs-vz
 * ─────────────────────────────────────────────────────────────────
 * Maneja rutas /api/* con lógica de servidor.
 * Para todo lo demás, sirve los archivos estáticos del sitio
 * usando env.ASSETS (Cloudflare Pages) o fetch directo.
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

// ═══════════════════════════════════════════════════════
//  HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        // ── Rutas de API ────────────────────────────────────────
        if (url.pathname === '/api/rates') {
            return handleRates(request, env);
        }
        if (url.pathname === '/api/history') {
            return handleHistory(request, env);
        }
        if (url.pathname === '/api/seed') {
            return handleSeed(request, env);
        }

        // ── Archivos estáticos (Cloudflare Assets) ──────────────
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not found', { status: 404 });
    },
};

// ═══════════════════════════════════════════════════════
//  /api/rates — Tasas en tiempo real (BCV + Binance P2P)
// ═══════════════════════════════════════════════════════
async function handleRates(request, env) {
    try {
        // Fetch paralelo: BCV desde dolarapi + Binance P2P directo (en paralelo)
        const [bcvResult, binanceResult] = await Promise.allSettled([
            fetchBCV(),
            fetchBinanceP2P(),
        ]);

        const { bcv, euro, rateDate } =
            bcvResult.status === 'fulfilled' ? bcvResult.value : { bcv: 0, euro: 0, rateDate: null };

        if (!bcv || !euro) throw new Error('No se pudo obtener tasa BCV');

        let binance = binanceResult.status === 'fulfilled' ? binanceResult.value : null;
        let binanceSource = 'binance-p2p-direct';

        // Fallback paralelo → dolarapi
        if (!binance) {
            console.warn('[rates] Binance P2P falló, usando dolarapi paralelo');
            try {
                const res = await fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(6000) });
                if (res.ok) {
                    const j = await res.json();
                    binance = j.find(i => i.fuente === 'paralelo')?.promedio ?? 0;
                    binanceSource = 'dolarapi-paralelo-fallback';
                }
            } catch (_) { }
        }

        if (!binance) throw new Error('No se pudo obtener tasa paralela');

        const date = rateDate ?? new Date().toISOString().slice(0, 10);

        // Guardar en KV
        if (env.RATES_HISTORY) {
            await env.RATES_HISTORY.put(
                date,
                JSON.stringify({ bcv, binance, euro, savedAt: new Date().toISOString() }),
                { expirationTtl: 60 * 60 * 24 * 30 }
            );
        }

        return json({ bcv, binance, euro, rateDate: date, source: { bcv: 'dolarapi/BCV', binance: binanceSource, euro: 'dolarapi/BCV' }, updatedAt: new Date().toISOString() });
    } catch (err) {
        return json({ error: err.message }, 500);
    }
}

// ═══════════════════════════════════════════════════════
//  /api/history — Tasas históricas desde KV
// ═══════════════════════════════════════════════════════
async function handleHistory(request, env) {
    if (!env.RATES_HISTORY) return json({ error: 'KV no configurado' }, 503);

    const url = new URL(request.url);
    const date = url.searchParams.get('date');

    try {
        if (date) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
                return json({ error: 'Formato inválido. Usa YYYY-MM-DD' }, 400);

            const raw = await env.RATES_HISTORY.get(date);
            if (!raw) return json({ error: 'Sin datos para esa fecha', date }, 404);
            return json({ date, ...JSON.parse(raw) });
        }

        // Sin parámetro → devolver fechas disponibles (últimos 14 días)
        const dates = Array.from({ length: 14 }, (_, i) => {
            const d = new Date();
            d.setDate(d.getDate() - i);
            return d.toISOString().slice(0, 10);
        });

        const checks = await Promise.all(dates.map(async d => (await env.RATES_HISTORY.get(d)) ? d : null));
        const available = checks.filter(Boolean);
        return json({ available, total: available.length });

    } catch (err) {
        return json({ error: err.message }, 500);
    }
}

// ═══════════════════════════════════════════════════════
//  /api/seed — Pre-llenar KV con historial de brecha-cambiaria
// ═══════════════════════════════════════════════════════
async function handleSeed(request, env) {
    if (!env.RATES_HISTORY) return json({ error: 'KV no configurado' }, 503);

    const url = new URL(request.url);
    const force = url.searchParams.get('force') === '1';

    try {
        const res = await fetch('https://brecha-cambiaria.com/api/history?limit=10000',
            { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`brecha-cambiaria HTTP ${res.status}`);
        const json2 = await res.json();
        const records = json2?.data ?? [];

        if (!records.length) throw new Error('0 registros recibidos');

        // Agrupar por fecha Venezuela (UTC-4)
        const byDay = {};
        for (const r of records) {
            if (!r.timestamp || !r.bcv_usd || !r.usdt_avg) continue;
            const veDate = new Date(new Date(r.timestamp).getTime() - 4 * 60 * 60 * 1000);
            const key = veDate.toISOString().slice(0, 10);
            (byDay[key] = byDay[key] || []).push({ bcv: r.bcv_usd, binance: r.usdt_avg, euro: r.bcv_eur });
        }

        const results = [];
        for (const [day, recs] of Object.entries(byDay).sort()) {
            if (!force && await env.RATES_HISTORY.get(day)) {
                results.push({ day, status: 'skip' });
                continue;
            }
            const avg = key => Math.round(recs.reduce((s, r) => s + r[key], 0) / recs.length * 100) / 100;
            const entry = { bcv: avg('bcv'), binance: avg('binance'), euro: avg('euro'), savedAt: new Date().toISOString(), source: `seed:${recs.length}records` };
            await env.RATES_HISTORY.put(day, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 60 });
            results.push({ day, status: 'saved', ...entry });
        }

        return json({ success: true, totalRecords: records.length, days: Object.keys(byDay).sort(), results });
    } catch (err) {
        return json({ error: err.message }, 500);
    }
}

// ═══════════════════════════════════════════════════════
//  Helpers de fetch
// ═══════════════════════════════════════════════════════
async function fetchBCV() {
    const [resUSD, resEUR] = await Promise.all([
        fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(8000) }),
        fetch('https://ve.dolarapi.com/v1/euros', { signal: AbortSignal.timeout(8000) }),
    ]);
    let bcv = 0, euro = 0, rateDate = null;
    if (resUSD.ok) {
        const j = await resUSD.json();
        const e = j.find(i => i.fuente === 'oficial');
        bcv = e?.promedio ?? 0;
        if (e?.fechaActualizacion) rateDate = e.fechaActualizacion.slice(0, 10);
    }
    if (resEUR.ok) {
        const j = await resEUR.json();
        euro = Array.isArray(j) ? (j.find(i => i.fuente === 'oficial')?.promedio ?? 0) : (j.promedio ?? 0);
    }
    return { bcv, euro, rateDate };
}

async function fetchBinanceP2P() {
    const res = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ asset: 'USDT', fiat: 'VES', merchantCheck: false, page: 1, payTypes: [], rows: 5, tradeType: 'BUY', publisherType: null }),
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Binance P2P ${res.status}`);
    const j = await res.json();
    const prices = (j?.data ?? []).map(a => parseFloat(a.adv?.price ?? '0')).filter(p => p > 0);
    if (!prices.length) throw new Error('Binance P2P: sin precios');
    return Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 100) / 100;
}

const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: CORS });
