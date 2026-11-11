// VoiceMenu.asi: a menu of the current character's voice lines for Transformers: The Game (PC, 2007).
// Press the menu key (V) and pick a line with the number keys; it plays at once, any time.
//
// Target: Transformers.exe v1.0.254.2. Loaded by Ultimate ASI Loader (dinput8.dll).
//
// How it works:
//   - Lines come from VoiceMenu\VoiceLines.txt (speaker, wav, subtitle id, label), built by
//     tools/make_voicelines.py from the game's own SPEECH.INI / MUSIC.CFG. The WAVs are in VoiceMenu\Lines.
//   - The player's character is read from [0x770614] -> +0x518 type record -> +0 name. A speaker matches
//     when its name is inside the character name (Megatron matches G1Megatron), or through [Aliases].
//   - Draws with Dear ImGui from a Present hook on the game's D3D9 device (vtable patch, so it chains with
//     DebugTrainer). It takes no mouse or window input: keys are read with GetAsyncKeyState, and the menu
//     only uses keys the game doesn't bind (PC\NUCONFIG.TXT).
//   - Plays with PlaySound from memory, so the volume setting can scale the samples.

#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <mmsystem.h>
#include <d3d9.h>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "imgui.h"
#include "imgui_impl_dx9.h"
#include "imgui_impl_win32.h"

#define VOICEMENU_VERSION "1.0.0"

namespace game {
constexpr uintptr_t kDevicePtr    = 0x2BD90EC;  // IDirect3DDevice9* (renderer object +4)
constexpr uintptr_t kPlayerPtr   = 0x770614;   // Char* of the player
constexpr uint32_t  kTypeRecord   = 0x518;      // Char -> type record; record +0 = const char* name
constexpr uintptr_t kLocalize     = 0x65EBA0;   // const char* __cdecl Localize(const char* id)
typedef const char*(__cdecl* LocalizeFn)(const char*);
const uint8_t kLocalizeBytes[]     = {0x51, 0x53, 0x55, 0x56, 0x57, 0xC7, 0x44, 0x24};

// The HUD's speech bubble: head portrait + subtitle box, what SPEECH.INI lines show. Speech::Play (0x4AAD90)
// calls it as HUD(0x713630)->ShowSpeech(head, text, seconds, 0) once its sound starts. It keeps the text
// pointer (it doesn't copy it), so the text must stay alive. Head = portrait index 0..11 (0x48FFB0 table):
// 0 optimus, 1/2 bumblebee, 3 starscream, 4 frenzy, 5 jazz, 6 blackout, 7 ironhide, 8 bonecrusher, 9 brawl,
// 10 megatron, 11 barricade. The widget objects live at [HUD+0x18]; it uses +0x10 and +0x60 of that.
// The bubble widget is [[HUD+0x18]+0x10]. ShowSpeech's setup (0x48FFB0) stores seconds at +0x10 but always sets
// the time left on screen, +0x14, to 3.0; its update (0x4901B0) counts +0x14 down by the frame time and hides the
// bubble at 0. +0x20 = the text pointer it shows.
constexpr uint32_t  kBubbleTimeLeft = 0x14;
constexpr uint32_t  kBubbleText     = 0x20;
constexpr uintptr_t kHud          = 0x713630;
constexpr uintptr_t kShowSpeech   = 0x492EB0;
typedef void(__thiscall* ShowSpeechFn)(void* hud, int head, const char* text, float seconds, int flag);
const uint8_t kShowSpeechBytes[]   = {0x8B, 0x44, 0x24, 0x08, 0x85, 0xC0, 0x56, 0x8B};
}  // namespace game

// ---------------------------------------------------------------- config + log
struct Config {
    int   menuKey = 'V';
    int   randomKey = 'B';      // plays a random line of your character without the menu (0 = off)
    int   stopKey = VK_BACK;
    int   prevPageKey = VK_OEM_4;   // [
    int   nextPageKey = VK_OEM_6;   // ]
    int   groupKey = VK_TAB;        // cycles: your character -> each speaker -> back
    int   volume = 100;             // percent, 0..200
    float fontScale = 1.25f;
    bool  showSubtitles = true;
    bool  closeOnPlay = false;
    bool  showToast = true;
    bool  dramaticOnly = true;      // only lines marked dramatic in VoiceLines.txt
    bool  showBubble = true;        // the game's own head + subtitle bubble
    float cooldown = 3.0f;          // seconds after a line ends before the next can start
    bool  allowInterrupt = false;   // 1 = a new line may cut off the current one (cooldown counts from its start)
};
static Config g_cfg;
static FILE*  g_log = nullptr;
static char   g_dir[MAX_PATH];
static char   g_iniPath[MAX_PATH];

static void Log(const char* fmt, ...) {
    if (!g_log) return;
    va_list a; va_start(a, fmt);
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "[%02d:%02d:%02d] ", t.wHour, t.wMinute, t.wSecond);
    vfprintf(g_log, fmt, a);
    fputc('\n', g_log);
    fflush(g_log);
    va_end(a);
}

struct KeyName { const char* name; int vk; };
static const KeyName kKeys[] = {
    {"F1", VK_F1}, {"F2", VK_F2}, {"F3", VK_F3}, {"F4", VK_F4}, {"F5", VK_F5}, {"F6", VK_F6}, {"F7", VK_F7},
    {"F8", VK_F8}, {"F9", VK_F9}, {"F10", VK_F10}, {"F11", VK_F11}, {"F12", VK_F12}, {"INSERT", VK_INSERT},
    {"DELETE", VK_DELETE}, {"HOME", VK_HOME}, {"END", VK_END}, {"PAGEUP", VK_PRIOR}, {"PAGEDOWN", VK_NEXT},
    {"TAB", VK_TAB}, {"BACKSPACE", VK_BACK}, {"TILDE", VK_OEM_3}, {"[", VK_OEM_4}, {"]", VK_OEM_6},
    {"MINUS", VK_OEM_MINUS}, {"PLUS", VK_OEM_PLUS}, {"COMMA", VK_OEM_COMMA}, {"PERIOD", VK_OEM_PERIOD},
    {"NUMPAD0", VK_NUMPAD0}, {"NONE", 0}, {"OFF", 0},
};

static int ParseKey(const char* s, int fallback) {
    while (*s == ' ') ++s;
    if (!*s) return fallback;
    for (const KeyName& k : kKeys) if (_stricmp(s, k.name) == 0) return k.vk;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) return (int)strtol(s, nullptr, 16);
    if (!s[1] && ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z') || (s[0] >= '0' && s[0] <= '9')))
        return toupper(s[0]);
    return fallback;
}

static const char* KeyToName(int vk) {
    static char buf[8];
    if (vk == 0) return "off";
    for (const KeyName& k : kKeys) if (k.vk == vk) return k.name;
    if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) { buf[0] = (char)vk; buf[1] = 0; return buf; }
    sprintf(buf, "0x%02X", vk);
    return buf;
}

static int IniKey(const char* key, int def) {
    char b[32];
    GetPrivateProfileStringA("VoiceMenu", key, "", b, sizeof(b), g_iniPath);
    return b[0] ? ParseKey(b, def) : def;
}

// [Aliases] CharacterName=Speaker, e.g. Bumblebee07=Bumblebee. Checked before the name match.
struct Alias { char type[48]; char speaker[32]; };
static Alias g_aliases[64];
static int   g_aliasCount = 0;

static void LoadConfig() {
    g_cfg.menuKey     = IniKey("MenuKey", g_cfg.menuKey);
    g_cfg.randomKey   = IniKey("RandomKey", g_cfg.randomKey);
    g_cfg.stopKey     = IniKey("StopKey", g_cfg.stopKey);
    g_cfg.prevPageKey = IniKey("PrevPageKey", g_cfg.prevPageKey);
    g_cfg.nextPageKey = IniKey("NextPageKey", g_cfg.nextPageKey);
    g_cfg.groupKey    = IniKey("SwitchListKey", g_cfg.groupKey);
    g_cfg.volume      = GetPrivateProfileIntA("VoiceMenu", "Volume", g_cfg.volume, g_iniPath);
    if (g_cfg.volume < 0) g_cfg.volume = 0;
    if (g_cfg.volume > 200) g_cfg.volume = 200;
    char b[32];
    GetPrivateProfileStringA("VoiceMenu", "FontScale", "1.25", b, sizeof(b), g_iniPath);
    g_cfg.fontScale = (float)atof(b);
    if (g_cfg.fontScale < 0.5f || g_cfg.fontScale > 4.0f) g_cfg.fontScale = 1.25f;
    g_cfg.showSubtitles = GetPrivateProfileIntA("VoiceMenu", "ShowSubtitles", 1, g_iniPath) != 0;
    g_cfg.closeOnPlay   = GetPrivateProfileIntA("VoiceMenu", "CloseOnPlay", 0, g_iniPath) != 0;
    g_cfg.showToast     = GetPrivateProfileIntA("VoiceMenu", "ShowStartupNote", 1, g_iniPath) != 0;
    g_cfg.dramaticOnly  = GetPrivateProfileIntA("VoiceMenu", "DramaticOnly", 1, g_iniPath) != 0;
    g_cfg.showBubble    = GetPrivateProfileIntA("VoiceMenu", "ShowSpeechBubble", 1, g_iniPath) != 0;
    g_cfg.allowInterrupt = GetPrivateProfileIntA("VoiceMenu", "AllowInterrupt", 0, g_iniPath) != 0;
    GetPrivateProfileStringA("VoiceMenu", "Cooldown", "3.0", b, sizeof(b), g_iniPath);
    g_cfg.cooldown = (float)atof(b);
    if (g_cfg.cooldown < 0) g_cfg.cooldown = 0;
    if (g_cfg.cooldown > 600) g_cfg.cooldown = 600;

    static char sect[4096];
    DWORD n = GetPrivateProfileSectionA("Aliases", sect, sizeof(sect), g_iniPath);
    g_aliasCount = 0;
    for (const char* p = sect; n && *p && g_aliasCount < 64; p += strlen(p) + 1) {
        const char* eq = strchr(p, '=');
        if (!eq || *p == ';') continue;
        Alias& a = g_aliases[g_aliasCount];
        size_t tl = eq - p; if (tl > 47) tl = 47;
        memcpy(a.type, p, tl); a.type[tl] = 0;
        strncpy(a.speaker, eq + 1, 31); a.speaker[31] = 0;
        ++g_aliasCount;
    }
}

// ---------------------------------------------------------------- safe memory access
static bool SafeRead(uintptr_t addr, void* out, size_t n) {
    __try { memcpy(out, reinterpret_cast<const void*>(addr), n); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
template <typename T> static bool Read(uintptr_t addr, T& out) { return SafeRead(addr, &out, sizeof(T)); }

static bool BytesMatch(uintptr_t addr, const uint8_t* b, size_t n) {
    uint8_t buf[16];
    return n <= sizeof(buf) && SafeRead(addr, buf, n) && memcmp(buf, b, n) == 0;
}

static void CurrentCharacter(char* out, size_t n) {
    out[0] = 0;
    uintptr_t pl = 0, rec = 0, name = 0;
    if (!Read(game::kPlayerPtr, pl) || !pl) return;
    if (!Read(pl + game::kTypeRecord, rec) || !rec) return;
    if (!Read(rec, name) || !name) return;
    if (!SafeRead(name, out, n - 1)) { out[0] = 0; return; }
    out[n - 1] = 0;
    for (size_t i = 0; out[i]; ++i) if ((unsigned char)out[i] < 0x20 || (unsigned char)out[i] > 0x7E) { out[0] = 0; return; }
}

// ---------------------------------------------------------------- lines
struct Line {
    char speaker[32];
    char file[64];
    char textId[64];
    char label[96];
    bool guess;
    int  head;                 // HUD portrait, -1 = no bubble
    bool dramatic;
    char subtitle[256];
    const char* gameText;      // the game's own copy of the subtitle (what the bubble shows), or null
    bool subtitleTried;
};

// Portrait for a speaker name, when VoiceLines.txt has no head column.
static int DefaultHead(const char* sp) {
    static const struct { const char* n; int h; } k[] = {
        {"Optimus", 0}, {"Bumblebee", 1}, {"Starscream", 3}, {"Frenzy", 4}, {"Jazz", 5}, {"Blackout", 6},
        {"Ironhide", 7}, {"Bonecrusher", 8}, {"Brawl", 9}, {"Megatron", 10}, {"Barricade", 11}};
    for (auto& e : k) if (_stricmp(e.n, sp) == 0) return e.h;
    return -1;
}
static Line* g_lines = nullptr;
static int   g_lineCount = 0;
static volatile int g_wavsFound = -1;   // -1 = not counted yet
static char  g_speakers[32][32];
static int   g_speakerCount = 0;

static int SpeakerIndex(const char* s) {
    for (int i = 0; i < g_speakerCount; ++i) if (_stricmp(g_speakers[i], s) == 0) return i;
    if (g_speakerCount >= 32) return -1;
    strncpy(g_speakers[g_speakerCount], s, 31);
    g_speakers[g_speakerCount][31] = 0;
    return g_speakerCount++;
}

static char* NextField(char*& p) {
    char* s = p;
    if (!s) return nullptr;
    char* t = strchr(s, '\t');
    if (t) { *t = 0; p = t + 1; } else p = nullptr;
    return s;
}

static bool LoadLines() {
    char path[MAX_PATH];
    sprintf(path, "%sVoiceMenu\\VoiceLines.txt", g_dir);
    FILE* f = fopen(path, "rb");
    if (!f) { Log("ERROR: can't open %s", path); return false; }
    int cap = 512;
    g_lines = (Line*)calloc(cap, sizeof(Line));
    char buf[1024];
    while (fgets(buf, sizeof(buf), f)) {
        size_t l = strlen(buf);
        while (l && (buf[l - 1] == '\n' || buf[l - 1] == '\r')) buf[--l] = 0;
        if (!l || buf[0] == ';' || buf[0] == '#') continue;
        if (g_lineCount == cap) { cap *= 2; g_lines = (Line*)realloc(g_lines, cap * sizeof(Line)); }
        Line& ln = g_lines[g_lineCount];
        memset(&ln, 0, sizeof(ln));
        char* p = buf;
        const char* sp = NextField(p); const char* fl = NextField(p);
        const char* tx = NextField(p); const char* lb = NextField(p); const char* gs = NextField(p);
        const char* hd = NextField(p); const char* dr = NextField(p);
        if (!sp || !fl || !*sp || !*fl) continue;
        strncpy(ln.speaker, sp, 31);
        strncpy(ln.file, fl, 63);
        strncpy(ln.textId, tx ? tx : "", 63);
        strncpy(ln.label, lb && *lb ? lb : fl, 95);
        ln.guess = gs && *gs == '1';
        ln.head = hd && *hd ? atoi(hd) : DefaultHead(ln.speaker);
        if (ln.head < -1 || ln.head > 11) ln.head = -1;
        ln.dramatic = !dr || !*dr || *dr == '1';
        SpeakerIndex(ln.speaker);
        ++g_lineCount;
    }
    fclose(f);
    int dramatic = 0;
    for (int i = 0; i < g_lineCount; ++i) dramatic += g_lines[i].dramatic;
    Log("loaded %d lines (%d dramatic), %d speakers", g_lineCount, dramatic, g_speakerCount);
    return g_lineCount > 0;
}

static const char* StrIStr(const char* h, const char* n) {
    size_t nl = strlen(n);
    if (!nl) return nullptr;
    for (; *h; ++h) if (_strnicmp(h, n, nl) == 0) return h;
    return nullptr;
}

// The speaker for a character type name, or "" when none matches.
static const char* SpeakerFor(const char* type) {
    if (!type[0]) return "";
    for (int i = 0; i < g_aliasCount; ++i) if (_stricmp(g_aliases[i].type, type) == 0) return g_aliases[i].speaker;
    const char* best = "";
    size_t bestLen = 0;
    for (int i = 0; i < g_speakerCount; ++i) {
        size_t l = strlen(g_speakers[i]);
        if (l > bestLen && StrIStr(type, g_speakers[i])) { best = g_speakers[i]; bestLen = l; }
    }
    return best;
}

static bool g_localizeOk = false;
static void FetchSubtitle(Line& ln) {
    if (ln.subtitleTried) return;
    ln.subtitleTried = true;
    if (!g_localizeOk || !ln.textId[0]) return;
    const char* s = nullptr;
    __try { s = reinterpret_cast<game::LocalizeFn>(game::kLocalize)(ln.textId); }
    __except (EXCEPTION_EXECUTE_HANDLER) { s = nullptr; }
    if (!s || !SafeRead(reinterpret_cast<uintptr_t>(s), ln.subtitle, sizeof(ln.subtitle) - 1)) { ln.subtitle[0] = 0; return; }
    ln.subtitle[sizeof(ln.subtitle) - 1] = 0;
    // The game returns the id itself (or a placeholder) when it has no text.
    if (_stricmp(ln.subtitle, ln.textId) == 0 || strlen(ln.subtitle) < 3) { ln.subtitle[0] = 0; return; }
    ln.gameText = s;
    for (char* c = ln.subtitle; *c; ++c) if ((unsigned char)*c < 0x20) *c = ' ';
}

// ---------------------------------------------------------------- the game's speech bubble
static bool g_bubbleOk = false;
static const char kNoText[] = " ";  // lines the game has no subtitle for: the head shows with an empty box

static bool HudReady() {
    uintptr_t w = 0, a = 0, b = 0;
    return Read(game::kHud + 0x18, w) && w && Read(w + 0x10, a) && a && Read(w + 0x60, b) && b;
}

// The bubble we showed, while it's still ours (the game hasn't put its own line in it).
static uintptr_t   g_bubbleWidget = 0;
static const char* g_bubbleText = nullptr;

static bool SafeWriteFloat(uintptr_t addr, float v) {
    __try { *reinterpret_cast<volatile float*>(addr) = v; return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static bool BubbleStillOurs() {
    uintptr_t w = 0, t = 0;
    if (!g_bubbleWidget) return false;
    if (!Read(game::kHud + 0x18, w) || !w || !Read(w + 0x10, w) || w != g_bubbleWidget ||
        !Read(g_bubbleWidget + game::kBubbleText, t) || t != reinterpret_cast<uintptr_t>(g_bubbleText)) {
        g_bubbleWidget = 0;
        return false;
    }
    return true;
}

// Keeps the bubble's time left equal to the voice line's time left (the game would close it after 3 s).
static void SetBubbleTime(float seconds) {
    if (BubbleStillOurs()) SafeWriteFloat(g_bubbleWidget + game::kBubbleTimeLeft, seconds);
}

static void ShowBubble(Line& ln, float seconds) {
    g_bubbleWidget = 0;
    if (!g_cfg.showBubble || !g_bubbleOk || ln.head < 0) return;
    if (!HudReady()) { Log("speech bubble skipped: HUD not ready"); return; }
    FetchSubtitle(ln);
    const char* text = ln.gameText ? ln.gameText : kNoText;
    __try {
        reinterpret_cast<game::ShowSpeechFn>(game::kShowSpeech)(reinterpret_cast<void*>(game::kHud), ln.head, text, seconds, 0);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        Log("ERROR: exception 0x%08X in ShowSpeech; bubble disabled", GetExceptionCode());
        g_bubbleOk = false;
        return;
    }
    uintptr_t w = 0;
    if (Read(game::kHud + 0x18, w) && w && Read(w + 0x10, w) && w) {
        g_bubbleWidget = w;
        g_bubbleText = text;
        SetBubbleTime(seconds);
    }
}

// ---------------------------------------------------------------- playback
static uint8_t* g_snd = nullptr;   // the WAV PlaySound is reading (kept alive while it plays)
static DWORD    g_playEnd = 0;     // tick when it ends
static DWORD    g_nextAllowed = 0; // cooldown: no new line before this tick
static int      g_playing = -1;    // line index
static void Note(const char* fmt, ...);

static void StopLine() {
    PlaySoundA(nullptr, nullptr, 0);
    free(g_snd); g_snd = nullptr;
    SetBubbleTime(0);  // the bubble closes with the voice
    g_bubbleWidget = 0;
    if (g_playing >= 0) {
        // Stopping early still leaves the cooldown, counted from now.
        DWORD now = GetTickCount();
        if (!g_cfg.allowInterrupt && (LONG)(g_nextAllowed - now) > (LONG)(g_cfg.cooldown * 1000)) g_nextAllowed = now + (DWORD)(g_cfg.cooldown * 1000);
    }
    g_playing = -1;
}

// Seconds left before another line may start (0 = ready).
static float CooldownLeft() {
    DWORD now = GetTickCount();
    if (!g_cfg.allowInterrupt && g_playing >= 0 && (LONG)(g_playEnd - now) > 0)
        return ((LONG)(g_playEnd - now) + g_cfg.cooldown * 1000) / 1000.0f;
    LONG left = (LONG)(g_nextAllowed - now);
    return left > 0 ? left / 1000.0f : 0;
}

// Where the dialogue WAVs can be: the mod's own folder, then where the game itself keeps them.
static const char* const kWavDirs[] = {"VoiceMenu\\Lines\\", "AUDIO\\_Dialogue\\USA\\", "AUDIO\\_Dialogue\\"};

static FILE* OpenWav(const char* file, char* path) {
    for (const char* d : kWavDirs) {
        sprintf(path, "%s%s%s", g_dir, d, file);
        FILE* f = fopen(path, "rb");
        if (f) return f;
    }
    return nullptr;
}

static int CountWavs() {
    char path[MAX_PATH];
    int n = 0;
    for (int i = 0; i < g_lineCount; ++i) {
        FILE* f = OpenWav(g_lines[i].file, path);
        if (f) { ++n; fclose(f); }
    }
    return n;
}

static bool PlayLine(int idx) {
    if (idx < 0 || idx >= g_lineCount) return false;
    float wait = CooldownLeft();
    if (wait > 0) { Note("Wait %.1fs", wait); return false; }
    char path[MAX_PATH];
    FILE* f = OpenWav(g_lines[idx].file, path);
    if (!f) {
        Log("missing %s (looked in VoiceMenu\\Lines and AUDIO\\_Dialogue)", g_lines[idx].file);
        Note("Voice file missing: %s (see README)", g_lines[idx].file);
        return false;
    }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t* d = (sz > 44 && sz < 64 * 1024 * 1024) ? (uint8_t*)malloc(sz) : nullptr;
    if (!d || fread(d, 1, sz, f) != (size_t)sz) { fclose(f); free(d); return false; }
    fclose(f);
    if (memcmp(d, "RIFF", 4) || memcmp(d + 8, "WAVE", 4)) { free(d); Log("not a WAV: %s", path); return false; }

    // Walk the chunks: scale 16-bit PCM by the volume and work out the length.
    uint32_t byteRate = 0; uint16_t fmt = 0, bits = 0;
    double secs = 0;
    for (long p = 12; p + 8 <= sz;) {
        uint32_t len = *(uint32_t*)(d + p + 4);
        if (!memcmp(d + p, "fmt ", 4) && len >= 16) {
            fmt = *(uint16_t*)(d + p + 8); byteRate = *(uint32_t*)(d + p + 16); bits = *(uint16_t*)(d + p + 22);
        } else if (!memcmp(d + p, "data", 4)) {
            uint32_t n = (uint32_t)((p + 8 + (long)len <= sz) ? len : sz - p - 8);
            if (byteRate) secs = (double)n / byteRate;
            if (fmt == 1 && bits == 16 && g_cfg.volume != 100) {
                int16_t* s = (int16_t*)(d + p + 8);
                for (uint32_t i = 0; i < n / 2; ++i) {
                    int v = s[i] * g_cfg.volume / 100;
                    s[i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
                }
            }
            break;
        }
        p += 8 + len + (len & 1);
    }

    StopLine();
    g_snd = d;
    if (!PlaySoundA((LPCSTR)g_snd, nullptr, SND_MEMORY | SND_ASYNC | SND_NODEFAULT)) {
        Log("PlaySound failed for %s", path);
        free(g_snd); g_snd = nullptr;
        return false;
    }
    g_playing = idx;
    DWORD now = GetTickCount();
    g_playEnd = now + (DWORD)(secs * 1000.0) + 100;
    g_nextAllowed = (g_cfg.allowInterrupt ? now : g_playEnd) + (DWORD)(g_cfg.cooldown * 1000);
    ShowBubble(g_lines[idx], secs > 0.1 ? (float)secs : 0.1f);
    Log("play %s (%s, %.1fs)", g_lines[idx].file, g_lines[idx].speaker, secs);
    return true;
}

// ---------------------------------------------------------------- menu state
static bool g_menuOpen = false;
static int  g_group = -1;           // -1 = your character, else a speaker index
static int  g_page = 0;
static char g_character[64] = "";
static int  g_view[512];            // line indices shown in the current list
static int  g_viewCount = 0;
static DWORD g_readyTick = 0;
static char g_note[96] = "";
static DWORD g_noteUntil = 0;

static void Note(const char* fmt, ...) {
    va_list a; va_start(a, fmt);
    vsnprintf(g_note, sizeof(g_note), fmt, a);
    va_end(a);
    g_noteUntil = GetTickCount() + 2500;
}

static const char* GroupSpeaker() {
    return g_group < 0 ? SpeakerFor(g_character) : g_speakers[g_group];
}

static bool Shown(const Line& ln, const char* sp) {
    return _stricmp(ln.speaker, sp) == 0 && (!g_cfg.dramaticOnly || ln.dramatic);
}

static void BuildView() {
    const char* sp = GroupSpeaker();
    g_viewCount = 0;
    if (!sp[0]) return;
    for (int i = 0; i < g_lineCount && g_viewCount < 512; ++i)
        if (Shown(g_lines[i], sp)) g_view[g_viewCount++] = i;
}

static int PageCount() { return g_viewCount ? (g_viewCount + 8) / 9 : 1; }

static bool GameIsForeground() {
    HWND f = GetForegroundWindow();
    DWORD pid = 0;
    if (f) GetWindowThreadProcessId(f, &pid);
    return pid == GetCurrentProcessId();
}

// Edge-triggered key press. Index = virtual-key code.
static bool g_down[256];
static bool Pressed(int vk, bool fg) {
    if (vk <= 0 || vk > 255) return false;
    bool d = fg && (GetAsyncKeyState(vk) & 0x8000) != 0;
    bool hit = d && !g_down[vk];
    g_down[vk] = d;
    return hit;
}

static void PlayRandomOwnLine() {
    const char* sp = SpeakerFor(g_character);
    if (!sp[0]) { Note("No voice lines for %s", g_character[0] ? g_character : "this character"); return; }
    int pick[512], n = 0;
    for (int i = 0; i < g_lineCount && n < 512; ++i) if (Shown(g_lines[i], sp)) pick[n++] = i;
    if (n) PlayLine(pick[rand() % n]);
    else Note("No lines for %s", sp);
}

static void UpdateInput() {
    bool fg = GameIsForeground();
    char cur[64];
    CurrentCharacter(cur, sizeof(cur));
    if (strcmp(cur, g_character) != 0) {
        strcpy(g_character, cur);
        Log("character: %s -> speaker %s", g_character[0] ? g_character : "(none)", SpeakerFor(g_character)[0] ? SpeakerFor(g_character) : "(none)");
        if (g_group < 0) { BuildView(); g_page = 0; }
    }

    if (Pressed(g_cfg.menuKey, fg)) {
        g_menuOpen = !g_menuOpen;
        if (g_menuOpen) { g_group = -1; g_page = 0; BuildView(); }
    }
    if (Pressed(g_cfg.randomKey, fg)) PlayRandomOwnLine();
    if (Pressed(g_cfg.stopKey, fg) && g_menuOpen) StopLine();

    if (!g_menuOpen) {
        for (int k = '1'; k <= '9'; ++k) Pressed(k, false);  // forget keys held while closed
        return;
    }
    if (Pressed(g_cfg.groupKey, fg)) {
        // your character -> every speaker in list order -> back to your character
        g_group = g_group + 1 >= g_speakerCount ? -1 : g_group + 1;
        g_page = 0;
        BuildView();
    }
    if (Pressed(g_cfg.prevPageKey, fg)) g_page = (g_page + PageCount() - 1) % PageCount();
    if (Pressed(g_cfg.nextPageKey, fg)) g_page = (g_page + 1) % PageCount();
    for (int k = 1; k <= 9; ++k) {
        bool hit = Pressed('0' + k, fg) | Pressed(VK_NUMPAD0 + k, fg);
        int slot = g_page * 9 + (k - 1);
        if (hit && slot < g_viewCount) {
            PlayLine(g_view[slot]);
            if (g_cfg.closeOnPlay) g_menuOpen = false;
        }
    }
    if (Pressed('0', fg) | Pressed(VK_NUMPAD0, fg)) StopLine();
}

// ---------------------------------------------------------------- drawing
static void DrawMenu() {
    ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x * 0.03f, io.DisplaySize.y * 0.12f), ImGuiCond_Always);
    ImGui::SetNextWindowSizeConstraints(ImVec2(420 * g_cfg.fontScale, 0), ImVec2(io.DisplaySize.x * 0.6f, io.DisplaySize.y * 0.8f));
    ImGui::SetNextWindowBgAlpha(0.88f);
    ImGuiWindowFlags fl = ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_NoNav | ImGuiWindowFlags_AlwaysAutoResize |
                          ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing;
    ImGui::Begin("Voice lines", nullptr, fl);

    const char* sp = GroupSpeaker();
    const char* kind = g_cfg.dramaticOnly ? "Dramatic lines" : "Lines";
    if (g_group < 0) {
        ImGui::Text("Playing as: %s", g_character[0] ? g_character : "(no character)");
        if (sp[0]) ImGui::Text("%s by %s: %d", kind, sp, g_viewCount);
        else ImGui::TextColored(ImVec4(1, 0.6f, 0.4f, 1), "This character has no lines. Press %s to browse others.", KeyToName(g_cfg.groupKey));
    } else {
        ImGui::Text("Browsing: %s (%d %s)", sp, g_viewCount, g_cfg.dramaticOnly ? "dramatic lines" : "lines");
    }
    float wait = CooldownLeft();
    if (wait > 0 && g_playing < 0) ImGui::TextColored(ImVec4(1, 0.6f, 0.4f, 1), "Ready in %.1fs", wait);
    ImGui::Separator();

    int first = g_page * 9;
    for (int k = 0; k < 9 && first + k < g_viewCount; ++k) {
        Line& ln = g_lines[g_view[first + k]];
        bool playing = g_playing == g_view[first + k];
        ImVec4 col = playing ? ImVec4(1.0f, 0.85f, 0.3f, 1) : ImVec4(1, 1, 1, 1);
        ImGui::TextColored(col, "%d  %s%s%s", k + 1, ln.label, ln.guess ? "  (?)" : "", playing ? "   <playing>" : "");
        if (g_cfg.showSubtitles) {
            FetchSubtitle(ln);
            if (ln.subtitle[0]) {
                ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + 400 * g_cfg.fontScale);
                ImGui::TextColored(ImVec4(0.7f, 0.7f, 0.75f, 1), "     %s", ln.subtitle);
                ImGui::PopTextWrapPos();
            }
        }
    }
    ImGui::Separator();
    ImGui::TextDisabled("Page %d/%d   1-9 play   0/%s stop   %s %s page   %s other characters   %s close",
                        g_page + 1, PageCount(), KeyToName(g_cfg.stopKey), KeyToName(g_cfg.prevPageKey),
                        KeyToName(g_cfg.nextPageKey), KeyToName(g_cfg.groupKey), KeyToName(g_cfg.menuKey));
    ImGui::End();
}

static void DrawCornerText(const char* text) {
    ImGuiIO& io = ImGui::GetIO();
    ImGui::SetNextWindowPos(ImVec2(io.DisplaySize.x * 0.5f, io.DisplaySize.y * 0.06f), ImGuiCond_Always, ImVec2(0.5f, 0));
    ImGui::SetNextWindowBgAlpha(0.7f);
    ImGui::Begin("##vmnote", nullptr, ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize |
                 ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    ImGui::TextUnformatted(text);
    ImGui::End();
}

// ---------------------------------------------------------------- D3D9 hooks
typedef HRESULT(STDMETHODCALLTYPE* PresentFn)(IDirect3DDevice9*, const RECT*, const RECT*, HWND, const RGNDATA*);
typedef HRESULT(STDMETHODCALLTYPE* ResetFn)(IDirect3DDevice9*, D3DPRESENT_PARAMETERS*);
static PresentFn g_origPresent = nullptr;
static ResetFn   g_origReset = nullptr;
static IDirect3DDevice9* g_device = nullptr;
static bool g_imguiReady = false;
static bool g_imguiFailed = false;

static bool InitImGui(IDirect3DDevice9* dev) {
    D3DDEVICE_CREATION_PARAMETERS cp = {};
    dev->GetCreationParameters(&cp);
    HWND hwnd = cp.hFocusWindow;
    IDirect3DSwapChain9* sc = nullptr;
    if (SUCCEEDED(dev->GetSwapChain(0, &sc)) && sc) {
        D3DPRESENT_PARAMETERS pp = {};
        if (SUCCEEDED(sc->GetPresentParameters(&pp)) && pp.hDeviceWindow) hwnd = pp.hDeviceWindow;
        sc->Release();
    }
    if (!hwnd) return false;
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr;
    io.ConfigFlags |= ImGuiConfigFlags_NoMouse | ImGuiConfigFlags_NoMouseCursorChange;
    io.FontGlobalScale = g_cfg.fontScale;
    ImGui::StyleColorsDark();
    ImGuiStyle& st = ImGui::GetStyle();
    st.WindowRounding = 6;
    st.Colors[ImGuiCol_TitleBgActive] = st.Colors[ImGuiCol_TitleBg] = ImVec4(0.35f, 0.15f, 0.45f, 1.0f);
    if (!ImGui_ImplWin32_Init(hwnd) || !ImGui_ImplDX9_Init(dev)) { Log("ImGui init failed"); return false; }
    g_readyTick = GetTickCount();
    Log("ImGui ready (window %p)", hwnd);
    return true;
}

static void Frame(IDirect3DDevice9* dev) {
    if (!g_imguiReady) {
        if (g_imguiFailed) return;
        g_imguiReady = InitImGui(dev);
        if (!g_imguiReady) return;
    }
    UpdateInput();
    if (g_playing >= 0) {
        // The bubble's own timer runs on game time (it stops in the pause menu), the voice on real time:
        // set the bubble to the voice's time left every frame, and close it when the voice ends.
        LONG left = (LONG)(g_playEnd - 100 - GetTickCount());
        if (left <= 0) {
            SetBubbleTime(0);
            g_bubbleWidget = 0;
            g_playing = -1;
        } else {
            SetBubbleTime(left / 1000.0f);
        }
    }

    bool toast = g_cfg.showToast && GetTickCount() - g_readyTick < 8000;
    bool note = GetTickCount() < g_noteUntil;
    if (!g_menuOpen && !toast && !note) return;
    if (dev->TestCooperativeLevel() != D3D_OK) return;

    ImGui_ImplDX9_NewFrame();
    ImGui_ImplWin32_NewFrame();
    ImGui::NewFrame();
    if (g_menuOpen) DrawMenu();
    if (note) DrawCornerText(g_note);
    else if (toast && !g_menuOpen) {
        char t[96];
        if (g_wavsFound == 0) sprintf(t, "Voice menu: no voice files found (see README)");
        else sprintf(t, "Voice menu ready: press %s", KeyToName(g_cfg.menuKey));
        DrawCornerText(t);
    }
    ImGui::EndFrame();
    if (SUCCEEDED(dev->BeginScene())) {
        ImGui::Render();
        ImGui_ImplDX9_RenderDrawData(ImGui::GetDrawData());
        dev->EndScene();
    } else {
        ImGui::Render();
    }
}

static HRESULT STDMETHODCALLTYPE HkPresent(IDirect3DDevice9* dev, const RECT* a, const RECT* b, HWND c, const RGNDATA* d) {
    if (dev == g_device) {
        __try { Frame(dev); }
        __except (EXCEPTION_EXECUTE_HANDLER) {
            static int n = 0;
            if (n++ < 5) Log("ERROR: exception 0x%08X in the menu", GetExceptionCode());
        }
    }
    return g_origPresent(dev, a, b, c, d);
}

static HRESULT STDMETHODCALLTYPE HkReset(IDirect3DDevice9* dev, D3DPRESENT_PARAMETERS* pp) {
    if (dev == g_device && g_imguiReady) ImGui_ImplDX9_InvalidateDeviceObjects();
    HRESULT hr = g_origReset(dev, pp);
    if (dev == g_device && g_imguiReady && SUCCEEDED(hr)) ImGui_ImplDX9_CreateDeviceObjects();
    return hr;
}

static void* PatchVtable(void** vt, int idx, void* fn) {
    DWORD old;
    if (!VirtualProtect(&vt[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) return nullptr;
    void* prev = vt[idx];
    vt[idx] = fn;
    VirtualProtect(&vt[idx], sizeof(void*), old, &old);
    return prev;
}

static DWORD WINAPI InitThread(LPVOID) {
    if (!LoadLines()) { Log("no lines; VoiceMenu disabled"); return 0; }
    g_wavsFound = CountWavs();
    Log("voice files found: %d of %d", g_wavsFound, g_lineCount);

    // Wait for the exe's code to be readable (SecuROM may decrypt it after start), then for the device.
    DWORD t0 = GetTickCount();
    while (GetTickCount() - t0 < 300000 && !BytesMatch(game::kLocalize, game::kLocalizeBytes, sizeof(game::kLocalizeBytes)))
        Sleep(100);
    g_localizeOk = BytesMatch(game::kLocalize, game::kLocalizeBytes, sizeof(game::kLocalizeBytes));
    g_bubbleOk = BytesMatch(game::kShowSpeech, game::kShowSpeechBytes, sizeof(game::kShowSpeechBytes));
    Log("subtitle lookup %s; speech bubble %s", g_localizeOk ? "available" : "unavailable",
        g_bubbleOk ? "available" : "unavailable (exe doesn't match v1.0.254.2)");

    IDirect3DDevice9* dev = nullptr;
    for (;;) {
        if (Read(game::kDevicePtr, dev) && dev) break;
        Sleep(50);
    }
    Sleep(1500);  // let the game (and DebugTrainer, if present) finish setting the device up
    Read(game::kDevicePtr, dev);
    void** vt = nullptr;
    if (!Read(reinterpret_cast<uintptr_t>(dev), vt) || !vt) { Log("device %p has no vtable", dev); return 0; }
    g_device = dev;
    g_origReset   = reinterpret_cast<ResetFn>(PatchVtable(vt, 16, reinterpret_cast<void*>(&HkReset)));
    g_origPresent = reinterpret_cast<PresentFn>(PatchVtable(vt, 17, reinterpret_cast<void*>(&HkPresent)));
    if (!g_origPresent || !g_origReset) { Log("ERROR: vtable patch failed"); return 0; }
    Log("D3D9 hooks installed (device %p)", dev);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        GetModuleFileNameA(inst, g_dir, MAX_PATH);
        char* slash = strrchr(g_dir, '\\');
        if (slash) slash[1] = 0;
        sprintf(g_iniPath, "%sVoiceMenu.ini", g_dir);
        char logPath[MAX_PATH];
        sprintf(logPath, "%sVoiceMenu.log", g_dir);
        g_log = fopen(logPath, "w");
        LoadConfig();
        srand(GetTickCount());
        Log("VoiceMenu " VOICEMENU_VERSION " loaded; menu key %s, random-line key %s", KeyToName(g_cfg.menuKey), KeyToName(g_cfg.randomKey));
        HANDLE h = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
        if (h) CloseHandle(h);
    }
    return TRUE;
}
