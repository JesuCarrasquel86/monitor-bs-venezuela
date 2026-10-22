/* ============================================================
   SERVICE WORKER – Bainas PWA v1.5.0
   Estrategia: Network-First para assets propios (siempre frescos)
               Cache-First para CDNs externos
   ============================================================ */

const CACHE_NAME = 'monitor-dolar-v3.4.4';
const OWN_ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json',
    '/icons/icon-96.png', '/icons/icon-192.png', '/icons/icon-512.png'];

// ── Instalación: skipWaiting inmediato ──
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.allSettled(OWN_ASSETS.map(url =>
                cache.add(url).catch(() => { })
            ))
        ).then(() => self.skipWaiting())   // ← toma control inmediato
    );
});

// ── Activación: limpiar todo caché viejo + claim ──
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())  // ← controla todas las tabs
    );
});

// ── Fetch ──
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // APIs externas y propias (/api/*) → dejar pasar directo (sin caché)
    // Antes solo se excluía dolarapi.com; /api/rates y /api/history caían
    // en la rama "Cache-First" de abajo y quedaban servidas desde caché
    // para siempre, por lo que las tasas no se refrescaban.
    if (url.hostname.includes('dolarapi.com') || url.pathname.startsWith('/api/')) return;

    const isOwnAsset = OWN_ASSETS.some(a => url.pathname === a || url.pathname === '/');

    if (isOwnAsset) {
        // Network-First: siempre busca la versión más nueva en la red
        event.respondWith(
            fetch(event.request).then(res => {
                const clone = res.clone();
                caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                return res;
            }).catch(() => caches.match(event.request))  // fallback offline
        );
    } else {
        // CDNs externos → Cache-First
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(res => {
                    if (res?.status === 200) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
                    }
                    return res;
                }).catch(() => {
                    if (event.request.mode === 'navigate') return caches.match('/index.html');
                });
            })
        );
    }
});

// ── Background Sync ──
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-rates') {
        event.waitUntil(
            self.clients.matchAll().then(clients =>
                clients.forEach(c => c.postMessage({ type: 'SYNC_RATES' }))
            )
        );
    }
});
