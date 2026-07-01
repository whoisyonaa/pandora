!macro customInit
  ReadRegStr $R0 HKEY_CURRENT_USER "Software\d83c978e-aaa7-5e77-b240-ff46883c2521" "InstallLocation"
  StrCmp $R0 "" done_current_user_upgrade
  StrCpy $INSTDIR "$R0"
  DeleteRegKey HKEY_CURRENT_USER "Software\Microsoft\Windows\CurrentVersion\Uninstall\d83c978e-aaa7-5e77-b240-ff46883c2521"

  done_current_user_upgrade:
!macroend
