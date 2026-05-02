/*
 * win-hotkey: Windows low-level keyboard hook — hold-to-talk helper.
 * Uses SetWindowsHookEx(WH_KEYBOARD_LL) which CAN consume key events,
 * equivalent to macOS CGEventTap active mode.
 *
 * Protocol:
 *   stdin  — SET <vk1,vk2,...> | CAPBEGIN | CAPEND | PASTE | QUIT
 *   stdout — READY | DOWN | UP | KEY <vk> D|U | CAPREADY | CAPEND | ERROR <msg>
 *
 * Key consumption strategy:
 *   - All keys pass through until the full combo fires.
 *   - When combo fires: inject F24+up (breaks pending Alt/Win menu) then
 *     synthetic ups for any modifiers that were let through, so the OS
 *     clears its modifier state cleanly.
 *   - After that, consume all target-key up events (both the injected-up
 *     modifiers and the directly consumed non-modifiers).
 *
 * Build (from VS Developer Command Prompt):
 *   cl /O2 /W3 native\win-hotkey.c /Fe:resources\bin\win-hotkey.exe user32.lib
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static DWORD g_target[32];
static int   g_target_n  = 0;
static BOOL  g_pressed[256];
static BOOL  g_consumed[256]; /* we ate the down for this vk */
static BOOL  g_eat_up[256];   /* eat next up (synthetic up already sent) */
static BOOL  g_active    = FALSE;
static BOOL  g_capturing = FALSE;
static HHOOK g_hook      = NULL;
static DWORD g_main_tid  = 0;

static void emit(const char *s) { puts(s); fflush(stdout); }

static void do_paste(void) {
    INPUT inp[4];
    ZeroMemory(inp, sizeof(inp));
    inp[0].type = INPUT_KEYBOARD; inp[0].ki.wVk = VK_CONTROL;
    inp[1].type = INPUT_KEYBOARD; inp[1].ki.wVk = 'V';
    inp[2].type = INPUT_KEYBOARD; inp[2].ki.wVk = 'V';  inp[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inp[3].type = INPUT_KEYBOARD; inp[3].ki.wVk = VK_CONTROL; inp[3].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(4, inp, sizeof(INPUT));
}

static BOOL combo_down(void) {
    if (g_target_n == 0) return FALSE;
    for (int i = 0; i < g_target_n; i++)
        if (!g_pressed[g_target[i] & 0xFF]) return FALSE;
    return TRUE;
}

static BOOL is_target(DWORD vk) {
    for (int i = 0; i < g_target_n; i++)
        if (g_target[i] == (vk & 0xFF)) return TRUE;
    return FALSE;
}

static BOOL is_modifier(DWORD vk) {
    return vk == VK_LMENU    || vk == VK_RMENU    ||
           vk == VK_LCONTROL || vk == VK_RCONTROL  ||
           vk == VK_LSHIFT   || vk == VK_RSHIFT    ||
           vk == VK_LWIN     || vk == VK_RWIN      ||
           vk == VK_CAPITAL;
}

/*
 * When the combo fires, fix up any modifier keys that were let through
 * (their down event reached the OS) so that:
 *  1. Alt/Win pending-menu state is cancelled (via injected F24 key).
 *  2. The OS modifier state is cleared (via synthetic key-ups).
 * We then mark those modifiers' real up events to be consumed so the OS
 * doesn't see a double up.
 *
 * Injected events re-enter the hook with LLKHF_INJECTED set and are
 * skipped immediately, so there is no recursion.
 */
static void fix_leaked_modifiers(void) {
    BOOL has_leaked_mod = FALSE;
    for (int i = 0; i < g_target_n; i++) {
        DWORD vk = g_target[i] & 0xFF;
        if (!g_consumed[vk] && is_modifier(vk) && g_pressed[vk])
            has_leaked_mod = TRUE;
    }
    if (!has_leaked_mod) return;

    /* F24 down+up: interrupts any pending Alt/Win menu activation. */
    INPUT f24[2];
    ZeroMemory(f24, sizeof(f24));
    f24[0].type = INPUT_KEYBOARD; f24[0].ki.wVk = VK_F24;
    f24[1].type = INPUT_KEYBOARD; f24[1].ki.wVk = VK_F24; f24[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, f24, sizeof(INPUT));

    /* Synthetic up for each leaked modifier to clear OS state. */
    INPUT buf[10]; int n = 0;
    ZeroMemory(buf, sizeof(buf));
    for (int i = 0; i < g_target_n && n < 10; i++) {
        DWORD vk = g_target[i] & 0xFF;
        if (g_consumed[vk] || !is_modifier(vk) || !g_pressed[vk]) continue;
        buf[n].type = INPUT_KEYBOARD;
        buf[n].ki.wVk = (WORD)vk;
        buf[n].ki.dwFlags = KEYEVENTF_KEYUP;
        /* Right-side extended keys need the extended flag. */
        if (vk == VK_RMENU || vk == VK_RCONTROL || vk == VK_RSHIFT || vk == VK_RWIN)
            buf[n].ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
        g_eat_up[vk] = TRUE; /* consume the real up when it arrives */
        n++;
    }
    if (n > 0) SendInput(n, buf, sizeof(INPUT));
}

static LRESULT CALLBACK hook_proc(int code, WPARAM wp, LPARAM lp) {
    if (code < 0) return CallNextHookEx(g_hook, code, wp, lp);

    KBDLLHOOKSTRUCT *ks = (KBDLLHOOKSTRUCT *)lp;

    /* Skip our own injected events — prevents recursion. */
    if (ks->flags & LLKHF_INJECTED) return CallNextHookEx(g_hook, code, wp, lp);

    DWORD vk = ks->vkCode & 0xFF;
    BOOL down = (wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN);
    BOOL up   = (wp == WM_KEYUP   || wp == WM_SYSKEYUP);

    /* Capture mode: swallow everything, report each event. */
    if (g_capturing) {
        char msg[32];
        sprintf(msg, "KEY %lu %c", (unsigned long)vk, down ? 'D' : 'U');
        emit(msg);
        return 1;
    }

    if (!is_target(vk)) return CallNextHookEx(g_hook, code, wp, lp);

    if (down) {
        g_pressed[vk] = TRUE;
        BOOL all_held = combo_down();

        if (!g_active && all_held) {
            g_active = TRUE;
            emit("DOWN");
            /* Fix any modifiers that were let through. */
            fix_leaked_modifiers();
            /* Consume the key that just completed the combo. */
            g_consumed[vk] = TRUE;
            return 1;
        }

        if (g_active) {
            /* Combo already active — consume. */
            g_consumed[vk] = TRUE;
            return 1;
        }

        /* Combo not yet active — let this key through normally. */
        g_consumed[vk] = FALSE;
        return CallNextHookEx(g_hook, code, wp, lp);
    }

    if (up) {
        g_pressed[vk] = FALSE;
        if (g_active && !combo_down()) { g_active = FALSE; emit("UP"); }
        BOOL eat = g_consumed[vk] || g_eat_up[vk];
        g_consumed[vk] = FALSE;
        g_eat_up[vk]   = FALSE;
        return eat ? 1 : CallNextHookEx(g_hook, code, wp, lp);
    }

    return CallNextHookEx(g_hook, code, wp, lp);
}

static void apply_set(const char *line) {
    const char *p = line + 3; /* skip "SET" */
    DWORD vks[32]; int n = 0;
    while (*p && n < 32) {
        while (*p == ' ' || *p == ',') p++;
        if (!*p) break;
        char *end;
        long v = strtol(p, &end, 10);
        if (end > p && v > 0 && v < 256) vks[n++] = (DWORD)v;
        p = end;
    }
    memset(g_pressed,  0, sizeof(g_pressed));
    memset(g_consumed, 0, sizeof(g_consumed));
    memset(g_eat_up,   0, sizeof(g_eat_up));
    if (g_active) { g_active = FALSE; emit("UP"); }
    memcpy(g_target, vks, n * sizeof(DWORD));
    g_target_n = n;
}

static DWORD WINAPI stdin_thread(LPVOID _) {
    char buf[256];
    while (fgets(buf, sizeof(buf), stdin)) {
        int n = (int)strlen(buf);
        while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) buf[--n] = '\0';
        if      (strncmp(buf, "SET", 3) == 0)   apply_set(buf);
        else if (strcmp(buf, "CAPBEGIN") == 0) {
            memset(g_pressed, 0, sizeof(g_pressed));
            memset(g_consumed, 0, sizeof(g_consumed));
            memset(g_eat_up,   0, sizeof(g_eat_up));
            if (g_active) { g_active = FALSE; emit("UP"); }
            g_capturing = TRUE;
            emit("CAPREADY");
        }
        else if (strcmp(buf, "CAPEND") == 0)  { g_capturing = FALSE; emit("CAPEND"); }
        else if (strcmp(buf, "PASTE") == 0)   { do_paste(); }
        else if (strcmp(buf, "QUIT") == 0)    { PostThreadMessageA(g_main_tid, WM_QUIT, 0, 0); return 0; }
    }
    PostThreadMessageA(g_main_tid, WM_QUIT, 0, 0);
    return 0;
}

int main(void) {
    g_main_tid = GetCurrentThreadId();
    memset(g_pressed,  0, sizeof(g_pressed));
    memset(g_consumed, 0, sizeof(g_consumed));
    memset(g_eat_up,   0, sizeof(g_eat_up));

    g_hook = SetWindowsHookEx(WH_KEYBOARD_LL, hook_proc, NULL, 0);
    if (!g_hook) {
        char msg[64];
        sprintf(msg, "ERROR SetWindowsHookEx failed (code %lu)", GetLastError());
        emit(msg);
        return 1;
    }
    emit("READY");

    HANDLE t = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
    if (!t) { emit("ERROR CreateThread failed"); UnhookWindowsHookEx(g_hook); return 1; }
    CloseHandle(t);

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    UnhookWindowsHookEx(g_hook);
    return 0;
}
