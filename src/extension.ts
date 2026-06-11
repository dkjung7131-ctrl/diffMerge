import * as vscode from 'vscode';
import * as path from 'path';

let panel: vscode.WebviewPanel | undefined;
let panelReady = false;          // webview 스크립트 로드 완료 여부
let pending: any[] = [];         // 로드 전 보낸 메시지 대기열 (유실 방지)
let extCtx: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
    extCtx = context;
    launcherTree = new LauncherTree();
    context.subscriptions.push(
        vscode.window.createTreeView('diffmerge.launcher', {
            treeDataProvider: launcherTree,
            dragAndDropController: launcherTree
        }),
        vscode.commands.registerCommand('diffmerge.pick', async (side: Side) => {
            const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'DiffMerge로 열기' });
            if (picked && picked[0]) {
                openPanel();
                await sendFile(side, picked[0]);
            }
        }),
        vscode.commands.registerCommand('diffmerge.open', () => {
            openPanel();
        }),
        // 탐색기/에디터탭 우클릭 — 1개 또는 2개 선택 모두 허용
        vscode.commands.registerCommand('diffmerge.compareSelected', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
            const sel = (uris && uris.length ? uris : (uri ? [uri] : [])).slice(0, 2);
            openPanel();
            if (sel[0]) { await sendFile('left', sel[0]); }
            if (sel[1]) { await sendFile('right', sel[1]); }
        }),
        // F5 키바인딩 (activeWebviewPanelId == 'diffMerge' 일 때만)
        vscode.commands.registerCommand('diffmerge.refresh', () => {
            panel?.webview.postMessage({ type: 'refresh' });
        }),
        vscode.commands.registerCommand('diffmerge.checkUpdate', () => checkUpdate(true))
    );

    // 하루 1회 자동 업데이트 확인 (GitHub Release)
    const last = context.globalState.get<number>('lastUpdateCheck', 0);
    if (Date.now() - last > 24 * 60 * 60 * 1000) {
        context.globalState.update('lastUpdateCheck', Date.now());
        checkUpdate(false);
    }
}

// ---------- 자동 업데이트 (GitHub Release 기반) ----------

const UPDATE_REPO = 'dkjung7131-ctrl/diffMerge';

async function checkUpdate(manual: boolean): Promise<void> {
    try {
        const gfetch: any = (globalThis as any).fetch;
        if (!gfetch) { return; }
        const cur: string = extCtx.extension.packageJSON.version;
        const res = await gfetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
            headers: { 'User-Agent': 'diffmerge-extension', 'Accept': 'application/vnd.github+json' }
        });
        if (!res.ok) { throw new Error('GitHub API 응답 ' + res.status); }
        const rel: any = await res.json();
        const latest = String(rel.tag_name || '').replace(/^v/, '');
        if (!latest || cmpVer(latest, cur) <= 0) {
            if (manual) { vscode.window.showInformationMessage(`DiffMerge: 최신 버전입니다 (v${cur})`); }
            return;
        }
        const asset = (rel.assets || []).find((a: any) => String(a.name).endsWith('.vsix'));
        if (!asset) {
            if (manual) { vscode.window.showWarningMessage(`DiffMerge v${latest} 릴리즈에 vsix 파일이 없습니다`); }
            return;
        }
        const pick = await vscode.window.showInformationMessage(
            `DiffMerge v${latest} 업데이트가 있습니다 (현재 v${cur})`, '업데이트', '나중에');
        if (pick !== '업데이트') { return; }
        const dl = await gfetch(asset.browser_download_url, { headers: { 'User-Agent': 'diffmerge-extension' } });
        if (!dl.ok) { throw new Error('다운로드 실패 ' + dl.status); }
        const buf = Buffer.from(await dl.arrayBuffer());
        await vscode.workspace.fs.createDirectory(extCtx.globalStorageUri);
        const tmp = vscode.Uri.joinPath(extCtx.globalStorageUri, asset.name);
        await vscode.workspace.fs.writeFile(tmp, buf);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', tmp);
        const r = await vscode.window.showInformationMessage(
            `DiffMerge v${latest} 설치 완료 — 창을 다시 로드하면 적용됩니다`, '다시 로드');
        if (r === '다시 로드') { vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    } catch (e: any) {
        if (manual) { vscode.window.showErrorMessage('DiffMerge 업데이트 확인 실패: ' + (e?.message ?? String(e))); }
    }
}

function cmpVer(a: string, b: string): number {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) { return d; }
    }
    return 0;
}

function openPanel(): void {
    if (panel) {
        panel.reveal();
        return;
    }
    panel = vscode.window.createWebviewPanel('diffMerge', 'DiffMerge', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extCtx.extensionUri, 'media')]
    });
    panelReady = false;
    pending = [];
    panel.onDidDispose(() => { panel = undefined; panelReady = false; pending = []; }, null, extCtx.subscriptions);
    panel.webview.onDidReceiveMessage(handleMessage, null, extCtx.subscriptions);
    panel.webview.html = getHtml(panel.webview);
}

// 패널 webview 로 메시지 전송 — 로드 전이면 대기열에 보관
function postToPanel(msg: any): void {
    if (panel && panelReady) {
        panel.webview.postMessage(msg);
    } else {
        pending.push(msg);
    }
}

async function handleMessage(m: any): Promise<void> {
    try {
        switch (m.type) {
            case 'ready': {
                panelReady = true;
                const q = pending;
                pending = [];
                for (const msg of q) { panel?.webview.postMessage(msg); }
                break;
            }
            case 'pickFile': {
                const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'DiffMerge로 열기' });
                if (picked && picked[0]) { await sendFile(m.side, picked[0]); }
                break;
            }
            case 'loadUri':
                await sendFile(m.side, vscode.Uri.parse(m.uri));
                break;
            case 'loadPath':
            case 'readPath':
                await sendFile(m.side, vscode.Uri.file(m.path));
                break;
            case 'save': {
                let target = m.path ? vscode.Uri.file(m.path) : await vscode.window.showSaveDialog({ saveLabel: '저장' });
                if (!target) { return; }
                await vscode.workspace.fs.writeFile(target, Buffer.from(m.content, 'utf8'));
                panel?.webview.postMessage({
                    type: 'saved', side: m.side,
                    path: target.fsPath, name: path.basename(target.fsPath)
                });
                vscode.window.setStatusBarMessage(`DiffMerge: ${path.basename(target.fsPath)} 저장됨`, 3000);
                break;
            }
            case 'error':
                vscode.window.showErrorMessage('DiffMerge: ' + m.message);
                break;
        }
    } catch (e: any) {
        vscode.window.showErrorMessage('DiffMerge: ' + (e?.message ?? String(e)));
    }
}

async function sendFile(side: 'left' | 'right', uri: vscode.Uri): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    postToPanel({
        type: 'setFile',
        side,
        path: uri.scheme === 'file' ? uri.fsPath : null,
        name: path.basename(uri.path),
        content: Buffer.from(bytes).toString('utf8')
    });
    slotNames[side] = path.basename(uri.path);
    launcherTree?.refresh();
}

// ---------- 사이드바 런처 (액티비티 바 아이콘) ----------

type Side = 'left' | 'right';
const slotNames: { left: string | null; right: string | null } = { left: null, right: null };
let launcherTree: LauncherTree | undefined;

type LauncherItem = Side | 'open';

// TreeView DnD — VSCode 탐색기에서 Shift 없이 그냥 끌어다 놓을 수 있는 공식 지원 경로.
// (webview 는 워크벤치 내부 드래그를 못 받는 제약이 있어 트리 뷰로 받는다 — vscode#182449)
class LauncherTree implements vscode.TreeDataProvider<LauncherItem>, vscode.TreeDragAndDropController<LauncherItem> {
    readonly dropMimeTypes = ['text/uri-list'];
    readonly dragMimeTypes: string[] = [];

    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;
    refresh(): void { this._onDidChange.fire(); }

    getChildren(el?: LauncherItem): LauncherItem[] {
        return el ? [] : ['open', 'left', 'right'];
    }

    getTreeItem(el: LauncherItem): vscode.TreeItem {
        if (el === 'open') {
            const t = new vscode.TreeItem('비교 창 열기');
            t.iconPath = new vscode.ThemeIcon('diff');
            t.command = { command: 'diffmerge.open', title: '비교 창 열기' };
            t.tooltip = 'DiffMerge 비교 창을 엽니다';
            return t;
        }
        const name = slotNames[el];
        const t = new vscode.TreeItem((el === 'left' ? '왼쪽: ' : '오른쪽: ') + (name ?? '(비어 있음)'));
        t.iconPath = new vscode.ThemeIcon(name ? 'file' : 'new-file');
        t.command = { command: 'diffmerge.pick', title: '파일 선택', arguments: [el] };
        t.tooltip = '클릭하면 파일 선택 대화상자가 열립니다.\n탐색기에서 파일을 이 줄에 끌어다 놓아도 됩니다 (Shift 불필요).';
        return t;
    }

    async handleDrop(target: LauncherItem | undefined, dt: vscode.DataTransfer): Promise<void> {
        const item = dt.get('text/uri-list');
        if (!item) { return; }
        const text = await item.asString();
        const uris = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s.charAt(0) !== '#');
        if (!uris.length) { return; }
        // 떨어뜨린 줄이 오른쪽 슬롯이면 오른쪽부터, 그 외(왼쪽·빈 영역·열기 줄)는 왼쪽부터
        const side: Side = target === 'right' ? 'right' : 'left';
        openPanel();
        await sendFile(side, vscode.Uri.parse(uris[0]));
        if (uris[1]) { await sendFile(side === 'left' ? 'right' : 'left', vscode.Uri.parse(uris[1])); }
    }
}

function getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extCtx.extensionUri, 'media', 'style.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extCtx.extensionUri, 'media', 'main.js'));
    const nonce = Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${cssUri}">
<title>DiffMerge</title>
</head>
<body>
<div id="app">
  <div id="toolbar">
    <button id="btnCompare" title="다시 비교 (F5)">⟳ 비교</button>
    <button id="btnSwap" title="좌우 바꾸기">⇄ 바꾸기</button>
    <button id="btnEdit" title="파일 없이 텍스트를 직접 붙여넣어 비교">✎ 텍스트</button>
    <span class="sep"></span>
    <button id="btnPrev" title="이전 변경">▲ 이전</button>
    <button id="btnNext" title="다음 변경">▼ 다음</button>
    <span id="stats"></span>
    <span class="spacer"></span>
    <button id="btnSaveL">왼쪽 저장</button>
    <button id="btnSaveR">오른쪽 저장</button>
  </div>
  <div id="headers">
    <div class="phead">
      <span class="pname"><span class="dot" id="dotL"></span><span id="nameL">(비어 있음)</span></span>
      <span class="ppath" id="pathL"></span>
      <span class="hbtns"><button id="btnOpenL">열기…</button><button id="btnClearL">지우기</button></span>
    </div>
    <div class="gutspace"></div>
    <div class="phead">
      <span class="pname"><span class="dot" id="dotR"></span><span id="nameR">(비어 있음)</span></span>
      <span class="ppath" id="pathR"></span>
      <span class="hbtns"><button id="btnOpenR">열기…</button><button id="btnClearR">지우기</button></span>
    </div>
  </div>
  <div id="main">
    <div id="diff" tabindex="0"></div>
    <div id="ruler" title="변경 위치 미리보기 — 클릭하면 이동">
      <canvas id="rulerCanvas"></canvas>
      <div id="rulerView"></div>
    </div>
  </div>
  <div id="welcome">
    <div class="w-icon">⇆</div>
    <div class="w-title">DiffMerge</div>
    <div class="w-text">
      Finder · 바탕화면에서는 파일을 이쪽으로 그냥 드래그하세요.<br>
      <b>VSCode 탐색기에서는</b> 사이드바(⇆)의 <b>왼쪽/오른쪽 슬롯</b>에 끌어다 놓거나, 우클릭 → <b>"DiffMerge로 비교"</b>.<br>
      이 패널에 직접 놓으려면 <b>드래그를 시작한 뒤, 놓기 직전에 Shift</b> 를 누르세요 (미리 누르면 안 됨).<br>
      파일 없이도 됩니다 — 그냥 <b>붙여넣기(⌘V)</b> 하거나 툴바의 <b>✎ 텍스트</b> 버튼을 누르세요.<br><br>
      <b>한 개만 열어도 됩니다</b> — 반대쪽은 빈 상태로 비교됩니다.
    </div>
    <div class="w-btns"><button id="btnWOpenL">왼쪽 파일 열기…</button><button id="btnWOpenR">오른쪽 파일 열기…</button></div>
  </div>
  <div id="editor">
    <div id="edCols">
      <div class="ed-col">
        <div class="ed-head">왼쪽</div>
        <textarea id="edL" placeholder="여기에 텍스트 붙여넣기 (⌘V)" spellcheck="false"></textarea>
      </div>
      <div class="ed-col">
        <div class="ed-head">오른쪽</div>
        <textarea id="edR" placeholder="여기에 텍스트 붙여넣기 (⌘V)" spellcheck="false"></textarea>
      </div>
    </div>
    <div id="editorBtns">
      <button id="btnEdApply">비교 (⌘Enter)</button>
      <button id="btnEdCancel">취소 (Esc)</button>
    </div>
  </div>
  <div id="dropOverlay">
    <div class="dz" id="dropL"><span>⬇ 왼쪽에 놓기</span></div>
    <div class="dz" id="dropR"><span>⬇ 오른쪽에 놓기</span></div>
    <div class="dz-hint">VSCode 탐색기에서 끌어왔다면 — <b>놓기 직전에 Shift</b> 를 누르세요 (드래그 시작 전에 미리 누르면 안 됨). 안 되면 사이드바(⇆) 슬롯에 놓으세요.</div>
  </div>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

export function deactivate() { }
