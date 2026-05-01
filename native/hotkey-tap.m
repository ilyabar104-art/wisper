// hotkey-tap: macOS hold-to-talk hotkey listener that CONSUMES matching key
// events (so Space etc. in a combo doesn't bleed into the active app).
//
// Protocol:
//   stdin commands (one per line):
//     SET <comma-separated CGKeyCodes>   set the active hotkey combo
//     QUIT                                graceful shutdown
//   stdout events (one per line):
//     READY                                tap installed and running
//     DOWN                                 combo just became fully held
//     UP                                   combo just released
//     ERROR <message>                      fatal init error
//
// Build:
//   clang -O2 -fobjc-arc -framework Cocoa -framework ApplicationServices \
//         hotkey-tap.m -o hotkey-tap

#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <stdio.h>
#import <string.h>
#import <stdlib.h>

// State (accessed from main run loop only).
static NSMutableSet<NSNumber *> *gTarget;   // target keycodes (Set<int>)
static NSMutableSet<NSNumber *> *gPressed;  // currently held subset
static BOOL gActive = NO;
static CFMachPortRef gTap = NULL;

// Printable keys we always swallow while the combo is active, even if they're
// not part of the configured combo. This prevents Option+Space (or similar)
// from leaking a character into the focused app when the user holds them
// together with a modifier-only hotkey.
//   49  = Space
//   48  = Tab
//   50  = Backquote (`)
static BOOL isPrintableSwallowKey(int64_t kc) {
    return kc == 49 || kc == 48 || kc == 50;
}

// Modifier keycode → CGEventFlags mask (for distinguishing press/release in flagsChanged).
static CGEventFlags maskForModifier(int64_t kc) {
    switch (kc) {
        case 54: case 55: return kCGEventFlagMaskCommand;
        case 56: case 60: return kCGEventFlagMaskShift;
        case 58: case 61: return kCGEventFlagMaskAlternate;
        case 59: case 62: return kCGEventFlagMaskControl;
        case 57:          return kCGEventFlagMaskAlphaShift;  // CapsLock
        case 63:          return kCGEventFlagMaskSecondaryFn; // Fn
        default:          return 0;
    }
}

static void emit(const char *line) {
    fputs(line, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

// Returns YES if the event should be consumed.
static BOOL updateState(int64_t keycode, BOOL isDown) {
    NSNumber *kc = @(keycode);
    if (![gTarget containsObject:kc]) return NO;

    BOOL wasActive = gActive;

    if (isDown) [gPressed addObject:kc];
    else        [gPressed removeObject:kc];

    BOOL allHeld = gTarget.count > 0 && [gTarget isSubsetOfSet:gPressed];

    if (!gActive && allHeld) {
        gActive = YES;
        emit("DOWN");
    } else if (gActive && !allHeld) {
        gActive = NO;
        emit("UP");
    }

    // Consume keyDown only when this press completes the combo (allHeld) or the
    // combo was already active (auto-repeat / additional target keys while recording).
    // Consume keyUp only when we were active at the moment of release (balances
    // any consumed keyDown so the app never sees an orphaned key-up).
    if (isDown) return (wasActive || allHeld);
    else        return wasActive;
}

static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type,
                              CGEventRef event, void *refcon) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (gTap) CGEventTapEnable(gTap, true);
        return event;
    }

    int64_t keycode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);

    if (type == kCGEventKeyDown) {
        if (updateState(keycode, YES)) return NULL;
        if (gActive && isPrintableSwallowKey(keycode)) return NULL;
    } else if (type == kCGEventKeyUp) {
        if (updateState(keycode, NO)) return NULL;
        if (gActive && isPrintableSwallowKey(keycode)) return NULL;
    } else if (type == kCGEventFlagsChanged) {
        CGEventFlags mask = maskForModifier(keycode);
        if (mask) {
            BOOL down = (CGEventGetFlags(event) & mask) != 0;
            // Update state for combo tracking, but NEVER consume flagsChanged.
            // Modifiers don't print characters, so swallowing them serves no
            // purpose — and consuming a modifier-release event corrupts the
            // system's modifier-state tracking, which breaks subsequent
            // CGEventPost calls (e.g. our auto-paste Cmd+V gets interpreted
            // as Cmd+Alt+V because the system still thinks Alt is held).
            updateState(keycode, down);
        }
    }
    return event;
}

// Parse "SET 56,57" → set gTarget to {56, 57}.
static void handleCommand(const char *line) {
    if (strncmp(line, "SET", 3) == 0) {
        NSMutableSet *next = [NSMutableSet set];
        const char *p = line + 3;
        while (*p) {
            while (*p == ' ' || *p == ',') p++;
            if (!*p) break;
            char *end;
            long v = strtol(p, &end, 10);
            if (end > p) [next addObject:@((int64_t)v)];
            p = end;
        }
        gTarget = next;
        [gPressed removeAllObjects];
        if (gActive) {
            gActive = NO;
            emit("UP");
        }
    } else if (strcmp(line, "PASTE") == 0) {
        // Send Cmd+V via CGEventPost at HID level — works in every app
        // including Electron (which ignores AppleScript keystrokes).
        CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        if (src) {
            CGEventRef vDn = CGEventCreateKeyboardEvent(src, 9, true);   // V = 9
            CGEventSetFlags(vDn, kCGEventFlagMaskCommand);
            CGEventPost(kCGHIDEventTap, vDn);
            CFRelease(vDn);
            CGEventRef vUp = CGEventCreateKeyboardEvent(src, 9, false);
            CGEventSetFlags(vUp, kCGEventFlagMaskCommand);
            CGEventPost(kCGHIDEventTap, vUp);
            CFRelease(vUp);
            CFRelease(src);
        }
        emit("PASTED");
    } else if (strcmp(line, "QUIT") == 0) {
        CFRunLoopStop(CFRunLoopGetCurrent());
    }
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        gTarget  = [NSMutableSet set];
        gPressed = [NSMutableSet set];

        CGEventMask mask =
            CGEventMaskBit(kCGEventKeyDown) |
            CGEventMaskBit(kCGEventKeyUp) |
            CGEventMaskBit(kCGEventFlagsChanged);

        gTap = CGEventTapCreate(
            kCGSessionEventTap,
            kCGHeadInsertEventTap,
            kCGEventTapOptionDefault,   // active tap = can consume events
            mask,
            tapCallback,
            NULL
        );
        if (!gTap) {
            emit("ERROR Failed to create event tap. Grant Accessibility permission to Wisper.");
            return 1;
        }

        CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gTap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
        CGEventTapEnable(gTap, true);
        emit("READY");

        // Read stdin on a background thread, dispatch commands to main loop.
        dispatch_queue_t q = dispatch_queue_create("hotkey.stdin", DISPATCH_QUEUE_SERIAL);
        dispatch_async(q, ^{
            char buf[1024];
            while (fgets(buf, sizeof(buf), stdin)) {
                size_t n = strlen(buf);
                while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r')) buf[--n] = 0;
                char *copy = strdup(buf);
                dispatch_async(dispatch_get_main_queue(), ^{
                    handleCommand(copy);
                    free(copy);
                });
            }
            dispatch_async(dispatch_get_main_queue(), ^{
                CFRunLoopStop(CFRunLoopGetCurrent());
            });
        });

        CFRunLoopRun();
    }
    return 0;
}
