// game.h: addresses in Transformers.exe v1.0.254.2 (retail, image base 0x400000, no ASLR).
// Found by static reading of the retail lab exe; see the "Debug trainer" section of RE_NOTES.md.
#pragma once
#include <cstdint>

namespace game {

// ---------------------------------------------------------------- render
constexpr uintptr_t kRenderer      = 0x2BD90E8;  // renderer object: +0 IDirect3D9*, +4 IDirect3DDevice9*
constexpr uintptr_t kDevicePtr     = kRenderer + 4;
constexpr uintptr_t kRendererInit  = 0x5E4460;  // calls Direct3DCreate9, stores into kRenderer

// ---------------------------------------------------------------- debug-menu globals
// Cheat/flag word. Written by the GUI debug actions, the debug option list and the command-line parser.
constexpr uintptr_t kCheatFlags    = 0x6FB268;
constexpr uintptr_t kHudOn         = 0x713658;   // byte; ToggleHUD flips it
constexpr uintptr_t kFlyCamera     = 0x77079C;   // dword 0/1; ToggleFlyCamera flips it
constexpr uintptr_t kOptionsObj    = 0x7705D0;   // game options object (`this` for the option calls)
constexpr uintptr_t kDebugOptMask  = kOptionsObj + 0x60;  // bit i = debug option i (menu's own copy)
constexpr uintptr_t kCamSens       = 0x7707A4;   // camera sensitivity setting, cycles 0..2
constexpr uintptr_t kAspectFlags   = 0x77074C;   // byte; (value & 0x18) != 0 = the other aspect ratio
constexpr uintptr_t kDebugOptNames = 0x6B93E0;   // const char* [8], e.g. "1. Draw FPS "
constexpr int       kNumDebugOpts  = 8;

// Cheat flag bits (kCheatFlags)
constexpr uint32_t kFlagGodMode    = 0x2;
constexpr uint32_t kFlagVibration  = 0x4;       // set = on (the NOVIBRATION switch clears it)
constexpr uint32_t kFlagSfxOff     = 0x800;
constexpr uint32_t kFlagMusicOff   = 0x1000;    // ToggleMusic sets music volume to 0 when this is set
// Debug option i toggles this bit (jump table at 0x50D464)
constexpr uint32_t kDebugOptBits[kNumDebugOpts] = {0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x8000};

// ---------------------------------------------------------------- GUI action handlers
// The FRONTEND.GUIC "Action" names map to these. All are plain cdecl functions with no arguments
// unless noted. Registration table: 0x49C9xx (push handler / push name / call 0x6056D0).
constexpr uintptr_t kToggleGodMode     = 0x47A350;
constexpr uintptr_t kToggleHUD         = 0x47A2B0;
constexpr uintptr_t kToggleFlyCamera   = 0x47A6D0;
constexpr uintptr_t kToggleVibration   = 0x47A9A0;
constexpr uintptr_t kToggleSFX         = 0x47A400;
constexpr uintptr_t kToggleMusic       = 0x47A4B0;
constexpr uintptr_t kToggleCamSens     = 0x48C440;
constexpr uintptr_t kToggleAspect      = 0x47A580;
constexpr uintptr_t kSetLevelComplete  = 0x499F80;  // also asks the GUI for page "DebugOptionsMenu" (no-op if missing)
constexpr uintptr_t kDebugOptToggle    = 0x50D370;  // void __thiscall Options::ToggleDebugOption(int i), ret 4
constexpr uintptr_t kDebugOptIsOn      = 0x50D490;  // bool __thiscall Options::IsDebugOptionOn(int i), ret 4

typedef void (__cdecl* VoidFn)();
typedef void (__thiscall* ToggleOptFn)(void* self, int i);

// ---------------------------------------------------------------- player (from RE_NOTES.md)
constexpr uintptr_t kPlayerPtr  = 0x770614;
constexpr uint32_t  kStateId    = 0x5C8;
constexpr uint32_t  kFlags628   = 0x628;
constexpr uint32_t  kFlagVehicle  = 1u << 18;
constexpr uint32_t  kFlagAirborne = 1u << 21;
constexpr uint32_t  kFlagGrounded = 1u << 24;

// ---------------------------------------------------------------- creatures + player swap
// Creature type table: every type the level's CREATURES.CFG included (robots, their Car/Tran parts, drones,
// pedestrians). Array of record pointers; count at +0x258. Filled by the CFG parser 0x408390.
constexpr uintptr_t kCreatureTable  = 0x6FDE90;
constexpr uintptr_t kCreatureCount  = kCreatureTable + 0x258;
constexpr int       kMaxCreatures   = 150;
constexpr uint32_t  kTypeName       = 0x000;  // const char* (initialised to "default", set by the CFG's name)
constexpr uint32_t  kTypeAbilities  = 0x1B4;  // EnableAbility bitfield
constexpr uint32_t  kAbilityTransform = 0x40;
constexpr uint32_t  kTypeRecord     = 0x518;  // Char instance -> its type record
// Loaded model of the type. 0x40B1A0 clears it for every type when a level loads; only creatures the level
// actually loads get it back (0x40AF30, 0x40B8DA). Spawning a type with no model leaves Char+0x51C null and
// crashes at 0x44653A, so a type is only offered when this is set and its part count (word +0xC) isn't 0
// (the same test 0x5364A0 makes).
constexpr uint32_t  kTypeModel      = 0x690;
constexpr uint32_t  kModelParts     = 0x00C;  // uint16
// Measured in game (creature dumps, 2026-11-07): every creature the level's CREATURES.CFG includes gets a
// model entry (+0x690 set) but its parts stay 0 until the creature cache loads it. The cache keeps the
// LEVEL.CFG "CREATURE x +car +tran" types (levelinfo +0xC14 list, fixed 35-slot array at +0xDC, no bounds
// check) plus whatever is spawned. So: +0x690 set = registered in this level, parts != 0 = resident.
//
// LoadCreature (0x43A170, __thiscall on the type table, ret 4): what level load calls for each LEVEL.CFG
// CREATURE name. Finds the type, picks a cache priority (0x40000 / 0x300000 / 0x100000 for drones), asks the
// creature cache at table+0x264 to load it (0x40B460), then walks dependent types. Already resident: adds a
// reference (0x40B4A0).
constexpr uintptr_t kLoadCreature   = 0x43A170;
typedef void (__thiscall* LoadCreatureFn)(void* table, const char* name);
// Don't call LoadCreature directly mid-level: outside the game's loading job it sits on the loading screen
// forever (seen in game). Mid-level loads go through the swapper's queue, as the script "#LoadCreature=X"
// does (0x50D7D0 with deferred = true):
//   QueueLoad (0x40BB00, __thiscall on the swapper 0x6FE480, ret 4): copies the name (max 31 chars) into the
//   string pool 0x6F9B60 + 32*[0x6FAFAC] and appends it to swapper+0xC (count +4, 16 slots, no bounds check).
//   Next frame 0x473010 sees the queue, shows the loading screen (0x511080(2)), and runs the job 0x43A3B0 ->
//   0x43A310, which loads each name with LoadCreature, then 0x40BC00 clears the busy bytes.
constexpr uintptr_t kQueueLoad      = 0x40BB00;
constexpr uintptr_t kSwapperBusy    = 0x6FE480;  // swapper +0: byte, set while the load job runs
constexpr uintptr_t kQueueLoadCount = 0x6FE484;  // swapper +4
constexpr uintptr_t kQueueFreeCount = 0x6FE488;  // swapper +8
typedef void (__thiscall* QueueLoadFn)(void* swapper, const char* name);
// QueueFree (0x40BB50): same as QueueLoad, but appends to the unload list at swapper+0x4C (count +8). The job
// runs unloads first (0x425FC0 per name), then loads. Used by the script's deferred unload (0x50D830).
// Each character the trainer loads stays in the creature cache until freed; without freeing, a few swaps
// fill the cache and the next model load gets no memory and crashes (0x65D204 pointer fix-up on a null
// buffer, 0x534F9A).
constexpr uintptr_t kQueueFree      = 0x40BB50;
// Distinct instructions inside each (the first bytes of both are identical).
constexpr uintptr_t kQueueLoadStore = 0x40BB30;  // mov eax,[ecx+4]; mov [ecx+eax*4+0xC],edx
constexpr uintptr_t kQueueFreeStore = 0x40BB80;  // mov eax,[ecx+8]; mov [ecx+eax*4+0x4C],edx

// Player swapper object. Each frame the game runs 0x4730A0 -> 0x473010, which (when nothing is loading)
// calls SwapPlayer 0x472F20. That reads the request at +0x8C (a creature name), looks it up with
// FindCreatureType 0x40AE90, removes the old player, spawns the new type at the old player's transform,
// stores it in [0x770614] and the level's player-type slot ([0x7183A8]+0xC4, so respawns keep it), then
// clears the request. The script message "#PlayerType=X" ends up here too.
constexpr uintptr_t kSwapper        = 0x6FE480;
constexpr uintptr_t kSwapRequest    = kSwapper + 0x8C;  // const char*; must stay valid (it's kept for respawn)
constexpr uintptr_t kSwapPlayer     = 0x472F20;
constexpr uintptr_t kSwapPoll       = 0x4730A0;
constexpr uintptr_t kFindCreatureType = 0x40AE90;

// ---------------------------------------------------------------- levels + chapters
// Level manager: every level the game knows (BIONICLE.CFG table). [mgr+4] = count, [mgr+0x10+4i] = name.
constexpr uintptr_t kLevelMgrPtr   = 0x71872C;
constexpr uintptr_t kLevelInfoPtr  = 0x7183A8;   // current level info: +0 name, +8 folder
// RequestLevel(name) (0x4B8F60, cdecl): looks the name up (0x4A3EB0), sets the pending level [0x6FB284] and
// a 0.7 s fade [0x6FB27C]; the main loop then loads it. What the debug menu's LevelSelect action calls.
constexpr uintptr_t kRequestLevel  = 0x4B8F60;
constexpr uintptr_t kPendingLevel  = 0x6FB284;
// Chapter table (filled at start-up): 14 main levels, 0x1C bytes each:
// +0 name, +4 chapter count, +8 const char* text ids[count], +0xC level title text id.
constexpr uintptr_t kChapterTable  = 0x713730;
constexpr int       kChapterLevels = 14;
constexpr uint32_t  kChapterStride = 0x1C;
constexpr uintptr_t kLocalize      = 0x65EBA0;   // const char* __cdecl Localize(const char* id)
// Chapter select, as the debug menu's MissionSelect (0x499FB0) does it:
//   SendScriptMessage([[0x6F5700]+0x1A0], "MissionMessage", (float)chapter, 0)      0x54C3A0
//   then for the script slot (8 slots of 0xC4 at mgr+0xC) whose script ([slot+4], name at +8) is "Level1":
//   FireEvent(slot, FindEvent("SkipLevel", [slot+4]))                               0x53C850 / 0x53B4D0
constexpr uintptr_t kScriptMgrPtr  = 0x6F5700;
constexpr uintptr_t kSendScriptMsg = 0x54C3A0;
constexpr uintptr_t kFindEvent     = 0x53B4D0;
constexpr uintptr_t kFireEvent     = 0x53C850;
typedef int  (__cdecl* RequestLevelFn)(const char* name);
typedef const char* (__cdecl* LocalizeFn)(const char* id);
typedef void (__cdecl* SendScriptMsgFn)(uintptr_t target, const char* msg, float value, int flags);
// 0x54C3A0 is really SetScriptVar: it calls FindScriptVar (0x547330(obj, name, flags), which finds or creates
// the named entry in obj's list at +0x10) and stores the value at entry+0x28. "if message X == N" in a script
// reads such a value. The game's mission-end code (0x4BF536) sets MissionMessage = 1 or 2 on [[0x6F5700]+0x1A0].
constexpr uintptr_t kFindScriptVar = 0x547330;
typedef uintptr_t (__cdecl* FindScriptVarFn)(uintptr_t obj, const char* name, int flags);
typedef int  (__cdecl* FindEventFn)(const char* name, uintptr_t script);
typedef void (__cdecl* FireEventFn)(uintptr_t slot, int event);

// Camera reset. SwapPlayer (0x472F20) leaves the player camera's follow state as it was, so after a swap the
// camera stays where the old character was. When the game teleports the player (0x4E90C1 → 0x46B900) it
// resets the camera with:
//   [0x770610]->vtable[0x3C]()   slot 15 = PlayerCamera::Reset 0x4A1B60 (default distances 40/15/5, copies
//                                the default camera table 0x721DE0 → 0x71A830, clears follow state)
//   0x4A1C30()                   turns the active camera controller [0x71848C] to face the player's heading
// [0x770610] is the player camera object (vtable 0x68AE78; also [0x7186EC], constructed at 0x4AE6F0).
constexpr uintptr_t kPlayerCamPtr   = 0x770610;
constexpr uintptr_t kPlayerCamVtbl  = 0x68AE78;
constexpr uintptr_t kCamReset       = 0x4A1B60;
constexpr uintptr_t kCamFaceHeading = 0x4A1C30;
typedef void (__thiscall* CamResetFn)(void* cam);

// ---------------------------------------------------------------- noclip + safe reset
// Character transform. GetMatrix returns the active body's 4x4 world matrix (position at [12..14]); GetPos
// returns its position (vec4). SetTransform places the character (what SwapPlayer and the respawns use:
// SetTransform(&matrix, 1, 0)). GetActiveBody returns the robot or vehicle body; its velocity vec4 is at
// [[body+0x34]+0x20], with a copy at char+0x810 (see RE_NOTES / VehicleJump).
constexpr uintptr_t kGetMatrix     = 0x4453D0;  // const float* __thiscall(char), ret
constexpr uintptr_t kGetPos        = 0x445460;  // const float* __thiscall(char), ret
constexpr uintptr_t kSetTransform  = 0x445520;  // void __thiscall(char, const float* m, int, int), ret 0xC
constexpr uintptr_t kGetActiveBody = 0x437AA0;  // void* __thiscall(char), ret
constexpr uint32_t  kBodyState     = 0x34;
constexpr uint32_t  kBodyVel       = 0x20;
constexpr uint32_t  kVelCopy       = 0x810;
constexpr uintptr_t kFrameDt       = 0x7183BC;  // float, seconds
// SafeRespawn (0x448AB0, __thiscall(char, float pos[4], float dir[4]), ret 8): finds the level's
// "SafeRespawn" spline (point pairs: position, then a point it faces) and writes the pair nearest the
// character on the ground plane. Returns false if the level has none. The player-respawn code (0x46D37A)
// uses it for the player.
constexpr uintptr_t kSafeRespawn   = 0x448AB0;
// Render camera: [0x77060C] -> +0xC 4x4 world matrix, position at +0x30 (the fly camera reads it there).
constexpr uintptr_t kRenderCamPtr  = 0x77060C;
typedef const float* (__thiscall* GetMatrixFn)(void* chr);
typedef void (__thiscall* SetTransformFn)(void* chr, const float* m, int a, int b);
typedef void* (__thiscall* GetActiveBodyFn)(void* chr);
typedef bool (__thiscall* SafeRespawnFn)(void* chr, float* pos, float* dir);

// ---------------------------------------------------------------- byte signatures
// Expected first bytes of each function in v1.0.254.2. A feature is only offered if its bytes match.
struct Sig { uintptr_t addr; uint8_t bytes[8]; int len; const char* name; };
const Sig kSigs[] = {
    {kRendererInit,     {0x51, 0x53, 0x56, 0x57, 0x6A, 0x20, 0x8B, 0xF1}, 8, "RendererInit"},
    {kToggleGodMode,    {0xA1, 0x68, 0xB2, 0x6F, 0x00, 0x8B, 0xC8, 0xF7}, 8, "ToggleGodMode"},
    {kToggleHUD,        {0xA0, 0x58, 0x36, 0x71, 0x00, 0x84, 0xC0, 0x0F}, 8, "ToggleHUD"},
    {kToggleFlyCamera,  {0x8B, 0x0D, 0x9C, 0x07, 0x77, 0x00, 0x33, 0xC0}, 8, "ToggleFlyCamera"},
    {kToggleVibration,  {0xA1, 0x68, 0xB2, 0x6F, 0x00, 0x8B, 0xC8, 0xF7}, 8, "ToggleVibration"},
    {kToggleSFX,        {0xA1, 0x68, 0xB2, 0x6F, 0x00, 0x8B, 0xC8, 0xF7}, 8, "ToggleSFX"},
    {kToggleMusic,      {0xA1, 0x68, 0xB2, 0x6F, 0x00, 0x8B, 0xC8, 0xF7}, 8, "ToggleMusic"},
    {kToggleCamSens,    {0xA1, 0xA4, 0x07, 0x77, 0x00, 0x83, 0xE8, 0x00}, 8, "ToggleCameraSensitivity"},
    {kToggleAspect,     {0xF6, 0x05, 0x4C, 0x07, 0x77, 0x00, 0x18, 0xB9}, 8, "ToggleAspectRatio"},
    {kSetLevelComplete, {0x6A, 0x01, 0xB9, 0x30, 0x36, 0x71, 0x00, 0xE8}, 8, "SetLevelComplete"},
    {kDebugOptToggle,   {0x8B, 0xC1, 0x8B, 0x4C, 0x24, 0x04, 0xBA, 0x01}, 8, "ToggleDebugOption"},
    {kDebugOptNames,    {0xA4, 0x5B, 0x68, 0x00, 0x8C, 0x5B, 0x68, 0x00}, 8, "DebugOptionNames"},
    {kSwapPlayer,       {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0, 0x83, 0xEC}, 8, "SwapPlayer"},
    {kSwapPoll,         {0xB9, 0x80, 0xE4, 0x6F, 0x00, 0xE9, 0x66, 0xFF}, 8, "SwapPoll"},
    {kFindCreatureType, {0x83, 0xEC, 0x24, 0xA1, 0x20, 0x3B, 0x6F, 0x00}, 8, "FindCreatureType"},
    {kRequestLevel,     {0x8B, 0x44, 0x24, 0x04, 0x56, 0x50, 0xE8, 0x45}, 8, "RequestLevel"},
    {kLoadCreature,     {0x83, 0xEC, 0x0C, 0x53, 0x8B, 0x5C, 0x24, 0x14}, 8, "LoadCreature"},
    {kQueueLoad,        {0x8B, 0x15, 0xAC, 0xAF, 0x6F, 0x00, 0x8B, 0x44}, 8, "QueueLoad"},
    {kQueueLoadStore,   {0x8B, 0x41, 0x04, 0x89, 0x54, 0x81, 0x0C, 0x8B}, 8, "QueueLoad list"},
    {kQueueFree,        {0x8B, 0x15, 0xAC, 0xAF, 0x6F, 0x00, 0x8B, 0x44}, 8, "QueueFree"},
    {kQueueFreeStore,   {0x8B, 0x41, 0x08, 0x89, 0x54, 0x81, 0x4C, 0x8B}, 8, "QueueFree list"},
    {kCamReset,         {0x53, 0x55, 0x8B, 0xE9, 0x56, 0x33, 0xDB, 0x89}, 8, "CameraReset"},
    {kGetMatrix,        {0x8B, 0x81, 0x28, 0x06, 0x00, 0x00, 0xC1, 0xE8}, 8, "GetMatrix"},
    {kGetPos,           {0x8B, 0x81, 0x28, 0x06, 0x00, 0x00, 0xC1, 0xE8}, 8, "GetPos"},
    {kSetTransform,     {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0, 0x81, 0xEC}, 8, "SetTransform"},
    {kGetActiveBody,    {0x8B, 0x81, 0x28, 0x06, 0x00, 0x00, 0xC1, 0xE8}, 8, "GetActiveBody"},
    {kSafeRespawn,      {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0, 0x83, 0xEC}, 8, "SafeRespawn"},
    {kCamFaceHeading,   {0x51, 0x8B, 0x0D, 0x14, 0x06, 0x77, 0x00, 0x56}, 8, "CameraFaceHeading"},
    {kLocalize,         {0x51, 0x53, 0x55, 0x56, 0x57, 0xC7, 0x44, 0x24}, 8, "Localize"},
    {kSendScriptMsg,    {0x8B, 0x44, 0x24, 0x10, 0x8B, 0x4C, 0x24, 0x08}, 8, "SendScriptMessage"},
    {kFindEvent,        {0x53, 0x56, 0x57, 0x8B, 0x7C, 0x24, 0x14, 0x83}, 8, "FindEvent"},
    {kFireEvent,        {0x56, 0x8B, 0x74, 0x24, 0x08, 0x33, 0xD2, 0x3B}, 8, "FireEvent"},
    {kFindScriptVar,    {0x53, 0x8B, 0x5C, 0x24, 0x08, 0x33, 0xC0, 0x85}, 8, "FindScriptVar"},
};

// Names for the raw flag view. Bits not listed are unknown.
struct FlagName { uint32_t bit; const char* name; };
const FlagName kFlagNames[] = {
    {0x2, "God mode"}, {0x4, "Vibration on"}, {0x8, "Draw FPS"}, {0x10, "Draw player coords"},
    {0x20, "Unlock all"}, {0x40, "Unlimited ammo"}, {0x80, "No police response"},
    {0x100, "Disable AI control"}, {0x200, "Show shields"}, {0x800, "SFX off"}, {0x1000, "Music off"},
    {0x2000, "ASYNC (command line)"}, {0x8000, "Slow motion"}, {0x80000, "cfgc (command line)"},
    {0x200000, "Unknown: level flow"}, {0x400000, "Unknown: set by game"},
    {0x800000, "Enable SELECT button (command line)"},
};

}  // namespace game
