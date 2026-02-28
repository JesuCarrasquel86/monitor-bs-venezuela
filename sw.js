/* ============================================================
   SERVICE WORKER – Monitor Dólar Venezuela PWA
   Estrategia: Cache-First para assets, Network-First para APIs
   ============================================================ */

const CACHE_NAME = 'monitor-dolar-v1.4.0';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/lucide@latest'
];

// ── Instalación: precachear assets estáticos ──
self.addEventListener('install', (event) => {
    console.log('[SW] Instalando Service Worker...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Cacheando assets estáticos');
            // Cachear uno por uno para no fallar en bloque si algún CDN falla
            const cachePromises = STATIC_ASSETS.map(url =>
                cache.add(url).catch(err =>
                    console.warn(`[SW] No se pudo cachear: ${url}`, err)
                )
            );
            return Promise.allSettled(cachePromises);
        }).then(() => self.skipWaiting())
    );
});

// ── Activación: limpiar caches viejos ──
self.addEventListener('activate', (event) => {
    console.log('[SW] Service Worker activo');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => {
                        console.log('[SW] Eliminando cache viejo:', name);
                        return caches.delete(name);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// ── Fetch: Network-First para APIs, Cache-First para assets ──
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // APIs externas → Network-First (sin caché, datos en vivo)
    const isExternalApi =
        url.hostname.includes('pydolarvenezuela.com') ||
        url.hostname.includes('dolarapi.com');

    if (isExternalApi) {
        // No interceptar las APIs, dejar pasar directo
        return;
    }

    // Assets locales y CDNs → Cache-First con Network Fallback
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) {
                return cached;
            }
            return fetch(event.request).then(response => {
                // Solo cachear respuestas exitosas de recursos estáticos
                if (response && response.status === 200 && response.type !== 'opaque') {
                    const cloned = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
                }
                return response;
            }).catch(() => {
                // Si es una navegación y no hay red, devolver index.html
                if (event.request.mode === 'navigate') {
                    return caches.match('/index.html');
                }
            });
        })
    );
});

// ── Background Sync: reintentar actualización cuando vuelva la red ──
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-rates') {
        console.log('[SW] Background Sync: actualizando tasas...');
        // El cliente se encargará de la actualización cuando la red esté disponible
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                clients.forEach(client => client.postMessage({ type: 'SYNC_RATES' }));
            })
        );
    }
});

// ── Push Notifications (base para futuras alertas de tasa) ──
self.addEventListener('push', (event) => {
    if (!event.data) return;
    const data = event.data.json();
    event.waitUntil(
        self.registration.showNotification(data.title || 'Monitor Dólar', {
            body: data.body || 'La tasa del dólar ha cambiado.',
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-72.png',
            tag: 'rate-update',
            renotify: true,
        })
    );
});
