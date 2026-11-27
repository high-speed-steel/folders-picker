# Trusted Folders Picker

一個輕量級的 VS Code 擴充套件，讓你快速選擇、管理並開啟自己信任的各個資料夾。

## 功能特色

- **快速選擇資料夾**：支援以資料夾名稱或完整路徑進行模糊搜尋。
- **多種開啟方式**：
  - 直接點選：依設定在目前視窗或新視窗開啟。
  - 右側快捷按鈕：可一鍵 **在新視窗開啟**、**加入目前工作區** 或 **從清單移除**。
- **狀態列快捷入口**：左下角狀態列常駐 `$(shield) 信任資料夾` 按鈕，點擊即可開啟清單。
- **快速管理清單**：支援將目前開啟的工作區直接加入清單，或透過系統對話框瀏覽並批次加入資料夾。

## 指令與快捷鍵

可透過命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）執行以下指令：

| 指令 | 說明 | 預設快捷鍵 |
| --- | --- | --- |
| `Trusted Folders: 快速選擇資料夾` | 開啟快速選擇面板 | `Ctrl+Alt+T` (`Cmd+Alt+T`) |
| `Trusted Folders: 將目前資料夾加入清單` | 將目前開啟的資料夾加入清單 | - |
| `Trusted Folders: 瀏覽並加入資料夾` | 開啟資料夾選擇器加入清單 | - |
| `Trusted Folders: 從清單移除資料夾` | 選擇並移除清單中的資料夾 | - |

## 設定說明

可在 VS Code 的 `settings.json` 中設定：

```json
{
  "trustedFoldersPicker.openInNewWindow": false,
  "trustedFoldersPicker.folders": [
    "C:\\Projects\\my-app",
    {
      "name": "工作專案 (別名)",
      "path": "D:\\Work\\backend-api"
    }
  ]
}
```

- `trustedFoldersPicker.folders`：信任資料夾清單，支援純路徑字串或 `{ name, path }` 物件（可自訂顯示名稱）。
- `trustedFoldersPicker.openInNewWindow`：是否預設在新視窗開啟資料夾（預設為 `false`）。

## 開發與打包

1. 用 VS Code 直接開啟 `trusted-folders-picker` 資料夾。
2. 按下 `F5` 即可自動編譯並啟動 **Extension Development Host** 進行測試與偵錯。
3. 若要打包成 `.vsix` 檔案安裝：
   ```powershell
   npm install
   npx @vscode/vsce package
   ```
   接著在 VS Code 擴充套件面板右上角選擇 **「從 VSIX 安裝...」** 即可。
