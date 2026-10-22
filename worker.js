/* ============================================================
   Ruteo por dominio
   - bainas.app          → landing (solo la raíz)
   - app.bainas.app      → la app
   - *.workers.dev       → la app (enlace viejo, sigue funcionando)
   Todo lo demás se sirve tal cual desde los estáticos.
   ============================================================ */

const LANDING_HOST = 'bainas.app';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.hostname === `www.${LANDING_HOST}`) {
            url.hostname = LANDING_HOST;
            return Response.redirect(url.toString(), 301);
        }

        if (url.hostname === LANDING_HOST && (url.pathname === '/' || url.pathname === '/index.html')) {
            return env.ASSETS.fetch(new Request(new URL('/landing', url), request));
        }

        const res = await env.ASSETS.fetch(request);

        // Los enlaces *.workers.dev siguen funcionando, pero no deben salir en
        // Google como copia de app.bainas.app.
        if (url.hostname.endsWith('.workers.dev')) {
            const out = new Response(res.body, res);
            out.headers.set('X-Robots-Tag', 'noindex');
            return out;
        }
        return res;
    },
};
