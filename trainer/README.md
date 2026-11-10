# trainer/

Source code for our trainer / debug tools (C++ ASI source, Visual Studio project files, Cheat Engine `.CT` tables, `.ini` settings).

Built files (`.exe`, `.dll`, `.asi`) are **not** committed. Each of us builds them from source with `build_msvc.bat`.

| Folder | What it is |
|---|---|
| `DebugTrainer` | F1 in-game menu: debug options, level/chapter select, noclip, character select, combat-hub opponents |
| `CharacterCams` | Per-character camera fixes (TripleC, Bonecrusher) + F8 camera dump / F9 physics trace. See `notes/CAMERA_FIX_GUIDE.md` |
| `DamageProbe` | Read-only damage logger (why a character does or doesn't take damage) |
| `TripleCFlightCam` | Old TripleC-only camera fix, replaced by `CharacterCams`. Don't install both. |
