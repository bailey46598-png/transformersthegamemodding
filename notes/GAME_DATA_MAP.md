# How Transformers: The Game is put together (data side)

This map comes from reading the extracted data, the 2.0 mod's changes and docs, and the exe.

- **For the exe side** (hooks, addresses, structs), see [RE_NOTES.md](RE_NOTES.md).
- **For the 2.0 mod breakdown**, see [MOD_2.0_DIFF.md](MOD_2.0_DIFF.md).
- **Status labels:** ✅ = seen directly. ❓ = inferred.

## The big picture
- **Content is data, not code.** The exe is the NU2 engine plus a fixed set of systems.
- **Almost everything that makes the game, the game, is plain text the engine reads at load time:**
  - characters, weapons, AI, missions, level setup and the UI
- **Only meshes, scenes, animations and textures are binary** (`.GHG`, `.GSC`, `.AN3`, `.DDS`).

**Proof from the 2.0 mod:** 1,941 files and 946 new ones (new campaigns, characters, dynamic missions, HUD),
with **zero code**.

```
Transformers.exe (NU2 engine)
  ├─ root *.CFG ............ global tables: weapons, projectiles, explosions, impacts, VFX
  ├─ CHARS\ ................ every creature: robot / car / transform-sequence + shared anims & attribs
  ├─ SCRIPTS\*.SCP ......... shared creature AI behaviours (combat, block, drones, vehicles)
  ├─ LEVELS\<LEVEL>\ ....... one folder per level (see below)
  ├─ GUI\*.GUIC, GFX\ ...... UI layout + logic (plain text), textures
  ├─ AUDIO\ ................ AUDIO.CFG, MUSIC.CFG, _DIALOGUE\<LANG>\, _MUSIC\
  ├─ FMV\ .................. Bink videos (binkw32.dll)
  └─ PC\NUCONFIG.TXT ....... key/pad bindings
```

**Retail packaging:**
- The retail game ships `Transformers_Lo.dat` and `Transformers_Hi.dat` archives. These are **Low** and
  **High Detail Mode**.
- The community extracts them with QuickBMS + `ttgames.bms`, and the game runs from the loose files.
- Configs split content per detail level with `PLATFORM CURRGEN … ENDPLATFORM` (Low) and
  `PLATFORM NEXTGEN … ENDPLATFORM` (High). Files ending `_NG` are the High-detail versions.

## Characters (`CHARS\`)
**A playable Transformer is three linked creatures** ✅:

| File | Creature | Holds |
|---|---|---|
| `X.CFG` | `X` | Robot mode. Model (`OBJECT robot.ghg`), `INCLUDE XSharedAnims.cfg` / `XSharedAttribs.cfg`, `TransformingBodyPart` lines that attach gun and melee arms (their own CFGs) |
| `XCAR.CFG` (or `XHELI`, `XVEH`) | `XCar` | Vehicle mode. Model `car.ghg`, `TERRINFO`, mass, idle anim |
| `XTRAN.CFG` | `XTran` | The transform-sequence model `transformer.ghg`, with `DEPENDS xcar` / `DEPENDS x` and the transform anims |
| `XSHAREDATTRIBS.CFG` | — | **The tuning file.** `AnimControl` speeds and timings, `EnableAbility` list, weapons, side and size, jump power, recoil and impact tables, energy |
| `XSHAREDANIMS.CFG` | — | The `ANIMGROUP` / `ANIMENTRY` table that maps anim names to `.AN3` files |

**Keyword handlers:** the top-level creature keywords map to handler functions in the exe's table at
0x6b4920. Examples: `JUMPPOWER`, `MASS`, `ENERGY`, `TRANSFORMMETER`, `SIDE`, `SIZE`, `FLYBACKFORCE`,
`IMPACTVELOCITY`, `PICKEDUPPOSITION` (see RE_NOTES).

**`EnableAbility` = a bitfield in the exe** (type record +0x1B4) ✅:

| Ability | Bit | What it controls |
|---|---|---|
| `Transform` | 0x40 | — |
| `Jump` | 0x4000 | — |
| `Fall` | 0x80000 ❓ | Gates the landing check. Removing `Fall` + `TransformSkid` (the 2.0 "Aerial Transformations" extra) makes the game think you're always grounded, so you can transform in mid-air. |

**Characters are referenced by name, and the set is fixed** ❓:
- The 2.0 mod adds Ratchet by **redefining an existing enemy slot**: `CHARACTER DronePickupTruck_a` with
  Ratchet's model, `Side Autobot`, and Ratchet's anims.
- It doesn't add a new name. The engine, or level scripts, seem to expect known creature names.
- **Swapping a model is a one-line change** (`OBJECT g1_jazz_robot.ghg`).

## Levels (`LEVELS\<NAME>\`)
**Folders:** `TRANQUILITY2`, `CITY`, `INTHECITY`, `HOOVERDAM` / `HOOVEREXT` / `HOOVERINT`, `QATAR`,
`AIRBASE`, `CYBERTRON(DCON)`, `*CITYBOSS`, `BARRICADETRANQUILITY`, `BLACKOUTTRANQUILITY`, `DEMOTRANQUILITY`,
`TESTTRANQUILITY`, `AUTOBONUS1`, `CVIEW`, `FRONTEND`, `STARTSCREEN`, `SUBMISSIONS`.

**Mission codes** in the 2.0 docs: `A1..A7` = Autobot campaign, `D1..D7` = Decepticon campaign,
`C1..C4` = chapters.

| File | Role |
|---|---|
| `LEVEL.CFG` | Level setup: `SCENE`/`DEFAULTSCENE`/`BUILDINGSCENE` (which `.GSC`), `STARTCHAR`, `DEFAULTCHAR robot car tran`, `CREATURE X +car +tran`, `CREATURECACHESIZE_KB` (character memory budget, which the 2.0 author raised to fight crashes), `PEDPERCENTAGE`, `LEVELZONE`, bloom/shadow/fog, unlocks |
| `CREATURES.CFG` | `INCLUDE chars/…` list of every creature loadable in this level, split by `PLATFORM` |
| `PLACEMENTS.INI` | Tagged positions: start points, FMV positions, spawn spots. `Placement { TagString PosX PosY PosZ RotX RotY RotZ Scale }` |
| `PHYSOBJTYPES(_NG).INI` | Every destructible/throwable object type: `GlobalID`, `HoldType` (BOX/POLE/SMALL), `PickupMode`, `DrawDist`, `PinRelease`, `RemovalTime` … |
| `TRIGGERS.INI`, `SPEECH.INI`, `VEHICLESKINS.CFG` | Triggers, dialogue hookup, traffic car skins |
| `*.RN`, `SPLINE.DAT` | Splines: vehicle paths (`VSPLINE`), pedestrian (`PSPLINE`), race (`RSPLINE`), plus named splines used by scripts (spawns, key locations) |
| `*_PC.GSC`, `*.RTL` | Level geometry/scenes and lighting (binary) |
| `AI\*.SCP` + `AI\SCRIPT.TXT` | The level's mission scripts. `SCRIPT.TXT` lists script files ❓ |

## The scripting language (`.SCP`), the biggest modding surface
There are 172 scripts in vanilla. Creature AI (`SCRIPTS\`) and missions (`LEVELS\*\AI\`) use the same
language ✅.

```
state Name
{
    conditions { if <expr> goto OtherState ... }     ; checked every tick
    actions    { Command args ... ; SetState X }       ; run on entry
}
ConditionMacro Name { if ... AND if ... }   CONST Name value   include file   OnMacro ...
```

**Most-used commands:**
- `SendToModule` (≈3,700), `CreateModule` (≈1,180)
- `SetState`, `DestroyAllModules`, `DestroyModule`, `ResetTimer`, `SetDeathPoint`, `SetMusic`
- `IncreasePlayerHealth`, `SetFlag`, `Idle`, `Transform`, `SetStrafe`, `EngageOpponent`, `CarDrive`
- `SetPhysicsState`, `FollowSpline`, `DoAttack`, `SpecialMove`

**Modules** are the engine's built-in mission systems, created by `CreateModule "#Type" "#Name" "#opt=val" …`:

| Group | Modules |
|---|---|
| Characters and speech | `#Speech`, `#Creature`, `#DriverDrone` |
| Flow and timing | `#Timer`, `#AndSwitch`, `#DelayedSend`, `#Goto` |
| Locations and objects | `#KeyLocation`, `#AreaRange`, `#SpecialObj`, `#ProgressPoint`, `#BuildingSecret` |
| Hazards and attacks | `#AAGun`, `#Meteorite`, `#SplineExplode`, `#CreatureBombingRun`, `#AttackWave`, `#AirAttack`, `#BossVehicle`, `#MegatronArm` |
| Mission structure | `#DroneCounter`, `#RaceNodes`, `#VehicleLevels`, `#ActionRing`, `#SubMissions` |
| Camera and level | `#SplineCamera`, `#GABIChange` |

They're queried in conditions, e.g. `if module "SwapToOP InArea" == 1.0`.

**`#General` is the global controller.** Common commands:
- `#ResetAll`
- `#LoadCreature=` / `#UnLoadCreature=`
- `#PlayerType=` / `#RevertPlayerType`
- `#SetPlayer=`
- `#StartMission`, `#CompleteMission`, `#FailMission`
- `#FadeUp` / `#FadeDown`
- `#StartVideo`
- `#SetMessage=` / `#SetMessageTimer=`
- `#AllowPlayerMovement`
- `#SetRadarInterference`
- `#SetVehicle`
- `#SetMaxOpponents`

**Example (2.0 mod):** the character-swap feature is about 90 lines. Four `#AreaRange` rings; entering one
sends `#PlayerType=Jazz` and `#SetPlayer=#CSReset`.

**Known limits** (from the 2.0 author):
- Long on-screen messages can softlock.
- Too many characters loaded (cache), or too many swaps, can crash.
- Some missions are fragile when stressed.

## UI (`GUI\*.GUIC`), also plain text
`FRONTEND.GUIC` is a declarative UI script ✅:

```
Begin Window / Begin List / Begin Button
    Text "LABEL"  or  Text ? GetXText
    Action <exe function> [args]
End
```

**Exe-backed actions include:**
- **Navigation:** `ChangePage`, `RequestChangePage`, `Backout`
- **Debug:** `SetLevelComplete`, `ToggleGodMode`, `ToggleHUD`, `ToggleFlyCamera`, `ToggleAspectRatio`,
  `ToggleCameraInverted`, `ToggleCameraSensitivity`
- **Settings:** `ToggleVibration`, `ToggleSFX`, `ToggleMusic`
- **Debug-option list:** `ToggleDebugOption` with `GetNumDebugOptions` / `GetDebugOptionText`

**The hidden debug menu is unlocked purely by editing this file** (the 2.0 "Enable Debug Mode" extra). It
adds a `DebugOptionsMenu` page with Level Select, Mission Select, God Mode, Fly Camera and the engine's own
debug toggles.

## Where each kind of mod lives
| Want to change | Edit | Code needed? |
|---|---|---|
| Weapon/projectile/explosion stats | root `WEAPONTYPES.CFG`, `PROJECTILETYPES.CFG`, `EXPLOSION.CFG` | No |
| A robot's speed, jump, health, moves | `CHARS\XSHAREDATTRIBS.CFG` | No |
| A robot's model | `OBJECT` line in `X.CFG` / `XCAR.CFG` / arm CFGs | No (a new `.GHG` needs a model tool) |
| Who you play, who spawns, missions | `LEVEL.CFG`, `CREATURES.CFG`, `AI\*.SCP` | No |
| Enemy AI behaviour | `SCRIPTS\*.SCP` | No |
| Menus, debug menu, HUD layout | `GUI\*.GUIC` (+ `GFX\*.DDS`) | No |
| Controls | `PC\NUCONFIG.TXT` | No |
| **New mechanics** (vehicle jump, air steering, new abilities, FPS fix, widescreen) | — | **Yes**: an ASI plugin (see `mods\VehicleJump`) |
