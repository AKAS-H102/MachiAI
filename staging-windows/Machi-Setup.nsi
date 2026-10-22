; Machi Personal AI Assistant - Windows Setup Script (NSIS)
; Architecture: Windows x64 Standalone Production Installer

!define PRODUCT_NAME "Machi Assistant"
!define PRODUCT_VERSION "1.5.0"
!define PRODUCT_PUBLISHER "Machi AI"
!define PRODUCT_WEB_SITE "https://machi.ai"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\Machi.exe"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define PRODUCT_UNINST_ROOT_KEY "HKLM"

SetCompressor /SOLID lzma
RequestExecutionLevel admin

Name "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile "../release/Machi-Setup.exe"
InstallDir "$PROGRAMFILES64\MachiAssistant"
InstallDirRegKey HKLM "${PRODUCT_DIR_REGKEY}" ""
ShowInstDetails show
ShowUnInstDetails show

; Interface Settings
!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

; Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Machi.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Machi Assistant now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetOverwrite try

  ; Install bundled standalone production files
  File "Machi.exe"
  File "start_machi.bat"
  File "node.exe"
  File "server.cjs"
  
  SetOutPath "$INSTDIR\dist"
  File /r "dist\*.*"

  SetOutPath "$INSTDIR"

  ; Create Start Menu Shortcuts
  CreateDirectory "$SMPROGRAMS\Machi Assistant"
  CreateShortcut "$SMPROGRAMS\Machi Assistant\Machi.lnk" "$INSTDIR\Machi.exe" "" "$INSTDIR\Machi.exe" 0
  CreateShortcut "$SMPROGRAMS\Machi Assistant\Uninstall.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0

  ; Create Desktop Shortcut
  CreateShortcut "$DESKTOP\Machi Assistant.lnk" "$INSTDIR\Machi.exe" "" "$INSTDIR\Machi.exe" 0

  ; Create Uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Registry Keys for Add/Remove Programs
  WriteRegStr HKLM "${PRODUCT_DIR_REGKEY}" "" "$INSTDIR\Machi.exe"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayName" "$(^Name)"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\Machi.exe"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
SectionEnd

Section Uninstall
  ; Remove shortcuts
  Delete "$DESKTOP\Machi Assistant.lnk"
  Delete "$SMPROGRAMS\Machi Assistant\Machi.lnk"
  Delete "$SMPROGRAMS\Machi Assistant\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Machi Assistant"

  ; Remove installed application files
  Delete "$INSTDIR\Machi.exe"
  Delete "$INSTDIR\start_machi.bat"
  Delete "$INSTDIR\node.exe"
  Delete "$INSTDIR\server.cjs"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR\dist"
  RMDir "$INSTDIR"

  ; Delete Registry Keys
  DeleteRegKey ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}"
  DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"
  SetAutoClose true
SectionEnd
