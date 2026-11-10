# scripts/

Tools we wrote: Python, PowerShell, batch files, QuickBMS `.bms` scripts, Blender scripts.

Scripts should **read the game files from your own install** (pass the game folder as an argument), never bundle them.

## What's here
- `AllCharacters/` – adds every robot family to every level's `CREATURES.CFG`, so the DebugTrainer's
  character select can swap to any robot in any level. Run it without `--apply` first to preview.
- `ChapterSelect/` – adds the chapter states the trainer's chapter select needs.
- `CombatHub/` – sets up the TestTranquility combat hub.
- `tf_studio/` – viewer and level editor.
