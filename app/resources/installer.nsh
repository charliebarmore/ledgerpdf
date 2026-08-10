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
