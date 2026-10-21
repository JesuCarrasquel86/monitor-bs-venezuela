/* ============================================================
   app.js – Monitor Bs. (PWA)
   ============================================================ */

'use strict';

const APP_VERSION = '3.0.0';
console.log(`monitor-bs-vz v${APP_VERSION} starting...`);

// ── Claves de almacenamiento (se conservan las de versiones anteriores) ──
const KEYS = {
    data: 'monitor-dolar-data',
    theme: 'monitor-dolar-theme',
    accent: 'monitor-dolar-accent',
    history: 'monitor-dolar-history',
    customRate: 'monitor-dolar-custom-rate',
    calcHistory: 'monitor-dolar-calc-history',
    gapThreshold: 'monitor-dolar-gap-threshold',
    gapAlertSent: 'monitor-dolar-gap-alert-sent',
    notifications: 'notifications-enabled',
    view: 'monitor-dolar-view',
    currency: 'monitor-dolar-currency',
    share: 'monitor-dolar-share',
    onboarding: 'monitor-dolar-onboarding-done',
    whatsNew: 'monitor-dolar-whats-new-seen',
    backfill: 'monitor-dolar-backfill',
    installDismissed: 'pwa-install-dismissed',
    samsungHintDismissed: 'samsung-chrome-hint-dismissed',
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

let data = { ...DEFAULT_RATES, amount: 1 };
let inputCurrency = 'usd';  // moneda en la que se escribe el monto: 'usd' | 'eur' | 'bs'
let lastForeign = 'usd';    // última divisa usada, para volver desde Bs con el botón de dirección
let isLoading = false;
let rateDate = null;        // fecha oficial de la tasa BCV (Date)
let lastFetchAt = null;     // momento de la última consulta exitosa (Date)
let hasFetchedOnce = false; // evita comparar la 1ra tasa real contra los valores placeholder
let sessionPrev = null;     // tasas antes de la última consulta de esta sesión
let prevRates = null;       // tasas del día anterior según el historial
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

const formatDayMonthYear = (d) =>
    `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

const formatLongDate = (d) => `${cap(d.toLocaleDateString('es-VE', { weekday: 'long' }))}, ${formatDayMonthYear(d)}`;

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

// ── Toast + portapapeles ──────────────────────────────────────
let toastTimer = null;
const showToast = (msg, isError = false) => {
    const el = $('toast');
    if (!el) return;
    setText('toast-text', msg);
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
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
const isBsMode = () => inputCurrency === 'bs';
const officialRate = () => (inputCurrency === 'eur' ? data.euro : data.bcv);
const getRate = (key) => (key === 'custom' ? customRate.value : data[key]);
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

const gapPercent = (bcv = data.bcv, binance = data.binance) => (bcv > 0 ? ((binance - bcv) / bcv) * 100 : 0);

const pctChange = (prev, curr) => (prev > 0 && curr > 0 ? ((curr - prev) / prev) * 100 : null);

const prevFor = (key) => (prevRates && prevRates[key]) || (sessionPrev && sessionPrev[key]) || null;

// ── Persistencia de tasas ─────────────────────────────────────
const saveToStorage = () => {
    store.setJSON(KEYS.data, {
        bcv: data.bcv,
        binance: data.binance,
        euro: data.euro,
        rateDate: rateDate ? toDateKey(rateDate) : null,
        savedAt: (lastFetchAt || new Date()).toISOString(),
    });
};

const loadFromStorage = () => {
    const stored = store.getJSON(KEYS.data, null);
    if (!stored || !stored.bcv || !stored.binance || !stored.euro) return false;
    data = { ...data, bcv: stored.bcv, binance: stored.binance, euro: stored.euro };
    if (stored.rateDate) rateDate = dateFromKey(stored.rateDate);
    if (stored.savedAt) lastFetchAt = new Date(stored.savedAt);
    hasFetchedOnce = true;
    return true;
};

// ── Historial diario de tasas ─────────────────────────────────
const saveHistoryEntry = (dateKey, entry) => {
    const history = store.getJSON(KEYS.history, {}) || {};
    history[dateKey] = { ...entry, savedAt: new Date().toISOString() };
    // Solo los últimos 14 días para no llenar localStorage
    const trimmed = {};
    Object.keys(history).sort().slice(-14).forEach((k) => { trimmed[k] = history[k]; });
    store.setJSON(KEYS.history, trimmed);
};

const getAllHistoryEntries = () => {
    const history = store.getJSON(KEYS.history, {}) || {};
    return Object.entries(history)
        .map(([date, v]) => ({ date, bcv: v.bcv, binance: v.binance, euro: v.euro }))
        .filter((e) => e.bcv && e.binance && e.euro)
        .sort((a, b) => b.date.localeCompare(a.date));
};

const refreshPrevRates = () => {
    const currentKey = toDateKey(rateDate || new Date());
    prevRates = getAllHistoryEntries().find((e) => e.date < currentKey) || null;
};

// Completa el historial local con el guardado en Cloudflare KV, para que
// "Antes" y el Historial tengan datos desde el primer día de uso.
const backfillHistory = async () => {
    const today = toDateKey(new Date());
    if (store.get(KEYS.backfill) === today) return;
    try {
        const res = await fetch('/api/history', { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return;
        const { available = [] } = await res.json();
        const local = new Set(getAllHistoryEntries().map((e) => e.date));
        const missing = available.filter((d) => !local.has(d)).slice(0, 14);
        await Promise.all(missing.map(async (d) => {
            try {
                const r = await fetch(`/api/history?date=${encodeURIComponent(d)}`, { signal: AbortSignal.timeout(8000) });
                if (!r.ok) return;
                const j = await r.json();
                if (j.bcv && j.binance && j.euro) saveHistoryEntry(d, { bcv: j.bcv, binance: j.binance, euro: j.euro });
            } catch (e) { }
        }));
        store.set(KEYS.backfill, today);
        if (missing.length) {
            refreshPrevRates();
            updateUI();
        }
    } catch (e) {
        console.warn('[backfillHistory]', e.message);
    }
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

const applyView = (mode) => {
    viewMode = mode === 'list' ? 'list' : 'grid';
    store.set(KEYS.view, viewMode);
    $('rates-grid')?.classList.toggle('is-list', viewMode === 'list');
    document.querySelectorAll('#view-toggle [data-view], #view-seg [data-view]').forEach((b) => {
        b.classList.toggle('is-selected', b.dataset.view === viewMode);
    });
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
    const willOpen = open === undefined ? menu.classList.contains('hidden') : open;
    menu.classList.toggle('hidden', !willOpen);
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

    const hint = $('conv-hint');
    if (hint) {
        const value = isBsMode()
            ? `${formatUsdt(data.bcv > 0 ? data.amount / data.bcv : 0)} $`
            : `${formatBs(data.amount * officialRate())} Bs`;
        hint.innerHTML = '';
        hint.append('= ');
        const strong = document.createElement('strong');
        strong.textContent = value;
        hint.append(strong, ' a tasa BCV');
    }
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
        setAmount(n);
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
        if (isBsMode()) {
            copyText(formatUsdt(data.bcv > 0 ? data.amount / data.bcv : 0), 'Monto en $ a tasa BCV copiado');
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
        const input2 = $('input-amount');
        if (input2) { input2.value = ''; input2.focus(); }
    });
};

// ══════════════════════════════════════════════════════════════
//  TARJETAS DE TASAS
// ══════════════════════════════════════════════════════════════
const buildRateCards = () => {
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
    setText(`line1-${key}`, data.amount !== 1 && rate ? `1 ${sym} = ${formatBs(rate)} Bs` : '');
    setText(`line2-${key}`, cardDateText(key));

    const prev = key === 'custom' ? null : prevFor(key);
    setText(`line3-${key}`, prev ? `Antes: ${formatBs(prev)}` : '');
    renderChange(`change-${key}`, prev ? pctChange(prev, rate) : null, '%');
};

const renderGapCard = (gapAlert) => {
    const gap = gapPercent();
    setText('title-gap', 'Brecha');
    setText('total-gap', isLoading ? '--' : NF2.format(gap));
    setText('suffix-gap', '%');

    if (isBsMode()) {
        const diffUsd = data.bcv > 0 && data.binance > 0 ? data.amount / data.bcv - data.amount / data.binance : 0;
        setText('line1-gap', `${formatUsdt(diffUsd)} $ de diferencia`);
    } else {
        setText('line1-gap', `+${formatBs((data.binance - data.bcv) * data.amount)} Bs de diferencia`);
    }
    setText('line2-gap', 'Binance vs. BCV');

    const pb = prevFor('bcv');
    const pp = prevFor('binance');
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
    if (rateDate) {
        const isToday = toDateKey(rateDate) === toDateKey(new Date());
        badge.textContent = isToday
            ? 'Hoy'
            : `${cap(rateDate.toLocaleDateString('es-VE', { weekday: 'short' }))} ${formatDayMonthYear(rateDate).slice(0, 5)}`;
        badge.classList.toggle('is-historical', !isToday);
    } else {
        badge.textContent = isLoading ? '...' : '';
        badge.classList.remove('is-historical');
    }
};

// ── Render general ────────────────────────────────────────────
const updateUI = () => {
    updateConverterChrome();

    // Diferencia a tasa: USDT a vender para cubrir el monto a tasa oficial
    const usdt = data.binance > 0
        ? (isBsMode() ? data.amount / data.binance : (data.amount * officialRate()) / data.binance)
        : 0;
    lastUsdtNeeded = usdt;
    setText('eq-usdt', isLoading ? '--' : `${formatUsdt(usdt)} USDT`);
    setText('sub-amount', amountLabel());

    const gapAlert = isLoading ? { exceeded: false } : checkGapAlert(gapPercent());
    ['bcv', 'euro', 'binance', 'custom'].forEach(renderRateCard);
    renderGapCard(gapAlert);
    updateRateDateBadge();

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

const openOverlay = (id) => {
    const el = $(id);
    if (!el || !el.classList.contains('hidden')) return;
    toggleCurrencyMenu(false);
    if (openHooks[id]) openHooks[id]();
    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    openStack.push(id);
    document.body.classList.add('no-scroll');
    document.querySelectorAll(`[data-opens="${id}"]`).forEach((b) => b.classList.add('is-active'));
};

const closeOverlay = (id) => {
    const el = $(id);
    if (!el || el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    el.setAttribute('aria-hidden', 'true');
    const i = openStack.lastIndexOf(id);
    if (i > -1) openStack.splice(i, 1);
    if (!openStack.length) document.body.classList.remove('no-scroll');
    document.querySelectorAll(`[data-opens="${id}"]`).forEach((b) => b.classList.remove('is-active'));
    if (closeHooks[id]) closeHooks[id]();
};

const closeAllOverlays = () => { while (topOverlay()) closeOverlay(topOverlay()); };

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
        if (!$('currency-menu')?.classList.contains('hidden')) { toggleCurrencyMenu(false); return; }
        if (topOverlay()) closeOverlay(topOverlay());
    });
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

const calcPreview = () => calcEvaluate(calcExpr);

// Número que se está escribiendo, con separador de miles: "~1234.5" → "-1.234,5"
const groupTyped = (s) => {
    const m = s.match(/^(~?)(\d*)(\.?)(\d*)(%?)$/);
    if (!m) return toCalcDisplay(s);
    const [, neg, int, dot, dec, pct] = m;
    const intPart = int ? NF0.format(Number(int)) : (dot ? '0' : '');
    return `${neg ? '-' : ''}${intPart}${dot ? ',' : ''}${dec}${pct}`;
};

const renderCalc = () => {
    const hasOp = calcHasOp();
    const preview = calcPreview();
    setText('calc-expression', hasOp ? toCalcDisplay(calcExpr) : calcEchoExpr);
    let main;
    if (!calcExpr) main = '0';
    else if (hasOp) main = preview !== null ? formatCalc(preview) : toCalcDisplay(calcExpr);
    else main = groupTyped(calcExpr);
    setText('calc-main', main);
    renderCalcItems();
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

const calcEquals = () => {
    const v = calcPreview();
    if (v === null) return;
    if (calcHasOp() || calcExpr.includes('%')) {
        const shown = toCalcDisplay(calcExpr);
        calcEchoExpr = `${shown} =`;
        saveCalcHistoryEntry(shown, v);
    }
    calcExpr = numToCalcExpr(v);
    calcJustEvaluated = true;
    renderCalc();
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

// ── Modo "canasta": cada sumando como chip removible ──
const getCalcItems = () => (/^[\d.]+(\+[\d.]+)+$/.test(calcExpr) ? calcExpr.split('+') : null);

const renderCalcItems = () => {
    const wrap = $('calc-items');
    if (!wrap) return;
    const items = getCalcItems();
    wrap.classList.toggle('hidden', !items);
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

// ── Tasas listas para insertar ──
const renderCalcChips = () => {
    const current = $('calc-chips-current');
    const previous = $('calc-chips-prev');
    if (!current || !previous) return;

    const makeChip = (key, value, isPrev) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `rate-chip${isPrev ? ' is-prev' : ''}`;
        b.dataset.color = RATE_DEFS[key].color;
        b.innerHTML = '<span class="dot"></span><span class="lbl"></span><span class="val"></span>';
        b.querySelector('.lbl').textContent = isPrev ? `${chipTitle(key)} ant.` : chipTitle(key);
        b.querySelector('.val').textContent = formatBs(value);
        b.addEventListener('click', () => calcInsertNumber(value));
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
    $('calc-history-panel')?.classList.toggle('hidden', !visible);
    $('calc-chips-block')?.classList.toggle('hidden', visible);
    $('calc-history-toggle')?.classList.toggle('is-active', visible);
    if (visible) renderCalcHistory();
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
        setCalcHistoryVisible($('calc-history-panel')?.classList.contains('hidden'));
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
        buildRateCards();
        updateUI();
        renderCalcChips();
        showToast(`Guardada como "${customRate.name || 'Mi tasa'}"`);
    });

    $('btn-calc-use')?.addEventListener('click', () => {
        const v = calcPreview();
        if (v === null) { showToast('No hay un resultado para usar', true); return; }
        if (v < 0) { showToast('El monto no puede ser negativo', true); return; }
        if (calcHasOp() || calcExpr.includes('%')) saveCalcHistoryEntry(toCalcDisplay(calcExpr), v);
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
const getNDaysAgoKey = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return toDateKey(d);
};

let historyStart = getNDaysAgoKey(7);
let historyEnd = toDateKey(new Date());

const getFilteredHistoryEntries = () =>
    getAllHistoryEntries().filter((e) => e.date >= historyStart && e.date <= historyEnd);

const renderHistoryList = () => {
    const list = $('history-list');
    if (!list) return;
    const entries = getFilteredHistoryEntries();
    list.innerHTML = '';

    if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'history-empty';
        empty.textContent = 'Sin registros en este rango. El historial se acumula con cada visita a la app.';
        list.appendChild(empty);
        return;
    }

    const makeCell = (label, value, isValue, onClick) => {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `history-cell${isValue ? ' is-value' : ''}`;
        const l = document.createElement('span');
        l.className = 'history-cell-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'history-cell-value';
        v.textContent = value;
        cell.append(l, v);
        cell.addEventListener('click', onClick);
        return cell;
    };

    entries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'history-row';
        const d = dateFromKey(entry.date);
        const dateText = `${cap(d.toLocaleDateString('es-VE', { weekday: 'short' }))} ${formatDayMonthYear(d)}`;
        row.appendChild(makeCell('Fecha', dateText, false, () => copyText(formatDayMonthYear(d), 'Fecha copiada')));

        const values = document.createElement('div');
        values.className = 'history-values';
        [['bcv', 'USD'], ['euro', 'EUR'], ['binance', 'P2P']].forEach(([k, label]) => {
            values.appendChild(makeCell(label, formatBs(entry[k]), true, () => copyText(formatBs(entry[k]), 'Tasa copiada')));
        });
        row.appendChild(values);
        list.appendChild(row);
    });
};

const updateHistoryResetVisibility = () => {
    const isDefault = historyStart === getNDaysAgoKey(7) && historyEnd === toDateKey(new Date());
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
    const rows = [['Fecha', 'BCV (Bs)', 'Euro (Bs)', 'Binance P2P (Bs)'], ...entries.map((e) => [e.date, e.bcv, e.euro, e.binance])];
    downloadBlob(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv;charset=utf-8;' }),
        `monitor-bs_historial_${historyStart}_${historyEnd}.csv`);
};

// ExcelJS (~950KB) se carga solo cuando alguien exporta a Excel
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
            { header: 'Binance P2P (Bs)', key: 'binance', width: 16 },
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
        historyStart = start.value || getNDaysAgoKey(7);
        updateHistoryResetVisibility();
        renderHistoryList();
    });
    end?.addEventListener('change', () => {
        historyEnd = end.value || toDateKey(new Date());
        updateHistoryResetVisibility();
        renderHistoryList();
    });
    $('history-reset')?.addEventListener('click', () => {
        historyStart = getNDaysAgoKey(7);
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
//  COMPARTIR (con datos de Pago Móvil / Transferencia)
// ══════════════════════════════════════════════════════════════
const SHARE_OPTIONS = ['bcv', 'euro', 'binance', 'custom', 'usdt'];

let shareState = {
    method: 'pm',
    pm: { bank: '', phone: '', id: '' },
    tr: { bank: '', account: '', holder: '', id: '' },
    rates: ['bcv'],
};

const loadShareState = () => {
    const saved = store.getJSON(KEYS.share, null);
    if (!saved) return;
    shareState = {
        method: saved.method === 'tr' ? 'tr' : 'pm',
        pm: { ...shareState.pm, ...saved.pm },
        tr: { ...shareState.tr, ...saved.tr },
        rates: Array.isArray(saved.rates) ? saved.rates : shareState.rates,
    };
};

const saveShareState = () => store.setJSON(KEYS.share, shareState);

const isShareOptionAvailable = (k) => k !== 'custom' || (customRate.enabled && customRate.value > 0);
const shareOptionTitle = (k) => (k === 'usdt' ? 'USDT a vender' : rateTitle(k));
const shareOptionValue = (k) => (k === 'usdt' ? `${formatUsdt(lastUsdtNeeded)} USDT` : `${formatCardTotal(k)} ${cardSuffix(k)}`);

const syncShareMethod = () => {
    document.querySelectorAll('#share-method [data-method]').forEach((b) => {
        const selected = b.dataset.method === shareState.method;
        b.classList.toggle('is-selected', selected);
        b.setAttribute('aria-selected', String(selected));
    });
    $('share-fields-pm')?.classList.toggle('hidden', shareState.method !== 'pm');
    $('share-fields-tr')?.classList.toggle('hidden', shareState.method !== 'tr');
};

const renderShareRates = () => {
    const list = $('share-rates');
    if (!list) return;
    list.innerHTML = '';
    SHARE_OPTIONS.filter(isShareOptionAvailable).forEach((k) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'select-row';
        row.classList.toggle('is-selected', shareState.rates.includes(k));
        row.setAttribute('aria-pressed', String(shareState.rates.includes(k)));
        row.innerHTML = '<span><span class="select-row-title"></span><span class="select-row-sub"></span></span>'
            + '<span class="select-check"><i data-lucide="check" class="ic-xs"></i></span>';
        row.querySelector('.select-row-title').textContent = shareOptionTitle(k);
        row.querySelector('.select-row-sub').textContent = shareOptionValue(k);
        row.addEventListener('click', () => {
            const i = shareState.rates.indexOf(k);
            if (i > -1) shareState.rates.splice(i, 1);
            else shareState.rates.push(k);
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
        .filter((k) => shareState.rates.includes(k) && isShareOptionAvailable(k))
        .forEach((k) => lines.push(`${shareOptionTitle(k)}: ${shareOptionValue(k)}`));

    const f = shareState[shareState.method];
    const fields = shareState.method === 'pm'
        ? [['Banco', f.bank], ['Teléfono', f.phone], ['C.I./RIF', f.id]]
        : [['Banco', f.bank], ['Cuenta', f.account], ['Titular', f.holder], ['C.I./RIF', f.id]];
    const filled = fields.filter(([, v]) => v && v.trim());
    if (filled.length) {
        lines.push('', shareState.method === 'pm' ? 'Datos para Pago Móvil' : 'Datos para Transferencia');
        filled.forEach(([label, v]) => lines.push(`${label}: ${v.trim()}`));
    }
    return lines.join('\n');
};

const setupShare = () => {
    openHooks['share-sheet'] = () => {
        document.querySelectorAll('#share-sheet [data-field]').forEach((input) => {
            const [group, field] = input.dataset.field.split('.');
            input.value = shareState[group][field] || '';
        });
        syncShareMethod();
        renderShareRates();
    };

    document.querySelectorAll('#share-method [data-method]').forEach((b) => {
        b.addEventListener('click', () => {
            shareState.method = b.dataset.method;
            saveShareState();
            syncShareMethod();
        });
    });

    document.querySelectorAll('#share-sheet [data-field]').forEach((input) => {
        input.addEventListener('input', () => {
            const [group, field] = input.dataset.field.split('.');
            shareState[group][field] = input.value;
            saveShareState();
        });
    });

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
//  ACCIONES DEL BLOQUE "DIFERENCIA A TASA"
// ══════════════════════════════════════════════════════════════
const setupHeroActions = () => {
    $('btn-copy-usdt')?.addEventListener('click', async () => {
        if (!(lastUsdtNeeded > 0)) return;
        const ok = await copyText(lastUsdtNeeded.toFixed(2), `USDT copiado: ${lastUsdtNeeded.toFixed(2)}`);
        const btn = $('btn-copy-usdt');
        if (ok && btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1500);
        }
    });

    // Binance P2P no permite prellenar el monto por URL: se copia (con punto
    // decimal, como lo espera Binance) para pegarlo al abrir el anuncio.
    $('btn-binance-p2p')?.addEventListener('click', async () => {
        if (lastUsdtNeeded > 0) {
            try { await navigator.clipboard.writeText(lastUsdtNeeded.toFixed(2)); } catch (e) { }
        }
        window.open('https://p2p.binance.com/trade/sell/USDT?fiat=VES', '_blank', 'noopener');
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

    setSwitch('toggle-notifications', store.get(KEYS.notifications) === 'true');

    const threshold = getGapThreshold();
    setSwitch('toggle-gap-alert', !!threshold);
    $('gap-alert-fields')?.classList.toggle('hidden', !threshold);
    const gapInput = $('input-gap-threshold');
    if (gapInput && document.activeElement !== gapInput) gapInput.value = threshold ?? '';

    setSwitch('toggle-custom-rate', customRate.enabled);
    $('custom-rate-fields')?.classList.toggle('hidden', !customRate.enabled);
    const nameInput = $('input-custom-rate-name');
    const valueInput = $('input-custom-rate-value');
    if (nameInput && document.activeElement !== nameInput) nameInput.value = customRate.name || '';
    if (valueInput && document.activeElement !== valueInput) valueInput.value = customRate.value || '';

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
        b.addEventListener('click', () => applyView(b.dataset.view));
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
        buildRateCards();
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
    { icon: 'layout-grid', title: 'Tablero rediseñado', desc: 'Cada tarjeta muestra la fecha, la tasa anterior y cuánto cambió. Elige entre cuadrícula y lista.' },
    { icon: 'calculator', title: 'Calculadora completa', desc: 'Tasas del día y anteriores listas para insertar, pegar montos, historial de operaciones y guardado como tasa personalizada.' },
    { icon: 'share-2', title: 'Comparte tus datos de pago', desc: 'Envía tus datos de Pago Móvil o Transferencia junto con los montos calculados.' },
    { icon: 'arrow-left-right', title: 'Selector de moneda', desc: 'Escribe el monto en Dólares, Euros o Bolívares directamente desde el conversor.' },
    { icon: 'history', title: 'Historial exportable', desc: 'Consulta las tasas por rango de fechas y expórtalas a CSV o Excel.' },
    { icon: 'palette', title: 'A tu gusto', desc: 'Tema claro u oscuro, color amarillo o verde, tasa personalizada y alertas cuando la brecha supere tu límite.' },
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
    { element: '#converter', popover: { title: 'Conversor', description: 'Escribe el monto y se calcula al instante en todas las tasas. Los botones 10, 20, 30… cargan montos frecuentes.' } },
    { element: '#btn-currency', popover: { title: 'Moneda del monto', description: 'Elige si escribes el monto en Dólares, Euros o Bolívares.' } },
    { element: '#btn-direction', popover: { title: 'Cambiar dirección', description: 'Alterna con un toque entre divisa → Bs y Bs → divisa.' } },
    { element: '#conv-actions .conv-icons', popover: { title: 'Acciones rápidas', description: 'Compartir con tus datos de Pago Móvil, copiar el monto a tasa BCV, pegar un monto copiado o borrarlo.' } },
    { element: '#hero', popover: { title: 'Diferencia a tasa', description: 'Cuántos USDT vender en Binance para cubrir el monto a tasa BCV. El botón copia esa cantidad y abre Binance P2P.' } },
    { element: '#rates-grid', popover: { title: 'Tasas del día', description: 'Toca una tarjeta para copiar su valor. Cada una muestra la fecha, la tasa anterior y cuánto cambió. La Brecha compara Binance con el BCV.' } },
    { element: '#view-toggle', popover: { title: 'Cuadrícula o lista', description: 'Elige cómo ver las tarjetas.' } },
    { element: '#hdr-calc', popover: { title: 'Calculadora', description: 'Suma precios, inserta las tasas con un toque y usa el resultado como monto.' } },
    { element: '#hdr-history', popover: { title: 'Historial', description: 'Consulta las tasas por fecha y expórtalas a CSV o Excel.' } },
    { element: '#hdr-settings', popover: { title: 'Configuración', description: 'Tema, color, alertas de brecha, tasa personalizada y esta guía cuando la necesites.' } },
];

const DRIVER_JS = 'https://cdn.jsdelivr.net/npm/driver.js@1.3.1/dist/driver.js.iife.js';
const DRIVER_CSS = 'https://cdn.jsdelivr.net/npm/driver.js@1.3.1/dist/driver.css';

const startTour = async () => {
    closeAllOverlays();
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
    window.scrollTo({ top: 0 });
    const tour = window.driver.js.driver({
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
        steps: TOUR_STEPS.filter((s) => document.querySelector(s.element)),
        onDestroyed: markIntroSeen,
    });
    tour.drive();
};

// Nuevo usuario → guía. Usuario que se actualiza → novedades. Solo una vez.
let introChecked = false;
const maybeShowIntro = (isFirstVisit) => {
    if (introChecked) return;
    introChecked = true;
    if (topOverlay()) return;
    if (!store.get(KEYS.onboarding)) {
        if (isFirstVisit) setTimeout(startTour, 600);
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
    setText('error-text', msg || '');
    $('error-msg')?.classList.toggle('hidden', !msg);
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
    // Intento 1: Cloudflare Pages Function
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
        fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(10000) }),
        fetch('https://ve.dolarapi.com/v1/euros', { signal: AbortSignal.timeout(10000) }),
    ]);
    if (!resUSD.ok || !resEUR.ok) throw new Error('dolarapi no disponible');
    const jUSD = await resUSD.json();
    const jEUR = await resEUR.json();
    const bcvEntry = jUSD.find((i) => i.fuente === 'oficial');
    const parallel = jUSD.find((i) => i.fuente === 'paralelo');
    const euro = Array.isArray(jEUR) ? jEUR.find((i) => i.fuente === 'oficial')?.promedio : jEUR.promedio;
    let date = bcvEntry?.fechaActualizacion ? new Date(bcvEntry.fechaActualizacion) : null;
    if (date && isNaN(date.getTime())) date = null;
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
            const r = await fetchRates();
            if (!r.bcv || !r.binance || !r.euro) throw new Error('Datos incompletos');

            if (hasFetchedOnce && (r.bcv !== data.bcv || r.binance !== data.binance || r.euro !== data.euro)) {
                sessionPrev = { bcv: data.bcv, binance: data.binance, euro: data.euro };
            }
            hasFetchedOnce = true;
            data = { ...data, bcv: r.bcv, binance: r.binance, euro: r.euro };
            rateDate = r.date;
            lastFetchAt = new Date();
            saveHistoryEntry(toDateKey(rateDate || lastFetchAt), { bcv: r.bcv, binance: r.binance, euro: r.euro });
            saveToStorage();
        } catch (err) {
            console.error('[fetchData]', err.message);
            showError('No se obtuvieron tasas. Intenta actualizar de nuevo en unos minutos.');
            if (!loadFromStorage()) data = { ...data, ...DEFAULT_RATES };
        } finally {
            refreshPrevRates();
            setLoadState(false);
        }
    })().finally(() => { fetchInFlight = null; });
    return fetchInFlight;
};

// ══════════════════════════════════════════════════════════════
//  PWA: conexión, instalación y Service Worker
// ══════════════════════════════════════════════════════════════
const updateOnlineStatus = () => $('offline-badge')?.classList.toggle('hidden', navigator.onLine);

const hideInstallBanner = () => {
    const banner = $('install-banner');
    if (!banner) return;
    banner.classList.add('hide');
    setTimeout(() => banner.classList.add('hidden'), 350);
};

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isSamsungInternet = () => /SamsungBrowser/i.test(navigator.userAgent) && /Android/i.test(navigator.userAgent);

// Abre la misma página en Chrome (si no está instalado, se queda en el navegador actual)
const chromeIntentUrl = () => {
    const { host, pathname, search, href } = window.location;
    return `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;`
        + `S.browser_fallback_url=${encodeURIComponent(href)};end`;
};

// Samsung Internet genera su propio APK al instalar una PWA y, en Android 14+,
// Play Protect lo bloquea ("se diseñó para una versión anterior de Android").
// Desde Chrome la instalación funciona, así que ahí se guía al usuario.
const setupSamsungInstallHint = () => {
    window.addEventListener('beforeinstallprompt', (e) => e.preventDefault());
    if (store.get(KEYS.samsungHintDismissed)) return;
    setText('install-title', 'Instala la app desde Chrome');
    setText('install-sub', 'Samsung Internet puede bloquear la instalación');
    setText('btn-install', 'Abrir en Chrome');
    $('install-banner')?.classList.remove('hidden');
    $('btn-install')?.addEventListener('click', () => { window.location.href = chromeIntentUrl(); });
    $('btn-install-dismiss')?.addEventListener('click', () => {
        store.set(KEYS.samsungHintDismissed, '1');
        hideInstallBanner();
    });
};

const setupInstallBanner = () => {
    if (isStandalone()) return;
    if (isSamsungInternet()) { setupSamsungInstallHint(); return; }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (!store.get(KEYS.installDismissed)) $('install-banner')?.classList.remove('hidden');
    });
    $('btn-install')?.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        hideInstallBanner();
    });
    $('btn-install-dismiss')?.addEventListener('click', () => {
        store.set(KEYS.installDismissed, '1');
        hideInstallBanner();
    });
    window.addEventListener('appinstalled', hideInstallBanner);
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
    loadShareState();
    const savedCurrency = store.get(KEYS.currency);
    if (CURRENCY[savedCurrency]) {
        inputCurrency = savedCurrency;
        if (savedCurrency !== 'bs') lastForeign = savedCurrency;
    }
    viewMode = store.get(KEYS.view) === 'list' ? 'list' : 'grid';

    buildRateCards();
    applyView(viewMode);
    refreshIcons();

    setupOverlays();
    setupConverter();
    setupHeroActions();
    setupCalculator();
    setupHistory();
    setupShare();
    setupSettings();
    setupWhatsNew();
    setupInstallBanner();
    setupGlobalListeners();
    updateOnlineStatus();
    registerServiceWorker();

    if (loadFromStorage()) {
        refreshPrevRates();
        setText('text-update', 'Cargando tasas...');
    }
    updateUI();

    fetchData().then(() => {
        maybeShowIntro(isFirstVisit);
        backfillHistory();
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
