# VoiceMenu 0.3

An in-game menu of your character's voice lines. Playing as Megatron, press **V** and you get every line Megatron
speaks in the game; press a number to play one, any time.

## Keys (change them in `VoiceMenu.ini`)
| Key | Does |
|---|---|
| V | Open / close the menu |
| 1-9 (or numpad) | Play that line on the page |
| 0 or Backspace | Stop |
| [ and ] | Previous / next page |
| Tab | Switch list: your character, then each other speaker, then back |
| B | Play a random line of your character without opening the menu |

Each line shows the game's own **speech bubble** with the speaker's head and subtitle, like a mission line. The bubble stays up exactly as long as the voice line plays, and closes if you stop the line.
A **cooldown** (3 s after a line ends, `Cooldown=`) stops spamming; the menu shows "Ready in" while it runs.

All of these are keys the game doesn't bind, so the menu never moves your character. It takes no mouse input.

## Dramatic lines only (default)
`DramaticOnly=1` shows only taunts, threats, battle cries and victory lines: 134 of the 293. Mission
directions, briefings and hints are hidden. The generator judges each line from its subtitle text
(`GUI\STRINGS_BIO.CSV`). Lines with no subtitle are mid-fight lines, so they're kept and marked `(?)`, because
nobody has listened to them yet. Change any line with the last column of `VoiceLines.txt`.

| Speaker | Dramatic | Unchecked `(?)` |
|---|---|---|
| Optimus | 42 | 17 |
| Starscream | 34 | 14 |
| Megatron | 20 | 12 |
| Ironhide | 13 | 10 |
| Jazz | 8 | 0 |
| Barricade | 7 | 5 |
| Blackout | 7 | 0 |
| Frenzy | 2 | 0 |
| Brawl | 1 | 0 |

**Brawl fix:** the game files Brawl's six calls for backup (Decepticon 3, chapter 4) under Bumblebee, because
the SPEECH.INI parser has no "Brawl" name. VoiceMenu moves them to Brawl and gives them his own head.

## All lines per character (`DramaticOnly=0`)
Built from the game's own `SPEECH.INI` (each line names its speaker) and `MUSIC.CFG`:

| Speaker | Lines | | Speaker | Lines |
|---|---|---|---|---|
| Optimus | 129 (21 guessed) | | Frenzy | 9 |
| Starscream | 73 | | Blackout | 8 |
| Megatron | 27 | | Brawl | 6 (moved from Bumblebee) |
| Jazz | 17 | | Other | 1 |
| Ironhide | 14 | | Bumblebee | 0 |
| Barricade | 9 | | | |

- **Guessed lines** (marked `(?)` in the menu) only play as music overlays, so no file says who speaks them. They
  get the speaker of the rest of their mission chapter.
- **Missing speakers:** Bumblebee, Bonecrusher and the others have no dialogue in the game. Their list is empty; Tab
  still lets them browse everyone else's.
- **Not included:** cutscene dialogue. It's baked into the Bink videos with music and effects.

## Install
Needs Ultimate ASI Loader (`dinput8.dll`) next to `Transformers.exe`.
1. Copy `build\VoiceMenu.asi` and `VoiceMenu.ini` next to `Transformers.exe`.
2. Run the generator to copy the WAVs and the list into `<game>\VoiceMenu\`:
   ```
   python tools\make_voicelines.py "<retail extract>" "<retail extract>\AUDIO\_Dialogue\USA" --copy "<game>"
   ```
   The WAVs come from your own retail extract (`Decompiled Shit game\AUDIO\_Dialogue\USA`, 293 files, 148 MB).
   Fresh Build has no dialogue WAVs at all.

**Uninstall:** delete `VoiceMenu.asi`, `VoiceMenu.ini`, `VoiceMenu.log` and the `VoiceMenu` folder.

## Files
| File | What |
|---|---|
| `src/VoiceMenu.cpp` | The ASI. Present hook (vtable patch, chains with DebugTrainer), ImGui overlay, PlaySound playback |
| `tools/make_voicelines.py` | Builds `data/VoiceLines.txt` and copies the WAVs |
| `data/VoiceLines.txt` | The line list: speaker, wav, subtitle id, label, unchecked, head, dramatic. Safe to edit by hand |
| `build_msvc.bat` | Build (uses `..\DebugTrainer\third_party\imgui`) |

## How it works
- **Character:** `[0x770614]` (player) → `+0x518` type record → `+0` name. A speaker matches when its name is in
  the character name (Megatron matches G1Megatron), or through `[Aliases]` in the INI.
- **Subtitles:** calls the game's `Localize` (0x65EBA0) with the line's text id, after a byte check. Lines the
  game has no text for show only their label.
- **Speech bubble:** `HUD(0x713630)->ShowSpeech(head, text, seconds, 0)` at 0x492EB0, the call the game's
  own Speech::Play (0x4AAD90) makes. Byte-checked; skipped when the HUD isn't built (front end). Text is the
  game's own string (the bubble keeps the pointer); lines with no subtitle show the head with an empty box.
- **Sound:** plays through Windows (`PlaySound`), not the game's sound engine. So it isn't positional, doesn't
  duck the music, and ignores the game's volume sliders (use `Volume=` instead).

## Status
- **0.1:** menu, character match and playback work in game (user-tested 2026-11-10).
- **0.2:** dramatic filter, speech bubble, cooldown, Brawl fix. Built and installed in `Lab - VehicleJump`.
  **Not run in game yet.** `VoiceMenu.log` should say `loaded 293 lines (134 dramatic)` and
  `speech bubble available`.
- **0.2 in game:** bubble shows, but always closes after 3 s (user report).
- **0.3:** bubble lasts as long as the line. ShowSpeech's setup (0x48FFB0) hardcodes the time left on screen
  (widget `[[0x713630+0x18]+0x10]` +0x14) to 3.0; the mod writes the line's time left there every frame while it
  plays (so pausing doesn't desync it), and 0 when the line ends or is stopped. It stops touching the bubble as
  soon as the widget's text (+0x20) isn't ours. Built and installed. **Not run in game yet.**
