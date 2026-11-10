# DamageProbe (v0.4)

A read-only logger that shows why a character does or doesn't take damage. It was built to find out why
Bonecrusher can't be hurt in robot mode. It changes nothing in the game.

## What it logs (`DamageProbe.log` next to `Transformers.exe`)
| Line | When | What |
|---|---|---|
| `IMPACTA` / `IMPACTB` | an impact (punch, shot, blast) lands near a character | impact type, position, radius, masks; then one line per character body it could hit, with the body's centre, the character's position, the distance from the impact to the body's shape, and the check that lets the hit through or throws it away (`PASSES -> TakeHit`, `skip: IMPACT INSIDE SHAPE`, `skip: category not in impact mask`, ...) |
| `TAKEHIT` | the game's damage function runs | target, impact type, health before -> after, damage multipliers |
| `STATE` | a known character's robot health, multipliers, flags or state changes | the values |
| `MARK` | you press **F7** | a separator line |

**F6** pauses and resumes logging.

Hooks: 0x507460 (impact routine A), 0x507750 (impact routine B), 0x506180 (TakeHit). Each checks the original
bytes first and is skipped (with a log line) if they don't match.

## Test (combat hub)
1. Start `Lab - VehicleJump`, load TestTranquility.
2. Open the trainer (F1) -> Opponents -> Mode **Dummy** (or Fight) -> **Barricade** -> Spawn.
3. Press **F7**. Punch it about 5 times, then shoot it about 5 times, in robot mode. Press **F7**.
4. Clear, then spawn **Bonecrusher**. Press **F7**. Punch 5 times, shoot 5 times (robot mode). Press **F7**.
5. Optional: let Bonecrusher transform to vehicle and hit him again, then **F7**.
6. Quit and send `Lab - VehicleJump\DamageProbe.log`.

**Uninstall:** delete `DamageProbe.asi` and `DamageProbe.log`.

## Build
`build_msvc.bat` (Visual Studio C++ tools, 32-bit).
