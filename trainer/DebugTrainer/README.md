# DebugTrainer (v0.2)

> **Setting it up on your own PC (repo version)**
> 1. Install Visual Studio 2022 Community with the **Desktop development with C++** workload.
> 2. Double-click `build_msvc.bat`. It makes `build\DebugTrainer.asi` (the `build` folder isn't uploaded to GitHub).
> 3. Put [Ultimate ASI Loader](https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases) (x86) next to
>    `Transformers.exe` in your **lab copy** of the game, renamed to `dinput8.dll`.
> 4. Copy `build\DebugTrainer.asi` and `DebugTrainer.ini` next to `Transformers.exe`, start the game, press **F1**.
>
> `third_party/imgui` holds only the Dear ImGui v1.91.9 files the build uses (MIT license, see `LICENSE.txt`).
> Paths below like `Lab - VehicleJump` and `mods\...` are from the original author's PC.


> **If some features don't work (greyed out, or "unavailable")**
> - **Chapter select** needs extra states added to the game's level scripts first. With Python 3 (or Blender's Python):
>   `python scripts\ChapterSelect\add_chapter_states.py "<your lab game folder>" --apply`
>   (run it without `--apply` first to preview; `--restore` undoes it).
> - **Opponents (combat hub)** needs `scripts\CombatHub\make_hub.py "<your lab game folder>\LEVELS\TESTTRANQUILITY"`
>   (see `scripts\CombatHub\README.md`; the level also needs a map copied in).
> - **Noclip turns on but you can't move:** close the menu first (F1). While the menu is open, W/A/S/D drive the
>   menu, not the player. Tick Noclip (or press N), close the menu, then fly.
> - **Lots of things greyed out / "code bytes don't match this exe":** your `Transformers.exe` is a
>   different build from the one the trainer was made for (retail v1.0.254.2). Open `DebugTrainer.log` next to
>   `Transformers.exe` and look for `signature mismatch:` lines. Send that log to the other person so the
>   addresses can be checked against your exe.

An in-game Dear ImGui menu for **Transformers: The Game** (PC, 2007, `Transformers.exe` v1.0.254.2 retail).
It exposes the game's own hidden debug menu without editing `FRONTEND.GUIC`. Press **F1** to open or close it.

## What's in the menu
| Section | Items | How it works |
|---|---|---|
| Game debug menu | God mode, Fly camera, HUD, Vibration, Sound effects, Music, Camera sensitivity (cycle), Aspect ratio (toggle) | Calls the same functions the hidden GUIC debug menu calls (`ToggleGodMode`, `ToggleFlyCamera`, ...). Checkboxes show the game's real state. |
| Engine debug options | Draw FPS, Draw player coords, Unlock all, Unlimited ammo, No police response, Disable AI control, Show shields, Slow motion | The game's own `ToggleDebugOption` list. Names are read from the exe. |
| Level and chapter select | Every level, plus each main level's chapters with their in-game titles, "Go" with a confirm box | The game's own `RequestLevel` (the debug menu's LevelSelect). A chapter is applied 3 s after the level loads, like the debug menu's MissionSelect (`MissionMessage` + `SkipLevel`). |
| Noclip | Toggle key (default N, "Change key" rebinds it), W/A/S/D or arrows to move relative to the camera, left mouse up, right mouse down, Shift faster, speed sliders, "Reset to nearest safe spot" | Every frame (from a BeginScene hook, before it is drawn) the player is moved, placed with the game's SetTransform 0x445520 and their velocity zeroed. Movement keys and mouse buttons are hidden from the game while it is on. The reset uses the game's SafeRespawn 0x448AB0 (nearest safe respawn point), or the last spot you stood on the ground in levels without those points. |
| Character select | Every creature this level registered (filters: Transformers only, In this level, name); ones not in memory are loaded through the game's creature cache first, current one marked, "Play as" or double-click | Writes the name into the game's own player-swap request (`0x6FE50C`), the same path the `#PlayerType` script message uses. You keep your position. Cancelled if the game doesn't pick it up within 5 s. |
| Opponents (combat hub) | Mode (Fight, Boss, Dummy, Wave), opponent list, Spawn, Clear, Go to arena | Only in a level whose script has the `Hub*` states from `mods\CombatHub\make_hub.py` (TestTranquility). Loads the opponent through the same mid-level loader as character select, clears the previous one, then switches the script to `Hub<Mode>_<Name>`. The live opponent's model is never freed; the previous one is freed 2.5 s after it's gone. Added in 0.2. Not tested in game yet. |
| Level (experimental) | Complete current level | The game's `SetLevelComplete` action, behind a confirm box. Not tested yet. |
| Player | Character pointer, state id, robot/vehicle, airborne/grounded | Read-only, from `RE_NOTES.md`. |
| Advanced: raw cheat flags | All 32 bits of the flag word `0x6FB268`, known ones named | Direct writes. Unknown bits may crash the game. |
| Trainer settings | Input blocking, text size, save | Writes `DebugTrainer.ini`. |

Not included: Character select can only pick creatures the current level loaded.

## Install
Needs Ultimate ASI Loader as `dinput8.dll` next to `Transformers.exe`. It's already in `Lab - VehicleJump` and
`TF Hoover Dam Edition PC` (both have the trainer installed). Chapter select also needs the hub states from
`mods\ChapterSelectdd_chapter_states.py`.
1. Copy `build\DebugTrainer.asi` and `DebugTrainer.ini` next to `Transformers.exe`.
2. Start the game. "Debug Trainer ready - press F1" shows in the bottom-left corner for 8 seconds.
3. Press **F1**. While it's open, the game gets no keyboard or mouse input.

## Controls
| Key | Action |
|---|---|
| Up / Down arrows | Move between items (the first press shows the highlight) |
| Left / Right arrows | Move between items on the same row |
| Space or Enter | Tick or untick the highlighted box, or press the highlighted button |
| Esc or F1 | Close the menu |
| Mouse | Move the menu's own white arrow cursor; left click, wheel to scroll. Speed: `MouseSpeed` in the INI or the slider. |

The game hides the Windows cursor and its window gets no mouse messages, so the menu draws its own cursor.
A low-level mouse hook (`WH_MOUSE_LL`) moves it, with DirectInput mouse motion as a fallback. While the menu is
open and the game is in front, the hook keeps mouse input from the game. It never blocks the mouse when another
window is in front. Keys are read from the game's own DirectInput keyboard when the window gets no key messages.
Each time the menu closes, the log records which input paths delivered anything.

**Uninstall:** delete `DebugTrainer.asi`, `DebugTrainer.ini`, `DebugTrainer.log` and `DebugTrainer_layout.ini`.

## Settings (`DebugTrainer.ini`)
| Key | Default | Meaning |
|---|---|---|
| `MenuKey` | `F1` | `F1`..`F12`, `INSERT`, `DELETE`, `HOME`, `END`, `PAGEUP`, `PAGEDOWN`, `TILDE`, or a VK code like `0x70` |
| `BlockMenuKeyInGame` | `1` | The game never sees the menu key. F1 is bound to the pad SELECT button in `PC\NUCONFIG.TXT`; the exe only enables SELECT with the `ENABLESELECTBUTTON` dev switch, so nothing is lost. |
| `BlockGameInputWhileOpen` | `1` | The game ignores keyboard and mouse while the menu is open |
| `StartOpen` | `0` | Open the menu on start |
| `ShowStartupNote` | `1` | The 8-second "ready" note |
| `FontScale` | `1.25` | Menu text size |

## How it works
- **Drawing:** a worker thread waits for the game's D3D9 device (the renderer object at `0x2BD90E8` holds
  `IDirect3D9*` at +0 and the device at +4). It then patches that device's vtable: `Present` draws the menu and
  `Reset` keeps ImGui alive across alt-tab.
- **Input:** the window procedure is subclassed for ImGui. DirectInput's `GetDeviceState` / `GetDeviceData`
  are patched (on the shared dinput8 vtables) to blank the game's keyboard and mouse while the menu is open.
  If the game holds the mouse exclusively, the menu cursor is driven from DirectInput's mouse deltas.
- **Safety:** each game function's first 8 bytes are checked against v1.0.254.2 before use. A feature whose
  bytes don't match is greyed out. Game calls and memory reads run under SEH, so a fault is logged in
  `DebugTrainer.log` instead of crashing.
- No hooking library. Only Dear ImGui v1.91.9 (MIT, `third_party\imgui`).

## Build
Run `build_msvc.bat` (Visual Studio 2022 with the C++ workload). The output is `build\DebugTrainer.asi`, 32-bit,
importing only USER32, KERNEL32, SHELL32 and IMM32.

## Status
Built. Installed in `Lab - VehicleJump`. **Not run in the game yet.**
