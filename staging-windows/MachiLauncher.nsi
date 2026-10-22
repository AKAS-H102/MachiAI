; Machi Native Windows Desktop Launcher
; Compiles to Machi.exe with NSIS
RequestExecutionLevel user
SilentInstall silent
OutFile "Machi.exe"

Section
  SetOutPath "$EXEDIR"
  ExecShell "" "$EXEDIR\start_machi.bat" "" SW_HIDE
SectionEnd
