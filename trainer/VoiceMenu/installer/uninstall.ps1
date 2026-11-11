# VoiceMenu - uninstaller. Removes only what install.ps1 added (listed in VoiceMenu_install.txt), plus the log.
param([string]$GameDir = "")
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $GameDir) {
    foreach ($c in @((Split-Path -Parent (Split-Path -Parent $Here)), (Get-Location).Path)) {
        if ($c -and (Test-Path (Join-Path $c "VoiceMenu_install.txt"))) { $GameDir = $c; break }
    }
}
if (-not $GameDir) {
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Pick the game folder VoiceMenu is installed in"
    if ($dlg.ShowDialog() -ne "OK") { throw "No game folder picked." }
    $GameDir = $dlg.SelectedPath
}
$ManifestPath = Join-Path $GameDir "VoiceMenu_install.txt"
if (-not (Test-Path $ManifestPath)) { throw "VoiceMenu isn't installed in $GameDir (no VoiceMenu_install.txt)." }

$entries = @(Get-Content $ManifestPath | Where-Object { $_ -like "CREATED|*" } | ForEach-Object { $_.Substring(8) })
# Files first, then folders (deepest first), and a folder only if it's empty.
foreach ($p in $entries) { if (Test-Path $p -PathType Leaf) { Remove-Item $p -Force } }
foreach ($p in ($entries | Sort-Object Length -Descending)) {
    if ((Test-Path $p -PathType Container) -and -not (Get-ChildItem $p -Force)) { Remove-Item $p -Force }
}
foreach ($f in @("VoiceMenu.log")) { $p = Join-Path $GameDir $f; if (Test-Path $p) { Remove-Item $p -Force } }
Remove-Item $ManifestPath -Force
Write-Host "VoiceMenu removed from $GameDir."
