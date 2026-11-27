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

const CONFIG_SECTION = 'trustedFoldersPicker';
const FOLDERS_KEY = 'folders';
const OPEN_IN_NEW_WINDOW_KEY = 'openInNewWindow';

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
    const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
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

let extensionContextRef: vscode.ExtensionContext | undefined;

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
    // 優先嘗試目前環境的 node:sqlite (VS Code 1.148+ 內建 Node 24 已原生支援)
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
    // 若 VS Code 內建 Node 尚未支援 node:sqlite，改呼叫系統 node
    const nodeCandidates = process.platform === 'win32'
      ? ['node', 'C:\\Program Files\\nodejs\\node.exe']
      : ['node', '/usr/local/bin/node', '/opt/homebrew/bin/node'];

    for (const nodeBin of nodeCandidates) {
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
        uriTrustInfo?: Array<{ uri?: string | { fsPath?: string; external?: string }; trusted?: boolean }>;
        uriInfo?: Array<{ uri?: string | { fsPath?: string; external?: string }; trusted?: boolean }>;
      };
      const uriList = Array.isArray(parsed?.uriTrustInfo)
        ? parsed.uriTrustInfo
        : Array.isArray(parsed?.uriInfo)
          ? parsed.uriInfo
          : [];

      for (const item of uriList) {
        if (!item?.trusted || !item?.uri) {
          continue;
        }
        try {
          let fsPath: string | undefined;
          if (typeof item.uri === 'string') {
            const parsedUri = vscode.Uri.parse(item.uri);
            if (parsedUri.scheme === 'file') {
              fsPath = parsedUri.fsPath;
            }
          } else if (typeof item.uri === 'object') {
            if (item.uri.fsPath) {
              fsPath = item.uri.fsPath;
            } else if (item.uri.external) {
              const parsedUri = vscode.Uri.parse(item.uri.external);
              if (parsedUri.scheme === 'file') {
                fsPath = parsedUri.fsPath;
              }
            }
          }

          if (!fsPath) {
            continue;
          }
          const normalizedPath = path.normalize(fsPath);
          const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
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
        } catch {
          // 忽略無效的 URI
        }
      }
    } catch {
      // 忽略 JSON 解析錯誤
    }
  }

  return result;
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
  const existingKeys = new Set(
    existing.map((f) => (process.platform === 'win32' ? f.path.toLowerCase() : f.path))
  );

  let addedCount = 0;
  for (const rawPath of newPaths) {
    const normalizedPath = path.normalize(rawPath.trim());
    const key = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
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
  const targetKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const filtered = existing.filter((f) => {
    const key = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
    return key !== targetKey;
  });

  if (filtered.length === existing.length) {
    return false;
  }

  await saveFolders(toRawConfigList(filtered));
  return true;
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

async function getMergedFolders(): Promise<NormalizedFolder[]> {
  const custom = getConfiguredFolders();
  const vscodeTrusted = await getVsCodeTrustedFolders();
  const seen = new Set(
    custom.map((f) => (process.platform === 'win32' ? f.path.toLowerCase() : f.path))
  );

  const merged = [...custom];
  for (const f of vscodeTrusted) {
    const key = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
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
    tooltip: '從清單移除',
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
      buttons: folder.source === 'custom' ? [newWindowBtn, addToWorkspaceBtn, removeBtn] : [newWindowBtn, addToWorkspaceBtn],
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
      if (!fs.existsSync(folder.path)) {
        vscode.window.showWarningMessage(`資料夾不存在：${folder.path}`);
        return;
      }
      const insertIndex = vscode.workspace.workspaceFolders?.length ?? 0;
      vscode.workspace.updateWorkspaceFolders(insertIndex, 0, {
        uri: vscode.Uri.file(folder.path),
        name: folder.name,
      });
    } else if (event.button === removeBtn) {
      const removed = await removeFolderFromConfig(folder.path);
      if (removed) {
        quickPick.items = buildItems(getConfiguredFolders());
        vscode.window.setStatusBarMessage(`已移除：${folder.name}`, 3000);
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
    vscode.window.showInformationMessage(`已加入 ${added} 個資料夾到信任清單。`);
  } else {
    vscode.window.showInformationMessage('選擇的資料夾已在信任清單中。');
  }
}

async function removeFolderViaPick(): Promise<void> {
  const folders = getConfiguredFolders();
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
      placeHolder: '選擇要從清單移除的資料夾',
      matchOnDetail: true,
    }
  );

  if (!selected) {
    return;
  }

  const removed = await removeFolderFromConfig(selected.folder.path);
  if (removed) {
    vscode.window.showInformationMessage(`已從清單移除：${selected.folder.name}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContextRef = context;
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(shield) 信任資料夾';
  statusBarItem.tooltip = '快速選擇信任的資料夾 (Ctrl+Alt+T)';
  statusBarItem.command = 'trustedFoldersPicker.pick';
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand('trustedFoldersPicker.pick', pickTrustedFolder),
    vscode.commands.registerCommand('trustedFoldersPicker.addCurrent', addCurrentFolders),
    vscode.commands.registerCommand('trustedFoldersPicker.addFolder', addFolderViaDialog),
    vscode.commands.registerCommand('trustedFoldersPicker.removeFolder', removeFolderViaPick)
  );
}

export function deactivate(): void {}
