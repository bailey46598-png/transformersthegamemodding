# Hoover Dam Edition (TF 2.0) → PC standalone: port notes (2026-11-07)

- **Output:** `..\TF Hoover Dam Edition PC\`. It's Fresh Build + TF_2.0 Main Files + the HDE port.
  - `README_HDE_PC.txt` is the player readme.
  - `HDE_PORT_LOG.txt` lists every change.
  - `_hde_port_backup\` holds every overwritten original.
- **Sources:**
  - `C:\Users\skeet\Desktop\TF claude\Hoover Dam Edition - PS3` (next-gen, used for the port).
  - `TF_2.0 Hoover Dam Edition` (the Wii build: wbfs/iso, Dolphin texture pack).
- **Tools:** `mods\hde_port\`.
  - `port_text.py`: text port + bundle → BIONICLE.CFG.
  - `msf2wav.py`: PS3 PS-ADPCM → wav.
  - `check_refs.py`, `check_music.py`.

## What I learned about the mod
- **PS3 reads the flattened `BIONICLE.CFGC`.** That file is the mod's real config. The loose PS3 `BIONICLE.CFG` is stale.
  The PC exe reads `Bionicle.cfg` (with INCLUDE), so the flattened bundle works as the PC BIONICLE.CFG.
- **The two "map settings" bundles** differ only in the NEXTGEN scene list. Low detail = `SCENE HooverExt` (the converted map).
- **The mod re-uses menu level slots** (BIONICLE level blocks with PATH levels/hooverExt and DATAPATH = the new folder):

  | Slot | Becomes |
  |---|---|
  | demoTranquility | AutoPrologue |
  | hooverInt | AutoComplete |
  | qatar | DconPrologue |
  | barricadeTranquility | hooverDam |
  | airBase | DconComplete |
  | city, inthecity, bosses, cybertron | Empty |

- **`LEVELS\HOOVEREXT\AI\AI.PAK`** (magic 0x1234567A, 0x1C B entries `{id, name, data, size, align}`) holds the ORIGINAL dev scripts.
  The loose .SCP files are the mod's. The PC reads loose scripts.
- **Script check:** every action and #command in the mod's scripts exists in the PC exe or the module scripts.
- **PS3 `.GUIC` and `.GUI`** are text in the same format as PC. GAME_FRONTEND is identical. GAME_GLOBAL only changes HUD portraits (applied).
- **PS3 audio** is MSF codec 3 (PS-ADPCM, 48 kHz). PC uses 16-bit PCM wav at 22,050 Hz.
- **The vanilla PC game falls back to `DEFAULTSCENE`** when NEXTGEN scenes are missing (Tranquility works that way). That's why
  vanilla Hoover crashed: its DEFAULTSCENE file was missing too.

## Menu (fixed after test 1: Hoover Dam missing from the menu, vanilla levels shown)
- **Cause:** the level tiles and labels are in `GUI\frontend.guic` (compiled menu) and `GUI\STRINGS_BIO.CSV` (UTF-16 string
  table, the changelog's "StringBios"). Neither was ported at first.
- **Fix (`mods\hde_port\port_menu.py`):**
  - The PS3 `frontend.guic` becomes the PC `FRONTEND.GUIC`. It adds HooverExtImage/HooverDamImage tiles and drops the
    BonusGallery/BonusMovies/G1Characters menus.
  - The strings are merged line by line. PS3 rows replace PC rows by label; PC-only rows and the header are kept.
- **Pictures:** the PC menu's picture files aren't loose in this folder, for the PC menu and the PS3 one alike. The PC game
  works anyway, so missing menu pictures are tolerated.

## Menu crash (test 2) fixed
- **Crash:** `c0000005` at 0x48A5FF. The front end builds `"%sImage"` from each level name (e.g. `airBaseImage`), finds the
  Image block, and dereferences its texture without checking it. The PS3 menu's `Begin Image pc` blocks point at
  PS3-only placeholders (`DECEPTICONSHIELD_BG_PS3`) or textures PC lacks (`HooverExt`, `HooverDam`). So the texture is null
  and the game crashes.
- **Fix:** `mods\hde_port\fix_menu_images.py` repoints each PC image to an existing PC texture.
  - Airbase uses DECEPTICONSHIELD_BG.
  - The HooverExt tile uses SCREEN_HOOVER_EXTERNAL; the HooverDam tile uses SCREEN_HOOVER_DAM.
- **Rule:** every `pc` image File in a menu must exist as `GUI\...\<name>_PC.DDS`.

## Not done
- **The PS3 high-detail scenes:** `HOOVEREXT_MAIN/BUILDINGS/VEHICLES/POS_PS3.GSC`, NU20 **version 0**, BE.
  Container: u32 NU20 offset, u32 count, then (offset, size) texture pairs. Its chunks aren't 16-aligned.
- **Wii-only features** (Brawl, Evil Bee creature swap).
- **Map props, transparency and texture animation** (see WII_HOOVEREXT_NOTES.md).
- **Not play-tested.**
