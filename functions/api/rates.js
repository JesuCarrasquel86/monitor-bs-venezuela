/**
 * Cloudflare Pages Function: /api/rates  (v2)
 * ─────────────────────────────────────────────────────────────────
 * Fuentes en cascada (orden de prioridad):
 *   BCV oficial   → dolarapi.com/v1/dolares  (scrape oficial del BCV)
 *   Paralelo/USDT → Binance P2P API directa (sin CORS desde el servidor)
 *   Euro BCV      → dolarapi.com/v1/euros
 *
 * Guarda snapshot diario en KV (binding: RATES_HISTORY)
 * Devuelve JSON con headers CORS para el browser.
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

// ── Obtener tasa BCV oficial desde dolarapi ───────────────────────
async function fetchBCV() {
    const [resUSD, resEUR] = await Promise.all([
        fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(8000) }),
        fetch('https://ve.dolarapi.com/v1/euros', { signal: AbortSignal.timeout(8000) }),
    ]);

    let bcv = 0, euro = 0, rateDate = null;

    if (resUSD.ok) {
        const j = await resUSD.json();
        const entry = j.find(i => i.fuente === 'oficial');
        bcv = entry?.promedio ?? 0;
        const raw = entry?.fechaActualizacion;
        if (raw) rateDate = raw.slice(0, 10); // 'YYYY-MM-DD'
    }

    if (resEUR.ok) {
        const j = await resEUR.json();
        euro = Array.isArray(j)
            ? (j.find(i => i.fuente === 'oficial')?.promedio ?? 0)
            : (j.promedio ?? 0);
    }

    return { bcv, euro, rateDate };
}

// ── Obtener tasa Paralelo desde Binance P2P (directo) ─────────────
async function fetchBinanceP2P() {
    // Binance P2P: precio promedio de los 5 mejores anuncios de COMPRA de USDT en VES
    const body = JSON.stringify({
        asset: 'USDT',
        fiat: 'VES',
        merchantCheck: false,
        page: 1,
        payTypes: [],
        rows: 5,
        tradeType: 'BUY',   // desde perspectiva del comprador venezolano
        publisherType: null,
    });

    const res = await fetch(
        'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0',
            },
            body,
            signal: AbortSignal.timeout(8000),
        }
    );

    if (!res.ok) throw new Error(`Binance P2P HTTP ${res.status}`);
    const json = await res.json();

    const ads = json?.data ?? [];
    if (!ads.length) throw new Error('Binance P2P: sin anuncios');

    // Promedio de los precios de los primeros anuncios
    const prices = ads
        .map(ad => parseFloat(ad.adv?.price ?? '0'))
        .filter(p => p > 0);

    if (!prices.length) throw new Error('Binance P2P: precios no parseables');

    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return Math.round(avg * 100) / 100; // 2 decimales
}

// ── Handler principal ─────────────────────────────────────────────
export async function onRequest(context) {
    const { request, env } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    try {
        // Llamadas en paralelo: BCV + Binance P2P
        const [{ bcv, euro, rateDate }, binanceResult] = await Promise.allSettled([
            fetchBCV(),
            fetchBinanceP2P(),
        ]).then(([r1, r2]) => [
            r1.status === 'fulfilled' ? r1.value : { bcv: 0, euro: 0, rateDate: null },
            r2.status === 'fulfilled' ? r2.value : null,
        ]);

        if (!bcv || !euro) throw new Error('No se pudo obtener tasa BCV');

        // Si Binance P2P falló, usar la tasa paralela de dolarapi como fallback
        let binance = binanceResult;
        if (!binance) {
            console.warn('[rates] Binance P2P falló, usando dolarapi paralelo como fallback');
            const res = await fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(6000) });
            if (res.ok) {
                const j = await res.json();
                binance = j.find(i => i.fuente === 'paralelo')?.promedio ?? 0;
            }
        }

        if (!binance) throw new Error('No se pudo obtener tasa paralela');

        const date = rateDate ?? new Date().toISOString().slice(0, 10);
        const payload = {
            bcv,
            binance,
            euro,
            rateDate: date,
            source: {
                bcv: 'dolarapi/BCV',
                binance: binanceResult ? 'binance-p2p-direct' : 'dolarapi/paralelo-fallback',
                euro: 'dolarapi/BCV',
            },
            updatedAt: new Date().toISOString(),
        };

        // Guardar en KV
        if (env.RATES_HISTORY) {
            await env.RATES_HISTORY.put(
                date,
                JSON.stringify({ bcv, binance, euro, savedAt: payload.updatedAt }),
                { expirationTtl: 60 * 60 * 24 * 30 }
            );
        }

        return new Response(JSON.stringify(payload), { status: 200, headers: CORS });

    } catch (err) {
        console.error('[rates]', err.message);
        return new Response(
            JSON.stringify({ error: err.message }),
            { status: 500, headers: CORS }
        );
    }
}
