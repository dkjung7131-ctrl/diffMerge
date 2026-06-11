// DiffMerge webview — diff 계산 · 렌더링 · 드래그앤드롭 · 블록 병합
(function () {
    'use strict';
    const vscode = acquireVsCodeApi();

    const state = {
        left: { path: null, name: null, lines: null, eol: '\n', edited: false },
        right: { path: null, name: null, lines: null, eol: '\n', edited: false }
    };
    let rows = [];    // { type:'same'|'mod'|'del'|'ins', l:번호|null, r:번호|null }
    let blocks = [];  // 연속된 변경 행 묶음 (병합/탐색 단위)
    let cur = -1;     // 현재 선택된 블록

    const $ = (id) => document.getElementById(id);
    const other = (s) => s === 'left' ? 'right' : 'left';

    // ---------------- diff 핵심 (patience diff) ----------------

    function splitLines(text) {
        if (text === '') { return []; }
        const lines = text.split(/\r\n|\r|\n/);
        if (lines.length && lines[lines.length - 1] === '') { lines.pop(); }
        return lines;
    }

    function pushOp(out, t, n) {
        if (n <= 0) { return; }
        const last = out[out.length - 1];
        if (last && last.t === t) { last.n += n; } else { out.push({ t: t, n: n }); }
    }

    // 양쪽 범위에서 정확히 1번씩 나오는 줄들을 앵커로 — LIS 로 순서 보존 매칭
    function patienceAnchors(a, alo, ahi, b, blo, bhi) {
        const ca = new Map(), cb = new Map();
        for (let i = alo; i < ahi; i++) { const k = a[i]; ca.set(k, ca.has(k) ? -1 : i); }
        for (let i = blo; i < bhi; i++) { const k = b[i]; cb.set(k, cb.has(k) ? -1 : i); }
        const cand = [];
        for (let i = alo; i < ahi; i++) {
            const k = a[i];
            if (ca.get(k) === i && cb.has(k) && cb.get(k) >= 0) { cand.push([i, cb.get(k)]); }
        }
        const tails = [], tailIdx = [], prev = new Array(cand.length).fill(-1);
        for (let i = 0; i < cand.length; i++) {
            const v = cand[i][1];
            let lo = 0, hi = tails.length;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) { lo = mid + 1; } else { hi = mid; } }
            tails[lo] = v; tailIdx[lo] = i;
            prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
        }
        const res = [];
        let i = tails.length ? tailIdx[tails.length - 1] : -1;
        while (i >= 0) { res.push(cand[i]); i = prev[i]; }
        res.reverse();
        return res;
    }

    function pdiff(a, alo, ahi, b, blo, bhi, out, depth) {
        let start = 0;
        while (alo + start < ahi && blo + start < bhi && a[alo + start] === b[blo + start]) { start++; }
        pushOp(out, 's', start);
        let end = 0;
        while (ahi - end > alo + start && bhi - end > blo + start && a[ahi - 1 - end] === b[bhi - 1 - end]) { end++; }
        const ral = alo + start, rah = ahi - end, rbl = blo + start, rbh = bhi - end;
        if (ral >= rah && rbl >= rbh) {
            // 남은 게 없음
        } else if (ral >= rah) {
            pushOp(out, 'i', rbh - rbl);
        } else if (rbl >= rbh) {
            pushOp(out, 'd', rah - ral);
        } else {
            const anchors = depth > 100 ? [] : patienceAnchors(a, ral, rah, b, rbl, rbh);
            if (!anchors.length) {
                pushOp(out, 'd', rah - ral);
                pushOp(out, 'i', rbh - rbl);
            } else {
                let pa = ral, pb = rbl;
                for (const an of anchors) {
                    pdiff(a, pa, an[0], b, pb, an[1], out, depth + 1);
                    pushOp(out, 's', 1);
                    pa = an[0] + 1; pb = an[1] + 1;
                }
                pdiff(a, pa, rah, b, pb, rbh, out, depth + 1);
            }
        }
        pushOp(out, 's', end);
    }

    function diffOps(a, b) {
        const out = [];
        pdiff(a, 0, a.length, b, 0, b.length, out, 0);
        return out;
    }

    // ---------------- rows / blocks ----------------

    function buildRows() {
        const a = state.left.lines || [], b = state.right.lines || [];
        const ops = diffOps(a, b);
        rows = [];
        let li = 0, ri = 0, k = 0;
        while (k < ops.length) {
            if (ops[k].t === 's') {
                for (let n = 0; n < ops[k].n; n++) { rows.push({ type: 'same', l: li++, r: ri++ }); }
                k++;
            } else {
                // 연속된 del/ins 묶음 → min 만큼은 mod(짝) 처리, 나머지는 단독
                let nd = 0, ni = 0;
                while (k < ops.length && ops[k].t !== 's') {
                    if (ops[k].t === 'd') { nd += ops[k].n; } else { ni += ops[k].n; }
                    k++;
                }
                const both = Math.min(nd, ni);
                for (let n = 0; n < both; n++) { rows.push({ type: 'mod', l: li++, r: ri++ }); }
                for (let n = both; n < nd; n++) { rows.push({ type: 'del', l: li++, r: null }); }
                for (let n = both; n < ni; n++) { rows.push({ type: 'ins', l: null, r: ri++ }); }
            }
        }
        blocks = [];
        let i = 0;
        while (i < rows.length) {
            if (rows[i].type === 'same') { i++; continue; }
            const startR = i;
            while (i < rows.length && rows[i].type !== 'same') { i++; }
            const lL = [], rL = [];
            for (let j = startR; j < i; j++) {
                if (rows[j].l != null) { lL.push(rows[j].l); }
                if (rows[j].r != null) { rL.push(rows[j].r); }
            }
            blocks.push({
                start: startR, end: i, lLines: lL, rLines: rL,
                lIns: nextIdx('l', i), rIns: nextIdx('r', i)
            });
        }
        if (cur >= blocks.length) { cur = blocks.length - 1; }
    }

    // 블록에 해당 측 줄이 하나도 없을 때 삽입 위치 = 블록 뒤 첫 줄 번호
    function nextIdx(which, rowIdx) {
        for (let j = rowIdx; j < rows.length; j++) {
            const v = which === 'l' ? rows[j].l : rows[j].r;
            if (v != null) { return v; }
        }
        return which === 'l' ? (state.left.lines || []).length : (state.right.lines || []).length;
    }

    // ---------------- 렌더링 ----------------

    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // mod 행의 줄 내부 변경 구간 (공통 접두/접미 제외)
    function intraline(aS, bS) {
        let p = 0;
        const n = aS.length, m = bS.length;
        while (p < n && p < m && aS[p] === bS[p]) { p++; }
        let s = 0;
        while (s < n - p && s < m - p && aS[n - 1 - s] === bS[m - 1 - s]) { s++; }
        return { p: p, ae: n - s, be: m - s };
    }

    function codeHtml(text, st, en) {
        if (st == null || st >= en) { return esc(text); }
        return esc(text.slice(0, st)) + '<span class="chg">' + esc(text.slice(st, en)) + '</span>' + esc(text.slice(en));
    }

    function render() {
        const a = state.left.lines || [], b = state.right.lines || [];
        const blockAt = new Map();
        blocks.forEach((bl, idx) => blockAt.set(bl.start, idx));
        let html = '';
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            let lHtml = '', rHtml = '';
            if (r.type === 'mod') {
                const it = intraline(a[r.l], b[r.r]);
                lHtml = codeHtml(a[r.l], it.p, it.ae);
                rHtml = codeHtml(b[r.r], it.p, it.be);
            } else {
                if (r.l != null) { lHtml = esc(a[r.l]); }
                if (r.r != null) { rHtml = esc(b[r.r]); }
            }
            let gut = '';
            if (blockAt.has(i)) {
                const bi = blockAt.get(i);
                gut = '<button class="cpy" data-b="' + bi + '" data-dir="l2r" title="왼쪽 → 오른쪽 복사">▶</button>'
                    + '<button class="cpy" data-b="' + bi + '" data-dir="r2l" title="오른쪽 → 왼쪽 복사">◀</button>';
            }
            html += '<div class="row t-' + r.type + '" id="row-' + i + '" data-i="' + i + '">'
                + '<div class="ln">' + (r.l != null ? r.l + 1 : '') + '</div>'
                + '<div class="code side-l' + (r.l == null ? ' empty' : '') + '">' + (lHtml || (r.l != null ? '&#8203;' : '')) + '</div>'
                + '<div class="gut">' + gut + '</div>'
                + '<div class="ln">' + (r.r != null ? r.r + 1 : '') + '</div>'
                + '<div class="code side-r' + (r.r == null ? ' empty' : '') + '">' + (rHtml || (r.r != null ? '&#8203;' : '')) + '</div>'
                + '</div>';
        }
        if (!rows.length && (state.left.lines || state.right.lines)) {
            html = '<div class="nodiff">두 파일 모두 내용이 없습니다</div>';
        }
        $('diff').innerHTML = html;
        markCur(false);
        drawRuler();
    }

    // ---------------- 오버뷰 룰러 (WinMerge 위치 창) ----------------

    const RULER_COLORS = {
        del: 'rgba(229, 83, 83, 0.95)',
        ins: 'rgba(83, 196, 119, 0.95)',
        mod: 'rgba(222, 184, 73, 0.95)',
        same: 'rgba(222, 184, 73, 0.95)'
    };

    function drawRuler() {
        const diffEl = $('diff'), ruler = $('ruler'), cv = $('rulerCanvas');
        const H = ruler.clientHeight, W = ruler.clientWidth;
        if (!H || !W) { return; }
        const dpr = window.devicePixelRatio || 1;
        cv.width = W * dpr;
        cv.height = H * dpr;
        cv.style.width = W + 'px';
        cv.style.height = H + 'px';
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const SH = diffEl.scrollHeight || 1;
        for (const bl of blocks) {
            const first = $('row-' + bl.start), last = $('row-' + (bl.end - 1));
            if (!first || !last) { continue; }
            const y1 = first.offsetTop / SH * H;
            const y2 = (last.offsetTop + last.offsetHeight) / SH * H;
            ctx.fillStyle = RULER_COLORS[rows[bl.start].type];
            ctx.fillRect(2, y1, W - 4, Math.max(2, y2 - y1));
        }
        updateRulerView();
    }

    function updateRulerView() {
        const diffEl = $('diff'), ruler = $('ruler'), rv = $('rulerView');
        const H = ruler.clientHeight;
        const SH = diffEl.scrollHeight || 1;
        rv.style.top = (diffEl.scrollTop / SH * H) + 'px';
        rv.style.height = Math.max(10, diffEl.clientHeight / SH * H) + 'px';
    }

    function rulerScrollTo(e) {
        const diffEl = $('diff');
        const rect = $('ruler').getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
        diffEl.scrollTop = frac * diffEl.scrollHeight - diffEl.clientHeight / 2;
    }

    function updateUi() {
        setHead('L', state.left);
        setHead('R', state.right);
        const loaded = state.left.lines || state.right.lines;
        $('stats').textContent = loaded ? (blocks.length ? '차이 ' + blocks.length + '곳' : '✓ 차이 없음') : '';
        $('welcome').style.display = loaded ? 'none' : 'flex';
        $('btnSaveL').disabled = !state.left.lines;
        $('btnSaveR').disabled = !state.right.lines;
    }

    function setHead(suffix, s) {
        $('name' + suffix).textContent = s.lines ? (s.name || '(이름 없음)') : '(비어 있음)';
        $('path' + suffix).textContent = s.path || '';
        $('path' + suffix).title = s.path || '';
        $('dot' + suffix).className = 'dot' + (s.edited ? ' on' : '');
    }

    function compare() {
        buildRows();
        render();
        updateUi();
        vscode.setState({ l: state.left.path, r: state.right.path });
    }

    // ---------------- 파일 적재 ----------------

    function setContent(side, path, name, content) {
        if (content.indexOf('\u0000') >= 0) {
            vscode.postMessage({ type: 'error', message: '바이너리 파일은 비교할 수 없습니다: ' + name });
            return;
        }
        const s = state[side];
        s.path = path || null;
        s.name = name || '(이름 없음)';
        s.eol = content.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
        s.lines = splitLines(content);
        s.edited = false;
        cur = -1;
        compare();
    }

    function clearSide(side) {
        state[side] = { path: null, name: null, lines: null, eol: '\n', edited: false };
        cur = -1;
        compare();
    }

    // ---------------- 텍스트 직접 입력 (붙여넣기 비교) ----------------

    // 파일이 연결된 쪽을 고치면 수정(저장 가능)으로, 빈 쪽이면 새 텍스트로 적재
    function setText(side, text) {
        const s = state[side];
        if (s.lines && s.path) {
            s.lines = splitLines(text);
            s.edited = true;
        } else {
            s.path = null;
            s.name = '(붙여넣은 텍스트)';
            s.eol = '\n';
            s.lines = splitLines(text);
            s.edited = false;
        }
        cur = -1;
    }

    function openEditor() {
        $('edL').value = state.left.lines ? state.left.lines.join('\n') : '';
        $('edR').value = state.right.lines ? state.right.lines.join('\n') : '';
        $('editor').classList.add('show');
        $('edL').focus();
    }

    function applyEditor() {
        const tL = $('edL').value, tR = $('edR').value;
        const oldL = state.left.lines ? state.left.lines.join('\n') : '';
        const oldR = state.right.lines ? state.right.lines.join('\n') : '';
        if (tL !== oldL) { setText('left', tL); }
        if (tR !== oldR) { setText('right', tR); }
        $('editor').classList.remove('show');
        compare();
    }

    // F5 / 비교 버튼 — 경로 있는 쪽은 디스크에서 다시 읽음 (수정 중이면 보존)
    function refresh() {
        let asked = false;
        for (const side of ['left', 'right']) {
            const s = state[side];
            if (s.path && !s.edited) {
                vscode.postMessage({ type: 'readPath', side: side, path: s.path });
                asked = true;
            }
        }
        if (!asked) { compare(); }
    }

    // ---------------- 병합 (블록 복사) ----------------

    function copyBlock(bi, dir) {
        const bl = blocks[bi];
        if (!bl) { return; }
        const src = dir === 'l2r' ? 'left' : 'right';
        const dst = dir === 'l2r' ? 'right' : 'left';
        if (!state[src].lines) { state[src].lines = []; }
        if (!state[dst].lines) {
            state[dst].lines = [];
            state[dst].name = state[dst].name || '(새 파일)';
        }
        const srcIdx = dir === 'l2r' ? bl.lLines : bl.rLines;
        const dstIdx = dir === 'l2r' ? bl.rLines : bl.lLines;
        const srcLines = srcIdx.map((i) => state[src].lines[i]);
        const at = dstIdx.length ? dstIdx[0] : (dir === 'l2r' ? bl.rIns : bl.lIns);
        state[dst].lines.splice(at, dstIdx.length, ...srcLines);
        state[dst].edited = true;
        compare();
    }

    function save(side) {
        const s = state[side];
        if (!s.lines) { return; }
        const content = s.lines.join(s.eol) + (s.lines.length ? s.eol : '');
        vscode.postMessage({ type: 'save', side: side, path: s.path, content: content });
    }

    // ---------------- 변경 블록 탐색 ----------------

    function nav(dir) {
        if (!blocks.length) { return; }
        cur = cur < 0 ? (dir > 0 ? 0 : blocks.length - 1)
            : (cur + dir + blocks.length) % blocks.length;
        markCur(true);
    }

    function markCur(scroll) {
        document.querySelectorAll('.row.sel').forEach((el) => el.classList.remove('sel'));
        if (cur < 0 || cur >= blocks.length) { return; }
        const bl = blocks[cur];
        for (let j = bl.start; j < bl.end; j++) {
            const el = $('row-' + j);
            if (el) { el.classList.add('sel'); }
        }
        if (scroll) {
            const el = $('row-' + bl.start);
            if (el) { el.scrollIntoView({ block: 'center' }); }
        }
    }

    // ---------------- 드래그앤드롭 ----------------

    let dragCount = 0;
    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCount++;
        $('dropOverlay').classList.add('show');
    });
    window.addEventListener('dragleave', () => {
        dragCount--;
        if (dragCount <= 0) { dragCount = 0; $('dropOverlay').classList.remove('show'); }
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCount = 0;
        $('dropOverlay').classList.remove('show');
    });

    for (const side of ['left', 'right']) {
        const zone = $(side === 'left' ? 'dropL' : 'dropR');
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            zone.classList.add('hover');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            zone.classList.remove('hover');
            dragCount = 0;
            $('dropOverlay').classList.remove('show');
            handleDrop(side, e.dataTransfer);
        });
    }

    function handleDrop(side, dt) {
        // 1) VSCode 탐색기(Shift 누른 채 드롭)·에디터 탭 드래그 → URI 목록
        //    탐색기 드래그는 워크벤치가 webview 이벤트를 막으므로 Shift 를 눌러야만 전달됨 (vscode#182449)
        const items = collectUris(dt);
        if (items.length) {
            postLoad(side, items[0]);
            if (items[1]) { postLoad(other(side), items[1]); }
            return;
        }
        // 2) Finder/바탕화면 드래그 → File 객체
        const files = dt.files;
        if (files && files.length) {
            loadDroppedFile(side, files[0]);
            if (files[1]) { loadDroppedFile(other(side), files[1]); }
            return;
        }
        // 3) 텍스트 조각 드래그
        const text = dt.getData('text/plain');
        if (text) { setContent(side, null, '(드롭한 텍스트)', text); }
    }

    // dataTransfer 에서 파일 URI/경로 후보 수집 — 표준 uri-list 우선, VSCode 내부 형식 폴백
    function collectUris(dt) {
        const items = [];
        const uriList = dt.getData('text/uri-list');
        if (uriList) {
            for (const u of uriList.split(/\r?\n/)) {
                if (u && u.charAt(0) !== '#') { items.push({ kind: 'uri', v: u }); }
            }
        }
        if (!items.length) {
            try {
                const ru = dt.getData('resourceurls');
                if (ru) { for (const u of JSON.parse(ru)) { if (u) { items.push({ kind: 'uri', v: u }); } } }
            } catch (e) { /* 형식 다르면 무시 */ }
        }
        if (!items.length) {
            try {
                const cf = dt.getData('codefiles');
                if (cf) { for (const p of JSON.parse(cf)) { if (p) { items.push({ kind: 'path', v: p }); } } }
            } catch (e) { /* 형식 다르면 무시 */ }
        }
        return items;
    }

    function postLoad(side, item) {
        if (item.kind === 'uri') {
            vscode.postMessage({ type: 'loadUri', side: side, uri: item.v });
        } else {
            vscode.postMessage({ type: 'loadPath', side: side, path: item.v });
        }
    }

    function loadDroppedFile(side, f) {
        if (f.path) {
            // 경로를 알 수 있으면 extension 쪽에서 읽음 (F5 새로고침 가능)
            vscode.postMessage({ type: 'loadPath', side: side, path: f.path });
            return;
        }
        // 경로를 못 얻는 환경 → 내용만 읽음 (비교는 되지만 F5 재읽기 불가)
        const rd = new FileReader();
        rd.onload = () => setContent(side, null, f.name, String(rd.result));
        rd.onerror = () => vscode.postMessage({ type: 'error', message: '파일을 읽을 수 없습니다: ' + f.name });
        rd.readAsText(f);
    }

    // ---------------- 이벤트 ----------------

    window.addEventListener('message', (e) => {
        const m = e.data;
        if (m.type === 'setFile') {
            setContent(m.side, m.path, m.name, m.content);
        } else if (m.type === 'refresh') {
            refresh();
        } else if (m.type === 'saved') {
            state[m.side].path = m.path;
            state[m.side].name = m.name;
            state[m.side].edited = false;
            updateUi();
        }
    });

    $('diff').addEventListener('click', (e) => {
        const btn = e.target.closest('button.cpy');
        if (btn) {
            copyBlock(parseInt(btn.dataset.b, 10), btn.dataset.dir);
            return;
        }
        const row = e.target.closest('.row');
        if (row) {
            const idx = parseInt(row.dataset.i, 10);
            const bi = blocks.findIndex((bl) => idx >= bl.start && idx < bl.end);
            if (bi >= 0) { cur = bi; markCur(false); }
        }
    });

    $('btnCompare').addEventListener('click', refresh);
    $('btnSwap').addEventListener('click', () => {
        const t = state.left;
        state.left = state.right;
        state.right = t;
        cur = -1;
        compare();
    });
    $('btnPrev').addEventListener('click', () => nav(-1));
    $('btnNext').addEventListener('click', () => nav(1));
    $('btnSaveL').addEventListener('click', () => save('left'));
    $('btnSaveR').addEventListener('click', () => save('right'));
    $('btnOpenL').addEventListener('click', () => vscode.postMessage({ type: 'pickFile', side: 'left' }));
    $('btnOpenR').addEventListener('click', () => vscode.postMessage({ type: 'pickFile', side: 'right' }));
    $('btnWOpenL').addEventListener('click', () => vscode.postMessage({ type: 'pickFile', side: 'left' }));
    $('btnWOpenR').addEventListener('click', () => vscode.postMessage({ type: 'pickFile', side: 'right' }));
    $('btnClearL').addEventListener('click', () => clearSide('left'));
    $('btnClearR').addEventListener('click', () => clearSide('right'));

    $('btnEdit').addEventListener('click', openEditor);
    $('btnEdApply').addEventListener('click', applyEditor);
    $('btnEdCancel').addEventListener('click', () => $('editor').classList.remove('show'));

    // 전역 붙여넣기 — 비어있는 쪽부터 채움, 둘 다 차 있으면 편집 화면을 띄움
    window.addEventListener('paste', (e) => {
        if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT')) { return; }
        if ($('editor').classList.contains('show')) { return; }
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        if (!text) { return; }
        e.preventDefault();
        if (!state.left.lines) { setText('left', text); compare(); }
        else if (!state.right.lines) { setText('right', text); compare(); }
        else { openEditor(); }
    });

    window.addEventListener('keydown', (e) => {
        const editorOpen = $('editor').classList.contains('show');
        if (editorOpen) {
            if (e.key === 'Escape') { e.preventDefault(); $('editor').classList.remove('show'); }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); applyEditor(); }
            return;
        }
        if (e.key === 'F5') { e.preventDefault(); refresh(); }
        else if (e.key === 'F8') { e.preventDefault(); nav(e.shiftKey ? -1 : 1); }
    });

    // 오버뷰 룰러 — 스크롤 추적 + 클릭/드래그 점프
    $('diff').addEventListener('scroll', updateRulerView);
    window.addEventListener('resize', drawRuler);
    let rulerDragging = false;
    $('ruler').addEventListener('mousedown', (e) => {
        rulerDragging = true;
        rulerScrollTo(e);
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if (rulerDragging) { rulerScrollTo(e); } });
    window.addEventListener('mouseup', () => { rulerDragging = false; });

    // 패널 재로드 시 이전 경로 복원
    const prev = vscode.getState();
    if (prev) {
        if (prev.l) { vscode.postMessage({ type: 'readPath', side: 'left', path: prev.l }); }
        if (prev.r) { vscode.postMessage({ type: 'readPath', side: 'right', path: prev.r }); }
    }
    updateUi();
    // 로드 완료 통지 — extension 이 대기열에 쌓아둔 setFile 메시지를 이때 보냄
    vscode.postMessage({ type: 'ready' });
})();
