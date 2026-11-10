# Transformers: The Game (2007) - Shared Modding Plan

A private, two-person project. We both use Claude Code + Universal Modder.

## Project goal
Learn how this game works and experiment with modding it: data tweaks, new moves and cameras, restored
cut content, and tools of our own. The point is to learn and have fun, not to ship a polished release.

## Current status (2026-11-10)
- **Recon done.** NU2 engine (Traveller's Tales), native 32-bit x86, D3D9, loose data files, no anti-cheat.
- **Mod route works.** Ultimate ASI Loader + our own `.asi` plugins load in the game.
- **Built so far** (source lives in the game folder's `mods/`, not yet moved here): vehicle jump, 7-slot
  level select, per-character cameras, combat test hub, debug trainer, TF Studio viewer/level editor,
  GHG/GSC/PS3/Wii format tools, HooverExt restoration work.
- **Format notes** are in `notes/` (GHG, GSC, CU2, data map, RE notes, and more).
- **Repo just set up.** Mod source code still needs to be reviewed and moved in, one mod at a time.

## Rules we follow
1. **Only our own work goes in this repo:** docs, notes, scripts, trainer source, experiment code.
2. **Never commit game files.** No `.exe`, `.dll`, `.DAT`, `.GHG`, `.GSC`, `.CFG`, textures, audio, video,
   saves, or anything extracted or copied from the game. The `.gitignore` blocks these, but check anyway.
3. **Never commit decompiled code or disassembler databases** (IDA `.idb/.i64`, Ghidra projects). Write what
   you learned in `notes/` in your own words instead.
4. **No built binaries.** Commit source; each of us builds our own `.asi`/`.dll`.
5. **Each of us uses our own legally owned copy of the game.** Scripts take the game folder as an argument.
6. **Test in a lab copy of the game**, never the clean install.
7. **Log every experiment in `MODLOG.md`**, including failures.
8. **Pull before you start, push when you stop**, so we don't overwrite each other.
9. **Before every commit, run `git status`** and read the list of files. If anything looks like game data, stop.

## Next steps
- [ ] Friend clones the repo and sets up their own lab copy of the game.
- [ ] Move mod source code from `mods/` into this repo, one mod at a time, checking each for game data.
- [ ] Move the debug trainer source into `trainer/`.
- [ ] Pick a first shared experiment and log it in `MODLOG.md`.
- [ ] Decide who works on what so we don't edit the same files at once.

---

# Original recon plan (2026-11-06)

# Transformers: The Game (PC, 2007) modding plan

Recon date: 2026-11-06. Nothing in the game folder has been modified. This file is the only thing added.

## Summary
- **Engine:** Traveller's Tales **NU2 / NuTT** engine (Traveller's Tales Oxford, 2007). It is the same family as
  LEGO Star Wars I/II and Bionicle Heroes. `BIONICLE.CFG` is literally the level/car table, left over from the
  Bionicle Heroes codebase.
- **Code:** **native C++, 32-bit x86**. There is no .NET, Mono, Lua VM or other managed layer to patch.
- **Easiest route:** **data mods**. The game reads loose, plain-text config and AI script files from this
  folder, so most gameplay tuning is text editing.
- **Deeper route:** a **native ASI plugin** loaded by a proxy DLL, with hooks found in a disassembler.
- **Existing loaders:** none installed and none exist for this game. There is no anti-cheat and no online play.

## Install facts (measured)
- **Install:** `H:\I hate my fucking life\God Awful Games that I hate that I love and love to hate\Fresh Build`
  (standalone folder, not a store install).
- **Data layout:** already extracted. There are 6,012 loose files (624 MB) and no `.DAT` archive. The
  community norm is to extract the retail `.DAT` files, and the game runs fine from loose files, so this is
  the modding-ready layout.
- **Exe:** `Transformers.exe`, version **1.0.254.2** ("Transformers Main Executable", Activision 2007).
  - PE timestamp 2007-06-06, i386, image base 0x400000, **no ASLR**, not large-address-aware.
  - SHA-256 `5AA3BD490F5B97F614A154FDCA98CAE845BB62C783C48E56042F19AC14AEEFD0`.
  - Build path strings: `c:\projects\transformers\Main.cpp`, `PhysObj.cpp`. The engine strings `nu2_debug` and
    `NUKEY_*` / `NUPAD_*` are NU2 identifiers.
- **Imports:** `d3d9` (Direct3D 9), `d3dx9_31`, `DINPUT8`, `XINPUT1_3`, `DSOUND`, `WINMM`, `binkw32` (Bink
  video, bundled), `WS2_32`, `RPCRT4`, `ole32`, `ADVAPI32` (registry + crypto), `SHELL32`.
- **Anti-cheat / online:** none. It is a single-player offline game.
- **Host:** Windows 11 x64 runs this x86 game natively, so no compatibility layer is needed.
- **Saves / config:** `%USERPROFILE%\Documents\My Games\Activision\Transformers\`. Save files are named
  `SaveGame<N>.Transformers_SavedGame`. That folder does not exist yet on this PC, so the game has not been
  run here or the Documents folder is redirected. Confirm after the first launch.
- **Logs:** none found. The exe has `consolelog`, `CONSOLE` and `_NOCONSOLE` strings, so a debug console or log
  may be switchable. This is unverified.

## ⚠ Gate 0: the exe is a cracked release
The PE header of `Transformers.exe` contains the scene tag `*!RELOADED!*` at file offset 0x358. This is the
RELOADED crack of v1.0.254.2, with the retail SecuROM protection removed. The unnamed sixth PE section fits
that too.

The universal-modder safety rules say to mod from the user's own install and never run an exe that has been
patched past its DRM. Before any work that runs or hooks the game:
1. Install from your own retail disc into a **separate lab folder**.
2. Use that disc's own `Transformers.exe` (plus the official patch, if any).
3. Pin the hash of that exe here. ASI hook signatures must be built against the exe that will be used.

Data-only research (reading the `.CFG` / `.SCP` / `.TXT` files, converting models offline) does not depend on
the exe and can start now. If the retail exe won't start because of SecuROM on Windows 11, record that as a
compatibility issue to solve. Don't work around it by keeping the cracked exe.

## What's moddable, by file type
| Files | Count | Format | Mod by |
|---|---|---|---|
| `*.CFG` (root, `CHARS\*`, `LEVELS\*`) | 410 | **Plain text.** Weapons, projectiles, VFX, explosions, impact types, per-robot attributes, transform/vehicle/arm configs, level and car tables | Text editor |
| `SCRIPTS\*.SCP`, `*.AI2`, `*.RTL` | 172 / 9 / 41 | **Plain-text AI script** (`CONST`, `ConditionMacro`, `if GetFlag ...`) | Text editor |
| `PC\NUCONFIG.TXT` | 1 | Plain-text key, mouse and pad bindings | Text editor |
| `*.DDS` | 2,002 | DirectX textures | Any DDS editor (paint.net, GIMP, Photoshop + NVTT) |
| `*.WAV` | 711 | Audio | Any audio editor (keep the sample rate and channels) |
| `*.GHG` | 174 | NU2 skinned character model | Research needed (see the tools section) |
| `*.GSC` | 12 | NU2 scene / level geometry | Research needed |
| `*.AN3`, `*.CU2`, `*.ATS`, `*.PTL`, `*.PAR` | 2,029 / 189 / 34 / 23 / 13 | Animation, cutscene, texture animation, particles | Binary; reverse engineering needed |
| `*.CFGC` | 1 | `BIONICLE.CFGC`: compiled/expanded text (`BuildingDamage Level N Value N`) | Text, but check what generates it before editing |

Example: `WEAPONTYPES.CFG` holds blocks like `Weapon Tank / Projectile Missile2 / ClipSize 1 / ReloadTime 1.0`.

## Dormant developer features in the exe (strings only, unverified in game)
`DebugOptionsMenu`, `ToggleDebugOption`, `GetNumDebugOptions`, `ToggleGodMode`, `GODMODE`, `ProcessCheats`,
`DebugRadar` / `TT_DEBUGRADAR`, `AIPathDebug`, `CreatureDebug1/2`, `DebugLines`, `consolelog`.

Several are named like script-callable functions, so the debug menu may be reachable from data or a small exe
hook. A community video, "USABLE DEBUG OPTIONS MOD", suggests someone has already exposed it. Finding out how
is a cheap, high-value first target.

## Community route
The scene is small and old, mostly 2008–2015, with no loader or framework.
- **Archive extraction:** QuickBMS + `ttgames.bms` (Luigi Auriemma). It is already done for this folder; it's
  only needed for a fresh retail install. A curated script set is at
  github.com/linterniGamer/Tt-Games-quickbms-scripts. The game runs from extracted files.
- **Textures:** mods on ModDB historically used **TexMod** (runtime injection). Replacing loose `.DDS` files
  directly is simpler now that the data is extracted.
- **Existing mods:** see Nexus Mods (about 11 mods, e.g. a G1 Bumblebee model swap and a high-quality cutscene
  voice mod), ModDB, the TFW2005 thread "My Transformers The Game Mods" (Ultra Magnus, custom missions), the
  "Transformers The Game 2.0" campaign overhaul, and a ROTF music replacement.
  - YouTube playlists from Barricade24 and BL4CK0U7 cover tutorials.
  - PCGamingWiki says LEGO-game (TT) modding guides apply to this game too.
- **Models (`.GHG`):** no tool targets this game specifically. Candidates from the LEGO/TT scene:
  - **TTGames-Workshop** (github.com/stryderjoe/TTGames-Workshop): a Blender importer for CD/GHG/GSC, aimed at
    later LEGO games.
  - The **LEGO Modding Tool** GHG workflow (ExtractPCGHG → PLY → re-import). It can't replace skinned meshes.
  - Noesis plugins.
  - All of these are for newer TT versions. The 2007 GHG revision may differ, so test with one file.
- **Known modern-Windows bug:** robots fail to climb buildings at high frame rates, which can block
  progress. The community workaround is a **60 FPS cap** (RivaTuner or a driver limiter). Some guides say 30.
  This is a candidate for a real fix through an ASI frame limiter.
- **Widescreen / FOV:** no confirmed fix was found (no Flawless Widescreen plugin). This is another candidate
  ASI target.
- **RTX Remix:** listed as not compatible.

## Tools on this machine
- **IDA Free 9.5** is installed. It is not IDA Pro.
  - It disassembles x86 and offers a cloud decompiler, which is fine for manual study of a 32-bit exe.
  - Its install has a `plugins` folder but no `python` folder, so IDAPython and the MCP bridges that rely on
    it are unlikely to work.
  - If you do have IDA Pro elsewhere, point me to it. Agent-driven analysis through `ida-pro-mcp` works there.
- **Not installed:**
  - Ghidra + GhidraMCP, a free alternative for agent-driven analysis.
  - x64dbg (x32dbg for this game) and Cheat Engine, for live memory work.
  - Ultimate ASI Loader.
  - A real Python. `um` was run through Blender 3.6's bundled Python, with placeholder Pillow/PyYAML modules in
    the session scratchpad. Installing `uv` (or Python + `pip install pillow numpy pyyaml`) makes `um` work
    normally.

## Chosen route
1. **Data mods first.** They cover weapon, projectile, AI, robot-stat, VFX, keybinding, texture and audio
   changes with zero code, against the files already extracted here.
2. **Native ASI plugin second**, for anything data can't reach: the debug menu, the frame cap / climbing fix,
   widescreen/FOV, new mechanics.
   - Loader: **Ultimate ASI Loader** (ThirteenAG) as a proxy `dinput8.dll` (the game imports
     `DirectInput8Create`), or `d3d9.dll` / `winmm.dll` as fallbacks.
   - Hooks: MinHook or SafetyHook with x86 `__thiscall` / `__stdcall` care.
   - Addresses: found by byte-pattern scan, even though the exe has no ASLR, so the plugin is robust.
   - Analysis: IDA Free (manual) or Ghidra + MCP (agent-driven), starting from the strings above. For example,
     xrefs to `ToggleGodMode`, `DebugOptionsMenu`, `timeGetTime` and `Direct3DCreate9`.
3. **Model and animation work last.** `.GHG`/`.AN3` editing needs format research proven by an
   unmodified round trip (reverse-engineering skill) before any custom robot.

Pick a specific idea and this plan narrows to one of the routes above.

## Feature 1: jump in vehicle mode
**What the data shows (measured 2026-11-06):**
- Abilities are robot-only.
  - `EnableAbility <name>` lines in `CHARS\*SHAREDATTRIBS.CFG` are checked against a fixed name table in the
    exe (strings at 0x281240–0x2814d4).
  - That table has `Jump`, `DoubleJump`, `StrafeJump` and `JumpSlam`, but **no vehicle ability**. Adding a
    line can't create one.
- Vehicle handling (steering, suspension, nitro, grip) is **not in any data file**. It lives in code (the
  `cVehicles` / `VEHICLEDIRECTTYPE_*` systems), so a real jump button needs a code plugin.
- **There is a dormant transform hop** in every `*SHAREDATTRIBS.CFG`:
  `AnimControl RobotToVehicleJumpTime 0.0` / `RobotToVehicleJumpVelocity 0.0`. It carries the dev comment
  *"PO: DO NOT ENABLE THIS...the car can't be controlled whilst in the air!"*. Its mirror,
  `VehicleToRobotJumpVelocity 11`, is what launches robots upward when they transform out of a car.

**Plan:**
1. **Data experiment (no code).** In a lab copy, set Bumblebee's `RobotToVehicleJumpTime 0.5` and
   `RobotToVehicleJumpVelocity 8`.
   - Expected: transforming into the car launches it upward.
   - This shows whether vehicle physics accepts upward velocity, how it lands, and what "can't be controlled
     in the air" means in practice.
   - It's a cheap preview of the feature and tells us whether air steering needs a hook too.
2. **Reverse engineering (IDA).**
   - Follow the xref from the string `RobotToVehicleJumpVelocity` (0x281b68) to the config parser. That gives
     the field's offset in the creature attribute struct.
   - Then find the code that **reads** that field during a transform. That code applies an upward velocity
     to a creature, which is exactly the primitive needed, and it names the velocity member and the
     "in the air" state.
   - Also find the following:

     | What | Where to look |
     |---|---|
     | The player's per-frame update in vehicle mode | xrefs of `vehicleidle` / `transformintovehicle` |
     | The vehicle "on ground" flag | — |
     | The jump input | The pad button behind `NUPAD_RLEFT` (Space by default, per `PC\NUCONFIG.TXT`). Robot `Jump` reads it; vehicle mode ignores it. |
3. **ASI plugin `VehicleJump.asi`.**
   - Loaded by Ultimate ASI Loader as `dinput8.dll`.
   - Hook the vehicle-mode update with MinHook, matching the calling convention.
   - Logic: **if** the player is in vehicle mode **and** on the ground **and** jump was just pressed, **then**
     set the vertical velocity to the INI value `JumpVelocity`. Add a cooldown, and optionally air steering.
   - Find addresses by byte pattern, and log clearly if a pattern isn't found.
   - INI settings: `JumpVelocity`, `Cooldown`, `AllowAirSteer`, and per-robot on/off.
4. **Verify in game.** Jump on flat ground, off ramps, into walls, mid-chase, and during a transform. Test
   with the 60 FPS cap.
5. **Fallback** if static analysis stalls: in x32dbg or Cheat Engine, find the player's height and vertical
   velocity while driving (a value that changes when falling off a ledge), then "find what writes" it to
   reach the same update function.

Steps 1, 4 and 5 run the game, so they wait on Gate 0 (a retail exe). Step 2 is reading code and can start
now. The game's code is the same in your disc's exe once SecuROM has unpacked it, so the byte patterns carry
over.

## Lab plan
- **Back up first.** `um backup` the whole game folder (624 MB) before any edit, and keep the original files
  untouched.
- **Lab copy.** Work in a separate lab copy of the folder (built from your retail install, per Gate 0). Keep a
  `MODLOG.md` of every changed file.
- **Windowed mode.** Not checked yet. Look for a launcher or registry setting (the exe reads the registry via
  `RegQueryValueExA`) or use dgVoodoo2 / a windowed D3D9 wrapper. This is needed for automated screenshots.
- **Frame cap.** Cap at 60 FPS during all testing to avoid the climbing bug.

## Unknowns to resolve first
1. Do you have a retail disc install, and does its exe run on Windows 11 with SecuROM? (Gate 0)
2. Do the game's settings live in the registry or a file? Where does windowed mode come from?
3. Does the game hot-reload or only read `.CFG`/`.SCP` at level load? Test with one harmless value, such as a
   `ClipSize`.
4. What is `BIONICLE.CFGC`, and is it generated from `BIONICLE.CFG` (edit one, does the other matter)?
5. How is `DebugOptionsMenu` reached? Check that YouTube mod, then xrefs in IDA.
6. Does any TT-scene GHG tool open this game's 2007 GHG revision?
7. Confirm the save folder location after the first launch.

## Knowledge base
`um kb search` (after `um kb sync`, 361 notes) found **no notes** on this game, on Traveller's Tales, on NU2
or on any LEGO game. This would be the first.
- Closest references: `games/tomb-raider-legend/film-reloads-qa-bridge-physics-mags-asi.md` (native x86 ASI)
  and `games/star-wars-the-force-unleashed/ronin-engine-modding-surface.md` (dinput8 loader, dormant dev
  features).
- Write a field note (`um kb new`) once something is verified in game.

## Sources
- PCGamingWiki: https://www.pcgamingwiki.com/wiki/Transformers:_The_Game
- Nexus Mods: https://www.nexusmods.com/games/transformersthegame/mods
- ModDB: https://www.moddb.com/games/transformers-the-game/mods
- TFW2005 thread: https://www.tfw2005.com/boards/threads/my-transformers-the-game-mods-w-download-links.1107192/
- Debug options mod video: https://www.youtube.com/watch?v=BkwobdKzzQA
- QuickBMS (ttgames.bms): https://aluigi.altervista.org/quickbms.htm
- TT QuickBMS scripts: https://github.com/linterniGamer/Tt-Games-quickbms-scripts
- DAT archive RE project: https://github.com/IsaMorphic/DATOneArchiver
- TTGames-Workshop: https://github.com/stryderjoe/TTGames-Workshop
- LEGO Modding Tool GHG wiki: https://github-wiki-see.page/m/AlubJ/LEGO-Modding-Tool/wiki/Mesh-Importing
- Climbing bug / FPS cap thread: https://www.seibertron.com/energonpub/is-there-a-fix-for-transformers-the-game-on-windows-10-t114665.php
