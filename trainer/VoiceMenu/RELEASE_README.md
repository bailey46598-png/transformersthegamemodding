# VoiceMenu 1.0.0 — play your character's voice lines any time

A mod for **Transformers: The Game** (PC, 2007). Press **V** in a level and you get a menu of the dramatic lines your
current character says in the game: taunts, threats, battle cries and victory lines. Press a number and the line
plays, with the game's own speech bubble showing the speaker's head and the subtitle.

## What it does
- **Your character's lines:** playing as Megatron you get Megatron's lines, as Optimus you get Optimus's, and so on.
  Tab lets you browse every other speaker too.
- **Dramatic lines only** by default (134 of the game's 293 voice lines). Mission directions like "head to the
  beacon" are hidden. Set `DramaticOnly=0` in `VoiceMenu.ini` to get them all.
- **The real speech bubble:** the speaker's head and subtitle, on screen for exactly as long as the line plays.
- **Cooldown:** after a line ends you wait 3 seconds before the next one (`Cooldown=` in the INI), so it can't be
  spammed.
- **Random line key:** B plays a random line of your character without opening the menu.

| Speaker | Dramatic lines | | Speaker | Dramatic lines |
|---|---|---|---|---|
| Optimus | 42 | | Barricade | 7 |
| Starscream | 34 | | Blackout | 7 |
| Megatron | 20 | | Frenzy | 2 |
| Ironhide | 13 | | Brawl | 1 |
| Jazz | 8 | | | |

Bumblebee, Bonecrusher and the rest have no voice lines in the game, so their own list is empty (Tab still works).
Lines marked `(?)` have no subtitle in the game, so nobody has checked what they say yet.

## Keys
| Key | Does |
|---|---|
| V | Open / close the menu |
| 1-9 (or numpad) | Play that line on the page |
| 0 or Backspace | Stop |
| [ and ] | Previous / next page |
| Tab | Switch list: your character, then each other speaker |
| B | Random line of your character, no menu |

None of these keys do anything in the game, so the menu never moves your character. Change them in `VoiceMenu.ini`.

## Requirements
- **Transformers: The Game, PC, v1.0.254.2**, running from loose files (an extracted install with `LEVELS\`,
  `AUDIO\` and so on next to `Transformers.exe`).
- **Ultimate ASI Loader** by ThirteenAG, as `dinput8.dll` next to `Transformers.exe`:
  https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases (not included).
- **The game's dialogue files.** The mod plays the game's own voice WAVs and doesn't include them. Most extracted
  installs have them in `AUDIO\_Dialogue\USA`. If yours doesn't, the installer asks for a folder that has them
  (for example another extracted copy of the game).

## Install
1. Unzip anywhere. The `VoiceMenu` folder can also go inside your game folder.
2. Run **Install VoiceMenu.bat**. It finds the game when it's run from inside the game folder, otherwise it asks.
3. If it says your game has no dialogue WAVs, pick a folder that has them when asked.
4. Start the game, load a level and press **V**.

The installer adds `VoiceMenu.asi`, `VoiceMenu.ini`, a `VoiceMenu\` folder and `VoiceMenu_install.txt` (the list of
what it added). It doesn't change any game file. If you already have a `VoiceMenu.ini`, it's kept, and the new
defaults go to `VoiceMenu.ini.new`.

**Uninstall:** run **Uninstall VoiceMenu.bat**. It removes only what the installer added.

## Troubleshooting
The mod writes `VoiceMenu.log` next to `Transformers.exe`.
- **No log at all:** the ASI loader (`dinput8.dll`) is missing.
- **"no voice files found"** on screen, or `voice files found: 0` in the log: the WAVs aren't in
  `AUDIO\_Dialogue\USA` or `VoiceMenu\Lines`. Run the installer again and point it at a folder that has them.
- **"speech bubble unavailable"** in the log: your `Transformers.exe` isn't v1.0.254.2. The lines still play,
  just without the bubble.
- **A line in the wrong list:** edit `VoiceMenu\VoiceLines.txt`. The first column is the speaker; the last column is
  1 (shown) or 0 (hidden when `DramaticOnly=1`).

## Compatibility
- Single player only (the game has no online play).
- Works next to the other ASI mods for this game, including DebugTrainer.
- The voice plays through Windows, not the game's mixer, so it ignores the in-game volume sliders. Use `Volume=`
  in `VoiceMenu.ini` (0-200).

## Source
`source/` has the plugin code (`src/VoiceMenu.cpp`), the build script and `tools/make_voicelines.py`, which builds
the line list from the game's own `SPEECH.INI`, `MUSIC.CFG` and `GUI\STRINGS_BIO.CSV`. Building needs Visual Studio
2022 with the C++ workload and Dear ImGui v1.91.9 in `source\third_party\imgui`.

## Credits
- **Ultimate ASI Loader** by ThirteenAG (required, not included).
- **Dear ImGui** by Omar Cornut, built into the plugin (MIT, see `THIRD_PARTY_IMGUI_LICENSE.txt`).
- **Capstone** disassembler, used to read the game code while building this.
- **Built by** the mod author together with Claude, an AI model by Anthropic, in Claude Code. Claude did the
  reverse engineering and wrote the code; the author tested it in game.
- No AI-generated art or audio: every voice line is the game's own.

## License
The code in `source/` and the installer scripts are MIT licensed (see `LICENSE.txt`). Transformers: The Game and
its voice recordings belong to their owners. You need your own copy of the game.
