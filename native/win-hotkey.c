/*
 * win-hotkey: Windows low-level keyboard hook — hold-to-talk helper.
 * Uses SetWindowsHookEx(WH_KEYBOARD_LL) which CAN consume key events,
 * equivalent to macOS CGEventTap active mode.
 *
 * Protocol (identical to hotkey-tap):
 *   stdin  — SET <comma-separated Windows VK codes> | QUIT
 *   stdout — READY | DOWN | UP | ERROR <msg>
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
static int   g_target_n = 0;
static BOOL  g_pressed[256];
static BOOL  g_active = FALSE;
static HHOOK g_hook   = NULL;
static DWORD g_main_tid = 0;

static void emit(const char *s) { puts(s); fflush(stdout); }

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

static LRESULT CALLBACK hook_proc(int code, WPARAM wp, LPARAM lp) {
    if (code < 0) return CallNextHookEx(g_hook, code, wp, lp);

    KBDLLHOOKSTRUCT *ks = (KBDLLHOOKSTRUCT *)lp;
    DWORD vk = ks->vkCode & 0xFF;

    if (!is_target(vk)) return CallNextHookEx(g_hook, code, wp, lp);

    BOOL down = (wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN);
    BOOL up   = (wp == WM_KEYUP   || wp == WM_SYSKEYUP);
    BOOL was_active = g_active;

    if (down) g_pressed[vk] = TRUE;
    if (up)   g_pressed[vk] = FALSE;

    BOOL all_held = combo_down();

    if (!g_active && all_held)  { g_active = TRUE;  emit("DOWN"); }
    if ( g_active && !all_held) { g_active = FALSE; emit("UP");   }

    /* Consume: keydown when press completes combo OR combo already active.
       Consume: keyup when combo was active at moment of release. */
    if (down && (was_active || all_held)) return 1;
    if (up   && was_active)               return 1;

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
    memset(g_pressed, 0, sizeof(g_pressed));
    if (g_active) { g_active = FALSE; emit("UP"); }
    memcpy(g_target, vks, n * sizeof(DWORD));
    g_target_n = n;
}

static DWORD WINAPI stdin_thread(LPVOID _) {
    char buf[256];
    while (fgets(buf, sizeof(buf), stdin)) {
        int n = (int)strlen(buf);
        while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) buf[--n] = '\0';
        if (strncmp(buf, "SET", 3) == 0) apply_set(buf);
        else if (strcmp(buf, "QUIT") == 0) { PostThreadMessageA(g_main_tid, WM_QUIT, 0, 0); return 0; }
    }
    PostThreadMessageA(g_main_tid, WM_QUIT, 0, 0);
    return 0;
}

int main(void) {
    g_main_tid = GetCurrentThreadId();
    memset(g_pressed, 0, sizeof(g_pressed));

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
