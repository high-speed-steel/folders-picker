import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

type FolderConfigItem = string | { name?: string; path: string };

interface NormalizedFolder {
  name: string;
  path: string;
  exists: boolean;
  source: 'custom' | 'vscode';
}

interface FolderQuickPickItem extends vscode.QuickPickItem {
  folder?: NormalizedFolder;
  action?: 'add';
}

interface TrustEntry {
  uri?: string | { fsPath?: string; external?: string; path?: string; scheme?: string };
  trusted?: boolean;
}

const CONFIG_SECTION = 'trustedFoldersPicker';
const FOLDERS_KEY = 'folders';
const OPEN_IN_NEW_WINDOW_KEY = 'openInNewWindow';

let extensionContextRef: vscode.ExtensionContext | undefined;
let viewProviderRef: TrustedFoldersViewProvider | undefined;

function normalizeKey(p: string): string {
  const normalized = path.normalize(p.trim()).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function extractFsPathFromTrustEntry(item: TrustEntry): string | undefined {
  if (!item?.uri) {
    return undefined;
  }
  if (typeof item.uri === 'string') {
    try {
      const parsedUri = vscode.Uri.parse(item.uri);
      return parsedUri.scheme === 'file' ? parsedUri.fsPath : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof item.uri === 'object') {
    if (item.uri.fsPath) {
      return item.uri.fsPath;
    }
    if (item.uri.external) {
      try {
        const parsedUri = vscode.Uri.parse(item.uri.external);
        return parsedUri.scheme === 'file' ? parsedUri.fsPath : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function getConfiguredFolders(): NormalizedFolder[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawList = config.get<FolderConfigItem[]>(FOLDERS_KEY, []);
  const seen = new Set<string>();
  const result: NormalizedFolder[] = [];

  for (const item of rawList) {
    const rawPath = typeof item === 'string' ? item : item?.path;
    if (!rawPath || typeof rawPath !== 'string') {
      continue;
    }

    const normalizedPath = path.normalize(rawPath.trim());
    const key = normalizeKey(normalizedPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const customName = typeof item === 'object' && item?.name ? item.name.trim() : '';
    const name = customName || path.basename(normalizedPath) || normalizedPath;
    const exists = fs.existsSync(normalizedPath);

    result.push({ name, path: normalizedPath, exists, source: 'custom' });
  }

  return result;
}

function getVsCodeStateDbPaths(): string[] {
  const candidates: string[] = [];
  const home = os.homedir();

  // 1. VS Code 新版 (1.148+): applicationSharedStorage (~/.vscode-shared/sharedStorage/state.vscdb)
  if (process.env.VSCODE_PORTABLE) {
    candidates.push(path.join(process.env.VSCODE_PORTABLE, 'shared-data', 'sharedStorage', 'state.vscdb'));
  }
  candidates.push(
    path.join(home, '.vscode-shared', 'sharedStorage', 'state.vscdb'),
    path.join(home, '.vscode-insiders-shared', 'sharedStorage', 'state.vscdb')
  );

  // 2. 目前執行的 VS Code 實例自身的 globalStorage/state.vscdb（舊版相容）
  if (extensionContextRef?.globalStorageUri) {
    const currentGlobalStorage = path.dirname(extensionContextRef.globalStorageUri.fsPath);
    candidates.push(path.join(currentGlobalStorage, 'state.vscdb'));
  }

  // 3. 傳統路徑備援
  const appNames = ['Code', 'Code - Insiders'];
  if (process.platform === 'win32' && process.env.APPDATA) {
    for (const app of appNames) {
      candidates.push(path.join(process.env.APPDATA, app, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else if (process.platform === 'darwin') {
    for (const app of appNames) {
      candidates.push(path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage', 'state.vscdb'));
    }
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const app of appNames) {
      candidates.push(path.join(configHome, app, 'User', 'globalStorage', 'state.vscdb'));
    }
  }

  return Array.from(new Set(candidates)).filter((p) => fs.existsSync(p));
}

function getNodeCandidates(): string[] {
  return process.platform === 'win32'
    ? ['node', 'C:\\Program Files\\nodejs\\node.exe']
    : ['node', '/usr/local/bin/node', '/opt/homebrew/bin/node'];
}

async function queryTrustModelFromDb(dbPath: string): Promise<string | null> {
  const queryScript = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'content.trust.model.key'").get();
      if (row && row.value) process.stdout.write(row.value);
    } finally {
      db.close();
    }
  `;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'content.trust.model.key'").get() as { value?: string } | undefined;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    for (const nodeBin of getNodeCandidates()) {
      try {
        const { stdout } = await execFileAsync(nodeBin, ['-e', queryScript, dbPath], {
          timeout: 3000,
          windowsHide: true,
        });
        if (stdout) {
          return stdout;
        }
      } catch {
        // 嘗試下一個候選路徑
      }
    }
    return null;
  }
}

async function writeTrustModelToDb(dbPath: string, newValue: string): Promise<boolean> {
  const writeScript = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    try {
      db.exec('PRAGMA busy_timeout = 3000');
      db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'content.trust.model.key'").run(process.argv[2]);
    } finally {
      db.close();
    }
  `;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA busy_timeout = 3000');
      db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'content.trust.model.key'").run(newValue);
      return true;
    } finally {
      db.close();
    }
  } catch {
    for (const nodeBin of getNodeCandidates()) {
      try {
        await execFileAsync(nodeBin, ['-e', writeScript, dbPath, newValue], {
          timeout: 4000,
          windowsHide: true,
        });
        return true;
      } catch {
        // 嘗試下一個候選路徑
      }
    }
    return false;
  }
}

async function getVsCodeTrustedFolders(): Promise<NormalizedFolder[]> {
  const dbPaths = getVsCodeStateDbPaths();
  const seen = new Set<string>();
  const result: NormalizedFolder[] = [];

  for (const dbPath of dbPaths) {
    const raw = await queryTrustModelFromDb(dbPath);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as {
        uriTrustInfo?: TrustEntry[];
        uriInfo?: TrustEntry[];
      };
      const uriList = Array.isArray(parsed?.uriTrustInfo)
        ? parsed.uriTrustInfo
        : Array.isArray(parsed?.uriInfo)
          ? parsed.uriInfo
          : [];

      for (const item of uriList) {
        if (!item?.trusted) {
          continue;
        }
        const fsPath = extractFsPathFromTrustEntry(item);
        if (!fsPath) {
          continue;
        }
        const normalizedPath = path.normalize(fsPath);
        const key = normalizeKey(normalizedPath);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push({
          name: path.basename(normalizedPath) || normalizedPath,
          path: normalizedPath,
          exists: fs.existsSync(normalizedPath),
          source: 'vscode',
        });
      }
    } catch {
      // 忽略 JSON 解析錯誤
    }
  }

  return result;
}

async function removeFromVsCodeTrustedDbs(targetPath: string): Promise<boolean> {
  const targetKey = normalizeKey(targetPath);
  const dbPaths = getVsCodeStateDbPaths();
  let removedAny = false;

  for (const dbPath of dbPaths) {
    const raw = await queryTrustModelFromDb(dbPath);
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as {
        uriTrustInfo?: TrustEntry[];
        uriInfo?: TrustEntry[];
      };

      let changed = false;
      const filterList = (list?: TrustEntry[]): TrustEntry[] | undefined => {
        if (!Array.isArray(list)) {
          return list;
        }
        const next = list.filter((item) => {
          const fsPath = extractFsPathFromTrustEntry(item);
          if (!fsPath) {
            return true;
          }
          return normalizeKey(fsPath) !== targetKey;
        });
        if (next.length !== list.length) {
          changed = true;
        }
        return next;
      };

      if (Array.isArray(parsed.uriTrustInfo)) {
        parsed.uriTrustInfo = filterList(parsed.uriTrustInfo);
      }
      if (Array.isArray(parsed.uriInfo)) {
        parsed.uriInfo = filterList(parsed.uriInfo);
      }

      if (changed) {
        const ok = await writeTrustModelToDb(dbPath, JSON.stringify(parsed));
        if (ok) {
          removedAny = true;
        }
      }
    } catch {
      // 忽略解析或寫入錯誤
    }
  }

  return removedAny;
}

async function saveFolders(items: FolderConfigItem[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(FOLDERS_KEY, items, vscode.ConfigurationTarget.Global);
}

function toRawConfigList(folders: NormalizedFolder[]): FolderConfigItem[] {
  return folders.map((f) => {
    const defaultName = path.basename(f.path) || f.path;
    return f.name !== defaultName ? { name: f.name, path: f.path } : f.path;
  });
}

async function addFoldersToConfig(newPaths: string[]): Promise<number> {
  const existing = getConfiguredFolders();
  const existingKeys = new Set(existing.map((f) => normalizeKey(f.path)));

  let addedCount = 0;
  for (const rawPath of newPaths) {
    const normalizedPath = path.normalize(rawPath.trim());
    const key = normalizeKey(normalizedPath);
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      existing.push({
        name: path.basename(normalizedPath) || normalizedPath,
        path: normalizedPath,
        exists: fs.existsSync(normalizedPath),
        source: 'custom',
      });
      addedCount++;
    }
  }

  if (addedCount > 0) {
    await saveFolders(toRawConfigList(existing));
  }
  return addedCount;
}

async function removeFolderFromConfig(targetPath: string): Promise<boolean> {
  const existing = getConfiguredFolders();
  const targetKey = normalizeKey(targetPath);
  const filtered = existing.filter((f) => normalizeKey(f.path) !== targetKey);

  if (filtered.length === existing.length) {
    return false;
  }

  await saveFolders(toRawConfigList(filtered));
  return true;
}

async function removeFolderEverywhere(targetPath: string): Promise<boolean> {
  const removedCustom = await removeFolderFromConfig(targetPath);
  const removedVsCode = await removeFromVsCodeTrustedDbs(targetPath);
  return removedCustom || removedVsCode;
}

async function openFolder(folderPath: string, forceNewWindow?: boolean): Promise<void> {
  if (!fs.existsSync(folderPath)) {
    vscode.window.showWarningMessage(`資料夾不存在：${folderPath}`);
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const defaultNewWindow = config.get<boolean>(OPEN_IN_NEW_WINDOW_KEY, false);
  const openInNewWindow = forceNewWindow ?? defaultNewWindow;

  await vscode.commands.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(folderPath),
    { forceNewWindow: openInNewWindow }
  );
}

function addFolderToWorkspace(folderPath: string, folderName: string): void {
  if (!fs.existsSync(folderPath)) {
    vscode.window.showWarningMessage(`資料夾不存在：${folderPath}`);
    return;
  }
  const insertIndex = vscode.workspace.workspaceFolders?.length ?? 0;
  vscode.workspace.updateWorkspaceFolders(insertIndex, 0, {
    uri: vscode.Uri.file(folderPath),
    name: folderName,
  });
}

async function getMergedFolders(): Promise<NormalizedFolder[]> {
  const custom = getConfiguredFolders();
  const vscodeTrusted = await getVsCodeTrustedFolders();
  const seen = new Set(custom.map((f) => normalizeKey(f.path)));

  const merged = [...custom];
  for (const f of vscodeTrusted) {
    const key = normalizeKey(f.path);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(f);
    }
  }
  return merged;
}

async function pickTrustedFolder(): Promise<void> {
  const folders = await getMergedFolders();
  const quickPick = vscode.window.createQuickPick<FolderQuickPickItem>();
  quickPick.placeholder = '選擇要開啟的信任資料夾（支援名稱或路徑搜尋）';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  const newWindowBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('empty-window'),
    tooltip: '在新視窗開啟',
  };
  const addToWorkspaceBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('add'),
    tooltip: '加入目前工作區',
  };
  const removeBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: '刪除（聯動移除信任）',
  };

  const buildItems = (list: NormalizedFolder[]): FolderQuickPickItem[] => {
    if (list.length === 0) {
      return [
        {
          label: '$(plus) 尚未設定任何資料夾，點此瀏覽並加入...',
          action: 'add',
        },
      ];
    }

    return list.map((folder) => ({
      label: `${folder.exists ? '$(folder-active)' : '$(warning)'} ${folder.name}`,
      description: folder.exists
        ? folder.source === 'vscode'
          ? 'VS Code 信任'
          : '自訂清單'
        : '（路徑不存在）',
      detail: folder.path,
      folder,
      buttons: [newWindowBtn, addToWorkspaceBtn, removeBtn],
    }));
  };

  quickPick.items = buildItems(folders);

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected) {
      return;
    }

    quickPick.hide();
    if (selected.action === 'add') {
      await addFolderViaDialog();
      return;
    }

    if (selected.folder) {
      await openFolder(selected.folder.path);
    }
  });

  quickPick.onDidTriggerItemButton(async (event) => {
    const folder = event.item.folder;
    if (!folder) {
      return;
    }

    if (event.button === newWindowBtn) {
      quickPick.hide();
      await openFolder(folder.path, true);
    } else if (event.button === addToWorkspaceBtn) {
      quickPick.hide();
      addFolderToWorkspace(folder.path, folder.name);
    } else if (event.button === removeBtn) {
      const removed = await removeFolderEverywhere(folder.path);
      if (removed) {
        quickPick.items = buildItems(await getMergedFolders());
        await viewProviderRef?.refresh();
        vscode.window.setStatusBarMessage(`已移除信任：${folder.name}`, 3000);
      }
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

async function addCurrentFolders(): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showInformationMessage('目前沒有開啟任何資料夾。');
    return;
  }

  const paths = workspaceFolders.map((wf) => wf.uri.fsPath);
  const added = await addFoldersToConfig(paths);

  if (added > 0) {
    await viewProviderRef?.refresh();
    vscode.window.showInformationMessage(`已將 ${added} 個目前資料夾加入信任清單。`);
  } else {
    vscode.window.showInformationMessage('目前的資料夾已在信任清單中。');
  }
}

async function addFolderViaDialog(): Promise<void> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: '加入信任清單',
  });

  if (!uris || uris.length === 0) {
    return;
  }

  const added = await addFoldersToConfig(uris.map((u) => u.fsPath));
  if (added > 0) {
    await viewProviderRef?.refresh();
    vscode.window.showInformationMessage(`已加入 ${added} 個資料夾到信任清單。`);
  } else {
    vscode.window.showInformationMessage('選擇的資料夾已在信任清單中。');
  }
}

async function removeFolderViaPick(): Promise<void> {
  const folders = await getMergedFolders();
  if (folders.length === 0) {
    vscode.window.showInformationMessage('信任資料夾清單目前是空的。');
    return;
  }

  const selected = await vscode.window.showQuickPick(
    folders.map((f) => ({
      label: f.name,
      detail: f.path,
      folder: f,
    })),
    {
      placeHolder: '選擇要刪除（聯動移除信任）的資料夾',
      matchOnDetail: true,
    }
  );

  if (!selected) {
    return;
  }

  const removed = await removeFolderEverywhere(selected.folder.path);
  if (removed) {
    await viewProviderRef?.refresh();
    vscode.window.showInformationMessage(`已移除信任：${selected.folder.name}`);
  }
}

class TrustedFoldersViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg.type !== 'string') {
        return;
      }

      switch (msg.type) {
        case 'ready':
          await this.refresh();
          break;
        case 'open':
          if (msg.path) {
            await openFolder(msg.path, false);
          }
          break;
        case 'openNewWindow':
          if (msg.path) {
            await openFolder(msg.path, true);
          }
          break;
        case 'addToWorkspace':
          if (msg.path) {
            addFolderToWorkspace(msg.path, msg.name || path.basename(msg.path));
          }
          break;
        case 'revealInExplorer':
          if (msg.path) {
            if (!fs.existsSync(msg.path)) {
              vscode.window.showWarningMessage(`資料夾不存在：${msg.path}`);
              return;
            }
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
          }
          break;
        case 'delete':
          if (msg.path) {
            const label = msg.name || path.basename(msg.path);
            const confirm = await vscode.window.showWarningMessage(
              `確定要刪除「${label}」嗎？這將同時從 VS Code 信任清單移除。`,
              { modal: false },
              '刪除'
            );
            if (confirm === '刪除') {
              const removed = await removeFolderEverywhere(msg.path);
              await this.refresh();
              if (removed) {
                vscode.window.setStatusBarMessage(`已移除信任：${label}`, 3000);
              }
            }
          }
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refresh();
      }
    });
  }

  async refresh(): Promise<void> {
    if (!this._view) {
      return;
    }
    const folders = await getMergedFolders();
    await this._view.webview.postMessage({ type: 'folders', folders });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: transparent;
    user-select: none;
    overflow-x: hidden;
    padding: 4px 0 12px 0;
  }
  .empty {
    padding: 16px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 1.5;
  }
  .folder-list {
    display: flex;
    flex-direction: column;
  }
  .folder-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 7px 10px 7px 12px;
    cursor: pointer;
    position: relative;
    border-radius: 3px;
  }
  .folder-item:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .folder-item.active-menu {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .folder-item.active-menu .folder-path {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.85;
  }
  .icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    color: var(--vscode-icon-foreground);
    opacity: 0.9;
  }
  .icon.missing {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .folder-name {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder-path {
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .missing-tag {
    color: var(--vscode-editorWarning-foreground, #cca700);
    margin-right: 4px;
  }
  .actions {
    display: none;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .folder-item:hover .actions {
    display: flex;
  }
  .action-btn {
    background: transparent;
    border: none;
    color: var(--vscode-icon-foreground);
    width: 22px;
    height: 22px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .action-btn.danger:hover {
    color: var(--vscode-errorForeground, #f48771);
  }
  .context-menu {
    position: fixed;
    z-index: 9999;
    min-width: 170px;
    background: var(--vscode-menu-background, #252526);
    color: var(--vscode-menu-foreground, #cccccc);
    border: 1px solid var(--vscode-menu-border, #454545);
    border-radius: 5px;
    padding: 4px 0;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.36);
    display: none;
  }
  .context-menu.show {
    display: block;
  }
  .menu-item {
    padding: 6px 14px;
    font-size: 12.5px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .menu-item:hover {
    background: var(--vscode-menu-selectionBackground, #04395e);
    color: var(--vscode-menu-selectionForeground, #ffffff);
  }
  .menu-item.danger {
    color: var(--vscode-errorForeground, #f48771);
  }
  .menu-item.danger:hover {
    background: var(--vscode-menu-selectionBackground, #04395e);
    color: #ffffff;
  }
  .menu-sep {
    height: 1px;
    background: var(--vscode-menu-separatorBackground, #454545);
    margin: 4px 0;
  }
</style>
</head>
<body>
  <div id="list" class="folder-list"></div>
  <div id="contextMenu" class="context-menu">
    <div class="menu-item" data-action="open">開啟資料夾</div>
    <div class="menu-item" data-action="openNewWindow">在新視窗開啟</div>
    <div class="menu-item" data-action="addToWorkspace">加入目前工作區</div>
    <div class="menu-item" data-action="revealInExplorer">在檔案總管中顯示</div>
    <div class="menu-sep"></div>
    <div class="menu-item danger" data-action="delete">刪除（移除信任）</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const listEl = document.getElementById('list');
    const menuEl = document.getElementById('contextMenu');
    let currentFolder = null;
    let activeRowEl = null;

    const folderSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10L14.5 3zm-.51 10h-12V3h4.29l.85.85.36.15H14v9z"/></svg>';
    const warnSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.56 1h.88l6.54 12.26-.44.74H1.44L1 13.26 7.56 1zM8 2.28L2.28 13h11.44L8 2.28zM8.625 12v-1h-1.25v1h1.25zm-1.25-2V6h1.25v4h-1.25z"/></svg>';
    const newWinSvg = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M14 2H2v12h12V2zm-1 11H3V5h10v8zm0-9H3V3h10v1z"/></svg>';
    const trashSvg = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M10 3h3v1h-1v9l-1 1H4l-1-1V4H2V3h3V2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1zM9 2H6v1h3V2zM4 13h7V4H4v9zm2-8H5v7h1V5zm1 0h1v7H7V5zm2 0h1v7H9V5z"/></svg>';

    function hideMenu() {
      menuEl.classList.remove('show');
      if (activeRowEl) {
        activeRowEl.classList.remove('active-menu');
        activeRowEl = null;
      }
    }

    function showMenu(x, y, folder, rowEl) {
      hideMenu();
      currentFolder = folder;
      activeRowEl = rowEl;
      rowEl.classList.add('active-menu');
      menuEl.classList.add('show');

      const rect = menuEl.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width - 4;
      const maxY = window.innerHeight - rect.height - 4;
      menuEl.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
      menuEl.style.top = Math.max(4, Math.min(y, maxY)) + 'px';
    }

    document.addEventListener('click', () => hideMenu());
    window.addEventListener('blur', () => hideMenu());
    window.addEventListener('scroll', () => hideMenu(), true);

    menuEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('.menu-item');
      if (!item || !currentFolder) return;
      const action = item.dataset.action;
      vscode.postMessage({ type: action, path: currentFolder.path, name: currentFolder.name });
      hideMenu();
    });

    function render(folders) {
      listEl.innerHTML = '';
      if (!folders || folders.length === 0) {
        listEl.innerHTML = '<div class="empty">目前沒有任何信任資料夾，可點擊上方「+」加入。</div>';
        return;
      }

      for (const folder of folders) {
        const row = document.createElement('div');
        row.className = 'folder-item';
        row.title = folder.path;

        const iconDiv = document.createElement('div');
        iconDiv.className = 'icon' + (folder.exists ? '' : ' missing');
        iconDiv.innerHTML = folder.exists ? folderSvg : warnSvg;

        const infoDiv = document.createElement('div');
        infoDiv.className = 'info';

        const nameDiv = document.createElement('div');
        nameDiv.className = 'folder-name';
        nameDiv.textContent = folder.name;

        const pathDiv = document.createElement('div');
        pathDiv.className = 'folder-path';
        if (!folder.exists) {
          const warnSpan = document.createElement('span');
          warnSpan.className = 'missing-tag';
          warnSpan.textContent = '（路徑不存在）';
          pathDiv.appendChild(warnSpan);
        }
        pathDiv.appendChild(document.createTextNode(folder.path));

        infoDiv.appendChild(nameDiv);
        infoDiv.appendChild(pathDiv);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'actions';

        const openNewBtn = document.createElement('button');
        openNewBtn.className = 'action-btn';
        openNewBtn.title = '在新視窗開啟';
        openNewBtn.innerHTML = newWinSvg;
        openNewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'openNewWindow', path: folder.path, name: folder.name });
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'action-btn danger';
        delBtn.title = '刪除（移除信任）';
        delBtn.innerHTML = trashSvg;
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'delete', path: folder.path, name: folder.name });
        });

        actionsDiv.appendChild(openNewBtn);
        actionsDiv.appendChild(delBtn);

        row.appendChild(iconDiv);
        row.appendChild(infoDiv);
        row.appendChild(actionsDiv);

        row.addEventListener('click', () => {
          hideMenu();
          vscode.postMessage({ type: 'open', path: folder.path, name: folder.name });
        });

        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showMenu(e.clientX, e.clientY, folder, row);
        });

        listEl.appendChild(row);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'folders') {
        render(msg.folders);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;
  const viewProvider = new TrustedFoldersViewProvider();
  viewProviderRef = viewProvider;

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(shield) 信任資料夾';
  statusBarItem.tooltip = '快速選擇信任的資料夾 (Ctrl+Alt+T)';
  statusBarItem.command = 'trustedFoldersPicker.pick';
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.window.registerWebviewViewProvider('trustedFoldersView', viewProvider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        void viewProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('trustedFoldersPicker.pick', pickTrustedFolder),
    vscode.commands.registerCommand('trustedFoldersPicker.refresh', () => viewProvider.refresh()),
    vscode.commands.registerCommand('trustedFoldersPicker.addCurrent', addCurrentFolders),
    vscode.commands.registerCommand('trustedFoldersPicker.addFolder', addFolderViaDialog),
    vscode.commands.registerCommand('trustedFoldersPicker.removeFolder', removeFolderViaPick)
  );
}

export function deactivate(): void {}
