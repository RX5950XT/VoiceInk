; VoiceInk 的 NSIS 自訂掛勾（electron-builder 會自動 include buildResources 底下的 installer.nsh）
;
; 為什麼需要這一支：
;   更新時 electron-builder 走 keepShortcuts，刻意不重建捷徑（怕把使用者釘選的那顆弄掉）。
;   但更新會把整個安裝資料夾與 VoiceInk.exe 換掉，捷徑 .lnk 裡的 IDList 記著的是舊檔案的
;   時間戳 —— 時間戳對不上，Windows 就解析不到目標，圖示直接退回「一張白紙加捷徑箭頭」。
;   實測：把 .lnk 的 IDList 時間戳改成現在這支 exe 的，同一個檔案的圖示立刻正常。
;   所以每次安裝都把「本來就存在」的那幾份捷徑重寫一次（使用者刪掉的不要自己長回來），
;   重寫後一定要補回 AUMID，否則捷徑跟跑起來的視窗對不起來，工作列會多長一顆。

Var voiceInkPinnedLink

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
  StrCpy $voiceInkPinnedLink "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk"
  !insertmacro voiceInkRefreshShortcut "$voiceInkPinnedLink"

  ; SHCNE_ASSOCCHANGED：叫檔案總管重讀圖示
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
