# CharacterCams

Per-character camera fixes for Transformers: The Game v1.0.254.2, loaded by the ASI loader (`dinput8.dll`).
Replaces `TripleCFlightCam.asi`: both patch the same camera table, so **only install one** (rename the old one to
`.disabled`). TripleCFlightCam's source and notes are in `trainer/TripleCFlightCam`.

## Install

Run `build_msvc.bat` first (Visual Studio 2022, "Desktop development with C++"); the `.asi` isn't in the repo.
Copy `build\CharacterCams.asi` and `CharacterCams.ini` next to `Transformers.exe`. It writes `CharacterCams.log`.

The F8 / F9 debug keys, and how to use them to fix other characters (drones, ...), are in
`notes/CAMERA_FIX_GUIDE.md`.

## What it fixes

| Character | Fix |
|---|---|
| TripleC (Shockwave), identity 15 | Blackout's flight camera, on-foot camera and heli handling (see `trainer/TripleCFlightCam/README.md`). Confirmed working in game. |
| Bonecrusher, identity 14 | Car camera sized for the Buffalo (the game's truck camera, fixed up), a camera ray that ignores his own body, a working R (front) view. Still being tuned. |

## INI

More keys (near/far distance, pitch, handling, wheels, camera ray) are described in the comments in `CharacterCams.ini`, which is the up-to-date list.

| Section / key | Default | Effect |
|---|---|---|
| `[TripleC] RobotCamera` | `Blackout` | On-foot camera; `Default` = the game's generic one |
| `[TripleC] FlightModel` | `Blackout` | Heli handling; `Default` = the game's AI-gunship handling |
| `[Bonecrusher] CarCamera` | `Truck` | `Truck` = the big-vehicle camera fixed up, `Bumblebee` = Bumblebee's resized, `Default` = untouched (0x7219B0) |
| `[Bonecrusher] CarDistance` | `12` | Camera distance; Bumblebee uses 7.5 |
| `[Bonecrusher] CarHeight` | `0` | Added to the preset's height offsets (+0x4C/+0x50/+0x54) |
| `[Bonecrusher] RView` | `On` | `Off` = the game's R view |
| `[Bonecrusher] RViewHeight` / `RViewForward` | `2` / `10` | R camera height and distance in front of his centre |

## How the camera picks work

- **Car / heli / on-foot presets:** PlayerCamera::Reset 0x4A1B60 → 0x49FF10 switches on identity (`Char+0x5E4` − 1)
  at 0x4A0D46. Each case sets slot A `[0x7179E0]` (on foot) and slot B `[0x7184C0]` (vehicle). Measured with F8 dumps.
- **Bonecrusher (identity 14)** used slot B 0x7219B0, the big-vehicle preset shared with Brawl (2) and Ironhide (7). Its
  base distance is 7.5, the same as Bumblebee's 0x721DE0, on a vehicle twice as long (9.5 vs 4.9) and 3.5× as tall.
  The plugin's identity-14 case copies Bumblebee's preset into the DLL at every reset (0x721DE0 is re-initialised at
  0x49FF26 first), sets the distance fields (+0x40/+0x44/+0x128/+0x12C live, +0x48/+0x158 base) and adds the height,
  then uses it as slot B. Slot A stays 0x71AC80.
- **R view (0x4B8B3F):** sets camera `+0x2AC` bit 0x200 and puts the camera in front of the vehicle, looking back.
  Height (`[esp+0x34]`) and forward (`[esp+0x38]`) come from byte table 0x4B8F38 (index = vehicle profile, profile+8)
  into jump table 0x4B8F20:

  | Profile | Vehicle | Height / forward |
  |---|---|---|
  | 0, 26 | Optimus, ? | 1.5 / 9 |
  | 1, 2 | Bumblebee, BB07 | 1 / 5 |
  | 3 | Jazz | 0.5 / 4 |
  | 5 | Ironhide | 1 / 6.5 |
  | 9 | Barricade | 0.4 / 5 |
  | everything else (Bonecrusher = 12) | | **0 / −2.5** (fallback: behind his own front, inside the body) |

  The plugin moves the jump table to a 7-entry copy (0x4B8C22) and sets profile 12's byte to the new case.

## F8 dump

F8 writes `CharacterCams_dump_id<identity>_<n>[_R].bin` (header `TCF2`, 16 u32: identity, profile, aircraft, preset,
`+0x52C`, `+0x530`, `+0x5C0`, car, player camera, render camera, R held), then the profile (0x80), aircraft (0xA90),
active preset (0x160), car (0x7F0), player camera `[0x770610]` (0x400), render camera `[0x77060C]` (0x100).

## Build

`build_msvc.bat` (Visual Studio 2022, Desktop development with C++).
