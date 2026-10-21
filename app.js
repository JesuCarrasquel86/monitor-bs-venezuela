/* ============================================================
   app.js – Monitor Bs. (PWA)
   ============================================================ */

'use strict';

const APP_VERSION = '3.2.0';
console.log(`monitor-bs-vz v${APP_VERSION} starting...`);

// ── Claves de almacenamiento (se conservan las de versiones anteriores) ──
const KEYS = {
    data: 'monitor-dolar-data',
    theme: 'monitor-dolar-theme',
    accent: 'monitor-dolar-accent',
    history: 'monitor-dolar-history',
    historicosAt: 'monitor-dolar-historicos-at',
    customRate: 'monitor-dolar-custom-rate',
    calcHistory: 'monitor-dolar-calc-history',
    gapThreshold: 'monitor-dolar-gap-threshold',
    gapAlertSent: 'monitor-dolar-gap-alert-sent',
    notifications: 'notifications-enabled',
    view: 'monitor-dolar-view',
    currency: 'monitor-dolar-currency',
    usdtMode: 'monitor-dolar-usdt-mode',
    share: 'monitor-dolar-share',
    profiles: 'monitor-dolar-pay-profiles',
    onboarding: 'monitor-dolar-onboarding-done',
    whatsNew: 'monitor-dolar-whats-new-seen',
    dayChoice: 'monitor-dolar-day-choice',
    autoNext: 'monitor-dolar-auto-next',
};

// localStorage puede fallar (modo privado, cuota llena): nunca debe romper la app
const store = {
    get(key, fallback = null) {
        try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(key, value); } catch (e) { }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) { }
    },
    getJSON(key, fallback) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
    },
    setJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
    },
};

// ── Estado ────────────────────────────────────────────────────
const DEFAULT_RATES = { bcv: 419.99, binance: 604.78, euro: 495.61 };
const DOLARAPI = 'https://ve.dolarapi.com/v1';
const HISTORY_DAYS = 120;

let data = { ...DEFAULT_RATES, amount: 1 };
let inputCurrency = 'usd';  // moneda en la que se escribe el monto: 'usd' | 'eur' | 'bs'
let lastForeign = 'usd';    // última divisa usada, para volver desde Bs con el botón de dirección
let isLoading = false;
let rateDate = null;        // fecha oficial de la tasa BCV vigente (Date)
let lastFetchAt = null;     // momento de la última consulta exitosa (Date)
let hasFetchedOnce = false; // evita comparar la 1ra tasa real contra los valores placeholder
let sessionPrev = null;     // tasas antes de la última consulta de esta sesión
let prevRates = null;       // tasas anteriores según el historial
let nextRates = null;       // tasa BCV del siguiente día hábil, si ya fue publicada
let useNext = false;        // el usuario eligió calcular con la tasa del día siguiente
let usdtMode = 'sell';      // 'sell' | 'buy' en Binance
let binanceQuotes = null;   // { buy, sell }: precio P2P para comprar y para vender USDT
let lastUsdtNeeded = 0;
let customRate = { enabled: false, name: 'Mi tasa', value: 0 };
let viewMode = 'grid';
let deferredInstallPrompt = null;

const CURRENCY = {
    usd: { sym: '$', name: 'Dólares' },
    eur: { sym: '€', name: 'Euros' },
    bs: { sym: 'Bs', name: 'Bolívares' },
};

const RATE_DEFS = {
    bcv: { title: 'BCV Dólar', chip: 'BCV $', icon: 'dollar-sign', color: 'green', sym: '$' },
    euro: { title: 'BCV Euro', chip: 'BCV €', icon: 'euro', color: 'blue', sym: '€' },
    binance: { title: 'Binance P2P', chip: 'P2P', icon: 'wallet', color: 'yellow', sym: 'USDT' },
    custom: { title: 'Personalizada', chip: 'Mía', icon: 'tag', color: 'purple', sym: '$' },
};

const CARD_ORDER = ['bcv', 'euro', 'binance', 'gap', 'custom'];

// ── Formato (es-VE: 1.234,56) ─────────────────────────────────
const numberFormat = (min, max) => new Intl.NumberFormat('es-VE', { minimumFractionDigits: min, maximumFractionDigits: max });
const NF0 = numberFormat(0, 0);
const NF2 = numberFormat(2, 2);
const NF24 = numberFormat(2, 4);
const NF06 = numberFormat(0, 6);

const formatBs = (v) => NF2.format(v);
const formatUsdt = (v) => NF24.format(v);
const formatCalc = (v) => NF06.format(v);

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const toDateKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

const dateFromKey = (key) => new Date(`${key}T12:00:00`);
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

const formatDayMonthYear = (d) =>
    `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

const formatLongDate = (d) => `${cap(d.toLocaleDateString('es-VE', { weekday: 'long' }))}, ${formatDayMonthYear(d)}`;

const formatShortDay = (d) =>
    `${cap(d.toLocaleDateString('es-VE', { weekday: 'short' }).replace('.', ''))} ${String(d.getDate()).padStart(2, '0')}`;

const formatTime = (d) => d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });

const formatRelative = (d) => (toDateKey(d) === toDateKey(new Date()) ? `Hoy, ${formatTime(d)}` : formatLongDate(d));

// Acepta "1.234,56", "1234,56", "1234.56" y "60.41"
const parseLocaleNumber = (input) => {
    if (input === null || input === undefined) return NaN;
    let s = String(input).trim().replace(/[^\d.,-]/g, '');
    if (!s) return NaN;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
        s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (lastComma > -1) {
        s = s.split(',').length > 2 ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (lastDot > -1) {
        const isThousands = s.split('.').length > 2 || /^-?[1-9]\d{0,2}\.\d{3}$/.test(s);
        if (isThousands) s = s.replace(/\./g, '');
    }
    return parseFloat(s);
};

// ── Plataforma ────────────────────────────────────────────────
const isAndroid = () => /Android/i.test(navigator.userAgent);
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSamsungInternet = () => /SamsungBrowser/i.test(navigator.userAgent) && isAndroid();
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ── DOM ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
const refreshIcons = () => { if (window.lucide) window.lucide.createIcons(); };

const popElement = (id) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('value-updated');
    void el.offsetWidth;
    el.classList.add('value-updated');
};

// Arma un párrafo con partes de texto y <strong>, sin usar innerHTML
const fillRichText = (el, parts) => {
    if (!el) return;
    el.textContent = '';
    parts.forEach((p) => {
        if (typeof p === 'string') { el.append(p); return; }
        const strong = document.createElement('strong');
        strong.textContent = p.strong;
        el.append(strong);
    });
};

// ── Animaciones ───────────────────────────────────────────────
const prefersReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const EASE_OUT = 'cubic-bezier(0.32, 0.72, 0, 1)';

// Ejecuta `done` al terminar la animación CSS del elemento (o tras `ms` por si no hay evento)
const afterAnimation = (el, ms, done) => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; done(); };
    el.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, ms);
};

const isShown = (el) => !!el && !el.classList.contains('hidden') && !el.classList.contains('anim-out');

// Muestra con un fundido y un leve deslizamiento
const showAnimated = (el) => {
    if (!el) return;
    if (!el.classList.contains('hidden') && !el.classList.contains('anim-out')) return;
    el.classList.remove('hidden', 'anim-out');
    if (prefersReducedMotion()) return;
    el.classList.remove('anim-in');
    void el.offsetWidth;
    el.classList.add('anim-in');
    afterAnimation(el, 300, () => el.classList.remove('anim-in'));
};

// Oculta con un fundido; el elemento queda "hidden" al terminar
const hideAnimated = (el) => {
    if (!isShown(el)) return;
    if (prefersReducedMotion()) { el.classList.add('hidden'); return; }
    el.classList.remove('anim-in');
    el.classList.add('anim-out');
    afterAnimation(el, 220, () => {
        if (!el.classList.contains('anim-out')) return; // se volvió a mostrar entretanto
        el.classList.remove('anim-out');
        el.classList.add('hidden');
    });
};

const setShownAnimated = (el, shown) => (shown ? showAnimated(el) : hideAnimated(el));

// Para contenidos que se reemplazan: lo viejo sale al instante y lo nuevo entra animado
const swapAnimated = (hideEl, showEl) => {
    hideEl?.classList.remove('anim-in', 'anim-out');
    hideEl?.classList.add('hidden');
    showAnimated(showEl);
};

// FLIP: mide, cambia el layout y anima cada elemento desde su posición anterior
const flipAnimate = (elements, mutate, { fade = [] } = {}) => {
    const els = elements.filter(Boolean);
    if (prefersReducedMotion() || !Element.prototype.animate) { mutate(); return; }
    const first = els.map((el) => el.getBoundingClientRect());
    mutate();
    els.forEach((el, i) => {
        const last = el.getBoundingClientRect();
        const dx = first[i].left - last.left;
        const dy = first[i].top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        const frames = [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }];
        if (fade.includes(el)) { frames[0].opacity = 0.55; frames[1].opacity = 1; }
        el.animate(frames, { duration: 420, easing: EASE_OUT });
    });
};

// ── Toast + portapapeles ──────────────────────────────────────
let toastTimer = null;
const showToast = (msg, isError = false, ms = 2200) => {
    const el = $('toast');
    if (!el) return;
    setText('toast-text', msg);
    el.classList.toggle('error', isError);
    el.classList.remove('hidden', 'is-hiding');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        if (prefersReducedMotion()) { el.classList.add('hidden'); return; }
        el.classList.add('is-hiding');
        afterAnimation(el, 260, () => {
            if (!el.classList.contains('is-hiding')) return;
            el.classList.remove('is-hiding');
            el.classList.add('hidden');
        });
    }, ms);
};

const copyText = async (text, msg) => {
    try {
        await navigator.clipboard.writeText(text);
        if (msg) showToast(msg);
        return true;
    } catch (e) {
        showToast('No se pudo copiar', true);
        return false;
    }
};

const readClipboardNumber = async () => {
    try {
        const n = parseLocaleNumber(await navigator.clipboard.readText());
        if (!Number.isFinite(n)) { showToast('El portapapeles no tiene un número', true); return null; }
        return n;
    } catch (e) {
        showToast('No se pudo leer el portapapeles', true);
        return null;
    }
};

// ── Cálculos ──────────────────────────────────────────────────
// Tasas con las que se calcula: las de hoy, o las del día siguiente si se eligió
const rates = () => (useNext && nextRates
    ? { bcv: nextRates.bcv, euro: nextRates.euro || data.euro, binance: data.binance }
    : { bcv: data.bcv, euro: data.euro, binance: data.binance });

const isBsMode = () => inputCurrency === 'bs';
const officialRate = () => (inputCurrency === 'eur' ? rates().euro : rates().bcv);
const getRate = (key) => (key === 'custom' ? customRate.value : rates()[key]);
const rateTitle = (key) => (key === 'custom' ? (customRate.name || 'Personalizada') : RATE_DEFS[key].title);
const chipTitle = (key) => (key === 'custom' ? (customRate.name || 'Mía').slice(0, 12) : RATE_DEFS[key].chip);

const cardTotal = (key) => {
    const rate = getRate(key);
    if (!rate) return 0;
    return isBsMode() ? data.amount / rate : data.amount * rate;
};

const cardSuffix = (key) => (isBsMode() ? RATE_DEFS[key].sym : 'Bs');
const formatCardTotal = (key) => (isBsMode() ? formatUsdt(cardTotal(key)) : formatBs(cardTotal(key)));

const amountLabel = () => `${formatBs(data.amount)} ${CURRENCY[inputCurrency].sym}`;

// Monto expresado en Bs a tasa oficial (lo que se quiere cubrir)
const amountInBsOfficial = () => (isBsMode() ? data.amount : data.amount * officialRate());

const gapPercent = (bcv = rates().bcv, binance = rates().binance) => (bcv > 0 ? ((binance - bcv) / bcv) * 100 : 0);

const pctChange = (prev, curr) => (prev > 0 && curr > 0 ? ((curr - prev) / prev) * 100 : null);

const prevFor = (key) => {
    // Con la tasa de mañana, "Antes" es la vigente hoy
    if (useNext && nextRates && (key === 'bcv' || key === 'euro')) return data[key];
    return (prevRates && prevRates[key]) || (sessionPrev && sessionPrev[key]) || null;
};

const nextDayLabel = () => {
    if (!nextRates) return '';
    return nextRates.key === toDateKey(addDays(new Date(), 1)) ? 'Mañana' : formatShortDay(nextRates.date);
};

const officialRatePhrase = () => {
    if (!(useNext && nextRates)) return 'a tasa BCV';
    const label = nextDayLabel();
    return label === 'Mañana' ? 'a tasa BCV de mañana' : `a tasa BCV del ${label}`;
};

// ── Persistencia de tasas ─────────────────────────────────────
const saveToStorage = () => {
    store.setJSON(KEYS.data, {
        bcv: data.bcv,
        binance: data.binance,
        euro: data.euro,
        rateDate: rateDate ? toDateKey(rateDate) : null,
        quotes: binanceQuotes,
        savedAt: (lastFetchAt || new Date()).toISOString(),
    });
};

const loadFromStorage = () => {
    const stored = store.getJSON(KEYS.data, null);
    if (!stored || !stored.bcv || !stored.binance || !stored.euro) return false;
    data = { ...data, bcv: stored.bcv, binance: stored.binance, euro: stored.euro };
    if (stored.rateDate) rateDate = dateFromKey(stored.rateDate);
    if (stored.savedAt) lastFetchAt = new Date(stored.savedAt);
    if (stored.quotes && stored.quotes.buy > 0 && stored.quotes.sell > 0) binanceQuotes = stored.quotes;
    hasFetchedOnce = true;
    return true;
};

// ── Historial diario de tasas ─────────────────────────────────
// { 'YYYY-MM-DD': { bcv?, euro?, binance? } }. El BCV solo publica días hábiles.
const mergeHistory = (updates) => {
    const history = store.getJSON(KEYS.history, {}) || {};
    Object.entries(updates).forEach(([key, values]) => {
        history[key] = { ...(history[key] || {}), ...values };
    });
    const trimmed = {};
    Object.keys(history).sort().slice(-HISTORY_DAYS).forEach((k) => { trimmed[k] = history[k]; });
    store.setJSON(KEYS.history, trimmed);
};

const getAllHistoryEntries = () => {
    const history = store.getJSON(KEYS.history, {}) || {};
    const num = (v) => (typeof v === 'number' && v > 0 ? v : null);
    return Object.entries(history)
        .map(([date, v]) => ({ date, bcv: num(v && v.bcv), binance: num(v && v.binance), euro: num(v && v.euro) }))
        .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && (e.bcv || e.binance || e.euro))
        .sort((a, b) => b.date.localeCompare(a.date));
};

// Calcula "Antes" (tasa previa) y si ya hay tasa del día siguiente publicada
const refreshDerivedRates = () => {
    const entries = getAllHistoryEntries();
    const officialKey = toDateKey(rateDate || new Date());
    const todayKey = toDateKey(new Date());
    const findPrev = (field, before) => {
        const e = entries.find((x) => x.date < before && x[field]);
        return e ? e[field] : null;
    };
    prevRates = {
        bcv: findPrev('bcv', officialKey),
        euro: findPrev('euro', officialKey),
        binance: findPrev('binance', todayKey),
    };

    const future = entries.filter((e) => e.date > officialKey && e.bcv).sort((a, b) => a.date.localeCompare(b.date))[0];
    nextRates = future ? { key: future.date, date: dateFromKey(future.date), bcv: future.bcv, euro: future.euro } : null;
    resolveUseNext();
};

// Desde las 5 pm se calcula con la tasa del día siguiente (si ya está publicada).
// Si el usuario eligió "Hoy" o "Mañana" ese día, se respeta su elección.
const NEXT_DAY_FROM_HOUR = 17;

// Configurable en Ajustes; activo por defecto
const isAutoNextEnabled = () => store.get(KEYS.autoNext) !== '0';

const autoUseNext = () => {
    if (!nextRates || !isAutoNextEnabled()) return false;
    const now = new Date();
    // El viernes se publica la del lunes: hasta 3 días adelante cuenta como "la siguiente"
    return now.getHours() >= NEXT_DAY_FROM_HOUR && nextRates.key <= toDateKey(addDays(now, 3));
};

const resolveUseNext = () => {
    if (!nextRates) { useNext = false; return; }
    const choice = store.getJSON(KEYS.dayChoice, null);
    if (choice && choice.date === toDateKey(new Date()) && choice.nextKey === nextRates.key) {
        useNext = !!choice.next;
        return;
    }
    useNext = autoUseNext();
};

// dolarapi publica el histórico diario (incluida la tasa BCV del día siguiente
// apenas sale). Se sincroniza cada 30 min como máximo.
const syncHistoricos = async () => {
    const last = Number(store.get(KEYS.historicosAt)) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return false;
    const get = (path) => fetch(`${DOLARAPI}/historicos/${path}`, { signal: AbortSignal.timeout(12000) })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);
    const [usd, eur, par] = await Promise.all([get('dolares/oficial'), get('euros/oficial'), get('dolares/paralelo')]);
    if (![usd, eur, par].some((a) => Array.isArray(a) && a.length)) return false;

    const cutoff = toDateKey(addDays(new Date(), -HISTORY_DAYS));
    const updates = {};
    const add = (list, field) => {
        if (!Array.isArray(list)) return;
        list.forEach((e) => {
            if (!e || typeof e.fecha !== 'string' || e.fecha < cutoff || !(e.promedio > 0)) return;
            updates[e.fecha] = { ...(updates[e.fecha] || {}), [field]: e.promedio };
        });
    };
    add(usd, 'bcv');
    add(eur, 'euro');
    add(par, 'binance');
    mergeHistory(updates);
    store.set(KEYS.historicosAt, String(Date.now()));
    return true;
};

// ── Tasa personalizada ────────────────────────────────────────
const loadCustomRate = () => {
    const saved = store.getJSON(KEYS.customRate, null);
    if (saved) customRate = { ...customRate, ...saved };
};

const saveCustomRate = () => store.setJSON(KEYS.customRate, customRate);

// ── Tema, color y vista ───────────────────────────────────────
const applyTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    store.set(KEYS.theme, theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0a0b0d' : '#f2f3f5';
};

const applyAccent = (accent) => {
    document.documentElement.setAttribute('data-accent', accent);
    store.set(KEYS.accent, accent);
};

const applyView = (mode, { animate = false } = {}) => {
    const next = mode === 'list' ? 'list' : 'grid';
    const grid = $('rates-grid');
    const changed = next !== viewMode || (grid && grid.classList.contains('is-list') !== (next === 'list'));
    viewMode = next;
    store.set(KEYS.view, viewMode);
    document.querySelectorAll('#view-toggle [data-view], #view-seg [data-view]').forEach((b) => {
        b.classList.toggle('is-selected', b.dataset.view === viewMode);
    });
    if (!grid) return;
    const mutate = () => grid.classList.toggle('is-list', viewMode === 'list');
    if (!animate || !changed) { mutate(); return; }
    // Las tarjetas se deslizan a su nueva posición; lo de abajo las acompaña
    const cards = [...grid.children];
    const below = [document.querySelector('.rates-hint'), $('error-msg'), $('hero')].filter(isShown);
    flipAnimate([...cards, ...below], mutate, { fade: cards });
};

// ══════════════════════════════════════════════════════════════
//  CONVERSOR
// ══════════════════════════════════════════════════════════════
const formatAmountDisplay = (n) => (n ? formatBs(n) : '');
const formatAmountEdit = (n) => (n ? String(Math.round(n * 100) / 100).replace('.', ',') : '');

const clearQuickActive = () => document.querySelectorAll('.quick-btn').forEach((b) => b.classList.remove('active'));

const setAmount = (n, { fromTyping = false } = {}) => {
    data.amount = Number.isFinite(n) && n >= 0 ? n : 0;
    const input = $('input-amount');
    if (!fromTyping && input) {
        input.value = document.activeElement === input ? formatAmountEdit(data.amount) : formatAmountDisplay(data.amount);
    }
    updateUI();
};

const setCurrency = (cur) => {
    inputCurrency = CURRENCY[cur] ? cur : 'usd';
    if (inputCurrency !== 'bs') lastForeign = inputCurrency;
    store.set(KEYS.currency, inputCurrency);
    updateUI();
};

const toggleCurrencyMenu = (open) => {
    const menu = $('currency-menu');
    const btn = $('btn-currency');
    if (!menu || !btn) return;
    const willOpen = open === undefined ? !isShown(menu) : open;
    setShownAnimated(menu, willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
};

const updateConverterChrome = () => {
    setText('currency-symbol', CURRENCY[inputCurrency].sym);
    if (isBsMode()) {
        setText('dir-from', 'Bs');
        setText('dir-to', CURRENCY[lastForeign].sym);
    } else {
        setText('dir-from', CURRENCY[inputCurrency].sym);
        setText('dir-to', 'Bs');
    }
    document.querySelectorAll('#currency-menu [data-currency]').forEach((b) => {
        b.classList.toggle('is-selected', b.dataset.currency === inputCurrency);
    });

    const r = rates();
    const value = isBsMode()
        ? `${formatUsdt(r.bcv > 0 ? data.amount / r.bcv : 0)} $`
        : `${formatBs(data.amount * officialRate())} Bs`;
    fillRichText($('conv-hint'), ['= ', { strong: value }, ` ${officialRatePhrase()}`]);
};

const setupConverter = () => {
    const input = $('input-amount');

    input?.addEventListener('focus', () => {
        input.value = formatAmountEdit(data.amount);
        requestAnimationFrame(() => input.select());
    });

    input?.addEventListener('blur', () => {
        input.value = formatAmountDisplay(data.amount);
    });

    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
    });

    input?.addEventListener('input', () => {
        // Solo dígitos y una coma decimal (el punto se convierte en coma), máx. 2 decimales
        let v = input.value.replace(/[^\d.,]/g, '').replace(/\./g, ',');
        const comma = v.indexOf(',');
        if (comma !== -1) v = v.slice(0, comma + 1) + v.slice(comma + 1).replace(/,/g, '').slice(0, 2);
        if (v !== input.value) input.value = v;
        clearQuickActive();
        setAmount(parseFloat(v.replace(',', '.')) || 0, { fromTyping: true });
    });

    input?.addEventListener('paste', (e) => {
        const n = parseLocaleNumber(e.clipboardData?.getData('text'));
        if (!Number.isFinite(n)) return;
        e.preventDefault();
        clearQuickActive();
        setAmount(Math.abs(n));
    });

    document.querySelectorAll('.quick-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            clearQuickActive();
            btn.classList.add('active');
            setAmount(Number(btn.dataset.amount));
        });
    });

    $('btn-currency')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCurrencyMenu();
    });

    document.querySelectorAll('#currency-menu [data-currency]').forEach((b) => {
        b.addEventListener('click', () => {
            setCurrency(b.dataset.currency);
            toggleCurrencyMenu(false);
        });
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.currency-wrap')) toggleCurrencyMenu(false);
    });

    $('btn-direction')?.addEventListener('click', () => setCurrency(isBsMode() ? lastForeign : 'bs'));

    $('act-copy')?.addEventListener('click', () => {
        const r = rates();
        if (isBsMode()) {
            copyText(formatUsdt(r.bcv > 0 ? data.amount / r.bcv : 0), 'Monto en $ a tasa BCV copiado');
        } else {
            copyText(formatBs(data.amount * officialRate()), 'Monto a tasa BCV copiado');
        }
    });

    $('act-paste')?.addEventListener('click', async () => {
        const n = await readClipboardNumber();
        if (n === null) return;
        clearQuickActive();
        setAmount(Math.abs(n));
        showToast('Monto pegado');
    });

    $('act-clear')?.addEventListener('click', () => {
        clearQuickActive();
        setAmount(0);
        const field = $('input-amount');
        if (field) { field.value = ''; field.focus(); }
    });
};

// ══════════════════════════════════════════════════════════════
//  TARJETAS DE TASAS
// ══════════════════════════════════════════════════════════════
const buildRateCards = ({ enter = null } = {}) => {
    const grid = $('rates-grid');
    if (!grid) return;
    grid.innerHTML = '';

    CARD_ORDER.filter((k) => k !== 'custom' || customRate.enabled).forEach((key) => {
        const def = key === 'gap' ? { icon: 'scale', color: 'red' } : RATE_DEFS[key];
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'rate-card';
        card.dataset.rate = key;
        card.dataset.color = def.color;
        if (key === 'gap') card.id = 'gap-card';
        card.innerHTML = `
            <span class="rc-head">
                <span class="rc-icon"><i data-lucide="${def.icon}" class="ic-sm"></i></span>
                <span class="rc-title" id="title-${key}"></span>
            </span>
            <span class="rc-value">
                <span class="rc-num" id="total-${key}">--</span>
                <span class="rc-suffix" id="suffix-${key}"></span>
            </span>
            <span class="rc-meta">
                <span class="rc-line" id="line1-${key}"></span>
                <span class="rc-line" id="line2-${key}"></span>
                <span class="rc-line" id="line3-${key}"></span>
            </span>
            <span class="rc-change" id="change-${key}"></span>`;
        card.addEventListener('click', () => onCardClick(key, card));
        grid.appendChild(card);
    });

    refreshIcons();

    // Entrada escalonada (al abrir la app) o solo de la tarjeta indicada
    if (prefersReducedMotion()) return;
    const targets = enter === 'all' ? [...grid.children] : (enter ? [grid.querySelector(`[data-rate="${enter}"]`)] : []);
    targets.filter(Boolean).forEach((card, i) => {
        card.style.animationDelay = `${i * 45}ms`;
        card.classList.add('card-in');
        afterAnimation(card, 600 + i * 45, () => {
            card.classList.remove('card-in');
            card.style.animationDelay = '';
        });
    });
};

const onCardClick = (key, card) => {
    if (key === 'gap') {
        copyText(`${NF2.format(gapPercent())}%`, 'Brecha copiada');
    } else {
        if (!getRate(key)) return;
        copyText(formatCardTotal(key), `${rateTitle(key)} copiado`);
    }
    card.classList.add('copied');
    setTimeout(() => card.classList.remove('copied'), 700);
};

const renderChange = (id, value, unit) => {
    const el = $(id);
    if (!el) return;
    if (value === null || !Number.isFinite(value) || isLoading) {
        el.textContent = '';
        el.className = 'rc-change';
        return;
    }
    const dir = value > 0.005 ? 'up' : value < -0.005 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '↗' : dir === 'down' ? '↘' : '→';
    el.textContent = `${arrow} ${NF2.format(Math.abs(value))}${unit}`;
    el.className = `rc-change ${dir}`;
};

const cardDateText = (key) => {
    if (key === 'custom') return 'Tasa definida por ti';
    if (key === 'binance') return lastFetchAt ? formatRelative(lastFetchAt) : '';
    if (useNext && nextRates) return formatLongDate(nextRates.date);
    const d = rateDate || lastFetchAt;
    return d ? formatLongDate(d) : '';
};

const renderRateCard = (key) => {
    if (key === 'custom' && !customRate.enabled) return;
    const rate = getRate(key);
    const sym = RATE_DEFS[key].sym;

    setText(`title-${key}`, rateTitle(key));
    setText(`total-${key}`, isLoading && key !== 'custom' ? '--' : formatCardTotal(key));
    setText(`suffix-${key}`, cardSuffix(key));
    if (key === 'binance' && binanceQuotes) {
        setText('line1-binance', `Compra ${formatBs(binanceQuotes.buy)} · Venta ${formatBs(binanceQuotes.sell)}`);
    } else {
        setText(`line1-${key}`, data.amount !== 1 && rate ? `1 ${sym} = ${formatBs(rate)} Bs` : '');
    }
    setText(`line2-${key}`, cardDateText(key));

    const prev = key === 'custom' ? null : prevFor(key);
    setText(`line3-${key}`, prev ? `Antes: ${formatBs(prev)}` : '');
    renderChange(`change-${key}`, prev ? pctChange(prev, rate) : null, '%');
};

const renderGapCard = (gapAlert) => {
    const r = rates();
    const gap = gapPercent();
    setText('title-gap', 'Brecha');
    setText('total-gap', isLoading ? '--' : NF2.format(gap));
    setText('suffix-gap', '%');

    if (isBsMode()) {
        const diffUsd = r.bcv > 0 && r.binance > 0 ? data.amount / r.bcv - data.amount / r.binance : 0;
        setText('line1-gap', `${formatUsdt(diffUsd)} $ de diferencia`);
    } else {
        setText('line1-gap', `+${formatBs((r.binance - r.bcv) * data.amount)} Bs de diferencia`);
    }
    setText('line2-gap', 'Binance vs. BCV');

    // Brecha anterior: con la tasa de mañana se compara contra la de hoy
    const pb = prevFor('bcv');
    const pp = useNext ? r.binance : prevFor('binance');
    const prevGap = pb && pp ? gapPercent(pb, pp) : null;
    setText('line3-gap', prevGap !== null ? `Antes: ${NF2.format(prevGap)}%` : '');

    if (gapAlert.exceeded) {
        const el = $('change-gap');
        if (el) {
            el.textContent = `Supera tu límite (${NF2.format(gapAlert.threshold)}%)`;
            el.className = 'rc-change alert';
        }
    } else {
        renderChange('change-gap', prevGap !== null ? gap - prevGap : null, ' pts');
    }
};

const updateRateDateBadge = () => {
    const badge = $('rate-date-badge');
    if (!badge) return;
    // Si hay tasa del día siguiente, el selector Hoy/Mañana ya indica el día
    if (nextRates) {
        badge.textContent = '';
        return;
    }
    if (rateDate) {
        const isToday = toDateKey(rateDate) === toDateKey(new Date());
        badge.textContent = isToday ? 'Hoy' : formatShortDay(rateDate);
        badge.classList.toggle('is-historical', !isToday);
    } else {
        badge.textContent = isLoading ? '...' : '';
        badge.classList.remove('is-historical');
    }
};

const syncDaySeg = () => {
    const seg = $('day-seg');
    if (!seg) return;
    setShownAnimated(seg, !!nextRates);
    if (!nextRates) return;
    const todayBtn = seg.querySelector('[data-day="today"]');
    if (todayBtn) {
        todayBtn.textContent = rateDate && toDateKey(rateDate) !== toDateKey(new Date()) ? formatShortDay(rateDate) : 'Hoy';
    }
    setText('day-next-label', nextDayLabel());
    seg.querySelectorAll('[data-day]').forEach((b) => b.classList.toggle('is-selected', (b.dataset.day === 'next') === useNext));
};

const setupDaySeg = () => {
    document.querySelectorAll('#day-seg [data-day]').forEach((b) => {
        b.addEventListener('click', () => {
            if (!nextRates) return;
            useNext = b.dataset.day === 'next';
            store.setJSON(KEYS.dayChoice, { date: toDateKey(new Date()), nextKey: nextRates.key, next: useNext });
            updateUI();
            showToast(useNext
                ? `Calculando con la tasa BCV del ${formatLongDate(nextRates.date).toLowerCase()}`
                : 'Calculando con la tasa BCV vigente hoy', false, 2600);
        });
    });

    // Si la app queda abierta, a las 5 pm pasa sola a la tasa de mañana
    setInterval(() => {
        const before = useNext;
        resolveUseNext();
        if (before !== useNext) updateUI();
    }, 60 * 1000);
};

// ══════════════════════════════════════════════════════════════
//  EQUIVALENTE EN USDT (vender / comprar en Binance)
// ══════════════════════════════════════════════════════════════
const BINANCE_P2P = {
    sell: 'https://p2p.binance.com/trade/sell/USDT?fiat=VES&payment=all-payments',
    buy: 'https://p2p.binance.com/trade/all-payments/USDT?fiat=VES',
};

// En Android, un intent explícito abre la app de Binance (com.binance.dev);
// si no está instalada, el navegador abre la web de P2P.
const binanceHref = () => {
    const url = BINANCE_P2P[usdtMode];
    if (!isAndroid()) return url;
    const u = new URL(url);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.binance.dev;`
        + `S.browser_fallback_url=${encodeURIComponent(url)};end`;
};

// Anuncios públicos de Binance P2P. tradeType BUY = el usuario compra USDT
// (paga el precio más alto); SELL = el usuario vende USDT (recibe el más bajo).
const BINANCE_ADS_API = 'https://www.binance.com/bapi/c2c/v1/public/c2c/agent/ad-list';

const fetchBinanceSide = async (tradeType) => {
    const url = `${BINANCE_ADS_API}?fiat=VES&asset=USDT&tradeType=${tradeType}&limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Binance P2P HTTP ${res.status}`);
    const json = await res.json();
    const items = (json && json.data && Array.isArray(json.data.items)) ? json.data.items : [];
    // Se descartan anuncios "señuelo" (límite de pocos Bs o casi sin USDT disponibles),
    // que suelen tener precios fuera de mercado
    const serious = items.filter((a) => Number(a.price) > 0 && Number(a.tradableAmount) >= 50 && Number(a.maxTransAmount) >= 1000);
    const pool = (serious.length >= 3 ? serious : items).map((a) => Number(a.price)).filter((p) => p > 0).slice(0, 5);
    if (!pool.length) throw new Error('Binance P2P sin anuncios');
    const sorted = [...pool].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

const fetchBinanceQuotes = async () => {
    const [buy, sell] = await Promise.all([fetchBinanceSide('BUY'), fetchBinanceSide('SELL')]);
    return { buy, sell };
};

// Precio de Binance para la operación elegida (con respaldo a la tasa general)
const usdtPrice = () => {
    if (binanceQuotes) return usdtMode === 'buy' ? binanceQuotes.buy : binanceQuotes.sell;
    return rates().binance;
};

const updateUsdtCard = () => {
    const bsAmount = amountInBsOfficial();
    const price = usdtPrice();
    const usdt = price > 0 ? bsAmount / price : 0;
    lastUsdtNeeded = usdt;
    setText('eq-usdt', isLoading ? '--' : `${formatUsdt(usdt)} USDT`);

    const what = isBsMode() ? '' : ` (tu monto ${officialRatePhrase()})`;
    fillRichText($('usdt-sub'), usdtMode === 'sell'
        ? ['Lo que debes vender en Binance para recibir ', { strong: `${formatBs(bsAmount)} Bs` }, `${what}.`]
        : ['Lo que compras en Binance con ', { strong: `${formatBs(bsAmount)} Bs` }, `${what}.`]);
    setText('usdt-price', binanceQuotes && !isLoading
        ? `Precio P2P para ${usdtMode === 'sell' ? 'vender' : 'comprar'}: ${formatBs(price)} Bs por USDT`
        : '');

    document.querySelectorAll('#usdt-mode [data-mode]').forEach((b) => b.classList.toggle('is-selected', b.dataset.mode === usdtMode));
    setText('binance-btn-text', usdtMode === 'sell' ? 'Copiar y vender en Binance P2P' : 'Copiar y comprar en Binance P2P');

    const link = $('btn-binance-p2p');
    if (link) {
        link.href = binanceHref();
        if (isAndroid()) link.removeAttribute('target');
        else link.setAttribute('target', '_blank');
    }
};

const setupUsdtCard = () => {
    usdtMode = store.get(KEYS.usdtMode) === 'buy' ? 'buy' : 'sell';

    document.querySelectorAll('#usdt-mode [data-mode]').forEach((b) => {
        b.addEventListener('click', () => {
            usdtMode = b.dataset.mode === 'buy' ? 'buy' : 'sell';
            store.set(KEYS.usdtMode, usdtMode);
            updateUsdtCard();
            popElement('eq-usdt');
        });
    });

    $('btn-copy-usdt')?.addEventListener('click', async () => {
        if (!(lastUsdtNeeded > 0)) return;
        const ok = await copyText(lastUsdtNeeded.toFixed(2), `USDT copiado: ${lastUsdtNeeded.toFixed(2)}`);
        const btn = $('btn-copy-usdt');
        if (ok && btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1500);
        }
    });

    // Es un <a>: la navegación la hace el navegador (así Android/iOS pueden abrir
    // la app). Aquí solo se copia el monto, con punto decimal como lo pide Binance.
    $('btn-binance-p2p')?.addEventListener('click', () => {
        if (lastUsdtNeeded > 0) {
            navigator.clipboard.writeText(lastUsdtNeeded.toFixed(2)).catch(() => { });
        }
    });
};

// ── Render general ────────────────────────────────────────────
const updateUI = () => {
    updateConverterChrome();
    updateUsdtCard();

    const gapAlert = isLoading ? { exceeded: false } : checkGapAlert(gapPercent());
    ['bcv', 'euro', 'binance', 'custom'].forEach(renderRateCard);
    renderGapCard(gapAlert);
    updateRateDateBadge();
    syncDaySeg();

    if (!isLoading) {
        CARD_ORDER.forEach((k) => popElement(`total-${k}`));
        popElement('eq-usdt');
    }
};

// ══════════════════════════════════════════════════════════════
//  HOJAS / MODALES
// ══════════════════════════════════════════════════════════════
const openStack = [];
const openHooks = {};
const closeHooks = {};

const topOverlay = () => openStack[openStack.length - 1] || null;

const OVERLAY_CLOSE_MS = 240;
const closingTimers = {};

// Termina de ocultar una hoja (al final de su animación de cierre)
const finishOverlayClose = (el) => {
    el.classList.remove('is-closing');
    el.classList.add('hidden');
    el.style.zIndex = '';
    const sheet = el.querySelector('.sheet');
    if (sheet) sheet.style.transform = '';
};

const openOverlay = (id) => {
    const el = $(id);
    if (!el) return;
    // Si se estaba cerrando, se cancela el cierre y se vuelve a abrir
    if (el.classList.contains('is-closing')) {
        clearTimeout(closingTimers[id]);
        finishOverlayClose(el);
    }
    if (!el.classList.contains('hidden')) return;
    toggleCurrencyMenu(false);
    suspendTourIfActive();
    if (openHooks[id]) openHooks[id]();
    // La última hoja abierta siempre queda encima, sin importar su orden en el HTML
    el.style.zIndex = String(100 + openStack.length);
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    openStack.push(id);
    document.body.classList.add('no-scroll');
    document.querySelectorAll(`[data-opens="${id}"]`).forEach((b) => b.classList.add('is-active'));
};

// El estado (pila, botones activos, hooks) cambia al instante; lo visual se anima
const closeOverlay = (id) => {
    const el = $(id);
    if (!el || el.classList.contains('hidden') || el.classList.contains('is-closing')) return;
    el.setAttribute('aria-hidden', 'true');
    if (prefersReducedMotion()) {
        finishOverlayClose(el);
    } else {
        el.classList.add('is-closing');
        closingTimers[id] = setTimeout(() => finishOverlayClose(el), OVERLAY_CLOSE_MS);
    }
    const i = openStack.lastIndexOf(id);
    if (i > -1) openStack.splice(i, 1);
    if (!openStack.length) document.body.classList.remove('no-scroll');
    document.querySelectorAll(`[data-opens="${id}"]`).forEach((b) => b.classList.remove('is-active'));
    if (closeHooks[id]) closeHooks[id]();
    if (!openStack.length) resumeTourIfSuspended();
};

const closeAllOverlays = () => { while (topOverlay()) closeOverlay(topOverlay()); };

// Arrastrar la barrita (o la cabecera) hacia abajo cierra la hoja
const setupSheetDrag = () => {
    document.querySelectorAll('.sheet-overlay').forEach((overlay) => {
        const sheet = overlay.querySelector('.sheet');
        if (!sheet) return;
        let startY = null;
        let startT = 0;
        let dy = 0;

        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target.closest('button, input, select, a, label')) return;
            startY = e.clientY;
            startT = performance.now();
            dy = 0;
            sheet.classList.add('is-dragging');
            e.currentTarget.setPointerCapture?.(e.pointerId);
        };
        const onMove = (e) => {
            if (startY === null) return;
            dy = Math.max(0, e.clientY - startY);
            sheet.style.transform = `translateY(${dy}px)`;
        };
        const onUp = () => {
            if (startY === null) return;
            const speed = dy / Math.max(1, performance.now() - startT);
            startY = null;
            sheet.classList.remove('is-dragging');
            if (dy > 110 || (dy > 30 && speed > 0.6)) {
                // La animación de cierre continúa desde donde se soltó
                closeOverlay(overlay.id);
            } else {
                sheet.style.transform = '';
            }
        };

        sheet.querySelectorAll('.sheet-handle, .sheet-header').forEach((zone) => {
            zone.addEventListener('pointerdown', onDown);
            zone.addEventListener('pointermove', onMove);
            zone.addEventListener('pointerup', onUp);
            zone.addEventListener('pointercancel', onUp);
        });
    });
};

const setupOverlays = () => {
    document.querySelectorAll('[data-opens]').forEach((btn) => {
        btn.addEventListener('click', () => openOverlay(btn.dataset.opens));
    });

    document.querySelectorAll('.sheet-overlay, .modal-overlay').forEach((ov) => {
        ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(ov.id); });
        ov.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeOverlay(ov.id)));
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (isShown($('currency-menu'))) { toggleCurrencyMenu(false); return; }
        if (topOverlay()) closeOverlay(topOverlay());
    });

    setupSheetDrag();
};

// ══════════════════════════════════════════════════════════════
//  CALCULADORA
// ══════════════════════════════════════════════════════════════
// La expresión interna usa "." decimal, "* / + -" y "~" como signo negativo
// (para no confundirlo con la resta). En pantalla se muestra en formato local.
let calcExpr = '';
let calcJustEvaluated = false;
let calcEchoExpr = ''; // la operación que produjo el resultado, tras pulsar "="

const CALC_DISPLAY_MAP = { '.': ',', '*': '×', '/': '÷', '-': '−', '~': '-' };
const toCalcDisplay = (s) => s.replace(/[.*/\-~]/g, (ch) => CALC_DISPLAY_MAP[ch]);
const isCalcOp = (c) => c === '+' || c === '-' || c === '*' || c === '/';
const calcLast = () => calcExpr.slice(-1);
const calcSegment = () => calcExpr.match(/[\d.]*$/)[0];
const calcHasOp = () => /[+\-*/]/.test(calcExpr);
const calcTokenize = (expr) => expr.match(/~?\d+\.?\d*%?|~?\.\d+%?|[+\-*/]/g) || [];

const numToCalcExpr = (n) => {
    const r = Math.round(n * 1e6) / 1e6;
    return r < 0 ? `~${-r}` : String(r);
};

// Precedencia: × ÷ antes que + −. "a + b%" suma el b% de a; "a × b%" usa b/100.
const calcEvaluate = (expr) => {
    const tokens = calcTokenize(expr);
    if (!tokens.length) return null;
    const vals = tokens.map((t) => {
        if (isCalcOp(t)) return t;
        const neg = t.startsWith('~');
        const body = neg ? t.slice(1) : t;
        const pct = body.endsWith('%');
        let v = parseFloat(pct ? body.slice(0, -1) : body);
        if (!Number.isFinite(v)) v = 0;
        if (neg) v = -v;
        return { v: pct ? v / 100 : v, pct };
    });
    for (let i = 0; i < vals.length; i++) {
        if ((i % 2 === 1) !== (typeof vals[i] === 'string')) return null;
    }
    if (typeof vals[vals.length - 1] === 'string') return null;

    const stage = [vals[0]];
    for (let i = 1; i < vals.length; i += 2) {
        const op = vals[i];
        const rhs = vals[i + 1];
        if (op === '*' || op === '/') {
            const left = stage[stage.length - 1];
            const v = op === '*' ? left.v * rhs.v : (rhs.v !== 0 ? left.v / rhs.v : NaN);
            stage[stage.length - 1] = { v, pct: false };
        } else {
            stage.push(op, rhs);
        }
    }
    let result = stage[0].v;
    for (let i = 1; i < stage.length; i += 2) {
        const rhs = stage[i + 1];
        const r = rhs.pct ? result * rhs.v : rhs.v;
        result = stage[i] === '+' ? result + r : result - r;
    }
    return Number.isFinite(result) ? result : null;
};

// Valor de la operación ignorando un operador final pendiente ("80 + 2 +" → 82)
const calcPreview = () => calcEvaluate(calcExpr.replace(/[+\-*/~.]+$/, ''));

// Número que se está escribiendo, con separador de miles: "~1234.5" → "-1.234,5"
const groupTyped = (s) => {
    const m = s.match(/^(~?)(\d*)(\.?)(\d*)(%?)$/);
    if (!m) return toCalcDisplay(s);
    const [, neg, int, dot, dec, pct] = m;
    const intPart = int ? NF0.format(Number(int)) : (dot ? '0' : '');
    return `${neg ? '-' : ''}${intPart}${dot ? ',' : ''}${dec}${pct}`;
};

const CALC_OP_SYMBOL = { '+': '+', '-': '−', '*': '×', '/': '÷' };

// "60+20*~3" → "60 + 20 × -3", con separador de miles en cada número
const formatExpr = (expr) => expr
    .split(/([+\-*/])/)
    .map((part) => (isCalcOp(part) ? ` ${CALC_OP_SYMBOL[part]} ` : groupTyped(part)))
    .join('')
    .trim();

// La letra se achica por pasos (con transición) cuando la operación es larga
const CALC_SIZE_STEPS = [[9, 'fs-xl'], [13, 'fs-lg'], [18, 'fs-md'], [Infinity, 'fs-sm']];
const fitCalcMain = (el) => {
    const len = el.textContent.replace(/\s/g, '').length;
    const size = CALC_SIZE_STEPS.find(([max]) => len <= max)[1];
    CALC_SIZE_STEPS.forEach(([, cls]) => el.classList.toggle(cls, cls === size));
    el.scrollLeft = el.scrollWidth; // lo último escrito siempre a la vista
};

// La línea grande muestra lo que se escribe; arriba, pequeño, el resultado parcial.
// Al pulsar "=" el resultado pasa a la línea grande.
const renderCalc = () => {
    let main;
    let sub = '';
    if (calcJustEvaluated) {
        main = groupTyped(calcExpr);
        sub = calcEchoExpr;
    } else if (!calcExpr) {
        main = '0';
    } else if (calcHasOp() || calcExpr.includes('%')) {
        main = formatExpr(calcExpr);
        const complete = calcExpr.replace(/[+\-*/~.]+$/, '');
        const live = /[+\-*/%]/.test(complete) ? calcEvaluate(complete) : null;
        if (live !== null) sub = `= ${formatCalc(live)}`;
    } else {
        main = groupTyped(calcExpr);
    }
    setText('calc-expression', sub);
    const mainEl = $('calc-main');
    if (mainEl) {
        mainEl.textContent = main;
        fitCalcMain(mainEl);
    }
    renderCalcItems();

    // Las tasas que ya están en la operación se marcan (tocarlas otra vez las quita)
    const tokens = calcJustEvaluated ? [] : calcTokenize(calcExpr);
    document.querySelectorAll('#calc-chips-block .rate-chip').forEach((chip) => {
        chip.classList.toggle('is-selected', tokens.includes(chip.dataset.token));
    });
};

const calcDigit = (d) => {
    calcEchoExpr = '';
    if (calcJustEvaluated) { calcExpr = ''; calcJustEvaluated = false; }
    if (calcLast() === '%') return; // "%" cierra el número; hace falta un operador para seguir
    const seg = calcSegment();
    if (d === '.') {
        if (seg.includes('.')) return;
        if (seg === '') calcExpr += '0';
    } else {
        if (seg.replace('.', '').length >= 15) return;
        if (seg === '0') calcExpr = calcExpr.slice(0, -1);
    }
    calcExpr += d;
    renderCalc();
};

const calcOperator = (op) => {
    calcEchoExpr = '';
    calcJustEvaluated = false;
    const last = calcLast();
    if (!calcExpr) {
        if (op === '-') calcExpr = '~';
    } else if (last === '~') {
        return;
    } else if (isCalcOp(last)) {
        // "5 × −3": un "−" tras × o ÷ empieza un número negativo
        if (op === '-' && (last === '*' || last === '/')) calcExpr += '~';
        else calcExpr = calcExpr.slice(0, -1) + op;
    } else if (last === '.') {
        calcExpr = calcExpr.slice(0, -1) + op;
    } else {
        calcExpr += op;
    }
    renderCalc();
};

const calcPercent = () => {
    calcEchoExpr = '';
    calcJustEvaluated = false;
    if (calcLast() === '.') calcExpr = calcExpr.slice(0, -1);
    if (!/\d/.test(calcLast())) return;
    calcExpr += '%';
    renderCalc();
};

const calcToggleSign = () => {
    calcEchoExpr = '';
    calcJustEvaluated = false;
    const m = calcExpr.match(/(~?)([\d.]*%?)$/);
    const start = calcExpr.length - m[0].length;
    calcExpr = calcExpr.slice(0, start) + (m[1] ? '' : '~') + m[2];
    renderCalc();
};

const calcBackspace = () => {
    calcEchoExpr = '';
    calcJustEvaluated = false;
    calcExpr = calcExpr.slice(0, -1);
    renderCalc();
};

const calcClear = () => {
    calcEchoExpr = '';
    calcJustEvaluated = false;
    calcExpr = '';
    renderCalc();
};

// El resultado "sube" a la línea grande y la operación queda arriba
const playCalcResult = () => {
    if (prefersReducedMotion()) return;
    ['calc-main', 'calc-expression'].forEach((id) => {
        const el = $(id);
        if (!el) return;
        el.classList.remove('calc-swap');
        void el.offsetWidth;
        el.classList.add('calc-swap');
        afterAnimation(el, 450, () => el.classList.remove('calc-swap'));
    });
};

const calcEquals = () => {
    const complete = calcExpr.replace(/[+\-*/~.]+$/, '');
    const v = calcEvaluate(complete);
    if (v === null || calcJustEvaluated) return;
    if (!/[+\-*/%]/.test(complete)) return; // un número solo no tiene nada que calcular
    const shown = formatExpr(complete);
    calcEchoExpr = `${shown} =`;
    saveCalcHistoryEntry(shown, v);
    calcExpr = numToCalcExpr(v);
    calcJustEvaluated = true;
    renderCalc();
    playCalcResult();
};

// Inserta un número (tasa, valor pegado): si ya hay un número delante, multiplica
const calcInsertNumber = (n) => {
    calcEchoExpr = '';
    let s = numToCalcExpr(n);
    if (calcJustEvaluated) { calcExpr = ''; calcJustEvaluated = false; }
    const last = calcLast();
    if (last === '~') {
        calcExpr = calcExpr.slice(0, -1);
        s = s.startsWith('~') ? s.slice(1) : `~${s}`;
    } else if (last === '.') {
        calcExpr = `${calcExpr.slice(0, -1)}*`;
    } else if (calcExpr && !isCalcOp(last)) {
        calcExpr += '*';
    }
    calcExpr += s;
    renderCalc();
};

// Quita la última aparición de un número junto al operador que lo une
const calcRemoveToken = (token) => {
    if (calcJustEvaluated) return false;
    const tokens = calcTokenize(calcExpr);
    const idx = tokens.lastIndexOf(token);
    if (idx === -1) return false;
    if (idx > 0) tokens.splice(idx - 1, 2);
    else tokens.splice(0, tokens.length > 1 ? 2 : 1);
    calcExpr = tokens.join('');
    calcEchoExpr = '';
    renderCalc();
    return true;
};

// ── Modo "canasta": cada sumando como chip removible ──
const getCalcItems = () => (/^[\d.]+(\+[\d.]+)+$/.test(calcExpr) ? calcExpr.split('+') : null);

const renderCalcItems = () => {
    const wrap = $('calc-items');
    if (!wrap) return;
    const items = getCalcItems();
    // La fila conserva su espacio aunque esté vacía, para que el teclado no se mueva
    wrap.classList.toggle('is-empty', !items);
    wrap.innerHTML = '';
    if (!items) return;
    items.forEach((part, idx) => {
        const chip = document.createElement('span');
        chip.className = 'calc-item';
        chip.textContent = groupTyped(part);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'calc-item-remove';
        remove.setAttribute('aria-label', 'Quitar');
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const parts = getCalcItems();
            if (!parts) return;
            parts.splice(idx, 1);
            calcExpr = parts.join('+');
            calcEchoExpr = '';
            calcJustEvaluated = false;
            renderCalc();
        });
        chip.appendChild(remove);
        wrap.appendChild(chip);
    });
};

// ── Tasas listas para insertar (o quitar) ──
const renderCalcChips = () => {
    const current = $('calc-chips-current');
    const previous = $('calc-chips-prev');
    if (!current || !previous) return;

    const makeChip = (key, value, isPrev) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `rate-chip${isPrev ? ' is-prev' : ''}`;
        b.dataset.color = RATE_DEFS[key].color;
        b.dataset.token = numToCalcExpr(value);
        b.innerHTML = '<span class="dot"></span><span class="lbl"></span><span class="val"></span>';
        b.querySelector('.lbl').textContent = isPrev ? `${chipTitle(key)} ant.` : chipTitle(key);
        b.querySelector('.val').textContent = formatUsdt(value); // mismo valor que se inserta
        b.addEventListener('click', () => {
            if (!calcRemoveToken(b.dataset.token)) calcInsertNumber(value);
        });
        return b;
    };

    current.innerHTML = '';
    previous.innerHTML = '';
    ['bcv', 'euro', 'binance', 'custom'].forEach((k) => {
        if (k === 'custom' && !customRate.enabled) return;
        const v = getRate(k);
        if (v > 0) current.appendChild(makeChip(k, v, false));
    });
    ['bcv', 'euro', 'binance'].forEach((k) => {
        const p = prevFor(k);
        if (p) previous.appendChild(makeChip(k, p, true));
    });
};

// ── Historial de operaciones ──
const CALC_HISTORY_MAX = 20;

const loadCalcHistory = () => {
    const list = store.getJSON(KEYS.calcHistory, []);
    return Array.isArray(list) ? list.filter((e) => e && typeof e.value === 'number') : [];
};

const saveCalcHistoryEntry = (expr, value) => {
    const list = loadCalcHistory();
    if (list[0] && list[0].expr === expr && list[0].value === value) return;
    list.unshift({ expr, value });
    store.setJSON(KEYS.calcHistory, list.slice(0, CALC_HISTORY_MAX));
};

const renderCalcHistory = () => {
    const wrap = $('calc-history-list');
    if (!wrap) return;
    const list = loadCalcHistory();
    wrap.innerHTML = '';
    if (!list.length) {
        const empty = document.createElement('p');
        empty.className = 'calc-history-empty';
        empty.textContent = 'Aún no hay operaciones. Pulsa "=" para guardarlas aquí.';
        wrap.appendChild(empty);
        return;
    }
    list.forEach((entry) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'calc-history-row';
        const expr = document.createElement('span');
        expr.className = 'expr';
        expr.textContent = entry.expr;
        const res = document.createElement('span');
        res.className = 'res';
        res.textContent = `= ${formatCalc(entry.value)}`;
        row.append(expr, res);
        row.addEventListener('click', () => {
            calcExpr = numToCalcExpr(entry.value);
            calcJustEvaluated = true;
            calcEchoExpr = `${entry.expr} =`;
            renderCalc();
        });
        wrap.appendChild(row);
    });
};

const setCalcHistoryVisible = (visible) => {
    const panel = $('calc-history-panel');
    const chips = $('calc-chips-block');
    if (visible) { renderCalcHistory(); swapAnimated(chips, panel); }
    else swapAnimated(panel, chips);
    $('calc-history-toggle')?.classList.toggle('is-active', visible);
};

const setupCalculator = () => {
    openHooks['calc-sheet'] = () => {
        renderCalcChips();
        setCalcHistoryVisible(false);
        renderCalc();
    };

    document.querySelectorAll('.calc-keypad .key').forEach((btn) => {
        btn.addEventListener('click', () => {
            const k = btn.dataset.key;
            if (k === 'C') calcClear();
            else if (k === 'sign') calcToggleSign();
            else if (k === '%') calcPercent();
            else if (k === 'back') calcBackspace();
            else if (k === '=') calcEquals();
            else if (isCalcOp(k)) calcOperator(k);
            else calcDigit(k);
        });
    });

    $('calc-history-toggle')?.addEventListener('click', () => {
        setCalcHistoryVisible(!isShown($('calc-history-panel')));
    });

    $('calc-history-clear')?.addEventListener('click', () => {
        store.remove(KEYS.calcHistory);
        renderCalcHistory();
    });

    $('calc-paste')?.addEventListener('click', async () => {
        const n = await readClipboardNumber();
        if (n !== null) calcInsertNumber(n);
    });

    $('calc-save-rate')?.addEventListener('click', () => {
        const v = calcPreview();
        if (v === null || v <= 0) { showToast('Necesitas un resultado mayor a 0', true); return; }
        customRate = { ...customRate, enabled: true, value: Math.round(v * 100) / 100 };
        saveCustomRate();
        buildRateCards({ enter: 'custom' });
        updateUI();
        renderCalcChips();
        renderCalc();
        showToast(`Guardada como "${customRate.name || 'Mi tasa'}"`);
    });

    $('btn-calc-use')?.addEventListener('click', () => {
        const v = calcPreview();
        if (v === null) { showToast('No hay un resultado para usar', true); return; }
        if (v < 0) { showToast('El monto no puede ser negativo', true); return; }
        if (calcHasOp() || calcExpr.includes('%')) saveCalcHistoryEntry(formatExpr(calcExpr), v);
        clearQuickActive();
        setAmount(v);
        calcExpr = '';
        calcEchoExpr = '';
        calcJustEvaluated = false;
        closeOverlay('calc-sheet');
        showToast('Monto actualizado');
    });

    // Teclado físico mientras la calculadora es la hoja visible
    document.addEventListener('keydown', (e) => {
        if (topOverlay() !== 'calc-sheet' || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key;
        if (/^\d$/.test(k)) calcDigit(k);
        else if (k === '.' || k === ',') calcDigit('.');
        else if (isCalcOp(k)) calcOperator(k);
        else if (k === '%') calcPercent();
        else if (k === 'Enter' || k === '=') calcEquals();
        else if (k === 'Backspace') calcBackspace();
        else if (k === 'Delete') calcClear();
        else return;
        e.preventDefault();
    });
};

// ══════════════════════════════════════════════════════════════
//  HISTORIAL DE TASAS
// ══════════════════════════════════════════════════════════════
let historyStart = toDateKey(addDays(new Date(), -7));
let historyEnd = toDateKey(new Date());

const getFilteredHistoryEntries = () =>
    getAllHistoryEntries().filter((e) => e.date >= historyStart && e.date <= historyEnd);

const renderHistoryList = () => {
    const list = $('history-list');
    if (!list) return;
    const entries = getFilteredHistoryEntries();
    list.innerHTML = '';
    // Al cambiar el rango, la lista nueva entra con un fundido
    if (!prefersReducedMotion()) {
        list.classList.remove('anim-in');
        void list.offsetWidth;
        list.classList.add('anim-in');
        afterAnimation(list, 300, () => list.classList.remove('anim-in'));
    }

    if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'history-empty';
        empty.textContent = 'Sin registros en este rango.';
        list.appendChild(empty);
        return;
    }

    const makeCell = (label, value, isValue, onClick) => {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `history-cell${isValue ? ' is-value' : ''}`;
        cell.disabled = !onClick;
        const l = document.createElement('span');
        l.className = 'history-cell-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'history-cell-value';
        v.textContent = value;
        cell.append(l, v);
        if (onClick) cell.addEventListener('click', onClick);
        return cell;
    };

    entries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'history-row';
        const d = dateFromKey(entry.date);
        row.appendChild(makeCell('Fecha', `${formatShortDay(d)}-${formatDayMonthYear(d).slice(3)}`, false,
            () => copyText(formatDayMonthYear(d), 'Fecha copiada')));

        const values = document.createElement('div');
        values.className = 'history-values';
        [['bcv', 'USD'], ['euro', 'EUR'], ['binance', 'P2P']].forEach(([k, label]) => {
            const v = entry[k];
            values.appendChild(makeCell(label, v ? formatBs(v) : '--', true,
                v ? () => copyText(formatBs(v), 'Tasa copiada') : null));
        });
        row.appendChild(values);
        list.appendChild(row);
    });
};

const updateHistoryResetVisibility = () => {
    const isDefault = historyStart === toDateKey(addDays(new Date(), -7)) && historyEnd === toDateKey(new Date());
    $('history-reset')?.classList.toggle('hidden', isDefault);
};

const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
};

const exportHistoryCSV = () => {
    const entries = getFilteredHistoryEntries();
    if (!entries.length) { showToast('No hay datos para exportar', true); return; }
    const rows = [['Fecha', 'BCV (Bs)', 'Euro (Bs)', 'Paralelo/P2P (Bs)'],
        ...entries.map((e) => [e.date, e.bcv ?? '', e.euro ?? '', e.binance ?? ''])];
    downloadBlob(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' }),
        `monitor-bs_historial_${historyStart}_${historyEnd}.csv`);
};

const loadScriptOnce = (() => {
    const cache = {};
    return (src) => {
        if (!cache[src]) {
            cache[src] = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = () => resolve();
                s.onerror = () => { delete cache[src]; reject(new Error(`No se pudo cargar ${src}`)); };
                document.head.appendChild(s);
            });
        }
        return cache[src];
    };
})();

// ExcelJS (~950KB) se carga solo cuando alguien exporta a Excel
const exportHistoryXLSX = async () => {
    const entries = getFilteredHistoryEntries();
    if (!entries.length) { showToast('No hay datos para exportar', true); return; }
    try {
        if (!window.ExcelJS) await loadScriptOnce('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js');
        const workbook = new window.ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Historial');
        sheet.columns = [
            { header: 'Fecha', key: 'date', width: 14 },
            { header: 'BCV (Bs)', key: 'bcv', width: 14 },
            { header: 'Euro (Bs)', key: 'euro', width: 14 },
            { header: 'Paralelo/P2P (Bs)', key: 'binance', width: 18 },
        ];
        entries.forEach((e) => sheet.addRow(e));
        const buffer = await workbook.xlsx.writeBuffer();
        downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
            `monitor-bs_historial_${historyStart}_${historyEnd}.xlsx`);
    } catch (e) {
        console.error('[exportHistoryXLSX]', e);
        showToast('No se pudo exportar a Excel', true);
    }
};

const setupHistory = () => {
    const start = $('history-start');
    const end = $('history-end');

    openHooks['history-sheet'] = () => {
        if (start) start.value = historyStart;
        if (end) end.value = historyEnd;
        updateHistoryResetVisibility();
        renderHistoryList();
    };

    start?.addEventListener('change', () => {
        historyStart = start.value || toDateKey(addDays(new Date(), -7));
        updateHistoryResetVisibility();
        renderHistoryList();
    });
    end?.addEventListener('change', () => {
        historyEnd = end.value || toDateKey(new Date());
        updateHistoryResetVisibility();
        renderHistoryList();
    });
    $('history-reset')?.addEventListener('click', () => {
        historyStart = toDateKey(addDays(new Date(), -7));
        historyEnd = toDateKey(new Date());
        if (start) start.value = historyStart;
        if (end) end.value = historyEnd;
        updateHistoryResetVisibility();
        renderHistoryList();
    });
    $('history-export-csv')?.addEventListener('click', exportHistoryCSV);
    $('history-export-xlsx')?.addEventListener('click', exportHistoryXLSX);
};

// ══════════════════════════════════════════════════════════════
//  PERFILES DE PAGO
// ══════════════════════════════════════════════════════════════
const BANKS = [
    ['0102', 'Banco de Venezuela'], ['0104', 'Venezolano de Crédito'], ['0105', 'Mercantil'],
    ['0108', 'Provincial'], ['0114', 'Bancaribe'], ['0115', 'Exterior'], ['0128', 'Caroní'],
    ['0134', 'Banesco'], ['0137', 'Sofitasa'], ['0138', 'Banco Plaza'], ['0151', 'BFC Fondo Común'],
    ['0156', '100% Banco'], ['0157', 'DelSur'], ['0163', 'Banco del Tesoro'], ['0166', 'Banco Agrícola'],
    ['0168', 'Bancrecer'], ['0169', 'Mi Banco'], ['0171', 'Banco Activo'], ['0172', 'Bancamiga'],
    ['0174', 'Banplus'], ['0175', 'Bicentenario'], ['0177', 'Banfanb'], ['0178', 'N58 Banco Digital'],
    ['0191', 'BNC'],
];
const PHONE_PREFIXES = ['0412', '0414', '0416', '0422', '0424', '0426'];
const DOC_TYPES = ['V', 'E', 'J', 'G', 'P'];

const bankName = (code) => (BANKS.find((b) => b[0] === code) || [])[1] || null;
const bankLabel = (code) => (bankName(code) ? `${bankName(code)} (${code})` : code);

let payProfiles = { list: [], defaultId: null };

const newProfile = (fields = {}) => ({
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    type: 'pm',
    docType: 'V',
    docNumber: '',
    phonePrefix: '0414',
    phoneNumber: '',
    banks: [],
    holder: '',
    account: '',
    ...fields,
});

const sanitizeProfile = (p) => {
    const out = { ...newProfile(), ...(p || {}) };
    out.type = out.type === 'tr' ? 'tr' : 'pm';
    out.docType = DOC_TYPES.includes(out.docType) ? out.docType : 'V';
    out.phonePrefix = PHONE_PREFIXES.includes(out.phonePrefix) ? out.phonePrefix : '0414';
    out.banks = Array.isArray(out.banks) ? out.banks.filter((c) => bankName(c)) : [];
    ['name', 'docNumber', 'phoneNumber', 'holder', 'account'].forEach((k) => { out[k] = String(out[k] || ''); });
    return out;
};

const saveProfiles = () => store.setJSON(KEYS.profiles, payProfiles);

const getProfile = (id) => payProfiles.list.find((p) => p.id === id) || null;

// v3.0 guardaba los datos de pago como texto libre en la hoja de compartir:
// se convierten en perfiles para no perderlos
const migrateLegacyShareData = () => {
    const legacy = store.getJSON(KEYS.share, null);
    if (!legacy || legacy.migrated || payProfiles.list.length) return;
    const pm = legacy.pm || {};
    const tr = legacy.tr || {};
    const parseDoc = (s = '') => {
        const m = String(s).trim().match(/^([VEJGP])[-\s.]*([\d.]+)$/i);
        return m ? { docType: m[1].toUpperCase(), docNumber: m[2].replace(/\./g, '') } : { docNumber: String(s).replace(/\D/g, '') };
    };
    const matchBanks = (s = '') => {
        const t = String(s).trim().toLowerCase();
        if (!t) return [];
        const code = (t.match(/\d{4}/) || [])[0];
        const b = BANKS.find(([c, n]) => c === code || n.toLowerCase().includes(t) || t.includes(n.toLowerCase()));
        return b ? [b[0]] : [];
    };
    const created = [];
    if (pm.bank || pm.phone || pm.id) {
        const digits = String(pm.phone || '').replace(/\D/g, '');
        const prefix = digits.slice(0, 4);
        const hasPrefix = PHONE_PREFIXES.includes(prefix);
        created.push(newProfile({
            name: 'Pago Móvil', type: 'pm', ...parseDoc(pm.id),
            phonePrefix: hasPrefix ? prefix : '0414',
            phoneNumber: (hasPrefix ? digits.slice(4) : digits).slice(-7),
            banks: matchBanks(pm.bank),
        }));
    }
    if (tr.account || tr.holder || tr.id) {
        created.push(newProfile({
            name: 'Transferencia', type: 'tr', ...parseDoc(tr.id),
            account: String(tr.account || '').replace(/\D/g, ''),
            holder: String(tr.holder || ''),
        }));
    }
    if (created.length) {
        payProfiles.list = created.map(sanitizeProfile);
        payProfiles.defaultId = payProfiles.list[0].id;
        saveProfiles();
    }
    store.setJSON(KEYS.share, { ...legacy, migrated: true });
};

const loadProfiles = () => {
    const saved = store.getJSON(KEYS.profiles, null);
    if (saved && Array.isArray(saved.list)) {
        payProfiles.list = saved.list.map(sanitizeProfile);
        payProfiles.defaultId = getProfile(saved.defaultId) ? saved.defaultId : (payProfiles.list[0]?.id || null);
    }
    migrateLegacyShareData();
};

const formatPhone = (p) => `${p.phonePrefix}-${p.phoneNumber}`;
const formatDoc = (p) => `${p.docType}-${p.docNumber}`;
const docLabel = (p) => (['J', 'G'].includes(p.docType) ? 'RIF' : 'Cédula');

const profileSummary = (p) => {
    if (p.type === 'pm') {
        const banks = p.banks.length === 1 ? bankName(p.banks[0]) : (p.banks.length ? `${p.banks.length} bancos` : null);
        return ['Pago Móvil', banks, p.phoneNumber ? formatPhone(p) : null].filter(Boolean).join(' · ');
    }
    return ['Transferencia', bankName(p.account.slice(0, 4)), p.account ? `•••• ${p.account.slice(-4)}` : null]
        .filter(Boolean).join(' · ');
};

const profileLines = (p) => {
    if (p.type === 'pm') {
        const lines = ['Datos para Pago Móvil'];
        if (p.banks.length === 1) lines.push(`Banco: ${bankLabel(p.banks[0])}`);
        else if (p.banks.length > 1) lines.push(`Bancos: ${p.banks.map(bankLabel).join(', ')}`);
        if (p.phoneNumber) lines.push(`Teléfono: ${formatPhone(p)}`);
        if (p.docNumber) lines.push(`${docLabel(p)}: ${formatDoc(p)}`);
        return lines;
    }
    const lines = ['Datos para Transferencia'];
    const code = p.account.slice(0, 4);
    if (bankName(code)) lines.push(`Banco: ${bankLabel(code)}`);
    if (p.account) lines.push(`Cuenta: ${p.account}`);
    if (p.holder) lines.push(`Titular: ${p.holder}`);
    if (p.docNumber) lines.push(`${docLabel(p)}: ${formatDoc(p)}`);
    return lines;
};

const makeEmptyCard = (icon, text, buttonText, onClick) => {
    const card = document.createElement('div');
    card.className = 'empty-card';
    card.innerHTML = `<i data-lucide="${icon}"></i><p></p>`;
    card.querySelector('p').textContent = text;
    if (buttonText) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip-btn';
        btn.innerHTML = '<i data-lucide="plus" class="ic-xs"></i>';
        btn.append(buttonText);
        btn.addEventListener('click', onClick);
        card.appendChild(btn);
    }
    return card;
};

const renderProfilesList = () => {
    const list = $('profiles-list');
    if (!list) return;
    list.innerHTML = '';
    if (!payProfiles.list.length) {
        list.appendChild(makeEmptyCard('credit-card', 'Aún no tienes perfiles de pago guardados.', 'Crear el primero', () => openProfileEditor(null)));
        refreshIcons();
        return;
    }
    payProfiles.list.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'profile-row';

        const star = document.createElement('button');
        star.type = 'button';
        star.className = `icon-btn profile-star${p.id === payProfiles.defaultId ? ' is-default' : ''}`;
        star.setAttribute('aria-label', 'Usar por defecto');
        star.title = 'Usar por defecto';
        star.innerHTML = '<i data-lucide="star" class="ic"></i>';
        star.addEventListener('click', () => {
            payProfiles.defaultId = p.id;
            saveProfiles();
            renderProfilesList();
            renderShareProfiles();
        });

        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'profile-main';
        main.innerHTML = '<span class="select-row-title"></span><span class="select-row-sub"></span>';
        main.querySelector('.select-row-title').textContent = p.name || 'Personal';
        main.querySelector('.select-row-sub').textContent = profileSummary(p);
        main.addEventListener('click', () => openProfileEditor(p));

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'icon-btn';
        edit.setAttribute('aria-label', 'Editar');
        edit.innerHTML = '<i data-lucide="pencil" class="ic-sm"></i>';
        edit.addEventListener('click', () => openProfileEditor(p));

        row.append(star, main, edit);
        list.appendChild(row);
    });
    refreshIcons();
};

// ── Editor de perfil ──
let editingProfile = null;
let editingIsNew = false;
let deleteArmedUntil = 0;

const editorSetType = (type) => {
    if (!editingProfile) return;
    editingProfile.type = type === 'tr' ? 'tr' : 'pm';
    document.querySelectorAll('#profile-type [data-type]').forEach((b) => {
        const sel = b.dataset.type === editingProfile.type;
        b.classList.toggle('is-selected', sel);
        b.setAttribute('aria-selected', String(sel));
    });
    document.querySelectorAll('#profile-editor [data-for]').forEach((el) => {
        if (el.dataset.for === editingProfile.type) showAnimated(el);
        else { el.classList.remove('anim-in', 'anim-out'); el.classList.add('hidden'); }
    });
};

const updateBanksSummary = () => {
    if (!editingProfile) return;
    setText('pf-banks-summary', editingProfile.banks.length
        ? editingProfile.banks.map((c) => bankName(c)).join(', ')
        : 'Ninguno');
};

// La lista se arma una vez por edición; tocar un banco solo cambia su estado
// (reconstruirla hacía saltar el scroll)
const editorRenderBanks = () => {
    if (!editingProfile) return;
    updateBanksSummary();
    const list = $('pf-banks-list');
    if (!list) return;
    list.innerHTML = '';
    BANKS.forEach(([code, name]) => {
        const item = document.createElement('button');
        item.type = 'button';
        const selected = editingProfile.banks.includes(code);
        item.className = `bank-item${selected ? ' is-selected' : ''}`;
        item.setAttribute('aria-pressed', String(selected));
        item.innerHTML = '<span class="bank-code"></span><span class="bank-name"></span>'
            + '<span class="select-check"><i data-lucide="check" class="ic-xs"></i></span>';
        item.querySelector('.bank-code').textContent = code;
        item.querySelector('.bank-name').textContent = name;
        item.addEventListener('click', () => {
            const i = editingProfile.banks.indexOf(code);
            if (i > -1) editingProfile.banks.splice(i, 1);
            else editingProfile.banks.push(code);
            item.classList.toggle('is-selected', i === -1);
            item.setAttribute('aria-pressed', String(i === -1));
            updateBanksSummary();
        });
        list.appendChild(item);
    });
    refreshIcons();
};

const editorUpdateAccountHint = () => {
    const hint = $('pf-account-bank');
    if (!hint || !editingProfile) return;
    const digits = editingProfile.account;
    const name = digits.length >= 4 ? bankName(digits.slice(0, 4)) : null;
    if (!digits) hint.textContent = 'Los primeros 4 dígitos indican el banco';
    else if (name) hint.textContent = `${name} · ${digits.length}/20 dígitos`;
    else hint.textContent = `${digits.length}/20 dígitos`;
    hint.classList.toggle('is-ok', !!name && digits.length === 20);
};

const setDeleteLabel = (text) => {
    const btn = $('btn-profile-delete');
    if (btn && btn.lastChild) btn.lastChild.textContent = text;
};

const openProfileEditor = (profile) => {
    editingIsNew = !profile;
    editingProfile = profile ? sanitizeProfile(JSON.parse(JSON.stringify(profile))) : newProfile();
    deleteArmedUntil = 0;
    setText('profile-editor-title', editingIsNew ? 'Nuevo perfil' : 'Editar perfil');
    $('pf-name').value = editingProfile.name;
    $('pf-doc-type').value = editingProfile.docType;
    $('pf-doc').value = editingProfile.docNumber;
    $('pf-phone-prefix').value = editingProfile.phonePrefix;
    $('pf-phone').value = editingProfile.phoneNumber;
    $('pf-holder').value = editingProfile.holder;
    $('pf-account').value = editingProfile.account;
    $('pf-banks-list')?.classList.remove('anim-in', 'anim-out');
    $('pf-banks-list')?.classList.add('hidden');
    $('pf-banks-chevron')?.classList.remove('is-open');
    $('pf-banks-toggle')?.setAttribute('aria-expanded', 'false');
    $('btn-profile-delete')?.classList.toggle('hidden', editingIsNew);
    setDeleteLabel('Eliminar perfil');
    editorSetType(editingProfile.type);
    editorRenderBanks();
    editorUpdateAccountHint();
    openOverlay('profile-editor');
};

const saveEditingProfile = () => {
    const p = editingProfile;
    if (!p) return;
    p.name = p.name.trim() || 'Personal';
    if (p.docNumber.length < 5) { showToast('Escribe el número de cédula o RIF', true); return; }
    if (p.type === 'pm') {
        if (p.phoneNumber.length !== 7) { showToast('El teléfono debe tener 7 dígitos después del prefijo', true); return; }
        if (!p.banks.length) { showToast('Elige al menos un banco', true); return; }
    } else if (p.account.length !== 20) {
        showToast('El número de cuenta debe tener 20 dígitos', true);
        return;
    }
    const clean = sanitizeProfile(p);
    if (editingIsNew) payProfiles.list.push(clean);
    else payProfiles.list = payProfiles.list.map((x) => (x.id === clean.id ? clean : x));
    if (!getProfile(payProfiles.defaultId)) payProfiles.defaultId = clean.id;
    if (editingIsNew) shareSelectedProfile = clean.id;
    saveProfiles();
    closeOverlay('profile-editor');
    showToast('Perfil guardado');
};

const setupProfiles = () => {
    openHooks['profiles-sheet'] = renderProfilesList;
    closeHooks['profile-editor'] = () => {
        editingProfile = null;
        renderProfilesList();
        renderShareProfiles();
        updateSettingsProfilesSub();
    };

    $('btn-profile-new')?.addEventListener('click', () => openProfileEditor(null));
    $('btn-profile-save')?.addEventListener('click', saveEditingProfile);

    document.querySelectorAll('#profile-type [data-type]').forEach((b) => {
        b.addEventListener('click', () => editorSetType(b.dataset.type));
    });

    const bindText = (id, field, digitsOnly, maxLen) => {
        $(id)?.addEventListener('input', (e) => {
            if (!editingProfile) return;
            let v = e.target.value;
            if (digitsOnly) {
                v = v.replace(/\D/g, '').slice(0, maxLen);
                if (v !== e.target.value) e.target.value = v;
            }
            editingProfile[field] = v;
            if (field === 'account') editorUpdateAccountHint();
        });
    };
    bindText('pf-name', 'name', false);
    bindText('pf-doc', 'docNumber', true, 10);
    bindText('pf-phone', 'phoneNumber', true, 7);
    bindText('pf-holder', 'holder', false);
    bindText('pf-account', 'account', true, 20);

    $('pf-doc-type')?.addEventListener('change', (e) => { if (editingProfile) editingProfile.docType = e.target.value; });
    $('pf-phone-prefix')?.addEventListener('change', (e) => { if (editingProfile) editingProfile.phonePrefix = e.target.value; });

    $('pf-banks-toggle')?.addEventListener('click', () => {
        const list = $('pf-banks-list');
        if (!list) return;
        const willOpen = !isShown(list);
        setShownAnimated(list, willOpen);
        $('pf-banks-toggle').setAttribute('aria-expanded', String(willOpen));
        $('pf-banks-chevron')?.classList.toggle('is-open', willOpen);
    });

    // Eliminar pide un segundo toque para evitar borrados accidentales
    $('btn-profile-delete')?.addEventListener('click', () => {
        if (!editingProfile || editingIsNew) return;
        if (Date.now() > deleteArmedUntil) {
            deleteArmedUntil = Date.now() + 3000;
            setDeleteLabel('Toca de nuevo para eliminar');
            setTimeout(() => { if (Date.now() > deleteArmedUntil) setDeleteLabel('Eliminar perfil'); }, 3100);
            return;
        }
        const id = editingProfile.id;
        payProfiles.list = payProfiles.list.filter((p) => p.id !== id);
        if (payProfiles.defaultId === id) payProfiles.defaultId = payProfiles.list[0]?.id || null;
        if (shareSelectedProfile === id) shareSelectedProfile = payProfiles.defaultId || 'none';
        saveProfiles();
        closeOverlay('profile-editor');
        showToast('Perfil eliminado');
    });
};

const updateSettingsProfilesSub = () => {
    const n = payProfiles.list.length;
    setText('settings-profiles-sub', n ? `${n} ${n === 1 ? 'perfil guardado' : 'perfiles guardados'}` : 'Tus datos de Pago Móvil y Transferencia');
};

// ══════════════════════════════════════════════════════════════
//  COMPARTIR
// ══════════════════════════════════════════════════════════════
const SHARE_OPTIONS = ['bcv', 'euro', 'binance', 'custom', 'usdt'];
let shareRates = ['bcv'];
let shareSelectedProfile = 'none';

const loadShareState = () => {
    const saved = store.getJSON(KEYS.share, null);
    if (saved && Array.isArray(saved.rates)) shareRates = saved.rates.filter((k) => SHARE_OPTIONS.includes(k));
};

const saveShareState = () => {
    const saved = store.getJSON(KEYS.share, {}) || {};
    store.setJSON(KEYS.share, { ...saved, rates: shareRates });
};

const isShareOptionAvailable = (k) => k !== 'custom' || (customRate.enabled && customRate.value > 0);

const shareOptionTitle = (k) => {
    if (k === 'usdt') return usdtMode === 'sell' ? 'USDT a vender' : 'USDT a comprar';
    const title = rateTitle(k);
    return useNext && nextRates && (k === 'bcv' || k === 'euro') ? `${title} (${formatDayMonthYear(nextRates.date)})` : title;
};

const shareOptionValue = (k) => (k === 'usdt' ? `${formatUsdt(lastUsdtNeeded)} USDT` : `${formatCardTotal(k)} ${cardSuffix(k)}`);

const makeSelectRow = (title, sub, selected, onClick) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `select-row${selected ? ' is-selected' : ''}`;
    row.setAttribute('aria-pressed', String(selected));
    row.innerHTML = '<span class="select-row-main"><span class="select-row-title"></span><span class="select-row-sub"></span></span>'
        + '<span class="select-check"><i data-lucide="check" class="ic-xs"></i></span>';
    row.querySelector('.select-row-title').textContent = title;
    row.querySelector('.select-row-sub').textContent = sub;
    row.addEventListener('click', onClick);
    return row;
};

const renderShareProfiles = () => {
    const list = $('share-profiles');
    if (!list) return;
    list.innerHTML = '';
    if (!payProfiles.list.length) {
        list.appendChild(makeEmptyCard('wallet-cards', 'Guarda tus datos de Pago Móvil o Transferencia para enviarlos con un toque.',
            'Crear perfil de pago', () => openProfileEditor(null)));
        refreshIcons();
        return;
    }
    if (shareSelectedProfile !== 'none' && !getProfile(shareSelectedProfile)) shareSelectedProfile = payProfiles.defaultId || 'none';
    // Elegir un perfil solo mueve la marca (sin reconstruir la lista)
    const select = (id) => {
        shareSelectedProfile = id;
        list.querySelectorAll('.select-row').forEach((r) => {
            const on = r.dataset.profile === id;
            r.classList.toggle('is-selected', on);
            r.setAttribute('aria-pressed', String(on));
        });
    };
    const addRow = (id, title, sub) => {
        const row = makeSelectRow(title, sub, shareSelectedProfile === id, () => select(id));
        row.dataset.profile = id;
        list.appendChild(row);
    };
    payProfiles.list.forEach((p) => {
        addRow(p.id, `${p.name || 'Personal'}${p.id === payProfiles.defaultId ? ' ★' : ''}`, profileSummary(p));
    });
    addRow('none', 'Sin datos de pago', 'Solo los montos');
    refreshIcons();
};

const renderShareRates = () => {
    const list = $('share-rates');
    if (!list) return;
    list.innerHTML = '';
    SHARE_OPTIONS.filter(isShareOptionAvailable).forEach((k) => {
        const row = makeSelectRow(shareOptionTitle(k), shareOptionValue(k), shareRates.includes(k), () => {
            const i = shareRates.indexOf(k);
            if (i > -1) shareRates.splice(i, 1);
            else shareRates.push(k);
            saveShareState();
            row.classList.toggle('is-selected', i === -1);
            row.setAttribute('aria-pressed', String(i === -1));
        });
        list.appendChild(row);
    });
    refreshIcons();
};

const buildShareMessage = () => {
    const lines = [`Monto: ${amountLabel()}`];
    SHARE_OPTIONS
        .filter((k) => shareRates.includes(k) && isShareOptionAvailable(k))
        .forEach((k) => lines.push(`${shareOptionTitle(k)}: ${shareOptionValue(k)}`));

    const profile = getProfile(shareSelectedProfile);
    if (profile) lines.push('', ...profileLines(profile));
    return lines.join('\n');
};

const setupShare = () => {
    openHooks['share-sheet'] = () => {
        shareSelectedProfile = getProfile(payProfiles.defaultId) ? payProfiles.defaultId : 'none';
        renderShareProfiles();
        renderShareRates();
    };

    $('btn-share-send')?.addEventListener('click', async () => {
        const text = buildShareMessage();
        const copied = await copyText(text, 'Datos copiados al portapapeles');
        // En el celular, además, abre el menú nativo para enviarlo por WhatsApp, etc.
        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        if (navigator.share && isTouch) {
            try { await navigator.share({ text }); } catch (e) { /* el usuario canceló */ }
        }
        if (copied) closeOverlay('share-sheet');
    });
};

// ══════════════════════════════════════════════════════════════
//  ALERTA DE BRECHA
// ══════════════════════════════════════════════════════════════
const getGapThreshold = () => {
    const n = parseFloat(store.get(KEYS.gapThreshold));
    return Number.isFinite(n) && n > 0 ? n : null;
};

// Resalta la tarjeta y notifica una sola vez por día y umbral
const checkGapAlert = (gapPct) => {
    const threshold = getGapThreshold();
    const exceeded = !!threshold && Number.isFinite(gapPct) && gapPct >= threshold;
    $('gap-card')?.classList.toggle('is-alert', exceeded);
    if (exceeded) {
        const sentKey = `${toDateKey(new Date())}:${threshold}`;
        if (store.get(KEYS.gapAlertSent) !== sentKey) {
            store.set(KEYS.gapAlertSent, sentKey);
            const enabled = store.get(KEYS.notifications) === 'true';
            if (enabled && 'Notification' in window && Notification.permission === 'granted') {
                new Notification('Brecha cambiaria alta', {
                    body: `La brecha es de ${NF2.format(gapPct)}% (tu límite: ${NF2.format(threshold)}%)`,
                    icon: '/icons/icon-192.png',
                });
            }
        }
    }
    return { exceeded, threshold };
};

// ══════════════════════════════════════════════════════════════
//  CONFIGURACIÓN
// ══════════════════════════════════════════════════════════════
const setSwitch = (id, on) => {
    const el = $(id);
    if (!el) return;
    el.classList.toggle('active', on);
    el.setAttribute('aria-checked', String(on));
};

const syncSettingsUI = () => {
    setSwitch('toggle-theme', document.documentElement.getAttribute('data-theme') === 'dark');
    const accent = document.documentElement.getAttribute('data-accent');
    document.querySelectorAll('#accent-seg [data-accent]').forEach((b) => b.classList.toggle('is-selected', b.dataset.accent === accent));
    applyView(viewMode);

    setSwitch('toggle-auto-next', isAutoNextEnabled());
    setSwitch('toggle-notifications', store.get(KEYS.notifications) === 'true');

    const threshold = getGapThreshold();
    setSwitch('toggle-gap-alert', !!threshold);
    setShownAnimated($('gap-alert-fields'), !!threshold);
    const gapInput = $('input-gap-threshold');
    if (gapInput && document.activeElement !== gapInput) gapInput.value = threshold ?? '';

    setSwitch('toggle-custom-rate', customRate.enabled);
    setShownAnimated($('custom-rate-fields'), customRate.enabled);
    const nameInput = $('input-custom-rate-name');
    const valueInput = $('input-custom-rate-value');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = customRate.name || '';
    if (valueInput && document.activeElement !== valueInput) valueInput.value = customRate.value || '';

    updateSettingsProfilesSub();
    updateInstallUI();
    setText('settings-version', `Monitor Bs. · v${APP_VERSION}`);
};

const setupSettings = () => {
    openHooks['settings-sheet'] = syncSettingsUI;

    $('toggle-theme')?.addEventListener('click', () => {
        applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        syncSettingsUI();
    });

    document.querySelectorAll('#accent-seg [data-accent]').forEach((b) => {
        b.addEventListener('click', () => { applyAccent(b.dataset.accent); syncSettingsUI(); });
    });

    document.querySelectorAll('#view-toggle [data-view], #view-seg [data-view]').forEach((b) => {
        b.addEventListener('click', () => applyView(b.dataset.view, { animate: true }));
    });

    $('toggle-auto-next')?.addEventListener('click', () => {
        store.set(KEYS.autoNext, isAutoNextEnabled() ? '0' : '1');
        // El ajuste manda: se olvida la elección manual de hoy para aplicarlo ya
        store.remove(KEYS.dayChoice);
        resolveUseNext();
        syncSettingsUI();
        updateUI();
    });

    $('toggle-notifications')?.addEventListener('click', async () => {
        const next = store.get(KEYS.notifications) !== 'true';
        if (next && 'Notification' in window && Notification.permission === 'default') {
            await Notification.requestPermission();
        }
        if (next && 'Notification' in window && Notification.permission === 'denied') {
            showToast('El navegador bloqueó las notificaciones', true);
        }
        store.set(KEYS.notifications, String(next));
        syncSettingsUI();
    });

    $('toggle-gap-alert')?.addEventListener('click', () => {
        if (getGapThreshold()) {
            store.remove(KEYS.gapThreshold);
            store.remove(KEYS.gapAlertSent);
        } else {
            store.set(KEYS.gapThreshold, String(parseFloat($('input-gap-threshold')?.value) || 40));
        }
        syncSettingsUI();
        updateUI();
    });

    $('input-gap-threshold')?.addEventListener('input', (e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n) && n > 0) {
            store.set(KEYS.gapThreshold, String(n));
            updateUI();
        }
    });

    $('toggle-custom-rate')?.addEventListener('click', () => {
        customRate.enabled = !customRate.enabled;
        saveCustomRate();
        buildRateCards({ enter: customRate.enabled ? 'custom' : null });
        updateUI();
        syncSettingsUI();
    });

    $('input-custom-rate-name')?.addEventListener('input', (e) => {
        customRate.name = e.target.value.trim();
        saveCustomRate();
        updateUI();
    });

    $('input-custom-rate-value')?.addEventListener('input', (e) => {
        const v = parseLocaleNumber(e.target.value);
        customRate.value = Number.isFinite(v) && v > 0 ? v : 0;
        saveCustomRate();
        updateUI();
    });

    $('btn-install-row')?.addEventListener('click', () => {
        closeOverlay('settings-sheet');
        installApp();
    });

    $('btn-open-whats-new')?.addEventListener('click', () => {
        closeOverlay('settings-sheet');
        showWhatsNew();
    });

    $('btn-open-tour')?.addEventListener('click', () => {
        closeOverlay('settings-sheet');
        startTour();
    });
};

// ══════════════════════════════════════════════════════════════
//  NOVEDADES Y GUÍA DE USO
// ══════════════════════════════════════════════════════════════
const WHATS_NEW = [
    { icon: 'arrow-left-right', title: 'Precios reales de compra y venta', desc: 'El equivalente en USDT usa el precio de Binance P2P para comprar o para vender, según lo que elijas.' },
    { icon: 'calendar', title: 'Tasa de mañana desde las 5 pm', desc: 'Cuando el BCV ya publicó la tasa del día siguiente, desde las 5 pm se usa sola. Toca "Hoy" si prefieres la vigente.' },
    { icon: 'calculator', title: 'Barra fija abajo', desc: 'La calculadora y el botón para instalar la app quedan siempre a mano en la parte inferior.' },
    { icon: 'wallet-cards', title: 'Perfiles de pago', desc: 'Guarda tus datos de Pago Móvil o Transferencia y envíalos con un toque al compartir.' },
    { icon: 'smartphone', title: 'Mejor en iPhone', desc: 'Ya no hace zoom al tocar campos, y el botón de instalar te muestra los pasos para agregarla a tu inicio.' },
    { icon: 'hand', title: 'Cierra deslizando', desc: 'Arrastra hacia abajo la barrita de cualquier ventana para cerrarla. La guía te deja probar cada botón.' },
];

const renderWhatsNew = () => {
    const list = $('whats-new-list');
    if (!list || list.childElementCount) return;
    WHATS_NEW.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'news-item';
        row.innerHTML = `<span class="rc-icon"><i data-lucide="${item.icon}" class="ic"></i></span>`
            + '<div><p class="news-title"></p><p class="news-desc"></p></div>';
        row.querySelector('.news-title').textContent = item.title;
        row.querySelector('.news-desc').textContent = item.desc;
        list.appendChild(row);
    });
    refreshIcons();
};

const markIntroSeen = () => {
    store.set(KEYS.onboarding, '1');
    store.set(KEYS.whatsNew, APP_VERSION);
};

const showWhatsNew = () => {
    renderWhatsNew();
    setText('whats-new-version', `Versión ${APP_VERSION}`);
    openOverlay('whats-new');
};

const TOUR_STEPS = [
    { element: '#converter', popover: { title: 'Conversor', description: 'Escribe el monto y se calcula al instante en todas las tasas. Puedes tocar lo resaltado para probarlo.' } },
    { element: '#currency-wrap', popover: { title: 'Moneda del monto', description: 'Elige si escribes el monto en Dólares, Euros o Bolívares. Tócalo para ver las opciones.' } },
    { element: '#btn-direction', popover: { title: 'Cambiar dirección', description: 'Alterna con un toque entre divisa → Bs y Bs → divisa.' } },
    { element: '#conv-icons', popover: { title: 'Acciones rápidas', description: 'Compartir con tu perfil de pago, copiar el monto a tasa BCV, pegar un monto copiado o borrarlo.' } },
    { element: '#rates-grid', popover: { title: 'Tasas', description: 'Toca una tarjeta para copiar su valor. Cada una muestra la fecha, la tasa anterior y cuánto cambió. La Brecha compara Binance con el BCV.' } },
    { element: '#view-toggle', popover: { title: 'Cuadrícula o lista', description: 'Elige cómo ver las tarjetas.' } },
    { element: '#hero', popover: { title: 'Equivalente en USDT', description: 'Cuántos USDT vender (o comprar) en Binance para cubrir tu monto a tasa BCV. El botón copia la cantidad y abre Binance P2P.' } },
    { element: '#dock-calc', popover: { title: 'Calculadora', description: 'Siempre a mano abajo (y también arriba). Suma precios, inserta tasas con un toque y usa el resultado como monto.' } },
    { element: '#dock-install', popover: { title: 'Instalar la app', description: 'Agrégala a tu pantalla de inicio para abrirla como una app. En iPhone te muestra los pasos.' } },
    { element: '#hdr-history', popover: { title: 'Historial', description: 'Consulta las tasas por fecha y expórtalas a CSV o Excel.' } },
    { element: '#hdr-settings', popover: { title: 'Configuración', description: 'Tema, color, perfiles de pago, alertas, tasa personalizada y esta guía cuando la necesites.' } },
];

const DRIVER_JS = 'https://cdn.jsdelivr.net/npm/driver.js@1.3.1/dist/driver.js.iife.js';
const DRIVER_CSS = 'https://cdn.jsdelivr.net/npm/driver.js@1.3.1/dist/driver.css';

let activeTour = null;
let tourResumeAt = null;

// Si durante la guía se toca un botón que abre una hoja, la guía se pausa
// y continúa en el paso siguiente al cerrar esa hoja.
const suspendTourIfActive = () => {
    if (!activeTour) return;
    const tour = activeTour;
    tourResumeAt = (tour.getActiveIndex() ?? 0) + 1;
    activeTour = null;
    tour.destroy();
};

const resumeTourIfSuspended = () => {
    if (tourResumeAt === null) return;
    const index = tourResumeAt;
    tourResumeAt = null;
    setTimeout(() => startTour(index), 300);
};

const startTour = async (fromIndex = 0) => {
    if (!fromIndex) { tourResumeAt = null; closeAllOverlays(); }
    try {
        if (!document.querySelector(`link[href="${DRIVER_CSS}"]`)) {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = DRIVER_CSS;
            document.head.appendChild(css);
        }
        await loadScriptOnce(DRIVER_JS);
    } catch (e) {
        showToast('No se pudo cargar la guía', true);
        return;
    }
    const steps = TOUR_STEPS.filter((s) => {
        const el = document.querySelector(s.element);
        return el && el.offsetParent !== null;
    });
    if (fromIndex >= steps.length) { markIntroSeen(); return; }
    if (!fromIndex) window.scrollTo({ top: 0 });

    activeTour = window.driver.js.driver({
        showProgress: true,
        progressText: '{{current}} de {{total}}',
        nextBtnText: 'Siguiente',
        prevBtnText: 'Anterior',
        doneBtnText: '¡Listo!',
        popoverClass: 'mbs-tour',
        stagePadding: 6,
        stageRadius: 14,
        overlayOpacity: 0.65,
        smoothScroll: true,
        disableActiveInteraction: false,
        steps,
        onDestroyed: () => {
            activeTour = null;
            markIntroSeen();
        },
    });
    activeTour.drive(fromIndex);
};

// Nuevo usuario → guía. Usuario que se actualiza → novedades. Solo una vez.
let introChecked = false;
const maybeShowIntro = (isFirstVisit) => {
    if (introChecked) return;
    introChecked = true;
    if (topOverlay()) return;
    if (!store.get(KEYS.onboarding)) {
        if (isFirstVisit) setTimeout(() => startTour(), 600);
        else showWhatsNew();
    } else if (store.get(KEYS.whatsNew) !== APP_VERSION) {
        showWhatsNew();
    }
};

const setupWhatsNew = () => {
    closeHooks['whats-new'] = markIntroSeen;
    $('whats-new-ok')?.addEventListener('click', () => closeOverlay('whats-new'));
    $('whats-new-tour')?.addEventListener('click', () => {
        closeOverlay('whats-new');
        startTour();
    });
};

// ══════════════════════════════════════════════════════════════
//  CONSULTA DE TASAS (Cloudflare Function + respaldo dolarapi)
// ══════════════════════════════════════════════════════════════
const showError = (msg) => {
    if (msg) setText('error-text', msg);
    setShownAnimated($('error-msg'), !!msg);
};

const setLoadState = (state) => {
    isLoading = state;
    $('icon-refresh')?.classList.toggle('animate-spin', state);
    if (state) {
        setText('text-update', 'Buscando tasas...');
    } else if (lastFetchAt) {
        setText('text-update', `Actualizado ${formatRelative(lastFetchAt).replace('Hoy, ', 'hoy ')}`);
    }
    updateUI();
};

const fetchRates = async () => {
    // Intento 1: Cloudflare Pages Function (Binance P2P directo)
    try {
        const res = await fetch('/api/rates', { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
            const j = await res.json();
            if (j.bcv && j.binance && j.euro) {
                return { bcv: j.bcv, binance: j.binance, euro: j.euro, date: j.rateDate ? dateFromKey(j.rateDate) : null };
            }
        }
    } catch (e) {
        console.warn('[/api/rates]', e.message);
    }

    // Intento 2: dolarapi.com directo
    const [resUSD, resEUR] = await Promise.all([
        fetch(`${DOLARAPI}/dolares`, { signal: AbortSignal.timeout(10000) }),
        fetch(`${DOLARAPI}/euros`, { signal: AbortSignal.timeout(10000) }),
    ]);
    if (!resUSD.ok || !resEUR.ok) throw new Error('dolarapi no disponible');
    const jUSD = await resUSD.json();
    const jEUR = await resEUR.json();
    const bcvEntry = jUSD.find((i) => i.fuente === 'oficial');
    const parallel = jUSD.find((i) => i.fuente === 'paralelo');
    const euro = Array.isArray(jEUR) ? jEUR.find((i) => i.fuente === 'oficial')?.promedio : jEUR.promedio;
    // "2026-10-20T00:00:00-04:00": se toma la fecha tal cual, sin convertir zona horaria
    const rawDate = bcvEntry?.fechaActualizacion;
    const date = typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? dateFromKey(rawDate.slice(0, 10)) : null;
    return { bcv: bcvEntry?.promedio ?? 0, binance: parallel?.promedio ?? 0, euro: euro ?? 0, date };
};

let fetchInFlight = null;
const fetchData = () => {
    if (fetchInFlight) return fetchInFlight;
    fetchInFlight = (async () => {
        if (!navigator.onLine) {
            showError('Sin conexión. Mostrando las últimas tasas guardadas.');
            updateUI();
            return;
        }
        setLoadState(true);
        showError(null);
        try {
            const [r, quotes] = await Promise.all([
                fetchRates(),
                fetchBinanceQuotes().catch((e) => { console.warn('[Binance P2P]', e.message); return null; }),
            ]);
            if (!r.bcv || !r.binance || !r.euro) throw new Error('Datos incompletos');

            // Precios reales de Binance P2P (compra/venta). Se ignoran si se alejan
            // demasiado de la tasa paralela, por si la respuesta viene corrupta.
            if (quotes && Math.abs((quotes.buy + quotes.sell) / 2 - r.binance) / r.binance < 0.15) {
                binanceQuotes = quotes;
                r.binance = Math.round(((quotes.buy + quotes.sell) / 2) * 100) / 100;
            }

            if (hasFetchedOnce && (r.bcv !== data.bcv || r.binance !== data.binance || r.euro !== data.euro)) {
                sessionPrev = { bcv: data.bcv, binance: data.binance, euro: data.euro };
            }
            hasFetchedOnce = true;
            data = { ...data, bcv: r.bcv, binance: r.binance, euro: r.euro };
            rateDate = r.date;
            lastFetchAt = new Date();

            // BCV/Euro se guardan con su fecha oficial; el paralelo con la fecha de hoy
            const officialKey = toDateKey(rateDate || lastFetchAt);
            const todayKey = toDateKey(lastFetchAt);
            const updates = { [officialKey]: { bcv: r.bcv, euro: r.euro } };
            updates[todayKey] = { ...(updates[todayKey] || {}), binance: r.binance };
            mergeHistory(updates);
            saveToStorage();
        } catch (err) {
            console.error('[fetchData]', err.message);
            showError('No se obtuvieron tasas. Intenta actualizar de nuevo en unos minutos.');
            if (!loadFromStorage()) data = { ...data, ...DEFAULT_RATES };
        } finally {
            refreshDerivedRates();
            setLoadState(false);
        }
        // El histórico (tasa de mañana, "Antes") llega aparte, sin bloquear la carga
        syncHistoricos().then((changed) => {
            if (!changed) return;
            refreshDerivedRates();
            updateUI();
            if (!$('history-sheet')?.classList.contains('hidden')) renderHistoryList();
        });
    })().finally(() => { fetchInFlight = null; });
    return fetchInFlight;
};

// ══════════════════════════════════════════════════════════════
//  PWA: conexión, instalación y Service Worker
// ══════════════════════════════════════════════════════════════
const updateOnlineStatus = () => $('offline-badge')?.classList.toggle('hidden', navigator.onLine);

// Abre la misma página en Chrome (si no está instalado, se queda en el navegador actual)
const chromeIntentUrl = () => {
    const { host, pathname, search, href } = window.location;
    return `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;`
        + `S.browser_fallback_url=${encodeURIComponent(href)};end`;
};

// El botón "Instalar app" de la barra inferior y de Configuración solo se
// oculta cuando ya se está usando la app instalada
const updateInstallUI = () => {
    const standalone = isStandalone();
    $('dock-install')?.classList.toggle('hidden', standalone);
    $('btn-install-row')?.classList.toggle('hidden', standalone);
    let sub = 'Acceso directo en tu pantalla de inicio';
    if (isSamsungInternet()) sub = 'Se abre en Chrome para instalarla sin bloqueos';
    else if (isIOS()) sub = 'Desde Compartir → Agregar a inicio';
    setText('install-row-sub', sub);
};

// Ventana con los pasos, para cuando el navegador no tiene botón de instalar
// (iPhone/iPad siempre; en otros, si la app ya está instalada o no es compatible)
const showInstallHelp = () => {
    const steps = $('install-steps');
    if (!steps) return;
    let kicker;
    let items;
    let note = '';
    if (isIOS()) {
        kicker = 'iPhone / iPad';
        items = [
            ['Toca el botón ', { strong: 'Compartir' }, ' (el cuadro con la flecha hacia arriba) en la barra del navegador.'],
            ['Baja y elige ', { strong: 'Agregar a inicio' }, '.'],
            ['Toca ', { strong: 'Agregar' }, '. La app aparecerá en tu pantalla de inicio.'],
        ];
        note = 'Funciona en Safari. En Chrome u otros navegadores necesitas iOS 16.4 o superior; si no te aparece la opción, abre esta página en Safari.';
    } else {
        kicker = 'Desde el menú del navegador';
        items = [
            ['Abre el ', { strong: 'menú' }, ' del navegador (⋮ o ☰).'],
            ['Elige ', { strong: 'Instalar app' }, ' o ', { strong: 'Agregar a la pantalla de inicio' }, '.'],
            ['Confirma. Si ya la instalaste, ábrela desde tu pantalla de inicio.'],
        ];
    }
    setText('install-help-kicker', kicker);
    steps.innerHTML = '';
    items.forEach((parts) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        fillRichText(span, parts);
        li.appendChild(span);
        steps.appendChild(li);
    });
    setText('install-note', note);
    openOverlay('install-help');
};

const installApp = async () => {
    if (isStandalone()) { showToast('Ya estás usando la app instalada'); return; }
    // Samsung Internet genera un APK que Play Protect bloquea en Android 14+
    if (isSamsungInternet()) { window.location.href = chromeIntentUrl(); return; }
    if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice.catch(() => null);
        deferredInstallPrompt = null;
        return;
    }
    showInstallHelp();
};

const setupInstall = () => {
    $('dock-install')?.addEventListener('click', installApp);
    updateInstallUI();
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        // En Samsung Internet no se usa: su instalación termina bloqueada
        if (!isSamsungInternet()) deferredInstallPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        showToast('App instalada. Ábrela desde tu pantalla de inicio');
    });
};

const registerServiceWorker = async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        reg.addEventListener('updatefound', () => {
            const worker = reg.installing;
            worker?.addEventListener('statechange', () => {
                if (worker.state === 'activated') window.location.reload();
            });
        });
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data?.type === 'SYNC_RATES') fetchData();
        });
        if ('SyncManager' in window) reg.sync.register('sync-rates').catch(() => { });
    } catch (err) {
        console.warn('[SW]', err);
    }
};

const setupGlobalListeners = () => {
    $('btn-refresh')?.addEventListener('click', () => fetchData());
    window.addEventListener('online', () => { updateOnlineStatus(); fetchData(); });
    window.addEventListener('offline', updateOnlineStatus);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!lastFetchAt || Date.now() - lastFetchAt.getTime() > 5 * 60 * 1000) fetchData();
    });
};

// ══════════════════════════════════════════════════════════════
//  INICIO
// ══════════════════════════════════════════════════════════════
const init = () => {
    const isFirstVisit = !store.get(KEYS.data) && !store.get(KEYS.onboarding);

    loadCustomRate();
    loadProfiles();
    loadShareState();
    const savedCurrency = store.get(KEYS.currency);
    if (CURRENCY[savedCurrency]) {
        inputCurrency = savedCurrency;
        if (savedCurrency !== 'bs') lastForeign = savedCurrency;
    }
    viewMode = store.get(KEYS.view) === 'list' ? 'list' : 'grid';

    buildRateCards({ enter: 'all' });
    applyView(viewMode);
    refreshIcons();

    setupOverlays();
    setupConverter();
    setupDaySeg();
    setupUsdtCard();
    setupCalculator();
    setupHistory();
    setupProfiles();
    setupShare();
    setupSettings();
    setupWhatsNew();
    setupInstall();
    setupGlobalListeners();
    updateOnlineStatus();
    registerServiceWorker();

    if (loadFromStorage()) setText('text-update', 'Cargando tasas...');
    refreshDerivedRates();
    updateUI();

    fetchData().then(() => maybeShowIntro(isFirstVisit));
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
