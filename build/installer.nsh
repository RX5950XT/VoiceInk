; VoiceInk 的 NSIS 自訂掛勾（electron-builder 會自動 include buildResources 底下的 installer.nsh）
;
; 為什麼需要這一支：
;   更新時 electron-builder 走 keepShortcuts，刻意不重建捷徑（怕把使用者釘選的那顆弄掉）。
;   但更新會把整個安裝資料夾與 VoiceInk.exe 換掉，捷徑 .lnk 裡的 IDList 記著的是舊檔案的
;   時間戳 —— 時間戳對不上，Windows 就解析不到目標，圖示直接退回「一張白紙加捷徑箭頭」。
;   實測：把 .lnk 的 IDList 時間戳改成現在這支 exe 的，同一個檔案的圖示立刻正常。
;   所以每次安裝都把「本來就存在」的那幾份捷徑重寫一次（使用者刪掉的不要自己長回來），
;   重寫後一定要補回 AUMID，否則捷徑跟跑起來的視窗對不起來，工作列會多長一顆。

; **這裡不可以宣告 `Var`**：這支 .nsh 會被安裝程式與解除安裝程式各編譯一次，而
; `customInstall` 只插進安裝程式那一份——解除安裝程式那次就變成「宣告了卻沒人用」，
; NSIS 報 warning 6001，electron-builder 把警告當錯誤，`electron:build` 整個失敗
; （症狀是 dist 只剩 `.nsis.7z`，連 `win-unpacked` 都被收走，而且錯誤訊息在很上面）。
; 路徑當字面值傳進 macro 就好——NSIS 的 macro 參數本來就是純文字替換。

!macro voiceInkRefreshShortcut link
  ${if} ${FileExists} "${link}"
    CreateShortCut "${link}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ; 捷徑已存在時 CreateShortCut 會設 error flag，清掉免得後面誤判
    ClearErrors
    WinShell::SetLnkAUMI "${link}" "${APP_ID}"
  ${endIf}
!macroend

!macro customInstall
  !insertmacro voiceInkRefreshShortcut "$newStartMenuLink"
  !insertmacro voiceInkRefreshShortcut "$newDesktopLink"

  ; 工作列顯示的是「已釘選」的那一份，跟開始功能表是兩個不同的檔案
  !insertmacro voiceInkRefreshShortcut "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"

  ; SHCNE_ASSOCCHANGED：叫檔案總管重讀圖示
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
