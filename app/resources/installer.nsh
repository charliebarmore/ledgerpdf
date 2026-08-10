; electron-builder's assisted NSIS page decides whether this is an upgrade from
; its install-location registry values alone. Reconcile those flags with the
; filesystem before the page is rendered so a stale value cannot tell a new
; user that LedgerPDF is already installed.
;
; This hook does not delete or rewrite registry state. It only controls the
; install-mode page's description; the normal installer owns cleanup and the
; actual install/upgrade path.
!macro customInstallMode
  StrCpy $hasPerUserInstallation "0"
  StrCpy $perUserInstallationFolder ""
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    StrCpy $hasPerUserInstallation "1"
    StrCpy $perUserInstallationFolder "$0"
  ${EndIf}

  StrCpy $hasPerMachineInstallation "0"
  StrCpy $perMachineInstallationFolder ""
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
    StrCpy $hasPerMachineInstallation "1"
    StrCpy $perMachineInstallationFolder "$0"
  ${EndIf}
!macroend

; electron-builder records InstallLocation in its private installation key but
; does not add the same value to Windows' Installed Apps entry. Add it here,
; then verify the minimum metadata Windows needs to present a normal uninstall
; experience. SHELL_CONTEXT follows the selected install mode: HKCU for the
; default per-user install and HKLM for an explicitly selected all-users install.
;
; Fail closed if any required value is missing. A successful installer must not
; leave LedgerPDF on disk without a discoverable uninstaller.
!macro customInstall
  ClearErrors
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  ReadRegStr $3 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayName
  ReadRegStr $4 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $5 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString

  ${If} ${Errors}
  ${OrIf} $3 == ""
  ${OrIf} $4 == ""
  ${OrIf} $5 == ""
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "LedgerPDF could not register its Windows uninstaller. Installation was stopped; please report this to LedgerPDF support."
    ${EndIf}
    SetErrorLevel 1
    Abort
  ${EndIf}
!macroend
