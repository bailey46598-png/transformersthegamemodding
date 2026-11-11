# Changelog

## 1.0.0 (2026-11-10)
First release.
- Menu of the current character's voice lines (V), random line key (B), browse other speakers (Tab).
- Dramatic lines only by default (134 of 293); `DramaticOnly=0` shows them all.
- The game's own speech bubble with the speaker's head and subtitle, on screen for as long as the line plays.
- 3 s cooldown after each line (`Cooldown=`, `AllowInterrupt=`).
- Brawl's radio lines, which the game files under Bumblebee, are moved to Brawl with his own head.
- Reads the voice WAVs from the game's `AUDIO\_Dialogue\USA`, or from `VoiceMenu\Lines`; the installer copies
  them there from another folder when the game has none.
