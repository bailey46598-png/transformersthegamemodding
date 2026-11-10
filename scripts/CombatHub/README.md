# Combat hub (TestTranquility)

TestTranquility becomes a testing arena where you can spawn any character as an opponent from the
DebugTrainer menu. It's for testing combat and special-ability changes as they're added.

## Parts
| Part | What it does |
|---|---|
| `make_hub.py` | Writes the hub into the level folder (default: the lab's `LEVELS\TESTTRANQUILITY`). Keeps the originals once as `*.hub.bak`; running it again gives the same files |
| Level script `AI\LEVEL.SCP` | One state per opponent and mode (`HubFight_Brawl`, `HubDummy_Megatron`, ...) plus `HubClear`, `HubGoArena` and `HubIdle`. Start and death respawn go to `HubArena` |
| `PLACEMENTS.INI` | `HubArena` placement: the baseball field (−5, 14, 250) |
| `SPLINE.DAT` | `HubSpawn` spline: opponents appear at (−5, 14.6, 315), facing the arena |
| DebugTrainer 0.2, **Opponents** panel | Lists every opponent the hub script knows. **Spawn** loads the character if needed, clears the previous opponent, then fires the state. Also has **Clear** and **Go to arena** |

Opponents are every whole character in the level's `CREATURES.CFG`, skipping vehicle, transform and arm
parts and pedestrians. Today that's 33: every robot, the G1 and alternate versions, Ratchet and all the drones.
**To add one:** add its `INCLUDE` to `CREATURES.CFG`, then re-run `make_hub.py`.

## Modes
| Mode | Script flags |
|---|---|
| Fight | `#Script=Combat`: normal combat AI |
| Boss | `#Script=Combat #Boss`: the flag the story's boss fights use |
| Dummy | `#Script=StandAndWait`: stands still, a target for testing moves |
| Wave | 3 at once, combat AI |

Every mode adds `#ForcePlayerAsOpp`, as Megatron's boss fight does, so the opponent fights you even when it's
on your side.

## Run
```
"C:\Program Files\Blender Foundation\Blender 3.6\3.6\python\bin\python.exe" make_hub.py
```
- `--check` shows what it would write without changing anything.
- `--modes=Fight,Dummy` writes fewer states, if the game has trouble with 138 of them. The largest shipped
  script has 65.

## Undo
Copy each `*.hub.bak` over its file (`AI\LEVEL.SCP`, `PLACEMENTS.INI`, `SPLINE.DAT`).
