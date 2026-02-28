/* ============================================================
   app.js – Monitor Dólar Venezuela PWA
   Lógica de negocio + Dark/Light Mode + Service Worker
   ============================================================ */

'use strict';

// ── Contenido de los tooltips ─────────────────────────────────
const TIPS = {
    'cantidad': {
        title: '¿Qué es la Cantidad?',
        body: 'Es el monto en divisas (USD o EUR) que quieres convertir. Por ejemplo, si colocas 5, la app te muestra cuántos Bolívares equivalen a 5 dólares o 5 euros a cada tasa, y cuántos USDT necesitas retirar de Binance para cubrir ese monto.'
    },
    'usdt': {
        title: '¿Qué significa "Debes sacar en Binance"?',
        body: 'Es la cantidad de USDT que necesitas vender en Binance P2P para obtener los Bolívares equivalentes al monto que colocaste, pero calculado a la tasa oficial BCV. Divide el total en Bs. (a tasa BCV) entre la tasa del mercado paralelo para darte el equivalente real en USDT.'
    },
    'bcv': {
        title: '¿Qué es la tasa BCV?',
        body: 'Es la tasa oficial publicada por el Banco Central de Venezuela (BCV). Sirve como referencia legal para transacciones formales. Es la tasa que usan bancos, nóminas y contratos. Generalmente es más baja que la tasa del mercado paralelo.'
    },
    'binance': {
        title: '¿Qué es la tasa Binance (Paralelo)?',
        body: 'Es el precio del dólar en el mercado libre, obtenido a partir del mercado P2P de Binance en Venezuela. Refleja el precio real al que puedes comprar o vender USDT (dólares digitales) hoy. Suele ser más alta que el BCV porque no está regulada.'
    },
    'euro': {
        title: '¿Qué es el Euro BCV?',
        body: 'Es la tasa oficial del Euro publicada por el Banco Central de Venezuela. Es la referencia legal para transacciones en euros dentro del territorio venezolano. Se actualiza diariamente igual que la tasa del dólar BCV.'
    },
    'brecha': {
        title: '¿Qué es la Brecha?',
        body: 'Es la diferencia entre la tasa del mercado paralelo (Binance) y la tasa oficial BCV. Se expresa en Bs. y en porcentaje (%). Un 44% de brecha significa que el dólar en el mercado libre cuesta 44% más que el dólar oficial. Es un indicador clave de la distorsión cambiaria.'
    },
    'euro-usdt': {
        title: '¿Qué es Euro en USDT?',
        body: 'Es la cantidad de USDT que necesitas vender en Binance para obtener los Bolívares que equivalen al monto en Euros a tasa BCV. Útil cuando recibes pagos en euros y necesitas saber cuánto USDT retirar para cubrir esa cantidad en Bs.'
    }
};

// ── Setup tooltips ────────────────────────────────────────────
const setupTooltips = () => {
    const overlay = document.getElementById('tooltip-overlay');
    const title = document.getElementById('tooltip-title');
    const body = document.getElementById('tooltip-body');
    const closeBtn = document.getElementById('tooltip-close');

    const showTip = (key) => {
        const tip = TIPS[key];
        if (!tip) return;
        title.textContent = tip.title;
        body.textContent = tip.body;
        overlay.classList.remove('hidden');
        overlay.setAttribute('aria-hidden', 'false');
    };

    const hideTip = () => {
        overlay.classList.add('hidden');
        overlay.setAttribute('aria-hidden', 'true');
    };

    // Cerrar con botón X
    closeBtn?.addEventListener('click', hideTip);

    // Cerrar al tocar el fondo oscuro (fuera del sheet)
    overlay?.addEventListener('click', (e) => {
        if (e.target === overlay) hideTip();
    });

    // Cerrar con Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideTip();
    });

    // Asignar a todos los botones ?
    document.querySelectorAll('.help-btn[data-tip]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            showTip(btn.dataset.tip);
            lucide.createIcons();
        });
    });
};


let data = { bcv: 419.99, binance: 604.78, euro: 495.61, amount: 1 };
let isEditing = false;
let isLoading = false;
let deferredInstallPrompt = null;

// ── Formato número venezolano ─────────────────────────────────
const formatBs = (val) =>
    new Intl.NumberFormat('es-VE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(val);

const formatUsdt = (val) =>
    new Intl.NumberFormat('es-VE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4
    }).format(val);

// ── Persistencia ─────────────────────────────────────────────
const STORAGE_KEY = 'monitor-dolar-data';
const THEME_KEY = 'monitor-dolar-theme';

const saveToStorage = () => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            bcv: data.bcv, binance: data.binance, euro: data.euro,
            savedAt: new Date().toISOString()
        }));
    } catch (e) { }
};

const loadFromStorage = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const stored = JSON.parse(raw);
        if (stored.bcv && stored.binance && stored.euro) {
            data = { ...data, ...stored };
            return true;
        }
    } catch (e) { }
    return false;
};

// ── Dark / Light Mode ─────────────────────────────────────────
const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);

    // Actualizar ícono del botón
    const iconTheme = document.getElementById('icon-theme');
    if (iconTheme) {
        iconTheme.setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
    }
    // Actualizar meta theme-color
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
        metaTheme.content = theme === 'dark' ? '#0c0e12' : '#f0f2f5';
    }
    lucide.createIcons();
};

const setupThemeToggle = () => {
    // Cargar tema guardado o preferencia del sistema
    const saved = localStorage.getItem(THEME_KEY);
    const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(saved || preferred);

    document.getElementById('btn-theme')?.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });
};

// ── Animación pop ─────────────────────────────────────────────
const popElement = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('value-updated');
    void el.offsetWidth;
    el.classList.add('value-updated');
};

// ── Actualizar UI ─────────────────────────────────────────────
const updateUI = () => {
    const totalBcv = data.bcv * data.amount;
    const totalBinance = data.binance * data.amount;
    const totalEuro = data.euro * data.amount;
    const diffBs = totalBinance - totalBcv;
    const diffPct = data.bcv > 0 ? (((data.binance - data.bcv) / data.bcv) * 100) : 0;
    const eqUsdt = data.binance > 0 ? (totalBcv / data.binance) : 0;
    const eqUsdtEuro = data.binance > 0 ? (totalEuro / data.binance) : 0;

    const ph = '--';
    const fmt = (v) => isLoading ? ph : formatBs(v);

    // Totales
    set('total-bcv', fmt(totalBcv));
    set('total-euro', fmt(totalEuro));
    set('total-binance', fmt(totalBinance));

    // Bases
    set('base-bcv', formatBs(data.bcv));
    set('base-euro', formatBs(data.euro));
    set('base-binance', formatBs(data.binance));

    // Análisis
    set('diff-bs', isLoading ? ph : `+ ${formatBs(diffBs)}`);
    set('diff-pct', isLoading ? ph : `+${diffPct.toFixed(2)}%`);
    set('eq-usdt', isLoading ? ph : `${formatUsdt(eqUsdt)} USDT`);
    set('eq-usdt-euro', isLoading ? ph : `${formatUsdt(eqUsdtEuro)} USDT`);

    if (!isLoading) {
        ['total-bcv', 'total-euro', 'total-binance', 'diff-bs', 'diff-pct', 'eq-usdt', 'eq-usdt-euro']
            .forEach(id => popElement(id));
    }

    // Inputs de edición
    setVal('input-bcv', data.bcv);
    setVal('input-euro', data.euro);
    setVal('input-binance', data.binance);

    // Toggle vista/edición
    ['bcv', 'euro', 'binance'].forEach(k => {
        const view = document.getElementById(`view-${k}`);
        const edit = document.getElementById(`edit-${k}`);
        if (view) view.style.display = isEditing ? 'none' : '';
        if (edit) edit.style.display = isEditing ? '' : 'none';
    });

    // Botón editar
    const btnEdit = document.getElementById('btn-edit');
    if (btnEdit) {
        if (isEditing) {
            btnEdit.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
            btnEdit.classList.add('active');
            set('text-update', 'Edición manual activa');
        } else {
            btnEdit.innerHTML = '<i data-lucide="edit-2" class="w-4 h-4"></i>';
            btnEdit.classList.remove('active');
        }
    }

    lucide.createIcons();
};

// ── Helpers DOM ───────────────────────────────────────────────
const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

// ── Error ─────────────────────────────────────────────────────
const showError = (msg) => {
    const wrapper = document.getElementById('error-msg');
    const text = document.getElementById('error-text');
    if (!wrapper || !text) return;
    text.textContent = msg || '';
    wrapper.style.display = msg ? 'flex' : 'none';
};

// ── Estado de carga ───────────────────────────────────────────
const setLoadState = (state) => {
    isLoading = state;
    const iconRefresh = document.getElementById('icon-refresh');
    const iconMain = document.getElementById('icon-main');
    const textMain = document.getElementById('text-main');

    if (state) {
        iconRefresh?.classList.add('animate-spin');
        iconMain?.classList.add('animate-spin');
        iconMain?.setAttribute('data-lucide', 'refresh-cw');
        if (textMain) textMain.textContent = 'Actualizando...';
        set('text-update', 'Buscando tasas...');
    } else {
        iconRefresh?.classList.remove('animate-spin');
        iconMain?.classList.remove('animate-spin');
        iconMain?.setAttribute('data-lucide', 'calculator');
        if (textMain) textMain.textContent = 'Actualizar Monitor';
        if (!isEditing) {
            const now = new Date();
            set('text-update',
                `Hoy ${now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true })}`
            );
        }
        saveToStorage();
    }
    lucide.createIcons();
    updateUI();
};

// ── Fetch de tasas ────────────────────────────────────────────
const fetchData = async () => {
    if (isEditing) return;
    if (!navigator.onLine) {
        showError('Sin conexión. Mostrando últimas tasas guardadas.');
        updateUI();
        return;
    }

    setLoadState(true);
    showError(null);

    try {
        let bcv = 0, paralelo = 0, euro = 0;

        const resUSD = await fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(10000) });
        if (!resUSD.ok) throw new Error(`HTTP ${resUSD.status}`);
        const jUSD = await resUSD.json();
        bcv = jUSD.find(i => i.fuente === 'oficial')?.promedio || 0;
        paralelo = jUSD.find(i => i.fuente === 'paralelo')?.promedio || 0;

        const resEUR = await fetch('https://ve.dolarapi.com/v1/euros', { signal: AbortSignal.timeout(10000) });
        if (!resEUR.ok) throw new Error(`HTTP ${resEUR.status}`);
        const jEUR = await resEUR.json();
        euro = Array.isArray(jEUR)
            ? (jEUR.find(i => i.fuente === 'oficial')?.promedio || 0)
            : (jEUR.promedio || 0);

        if (!bcv || !paralelo || !euro) throw new Error('Datos incompletos');

        data = { ...data, bcv, binance: paralelo, euro };

    } catch (err) {
        console.error('[fetchData]', err.message);
        showError('No se obtuvieron tasas. Usa ✏️ para editarlas manualmente.');
        if (!loadFromStorage()) {
            data = { ...data, bcv: 419.99, binance: 604.78, euro: 495.61 };
        }
    } finally {
        setLoadState(false);
    }
};

// ── Online/Offline ────────────────────────────────────────────
const updateOnlineStatus = () => {
    const badge = document.getElementById('offline-badge');
    if (!badge) return;
    badge.style.display = navigator.onLine ? 'none' : 'flex';
};

// ── Instalar banner PWA ───────────────────────────────────────
const setupInstallBanner = () => {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (!localStorage.getItem('pwa-install-dismissed')) {
            const banner = document.getElementById('install-banner');
            if (banner) { banner.classList.remove('hidden'); lucide.createIcons(); }
        }
    });
    document.getElementById('btn-install')?.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        hideBanner();
    });
    document.getElementById('btn-install-dismiss')?.addEventListener('click', () => {
        localStorage.setItem('pwa-install-dismissed', '1');
        hideBanner();
    });
    window.addEventListener('appinstalled', hideBanner);
};

const hideBanner = () => {
    const banner = document.getElementById('install-banner');
    if (!banner) return;
    banner.classList.add('hide');
    setTimeout(() => banner.classList.add('hidden'), 350);
};

// ── Service Worker ────────────────────────────────────────────
const registerServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data?.type === 'SYNC_RATES') fetchData();
        });
        if ('SyncManager' in window) reg.sync.register('sync-rates').catch(() => { });
    } catch (err) { console.warn('[SW]', err); }
};

// ── Event Listeners ───────────────────────────────────────────
const setupEventListeners = () => {
    document.getElementById('input-amount')?.addEventListener('input', (e) => {
        data.amount = Number(e.target.value) || 0;
        updateUI();
    });

    ['bcv', 'euro', 'binance'].forEach(k => {
        document.getElementById(`input-${k}`)?.addEventListener('input', (e) => {
            data[k] = Number(e.target.value) || 0;
            updateUI();
        });
    });

    document.getElementById('btn-edit')?.addEventListener('click', () => {
        isEditing = !isEditing;
        updateUI();
    });

    document.getElementById('btn-refresh')?.addEventListener('click', fetchData);
    document.getElementById('btn-main')?.addEventListener('click', fetchData);

    window.addEventListener('online', () => { updateOnlineStatus(); fetchData(); });
    window.addEventListener('offline', updateOnlineStatus);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || isEditing) return;
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        try {
            const { savedAt } = JSON.parse(raw);
            if (Date.now() - new Date(savedAt).getTime() > 5 * 60 * 1000) fetchData();
        } catch { fetchData(); }
    });
};

// ── Init ──────────────────────────────────────────────────────
const init = () => {
    setupThemeToggle();
    lucide.createIcons();
    updateOnlineStatus();
    setupEventListeners();
    setupInstallBanner();
    setupTooltips();
    registerServiceWorker();

    if (loadFromStorage()) {
        updateUI();
        set('text-update', 'Cargando tasas...');
    }
    fetchData();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
