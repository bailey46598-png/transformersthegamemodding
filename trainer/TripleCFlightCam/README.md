# TripleCFlightCam

Gives TripleC's helicopter form Blackout's flight camera and flight handling. For Transformers: The Game v1.0.254.2, loaded by the
ASI loader (`dinput8.dll`) like the other plugins.

## Install

Needs the ASI loader (`dinput8.dll`) in the game folder. The `.asi` is not in the repo: run `build_msvc.bat` first
(Visual Studio 2022 with "Desktop development with C++"), which makes `build\TripleCFlightCam.asi`. Don't use it
together with `CharacterCams.asi`: both patch the same camera table.

Copy `build\TripleCFlightCam.asi` and `TripleCFlightCam.ini` next to `Transformers.exe`. It writes
`TripleCFlightCam.log` there.

`TripleCFlightCam.ini`:

| Key | Values | Effect |
|---|---|---|
| `RobotCamera` | `Blackout` (default), `Default` | On-foot camera. `Default` = the game's generic camera. |
| `FlightModel` | `Blackout` (default), `Default` | Heli handling. `Default` = the game's AI-gunship handling. |

## Why TripleC's flight camera (and steering) was broken

PlayerCamera::Reset (0x4A1B60) calls 0x49FF10, which picks two camera presets by the player's identity
(`Char+0x5E4`): slot A (`[0x7179E0]`) and slot B (`[0x7184C0]`). The transform code (0x4B86xx) swaps between them.

The switch at 0x4A0D46 only has entries for identities 1–14. TripleC is identity 15 (spawn code 0x4712F3,
vehicle profile 14), so it falls through to the generic default presets, which were never meant for a flyer.

**Measured in game (F8 dumps, 0.3):** in heli flight the active preset is **slot B**. Blackout flies with 0x71AF50,
TripleC with 0x721DE0. (0.1 and 0.2 put Blackout's preset in slot A by mistake, which is the on-foot camera, so the
heli never changed.)

| Active preset in flight | Blackout (0x71AF50) | TripleC before (0x721DE0) |
|---|---|---|
| +0x48 / +0x158 (distance) | 25 | 7.5 |
| +0x4C / +0x50 / +0x54 | 6 / 6 / 6 | −0.3 / −0.8 / −0.61 |
| +0x7C / +0x80 / +0x84 | −9020 / −12288 / 5000 | −3000 / −9000 / −3000 |
| +0x94 / +0xA4 | 20 / 2000 | 2 / 400 |
| +0x130 / +0x134 | 6.6 / 40 | 0.55 / 20 |

The heli's steering reads the active preset too (0x440A3E, 0x441A41, 0x42CA3A read `preset+0x7C`). In the dumps,
Blackout's steer target (aircraft `+0x1C0`) sat ~120 units ahead of him; TripleC's equalled his own position. The
wrong preset broke steering as well as the view.

Identity → presets (slot A on foot / slot B flight): Blackout 10 → 0x71A9A0 / 0x71AF50; TripleC 15 → 0x721B10 /
0x721DE0 (default).

## What the plugin changes

Two same-length patches, applied once the exe's code matches v1.0.254.2:

1. 0x4A0D53: the jump table address → a 15-entry copy in the DLL (entries 0–13 are the originals).
2. 0x4A0D49: the table limit 0xD → 0xE.

Entry 14 (identity 15) runs a 3-instruction stub: slot A = the INI's on-foot choice, slot B = Blackout's flight
preset 0x71AF50, then it continues at 0x4A0E0D like every other case. No other character is affected.

## F8 dump (0.3+)

F8 writes `TripleCFlightCam_dump_id<identity>_<n>.bin` next to the exe: a 32-byte header (`TCFD`, identity, active
profile, aircraft, preset, `+0x52C`, `+0x530`, `+0x5C0`), then the profile (0x80 bytes), aircraft (0xA90) and active
camera preset (0x160).

## Flight model (0.2)

Aircraft setup 0x43F650 sends type 0x20 (TripleC) to 0x41C2C0, the AI gunship handling also used by type 0x13,
and leaves aircraft `+0x368` at 7. Blackout (type 0x21) gets 0x41CD20 and `+0x368 = 8`. The camera trails the
aircraft, so gunship handling makes even Blackout's camera feel wrong.

The plugin replaces `call 0x41C2C0` at 0x43FA18 (TripleC's case only) with a hook that runs the original (so TripleC
keeps its own gun positions, ±2.5 / 1.25 / −1) and then writes Blackout's values:

| Field | Blackout | TripleC (game) |
|---|---|---|
| +0x114 | 3.5 | 3.3 |
| +0x230 / +0x234 / +0x238 | 100 / 50 / 20 | 10 / 5 / 2.5 |
| +0x248 / +0x24C | 0.0002 / 0.005 | 0.001 / 0.0005 |
| +0x254 / +0x258 | 2 / 2 | 1 / 0.5 |
| +0x260 | 134.083 | 0 |
| +0x264 / +0x268 / +0x26C | 71.511 / 40.225 / 1.25 | 223.472 / 8.939 / 0.2 |
| +0x284 | 0.1 | 0.3 |
| +0x368 (mode) | 8 | 7 |

## Build

`build_msvc.bat` (Visual Studio 2022, Desktop development with C++).
