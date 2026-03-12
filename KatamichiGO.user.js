// ==UserScript==
// @name         KatamichiGO! Monitor
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Log car list changes with persistent diff history, re-open panel, per-car timeline
// @match        https://cp.toyota.jp/rentacar/*
// @downloadURL  https://github.com/peashooterr/katamichigo-script/raw/main/KatamichiGO.user.js
// @updateURL    https://github.com/peashooterr/katamichigo-script/raw/main/KatamichiGO.user.js
// @author       peashooterr
// @grant        GM_notification
// ==/UserScript==

(function () {
    'use strict';

    const CFG = {
        CARS_KEY:       'trc_cars_v1',
        HISTORY_KEY:    'trc_history_v1',
        UNREAD_KEY:     'trc_unread_v1',
        INTERVAL_KEY:   'trc_interval_v1',
        NOTIFY_TO_KEY:  'trc_notify_timeout_v1',
        POLL_INTERVAL:  60_000,
        MAX_HISTORY:    200,
        NOTIFY:         true,
        WAIT_TIMEOUT:   15_000,
        NOTIFY_TIMEOUT: 600_000,
    };

    const log = (...a) => console.log('[TRC]', ...a);
    const t   = el => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

    function waitForContent() {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + CFG.WAIT_TIMEOUT;
            const tid = setInterval(() => {
                if (document.querySelector('li.service-item')) {
                    clearInterval(tid); resolve();
                } else if (Date.now() > deadline) {
                    clearInterval(tid); reject(new Error('timeout'));
                }
            }, 500);
        });
    }

    function parseCars() {
        const cars = [];
        const seenIds = new Set();
        document.querySelectorAll('li.service-item').forEach(li => {
            const body        = li.querySelector('.service-item__body');
            const status      = body?.classList.contains('show-entry-end') ? '受付終了' : '受付中';
            const departStore = t(li.querySelector('.service-item__shop-start p:last-child'));
            const returnStore = t(li.querySelector('.service-item__shop-return p:last-child'));
            const period      = t(li.querySelector('.service-item__date p:last-child'));
            const carType     = t(li.querySelector('.service-item__info__car-type p:last-child'));
            const conditions  = t(li.querySelector('.service-item__info__condition p:last-child'));
            const phone       = t(li.querySelector('.service-item__reserve-tel'));
            if (!carType) return;
            const id = `${departStore}|${carType}|${period}`;
            if (seenIds.has(id)) return;
            seenIds.add(id);
            cars.push({ id, status, departStore, returnStore, period, carType, conditions, phone });
        });
        log(`Parsed ${cars.length} cars`);
        return cars;
    }

    function loadJSON(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; }
        catch { return fallback; }
    }
    function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

    function loadCars()     { return loadJSON(CFG.CARS_KEY, []); }
    function saveCars(c)    { saveJSON(CFG.CARS_KEY, c); }
    function loadHistory()  { return loadJSON(CFG.HISTORY_KEY, []); }
    function saveHistory(h) { saveJSON(CFG.HISTORY_KEY, h); }
    function loadUnread()   { return loadJSON(CFG.UNREAD_KEY, 0); }
    function saveUnread(n)  { saveJSON(CFG.UNREAD_KEY, n); }
    function loadInterval()    { return loadJSON(CFG.INTERVAL_KEY,  CFG.POLL_INTERVAL / 1000); }
    function saveInterval(s)   { saveJSON(CFG.INTERVAL_KEY, s); }
    function loadNotifyTimeout(){ return loadJSON(CFG.NOTIFY_TO_KEY, CFG.NOTIFY_TIMEOUT / 1000); }
    function saveNotifyTimeout(s){ saveJSON(CFG.NOTIFY_TO_KEY, s); }

    function clearAllData() {
        [CFG.CARS_KEY, CFG.HISTORY_KEY, CFG.UNREAD_KEY].forEach(k => localStorage.removeItem(k));
        log('All data cleared');
    }

    function diffCars(prev, curr) {
        const prevMap = new Map(prev.map(c => [c.id, c]));
        const currMap = new Map(curr.map(c => [c.id, c]));
        return {
            added:       curr.filter(c => !prevMap.has(c.id)),
            disappeared: prev.filter(c => !currMap.has(c.id)),
            statusChangedToClosed: curr
                .filter(c => prevMap.has(c.id) && prevMap.get(c.id).status !== '受付終了' && c.status === '受付終了')
                .map(c => ({ before: prevMap.get(c.id), after: c })),
        };
    }

    function hasChanges(diff) {
        return diff.added.length || diff.disappeared.length || diff.statusChangedToClosed.length;
    }

    function appendHistory(diff) {
        const history = loadHistory();
        history.unshift({ ts: Date.now(), diff });
        if (history.length > CFG.MAX_HISTORY) history.length = CFG.MAX_HISTORY;
        saveHistory(history);
        saveUnread(loadUnread() + 1);
    }

    function notify(diff) {
        if (!CFG.NOTIFY || typeof GM_notification !== 'function') return;
        const parts = [];
        if (diff.added.length)                 parts.push(`新規 ${diff.added.length}件`);
        if (diff.statusChangedToClosed.length) parts.push(`受付終了 ${diff.statusChangedToClosed.length}件`);
        if (diff.disappeared.length)            parts.push(`消去 ${diff.disappeared.length}件`);
        GM_notification({
            title:   '片道GO! 変更あり',
            text:    parts.join(' / '),
            timeout: loadNotifyTimeout() * 1000,
            onclick: () => window.focus(),
        });
    }

    // ── UI ヘルパー ───────────────────────────────────────────────────────────
    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'style') e.style.cssText = v;
            else if (k === 'onclick') e.addEventListener('click', v);
            else e[k] = v;
        });
        (Array.isArray(children) ? children : [children]).forEach(c =>
            e.append(c instanceof Node ? c : document.createTextNode(String(c ?? '')))
        );
        return e;
    }

    function css(obj) {
        return Object.entries(obj)
            .map(([k, v]) => `${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}:${v}`)
            .join(';');
    }

    function btn(text, onclick, extra = '') {
        return el('button', {
            style: css({ padding:'5px 12px', border:'none', borderRadius:'5px', cursor:'pointer', fontSize:'12px', fontWeight:'bold' }) + ';' + extra,
            onclick
        }, text);
    }

    function badge(text, color) {
        return el('span', { style: css({ background:color, color:'#fff', padding:'3px 9px', borderRadius:'12px', fontSize:'12px', fontWeight:'bold' }) }, text);
    }

    // ── 車両別タイムライン取得 ─────────────────────────────────────────────────
    function getCarTimeline(carId) {
        const history = loadHistory();
        const events = [];
        [...history].reverse().forEach(({ ts, diff }) => {
            const wasAdded   = diff.added.find(c => c.id === carId);
            const wasGone    = diff.disappeared.find(c => c.id === carId);
            const wasClosed  = diff.statusChangedToClosed.find(s => s.after.id === carId);
            if (wasAdded)  events.push({ ts, type: 'added',       car: wasAdded });
            if (wasClosed) events.push({ ts, type: 'closed',      car: wasClosed.after });
            if (wasGone)   events.push({ ts, type: 'disappeared', car: wasGone });
        });
        return events;
    }

    // ── 車両別タイムラインモーダル ─────────────────────────────────────────────
    const TIMELINE_ID = 'trc-timeline-overlay';

    function openCarTimeline(car) {
        document.getElementById(TIMELINE_ID)?.remove();

        const events = getCarTimeline(car.id);

        const overlay = el('div', { id: TIMELINE_ID, style: css({
            position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:1000000
        })});
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

        const panel = el('div', { style: css({
            position:'fixed', top:'5%', left:'50%', transform:'translateX(-50%)',
            width:'min(92%, 600px)', maxHeight:'88vh', overflowY:'auto',
            background:'#fff', borderRadius:'10px', boxShadow:'0 4px 28px rgba(0,0,0,.35)',
            padding:'18px', fontFamily:'sans-serif', fontSize:'13px', color:'#333', zIndex:1000001
        })});

        const hdr = el('div', { style: css({ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'12px', marginBottom:'12px' }) });
        const titleWrap = el('div', { style:'min-width:0;flex:1' });
        titleWrap.append(el('div', { style:'font-size:15px;font-weight:bold;margin-bottom:4px' }, '🚗 車両履歴タイムライン'));
        titleWrap.append(el('div', { style:'font-size:12px;color:#555;word-break:break-all' }, `${car.carType}　${car.departStore}`));
        titleWrap.append(el('div', { style:'font-size:12px;color:#555' }, `期間：${car.period}`));
        hdr.append(titleWrap, btn('✕ 閉じる', () => overlay.remove(), 'background:#555;color:#fff;white-space:nowrap;flex-shrink:0'));
        panel.append(hdr);

        if (!events.length) {
            panel.append(el('div', { style:'color:#888;text-align:center;padding:30px' }, 'この車両の変更履歴はありません。'));
        } else {
            const timeline = el('div', { style: css({ position:'relative', paddingLeft:'28px' }) });
            const vline = el('div', { style: css({
                position:'absolute', left:'10px', top:'8px', bottom:'8px',
                width:'2px', background:'#dee2e6', borderRadius:'2px'
            })});
            timeline.append(vline);

            events.forEach((ev, i) => {
                const isLast = i === events.length - 1;
                const cfg = {
                    added:       { color:'#28a745', dot:'#28a745', icon:'＋', label:'ページに出現' },
                    closed:      { color:'#856404', dot:'#e0a800', icon:'⚠', label:'受付終了' },
                    disappeared: { color:'#dc3545', dot:'#dc3545', icon:'✕', label:'ページから消滅' },
                }[ev.type];

                const row = el('div', { style: css({ position:'relative', marginBottom: isLast ? '0' : '18px' }) });

                row.append(el('div', { style: css({
                    position:'absolute', left:'-22px', top:'3px',
                    width:'14px', height:'14px', borderRadius:'50%',
                    background: cfg.dot, border:'2px solid #fff',
                    boxShadow:'0 0 0 2px ' + cfg.dot,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:'8px', color:'#fff', fontWeight:'bold'
                }), title: cfg.label }, cfg.icon));

                const content = el('div', { style: css({
                    background: ev.type === 'added' ? '#d4edda' : ev.type === 'closed' ? '#fff3cd' : '#f8d7da',
                    border: `1px solid ${cfg.dot}`,
                    borderRadius:'7px', padding:'8px 12px'
                })});

                content.append(el('div', { style: css({ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'5px' }) }, [
                    el('span', { style: `font-weight:bold;font-size:13px;color:${cfg.color}` }, `${cfg.icon} ${cfg.label}`),
                    el('span', { style:'font-size:11px;color:#666' }, new Date(ev.ts).toLocaleString()),
                ]));

                let detailOpen = false;
                const detailBody = el('div', { style:'display:none;margin-top:6px;border-top:1px solid rgba(0,0,0,.08);padding-top:6px' });
                [
                    ['出発店舗', ev.car.departStore],
                    ['返却店舗', ev.car.returnStore],
                    ['出発期間', ev.car.period],
                    ['車種',     ev.car.carType],
                    ['条件',     ev.car.conditions],
                    ['電話',     ev.car.phone],
                ].filter(([, v]) => v).forEach(([label, val]) => {
                    detailBody.append(el('div', { style:'font-size:12px;line-height:1.8' }, [
                        el('span', { style:'font-weight:bold;min-width:64px;display:inline-block' }, `${label}：`),
                        el('span', {}, val)
                    ]));
                });

                const toggleDetail = btn('詳細 ▾', () => {
                    detailOpen = !detailOpen;
                    detailBody.style.display = detailOpen ? 'block' : 'none';
                    toggleDetail.textContent = detailOpen ? '詳細 ▴' : '詳細 ▾';
                }, `background:transparent;color:${cfg.color};padding:0 4px;font-size:11px`);

                content.append(toggleDetail, detailBody);
                row.append(content);
                timeline.append(row);
            });

            panel.append(timeline);
        }

        overlay.append(panel);
        document.body.append(overlay);
    }

    // ── 車両カード ────────────────────────────────────────────────────────────
    function carCard(car, bg) {
        const rows = [
            ['出発店舗', car.departStore], ['返却店舗', car.returnStore],
            ['出発期間', car.period],      ['車種',     car.carType],
            ['条件',     car.conditions], ['電話',     car.phone],
            ['状態',     car.status],
        ];
        const card = el('div', { style: css({
            background: bg, border:'1px solid #ccc', borderRadius:'6px',
            padding:'8px 12px', marginBottom:'6px', lineHeight:'1.7',
            cursor:'pointer', transition:'box-shadow .15s, transform .15s',
        })});

        card.addEventListener('mouseenter', () => {
            card.style.boxShadow = '0 2px 10px rgba(0,0,0,.18)';
            card.style.transform = 'translateY(-1px)';
        });
        card.addEventListener('mouseleave', () => {
            card.style.boxShadow = '';
            card.style.transform = '';
        });

        card.addEventListener('click', () => openCarTimeline(car));

        rows.filter(([, v]) => v).forEach(([label, val]) => {
            card.append(el('div', {}, [
                el('span', { style:'font-weight:bold;min-width:70px;display:inline-block' }, `${label}：`),
                el('span', {}, val)
            ]));
        });
        return card;
    }

    // ── パネル ────────────────────────────────────────────────────────────────
    const OVERLAY_ID = 'trc-overlay';
    const FAB_ID     = 'trc-fab';
    const BADGE_ID   = 'trc-fab-badge';

    function openPanel() {
        if (document.getElementById(OVERLAY_ID)) return;

        saveUnread(0);
        updateFABBadge();

        const overlay = el('div', { id: OVERLAY_ID, style: css({ position:'fixed', inset:0, background:'rgba(0,0,0,.45)', zIndex:999998 }) });
        overlay.addEventListener('click', e => { if (e.target === overlay) closePanel(); });

        const panel = el('div', { style: css({
            position:'fixed', top:'4%', left:'50%', transform:'translateX(-50%)',
            width:'min(92%, 740px)', maxHeight:'90vh', overflowY:'auto',
            background:'#fff', borderRadius:'10px', boxShadow:'0 4px 24px rgba(0,0,0,.3)',
            padding:'16px', fontFamily:'sans-serif', fontSize:'13px', color:'#333', zIndex:999999
        })});

        const hdr = el('div', { style: css({ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'10px' }) });
        hdr.append(
            el('h2', { style:'margin:0;font-size:15px' }, '片道GO! 変更履歴'),
            btn('✕ 閉じる', closePanel, 'background:#555;color:#fff')
        );
        panel.append(hdr);

        // ── リロード間隔設定 ──────────────────────────────────────────────────
        const settingsBox = el('div', { style: css({
            background:'#f5f7fa', border:'1px solid #dde', borderRadius:'7px',
            padding:'10px 14px', marginBottom:'12px',
            display:'flex', alignItems:'center', gap:'10px', flexWrap:'wrap'
        })});
        settingsBox.append(el('span', { style:'font-weight:bold;font-size:12px;color:#555' }, '⚙ リロード間隔：'));

        const intervalInput = el('input', {
            type:'number', min:'10', max:'3600',
            value: String(loadInterval()),
            style: css({ width:'70px', padding:'4px 8px', border:'1px solid #ccc', borderRadius:'5px', fontSize:'12px' })
        });

        const applyBtn = btn('適用', () => {
            const secs = Math.max(10, Math.min(3600, parseInt(intervalInput.value, 10) || 60));
            intervalInput.value = String(secs);
            saveInterval(secs);
            statusMsg.textContent = `✓ ${secs}秒に設定しました（次回リロード時から適用）`;
            setTimeout(() => { statusMsg.textContent = ''; }, 3000);
        }, 'background:#0070c0;color:#fff');

        const statusMsg = el('span', { style:'font-size:11px;color:#28a745' });

        settingsBox.append(intervalInput, el('span', { style:'font-size:12px;color:#555' }, '秒'), applyBtn);

        // 通知タイムアウト設定
        settingsBox.append(el('span', { style:'font-weight:bold;font-size:12px;color:#555;margin-left:14px' }, '🔔 通知表示時間：'));

        const notifyInput = el('input', {
            type:'number', min:'0', max:'3600',
            value: String(loadNotifyTimeout()),
            style: css({ width:'70px', padding:'4px 8px', border:'1px solid #ccc', borderRadius:'5px', fontSize:'12px' })
        });

        const notifyApplyBtn = btn('適用', () => {
            const secs = Math.max(0, Math.min(3600, parseInt(notifyInput.value, 10) || 0));
            notifyInput.value = String(secs);
            saveNotifyTimeout(secs);
            statusMsg.textContent = `✓ 通知を${secs === 0 ? '手動で閉じる' : secs + '秒'}に設定しました`;
            setTimeout(() => { statusMsg.textContent = ''; }, 3000);
        }, 'background:#0070c0;color:#fff');

        settingsBox.append(notifyInput, el('span', { style:'font-size:12px;color:#555' }, '秒（0＝手動で閉じる）'), notifyApplyBtn, statusMsg);
        panel.append(settingsBox);

        // ── 履歴リスト ────────────────────────────────────────────────────────
        const listWrap = el('div', { id: 'trc-list' });
        renderHistoryList(listWrap);
        panel.append(listWrap);

        const footer = el('div', { style: css({ display:'flex', gap:'8px', marginTop:'14px', borderTop:'1px solid #eee', paddingTop:'10px', flexWrap:'wrap' }) });
        footer.append(
            btn('全記録をクリア', () => {
                if (confirm('すべての変更履歴を削除しますか？')) {
                    clearAllData(); closePanel(); openPanel();
                }
            }, 'background:#dc3545;color:#fff')
        );
        panel.append(footer);

        overlay.append(panel);
        document.body.append(overlay);
    }

    function renderHistoryList(wrap) {
        wrap.innerHTML = '';
        const history = loadHistory();

        if (!history.length) {
            wrap.append(el('div', { style:'color:#888;text-align:center;padding:30px' }, 'まだ変更履歴はありません。'));
            return;
        }

        history.forEach((record, idx) => {
            const { ts, diff } = record;

            if (!diff.added.length && !diff.disappeared.length && !diff.statusChangedToClosed.length) return;

            const card = el('div', { style: css({
                border:'1px solid #ddd', borderRadius:'8px', marginBottom:'12px', overflow:'hidden'
            })});

            let expanded = true;

            const cardHdr = el('div', { style: css({
                display:'flex', justifyContent:'space-between', alignItems:'center',
                background:'#f0f4f8', padding:'8px 12px', cursor:'pointer', userSelect:'none'
            })});

            const badgeRow = el('div', { style:'display:flex;gap:6px;align-items:center;flex-wrap:wrap' });
            badgeRow.append(el('span', { style:'font-size:12px;color:#555;margin-right:4px' }, new Date(ts).toLocaleString()));
            if (diff.added.length)                 badgeRow.append(badge(`＋${diff.added.length}`, '#28a745'));
            if (diff.statusChangedToClosed.length) badgeRow.append(badge(`⚠${diff.statusChangedToClosed.length}`, '#e0a800'));
            if (diff.disappeared.length)            badgeRow.append(badge(`✕${diff.disappeared.length}`, '#dc3545'));

            const toggleBtn = el('span', {
                style: css({
                    fontSize:'16px', lineHeight:'1', transition:'transform .2s',
                    display:'inline-block', transform:'rotate(0deg)',
                    color:'#555', marginRight:'6px', pointerEvents:'none'
                })
            }, '▾');

            const rightGroup = el('div', { style:'display:flex;align-items:center;gap:4px' });

            const delBtn = btn('✕', e => {
                e.stopPropagation();
                const h = loadHistory();
                h.splice(idx, 1);
                saveHistory(h);
                card.remove();
            }, 'background:transparent;color:#aaa;font-size:14px;padding:2px 6px');

            rightGroup.append(toggleBtn, delBtn);
            cardHdr.append(badgeRow, rightGroup);

            const body = el('div', { style:'padding:10px 12px' });

            if (diff.added.length) {
                body.append(el('div', { style:'font-weight:bold;font-size:12px;margin-bottom:4px;color:#28a745' }, '新しく追加された車'));
                diff.added.forEach(c => body.append(carCard(c, '#d4edda')));
            }
            if (diff.statusChangedToClosed.length) {
                body.append(el('div', { style:'font-weight:bold;font-size:12px;margin:8px 0 4px;color:#856404' }, '受付終了になった車'));
                diff.statusChangedToClosed.forEach(s => body.append(carCard(s.after, '#fff3cd')));
            }
            if (diff.disappeared.length) {
                body.append(el('div', { style:'font-weight:bold;font-size:12px;margin:8px 0 4px;color:#dc3545' }, 'ページから消えた車'));
                diff.disappeared.forEach(c => body.append(carCard(c, '#f8d7da')));
            }

            function setExpanded(state) {
                expanded = state;
                body.style.display        = expanded ? 'block' : 'none';
                toggleBtn.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
            }

            const isFirst = wrap.children.length === 0;
            cardHdr.addEventListener('click', () => setExpanded(!expanded));
            setExpanded(isFirst);

            card.append(cardHdr, body);
            wrap.append(card);
        });

        if (!wrap.children.length) {
            wrap.append(el('div', { style:'color:#888;text-align:center;padding:20px' }, '変更履歴はありません。'));
        }
    }

    function closePanel() { document.getElementById(OVERLAY_ID)?.remove(); }

    function createFAB() {
        if (document.getElementById(FAB_ID)) return;
        const wrap = el('div', { id: FAB_ID, style: css({ position:'fixed', bottom:'24px', right:'24px', zIndex:'999997', width:'52px', height:'52px' }) });
        const fabBtn = el('div', {
            title: '片道GO! 履歴を開く',
            style: css({ position:'absolute', inset:'0', borderRadius:'50%', background:'#0070c0', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'22px', cursor:'pointer', boxShadow:'0 3px 10px rgba(0,0,0,.35)', userSelect:'none', transition:'background .2s' }),
            onclick: openPanel
        }, '🚗');
        fabBtn.addEventListener('mouseenter', () => fabBtn.style.background = '#005fa3');
        fabBtn.addEventListener('mouseleave', () => fabBtn.style.background = '#0070c0');
        const badgeEl = el('div', { id: BADGE_ID, style: css({ position:'absolute', top:'-2px', right:'-2px', background:'#dc3545', color:'#fff', borderRadius:'50%', minWidth:'18px', height:'18px', fontSize:'10px', fontWeight:'bold', display:'none', alignItems:'center', justifyContent:'center', pointerEvents:'none', padding:'0 3px' }) });
        wrap.append(fabBtn, badgeEl);
        document.body.append(wrap);
        updateFABBadge();
    }

    function updateFABBadge() {
        const b = document.getElementById(BADGE_ID);
        if (!b) return;
        const n = loadUnread();
        b.textContent = n > 99 ? '99+' : String(n);
        b.style.display = n > 0 ? 'flex' : 'none';
    }

    async function check() {
        try {
            const curr = parseCars();
            const prev = loadCars();

            if (!prev.length) {
                saveCars(curr);
                log(`First run: saved ${curr.length} cars as baseline.`);
                return;
            }

            const diff = diffCars(prev, curr);
            saveCars(curr);

            if (!hasChanges(diff)) { log('No changes.'); return; }

            appendHistory(diff);
            notify(diff);
            updateFABBadge();
            log(`Changes detected: +${diff.added.length} ⚠${diff.statusChangedToClosed.length} ✕${diff.disappeared.length}`);
        } catch (e) {
            log('check error:', e);
        }
    }

    function scheduleReload() {
        const secs = loadInterval();
        const ms = secs * 1000;
        setTimeout(() => location.reload(), ms);
        log(`Next reload in ${secs}s`);
    }

    async function main() {
        try { await waitForContent(); } catch (e) { log(e.message); }
        createFAB();
        await check();
        openPanel();
        scheduleReload();
    }

    main();
})();
