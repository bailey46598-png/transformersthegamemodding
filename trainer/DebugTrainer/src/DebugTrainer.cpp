// DebugTrainer.asi: an ImGui trainer for Transformers: The Game (PC, 2007) that exposes the game's own
// hidden debug menu (God Mode, Fly Camera, HUD, the 8 engine debug options, ...) behind a hotkey (F1).
//
// Target: Transformers.exe v1.0.254.2 (retail). Loaded by Ultimate ASI Loader (dinput8.dll).
//
// How it works:
//   1. A worker thread waits for the game to create its Direct3D 9 device (stored at 0x2BD90EC), then
//      patches the device's vtable: Present (draws the menu) and Reset (keeps ImGui alive on alt-tab).
//   2. It patches the DirectInput device vtable (GetDeviceState / GetDeviceData) so that, while the
//      menu is open, the game sees no keyboard or mouse input, and the hotkey never reaches the game.
//   3. Menu actions call the game's own GUI action handlers (the functions FRONTEND.GUIC's debug menu
//      calls), on the render thread, so the game's state stays consistent.
//   Every game address is checked against the expected bytes first; a feature whose bytes don't match is
//   greyed out instead of being called.

#define _CRT_SECURE_NO_WARNINGS
#define DIRECTINPUT_VERSION 0x0800
#include <windows.h>
#include <d3d9.h>
#include <dinput.h>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "imgui.h"
#include "imgui_impl_dx9.h"
#include "imgui_impl_win32.h"
#include "game.h"

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND, UINT, WPARAM, LPARAM);

#define TRAINER_VERSION "0.2"

// ---------------------------------------------------------------- config + log
struct Config {
    int   menuKey        = VK_F1;  // virtual-key code
    bool  blockKeyInGame = true;   // hide the menu key from the game
    bool  blockInput     = true;   // game sees no keyboard/mouse while the menu is open
    bool  startOpen      = false;
    bool  showToast      = true;   // "trainer ready" note for a few seconds after start
    float fontScale      = 1.25f;
    float mouseSpeed     = 1.0f;   // menu cursor speed
    int   noclipKey      = 'N';    // toggles noclip (virtual-key code); rebindable in the menu
    float noclipSpeed    = 25.0f;  // units per second
    float noclipFast     = 3.0f;   // speed multiplier while Shift is held
};

static Config g_cfg;
static FILE*  g_log = nullptr;
static char   g_dir[MAX_PATH];
static char   g_iniPath[MAX_PATH];
static char   g_imguiIni[MAX_PATH];

static void Log(const char* fmt, ...) {
    if (!g_log) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list ap; va_start(ap, fmt); vfprintf(g_log, fmt, ap); va_end(ap);
    fputc('\n', g_log);
    fflush(g_log);
}

struct KeyName { const char* name; int vk; };
static const KeyName kKeys[] = {
    {"F1", VK_F1}, {"F2", VK_F2}, {"F3", VK_F3}, {"F4", VK_F4}, {"F5", VK_F5}, {"F6", VK_F6},
    {"F7", VK_F7}, {"F8", VK_F8}, {"F9", VK_F9}, {"F10", VK_F10}, {"F11", VK_F11}, {"F12", VK_F12},
    {"INSERT", VK_INSERT}, {"DELETE", VK_DELETE}, {"HOME", VK_HOME}, {"END", VK_END},
    {"PAGEUP", VK_PRIOR}, {"PAGEDOWN", VK_NEXT}, {"TILDE", VK_OEM_3}, {"BACKQUOTE", VK_OEM_3},
    {"TAB", VK_TAB}, {"CAPSLOCK", VK_CAPITAL}, {"BACKSPACE", VK_BACK}, {"ENTER", VK_RETURN},
    {"LCTRL", VK_LCONTROL}, {"RCTRL", VK_RCONTROL}, {"LALT", VK_LMENU}, {"RALT", VK_RMENU},
    {"NUM0", VK_NUMPAD0}, {"NUM1", VK_NUMPAD1}, {"NUM2", VK_NUMPAD2}, {"NUM3", VK_NUMPAD3},
    {"NUM4", VK_NUMPAD4}, {"NUM5", VK_NUMPAD5}, {"NUM6", VK_NUMPAD6}, {"NUM7", VK_NUMPAD7},
    {"NUM8", VK_NUMPAD8}, {"NUM9", VK_NUMPAD9}, {"MOUSE4", VK_XBUTTON1}, {"MOUSE5", VK_XBUTTON2},
};

static int ParseKey(const char* s, int fallback = VK_F1) {
    for (const KeyName& k : kKeys) if (_stricmp(s, k.name) == 0) return k.vk;
    if (s[0] && !s[1]) {  // single letter or digit
        char c = (char)toupper((unsigned char)s[0]);
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
    }
    if (s[0]) { int v = (int)strtol(s, nullptr, 0); if (v > 0 && v < 256) return v; }
    return fallback;
}

static const char* KeyToName(int vk) {
    for (const KeyName& k : kKeys) if (k.vk == vk) return k.name;
    static char buf[2][16];
    static int slot = 0;
    slot ^= 1;  // two buffers, so two names can be formatted in one printf
    if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) { buf[slot][0] = (char)vk; buf[slot][1] = 0; }
    else sprintf(buf[slot], "0x%02X", vk);
    return buf[slot];
}

static void LoadConfig() {
    char buf[64];
    GetPrivateProfileStringA("Trainer", "MenuKey", "F1", buf, sizeof(buf), g_iniPath);
    g_cfg.menuKey        = ParseKey(buf);
    g_cfg.blockKeyInGame = GetPrivateProfileIntA("Trainer", "BlockMenuKeyInGame", 1, g_iniPath) != 0;
    g_cfg.blockInput     = GetPrivateProfileIntA("Trainer", "BlockGameInputWhileOpen", 1, g_iniPath) != 0;
    g_cfg.startOpen      = GetPrivateProfileIntA("Trainer", "StartOpen", 0, g_iniPath) != 0;
    g_cfg.showToast      = GetPrivateProfileIntA("Trainer", "ShowStartupNote", 1, g_iniPath) != 0;
    GetPrivateProfileStringA("Trainer", "FontScale", "1.25", buf, sizeof(buf), g_iniPath);
    g_cfg.fontScale = (float)atof(buf);
    GetPrivateProfileStringA("Trainer", "MouseSpeed", "1.0", buf, sizeof(buf), g_iniPath);
    g_cfg.mouseSpeed = (float)atof(buf);
    if (g_cfg.mouseSpeed < 0.1f || g_cfg.mouseSpeed > 10.0f) g_cfg.mouseSpeed = 1.0f;
    if (g_cfg.fontScale < 0.5f || g_cfg.fontScale > 4.0f) g_cfg.fontScale = 1.25f;
    GetPrivateProfileStringA("Noclip", "Key", "N", buf, sizeof(buf), g_iniPath);
    g_cfg.noclipKey = ParseKey(buf, 'N');
    GetPrivateProfileStringA("Noclip", "Speed", "25", buf, sizeof(buf), g_iniPath);
    g_cfg.noclipSpeed = (float)atof(buf);
    if (g_cfg.noclipSpeed < 1.0f || g_cfg.noclipSpeed > 500.0f) g_cfg.noclipSpeed = 25.0f;
    GetPrivateProfileStringA("Noclip", "FastMultiplier", "3", buf, sizeof(buf), g_iniPath);
    g_cfg.noclipFast = (float)atof(buf);
    if (g_cfg.noclipFast < 1.0f || g_cfg.noclipFast > 20.0f) g_cfg.noclipFast = 3.0f;
}

static void SaveConfig() {
    char buf[32];
    WritePrivateProfileStringA("Trainer", "MenuKey", KeyToName(g_cfg.menuKey), g_iniPath);
    WritePrivateProfileStringA("Trainer", "BlockMenuKeyInGame", g_cfg.blockKeyInGame ? "1" : "0", g_iniPath);
    WritePrivateProfileStringA("Trainer", "BlockGameInputWhileOpen", g_cfg.blockInput ? "1" : "0", g_iniPath);
    WritePrivateProfileStringA("Trainer", "StartOpen", g_cfg.startOpen ? "1" : "0", g_iniPath);
    WritePrivateProfileStringA("Trainer", "ShowStartupNote", g_cfg.showToast ? "1" : "0", g_iniPath);
    sprintf(buf, "%.2f", g_cfg.fontScale);
    WritePrivateProfileStringA("Trainer", "FontScale", buf, g_iniPath);
    sprintf(buf, "%.2f", g_cfg.mouseSpeed);
    WritePrivateProfileStringA("Trainer", "MouseSpeed", buf, g_iniPath);
    WritePrivateProfileStringA("Noclip", "Key", KeyToName(g_cfg.noclipKey), g_iniPath);
    sprintf(buf, "%.1f", g_cfg.noclipSpeed);
    WritePrivateProfileStringA("Noclip", "Speed", buf, g_iniPath);
    sprintf(buf, "%.1f", g_cfg.noclipFast);
    WritePrivateProfileStringA("Noclip", "FastMultiplier", buf, g_iniPath);
}

// ---------------------------------------------------------------- safe memory access
static bool SafeRead(uintptr_t addr, void* out, size_t n) {
    __try { memcpy(out, reinterpret_cast<const void*>(addr), n); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}
template <typename T> static bool Read(uintptr_t addr, T& out) { return SafeRead(addr, &out, sizeof(T)); }

static bool SafeWrite32(uintptr_t addr, uint32_t v) {
    __try { *reinterpret_cast<volatile uint32_t*>(addr) = v; return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// Calls a game function under SEH so a bad call is logged instead of killing the game.
static bool CallVoid(uintptr_t fn, const char* what) {
    __try { reinterpret_cast<game::VoidFn>(fn)(); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in %s", GetExceptionCode(), what); return false; }
}

static bool CallToggleOption(int i) {
    __try { reinterpret_cast<game::ToggleOptFn>(game::kDebugOptToggle)(reinterpret_cast<void*>(game::kOptionsObj), i); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in ToggleDebugOption(%d)", GetExceptionCode(), i); return false; }
}

static bool g_sigOk[sizeof(game::kSigs) / sizeof(game::kSigs[0])];

static bool CheckSigs() {
    bool all = true;
    for (size_t i = 0; i < sizeof(game::kSigs) / sizeof(game::kSigs[0]); ++i) {
        const game::Sig& s = game::kSigs[i];
        uint8_t got[8] = {};
        g_sigOk[i] = SafeRead(s.addr, got, s.len) && memcmp(got, s.bytes, s.len) == 0;
        if (!g_sigOk[i]) {
            all = false;
            Log("signature mismatch: %s at 0x%08X (got %02X %02X %02X %02X ...)", s.name, (unsigned)s.addr,
                got[0], got[1], got[2], got[3]);
        }
    }
    return all;
}

static bool SigOk(uintptr_t addr) {
    for (size_t i = 0; i < sizeof(game::kSigs) / sizeof(game::kSigs[0]); ++i)
        if (game::kSigs[i].addr == addr) return g_sigOk[i];
    return false;
}

// ---------------------------------------------------------------- vtable patching
static void* PatchVtable(void** vt, int idx, void* fn) {
    DWORD old;
    if (!VirtualProtect(&vt[idx], sizeof(void*), PAGE_EXECUTE_READWRITE, &old)) return nullptr;
    void* orig = vt[idx];
    InterlockedExchangePointer(&vt[idx], fn);
    VirtualProtect(&vt[idx], sizeof(void*), old, &old);
    return orig;
}

// ---------------------------------------------------------------- state
static IDirect3DDevice9* g_device   = nullptr;
static HWND    g_hwnd        = nullptr;
static WNDPROC g_origWndProc = nullptr;
static bool    g_imguiReady  = false;
static volatile bool g_menuOpen = false;
static bool    g_keyWasDown  = false;
static DWORD   g_readyTick   = 0;
static int     g_menuDik     = 0;   // DirectInput scan code of the menu key

// Mouse fallback: if the game holds the mouse in DirectInput exclusive mode, Windows sends no mouse
// messages, so the menu cursor is driven from DirectInput deltas instead.
static volatile LONG g_diMouseDX = 0, g_diMouseDY = 0, g_diMouseWheel = 0;
static volatile LONG g_diMouseButtons = 0;   // bit i = button i down
static volatile bool g_diMouseSeen = false;  // DirectInput mouse data arrived while the menu was open
static ImVec2 g_virtualMouse(0, 0);

// Keyboard fallback: navigation keys read from the game's DirectInput keyboard, for when the window gets no
// WM_KEYDOWN messages. Bit i of g_diNavKeys = kNavKeys[i] held.
struct NavKey { int dik; ImGuiKey key; };
static const NavKey kNavKeys[] = {
    {DIK_UP, ImGuiKey_UpArrow}, {DIK_DOWN, ImGuiKey_DownArrow}, {DIK_LEFT, ImGuiKey_LeftArrow},
    {DIK_RIGHT, ImGuiKey_RightArrow}, {DIK_RETURN, ImGuiKey_Enter}, {DIK_NUMPADENTER, ImGuiKey_KeypadEnter},
    {DIK_SPACE, ImGuiKey_Space}, {DIK_ESCAPE, ImGuiKey_Escape}, {DIK_TAB, ImGuiKey_Tab},
    {DIK_PRIOR, ImGuiKey_PageUp}, {DIK_NEXT, ImGuiKey_PageDown}, {DIK_HOME, ImGuiKey_Home}, {DIK_END, ImGuiKey_End},
};
static const int kNumNavKeys = sizeof(kNavKeys) / sizeof(kNavKeys[0]);
static volatile LONG g_diNavKeys = 0;

// Per menu session diagnostics: which input paths delivered anything.
static volatile LONG g_wmKeyMsgs = 0, g_wmMouseMsgs = 0, g_diKbReads = 0, g_diKbBuffered = 0;
static volatile LONG g_diMouseReads = 0, g_diMouseBuffered = 0, g_diOtherSize = 0;

// ---------------------------------------------------------------- low-level mouse hook
// WH_MOUSE_LL sees the physical mouse no matter how the game reads it (DirectInput exclusive, raw input,
// cursor re-centring). While the menu is open and the game is the foreground window, it turns mouse motion
// and clicks into menu input and, with BlockGameInputWhileOpen, swallows them so the OS cursor stays put and
// the game doesn't react. It never swallows anything when another window is in front.
static HINSTANCE g_inst = nullptr;
static HHOOK g_llHook = nullptr;
static volatile LONG g_llDX = 0, g_llDY = 0, g_llEvents = 0, g_clicks = 0;
static volatile bool g_llSeen = false;

struct MouseEvt { int button; bool down; float wheel; };
static const int kMouseQueue = 64;
static MouseEvt g_mq[kMouseQueue];
static int g_mqHead = 0, g_mqCount = 0;
static SRWLOCK g_mqLock = SRWLOCK_INIT;

static void PushMouseEvt(int button, bool down, float wheel) {
    AcquireSRWLockExclusive(&g_mqLock);
    if (g_mqCount < kMouseQueue) { g_mq[(g_mqHead + g_mqCount) % kMouseQueue] = {button, down, wheel}; ++g_mqCount; }
    ReleaseSRWLockExclusive(&g_mqLock);
}

static bool GameIsForeground() {
    HWND f = GetForegroundWindow();
    if (!f) return false;
    DWORD pid = 0; GetWindowThreadProcessId(f, &pid);
    return pid == GetCurrentProcessId();
}

static LRESULT CALLBACK LowLevelMouseProc(int code, WPARAM wp, LPARAM lp) {
    if (code == HC_ACTION && g_menuOpen && GameIsForeground()) {
        const MSLLHOOKSTRUCT* m = reinterpret_cast<const MSLLHOOKSTRUCT*>(lp);
        g_llSeen = true;
        InterlockedIncrement(&g_llEvents);
        switch (wp) {
            case WM_MOUSEMOVE: {
                // m->pt is where the cursor would go; the cursor hasn't moved yet, so the difference is
                // this event's motion even if the game keeps re-centring the cursor.
                POINT cur;
                if (GetCursorPos(&cur)) {
                    InterlockedExchangeAdd(&g_llDX, m->pt.x - cur.x);
                    InterlockedExchangeAdd(&g_llDY, m->pt.y - cur.y);
                }
                break;
            }
            case WM_LBUTTONDOWN: PushMouseEvt(0, true, 0); break;
            case WM_LBUTTONUP:   PushMouseEvt(0, false, 0); break;
            case WM_RBUTTONDOWN: PushMouseEvt(1, true, 0); break;
            case WM_RBUTTONUP:   PushMouseEvt(1, false, 0); break;
            case WM_MBUTTONDOWN: PushMouseEvt(2, true, 0); break;
            case WM_MBUTTONUP:   PushMouseEvt(2, false, 0); break;
            case WM_MOUSEWHEEL:  PushMouseEvt(0, false, (float)(short)HIWORD(m->mouseData) / WHEEL_DELTA); break;
        }
        if (g_cfg.blockInput) return 1;
    }
    return CallNextHookEx(nullptr, code, wp, lp);
}

static DWORD WINAPI MouseHookThread(LPVOID) {
    g_llHook = SetWindowsHookExA(WH_MOUSE_LL, LowLevelMouseProc, g_inst, 0);
    if (!g_llHook) { Log("low-level mouse hook failed (error %lu); using DirectInput mouse only", GetLastError()); return 0; }
    Log("low-level mouse hook installed");
    MSG msg;
    while (GetMessageA(&msg, nullptr, 0, 0) > 0) {}  // the hook runs on this thread's message loop
    UnhookWindowsHookEx(g_llHook);
    return 0;
}

static void UpdateNavKey(int dik, bool down) {
    for (int i = 0; i < kNumNavKeys; ++i) {
        if (kNavKeys[i].dik != dik) continue;
        LONG m = g_diNavKeys;
        InterlockedExchange(&g_diNavKeys, down ? (m | (1 << i)) : (m & ~(1 << i)));
    }
}

static int VkToDik(int vk) {
    UINT sc = MapVirtualKeyA(vk, MAPVK_VK_TO_VSC_EX);
    if (!sc) return 0;
    return (int)((sc & 0xFF) | ((sc & 0xFF00) ? 0x80 : 0));
}

// ---------------------------------------------------------------- DirectInput hooks
typedef HRESULT (STDMETHODCALLTYPE* GetDeviceStateFn)(void* self, DWORD cb, LPVOID data);
typedef HRESULT (STDMETHODCALLTYPE* GetDeviceDataFn)(void* self, DWORD cb, LPDIDEVICEOBJECTDATA rg, LPDWORD n, DWORD fl);
typedef HRESULT (STDMETHODCALLTYPE* GetCapsFn)(void* self, LPDIDEVCAPS caps);

struct DiVtable { void** vt; GetDeviceStateFn gds; GetDeviceDataFn gdd; };
static DiVtable g_diVt[2];  // [0] = ANSI interface, [1] = wide interface (dinput8 has a vtable for each)
static int g_diVtCount = 0;

static const DiVtable* FindDiVt(void* self) {
    void** vt = *reinterpret_cast<void***>(self);
    for (int i = 0; i < g_diVtCount; ++i) if (g_diVt[i].vt == vt) return &g_diVt[i];
    return nullptr;
}

// Remembers each device's type so buffered reads can be classified (keyboard vs mouse).
struct DevType { void* dev; BYTE type; };
static DevType g_devTypes[16];
static int g_devTypeCount = 0;

static BYTE DeviceType(void* self) {
    for (int i = 0; i < g_devTypeCount; ++i) if (g_devTypes[i].dev == self) return g_devTypes[i].type;
    DIDEVCAPS caps = {}; caps.dwSize = sizeof(caps);
    void** vt = *reinterpret_cast<void***>(self);
    BYTE type = 0;
    if (SUCCEEDED(reinterpret_cast<GetCapsFn>(vt[3])(self, &caps))) type = (BYTE)(caps.dwDevType & 0xFF);
    if (g_devTypeCount < 16) g_devTypes[g_devTypeCount++] = {self, type};
    return type;
}

// ---------------------------------------------------------------- noclip input
// While noclip is on (and the menu is closed), the movement keys and the left/right mouse buttons are read
// here and hidden from the game; mouse motion still reaches it, so the camera turns as usual.
static volatile bool g_noclip = false;
static int g_noclipDik = 0;  // DirectInput scan code of the noclip key (0 for mouse buttons)
enum NoclipIn { NC_FWD = 1, NC_BACK = 2, NC_LEFT = 4, NC_RIGHT = 8, NC_UP = 16, NC_DOWN = 32, NC_FAST = 64 };
static volatile LONG g_ncKeys = 0;   // from the keyboard
static volatile LONG g_ncMouse = 0;  // from the mouse (NC_UP = left button, NC_DOWN = right button)
static const BYTE kNoclipBlock[] = {DIK_W, DIK_A, DIK_S, DIK_D, DIK_UP, DIK_DOWN, DIK_LEFT, DIK_RIGHT, DIK_SPACE};

static HRESULT STDMETHODCALLTYPE HkGetDeviceState(void* self, DWORD cb, LPVOID data) {
    const DiVtable* v = FindDiVt(self);
    if (!v) return DIERR_GENERIC;
    HRESULT hr = v->gds(self, cb, data);
    if (FAILED(hr) || !data) return hr;
    if (cb == 256) {  // keyboard
        BYTE* keys = static_cast<BYTE*>(data);
        if (g_menuOpen) {
            InterlockedIncrement(&g_diKbReads);
            LONG m = 0;
            for (int i = 0; i < kNumNavKeys; ++i) if (keys[kNavKeys[i].dik] & 0x80) m |= 1 << i;
            InterlockedExchange(&g_diNavKeys, m);
        }
        if (g_noclip && !g_menuOpen) {
            LONG k = 0;
            if ((keys[DIK_W] | keys[DIK_UP]) & 0x80) k |= NC_FWD;
            if ((keys[DIK_S] | keys[DIK_DOWN]) & 0x80) k |= NC_BACK;
            if ((keys[DIK_A] | keys[DIK_LEFT]) & 0x80) k |= NC_LEFT;
            if ((keys[DIK_D] | keys[DIK_RIGHT]) & 0x80) k |= NC_RIGHT;
            if ((keys[DIK_LSHIFT] | keys[DIK_RSHIFT]) & 0x80) k |= NC_FAST;
            InterlockedExchange(&g_ncKeys, k);
            for (BYTE dik : kNoclipBlock) keys[dik] = 0;
        }
        if (g_noclipDik) keys[g_noclipDik] = 0;
        if (g_menuOpen && g_cfg.blockInput) memset(keys, 0, 256);
        else if (g_cfg.blockKeyInGame && g_menuDik) keys[g_menuDik] = 0;
    } else if (cb == sizeof(DIMOUSESTATE) || cb == sizeof(DIMOUSESTATE2)) {  // mouse
        if (g_noclip && !g_menuOpen) {
            DIMOUSESTATE* m = static_cast<DIMOUSESTATE*>(data);
            LONG b = 0;
            if (m->rgbButtons[0] & 0x80) b |= NC_UP;
            if (m->rgbButtons[1] & 0x80) b |= NC_DOWN;
            InterlockedExchange(&g_ncMouse, b);
            m->rgbButtons[0] = m->rgbButtons[1] = 0;  // no attacks while flying
        }
        if (g_menuOpen) {
            InterlockedIncrement(&g_diMouseReads);
            DIMOUSESTATE* m = static_cast<DIMOUSESTATE*>(data);
            InterlockedExchangeAdd(&g_diMouseDX, m->lX);
            InterlockedExchangeAdd(&g_diMouseDY, m->lY);
            InterlockedExchangeAdd(&g_diMouseWheel, m->lZ);
            LONG b = 0;
            for (int i = 0; i < 3; ++i) if (m->rgbButtons[i] & 0x80) b |= 1 << i;
            InterlockedExchange(&g_diMouseButtons, b);
            if (m->lX || m->lY) g_diMouseSeen = true;
            if (g_cfg.blockInput) memset(data, 0, cb);
        }
    } else if (g_menuOpen) {
        InterlockedExchange(&g_diOtherSize, (LONG)cb);  // a device type we don't handle (pad?)
    }
    return hr;
}

static HRESULT STDMETHODCALLTYPE HkGetDeviceData(void* self, DWORD cb, LPDIDEVICEOBJECTDATA rg, LPDWORD n, DWORD fl) {
    const DiVtable* v = FindDiVt(self);
    if (!v) return DIERR_GENERIC;
    HRESULT hr = v->gdd(self, cb, rg, n, fl);
    if (FAILED(hr) || !rg || !n || (fl & DIGDD_PEEK)) return hr;
    BYTE type = DeviceType(self);
    if (type == DI8DEVTYPE_KEYBOARD) {
        if (g_menuOpen) {
            if (*n) InterlockedIncrement(&g_diKbBuffered);
            for (DWORD r = 0; r < *n; ++r) {
                auto* item = reinterpret_cast<DIDEVICEOBJECTDATA*>(reinterpret_cast<BYTE*>(rg) + r * cb);
                UpdateNavKey((int)item->dwOfs, (item->dwData & 0x80) != 0);
            }
        }
        if (g_menuOpen && g_cfg.blockInput) { *n = 0; return hr; }
        if (g_cfg.blockKeyInGame && g_menuDik) {  // drop the menu key's events, keep the rest
            DWORD w = 0;
            for (DWORD r = 0; r < *n; ++r) {
                auto* item = reinterpret_cast<DIDEVICEOBJECTDATA*>(reinterpret_cast<BYTE*>(rg) + r * cb);
                if ((int)item->dwOfs == g_menuDik) continue;
                if (w != r) memcpy(reinterpret_cast<BYTE*>(rg) + w * cb, item, cb);
                ++w;
            }
            *n = w;
        }
    } else if (type == DI8DEVTYPE_MOUSE && g_menuOpen) {
        if (*n) InterlockedIncrement(&g_diMouseBuffered);
        for (DWORD r = 0; r < *n; ++r) {
            auto* item = reinterpret_cast<DIDEVICEOBJECTDATA*>(reinterpret_cast<BYTE*>(rg) + r * cb);
            LONG val = (LONG)item->dwData;
            switch (item->dwOfs) {
                case DIMOFS_X: InterlockedExchangeAdd(&g_diMouseDX, val); g_diMouseSeen = true; break;
                case DIMOFS_Y: InterlockedExchangeAdd(&g_diMouseDY, val); g_diMouseSeen = true; break;
                case DIMOFS_Z: InterlockedExchangeAdd(&g_diMouseWheel, val); break;
                case DIMOFS_BUTTON0: case DIMOFS_BUTTON1: case DIMOFS_BUTTON2: {
                    int bit = 1 << (item->dwOfs - DIMOFS_BUTTON0);
                    LONG b = g_diMouseButtons;
                    InterlockedExchange(&g_diMouseButtons, (item->dwData & 0x80) ? (b | bit) : (b & ~bit));
                    break;
                }
            }
        }
        if (g_cfg.blockInput) *n = 0;
    }
    return hr;
}

static void InstallDInputHooks() {
    HMODULE di = GetModuleHandleA("dinput8.dll");
    if (!di) di = LoadLibraryA("dinput8.dll");
    typedef HRESULT (WINAPI* CreateFn)(HINSTANCE, DWORD, REFIID, LPVOID*, LPUNKNOWN);
    CreateFn create = di ? reinterpret_cast<CreateFn>(GetProcAddress(di, "DirectInput8Create")) : nullptr;
    if (!create) { Log("DirectInput8Create not found; input blocking disabled"); return; }

    const IID* iids[2] = {&IID_IDirectInput8A, &IID_IDirectInput8W};
    for (int k = 0; k < 2; ++k) {
        IUnknown* dinput = nullptr;
        if (FAILED(create(GetModuleHandleA(nullptr), DIRECTINPUT_VERSION, *iids[k], (LPVOID*)&dinput, nullptr)) || !dinput) {
            Log("DirectInput8Create (%s) failed", k ? "W" : "A");
            continue;
        }
        // CreateDevice is slot 3 on both interfaces; the GUID argument is the same.
        typedef HRESULT (STDMETHODCALLTYPE* CreateDevFn)(void*, REFGUID, void**, LPUNKNOWN);
        void** dvt = *reinterpret_cast<void***>(dinput);
        void* dev = nullptr;
        if (SUCCEEDED(reinterpret_cast<CreateDevFn>(dvt[3])(dinput, GUID_SysKeyboard, &dev, nullptr)) && dev) {
            void** vt = *reinterpret_cast<void***>(dev);
            bool dup = false;
            for (int i = 0; i < g_diVtCount; ++i) if (g_diVt[i].vt == vt) dup = true;
            if (!dup && g_diVtCount < 2) {
                DiVtable& e = g_diVt[g_diVtCount];
                e.vt  = vt;
                e.gds = reinterpret_cast<GetDeviceStateFn>(vt[9]);
                e.gdd = reinterpret_cast<GetDeviceDataFn>(vt[10]);
                ++g_diVtCount;  // publish before patching, so the hooks can find their originals
                PatchVtable(vt, 9, reinterpret_cast<void*>(&HkGetDeviceState));
                PatchVtable(vt, 10, reinterpret_cast<void*>(&HkGetDeviceData));
                Log("DirectInput device hooks installed (%s vtable %p)", k ? "W" : "A", vt);
            }
            reinterpret_cast<IUnknown*>(dev)->Release();
        }
        dinput->Release();
    }
}

// ---------------------------------------------------------------- window procedure
static bool IsInputMsg(UINT msg) {
    return (msg >= WM_KEYFIRST && msg <= WM_KEYLAST) || (msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) ||
           msg == WM_INPUT;
}

static LRESULT CALLBACK HkWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if ((msg == WM_KEYDOWN || msg == WM_KEYUP || msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP) &&
        (((int)wp == g_cfg.menuKey && g_cfg.blockKeyInGame) || (int)wp == g_cfg.noclipKey))
        return 0;
    if (g_imguiReady && g_menuOpen) {
        if (msg >= WM_KEYFIRST && msg <= WM_KEYLAST) InterlockedIncrement(&g_wmKeyMsgs);
        if (msg >= WM_MOUSEFIRST && msg <= WM_MOUSELAST) InterlockedIncrement(&g_wmMouseMsgs);
        if (ImGui_ImplWin32_WndProcHandler(hwnd, msg, wp, lp)) return 1;
        if (g_cfg.blockInput && IsInputMsg(msg)) return 0;
    }
    return CallWindowProcA(g_origWndProc, hwnd, msg, wp, lp);
}

// ---------------------------------------------------------------- menu
static uint32_t Flags() { uint32_t f = 0; Read(game::kCheatFlags, f); return f; }

// A checkbox that shows the game's real state and calls the game's toggle when clicked.
static void ToggleRow(const char* label, bool on, uintptr_t fn, const char* help) {
    bool ok = SigOk(fn);
    ImGui::BeginDisabled(!ok);
    bool v = on;
    if (ImGui::Checkbox(label, &v) && v != on) {
        Log("toggle %s -> %d", label, v ? 1 : 0);
        CallVoid(fn, label);
    }
    ImGui::EndDisabled();
    if (help && ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
        ImGui::SetTooltip("%s%s", ok ? "" : "[unavailable: code bytes don't match this exe]\n", help);
}

static void DrawDebugMenu() {
    uint32_t f = Flags();
    uint8_t hud = 0; Read(game::kHudOn, hud);
    uint32_t fly = 0; Read(game::kFlyCamera, fly);

    ImGui::SeparatorText("Game debug menu");
    ToggleRow("God mode", (f & game::kFlagGodMode) != 0, game::kToggleGodMode, "The game's own invincibility cheat.");
    ToggleRow("Fly camera", fly != 0, game::kToggleFlyCamera, "Detached free camera (the game's debug fly cam).");
    ToggleRow("HUD", hud != 0, game::kToggleHUD, "Show or hide the in-game HUD.");
    ToggleRow("Vibration", (f & game::kFlagVibration) != 0, game::kToggleVibration, "Controller rumble.");
    ToggleRow("Sound effects", (f & game::kFlagSfxOff) == 0, game::kToggleSFX, "Mute or unmute sound effects.");
    ToggleRow("Music", (f & game::kFlagMusicOff) == 0, game::kToggleMusic, "Mute or unmute music.");

    uint32_t sens = 0; Read(game::kCamSens, sens);
    ImGui::BeginDisabled(!SigOk(game::kToggleCamSens));
    if (ImGui::Button("Cycle")) { Log("cycle camera sensitivity"); CallVoid(game::kToggleCamSens, "ToggleCameraSensitivity"); }
    ImGui::EndDisabled();
    ImGui::SameLine(); ImGui::Text("Camera sensitivity: %u", sens);

    uint8_t asp = 0; Read(game::kAspectFlags, asp);
    ImGui::BeginDisabled(!SigOk(game::kToggleAspect));
    if (ImGui::Button("Toggle")) { Log("toggle aspect ratio"); CallVoid(game::kToggleAspect, "ToggleAspectRatio"); }
    ImGui::EndDisabled();
    ImGui::SameLine(); ImGui::Text("Aspect ratio mode: %s", (asp & 0x18) ? "alternate (likely widescreen)" : "default");
}

static void DrawEngineOptions() {
    ImGui::SeparatorText("Engine debug options");
    bool ok = SigOk(game::kDebugOptToggle) && SigOk(game::kDebugOptNames);
    uint32_t f = Flags();
    ImGui::BeginDisabled(!ok);
    for (int i = 0; i < game::kNumDebugOpts; ++i) {
        char name[64] = "?";
        uintptr_t p = 0;
        if (Read(game::kDebugOptNames + 4 * i, p) && p) {
            SafeRead(p, name, sizeof(name) - 1);
            name[sizeof(name) - 1] = 0;
            for (int j = (int)strlen(name) - 1; j >= 0 && name[j] == ' '; --j) name[j] = 0;  // trim
        }
        bool on = (f & game::kDebugOptBits[i]) != 0, v = on;
        ImGui::PushID(i);
        if (ImGui::Checkbox(name, &v) && v != on) {
            Log("debug option %d (%s) -> %d", i, name, v ? 1 : 0);
            CallToggleOption(i);
        }
        ImGui::PopID();
    }
    ImGui::EndDisabled();
    if (!ok) ImGui::TextDisabled("Unavailable: code bytes don't match this exe.");
}

static void DrawLevel() {
    ImGui::SeparatorText("Level (experimental)");
    ImGui::BeginDisabled(!SigOk(game::kSetLevelComplete));
    if (ImGui::Button("Complete current level...")) ImGui::OpenPopup("confirm_complete");
    ImGui::EndDisabled();
    if (ImGui::BeginPopupModal("confirm_complete", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::TextUnformatted("Calls the game's SetLevelComplete debug action.\n"
                               "Not tested yet: it may behave oddly mid-mission. Save first.");
        if (ImGui::Button("Do it")) { Log("SetLevelComplete"); CallVoid(game::kSetLevelComplete, "SetLevelComplete"); ImGui::CloseCurrentPopup(); }
        ImGui::SameLine();
        if (ImGui::Button("Cancel")) ImGui::CloseCurrentPopup();
        ImGui::EndPopup();
    }
}

// ---------------------------------------------------------------- character select
// Names handed to the game must stay valid for the whole session (the level keeps the pointer for respawns),
// so each name is copied once into this pool and never freed.
static char g_namePool[256][48];
static int  g_namePoolCount = 0;

static const char* InternName(const char* s) {
    for (int i = 0; i < g_namePoolCount; ++i) if (strcmp(g_namePool[i], s) == 0) return g_namePool[i];
    if (g_namePoolCount >= 256) return nullptr;
    strncpy(g_namePool[g_namePoolCount], s, 47);
    g_namePool[g_namePoolCount][47] = 0;
    return g_namePool[g_namePoolCount++];
}

static bool ReadName(uintptr_t strPtr, char* out, size_t n) {
    if (!strPtr || !SafeRead(strPtr, out, n - 1)) return false;
    out[n - 1] = 0;
    return out[0] != 0;
}

static bool ReadTypeName(uintptr_t rec, char* out, size_t n) {
    uintptr_t p = 0;
    return rec && Read(rec + game::kTypeName, p) && ReadName(p, out, n);
}

static const char* g_swapName = nullptr;   // pending request we wrote
static uintptr_t   g_swapOldPlayer = 0;
static DWORD       g_swapTick = 0;
static char        g_swapStatus[128] = "";

static bool SwapAvailable() {
    return SigOk(game::kSwapPlayer) && SigOk(game::kSwapPoll) && SigOk(game::kFindCreatureType);
}

// Model state of a type in this level (see game::kTypeModel):
//   0 = not registered (the level's CREATURES.CFG doesn't include it: it can't be loaded),
//   1 = registered but not in memory (the creature cache can load it), 2 = resident.
static int TypeModelState(uintptr_t rec) {
    uintptr_t model = 0; uint16_t parts = 0;
    if (!rec || !Read(rec + game::kTypeModel, model) || !model) return 0;
    return Read(model + game::kModelParts, parts) && parts != 0 ? 2 : 1;
}

static uintptr_t FindTypeRecord(const char* name) {
    int32_t count = 0;
    Read(game::kCreatureCount, count);
    if (count < 0 || count > game::kMaxCreatures) return 0;
    for (int i = 0; i < count; ++i) {
        uintptr_t rec = 0; char n[48];
        if (Read(game::kCreatureTable + 4 * i, rec) && ReadTypeName(rec, n, sizeof(n)) && _stricmp(n, name) == 0) return rec;
    }
    return 0;
}

// A robot and the types it needs to play and transform: its vehicle ("<name>Car", "Veh" or "Heli") and its
// transform model ("<name>Tran"), when they exist.
struct Family { uintptr_t rec[3]; char name[3][48]; int n; };

static Family GetFamily(uintptr_t rec, const char* name) {
    Family f = {};
    f.rec[0] = rec; strncpy(f.name[0], name, 47); f.n = 1;
    static const char* veh[] = {"Car", "Veh", "Heli"};
    char buf[64];
    for (const char* s : veh) {
        sprintf(buf, "%.40s%s", name, s);
        if (uintptr_t r = FindTypeRecord(buf)) { f.rec[f.n] = r; ReadTypeName(r, f.name[f.n], 48); ++f.n; break; }
    }
    sprintf(buf, "%.40sTran", name);
    if (uintptr_t r = FindTypeRecord(buf)) { f.rec[f.n] = r; ReadTypeName(r, f.name[f.n], 48); ++f.n; }
    return f;
}

// Lowest model state across the family (0 = some part can't be loaded in this level).
static int FamilyState(const Family& f) {
    int s = 2;
    for (int i = 0; i < f.n; ++i) { int t = TypeModelState(f.rec[i]); if (t < s) s = t; }
    return s;
}

static const char* NotPlayableReason(uintptr_t rec, const char* name) {
    return FamilyState(GetFamily(rec, name)) == 0 ? "not in this level's CREATURES.CFG" : nullptr;
}

// Set while a LoadCreature call is running, for the watchdog: the call can block forever inside the game
// (its creature-load wait, Sleep(10) loop at 0x473050) when the background loader never finishes.
static volatile const char* g_inLoadCall = nullptr;
static volatile DWORD g_lastFrameTick = 0;

// Queues a creature load the way the script "#LoadCreature=X" does; the game loads it on a later frame
// behind its own short loading screen (see game::kQueueLoad).
static bool CallQueueLoad(const char* name) {
    __try { reinterpret_cast<game::QueueLoadFn>(game::kQueueLoad)(reinterpret_cast<void*>(game::kSwapper), name); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in QueueLoad(%s)", GetExceptionCode(), name); return false; }
}

// Resets the player camera after a swap, the way the game does after it teleports the player (see
// game::kCamReset). Only runs when [0x770610] really is the player camera.
static void ResetPlayerCamera() {
    if (!SigOk(game::kCamReset) || !SigOk(game::kCamFaceHeading)) return;
    uintptr_t cam = 0, vt = 0, slot15 = 0, pl = 0;
    if (!Read(game::kPlayerCamPtr, cam) || !cam || !Read(cam, vt) || !Read(game::kPlayerPtr, pl) || !pl) {
        Log("camera reset skipped (camera %08X, player %08X)", (unsigned)cam, (unsigned)pl);
        return;
    }
    Read(vt + 15 * 4, slot15);
    if (vt != game::kPlayerCamVtbl || slot15 != game::kCamReset) {
        Log("camera reset skipped: [0x770610] isn't the player camera (vtable %08X, slot 15 %08X)", (unsigned)vt, (unsigned)slot15);
        return;
    }
    __try {
        reinterpret_cast<game::CamResetFn>(slot15)(reinterpret_cast<void*>(cam));
        reinterpret_cast<game::CamResetFn>(game::kCamFaceHeading)(reinterpret_cast<void*>(cam));
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in camera reset", GetExceptionCode()); return; }
    Log("camera reset after swap");
}

static bool CallQueueFree(const char* name) {
    __try { reinterpret_cast<game::QueueLoadFn>(game::kQueueFree)(reinterpret_cast<void*>(game::kSwapper), name); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in QueueFree(%s)", GetExceptionCode(), name); return false; }
}

// True when the game has no creature load or unload queued or running.
static bool LoadQueueIdle() {
    uint8_t busy = 1; uint32_t nl = 1, nf = 1;
    return Read(game::kSwapperBusy, busy) && Read(game::kQueueLoadCount, nl) && Read(game::kQueueFreeCount, nf) &&
           busy == 0 && nl == 0 && nf == 0;
}

// Watchdog thread: logs when the game stops drawing frames, and whether a creature load was running.
static DWORD WINAPI WatchdogThread(LPVOID) {
    bool reported = false;
    for (;;) {
        Sleep(1000);
        DWORD last = g_lastFrameTick;
        if (!last) continue;
        DWORD idle = GetTickCount() - last;
        if (idle > 20000 && !reported) {
            const char* n = (const char*)g_inLoadCall;
            if (n) Log("STUCK: no frames for %lu s while loading %s: the game's creature loader never "
                       "finished. Close the game with Task Manager.", idle / 1000, n);
            else Log("no frames for %lu s (loading screen, alt-tab or a hang)", idle / 1000);
            reported = true;
        } else if (idle < 2000) {
            reported = false;
        }
    }
}

static const char* g_loadName = nullptr;   // waiting for the cache to load this family, then swap
static DWORD       g_loadTick = 0;

// Characters the trainer loaded into the creature cache, with exactly the parts it queued. Released (queued
// for unloading) after a swap, once you're no longer playing them, so the cache doesn't fill up.
struct TrainerLoad { char root[48]; char part[3][48]; int n; };
static TrainerLoad g_loads[8];
static int  g_loadCount = 0;
static bool g_releasePending = false;

static TrainerLoad* FindLoad(const char* root) {
    for (int i = 0; i < g_loadCount; ++i) if (_stricmp(g_loads[i].root, root) == 0) return &g_loads[i];
    return nullptr;
}

// True if the level keeps this type loaded itself (LEVEL.CFG CREATURE list, levelinfo +0xC14).
static bool LevelKeepsLoaded(const char* name) {
    uintptr_t info = 0; uint32_t n = 0;
    if (!Read(game::kLevelInfoPtr, info) || !info || !Read(info + 0xC10, n) || n > 64) return false;
    for (uint32_t i = 0; i < n; ++i) {
        uintptr_t p = 0; char nm[48];
        if (Read(info + 0xC14 + 4 * i, p) && ReadName(p, nm, sizeof(nm)) && _stricmp(nm, name) == 0) return true;
    }
    return false;
}

static void CurrentPlayerType(char* out, size_t n) {
    uintptr_t pl = 0, rec = 0;
    out[0] = 0;
    if (Read(game::kPlayerPtr, pl) && pl && Read(pl + game::kTypeRecord, rec)) ReadTypeName(rec, out, n);
}

// Queues unloads for trainer-loaded characters you're no longer playing. Runs after swaps, once the game's
// load queue is idle (it never frees the model you're playing: the swap has already replaced you).
static char g_loadsLevel[48] = "";  // the level the entries in g_loads belong to
static bool CurrentLevelName(char* out, size_t n);

// Combat hub opponents (see DrawOpponents). Declared here so the release code below never frees the model of the
// opponent that's alive, nor anything while an opponent is loading or about to spawn.
static const char* g_oppName = nullptr;      // opponent currently spawned by the trainer
static const char* g_oppLoadName = nullptr;  // waiting for this family to load, then spawn
static const char* g_oppPending = nullptr;   // loaded; spawn state fires at g_oppSpawnAt
static DWORD g_releaseNotBefore = 0;         // release waits until the old opponent is gone

static void ReleaseUnusedLoads() {
    char lvl[48] = "";
    CurrentLevelName(lvl, sizeof(lvl));
    if (g_loadCount && _stricmp(lvl, g_loadsLevel) != 0) {  // new level: its cache started empty, forget them
        Log("level changed: forgetting %d trainer-loaded characters", g_loadCount);
        g_loadCount = 0;
        g_releasePending = false;
    }
    strcpy(g_loadsLevel, lvl);
    if (!g_releasePending || g_loadName || g_swapName || g_oppLoadName || g_oppPending) return;
    if (GetTickCount() < g_releaseNotBefore) return;
    if (!SigOk(game::kQueueFree) || !SigOk(game::kQueueFreeStore)) { g_releasePending = false; return; }
    if (!LoadQueueIdle()) return;  // try again next frame
    char cur[48];
    CurrentPlayerType(cur, sizeof(cur));
    if (!cur[0]) return;
    for (int i = 0; i < g_loadCount;) {
        TrainerLoad& L = g_loads[i];
        if (_stricmp(L.root, cur) == 0 || LevelKeepsLoaded(L.root) || (g_oppName && _stricmp(L.root, g_oppName) == 0)) { ++i; continue; }
        for (int k = 0; k < L.n; ++k) {
            Log("releasing %s (loaded by the trainer, no longer played)", L.part[k]);
            CallQueueFree(L.part[k]);
        }
        g_loads[i] = g_loads[--g_loadCount];
    }
    g_releasePending = false;
}

static void StartSwap(const char* name) {
    uintptr_t cur = 0, pl = 0;
    if (!Read(game::kSwapRequest, cur) || !Read(game::kPlayerPtr, pl)) return;
    if (cur) { sprintf(g_swapStatus, "The game already has a swap pending."); return; }
    if (!pl) { sprintf(g_swapStatus, "No player character right now."); return; }
    g_swapOldPlayer = pl;
    g_swapName = name;
    g_swapTick = GetTickCount();
    SafeWrite32(game::kSwapRequest, (uint32_t)(uintptr_t)name);
    sprintf(g_swapStatus, "Swapping to %s...", name);
    Log("character swap requested: %s (old player %08X)", name, (unsigned)pl);
}

static void RequestSwap(const char* typeName) {
    uintptr_t rec = FindTypeRecord(typeName);
    if (!rec) { sprintf(g_swapStatus, "%.40s isn't a creature type.", typeName); return; }
    Family f = GetFamily(rec, typeName);
    int state = FamilyState(f);
    if (state == 0) {
        sprintf(g_swapStatus, "Can't play as %.40s: not in this level's CREATURES.CFG.", typeName);
        Log("character swap refused: %s (not registered in this level)", typeName);
        return;
    }
    const char* name = InternName(typeName);
    if (!name) return;
    char cur[48];
    CurrentPlayerType(cur, sizeof(cur));
    if (_stricmp(cur, typeName) == 0) { sprintf(g_swapStatus, "You're already playing as %s.", name); return; }
    if (state == 2) { StartSwap(name); return; }
    if (g_releasePending) { sprintf(g_swapStatus, "Freeing the last character first; try again in a moment."); return; }
    // Registered but not in memory: queue every missing part with the game's own mid-level loader, then swap
    // once they're in. The game shows its loading screen for a moment while it loads them.
    if (!SigOk(game::kQueueLoad)) { sprintf(g_swapStatus, "%s isn't loaded, and loading is unavailable on this exe.", name); return; }
    if (!LoadQueueIdle()) { sprintf(g_swapStatus, "The game is already loading creatures; try again in a moment."); return; }
    if (!SigOk(game::kQueueLoadStore)) { sprintf(g_swapStatus, "Loading is unavailable on this exe."); return; }
    for (int i = 0; i < f.n; ++i)
        if (strlen(f.name[i]) > 31) { sprintf(g_swapStatus, "%s: name too long for the game's load queue.", f.name[i]); return; }
    TrainerLoad* L = FindLoad(name);
    if (!L && g_loadCount < 8) { L = &g_loads[g_loadCount++]; memset(L, 0, sizeof(*L)); strncpy(L->root, name, 47); }
    for (int i = 0; i < f.n; ++i) {
        if (TypeModelState(f.rec[i]) == 2) continue;
        Log("queueing %s for loading", f.name[i]);
        if (!CallQueueLoad(f.name[i])) { sprintf(g_swapStatus, "Queueing %s failed (see log).", f.name[i]); return; }
        if (L) {  // remember each part we queued (once), so exactly those get freed later
            bool have = false;
            for (int k = 0; k < L->n; ++k) if (_stricmp(L->part[k], f.name[i]) == 0) have = true;
            if (!have && L->n < 3) strncpy(L->part[L->n++], f.name[i], 47);
        }
    }
    g_loadName = name;
    g_inLoadCall = name;  // for the watchdog
    g_loadTick = GetTickCount();
    sprintf(g_swapStatus, "Loading %s...", name);
}

// Runs every frame: finishes a load-then-swap, reports when the game has done a swap, and cancels either if
// the game doesn't get there in time.
static void UpdateSwap() {
    ReleaseUnusedLoads();
    if (g_loadName) {
        uintptr_t rec = FindTypeRecord(g_loadName);
        int state = rec ? FamilyState(GetFamily(rec, g_loadName)) : 0;
        if (state == 2) {
            Log("%s loaded after %lu ms", g_loadName, GetTickCount() - g_loadTick);
            g_inLoadCall = nullptr;
            const char* n = g_loadName; g_loadName = nullptr;
            StartSwap(n);
        } else if (GetTickCount() - g_loadTick > 30000) {
            uint32_t nl = 0; uint8_t busy = 0;
            Read(game::kQueueLoadCount, nl); Read(game::kSwapperBusy, busy);
            Log("%s didn't load within 30 s (queue %u, busy %u; cache full?)", g_loadName, nl, busy);
            sprintf(g_swapStatus, "%s didn't load within 30 s (the level's creature cache may be full).", g_loadName);
            g_inLoadCall = nullptr;
            g_loadName = nullptr;
        }
        return;
    }
    if (!g_swapName) return;
    uintptr_t req = 0, pl = 0;
    Read(game::kSwapRequest, req);
    Read(game::kPlayerPtr, pl);
    if (req == 0) {
        Log("character swap done: %s, player %08X -> %08X", g_swapName, (unsigned)g_swapOldPlayer, (unsigned)pl);
        sprintf(g_swapStatus, "Now playing as %s.", g_swapName);
        g_swapName = nullptr;
        g_releasePending = g_loadCount > 0;
        ResetPlayerCamera();
    } else if (GetTickCount() - g_swapTick > 5000) {
        if (req == (uintptr_t)g_swapName) SafeWrite32(game::kSwapRequest, 0);
        Log("character swap to %s not picked up within 5 s; cancelled", g_swapName);
        sprintf(g_swapStatus, "The game didn't swap (loading or cutscene?). Cancelled.");
        g_swapName = nullptr;
    }
}

static void DrawCharacterSelect() {
    ImGui::SeparatorText("Character select");
    if (!SwapAvailable()) { ImGui::TextDisabled("Unavailable: code bytes don't match this exe."); return; }

    uintptr_t pl = 0, plRec = 0;
    char curName[48] = "-";
    if (Read(game::kPlayerPtr, pl) && pl && Read(pl + game::kTypeRecord, plRec)) ReadTypeName(plRec, curName, sizeof(curName));
    ImGui::Text("Playing as: %s", pl ? curName : "(no player)");

    static bool transformersOnly = true;
    static bool loadedOnly = true;
    static char filter[32] = "";
    static int selected = -1;
    ImGui::Checkbox("Transformers only", &transformersOnly);
    ImGui::SameLine();
    ImGui::Checkbox("In this level", &loadedOnly);
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Only creatures this level's CREATURES.CFG includes. Those can be played: ones not in\n"
                          "memory yet are loaded through the level's creature cache first. The others have no\n"
                          "model in this level and can't be played (it would crash).");
    ImGui::SetNextItemWidth(-FLT_MIN);
    ImGui::InputTextWithHint("##filter", "filter by name", filter, sizeof(filter));

    int32_t count = 0;
    Read(game::kCreatureCount, count);
    if (count < 0 || count > game::kMaxCreatures) count = 0;

    char selName[48] = "";
    float rows = 8.0f;
    if (ImGui::BeginListBox("##creatures", ImVec2(-FLT_MIN, rows * ImGui::GetTextLineHeightWithSpacing()))) {
        int shown = 0;
        for (int i = 0; i < count; ++i) {
            uintptr_t rec = 0;
            char name[48];
            if (!Read(game::kCreatureTable + 4 * i, rec) || !ReadTypeName(rec, name, sizeof(name))) continue;
            uint32_t ab = 0; Read(rec + game::kTypeAbilities, ab);
            bool isTf = (ab & game::kAbilityTransform) != 0;
            if (transformersOnly && !isTf) continue;
            if (filter[0]) {
                char a[48], b[32];
                strcpy(a, name); strcpy(b, filter); _strlwr(a); _strlwr(b);
                if (!strstr(a, b)) continue;
            }
            int state = FamilyState(GetFamily(rec, name));
            const char* why = state == 0 ? "not in this level's CREATURES.CFG" : nullptr;
            if (loadedOnly && why) continue;
            ++shown;
            char label[128];
            const char* tag = rec == plRec ? "   (current)" : why ? "   - " : state == 1 ? "   (loads when picked)" : "";
            sprintf(label, "%s%s%s##%d", name, tag, why ? why : "", i);
            ImGui::BeginDisabled(why != nullptr);
            if (ImGui::Selectable(label, selected == i, ImGuiSelectableFlags_AllowDoubleClick)) {
                selected = i;
                if (ImGui::IsMouseDoubleClicked(0) && pl && !g_swapName && !g_loadName) RequestSwap(name);
            }
            ImGui::EndDisabled();
            if (selected == i && !why) strcpy(selName, name);
        }
        if (!shown) ImGui::TextDisabled(count ? "Nothing matches." : "No creatures loaded (menu or loading).");
        ImGui::EndListBox();
    }

    ImGui::BeginDisabled(!selName[0] || !pl || g_swapName != nullptr || g_loadName != nullptr);
    char btn[80]; sprintf(btn, "Play as %s", selName[0] ? selName : "...");
    if (ImGui::Button(btn)) RequestSwap(selName);
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
        ImGui::SetTooltip("Swaps you into the selected creature where you stand (double-click works too).\n"
                          "If it isn't in memory, the level's creature cache loads it (robot, vehicle and\n"
                          "transform) first, the same call level loading uses. Experimental: save first.");
    if (g_swapStatus[0]) ImGui::TextWrapped("%s", g_swapStatus);
}

// ---------------------------------------------------------------- level + chapter select
static bool LevelSelectAvailable() { return SigOk(game::kRequestLevel); }
static bool ChapterSelectAvailable() {
    return SigOk(game::kSendScriptMsg) && SigOk(game::kFindEvent) && SigOk(game::kFireEvent);
}

static bool CurrentLevelName(char* out, size_t n) {
    uintptr_t info = 0, name = 0;
    return Read(game::kLevelInfoPtr, info) && info && Read(info, name) && ReadName(name, out, n);
}

static int LevelCount() {
    uintptr_t mgr = 0; int32_t n = 0;
    if (!Read(game::kLevelMgrPtr, mgr) || !mgr || !Read(mgr + 4, n) || n < 0 || n > 256) return 0;
    return n;
}

static bool LevelName(int i, char* out, size_t n) {
    uintptr_t mgr = 0, name = 0;
    return Read(game::kLevelMgrPtr, mgr) && mgr && Read(mgr + 0x10 + 4 * i, name) && ReadName(name, out, n);
}

static void Localize(const char* id, char* out, size_t n) {
    out[0] = 0;
    if (!id || !SigOk(game::kLocalize)) return;
    const char* s = nullptr;
    __try { s = reinterpret_cast<game::LocalizeFn>(game::kLocalize)(id); }
    __except (EXCEPTION_EXECUTE_HANDLER) { s = nullptr; }
    if (s) ReadName(reinterpret_cast<uintptr_t>(s), out, n);
}

// ---- chapters, from the level's own scripts
// The exe's chapter table (0x713730, filled at 0x6797A0) is an unfinished stub: every level has 1 chapter whose
// id is "WorkInProgress", which the debug menu's MissionSelect refuses. The level scripts do support chapter
// jumps: LEVELS\<level>\AI\LEVEL1.SCP includes the hub (e.g. Auto1Hub.scp), and the hub's "state SkipLevel"
// jumps to ChapterN_InitGoto on message "MissionMessage" == N. So the chapter count comes from that state.
static const char* StrIStr(const char* h, const char* n) {
    size_t ln = strlen(n);
    for (; *h; ++h) if (_strnicmp(h, n, ln) == 0) return h;
    return nullptr;
}

static char* ReadWholeFile(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return nullptr;
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    if (n <= 0 || n > 4 * 1024 * 1024) { fclose(f); return nullptr; }
    char* buf = static_cast<char*>(malloc(n + 1));
    if (buf) { buf[fread(buf, 1, n, f)] = 0; }
    fclose(f);
    return buf;
}

// Calls fn(line) for each line with leading whitespace and anything after ';' removed; stops if fn returns false.
template <typename F> static void ForEachLine(char* text, F fn) {
    for (char* p = text; p && *p;) {
        char* e = strpbrk(p, "\r\n");
        char save = 0;
        if (e) { save = *e; *e = 0; }
        char* s = p; while (*s == ' ' || *s == '\t') ++s;
        if (char* c = strchr(s, ';')) *c = 0;
        bool go = fn(s);
        if (e) *e = save;
        if (!go || !e) break;
        p = e + 1;
    }
}

struct LevelChapters { char level[48]; int count; char hub[48]; };
static LevelChapters g_chapters[40];
static int g_chapterN = 0;

static int ScriptChapters(const char* level, const char** hubOut = nullptr) {
    for (int i = 0; i < g_chapterN; ++i)
        if (_stricmp(g_chapters[i].level, level) == 0) { if (hubOut) *hubOut = g_chapters[i].hub; return g_chapters[i].count; }
    LevelChapters c = {};
    strncpy(c.level, level, 47);
    char path[MAX_PATH];
    sprintf(path, "%sLEVELS/%s/AI/LEVEL1.SCP", g_dir, level);
    if (char* l1 = ReadWholeFile(path)) {
        ForEachLine(l1, [&](char* s) {
            if (_strnicmp(s, "include", 7) != 0) return true;
            char* q = strchr(s, '"'); char* q2 = q ? strchr(q + 1, '"') : nullptr;
            if (!q || !q2) return true;
            *q2 = 0;
            if (StrIStr(q + 1, "hub")) { strncpy(c.hub, q + 1, 47); return false; }
            return true;
        });
        free(l1);
    }
    if (c.hub[0]) {
        sprintf(path, "%sLEVELS/%s/AI/%s", g_dir, level, c.hub);
        if (char* hub = ReadWholeFile(path)) {
            bool in = false;
            ForEachLine(hub, [&](char* s) {
                if (!in) {
                    if (_strnicmp(s, "state", 5) == 0) {
                        char* t = s + 5; while (*t == ' ' || *t == '\t') ++t;
                        if (_strnicmp(t, "SkipLevel", 9) == 0 && (t[9] == 0 || t[9] == ' ' || t[9] == '\t')) in = true;
                    }
                    return true;
                }
                if (_strnicmp(s, "state", 5) == 0) return false;  // next state: done
                if (const char* m = StrIStr(s, "MissionMessage")) {
                    if (const char* eq = strstr(m, "==")) { int n = atoi(eq + 2); if (n > c.count && n <= 16) c.count = n; }
                }
                return true;
            });
            free(hub);
        }
    }
    Log("chapters for %s: %d (hub %s)", level, c.count, c.hub[0] ? c.hub : "none");
    if (g_chapterN < 40) g_chapters[g_chapterN++] = c;
    if (hubOut) *hubOut = g_chapterN ? g_chapters[g_chapterN - 1].hub : "";
    return c.count;
}

static bool CallRequestLevel(const char* name) {
    __try { return reinterpret_cast<game::RequestLevelFn>(game::kRequestLevel)(name) != 0; }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in RequestLevel", GetExceptionCode()); return false; }
}

// Chapter jump, in two steps. The hub's "state SkipLevel" fades the screen down when it's entered and then
// waits for message "MissionMessage" == N. Sending the message first (as the unfinished debug menu does) loses
// it: the script is still in its old state, so it sits in SkipLevel on a black screen. So the event goes
// first, and the message follows once, 0.5 s later. Once only: chapter scripts read MissionMessage too
// (1 = chapter complete, 2 = mission failed).
// Switches the Level1 script to the named state. FindEvent (0x53B4D0) walks the script's states and returns the
// one with that name, or 0; FireEvent (0x53C850) switches to it. Returns 0 if the state doesn't exist, -1 on a
// fault, 1 when switched.
static int CallStateEvent(uintptr_t mgr, int slotIdx, const char* state) {
    __try {
        uintptr_t slot = mgr + 0xC + slotIdx * 0xC4, script = 0;
        Read(slot + 4, script);
        int ev = reinterpret_cast<game::FindEventFn>(game::kFindEvent)(state, script);
        if (!ev) return 0;
        reinterpret_cast<game::FireEventFn>(game::kFireEvent)(slot, ev);
        return 1;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X switching to state %s", GetExceptionCode(), state); return -1; }
}

static bool CallMissionMessage(uintptr_t target, int chapter) {
    __try { reinterpret_cast<game::SendScriptMsgFn>(game::kSendScriptMsg)(target, "MissionMessage", (float)chapter, 0); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X sending MissionMessage", GetExceptionCode()); return false; }
}

static int       g_pendingChapter = 0;       // MissionMessage still to send after the SkipLevel event
static DWORD     g_pendingChapterTick = 0;
static uintptr_t g_pendingScript = 0;        // the Level1 script object (holds the hub's SkipLevel state)

// Value of a script variable on obj, or -1 if it can't be read.
static float ScriptVar(uintptr_t obj, const char* name) {
    uintptr_t e = 0;
    __try { e = reinterpret_cast<game::FindScriptVarFn>(game::kFindScriptVar)(obj, name, 0); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return -1; }
    float v = -1;
    if (e) Read(e + 0x28, v);
    return v;
}

// Watch window after sending: logs every change of MissionMessage on both objects, to see which one the
// hub reads (a read that consumes it shows as a reset).
static DWORD     g_watchUntil = 0;
static uintptr_t g_watchObj[2] = {};
static float     g_watchLast[2] = {};

// Runs every frame: sends the chapter number once the hub has had time to enter its SkipLevel state.
static void UpdateChapterMessage() {
    if (g_watchUntil) {
        if (GetTickCount() > g_watchUntil) { g_watchUntil = 0; Log("chapter message: watch ended"); }
        else for (int k = 0; k < 2; ++k) {
            if (!g_watchObj[k]) continue;
            float v = ScriptVar(g_watchObj[k], "MissionMessage");
            if (v != g_watchLast[k]) { Log("chapter message: %s MissionMessage %.0f -> %.0f", k ? "Level1 script" : "mission target", g_watchLast[k], v); g_watchLast[k] = v; }
        }
    }
    if (!g_pendingChapter || GetTickCount() - g_pendingChapterTick < 500) return;
    int chapter = g_pendingChapter;
    g_pendingChapter = 0;
    uintptr_t mgr = 0, target = 0;
    if (!Read(game::kScriptMgrPtr, mgr) || !mgr || !Read(mgr + 0x1A0, target)) { Log("chapter message: level scripts gone"); return; }
    uintptr_t script = g_pendingScript;
    Log("chapter message: MissionMessage = %d (mission target %08X, Level1 script %08X)", chapter, (unsigned)target, (unsigned)script);
    CallMissionMessage(target, chapter);
    if (script && script != target) CallMissionMessage(script, chapter);
    g_watchObj[0] = target;
    g_watchObj[1] = (script && script != target) ? script : 0;
    for (int k = 0; k < 2; ++k) g_watchLast[k] = g_watchObj[k] ? ScriptVar(g_watchObj[k], "MissionMessage") : 0;
    Log("chapter message: now mission target = %.0f, Level1 script = %.0f", g_watchLast[0], g_watchLast[1]);
    g_watchUntil = GetTickCount() + 4000;
}

// Jumps to a chapter (1-based) of the current level, the way the debug menu's MissionSelect does.
static bool SelectChapter(int chapter, char* status) {
    char lvl[48];
    if (!CurrentLevelName(lvl, sizeof(lvl))) { sprintf(status, "Not in a level."); return false; }
    if (ScriptChapters(lvl) < chapter) { sprintf(status, "%s has no chapter %d.", lvl, chapter); return false; }
    uintptr_t mgr = 0, target = 0;
    if (!Read(game::kScriptMgrPtr, mgr) || !mgr || !Read(mgr + 0x1A0, target)) { sprintf(status, "Level scripts not running."); return false; }
    for (int i = 0; i < 8; ++i) {
        uintptr_t script = 0, name = 0; char n[32];
        if (!Read(mgr + 0x10 + i * 0xC4, script) || !script || !Read(script + 8, name) || !ReadName(name, n, sizeof(n))) continue;
        if (_stricmp(n, "Level1") != 0) continue;
        // The hub's TrainerChapterN state (added by mods\ChapterSelect\add_chapter_states.py) does what SkipLevel
        // does, then goes to ChapterN_InitGoto by itself, so no MissionMessage is needed.
        char state[32];
        sprintf(state, "TrainerChapter%d", chapter);
        int r = CallStateEvent(mgr, i, state);
        Log("chapter select: %s chapter %d (script slot %d): state %s -> %s", lvl, chapter, i, state,
            r > 0 ? "switched" : r == 0 ? "not found" : "fault");
        if (r == 0) {
            sprintf(status, "%s's scripts don't have %s yet: run mods\\ChapterSelect\\add_chapter_states.py --apply.", lvl, state);
            return false;
        }
        if (r < 0) { sprintf(status, "Chapter select failed (see log)."); return false; }
        sprintf(status, "Jumping to %s chapter %d...", lvl, chapter);
        return true;
    }
    sprintf(status, "This level has no Level1 script, so it has no chapters to jump to.");
    return false;
}

static char  g_levelStatus[128] = "";
static char  g_jumpLevel[48] = "";   // level we asked for; chapter applied once it's loaded
static int   g_jumpChapter = 0;
static DWORD g_jumpTick = 0, g_jumpReadyTick = 0;

static void GoToLevel(const char* level, int chapter) {
    char cur[48] = "";
    CurrentLevelName(cur, sizeof(cur));
    if (chapter > 0 && cur[0] && _stricmp(cur, level) == 0) {  // same level: just change chapter
        SelectChapter(chapter, g_levelStatus);
        return;
    }
    static char name[48];
    strncpy(name, level, 47); name[47] = 0;
    Log("level select: %s (chapter %d)", name, chapter);
    if (!CallRequestLevel(name)) { sprintf(g_levelStatus, "The game refused level %s.", name); return; }
    sprintf(g_levelStatus, "Loading %s...", name);
    strcpy(g_jumpLevel, name);
    g_jumpChapter = chapter;
    g_jumpTick = GetTickCount();
    g_jumpReadyTick = 0;
}

// Runs every frame: after a requested level has loaded (and the player has existed for 3 s, so the level
// scripts are up), applies the requested chapter.
static void UpdateLevelJump() {
    if (!g_jumpLevel[0]) return;
    DWORD now = GetTickCount();
    if (now - g_jumpTick > 180000) { Log("level jump to %s timed out", g_jumpLevel); g_jumpLevel[0] = 0; return; }
    char cur[48] = ""; uintptr_t pl = 0;
    bool there = CurrentLevelName(cur, sizeof(cur)) && _stricmp(cur, g_jumpLevel) == 0 && Read(game::kPlayerPtr, pl) && pl;
    if (!there) { g_jumpReadyTick = 0; return; }
    if (!g_jumpReadyTick) { g_jumpReadyTick = now; Log("level %s loaded", cur); return; }
    if (now - g_jumpReadyTick < 3000) return;
    if (g_jumpChapter > 0) SelectChapter(g_jumpChapter, g_levelStatus);
    else sprintf(g_levelStatus, "Loaded %s.", cur);
    g_jumpLevel[0] = 0;
}

static void DrawLevelSelect() {
    ImGui::SeparatorText("Level and chapter select");
    if (!LevelSelectAvailable()) { ImGui::TextDisabled("Unavailable: code bytes don't match this exe."); return; }

    char cur[48] = "-";
    CurrentLevelName(cur, sizeof(cur));
    ImGui::Text("Current level: %s", cur);

    static char selLevel[48] = "";
    static int selChapter = 0;  // 0 = start of the level
    if (!selLevel[0] && cur[0] != '-') strcpy(selLevel, cur);

    int n = LevelCount();
    ImGui::SetNextItemWidth(-FLT_MIN);
    if (ImGui::BeginCombo("##level", selLevel[0] ? selLevel : "pick a level")) {
        for (int i = 0; i < n; ++i) {
            char name[48];
            if (!LevelName(i, name, sizeof(name))) continue;
            char label[160];
            int ch = ScriptChapters(name);
            if (ch) sprintf(label, "%s  (%d chapters)##%d", name, ch, i);
            else sprintf(label, "%s##%d", name, i);
            bool sel = _stricmp(name, selLevel) == 0;
            if (ImGui::Selectable(label, sel)) { strcpy(selLevel, name); selChapter = 0; }
            if (sel) ImGui::SetItemDefaultFocus();
        }
        if (!n) ImGui::TextDisabled("Level list not available yet.");
        ImGui::EndCombo();
    }

    int chapters = selLevel[0] ? ScriptChapters(selLevel) : 0;
    char chLabel[128] = "Start of level";
    if (selChapter > 0) sprintf(chLabel, "Chapter %d", selChapter);
    ImGui::BeginDisabled(!chapters || !ChapterSelectAvailable());
    ImGui::SetNextItemWidth(-FLT_MIN);
    if (ImGui::BeginCombo("##chapter", chapters ? chLabel : "No chapters for this level")) {
        if (ImGui::Selectable("Start of level", selChapter == 0)) selChapter = 0;
        for (int i = 0; i < chapters; ++i) {
            char t[32]; sprintf(t, "Chapter %d", i + 1);
            ImGui::PushID(i);
            if (ImGui::Selectable(t, selChapter == i + 1)) selChapter = i + 1;
            ImGui::PopID();
        }
        ImGui::EndCombo();
    }
    ImGui::EndDisabled();
    if (selChapter > chapters) selChapter = 0;

    ImGui::BeginDisabled(!selLevel[0] || g_jumpLevel[0] != 0);
    if (ImGui::Button("Go")) ImGui::OpenPopup("confirm_level");
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
        ImGui::SetTooltip("Loads the level with the game's own level select (the hidden debug menu's).\n"
                          "A chapter is applied about 3 s after the level has loaded, like the hub's chapter select.\n"
                          "Same level + a chapter: jumps straight to that chapter.");
    if (g_jumpLevel[0]) {
        ImGui::SameLine();
        if (ImGui::Button("Cancel chapter jump")) { g_jumpLevel[0] = 0; sprintf(g_levelStatus, "Chapter jump cancelled."); }
    }
    if (ImGui::BeginPopupModal("confirm_level", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::Text("Go to %s, %s?", selLevel, selChapter ? chLabel : "start of level");
        ImGui::TextUnformatted("Progress since your last save in this level is lost.");
        if (ImGui::Button("Go")) { GoToLevel(selLevel, selChapter); ImGui::CloseCurrentPopup(); }
        ImGui::SameLine();
        if (ImGui::Button("Cancel")) ImGui::CloseCurrentPopup();
        ImGui::EndPopup();
    }
    if (g_levelStatus[0]) ImGui::TextWrapped("%s", g_levelStatus);
}

// ---------------------------------------------------------------- creature diagnostics
// Once per level (3 s after the player exists), logs every creature type with its raw model fields, plus the
// level info's second creature-name list (+0xC10 count, +0xC14 names), to find out what decides which models
// a level keeps loaded.
static char  g_diagLevel[48] = "";
static DWORD g_diagReadyTick = 0;

static void DumpCreatures(const char* level) {
    int32_t count = 0;
    Read(game::kCreatureCount, count);
    Log("==== creature dump for %s: %d types ====", level, count);
    if (count < 0 || count > game::kMaxCreatures) return;
    for (int i = 0; i < count; ++i) {
        uintptr_t rec = 0, model = 0; char name[48] = "?";
        uint32_t ab = 0; uint16_t parts = 0; uint32_t m0 = 0, m4 = 0, m8 = 0;
        if (!Read(game::kCreatureTable + 4 * i, rec) || !rec) continue;
        ReadTypeName(rec, name, sizeof(name));
        Read(rec + game::kTypeAbilities, ab);
        Read(rec + game::kTypeModel, model);
        if (model) { Read(model + game::kModelParts, parts); Read(model, m0); Read(model + 4, m4); Read(model + 8, m8); }
        Log("  %3d %-26s abil=%08X model=%08X parts=%u  [%08X %08X %08X]", i, name, ab, (unsigned)model, parts, m0, m4, m8);
    }
    uintptr_t info = 0; uint32_t n2 = 0;
    if (Read(game::kLevelInfoPtr, info) && info && Read(info + 0xC10, n2) && n2 < 64) {
        char line[512] = "";
        for (uint32_t i = 0; i < n2; ++i) {
            uintptr_t p = 0; char nm[48] = "?";
            Read(info + 0xC14 + 4 * i, p); ReadName(p, nm, sizeof(nm));
            if (strlen(line) + strlen(nm) + 2 < sizeof(line)) { strcat(line, nm); strcat(line, " "); }
        }
        Log("  level list +0xC14 (%u): %s", n2, line);
    }
    uint32_t cache = 0; uint16_t pool = 0;
    if (info) { Read(info + 0xBF0, cache); Read(info + 0xBF4, pool); }
    Log("  level info: creature cache %u KB, creature pool %u", cache, pool);
    Log("==== end creature dump ====");
}

static void UpdateCreatureDiag() {
    char cur[48] = ""; uintptr_t pl = 0;
    if (!CurrentLevelName(cur, sizeof(cur)) || !Read(game::kPlayerPtr, pl) || !pl) { g_diagReadyTick = 0; return; }
    if (_stricmp(cur, g_diagLevel) == 0) return;
    DWORD now = GetTickCount();
    if (!g_diagReadyTick) { g_diagReadyTick = now; return; }
    if (now - g_diagReadyTick < 3000) return;
    strcpy(g_diagLevel, cur);
    DumpCreatures(cur);
}

// ---------------------------------------------------------------- opponents (combat hub)
// A level becomes a combat hub when its script has the states written by mods\CombatHub\make_hub.py:
// Hub<Mode>_<Type> (spawns that opponent at the HubSpawn spline), HubClear, HubGoArena and HubIdle.
// Spawning: the trainer loads the opponent's family (robot, vehicle, transform) through the game's own
// mid-level loader, the same way character select does, waits until it's resident, clears the previous opponent,
// then fires the state. The opponent's model stays loaded while it's the current opponent; the previous one is
// freed a couple of seconds after it's gone.
static const char* kOppModes[] = {"Fight", "Boss", "Dummy", "Wave"};
static const char* kOppModeHelp[] = {
    "Normal combat AI (Script=Combat).",
    "Combat AI with the #Boss flag, as the story's boss fights use it.",
    "Stands still and doesn't attack (Script=StandAndWait): a target for testing moves.",
    "Three at once with combat AI."};
static int   g_oppMode = 0;
static DWORD g_oppTick = 0, g_oppSpawnAt = 0;
static int   g_oppPendingMode = 0;
static char  g_oppStatus[160] = "";
static char  g_oppLevel[48] = "";

// True if any running level script has this state.
static bool HubStateExists(const char* state) {
    uintptr_t mgr = 0;
    if (!Read(game::kScriptMgrPtr, mgr) || !mgr) return false;
    for (int i = 0; i < 8; ++i) {
        uintptr_t script = 0;
        if (!Read(mgr + 0x10 + i * 0xC4, script) || !script) continue;
        __try { if (reinterpret_cast<game::FindEventFn>(game::kFindEvent)(state, script)) return true; }
        __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    }
    return false;
}

// Switches whichever level script has the state to it. 1 = switched, 0 = no script has it, -1 = fault.
static int FireHubState(const char* state) {
    uintptr_t mgr = 0;
    if (!Read(game::kScriptMgrPtr, mgr) || !mgr) return 0;
    for (int i = 0; i < 8; ++i) {
        uintptr_t script = 0;
        if (!Read(mgr + 0x10 + i * 0xC4, script) || !script) continue;
        int r = CallStateEvent(mgr, i, state);
        if (r != 0) { Log("hub: state %s -> %s (script slot %d)", state, r > 0 ? "switched" : "fault", i); return r; }
    }
    Log("hub: no level script has state %s", state);
    return 0;
}

static bool HubAvailable() { return ChapterSelectAvailable() && HubStateExists("HubIdle"); }

static void ScheduleOppRelease() {
    g_releasePending = g_loadCount > 0;
    g_releaseNotBefore = GetTickCount() + 2500;  // the old opponent must be gone before its model is freed
}

static void BeginOppSpawn(const char* name, int mode) {
    g_oppPending = name;
    g_oppPendingMode = mode;
    if (g_oppName) {  // clear the current one first, then spawn a moment later
        FireHubState("HubClear");
        g_oppSpawnAt = GetTickCount() + 400;
    } else {
        g_oppSpawnAt = GetTickCount();
    }
    sprintf(g_oppStatus, "Spawning %s (%s)...", name, kOppModes[mode]);
}

static void RequestOpponent(const char* typeName, int mode) {
    char state[96];
    sprintf(state, "Hub%s_%.60s", kOppModes[mode], typeName);
    if (!HubStateExists(state)) {
        sprintf(g_oppStatus, "The hub script has no %s: re-run mods\\CombatHub\\make_hub.py.", state);
        return;
    }
    uintptr_t rec = FindTypeRecord(typeName);
    if (!rec) { sprintf(g_oppStatus, "%.40s isn't a creature type in this level.", typeName); return; }
    Family f = GetFamily(rec, typeName);
    int st = FamilyState(f);
    if (st == 0) { sprintf(g_oppStatus, "%.40s isn't in this level's CREATURES.CFG.", typeName); return; }
    const char* name = InternName(typeName);
    if (!name) return;
    if (st == 2) { BeginOppSpawn(name, mode); return; }
    // Not in memory: load the missing parts with the game's mid-level loader (as character select does).
    if (!SigOk(game::kQueueLoad) || !SigOk(game::kQueueLoadStore)) { sprintf(g_oppStatus, "Loading is unavailable on this exe."); return; }
    if (!LoadQueueIdle()) { sprintf(g_oppStatus, "The game is already loading creatures; try again in a moment."); return; }
    for (int i = 0; i < f.n; ++i)
        if (strlen(f.name[i]) > 31) { sprintf(g_oppStatus, "%s: name too long for the game's load queue.", f.name[i]); return; }
    TrainerLoad* L = FindLoad(name);
    if (!L && g_loadCount < 8) { L = &g_loads[g_loadCount++]; memset(L, 0, sizeof(*L)); strncpy(L->root, name, 47); }
    for (int i = 0; i < f.n; ++i) {
        if (TypeModelState(f.rec[i]) == 2) continue;
        Log("hub: queueing %s for loading", f.name[i]);
        if (!CallQueueLoad(f.name[i])) { sprintf(g_oppStatus, "Queueing %s failed (see log).", f.name[i]); return; }
        if (L) {
            bool have = false;
            for (int k = 0; k < L->n; ++k) if (_stricmp(L->part[k], f.name[i]) == 0) have = true;
            if (!have && L->n < 3) strncpy(L->part[L->n++], f.name[i], 47);
        }
    }
    g_oppLoadName = name;
    g_oppPendingMode = mode;
    g_inLoadCall = name;  // for the watchdog
    g_oppTick = GetTickCount();
    sprintf(g_oppStatus, "Loading %s...", name);
}

static void ClearOpponent() {
    if (FireHubState("HubClear") > 0) {
        if (g_oppName) Log("hub: cleared %s", g_oppName);
        g_oppName = nullptr;
        ScheduleOppRelease();
        sprintf(g_oppStatus, "Opponent cleared.");
    } else sprintf(g_oppStatus, "Clear failed (see log).");
}

// Runs every frame.
static void UpdateOpponents() {
    char lvl[48] = "";
    CurrentLevelName(lvl, sizeof(lvl));
    if (_stricmp(lvl, g_oppLevel) != 0) {  // new level: nothing of ours is alive any more
        strcpy(g_oppLevel, lvl);
        g_oppName = g_oppLoadName = g_oppPending = nullptr;
        g_oppStatus[0] = 0;
    }
    if (g_oppLoadName) {
        uintptr_t rec = FindTypeRecord(g_oppLoadName);
        int st = rec ? FamilyState(GetFamily(rec, g_oppLoadName)) : 0;
        if (st == 2) {
            Log("hub: %s loaded after %lu ms", g_oppLoadName, GetTickCount() - g_oppTick);
            g_inLoadCall = nullptr;
            const char* n = g_oppLoadName; g_oppLoadName = nullptr;
            BeginOppSpawn(n, g_oppPendingMode);
        } else if (GetTickCount() - g_oppTick > 30000) {
            Log("hub: %s didn't load within 30 s (cache full?)", g_oppLoadName);
            sprintf(g_oppStatus, "%s didn't load within 30 s (the creature cache may be full: Clear, then try again).", g_oppLoadName);
            g_inLoadCall = nullptr;
            g_oppLoadName = nullptr;
        }
        return;
    }
    if (g_oppPending && GetTickCount() >= g_oppSpawnAt) {
        char state[96];
        sprintf(state, "Hub%s_%.60s", kOppModes[g_oppPendingMode], g_oppPending);
        const char* prev = g_oppName;
        int r = FireHubState(state);
        if (r > 0) {
            g_oppName = g_oppPending;
            sprintf(g_oppStatus, "Spawned %s (%s) at the arena.", g_oppName, kOppModes[g_oppPendingMode]);
            if (prev && _stricmp(prev, g_oppName) != 0) ScheduleOppRelease();
        } else {
            sprintf(g_oppStatus, "Spawning %s failed (see log).", g_oppPending);
        }
        g_oppPending = nullptr;
    }
}

static void DrawOpponents() {
    ImGui::SeparatorText("Opponents (combat hub)");
    if (!ChapterSelectAvailable()) { ImGui::TextDisabled("Unavailable: code bytes don't match this exe."); return; }
    if (!HubAvailable()) {
        ImGui::TextDisabled("This level isn't a combat hub. Load TestTranquility (set up by");
        ImGui::TextDisabled("mods\\CombatHub\\make_hub.py).");
        return;
    }
    for (int m = 0; m < 4; ++m) {
        if (m) ImGui::SameLine();
        ImGui::RadioButton(kOppModes[m], &g_oppMode, m);
        if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", kOppModeHelp[m]);
    }
    static char filter[32] = "";
    static int selected = -1;
    ImGui::SetNextItemWidth(-FLT_MIN);
    ImGui::InputTextWithHint("##oppfilter", "filter opponents", filter, sizeof(filter));

    int32_t count = 0;
    Read(game::kCreatureCount, count);
    if (count < 0 || count > game::kMaxCreatures) count = 0;
    char selName[48] = "";
    if (ImGui::BeginListBox("##opponents", ImVec2(-FLT_MIN, 8.0f * ImGui::GetTextLineHeightWithSpacing()))) {
        int shown = 0;
        for (int i = 0; i < count; ++i) {
            uintptr_t rec = 0; char name[48];
            if (!Read(game::kCreatureTable + 4 * i, rec) || !ReadTypeName(rec, name, sizeof(name))) continue;
            char st[96]; sprintf(st, "HubFight_%.60s", name);
            if (!HubStateExists(st)) continue;  // only types the hub script knows
            if (filter[0]) {
                char a[48], b[32]; strcpy(a, name); strcpy(b, filter); _strlwr(a); _strlwr(b);
                if (!strstr(a, b)) continue;
            }
            ++shown;
            int ms = FamilyState(GetFamily(rec, name));
            bool cur = g_oppName && _stricmp(g_oppName, name) == 0;
            char label[128];
            sprintf(label, "%s%s##opp%d", name, cur ? "   (current opponent)" : ms == 1 ? "   (loads when spawned)" : "", i);
            if (ImGui::Selectable(label, selected == i, ImGuiSelectableFlags_AllowDoubleClick)) {
                selected = i;
                if (ImGui::IsMouseDoubleClicked(0) && !g_oppLoadName && !g_oppPending && !g_loadName && !g_swapName) RequestOpponent(name, g_oppMode);
            }
            if (selected == i) strcpy(selName, name);
        }
        if (!shown) ImGui::TextDisabled("No opponents found.");
        ImGui::EndListBox();
    }
    bool busy = g_oppLoadName || g_oppPending || g_loadName || g_swapName;
    ImGui::BeginDisabled(!selName[0] || busy);
    char btn[96]; sprintf(btn, "Spawn %s (%s)", selName[0] ? selName : "...", kOppModes[g_oppMode]);
    if (ImGui::Button(btn)) RequestOpponent(selName, g_oppMode);
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled))
        ImGui::SetTooltip("Replaces the current opponent. Ones not in memory are loaded first (the game shows its\n"
                          "loading screen for a moment). Double-click a name works too.");
    ImGui::SameLine();
    ImGui::BeginDisabled(busy);
    if (ImGui::Button("Clear")) ClearOpponent();
    ImGui::SameLine();
    if (ImGui::Button("Go to arena")) { if (FireHubState("HubGoArena") > 0) sprintf(g_oppStatus, "Moved to the arena."); }
    ImGui::EndDisabled();
    ImGui::Text("Opponent: %s", g_oppName ? g_oppName : "none");
    if (g_oppStatus[0]) ImGui::TextWrapped("%s", g_oppStatus);
}

static void DrawPlayer() {
    ImGui::SeparatorText("Player");
    uintptr_t pl = 0;
    if (!Read(game::kPlayerPtr, pl) || !pl) { ImGui::TextDisabled("No player character (menu or loading)."); return; }
    int32_t state = 0; uint32_t fl = 0;
    Read(pl + game::kStateId, state); Read(pl + game::kFlags628, fl);
    ImGui::Text("Character  %08X", (unsigned)pl);
    ImGui::Text("State id   %d", state);
    ImGui::Text("Form       %s", (fl & game::kFlagVehicle) ? "vehicle" : "robot");
    ImGui::Text("Airborne   %s   Grounded %s", (fl & game::kFlagAirborne) ? "yes" : "no", (fl & game::kFlagGrounded) ? "yes" : "no");
}

static void DrawRawFlags() {
    if (!ImGui::CollapsingHeader("Advanced: raw cheat flags")) return;
    uint32_t f = Flags();
    ImGui::Text("Flag word at 0x%08X = 0x%08X", (unsigned)game::kCheatFlags, f);
    ImGui::TextDisabled("Flipping unknown bits may crash the game.");
    for (int b = 0; b < 32; ++b) {
        uint32_t bit = 1u << b;
        const char* nm = "unknown";
        for (const auto& n : game::kFlagNames) if (n.bit == bit) nm = n.name;
        bool v = (f & bit) != 0;
        char label[96]; sprintf(label, "0x%08X  %s", bit, nm);
        if (ImGui::Checkbox(label, &v)) {
            Log("raw flag 0x%08X -> %d", bit, v ? 1 : 0);
            SafeWrite32(game::kCheatFlags, v ? (Flags() | bit) : (Flags() & ~bit));
        }
    }
}

static void DrawSettings() {
    if (!ImGui::CollapsingHeader("Trainer settings")) return;
    ImGui::Text("Menu key: %s  (change MenuKey in DebugTrainer.ini)", KeyToName(g_cfg.menuKey));
    ImGui::Checkbox("Hide menu key from the game", &g_cfg.blockKeyInGame);
    ImGui::Checkbox("Block game input while menu is open", &g_cfg.blockInput);
    ImGui::Checkbox("Open menu on start", &g_cfg.startOpen);
    ImGui::Checkbox("Show startup note", &g_cfg.showToast);
    if (ImGui::SliderFloat("Text size", &g_cfg.fontScale, 0.75f, 3.0f, "%.2f")) ImGui::GetIO().FontGlobalScale = g_cfg.fontScale;
    ImGui::SliderFloat("Cursor speed", &g_cfg.mouseSpeed, 0.25f, 4.0f, "%.2f");
    if (ImGui::Button("Save settings")) { SaveConfig(); Log("settings saved"); }
}

// ---------------------------------------------------------------- noclip
// Noclip takes over the player's position: every frame (before it's drawn, from the BeginScene hook) the
// trainer moves the player by the noclip input, places them with the game's SetTransform, and zeroes their
// velocity, so gravity and collisions can't move them. Turning it off leaves them where they are.
static float g_ncPos[3] = {};
static float g_ncFwd[2] = {0, 1};      // last good camera-forward on the ground plane
static DWORD g_ncLastTick = 0;
static float g_safePos[3] = {};        // last spot the player stood on the ground (reset fallback)
static bool  g_haveSafePos = false;
static char  g_noticeText[64] = "";    // short on-screen note (e.g. "Noclip ON")
static DWORD g_noticeUntil = 0;
static bool  g_capturingKey = false;   // "press a key" for rebinding the noclip key
static char  g_noclipStatus[128] = "";
static bool  g_inOurScene = false;     // the trainer's own BeginScene (drawing the menu) is running
static bool  g_ncApplied = false;      // noclip already applied this frame

static bool NoclipAvailable() {
    return SigOk(game::kGetMatrix) && SigOk(game::kGetPos) && SigOk(game::kSetTransform) && SigOk(game::kGetActiveBody);
}

static void Notice(const char* text) {
    strncpy(g_noticeText, text, sizeof(g_noticeText) - 1);
    g_noticeUntil = GetTickCount() + 1500;
}

static bool PlayerPos(uintptr_t pl, float out[3]) {
    const float* p = nullptr;
    __try { p = reinterpret_cast<game::GetMatrixFn>(game::kGetPos)(reinterpret_cast<void*>(pl)); }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
    return p && SafeRead(reinterpret_cast<uintptr_t>(p), out, 12);
}

// Places the player at pos, keeping their rotation, and zeroes their velocity.
static bool PlacePlayer(uintptr_t pl, const float pos[3]) {
    float m[16];
    __try {
        const float* cur = reinterpret_cast<game::GetMatrixFn>(game::kGetMatrix)(reinterpret_cast<void*>(pl));
        if (!cur) return false;
        memcpy(m, cur, sizeof(m));
        m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
        reinterpret_cast<game::SetTransformFn>(game::kSetTransform)(reinterpret_cast<void*>(pl), m, 1, 0);
        void* body = reinterpret_cast<game::GetActiveBodyFn>(game::kGetActiveBody)(reinterpret_cast<void*>(pl));
        uintptr_t st = 0;
        if (body && Read(reinterpret_cast<uintptr_t>(body) + game::kBodyState, st) && st) {
            float* v = reinterpret_cast<float*>(st + game::kBodyVel);
            v[0] = v[1] = v[2] = 0;
        }
        float* vc = reinterpret_cast<float*>(pl + game::kVelCopy);
        vc[0] = vc[1] = vc[2] = 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X placing the player", GetExceptionCode()); return false; }
    return true;
}

static void SetNoclip(bool on) {
    if (on == g_noclip) return;
    uintptr_t pl = 0;
    if (on) {
        if (!NoclipAvailable()) { Notice("Noclip unavailable on this exe"); return; }
        if (!Read(game::kPlayerPtr, pl) || !pl || !PlayerPos(pl, g_ncPos)) { Notice("Noclip: no player right now"); return; }
        g_ncLastTick = GetTickCount();
        InterlockedExchange(&g_ncKeys, 0); InterlockedExchange(&g_ncMouse, 0);
    }
    g_noclip = on;
    Log("noclip %s at %.1f %.1f %.1f", on ? "on" : "off", g_ncPos[0], g_ncPos[1], g_ncPos[2]);
    Notice(on ? (g_menuOpen ? "Noclip ON - close the menu to fly" : "Noclip ON") : "Noclip OFF");
}

// Each frame, before it's drawn: moves and places the player while noclip is on; otherwise remembers the
// last spot they stood on the ground.
static void ApplyNoclip() {
    uintptr_t pl = 0;
    if (!Read(game::kPlayerPtr, pl) || !pl) { if (g_noclip) { g_noclip = false; Log("noclip off: player gone"); } return; }
    if (!g_noclip) {
        uint32_t fl = 0; float p[3];
        if (NoclipAvailable() && Read(pl + game::kFlags628, fl) && (fl & game::kFlagGrounded) && !(fl & game::kFlagAirborne) && PlayerPos(pl, p)) {
            memcpy(g_safePos, p, sizeof(p)); g_haveSafePos = true;
        }
        return;
    }
    DWORD now = GetTickCount();
    float dt = (now - g_ncLastTick) / 1000.0f;
    g_ncLastTick = now;
    if (dt > 0.1f) dt = 0.1f;  // after a hitch or loading, don't jump far
    LONG in = g_menuOpen ? 0 : (g_ncKeys | g_ncMouse);
    // Camera-relative directions: forward is the flat direction from the camera to the player.
    uintptr_t cam = 0, mat = 0; float cp[3];
    if (Read(game::kRenderCamPtr, cam) && cam && Read(cam + 0xC, mat) && mat && SafeRead(mat + 0x30, cp, 12)) {
        float fx = g_ncPos[0] - cp[0], fz = g_ncPos[2] - cp[2], len = sqrtf(fx * fx + fz * fz);
        if (len > 0.5f) { g_ncFwd[0] = fx / len; g_ncFwd[1] = fz / len; }
    }
    float fx = g_ncFwd[0], fz = g_ncFwd[1];
    float rx = fz, rz = -fx;  // right of forward (y up)
    float mv[3] = {0, 0, 0};
    if (in & NC_FWD)   { mv[0] += fx; mv[2] += fz; }
    if (in & NC_BACK)  { mv[0] -= fx; mv[2] -= fz; }
    if (in & NC_RIGHT) { mv[0] += rx; mv[2] += rz; }
    if (in & NC_LEFT)  { mv[0] -= rx; mv[2] -= rz; }
    if (in & NC_UP)    mv[1] += 1;
    if (in & NC_DOWN)  mv[1] -= 1;
    float speed = g_cfg.noclipSpeed * ((in & NC_FAST) ? g_cfg.noclipFast : 1.0f) * dt;
    for (int i = 0; i < 3; ++i) g_ncPos[i] += mv[i] * speed;
    PlacePlayer(pl, g_ncPos);
}

// Puts the player at the level's nearest SafeRespawn point, or else the last spot they stood on the ground.
static void ResetToSafeSpot() {
    uintptr_t pl = 0;
    if (!Read(game::kPlayerPtr, pl) || !pl) { sprintf(g_noclipStatus, "No player right now."); return; }
    float pos[4] = {}, dir[4] = {};
    bool found = false;
    if (SigOk(game::kSafeRespawn)) {
        __try { found = reinterpret_cast<game::SafeRespawnFn>(game::kSafeRespawn)(reinterpret_cast<void*>(pl), pos, dir); }
        __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in SafeRespawn", GetExceptionCode()); found = false; }
    }
    const char* how = "the level's nearest safe respawn point";
    if (!found) {
        if (!g_haveSafePos) { sprintf(g_noclipStatus, "No safe spot known: this level has no SafeRespawn points and you haven't stood on the ground yet."); return; }
        memcpy(pos, g_safePos, 12);
        how = "the last spot you stood on the ground";
    }
    pos[1] += 0.5f;  // a little above the ground, so you don't start inside it
    if (!PlacePlayer(pl, pos)) { sprintf(g_noclipStatus, "Reset failed (see log)."); return; }
    memcpy(g_ncPos, pos, 12);  // noclip continues from here if it's on
    Log("reset to %s: %.1f %.1f %.1f", how, pos[0], pos[1], pos[2]);
    sprintf(g_noclipStatus, "Moved to %s.", how);
}

static void DrawNoclip() {
    ImGui::SeparatorText("Noclip");
    if (!NoclipAvailable()) { ImGui::TextDisabled("Unavailable: code bytes don't match this exe."); return; }
    bool on = g_noclip;
    char label[48]; sprintf(label, "Noclip  [%s]", KeyToName(g_cfg.noclipKey));
    if (ImGui::Checkbox(label, &on)) SetNoclip(on);
    ImGui::SameLine();
    if (g_capturingKey) {
        ImGui::TextColored(ImVec4(1, 0.8f, 0.3f, 1), "Press a key... (Esc cancels)");
    } else if (ImGui::Button("Change key")) {
        g_capturingKey = true;
    }
    ImGui::TextDisabled("W/A/S/D or arrows: move   Left mouse: up   Right mouse: down   Shift: faster");
    // Movement is paused while this menu is open (its keys drive the menu), so say how to start flying.
    if (g_noclip)
        ImGui::TextColored(ImVec4(1, 0.8f, 0.3f, 1), "Noclip is ON. Close this menu (%s) to fly around.", KeyToName(g_cfg.menuKey));
    ImGui::SetNextItemWidth(160);
    ImGui::SliderFloat("Speed", &g_cfg.noclipSpeed, 5.0f, 150.0f, "%.0f");
    ImGui::SameLine();
    ImGui::SetNextItemWidth(120);
    ImGui::SliderFloat("Shift x", &g_cfg.noclipFast, 1.0f, 10.0f, "%.1f");
    if (ImGui::Button("Reset to nearest safe spot")) ResetToSafeSpot();
    if (ImGui::IsItemHovered())
        ImGui::SetTooltip("Moves you to the level's nearest safe respawn point (clear of props), the one the\n"
                          "game itself uses. Levels without those points use the last spot you stood on the ground.");
    if (g_noclipStatus[0]) ImGui::TextWrapped("%s", g_noclipStatus);
}

// Key capture for rebinding: the first key pressed (not the mouse's left/right/middle) becomes the noclip key.
static void UpdateKeyCapture() {
    if (!g_capturingKey) return;
    static bool waitRelease = true;  // ignore the click/key that opened the capture
    bool any = false;
    for (int vk = 0x05; vk < 0xFF; ++vk) {
        if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU) continue;  // use the left/right versions
        if (!(GetAsyncKeyState(vk) & 0x8000)) continue;
        any = true;
        if (waitRelease) continue;
        if (vk == VK_ESCAPE) { g_capturingKey = false; waitRelease = true; return; }
        if (vk == g_cfg.menuKey) continue;
        g_cfg.noclipKey = vk;
        g_noclipDik = VkToDik(vk);
        g_capturingKey = false;
        waitRelease = true;
        SaveConfig();
        Log("noclip key set to %s", KeyToName(vk));
        return;
    }
    if (!any) waitRelease = false;
}

static void DrawNotice() {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(vp->Pos.x + vp->Size.x * 0.5f, vp->Pos.y + vp->Size.y * 0.12f), ImGuiCond_Always, ImVec2(0.5f, 0.5f));
    ImGui::SetNextWindowBgAlpha(0.6f);
    ImGui::Begin("##notice", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize |
                 ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    ImGui::TextUnformatted(g_noticeText);
    ImGui::End();
}

static void DrawMenu() {
    ImGui::SetNextWindowSize(ImVec2(430, 560), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowPos(ImVec2(40, 40), ImGuiCond_FirstUseEver);
    bool open = true;
    char title[96]; sprintf(title, "TF:TG Debug Trainer " TRAINER_VERSION "  [%s]###trainer", KeyToName(g_cfg.menuKey));
    if (ImGui::Begin(title, &open)) {
        ImGui::TextDisabled("Arrows: move   Space/Enter: toggle   Esc or %s: close", KeyToName(g_cfg.menuKey));
        if (ImGui::IsKeyPressed(ImGuiKey_Escape, false) && !ImGui::IsPopupOpen("", ImGuiPopupFlags_AnyPopupId)) {
            open = false;
            Log("menu closed (Esc)");
        }
        DrawDebugMenu();
        DrawEngineOptions();
        DrawNoclip();
        DrawLevelSelect();
        DrawCharacterSelect();
        DrawOpponents();
        DrawLevel();
        DrawPlayer();
        ImGui::Spacing();
        DrawRawFlags();
        DrawSettings();
    }
    ImGui::End();
    if (!open) g_menuOpen = false;
}

static void DrawToast() {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(ImVec2(vp->Pos.x + 16, vp->Pos.y + vp->Size.y - 16), ImGuiCond_Always, ImVec2(0, 1));
    ImGui::SetNextWindowBgAlpha(0.6f);
    ImGui::Begin("##toast", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize |
                 ImGuiWindowFlags_NoInputs | ImGuiWindowFlags_NoFocusOnAppearing | ImGuiWindowFlags_NoNav);
    ImGui::Text("Debug Trainer ready - press %s", KeyToName(g_cfg.menuKey));
    ImGui::End();
}

// ---------------------------------------------------------------- D3D9 hooks
typedef HRESULT (STDMETHODCALLTYPE* PresentFn)(IDirect3DDevice9*, const RECT*, const RECT*, HWND, const RGNDATA*);
typedef HRESULT (STDMETHODCALLTYPE* ResetFn)(IDirect3DDevice9*, D3DPRESENT_PARAMETERS*);
static PresentFn g_origPresent = nullptr;
static ResetFn   g_origReset   = nullptr;
static bool      g_presentSeen = false;

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
    if (!hwnd) { Log("no game window found yet"); return false; }

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = g_imguiIni;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.ConfigFlags |= ImGuiConfigFlags_NoMouseCursorChange;  // leave the game's (hidden) Windows cursor alone
    io.FontGlobalScale = g_cfg.fontScale;
    ImGui::StyleColorsDark();
    ImGuiStyle& st = ImGui::GetStyle();
    st.WindowRounding = 6; st.FrameRounding = 4; st.GrabRounding = 4;
    st.Colors[ImGuiCol_WindowBg].w = 0.92f;
    // Autobot red / Decepticon purple accents
    st.Colors[ImGuiCol_TitleBgActive] = ImVec4(0.45f, 0.08f, 0.10f, 1.0f);
    st.Colors[ImGuiCol_CheckMark]     = ImVec4(0.95f, 0.35f, 0.30f, 1.0f);
    st.Colors[ImGuiCol_Header]        = ImVec4(0.35f, 0.15f, 0.45f, 0.6f);

    if (!ImGui_ImplWin32_Init(hwnd) || !ImGui_ImplDX9_Init(dev)) {
        Log("ImGui backend init failed");
        return false;
    }
    g_hwnd = hwnd;
    g_origWndProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrA(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&HkWndProc)));
    g_readyTick = GetTickCount();
    g_menuOpen = g_cfg.startOpen;
    Log("ImGui ready (window %p)", hwnd);
    return true;
}

static void PollHotkey() {
    bool fg = false;
    HWND f = GetForegroundWindow();
    if (f) { DWORD pid = 0; GetWindowThreadProcessId(f, &pid); fg = pid == GetCurrentProcessId(); }
    bool down = fg && (GetAsyncKeyState(g_cfg.menuKey) & 0x8000) != 0;
    if (down && !g_keyWasDown) {
        g_menuOpen = !g_menuOpen;
        Log("menu %s", g_menuOpen ? "opened" : "closed");
        if (!g_menuOpen) {
            Log("  input seen while open: window keys=%ld window mouse=%ld | DI keyboard reads=%ld buffered=%ld | "
                "DI mouse reads=%ld buffered=%ld moved=%d | other DI size=%ld | mouse hook events=%ld",
                g_wmKeyMsgs, g_wmMouseMsgs, g_diKbReads, g_diKbBuffered, g_diMouseReads, g_diMouseBuffered,
                g_diMouseSeen ? 1 : 0, g_diOtherSize, g_llEvents);
            Log("  menu cursor ended at %.0f,%.0f on a %.0fx%.0f display (source: %s), clicks=%ld", g_virtualMouse.x,
                g_virtualMouse.y, ImGui::GetIO().DisplaySize.x, ImGui::GetIO().DisplaySize.y,
                g_llSeen ? "mouse hook" : g_diMouseSeen ? "DirectInput" : "none", g_clicks);
        } else {
            g_llEvents = 0; g_clicks = 0;
            InterlockedExchange(&g_llDX, 0); InterlockedExchange(&g_llDY, 0);
            AcquireSRWLockExclusive(&g_mqLock); g_mqCount = 0; ReleaseSRWLockExclusive(&g_mqLock);
            g_wmKeyMsgs = g_wmMouseMsgs = g_diKbReads = g_diKbBuffered = 0;
            g_diMouseReads = g_diMouseBuffered = g_diOtherSize = 0;
            InterlockedExchange(&g_diNavKeys, 0);
            RECT rc; GetClientRect(g_hwnd, &rc);
            g_virtualMouse = ImVec2((rc.right - rc.left) * 0.5f, (rc.bottom - rc.top) * 0.5f);
            g_diMouseSeen = false;
            InterlockedExchange(&g_diMouseDX, 0); InterlockedExchange(&g_diMouseDY, 0);
            InterlockedExchange(&g_diMouseWheel, 0); InterlockedExchange(&g_diMouseButtons, 0);
        }
    }
    g_keyWasDown = down;

    // Noclip key (not while rebinding it).
    static bool ncWasDown = false;
    bool ncDown = fg && !g_capturingKey && (GetAsyncKeyState(g_cfg.noclipKey) & 0x8000) != 0;
    if (ncDown && !ncWasDown) SetNoclip(!g_noclip);
    ncWasDown = ncDown;
}

// Drives the menu cursor. The game owns the real mouse, so the menu keeps its own cursor position and moves it
// by the physical mouse's motion: from the low-level mouse hook when it works, else from DirectInput.
// A position is sent every frame, so ImGui always draws its own cursor.
// The position goes into ImGui's queue before any click, so ImGui applies each click at the drawn cursor.
// (The Win32 backend also queues the hidden Windows cursor's position every frame. ImGui handles queued
// events in order, so a click queued before our position would land at that hidden cursor instead.)
static void FeedMouse() {
    ImGuiIO& io = ImGui::GetIO();
    float dx = 0, dy = 0;
    MouseEvt q[kMouseQueue]; int n = 0;
    LONG diButtons = 0, diWheel = 0;
    if (g_llSeen) {
        dx = (float)InterlockedExchange(&g_llDX, 0);
        dy = (float)InterlockedExchange(&g_llDY, 0);
        InterlockedExchange(&g_diMouseDX, 0); InterlockedExchange(&g_diMouseDY, 0);
        InterlockedExchange(&g_diMouseWheel, 0);
        AcquireSRWLockExclusive(&g_mqLock);
        for (; n < g_mqCount; ++n) q[n] = g_mq[(g_mqHead + n) % kMouseQueue];
        g_mqHead = (g_mqHead + g_mqCount) % kMouseQueue; g_mqCount = 0;
        ReleaseSRWLockExclusive(&g_mqLock);
    } else if (g_diMouseSeen) {
        dx = (float)InterlockedExchange(&g_diMouseDX, 0);
        dy = (float)InterlockedExchange(&g_diMouseDY, 0);
        diWheel = InterlockedExchange(&g_diMouseWheel, 0);
        diButtons = g_diMouseButtons;
    }
    g_virtualMouse.x += dx * g_cfg.mouseSpeed;
    g_virtualMouse.y += dy * g_cfg.mouseSpeed;
    if (g_virtualMouse.x > io.DisplaySize.x - 1) g_virtualMouse.x = io.DisplaySize.x - 1;
    if (g_virtualMouse.y > io.DisplaySize.y - 1) g_virtualMouse.y = io.DisplaySize.y - 1;
    if (g_virtualMouse.x < 0) g_virtualMouse.x = 0;
    if (g_virtualMouse.y < 0) g_virtualMouse.y = 0;
    io.AddMousePosEvent(g_virtualMouse.x, g_virtualMouse.y);

    if (g_llSeen) {
        for (int i = 0; i < n; ++i) {
            if (q[i].wheel != 0) io.AddMouseWheelEvent(0, q[i].wheel);
            else { io.AddMouseButtonEvent(q[i].button, q[i].down); if (q[i].down) InterlockedIncrement(&g_clicks); }
        }
    } else if (g_diMouseSeen) {
        for (int i = 0; i < 3; ++i) io.AddMouseButtonEvent(i, (diButtons >> i) & 1);
        if (diWheel) io.AddMouseWheelEvent(0, (float)diWheel / WHEEL_DELTA);
    }
}

static void Frame(IDirect3DDevice9* dev) {
    if (!g_imguiReady) {
        g_imguiReady = InitImGui(dev);
        if (!g_imguiReady) return;
    }
    PollHotkey();
    UpdateKeyCapture();
    UpdateSwap();
    UpdateOpponents();
    UpdateLevelJump();
    UpdateChapterMessage();
    UpdateCreatureDiag();
    bool toast = g_cfg.showToast && GetTickCount() - g_readyTick < 8000 && !g_menuOpen;
    bool notice = GetTickCount() < g_noticeUntil;
    if (!g_menuOpen && !toast && !notice) return;
    if (dev->TestCooperativeLevel() != D3D_OK) return;

    ImGui_ImplDX9_NewFrame();
    ImGui_ImplWin32_NewFrame();
    if (g_menuOpen) {
        FeedMouse();
        // Navigation keys from the game's DirectInput keyboard, always: the window gets only some key messages.
        // ImGui drops an event that repeats a key's current state, so keys reported both ways count once.
        ImGuiIO& io = ImGui::GetIO();
        LONG m = g_diNavKeys;
        for (int i = 0; i < kNumNavKeys; ++i) io.AddKeyEvent(kNavKeys[i].key, ((m >> i) & 1) != 0);
    }
    ImGui::GetIO().MouseDrawCursor = false;  // drawn below, so it can't be lost
    ImGui::NewFrame();
    if (g_menuOpen) {
        DrawMenu();
        // Menu cursor: a white arrow with a black outline, tip at the cursor position.
        ImDrawList* dl = ImGui::GetForegroundDrawList();
        float s = 1.4f * g_cfg.fontScale, x = g_virtualMouse.x, y = g_virtualMouse.y;
        ImVec2 pts[7] = {{x, y}, {x, y + 17 * s}, {x + 4.5f * s, y + 13 * s}, {x + 8 * s, y + 20 * s},
                         {x + 10.5f * s, y + 19 * s}, {x + 7 * s, y + 12 * s}, {x + 12 * s, y + 12 * s}};
        dl->AddConcavePolyFilled(pts, 7, IM_COL32(255, 255, 255, 255));
        dl->AddPolyline(pts, 7, IM_COL32(0, 0, 0, 255), ImDrawFlags_Closed, 1.5f);
    }
    if (toast) DrawToast();
    if (notice) DrawNotice();
    ImGui::EndFrame();

    g_inOurScene = true;  // our own BeginScene: the hook must not apply noclip here
    if (SUCCEEDED(dev->BeginScene())) {
        ImGui::Render();
        ImGui_ImplDX9_RenderDrawData(ImGui::GetDrawData());
        dev->EndScene();
    } else {
        ImGui::Render();
    }
    g_inOurScene = false;
}

// BeginScene hook: the game's first BeginScene of a frame comes after its update, before it draws, so
// placing the noclip player here means the frame shows where noclip put them (not where physics moved them).
typedef HRESULT (STDMETHODCALLTYPE* BeginSceneFn)(IDirect3DDevice9*);
static BeginSceneFn g_origBeginScene = nullptr;

static void ApplyNoclipOnce() {
    if (g_ncApplied) return;
    g_ncApplied = true;
    __try { ApplyNoclip(); }
    __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X in noclip", GetExceptionCode()); g_noclip = false; }
}

static HRESULT STDMETHODCALLTYPE HkBeginScene(IDirect3DDevice9* dev) {
    if (dev == g_device && !g_inOurScene) ApplyNoclipOnce();
    return g_origBeginScene(dev);
}

static HRESULT STDMETHODCALLTYPE HkPresent(IDirect3DDevice9* dev, const RECT* a, const RECT* b, HWND c, const RGNDATA* d) {
    if (!g_presentSeen) { g_presentSeen = true; Log("first Present on device %p", dev); }
    g_lastFrameTick = GetTickCount();
    if (dev == g_device) {
        ApplyNoclipOnce();  // fallback if the game drew this frame without a BeginScene we saw
        __try { Frame(dev); }
        __except (EXCEPTION_EXECUTE_HANDLER) { Log("ERROR: exception 0x%08X while drawing the menu", GetExceptionCode()); }
        g_ncApplied = false;  // next frame
    }
    return g_origPresent(dev, a, b, c, d);
}

static HRESULT STDMETHODCALLTYPE HkReset(IDirect3DDevice9* dev, D3DPRESENT_PARAMETERS* pp) {
    if (dev == g_device && g_imguiReady) ImGui_ImplDX9_InvalidateDeviceObjects();
    HRESULT hr = g_origReset(dev, pp);
    if (dev == g_device && g_imguiReady && SUCCEEDED(hr)) ImGui_ImplDX9_CreateDeviceObjects();
    Log("device Reset -> 0x%08X", (unsigned)hr);
    return hr;
}

// ---------------------------------------------------------------- start-up
static DWORD WINAPI InitThread(LPVOID) {
    // Wait for the exe's code to be readable and match (SecuROM may decrypt it after start).
    DWORD t0 = GetTickCount();
    bool all = false;
    while (GetTickCount() - t0 < 300000) {
        all = CheckSigs();
        if (SigOk(game::kRendererInit)) break;
        Sleep(100);
    }
    if (!SigOk(game::kRendererInit)) { Log("renderer code doesn't match v1.0.254.2; trainer disabled"); return 0; }
    Log("code check: %s (after %lums)", all ? "all features match" : "some features unavailable", GetTickCount() - t0);
    g_menuDik = VkToDik(g_cfg.menuKey);
    g_noclipDik = VkToDik(g_cfg.noclipKey);

    // Wait for the game's D3D9 device.
    IDirect3DDevice9* dev = nullptr;
    for (;;) {
        if (Read(game::kDevicePtr, dev) && dev) break;
        Sleep(50);
    }
    Sleep(200);  // let the game finish setting the device up
    Read(game::kDevicePtr, dev);
    void** vt = nullptr;
    if (!Read(reinterpret_cast<uintptr_t>(dev), vt) || !vt) { Log("device %p has no vtable; giving up", dev); return 0; }
    g_device = dev;
    g_origPresent = reinterpret_cast<PresentFn>(vt[17]);
    g_origReset   = reinterpret_cast<ResetFn>(vt[16]);
    g_origBeginScene = reinterpret_cast<BeginSceneFn>(vt[41]);
    PatchVtable(vt, 16, reinterpret_cast<void*>(&HkReset));
    PatchVtable(vt, 17, reinterpret_cast<void*>(&HkPresent));
    PatchVtable(vt, 41, reinterpret_cast<void*>(&HkBeginScene));
    Log("D3D9 hooks installed (device %p, vtable %p)", dev, vt);

    InstallDInputHooks();
    HANDLE mh = CreateThread(nullptr, 0, MouseHookThread, nullptr, 0, nullptr);
    if (mh) CloseHandle(mh);
    HANDLE wd = CreateThread(nullptr, 0, WatchdogThread, nullptr, 0, nullptr);
    if (wd) CloseHandle(wd);

    Sleep(10000);
    if (!g_presentSeen) Log("WARNING: no Present call seen after 10 s; the menu can't draw");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        g_inst = inst;
        GetModuleFileNameA(inst, g_dir, MAX_PATH);
        char* slash = strrchr(g_dir, '\\');
        if (slash) slash[1] = 0;
        sprintf(g_iniPath, "%sDebugTrainer.ini", g_dir);
        sprintf(g_imguiIni, "%sDebugTrainer_layout.ini", g_dir);
        char logPath[MAX_PATH]; sprintf(logPath, "%sDebugTrainer.log", g_dir);
        char prevPath[MAX_PATH]; sprintf(prevPath, "%sDebugTrainer.prev.log", g_dir);
        MoveFileExA(logPath, prevPath, MOVEFILE_REPLACE_EXISTING);  // keep the last run's log (e.g. after a crash)
        g_log = fopen(logPath, "w");
        LoadConfig();
        Log("DebugTrainer " TRAINER_VERSION " loaded; menu key %s", KeyToName(g_cfg.menuKey));
        HANDLE h = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
        if (h) CloseHandle(h);
    }
    return TRUE;
}
