# VoiceMenu - installer (Transformers: The Game, PC, v1.0.254.2)
# Copies VoiceMenu.asi, VoiceMenu.ini and the line list into the game folder, then makes sure the game's own
# dialogue WAVs can be found. Everything it adds is listed in VoiceMenu_install.txt; uninstall.ps1 removes it.
param([string]$GameDir = "", [string]$DialogueDir = "")
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Files = Join-Path (Split-Path -Parent $Here) "files"
$NeedWavs = 293

Add-Type -AssemblyName System.Windows.Forms
function Pick-Folder([string]$what) {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = $what
    if ($dlg.ShowDialog() -ne "OK") { return $null }
    return $dlg.SelectedPath
}
function Find-Game {
    foreach ($c in @((Split-Path -Parent (Split-Path -Parent $Here)), (Get-Location).Path)) {
        if ($c -and (Test-Path (Join-Path $c "Transformers.exe"))) { return $c }
    }
    $p = Pick-Folder "Pick your Transformers: The Game folder (the one with Transformers.exe)"
    if (-not $p) { throw "No game folder picked." }
    return $p
}
# The dialogue WAVs in a folder (or its AUDIO\_Dialogue\USA), by name.
function Wavs-In([string]$dir) {
    if (-not $dir -or -not (Test-Path $dir)) { return @() }
    foreach ($sub in @("", "USA", "AUDIO\_Dialogue\USA", "AUDIO\_Dialogue", "_Dialogue\USA")) {
        $d = if ($sub) { Join-Path $dir $sub } else { $dir }
        if (Test-Path $d) {
            $w = @(Get-ChildItem $d -Filter *.wav -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(a|d)\d|levelintro' })
            if ($w.Count -ge 100) { return $w }
        }
    }
    return @()
}

if (-not $GameDir) { $GameDir = Find-Game }
$GameDir = (Resolve-Path $GameDir).Path
if (-not (Test-Path (Join-Path $GameDir "Transformers.exe"))) { throw "Transformers.exe not found in $GameDir" }
$ManifestPath = Join-Path $GameDir "VoiceMenu_install.txt"
$Manifest = New-Object System.Collections.Generic.List[string]
if (Test-Path $ManifestPath) { $Manifest.AddRange([string[]](Get-Content $ManifestPath)) }
function Note-Created([string]$p) { if (-not $Manifest.Contains("CREATED|$p")) { $Manifest.Add("CREATED|$p") } }

Write-Host "Installing VoiceMenu into $GameDir"
if (-not (Test-Path (Join-Path $GameDir "dinput8.dll"))) {
    Write-Warning "dinput8.dll (Ultimate ASI Loader) not found. VoiceMenu.asi won't load without it. See README."
}

# 1. The plugin. An existing VoiceMenu.ini is kept (your settings); the new one goes next to it as .ini.new.
$dst = Join-Path $GameDir "VoiceMenu.asi"
if (-not (Test-Path $dst)) { Note-Created $dst }
Copy-Item (Join-Path $Files "VoiceMenu.asi") $dst -Force
Write-Host "  VoiceMenu.asi"
$ini = Join-Path $GameDir "VoiceMenu.ini"
if (Test-Path $ini) {
    Copy-Item (Join-Path $Files "VoiceMenu.ini") "$ini.new" -Force
    Note-Created "$ini.new"
    Write-Host "  VoiceMenu.ini kept (the new defaults are in VoiceMenu.ini.new)"
} else {
    Copy-Item (Join-Path $Files "VoiceMenu.ini") $ini
    Note-Created $ini
    Write-Host "  VoiceMenu.ini"
}
$vm = Join-Path $GameDir "VoiceMenu"
if (-not (Test-Path $vm)) { New-Item -ItemType Directory $vm | Out-Null; Note-Created $vm }
$list = Join-Path $vm "VoiceLines.txt"
if (-not (Test-Path $list)) { Note-Created $list }
Copy-Item (Join-Path $Files "VoiceMenu\VoiceLines.txt") $list -Force
Write-Host "  VoiceMenu\VoiceLines.txt"

# 2. The voice files. The mod plays the game's own dialogue; it reads them from AUDIO\_Dialogue\USA when the
#    game has them there, else from VoiceMenu\Lines.
$have = @(Wavs-In (Join-Path $GameDir "AUDIO\_Dialogue\USA")).Count
if ($have -eq 0) { $have = @(Wavs-In (Join-Path $vm "Lines")).Count }
if ($have -ge 100) {
    Write-Host "  Voice files: found $have in your game folder. Nothing to copy."
} else {
    Write-Host ""
    Write-Host "  Your game folder has no dialogue WAVs (AUDIO\_Dialogue\USA is missing)."
    Write-Host "  Pick a folder that has them: another extracted copy of the game, or its AUDIO\_Dialogue\USA folder."
    if (-not $DialogueDir) { $DialogueDir = Pick-Folder "Pick a folder with the game's dialogue WAVs (an extracted game folder, or its AUDIO\_Dialogue\USA)" }
    $src = @(Wavs-In $DialogueDir)
    if ($src.Count -eq 0) {
        Write-Warning "No dialogue WAVs found there. The menu will open but lines won't play until the WAVs are in VoiceMenu\Lines (see README)."
    } else {
        $lines = Join-Path $vm "Lines"
        if (-not (Test-Path $lines)) { New-Item -ItemType Directory $lines | Out-Null; Note-Created $lines }
        foreach ($w in $src) {
            $d = Join-Path $lines $w.Name
            if (-not (Test-Path $d)) { Copy-Item $w.FullName $d; Note-Created $d }
        }
        Write-Host "  Voice files: copied $($src.Count) into VoiceMenu\Lines."
        if ($src.Count -lt $NeedWavs) { Write-Warning "Expected $NeedWavs; lines without a file will say 'Voice file missing'." }
    }
}

$Manifest | Set-Content $ManifestPath
Write-Host ""
Write-Host "Done. Start the game, load a level and press V. Uninstall with 'Uninstall VoiceMenu.bat'."
