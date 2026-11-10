# Vanilla vs the 2.0 mod: what changed and what it teaches

Compared on 2026-11-06 by file hash. Only data files were compared; no game was run.

## Correction: "Build For Testing" is not the full 2.0 mod
| Compared against Fresh Build | Files | New | Changed | Same |
|---|---|---|---|---|
| **Build For Testing** | 6,052 | 40 | 21 | 5,991 |
| **TF_2.0 Main Files** (the full mod) | 1,941 | 946 | 817 | 178 |

- **Build For Testing** has the Demo Tranquility changes plus a few **2.0 Extra Mods** (Playable Ratchet,
  Alt-Gun Optimus, G1 Jazz, Galvatron), and a 1.3 GB `Transformers_Hi.DAT` archive.
- **The full mod has never been merged into a test build.** It lives in `TF_2.0 Mod\TF_2.0 Main Files`.
- **Fresh Build** has a `TransformersDemo.exe` that Build For Testing doesn't have.

## Build For Testing in detail (40 new, 21 changed)
| What | How it's done | Files |
|---|---|---|
| G1 Jazz, Galvatron, Alt-Arm Optimus | New `.GHG` models, plus **one `OBJECT` line** changed per config | `JAZZ01*.CFG`, `G1MEGATRON*.CFG`, `OPTIMUSPRIME01*.CFG` + 14 GHGs |
| Jazz loses melee arm / vehicle weapon | `TransformingBodyPart` lines commented out | `JAZZ01.CFG` |
| Playable Ratchet | **Hijacks the enemy slot `DronePickupTruck_a`**: new model, `Side Autobot`, new anim sets in `CHARS\DLC_RATCHET\`. Ratchet's speeds are written into `DRONEPICKUPTRUCKSHAREDATTRIBS.CFG` (Walk 50→107, Run 100→280, transform 1.0→1.35 s) | 9 CFGs, 2 AN3s, 2 GHGs |
| Demo Tranquility revived | Start as Optimus instead of Bumblebee (`LEVEL.CFG`, hub script). `CREATURES.CFG` **drops the Low-detail pedestrians** to free the creature budget and adds 7 playable bots. +501 placement lines (start, Sam's house, FMV spots). New scripts `CREATURESWAP`, `SUBMISSION_EXTRA`, `ADVANCEDCOMBAT_TUTORIAL`. Rebuilt level scenes (`*.GSC`, about 320 MB) | `LEVELS\DEMOTRANQUILITY\*` |
| Drum platform becomes throwable | `HoldType BOX→POLE`, `PickupMode NEVER→UNPINNEDONLY`, `DrawDist 200→9999`, `PinRelease 0.25→0` | `PHYSOBJTYPES(_NG).INI` |
| Tranquility 2 squad | `#PlayerType=Jazz,Ironhide,OptimusPrime,Jazz` (the 4th slot was Optimus) | `AUTO2HUB.SCP` |

**Not applied:**
- `README_PINK_DARK_DISTORTION.txt` describes a `LEVEL.CFG` visual mod (magenta background, heavy bloom),
  but the `LEVEL.CFG` here doesn't have it.
- `demotranq.zip` is an older backup of the level's scripts.

## The full 2.0 mod (TF_2.0 Main Files)
- **Characters (about 650 new files):**
  - **Per-level character sets**, each a full Transformer set loaded by that level's `CREATURES.CFG`:
    - `DEFAULT_CHARS` (215)
    - `EX_CHARS` (216)
    - `ELITE_CHARS` (68), the "concept-art" elite Decepticon drones
    - `DT_`, `Q_`, `HI_`, `T2_`, `BT_`, `COM_`, `DEFAULTBOSS_`
  - **Reskinned drone families:** Ratchet (70), Towtruck, Pickup, Cement, Forklift, MiG, Armoured Car.
- **Every level:** 93 scripts and 42 INIs changed. This adds "Dynamic Submissions", new waves, bosses,
  checkpoints and crash-avoidance states. Per-level change logs are in `TF_2.0 Documents\Log\`, and
  mission locations are in `Dynamic Submissions Map\`.
- **UI:** 625 GUI textures replaced, `GAME_GLOBAL.GUIC`, and new bios in `STRINGS_BIO.CSV`.
- **Audio/video:** new music and dialogue (`AUDIO\_DIALOGUE\USA` is required regardless of language), and
  edited FMVs.
- **Global tuning:** root `WEAPONTYPES` / `PROJECTILETYPES` / `EXPLOSION` / `IMPACTTYPES` / `MODCRETYPES`,
  and `SCRIPTS\COMBAT.SCP`.
- **Installs on the Low-detail (`_lo.dat`) extraction**, merged over the loose folders.

## Lessons for our own modding
1. **Content mods need no code.** A whole new campaign layer fits in CFG + SCP + INI + GUIC.
2. **Creature names are fixed. Reuse slots instead of adding names.** That's the Ratchet trick. If we
   want truly new characters, a plugin could register names; the parser is the 0x6b4920 table.
3. **The creature budget (`CREATURECACHESIZE_KB`) is the main crash cause.** The author fought it by:
   - dropping pedestrians
   - unloading creatures between chapters
   - adding script states that remove drones when at risk
   - **Plugin idea:** log or raise the budget safely.
4. **Ability flags are powerful but blunt.** Removing `Fall` gives mid-air transforms, but it breaks
   animations. **VehicleJump** is the precise version: a code hook rather than a flag hack. The same
   approach could give clean air transforms without losing the fall animations.
5. **The hidden debug menu is one GUIC edit away.** Fly Camera, Level and Mission Select and God Mode make
   a great testing toolkit for our own mods.
6. **Stability is hardware-dependent and mission-specific** (KnownIssues.txt). Test any big mod in the
   lab with the 60 FPS cap, in both Low and High detail.
