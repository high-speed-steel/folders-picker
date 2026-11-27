# Trusted Folders Picker

一個輕量級的 VS Code 擴充套件，自動讀取 VS Code 內建的 **工作區信任（Workspace Trust）** 清單，讓你從左側側邊欄或快速選擇面板一鍵開啟、管理你信任的各個資料夾。

## 功能特色

- **自動同步 VS Code 信任清單**：
  - 自動讀取 VS Code 內建的 Workspace Trust 資料庫（支援新版 `~/.vscode-shared/sharedStorage/state.vscdb` 與舊版 `globalStorage/state.vscdb`），無須手動重複設定。
  - 同時支援自訂清單（`trustedFoldersPicker.folders`），自動合併去重顯示。
- **專屬左側側邊欄視圖**：
  - 左側活動列新增「信任資料夾」盾牌圖示，打開即可一目了然瀏覽所有信任資料夾。
  - 清晰的兩行卡片排版：**粗體資料夾名稱**搭配**下方灰色完整路徑**，不存在的路徑會自動以警告圖示標示。
  - 單擊資料夾即可直接開啟；滑鼠懸停提供「在新視窗開啟」、「刪除（移除信任）」快捷按鈕。
- **右鍵選單與聯動刪除**：
  - 對側邊欄任一資料夾按右鍵可執行：**開啟資料夾**、**在新視窗開啟**、**加入目前工作區**、**在檔案總管中顯示**、**刪除（移除信任）**。
  - 刪除操作會同步從自訂清單與 VS Code 信任資料庫中移除該資料夾的信任紀錄。
- **快速選擇面板與狀態列入口**：
  - 按下 `Ctrl+Alt+T`（macOS 為 `Cmd+Alt+T`）或點擊左下角狀態列 `$(shield) 信任資料夾`，即可開啟支援名稱與路徑模糊搜尋的 QuickPick 面板。

## 指令與快捷鍵

可透過命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）執行：

| 指令 | 說明 | 預設快捷鍵 |
| --- | --- | --- |
| `Trusted Folders: 快速選擇資料夾` | 開啟快速搜尋選擇面板 | `Ctrl+Alt+T` (`Cmd+Alt+T`) |
| `Trusted Folders: 將目前資料夾加入清單` | 將目前開啟的工作區資料夾加入自訂清單 | - |
| `Trusted Folders: 瀏覽並加入資料夾` | 透過系統對話框批次加入資料夾 | - |
| `Trusted Folders: 從清單移除資料夾` | 選擇並聯動移除信任資料夾 | - |
| `重新整理` | 重新讀取信任資料夾清單 | - |

## 設定說明

可在 VS Code 的 `settings.json` 中自訂額外資料夾與預設行為：

```json
{
  "trustedFoldersPicker.openInNewWindow": false,
  "trustedFoldersPicker.folders": [
    "C:\\Projects\\my-app",
    {
      "name": "工作專案（自訂別名）",
      "path": "D:\\Work\\backend-api"
    }
  ]
}
```

- `trustedFoldersPicker.folders`：額外加入的資料夾清單，支援純路徑字串或 `{ name, path }` 物件（可自訂顯示名稱）。
- `trustedFoldersPicker.openInNewWindow`：點擊資料夾時是否預設在新視窗開啟（預設為 `false`）。

## 安裝方式

### 從 VSIX 安裝
1. 下載或打包 `.vsix` 檔案。
2. 在 VS Code 擴充套件面板右上角點擊 **`...`** → **「從 VSIX 安裝...」**，或於終端機執行：
   ```bash
   code --install-extension trusted-folders-picker-0.3.1.vsix
   ```

## 開發與打包

1. 安裝依賴並編譯：
   ```bash
   npm install
   npm run compile
   ```
2. 用 VS Code 直接開啟專案資料夾，按下 **`F5`** 啟動 **Extension Development Host** 進行測試與偵錯。
3. 打包成 `.vsix`：
   ```bash
   npx @vscode/vsce package
   ```
