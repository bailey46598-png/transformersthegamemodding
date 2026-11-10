# ChapterSelect

Adds a jump-in state per chapter to each level hub script, so the DebugTrainer's chapter select can start any
chapter.

## Why
- The exe's chapter table is an unfinished stub: every level has 1 chapter called "WorkInProgress".
- Each hub's `state SkipLevel` fades out and then waits for `message "MissionMessage" == N`. No way was found
  to set the message it reads.
- So this adds `state TrainerChapter1`–`4` to each hub. Each does what the hub does when you drive into that
  chapter's action ring: the hub's own `GlobalStartChapter` actions, then `ChapterN_Enter` (intro, the
  chapter's creatures, then the mission). The trainer switches to them by name.

## Use
```
python add_chapter_states.py "<game folder>"            # dry run
python add_chapter_states.py "<game folder>" --apply    # edits hubs, with *.chapters.bak backups
python add_chapter_states.py "<game folder>" --restore  # undo
```
- Hubs: the 10 levels with chapters (AutoCityBoss, Cybertron and CybertronDcon have none).
- The added block is marked `; ---- ChapterSelect ...`.
- Re-running gives the same files.

## Status
Applied to `Lab - VehicleJump` on 2026-11-08. Not tested in game.
