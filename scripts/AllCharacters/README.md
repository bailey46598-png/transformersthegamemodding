# AllCharacters

Makes every Transformer playable in every level, through the DebugTrainer's character select.

## Why it's needed
- Every creature type exists in every level. The type table is built from the master `CHARS\CREATURES.CFG`
  (147 types).
- A level only loads **models** for the creatures in its own `LEVELS\<level>\CREATURES.CFG`. Swapping to a
  type with no model crashes the game (0x44653A). That's why the trainer only offers loaded creatures.
- This mod adds the missing robot families to each level's `CREATURES.CFG`, so the game loads them itself,
  and raises the level's `CREATURECACHESIZE_KB` to fit them.

## What it adds
These 18 families, each as the exact file set the master list uses (robot + vehicle + transform, plus
TripleC's turret):

BumbleBee, BumbleBee07, OptimusPrime, OptimusPrime01, G1OptimusPrime, Barricade, Scorponok, Ironhide,
TripleC, Jazz, Jazz01, Brawl, Blackout, Starscream, Starscream01, BoneCrusher, Megatron, G1Megatron.

Drones and pedestrians are left as each level has them.

**Memory budget:** each level gets `old + 2 × (KB of model and animation files added)`, rounded up to 100 KB.
- For comparison, shipped levels run at 0.7× to 2.6× their creature files on disk. Blackout Tranquility,
  which ships with every robot, runs at 1.65×.
- The result is about 15–22 MB per level, up from 1.5–13.5 MB. Levels load more slowly.

## Use
Run with any Python 3; Blender's bundled Python works too:

```
python make_all_characters.py "<game folder>"            # dry run: prints the plan
python make_all_characters.py "<game folder>" --apply    # edits, with *.allchars.bak backups
python make_all_characters.py "<game folder>" --restore  # undo
```

- **Builds on the files as they are.** Other mods' edits are kept; for example, CITY's Playable Ratchet
  lines and its 8005 budget.
- **Uses its own backup name** (`.allchars.bak`), so it never touches another mod's `.vanilla` files.
- **Re-running gives the same files.** Its block is marked with `; ---- AllCharacters ...` comments.
- `creature_cost.py "<game folder>"` prints each level's creature data and budget.

## Status
- Applied to `Lab - VehicleJump` on 2026-11-07: all 17 levels, 34 backups.
- **Not tested in game.** Risks:
  - running out of memory in a level, from the bigger budget plus the models
  - longer loading
  - a level hitting another creature limit not found yet

  If a level crashes on load, run `--restore` (or restore that level's two `.allchars.bak` files) and report
  which level.
