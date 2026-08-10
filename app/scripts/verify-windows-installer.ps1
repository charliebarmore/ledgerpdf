param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
  throw 'Windows installer verification must run on Windows.'
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\LedgerPDF'
$appExe = Join-Path $installDir 'LedgerPDF.exe'
$uninstaller = Join-Path $installDir 'Uninstall LedgerPDF.exe'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Get-PropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [object]$InputObject,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Get-LedgerPdfUninstallEntries {
  if (-not (Test-Path -LiteralPath $uninstallRoot)) {
    return @()
  }

  return @(
    Get-ChildItem -LiteralPath $uninstallRoot | ForEach-Object {
      Get-ItemProperty -LiteralPath $_.PSPath
    } | Where-Object {
      $displayName = Get-PropertyValue -InputObject $_ -Name 'DisplayName'
      $location = Get-PropertyValue -InputObject $_ -Name 'InstallLocation'
      $publisher = Get-PropertyValue -InputObject $_ -Name 'Publisher'
      $uninstallString = Get-PropertyValue -InputObject $_ -Name 'UninstallString'
      $displayName -like 'LedgerPDF*' -or
      $location -eq $installDir -or
      ($publisher -eq 'Ledger Labs LLC' -and $uninstallString -like '*LedgerPDF*')
    }
  )
}

function Write-UninstallEntryDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Entry
  )

  $fields = @(
    'DisplayName',
    'Publisher',
    'InstallLocation',
    'UninstallString',
    'QuietUninstallString',
    'DisplayVersion'
  )
  Write-Host "Installed Apps registry key: $($Entry.PSPath)"
  foreach ($field in $fields) {
    $value = Get-PropertyValue -InputObject $Entry -Name $field
    if ([string]::IsNullOrWhiteSpace([string]$value)) {
      $value = '<missing>'
    }
    Write-Host "  ${field}: $value"
  }
}

function Wait-For {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Description,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Condition,
    [int]$TimeoutSeconds = 30
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Timed out waiting for $Description."
}

if (Test-Path -LiteralPath $installDir) {
  throw "Installer test requires a clean machine, but the install directory exists: $installDir"
}
if (@(Get-LedgerPdfUninstallEntries).Count -ne 0) {
  throw 'Installer test requires a clean machine, but a LedgerPDF uninstall entry already exists.'
}

$installed = $false
try {
  $install = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser') -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "Installer exited with code $($install.ExitCode)."
  }
  $installed = $true

  Wait-For 'the installed application and uninstaller' {
    (Test-Path -LiteralPath $appExe) -and (Test-Path -LiteralPath $uninstaller)
  }
  Wait-For 'the Windows Installed Apps registry entry' {
    @(Get-LedgerPdfUninstallEntries).Count -eq 1
  }

  $entries = @(Get-LedgerPdfUninstallEntries)
  $entry = $entries[0]
  Write-UninstallEntryDiagnostics -Entry $entry
  $displayName = Get-PropertyValue -InputObject $entry -Name 'DisplayName'
  $publisher = Get-PropertyValue -InputObject $entry -Name 'Publisher'
  $location = Get-PropertyValue -InputObject $entry -Name 'InstallLocation'
  $uninstallString = Get-PropertyValue -InputObject $entry -Name 'UninstallString'
  if ($displayName -notlike 'LedgerPDF*') {
    throw "Unexpected DisplayName: $displayName"
  }
  if ($publisher -ne 'Ledger Labs LLC') {
    throw "Unexpected Publisher: $publisher"
  }
  if ([string]::IsNullOrWhiteSpace([string]$location)) {
    throw 'Installed Apps entry is missing InstallLocation.'
  }
  if (-not [string]::Equals(
      [IO.Path]::GetFullPath([string]$location),
      [IO.Path]::GetFullPath($installDir),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Unexpected InstallLocation: $location"
  }
  if ([string]$uninstallString -notlike "*$uninstaller*") {
    throw "UninstallString does not name the installed uninstaller: $uninstallString"
  }

  Write-Host 'Installed Apps registration metadata verified.'
}
finally {
  if ($installed -and (Test-Path -LiteralPath $uninstaller)) {
    $remove = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -Wait -PassThru
    if ($remove.ExitCode -ne 0) {
      throw "Uninstaller exited with code $($remove.ExitCode)."
    }
  }
}

Wait-For 'the application and Installed Apps entry to be removed' {
  -not (Test-Path -LiteralPath $appExe) -and @(Get-LedgerPdfUninstallEntries).Count -eq 0
}

Write-Host 'Windows installer registration and uninstall lifecycle: OK'
