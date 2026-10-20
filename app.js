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
let isLoading = false;
let convMode = 'usd';     // 'usd' = entrada USD/EUR → Bs | 'bs' = entrada Bs → USD
let deferredInstallPrompt = null;
let historyCache = {};    // { 'YYYY-MM-DD': { bcv, binance, euro } }
let selectedDayKey = null; // null = hoy (live)
let rateDate = null;       // fecha de la tasa actual (Date object o null)
let lastUsdtNeeded = 0;    // último "USDT a vender" calculado, para copiar/abrir Binance


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
console.log('monitor-bs-vz v2.1.0 starting...');
const STORAGE_KEY = 'monitor-dolar-data';
const THEME_KEY = 'monitor-dolar-theme';
const HISTORY_KEY = 'monitor-dolar-history'; // historial diario: { 'YYYY-MM-DD': { bcv, binance, euro } }

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

// ── Guardar tasa del día en historial ─────────────────────────────────
const saveHistoryEntry = (dateKey, entry) => {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const history = raw ? JSON.parse(raw) : {};
        history[dateKey] = { ...entry, savedAt: new Date().toISOString() };
        // Mantener solo los últimos 14 días para no llenar localStorage
        const keys = Object.keys(history).sort().slice(-14);
        const trimmed = {};
        keys.forEach(k => { trimmed[k] = history[k]; });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    } catch (e) { }
};

const loadHistoryEntry = (dateKey) => {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return null;
        const history = JSON.parse(raw);
        return history[dateKey] || null;
    } catch (e) { return null; }
};

const loadAllHistory = () => {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return;
        const history = JSON.parse(raw);
        Object.entries(history).forEach(([k, v]) => {
            if (v.bcv && v.binance && v.euro) {
                historyCache[k] = { bcv: v.bcv, binance: v.binance, euro: v.euro };
            }
        });
    } catch (e) { }
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
    const ph = '--';
    const fmt = (v) => isLoading ? ph : formatBs(v);

    // Brecha en % es independiente del monto/modo: solo depende de las tasas
    const gapPct = data.bcv > 0 ? ((data.binance - data.bcv) / data.bcv) * 100 : 0;
    if (!isLoading) checkGapAlert(gapPct);

    if (convMode === 'usd') {
        // ── USD/EUR → Bs (modo por defecto) ──
        const totalBcv = data.bcv * data.amount;
        const totalBinance = data.binance * data.amount;
        const totalEuro = data.euro * data.amount;
        const diffBs = totalBinance - totalBcv;
        const diffPct = data.bcv > 0 ? (((data.binance - data.bcv) / data.bcv) * 100) : 0;
        const eqUsdt = data.binance > 0 ? totalBcv / data.binance : 0;
        const eqUsdtEuro = data.binance > 0 ? totalEuro / data.binance : 0;
        lastUsdtNeeded = eqUsdt;

        set('total-bcv', fmt(totalBcv));
        set('total-euro', fmt(totalEuro));
        set('total-binance', fmt(totalBinance));
        set('base-bcv', formatBs(data.bcv));
        set('base-euro', formatBs(data.euro));
        set('base-binance', formatBs(data.binance));
        set('diff-bs', isLoading ? ph : `+ ${formatBs(diffBs)}`);
        set('diff-pct', isLoading ? ph : `+${diffPct.toFixed(2)}%`);
        set('eq-usdt', isLoading ? ph : `${formatUsdt(eqUsdt)} USDT`);
        set('eq-usdt-euro', isLoading ? ph : `${formatUsdt(eqUsdtEuro)} USDT`);
        const sub = document.getElementById('sub-amount');
        if (sub) sub.textContent = `${data.amount} USD`;

    } else {
        // ── Bs → USD (modo inverso como AirTM/Binance) ──
        const usdAtBcv = data.bcv > 0 ? data.amount / data.bcv : 0;
        const usdAtBinance = data.binance > 0 ? data.amount / data.binance : 0;
        const eurAtBcv = data.euro > 0 ? data.amount / data.euro : 0;
        const usdtNeeded = data.binance > 0 ? data.amount / data.binance : 0;
        lastUsdtNeeded = usdtNeeded;
        const diffUsd = usdAtBcv - usdAtBinance;
        const diffPct = usdAtBinance > 0 ? (diffUsd / usdAtBinance) * 100 : 0;

        set('total-bcv', isLoading ? ph : `${formatUsdt(usdAtBcv)} USD`);
        set('total-binance', isLoading ? ph : `${formatUsdt(usdAtBinance)} USD`);
        set('total-euro', isLoading ? ph : `${formatUsdt(eurAtBcv)} EUR`);
        set('base-bcv', formatBs(data.bcv));
        set('base-euro', formatBs(data.euro));
        set('base-binance', formatBs(data.binance));
        set('diff-bs', isLoading ? ph : `+${formatUsdt(diffUsd)} USD`);
        set('diff-pct', isLoading ? ph : `+${diffPct.toFixed(2)}%`);
        set('eq-usdt', isLoading ? ph : `${formatUsdt(usdtNeeded)} USDT`);
        set('eq-usdt-euro', isLoading ? ph : `${formatUsdt(usdtNeeded)} USDT`);
        const sub = document.getElementById('sub-amount');
        if (sub) sub.textContent = `${formatBs(data.amount)} Bs`;
    }

    if (!isLoading) {
        ['total-bcv', 'total-euro', 'total-binance', 'diff-bs', 'diff-pct', 'eq-usdt', 'eq-usdt-euro']
            .forEach(id => popElement(id));
    }

    // Actualizar prefijo del input según modo
    const currLabel = document.getElementById('currency-mode-label');
    const currBtn = document.getElementById('btn-currency-mode');
    if (currLabel) currLabel.textContent = convMode === 'usd' ? 'USD / EUR' : 'Bs.';
    currBtn?.classList.toggle('mode-bs', convMode === 'bs');

    lucide.createIcons();
};


// ── Helpers DOM ───────────────────────────────────────────────
const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

// ── Toggle modo de divisa (USD/EUR ⇔ Bs.) ─────────────────────
const setupCurrencyModeToggle = () => {
    document.getElementById('btn-currency-mode')?.addEventListener('click', () => {
        convMode = convMode === 'usd' ? 'bs' : 'usd';
        // Reset input a 1 al cambiar modo
        data.amount = 1;
        const input = document.getElementById('input-amount');
        if (input) { input.value = 1; input.select(); }
        document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
        updateUI();
    });
};

// ── Feedback visual temporal en un botón (ícono "check" y vuelta atrás) ──
const flashIcon = (btn, icon, tempIcon, originalIcon, ms = 1800) => {
    if (!icon) return;
    btn?.classList.add('copied');
    icon.setAttribute('data-lucide', tempIcon);
    lucide.createIcons();
    setTimeout(() => {
        btn?.classList.remove('copied');
        icon.setAttribute('data-lucide', originalIcon);
        lucide.createIcons();
    }, ms);
};

// ── Botón copiar USDT ──────────────────────────────────────────
const setupCopyBtn = () => {
    document.getElementById('btn-copy-usdt')?.addEventListener('click', () => {
        const val = document.getElementById('eq-usdt')?.textContent;
        if (!val || val === '--') return;
        navigator.clipboard.writeText(val).then(() => {
            flashIcon(document.getElementById('btn-copy-usdt'), document.getElementById('icon-copy'), 'check', 'copy');
        }).catch(() => { });
    });
};

// ── Botón compartir resumen ─────────────────────────────────────
const buildShareText = () => {
    const dir = convMode === 'usd' ? `${data.amount} USD/EUR` : `${formatBs(data.amount)} Bs`;
    const bcvText = document.getElementById('total-bcv')?.textContent || '--';
    const binanceText = document.getElementById('total-binance')?.textContent || '--';
    const gapText = document.getElementById('diff-pct')?.textContent || '--';
    const eqText = document.getElementById('eq-usdt')?.textContent || '--';
    return [
        `Monitor Bs. — ${dir}`,
        `BCV: ${bcvText}`,
        `Binance: ${binanceText}`,
        `Brecha: ${gapText}`,
        `USDT a vender en Binance: ${eqText}`,
    ].join('\n');
};

const setupShareBtn = () => {
    document.getElementById('btn-share')?.addEventListener('click', async () => {
        const text = buildShareText();
        if (navigator.share) {
            try { await navigator.share({ text }); } catch (e) { /* cancelado por el usuario */ }
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            flashIcon(document.getElementById('btn-share'), document.getElementById('icon-share'), 'check', 'share-2');
        } catch (e) { }
    });
};

// ── Acción rápida: copiar monto y abrir Binance P2P ─────────────
// Binance P2P no soporta prellenar el monto a vender vía URL, así que
// copiamos el valor (en formato numérico plano, sin coma decimal) para
// pegarlo directo en el anuncio una vez abierto.
const setupBinanceAction = () => {
    document.getElementById('btn-binance-p2p')?.addEventListener('click', async () => {
        if (lastUsdtNeeded > 0) {
            try { await navigator.clipboard.writeText(lastUsdtNeeded.toFixed(2)); } catch (e) { }
        }
        window.open('https://p2p.binance.com/trade/sell/USDT?fiat=VES', '_blank', 'noopener');
    });
};

// ── Calculadora integrada (overlay) ────────────────────────────
// Suma/resta/multiplica/divide varios montos antes de usarlos como Cantidad,
// sin depender de una app de calculadora externa.
let calcEvalExpr = '';     // expresión real, para evaluar: "10+20*2"
let calcDisplayExpr = '';  // expresión mostrada, con símbolos bonitos: "10+20×2"
let calcJustEvaluated = false;

const CALC_OP_DISPLAY = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const calcIsOperator = (c) => c === '+' || c === '-' || c === '*' || c === '/';
const calcLastChar = () => calcEvalExpr.slice(-1);

const calcTokenize = (expr) => expr.match(/\d+\.?\d*%?|\.\d+%?|[+\-*/]/g) || [];

// Evalúa tokens respetando precedencia (* / antes que + -); % = valor/100
const calcEvalTokens = (tokens) => {
    if (!tokens.length) return 0;
    const vals = tokens.map(t => calcIsOperator(t) ? t : (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)));
    const stage = [vals[0]];
    for (let i = 1; i < vals.length; i += 2) {
        const op = vals[i];
        const rhs = vals[i + 1];
        if (rhs === undefined) break;
        if (op === '*') stage[stage.length - 1] *= rhs;
        else if (op === '/') stage[stage.length - 1] = rhs !== 0 ? stage[stage.length - 1] / rhs : 0;
        else stage.push(op, rhs);
    }
    let result = stage[0] || 0;
    for (let i = 1; i < stage.length; i += 2) {
        const op = stage[i];
        const rhs = stage[i + 1];
        if (rhs === undefined) break;
        if (op === '+') result += rhs;
        else if (op === '-') result -= rhs;
    }
    return result;
};

const calcPreview = () => {
    if (!calcEvalExpr || calcIsOperator(calcLastChar())) return null;
    try {
        const result = calcEvalTokens(calcTokenize(calcEvalExpr));
        return Number.isFinite(result) ? result : null;
    } catch (e) { return null; }
};

const updateCalcDisplay = () => {
    const exprEl = document.getElementById('calc-expression');
    const resultEl = document.getElementById('calc-result');
    if (exprEl) exprEl.textContent = calcDisplayExpr || '0';
    if (resultEl) {
        const preview = calcPreview();
        const hasOp = /[+\-*/]/.test(calcEvalExpr);
        resultEl.textContent = (preview !== null && hasOp) ? `= ${formatUsdt(preview)}` : ' ';
    }
    renderCalcItems();
};

// ── Modo "canasta": lista de ítems cuando la expresión es una suma pura ──
const getCalcItems = () => {
    if (!calcEvalExpr || calcIsOperator(calcLastChar())) return null;
    const isPureSum = /^[\d.]+%?(\+[\d.]+%?)*$/.test(calcEvalExpr);
    if (!isPureSum) return null;
    const evalParts = calcEvalExpr.split('+');
    if (evalParts.length < 2) return null;
    const dispParts = calcDisplayExpr.split('+');
    return evalParts.map((ev, i) => ({ evalText: ev, dispText: dispParts[i] ?? ev }));
};

const renderCalcItems = () => {
    const wrap = document.getElementById('calc-items');
    if (!wrap) return;
    const items = getCalcItems();
    if (!items) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = '';
    items.forEach((item, idx) => {
        const chip = document.createElement('span');
        chip.className = 'calc-item';
        chip.textContent = item.dispText;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'calc-item-remove';
        removeBtn.setAttribute('aria-label', 'Quitar');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => removeCalcItem(idx));
        chip.appendChild(removeBtn);
        wrap.appendChild(chip);
    });
};

const removeCalcItem = (idx) => {
    const items = getCalcItems();
    if (!items) return;
    items.splice(idx, 1);
    if (!items.length) { calcClear(); return; }
    calcEvalExpr = items.map(i => i.evalText).join('+');
    calcDisplayExpr = items.map(i => i.dispText).join('+');
    calcJustEvaluated = false;
    updateCalcDisplay();
};

const calcAppendDigit = (d) => {
    if (calcJustEvaluated) { calcEvalExpr = ''; calcDisplayExpr = ''; calcJustEvaluated = false; }
    if (calcLastChar() === '%') return; // "%" cierra el número; hace falta un operador para seguir
    if (d === '.') {
        const lastNum = calcEvalExpr.match(/(\d*\.?\d*)$/)?.[0] || '';
        if (lastNum.includes('.')) return;
        if (calcEvalExpr === '' || calcIsOperator(calcLastChar())) {
            calcEvalExpr += '0';
            calcDisplayExpr += '0';
        }
    }
    calcEvalExpr += d;
    calcDisplayExpr += d;
    updateCalcDisplay();
};

const calcAppendOperator = (op) => {
    calcJustEvaluated = false;
    if (!calcEvalExpr) return; // no empezar la expresión con un operador
    if (calcIsOperator(calcLastChar())) {
        calcEvalExpr = calcEvalExpr.slice(0, -1) + op;
        calcDisplayExpr = calcDisplayExpr.slice(0, -1) + CALC_OP_DISPLAY[op];
    } else {
        calcEvalExpr += op;
        calcDisplayExpr += CALC_OP_DISPLAY[op];
    }
    updateCalcDisplay();
};

const calcAppendPercent = () => {
    const last = calcLastChar();
    if (!last || calcIsOperator(last) || last === '%') return;
    calcEvalExpr += '%';
    calcDisplayExpr += '%';
    updateCalcDisplay();
};

const calcBackspace = () => {
    calcEvalExpr = calcEvalExpr.slice(0, -1);
    calcDisplayExpr = calcDisplayExpr.slice(0, -1);
    calcJustEvaluated = false;
    updateCalcDisplay();
};

const calcClear = () => {
    calcEvalExpr = '';
    calcDisplayExpr = '';
    calcJustEvaluated = false;
    updateCalcDisplay();
};

const calcEquals = () => {
    const preview = calcPreview();
    if (preview === null) return;
    const resultStr = String(Math.round(preview * 1e6) / 1e6);
    calcEvalExpr = resultStr;
    calcDisplayExpr = resultStr;
    calcJustEvaluated = true;
    updateCalcDisplay();
};

// ── Historial de cálculos recientes ─────────────────────────────
const CALC_HISTORY_KEY = 'monitor-dolar-calc-history';
const CALC_HISTORY_MAX = 8;

const loadCalcHistory = () => {
    try {
        const raw = localStorage.getItem(CALC_HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
};

const saveCalcHistoryEntry = (displayExpr, value) => {
    try {
        const list = loadCalcHistory();
        list.unshift({ expr: displayExpr, value });
        localStorage.setItem(CALC_HISTORY_KEY, JSON.stringify(list.slice(0, CALC_HISTORY_MAX)));
    } catch (e) { }
};

const renderCalcHistory = () => {
    const wrap = document.getElementById('calc-history');
    if (!wrap) return;
    const list = loadCalcHistory();
    if (!list.length) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = '';
    list.forEach(entry => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'calc-history-chip';
        chip.textContent = `${entry.expr} = ${formatUsdt(entry.value)}`;
        chip.addEventListener('click', () => {
            const resultStr = String(entry.value);
            calcEvalExpr = resultStr;
            calcDisplayExpr = resultStr;
            calcJustEvaluated = true;
            updateCalcDisplay();
        });
        wrap.appendChild(chip);
    });
};

const openCalcOverlay = () => {
    calcClear();
    renderCalcHistory();
    const overlay = document.getElementById('calc-overlay');
    overlay?.classList.remove('hidden');
    overlay?.setAttribute('aria-hidden', 'false');
};

const closeCalcOverlay = () => {
    const overlay = document.getElementById('calc-overlay');
    overlay?.classList.add('hidden');
    overlay?.setAttribute('aria-hidden', 'true');
};

const setupCalculator = () => {
    document.getElementById('btn-open-calc')?.addEventListener('click', openCalcOverlay);
    document.getElementById('calc-close')?.addEventListener('click', closeCalcOverlay);
    document.getElementById('calc-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'calc-overlay') closeCalcOverlay();
    });

    document.querySelectorAll('.calc-key').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.key;
            if (key === 'C') calcClear();
            else if (key === 'back') calcBackspace();
            else if (key === '=') calcEquals();
            else if (key === '%') calcAppendPercent();
            else if (calcIsOperator(key)) calcAppendOperator(key);
            else calcAppendDigit(key);
        });
    });

    // Usar el resultado de la calculadora como Cantidad
    document.getElementById('btn-calc-use')?.addEventListener('click', () => {
        const preview = calcPreview();
        if (preview === null) { closeCalcOverlay(); return; }
        const finalVal = Math.round(preview * 1e6) / 1e6;
        if (/[+\-*/]/.test(calcEvalExpr)) saveCalcHistoryEntry(calcDisplayExpr, finalVal);
        data.amount = finalVal;
        const input = document.getElementById('input-amount');
        if (input) input.value = finalVal;
        document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
        updateUI();
        closeCalcOverlay();
    });

    // Soporte de teclado físico mientras la calculadora está abierta
    document.addEventListener('keydown', (e) => {
        const overlay = document.getElementById('calc-overlay');
        if (!overlay || overlay.classList.contains('hidden')) return;
        if (e.key === 'Escape') { closeCalcOverlay(); return; }
        if (/^[0-9.]$/.test(e.key)) { calcAppendDigit(e.key); return; }
        if (calcIsOperator(e.key)) { calcAppendOperator(e.key); return; }
        if (e.key === '%') { calcAppendPercent(); return; }
        if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); calcEquals(); return; }
        if (e.key === 'Backspace') { calcBackspace(); return; }
    });
};

// ── Error ─────────────────────────────────────────────────────
const showError = (msg) => {
    const wrapper = document.getElementById('error-msg');
    const text = document.getElementById('error-text');
    if (!wrapper || !text) return;
    text.textContent = msg || '';
    wrapper.classList.toggle('hidden', !msg);
};

// ── Alerta de brecha configurable ───────────────────────────────
const GAP_THRESHOLD_KEY = 'monitor-dolar-gap-threshold';
const GAP_ALERT_SENT_KEY = 'monitor-dolar-gap-alert-sent';

const getGapThreshold = () => {
    const raw = localStorage.getItem(GAP_THRESHOLD_KEY);
    const n = raw ? parseFloat(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
};

const updateGapAlertUI = (threshold) => {
    const btn = document.getElementById('btn-gap-alert');
    if (!btn) return;
    btn.classList.toggle('gap-alert-active', !!threshold);
    btn.title = threshold
        ? `Te avisamos si la brecha supera ${threshold}% (toca para cambiar)`
        : 'Configurar alerta de brecha';
};

const setupGapAlertButton = () => {
    updateGapAlertUI(getGapThreshold());
    document.getElementById('btn-gap-alert')?.addEventListener('click', () => {
        const current = getGapThreshold();
        const input = window.prompt(
            'Avisarme cuando la brecha supere este % (deja vacío para desactivar):',
            current ? String(current) : ''
        );
        if (input === null) return; // cancelado
        const trimmed = input.trim();
        if (trimmed === '') {
            localStorage.removeItem(GAP_THRESHOLD_KEY);
            localStorage.removeItem(GAP_ALERT_SENT_KEY);
            updateGapAlertUI(null);
            document.getElementById('gap-card')?.classList.remove('gap-card-alert');
            return;
        }
        const n = parseFloat(trimmed.replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) return;
        localStorage.setItem(GAP_THRESHOLD_KEY, String(n));
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
        updateGapAlertUI(n);
    });
};

// Resalta la tarjeta de Brecha y notifica (1 vez por umbral/día) si se supera
const checkGapAlert = (gapPct) => {
    const threshold = getGapThreshold();
    const card = document.getElementById('gap-card');
    if (!threshold || !Number.isFinite(gapPct)) {
        card?.classList.remove('gap-card-alert');
        return;
    }
    const exceeded = gapPct >= threshold;
    card?.classList.toggle('gap-card-alert', exceeded);
    if (!exceeded) return;

    const sentKey = `${toDateKey(new Date())}:${threshold}`;
    if (localStorage.getItem(GAP_ALERT_SENT_KEY) === sentKey) return;
    localStorage.setItem(GAP_ALERT_SENT_KEY, sentKey);
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Brecha cambiaria alta', {
            body: `La brecha es de ${gapPct.toFixed(1)}% (tu límite: ${threshold}%)`,
            icon: '/icons/icon-192.png',
        });
    }
};

// ── Capitalizar primera letra ──────────────────────────────────────
const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

// ── Helpers de fecha ──────────────────────────────────────────────
const toDateKey = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// ── Mostrar fecha de la tasa en el badge ──────────────────────────
const updateRateDateBadge = () => {
    const badge = document.getElementById('rate-date-badge');
    if (!badge) return;

    if (selectedDayKey) {
        const d = new Date(selectedDayKey + 'T12:00:00');
        const dayName = d.toLocaleDateString('es-VE', { weekday: 'short' });
        const dayMonth = d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit' });
        badge.textContent = `${cap(dayName)} ${dayMonth}`;
        badge.classList.add('is-historical');
    } else if (rateDate) {
        const today = new Date();
        const todayKey = toDateKey(today);
        const rateDateKey = toDateKey(rateDate);
        if (rateDateKey === todayKey) {
            badge.textContent = 'Hoy';
            badge.classList.remove('is-historical');
        } else {
            // Fin de semana: la tasa es del viernes
            const dayName = rateDate.toLocaleDateString('es-VE', { weekday: 'short' });
            const dayMonth = rateDate.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit' });
            badge.textContent = `${cap(dayName)} ${dayMonth}`;
            badge.classList.add('is-historical');
        }
    } else {
        badge.textContent = isLoading ? '...' : 'Hoy';
        badge.classList.remove('is-historical');
    }
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
        const now = new Date();
        set('text-update',
            `Hoy ${now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true })}`
        );
        saveToStorage();
    }
    updateRateDateBadge();
    lucide.createIcons();
    updateUI();
};

const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

// Genera los últimos N días (incluyendo hoy)
const buildDays = (n = 7) => {
    const days = [];
    const now = new Date();
    for (let i = 0; i < n; i++) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push(d);
    }
    return days; // [hoy, ayer, anteayer, ...]
};

// ── Construir barra de días ──────────────────────────────────
const buildDaysBar = () => {
    const bar = document.getElementById('days-bar');
    if (!bar) return;
    const days = buildDays(7);
    const todayKey = toDateKey(new Date());

    // Determinar qué día tiene la tasa actual (viene de la API)
    // Si es fin de semana, el dato de 'hoy' en la API puede ser el viernes
    const activeLiveKey = rateDate ? toDateKey(rateDate) : todayKey;

    bar.innerHTML = '';
    days.forEach((d, idx) => {
        const key = toDateKey(d);
        const isToday = key === todayKey;
        const isWknd = isWeekend(d);
        const isCurrent = (selectedDayKey === null && key === activeLiveKey) ||
            selectedDayKey === key;

        const btn = document.createElement('button');
        btn.className = 'day-pill';
        if (isToday) btn.classList.add('today-pill');
        if (isWknd) btn.classList.add('weekend-pill');
        if (isCurrent) btn.classList.add('active');

        // Etiqueta
        let label;
        if (isToday) {
            label = 'Hoy';
        } else if (idx === 1) {
            label = 'Ayer';
        } else {
            label = d.toLocaleDateString('es-VE', { weekday: 'short', day: '2-digit' });
            label = cap(label);
        }

        btn.innerHTML = `<span class="pill-dot"></span>${label}`;
        btn.title = d.toLocaleDateString('es-VE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        btn.dataset.dateKey = key;

        btn.addEventListener('click', () => onDayPillClick(key));
        bar.appendChild(btn);
    });
};

// ── Click en píldora de día ──────────────────────────────────
const onDayPillClick = async (key) => {
    const liveDateKey = rateDate ? toDateKey(rateDate) : toDateKey(new Date());

    // Volver al modo live
    if (key === liveDateKey) {
        selectedDayKey = null;
        const live = historyCache['__live__'];
        if (live) data = { ...data, ...live };
        showError(null);
        buildDaysBar();
        updateRateDateBadge();
        updateUI();
        return;
    }

    selectedDayKey = key;
    showError(null);
    buildDaysBar();
    updateRateDateBadge();

    // 1º: memoria
    if (historyCache[key]) {
        data = { ...data, ...historyCache[key] };
        updateUI();
        return;
    }

    // 2º: localStorage
    const local = loadHistoryEntry(key);
    if (local) {
        historyCache[key] = local;
        data = { ...data, ...local };
        updateUI();
        return;
    }

    // 3º: Cloudflare KV via /api/history
    try {
        const res = await fetch(`/api/history?date=${key}`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
            const j = await res.json();
            if (j.bcv && j.binance && j.euro) {
                const entry = { bcv: j.bcv, binance: j.binance, euro: j.euro };
                historyCache[key] = entry;
                saveHistoryEntry(key, entry); // guardar local también
                data = { ...data, ...entry };
                updateUI();
                return;
            }
        } else if (res.status === 404) {
            showError('Sin datos para ese día. El historial se acumula con cada visita a la app.');
            ['total-bcv', 'total-euro', 'total-binance', 'base-bcv', 'base-euro', 'base-binance',
                'diff-bs', 'diff-pct', 'eq-usdt', 'eq-usdt-euro'].forEach(id => set(id, '--'));
            return;
        }
    } catch (e) {
        console.warn('[history API]', e.message);
    }

    // Sin datos en ninguna fuente
    showError('Sin datos guardados para ese día.');
    ['total-bcv', 'total-euro', 'total-binance', 'base-bcv', 'base-euro', 'base-binance',
        'diff-bs', 'diff-pct', 'eq-usdt', 'eq-usdt-euro'].forEach(id => set(id, '--'));
};
// ── Fetch de tasas (con Cloudflare Function + fallback dolarapi) ────────────
const fetchData = async () => {
    if (!navigator.onLine) {
        showError('Sin conexión. Mostrando últimas tasas guardadas.');
        updateUI();
        return;
    }

    selectedDayKey = null;
    setLoadState(true);
    showError(null);

    try {
        let bcv = 0, binance = 0, euro = 0;
        let apiRateDate = null;
        let usedCFFunction = false;

        // ─ Intento 1: Cloudflare Pages Function /api/rates ─
        try {
            const res = await fetch('/api/rates', { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const j = await res.json();
                if (j.bcv && j.binance && j.euro) {
                    ({ bcv, binance, euro } = j);
                    if (j.rateDate) apiRateDate = new Date(j.rateDate + 'T12:00:00');
                    usedCFFunction = true;
                }
            }
        } catch (e) {
            console.warn('[/api/rates]', e.message);
        }

        // ─ Intento 2 (fallback): dolarapi.com directo ─
        if (!usedCFFunction) {
            const [resUSD, resEUR] = await Promise.all([
                fetch('https://ve.dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(10000) }),
                fetch('https://ve.dolarapi.com/v1/euros', { signal: AbortSignal.timeout(10000) }),
            ]);
            if (!resUSD.ok || !resEUR.ok) throw new Error('dolarapi no disponible');
            const jUSD = await resUSD.json();
            const jEUR = await resEUR.json();
            const bcvEntry = jUSD.find(i => i.fuente === 'oficial');
            const paralelEntry = jUSD.find(i => i.fuente === 'paralelo');
            bcv = bcvEntry?.promedio ?? 0;
            binance = paralelEntry?.promedio ?? 0;
            euro = Array.isArray(jEUR)
                ? (jEUR.find(i => i.fuente === 'oficial')?.promedio ?? 0)
                : (jEUR.promedio ?? 0);
            const rawDate = bcvEntry?.fechaActualizacion ?? null;
            if (rawDate) {
                apiRateDate = new Date(rawDate);
                if (isNaN(apiRateDate.getTime())) apiRateDate = null;
            }
        }

        if (!bcv || !binance || !euro) throw new Error('Datos incompletos');

        data = { ...data, bcv, binance, euro };
        rateDate = apiRateDate;

        // Guardar en memoria y localStorage
        historyCache['__live__'] = { bcv, binance, euro };
        const entryDateKey = apiRateDate ? toDateKey(apiRateDate) : toDateKey(new Date());
        historyCache[entryDateKey] = { bcv, binance, euro };
        saveHistoryEntry(entryDateKey, { bcv, binance, euro });

    } catch (err) {
        console.error('[fetchData]', err.message);
        showError('No se obtuvieron tasas. Intenta actualizar de nuevo en unos minutos.');
        if (!loadFromStorage()) {
            data = { ...data, bcv: 419.99, binance: 604.78, euro: 495.61 };
        }
    } finally {
        setLoadState(false);
        buildDaysBar();
    }
};

// ── Online/Offline ────────────────────────────────────────────
const updateOnlineStatus = () => {
    const badge = document.getElementById('offline-badge');
    if (!badge) return;
    badge.classList.toggle('hidden', navigator.onLine);
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

        // Al detectar un nuevo SW, recargar cuando tome el control
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'activated') {
                    console.log('[SW] Nueva versión detectada, recargando...');
                    window.location.reload();
                }
            });
        });

        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data?.type === 'SYNC_RATES') fetchData();
        });
        if ('SyncManager' in window) reg.sync.register('sync-rates').catch(() => { });
    } catch (err) { console.warn('[SW]', err); }
};

// ── Event Listeners ───────────────────────────────────────────
const setupEventListeners = () => {
    const inputAmount = document.getElementById('input-amount');
    inputAmount?.addEventListener('input', (e) => {
        data.amount = Number(e.target.value) || 0;
        // Quitar active de todos los chips
        document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
        updateUI();
    });
    inputAmount?.addEventListener('focus', () => inputAmount.select());

    // Botones rápidos de monto
    document.querySelectorAll('.quick-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = Number(btn.dataset.amount);
            data.amount = val;
            const input = document.getElementById('input-amount');
            if (input) input.value = val;
            // Highlight del chip activo
            document.querySelectorAll('.quick-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateUI();
        });
    });

    document.getElementById('btn-refresh')?.addEventListener('click', fetchData);
    document.getElementById('btn-main')?.addEventListener('click', fetchData);

    window.addEventListener('online', () => { updateOnlineStatus(); fetchData(); });
    window.addEventListener('offline', updateOnlineStatus);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
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
    setupCurrencyModeToggle();
    setupCopyBtn();
    setupShareBtn();
    setupBinanceAction();
    setupGapAlertButton();
    setupCalculator();
    registerServiceWorker();
    buildDaysBar(); // render inicial de la barra de días
    loadAllHistory(); // cargar historial local guardado

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
