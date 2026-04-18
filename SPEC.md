# Playback Speed Control — SPEC

## Status

Working specification compiled from decisions made so far in this conversation.

---

## 1. Project Summary

**Playback Speed Control** is a **Firefox-first** WebExtension focused on one job only:

- control playback speed for web media
- do it predictably
- do it with minimal UI and minimal surface area
- avoid feature creep that causes compatibility drift

The extension is intended to be implemented with **WXT + TypeScript + React**.

The design goal is **not** to copy existing extensions. It is to build a cleaner and more maintainable implementation by avoiding the categories of problems those projects accumulated.

---

## 2. Product Goals

### Primary goals

1. **Firefox-first reliability**
2. **Minimal, clean implementation**
3. **Good compatibility with standard web media players**
4. **Low overhead and good runtime performance**
5. **Clear popup-based UX**
6. **Stable keyboard shortcut workflow**
7. **Simple persistence model**

### Practical compatibility target

The extension should work with:

- standard HTML5 `<video>` elements
- standard HTML5 `<audio>` elements when audio support is enabled
- dynamically inserted media elements
- same-page custom players that still wrap reachable media elements
- iframes/frames where extension injection is allowed

### Explicit non-goal

Do **not** promise support for literally every player implementation on the web.

Support is **best effort** for:

- heavily customized players
- unusual iframe structures
- sites that rely on page-world internals
- playback systems that do not expose standard media elements in a usable way

---

## 3. Product Scope

### In scope for v1

- set playback speed
- increase/decrease speed via shortcut or popup
- reset speed to `1x`
- preferred/default speed
- remember last used speed
- optional force/apply saved speed on load
- keyboard shortcuts
- disable extension on specific sites
- optional audio support
- popup UI as the main interface
- toolbar badge showing current speed for active tab
- optional transient toast for feedback when speed changes
- optional per-site saved speed behavior

### Out of scope for v1

- visual effects
- volume boost
- pitch manipulation
- rewind/advance controls
- frame-by-frame stepping
- subtitle controls or subtitle synchronization logic
- progress restore / resume playback position
- permanent floating controller overlay as default UI
- cross-tab/global-context inheritance models
- broad site-specific hacks as default behavior

---

## 4. UX / UI Decisions

## 4.1 Main UI model

The **main user interface** should be the **extension popup** opened from the toolbar icon.

The popup should have:

- a **default compact view** for the most common actions
- an **expanded settings view** inside the same popup
- clean, clear UI/UX
- no separate options page in v1 unless implementation constraints make it necessary later

### Compact/default popup view

Should expose only the high-frequency controls:

- current detected speed
- speed up
- speed down
- reset to `1x`
- preferred speed quick control
- current site enabled/disabled state
- optional audio toggle shortcut/access if needed

### Expanded/settings popup view

Should expose:

- keyboard shortcut mapping/config
- preferred/default speed
- remember last speed toggle
- per-site save behavior toggle
- force/apply saved speed on load toggle
- audio support toggle
- disabled sites list
- optional toast toggle
- any additional minimal settings that directly support playback speed behavior

### UI principle

The popup should feel like:

- minimal first
- settings second
- everything in one place
- no unnecessary pages or navigation layers

## 4.2 Popup persistence / pinning

Desired by user, but **not selected for v1 as a native extension-popup behavior**.

Reason:

- standard extension popups auto-close when the user clicks outside them
- a true persistent/pinned popup would require a different UI mode than a normal toolbar popup

### Selected handling for v1

- popup remains a normal extension popup
- compact view + expanded settings live inside the same popup

### Deferred alternative

If persistent inspector-style UI is needed later, evaluate a separate dedicated extension page/window/panel mode.

## 4.3 User feedback model

### Selected

1. **Toolbar badge** shows current speed for the active tab when eligible media is present
2. **Popup** shows current speed and controls
3. **Optional transient toast** provides on-page feedback when a shortcut changes speed

### Rejected for v1

- permanent floating on-page controller as default behavior

Reason:

- it adds DOM/CSS/z-index/event-surface complexity
- it is a common source of site conflicts
- it is not required if badge + popup + optional toast cover feedback well

---

## 5. Functional Requirements

## 5.1 Core speed behavior

The extension must support:

- increase speed by configured increment
- decrease speed by configured increment
- set exact preferred/default speed
- reset speed to `1x`
- apply remembered speed when configured

### Default assumptions

Initial default values are:

- speed step: `0.1`
- reset speed: `1.0`
- preferred/default speed: `1.0`
- auto-restore speed on new media: enabled

These are defaults only, not hard-coded constraints.

## 5.2 Persistence

The extension must support these distinct persistence behaviors:

### Preferred/default speed

A user-defined preferred speed that acts as the default chosen speed.

### Remember last used speed

Store the last extension-owned speed for reuse when enabled.

### Effective speed authority

The runtime authority rules must be seamless and fixed in product behavior, not exposed as a user-facing mode switch.

Selected behavior:

- the current extension speed is the authoritative speed used by the extension
- if the user changes speed through the player UI or player shortcuts, that observed speed becomes the new current extension speed
- startup/internal player `ratechange` events must not be treated as user intent
- startup/internal player `ratechange` events must not overwrite remembered speed
- legacy remembered-speed data without current provenance metadata must not be auto-restored as authoritative speed

### Save scope

The user should be able to choose whether saved speed behavior is:

- **global**
- **per-site**

If per-site mode is enabled, saved speed should be stored and applied based on the current site.

### Force/apply saved speed on load

Optional setting to actively re-apply the remembered/preferred speed on media load, for sites that override playback speed.

Important distinction:

- **remember last speed** = save the last extension-owned value
- **save scope** = global or per-site
- **force/apply on load** = actively re-apply speed when new media is initialized or a site resets it

Implementation rules:

- pages without eligible media must remain dormant
- non-media pages must not intercept extension shortcuts
- restoring speed during media initialization must not poison remembered speed with fallback or transient player values such as the clamp floor
- extension runtime must avoid repeated whole-document rescans in normal steady-state control paths
- subframes without eligible media must not emit dormant state, win frame selection, or become action targets
- startup speed restore must wait for a playback-ready lifecycle point rather than forcing speed during very early media initialization

## 5.3 Audio support

Audio should be supported only when explicitly enabled.

Rationale:

- main project focus is video
- audio support is useful but secondary
- keeping audio optional reduces accidental impact

## 5.4 Disabled sites

The extension must allow users to disable it on selected sites.

v1 behavior:

- store disabled site rules as user-managed entries
- support one entry per line
- keep matching simple and understandable

### Selected v1 rule model

Start with **simple host/domain entries only**.

Examples:

- `youtube.com`
- `www.youtube.com`
- `m.youtube.com`
- `vimeo.com`

This means v1 does **not** start with wildcard patterns, regex, or advanced URL syntax.

## 5.5 Keyboard shortcuts

Keyboard shortcuts are required.

Required actions:

- increase speed
- decrease speed
- reset speed
- apply preferred/default speed
- optional toggle toast if later useful

Initial default shortcut values:
- increase speed: `d`
- decrease speed: `s`

### Important behavior rule

Shortcuts must not operate on an undefined target. The extension needs a deterministic target-selection strategy.

---

## 6. Media Targeting Model

A major source of bugs in existing extensions is ambiguous targeting when a page contains multiple media elements.

### Selected targeting strategy for v1

When the user changes speed, target media in this order:

1. **Last interacted eligible media element** in the current tab/frame
2. Otherwise, the **currently playing visible video** most likely to be primary
3. Otherwise, the **largest visible eligible video**
4. Otherwise, the **first eligible media element** discovered in the page/frame

### Eligible media element

- `<video>` always eligible
- `<audio>` eligible only when audio support is enabled

### Requirements

- media discovery must update as the page changes
- dynamically inserted elements must be tracked
- stale references must be cleaned up

---

## 7. Compatibility Strategy

## 7.1 Supported path

The core implementation should target **reachable standard media elements**.

That means v1 should primarily operate through standard media APIs on discovered media elements.

## 7.2 Best-effort path

Best-effort compatibility includes:

- custom players wrapping standard media elements
- media inserted after initial load
- shadow-DOM-contained media where reachable
- frames where extension injection is allowed

## 7.3 Not guaranteed

Not guaranteed in v1:

- every custom player on the web
- every page-world-only player setup
- every unusual embedded/third-party player architecture
- deep site-specific compatibility fixes

## 7.4 Policy on page-specific hacks

Do not start with a large library of site-specific hacks.

Preferred order:

1. standards-based implementation
2. robust media detection
3. clean fallback behavior
4. site-specific compatibility fixes only when justified

---

## 8. Performance Requirements

The extension should remain lightweight and avoid the common pattern of turning a simple utility into a heavy runtime layer.

### Requirements

- very small content-script bootstrap
- no constant polling
- use event-driven updates where possible
- use a minimal observer strategy for dynamic media discovery
- avoid expensive repeated DOM scans
- avoid repeated storage writes for every tiny state change
- debounce or batch persistence where appropriate
- avoid unnecessary layout reads/writes
- keep popup logic isolated from page logic

### Principle

This should behave like a focused utility, not a mini app injected into every page.

---

## 9. Architecture

## 9.1 Stack

- **WXT**
- **TypeScript**
- **React**
- Firefox-first target
- one codebase, with browser portability as a secondary benefit rather than the initial product goal

## 9.2 Main parts

### A. Background/runtime layer

Responsibilities:

- manage extension-level state
- manage toolbar badge updates
- coordinate tab-specific state
- handle extension commands and messaging

### B. Content script layer

Responsibilities:

- discover eligible media elements
- observe dynamic page changes
- apply speed changes to target media
- emit active-media and current-speed updates
- optionally show transient toast feedback

### C. Popup UI layer

Responsibilities:

- compact control view
- expanded settings view
- read/update settings
- show current tab speed/status
- allow per-site enable/disable action

### D. Shared domain modules

Suggested modules:

- `settings`
- `siteRules`
- `mediaRegistry`
- `targetSelection`
- `speedController`
- `badgeState`
- `toast`
- `messaging`

---

## 10. Suggested Repo Structure

```text
entrypoints/
  background.ts
  content.ts
  popup/
    App.tsx
    components/
    styles.css
src/
  core/
    mediaRegistry.ts
    targetSelection.ts
    speedController.ts
    siteRules.ts
    settings.ts
    badgeState.ts
    messaging.ts
    toast.ts
  types/
    settings.ts
    messages.ts
  utils/
    numbers.ts
    urls.ts
    dom.ts
public/
  icons/
```

The exact WXT entrypoint layout can be adjusted to the generated template, but this separation should remain.

---

## 11. Settings Model

### Selected settings for v1

- extension enabled
- preferred/default speed
- speed increment step
- remember last used speed
- save scope: global or per-site
- apply/force saved speed on load
- work on audio
- disabled sites list
- toast enabled
- shortcut mappings

Do not add a user-facing speed-authority mode toggle. The authority behavior is part of the fixed runtime design.

### Suggested stored shapes

```ts
interface AppSettings {
  enabled: boolean;
  preferredSpeed: number;
  speedStep: number;
  rememberLastSpeed: boolean;
  saveScope: 'global' | 'site';
  forceSavedSpeedOnLoad: boolean;
  workOnAudio: boolean;
  toastEnabled: boolean;
  disabledSites: string[];
  shortcuts: ShortcutConfig[];
}

interface SavedSpeedEntry {
  value: number;
  updatedAt: number;
}

interface GlobalPlaybackState {
  lastSpeed?: SavedSpeedEntry;
}

interface SitePlaybackState {
  siteKey: string;
  lastSpeed?: SavedSpeedEntry;
}
```

### State model rule

Keep storage intentionally simple. Do not introduce complex inheritance/state layers in v1.

Store remembered speed with enough metadata to distinguish current trusted entries from legacy ambiguous entries.

---

## 12. Badge Behavior

### Selected behavior

- toolbar badge displays current effective speed for the active tab when eligible media is present
- if no eligible media is detected, do not show the speed number on the icon
- badge should update when:
  - active media changes
  - speed changes
  - tab changes
  - navigation invalidates previous state

### Display guidance

Badge text should stay short and readable, such as:

- `1x`
- `1.5`
- `2x`

Avoid overloading the badge with extra meaning.

---

## 13. Toast Behavior

### Status

Selected as **optional**, but **enabled by default**.

### Purpose

Provide immediate feedback when speed changes via keyboard shortcuts.

### Requirements

- small
- transient
- non-interactive
- very low visual weight
- almost transparent
- must not hinder the video or page view
- must not persist as a floating controller
- must not capture focus
- easy to disable

### Example content

- `1.25x`
- `1.5x`
- `Reset to 1x`

---

## 14. Popup UX Specification

## 14.1 Compact view contents

- current speed display
- minus/decrease action
- plus/increase action
- reset action
- preferred/default speed quick action or input
- current site enabled/disabled toggle
- entry to expand settings

## 14.2 Expanded settings contents

- preferred speed input
- step size input
- remember last speed toggle
- save scope selector: global or per-site
- force saved speed on load toggle
- audio support toggle
- toast toggle
- disabled sites editor
- shortcut editor

## 14.3 UX rules

- compact view should satisfy most daily use without expansion
- settings should remain understandable at a glance
- minimize jargon in user-facing labels
- no cluttered matrix-style layout
- use clear grouping: playback, persistence, sites, shortcuts, feedback

---

## 15. Reliability Rules

The implementation should intentionally avoid the known failure categories seen in similar projects.

### Must avoid where possible

- overlay UI conflicts with page layout
- ambiguous target media selection
- overly broad feature surface
- cross-tab state leakage
- site-specific hacks as baseline architecture
- hidden global modes that users cannot reason about
- excessive content-script work on pages with no media
- inconsistent saved-speed behavior
- shortcut behavior that silently targets the wrong element

### Design principle

A smaller correct feature set is better than a broader unstable one.

---

## 16. Testing / Acceptance Criteria

## 16.1 Core acceptance criteria

The extension is acceptable for v1 if it can reliably do the following:

- change speed on standard HTML5 video players
- remember and reapply saved speed when configured
- support global or per-site saved speed behavior
- avoid affecting disabled sites
- update badge correctly for the active tab
- allow all essential controls from the popup
- provide working keyboard shortcuts
- handle dynamically inserted media on common sites
- avoid noticeable performance degradation on normal browsing pages
- avoid changing or intercepting pages that do not contain eligible media
- do not reset startup playback to the clamp floor unless the user explicitly chose that speed

## 16.2 Manual test matrix

Minimum manual coverage should include:

- single video page
- page with multiple videos
- page with audio only
- dynamic SPA navigation
- media inside iframes where accessible
- site with custom controls but standard media underneath
- disabled site behavior
- shortcut conflicts/basic usability
- badge updates across tab switches

---

## 17. Deferred Items

These are not rejected permanently, but are intentionally deferred.

### Deferred

- persistent/pinned inspector-style UI
- separate options page
- permanent floating controller
- rewind/advance controls
- richer site rule system
- site-specific compatibility adapters
- multi-browser optimization beyond Firefox-first goals

---

## 18. Rejected for Current Scope

### Rejected

- expanding into a broad media utility extension
- adding unrelated playback features in v1
- making the on-page floating controller part of the default interaction model
- building around old projects as a baseline design reference
- describing the project as universal support for all players

---

## 19. Remaining Minor Decisions

These can be finalized once the bootstrap zip is uploaded and the repo structure is visible.

1. Popup implementation details will follow the actual WXT + React bootstrap structure.
2. Disabled-site matching starts with host/domain entries only; advanced syntax can be evaluated later if needed.
3. Badge remains empty when no eligible media is present.
4. Toast is enabled by default.

---

## 20. Recommended v1 Definition

If implementation starts now, **v1** should be defined as:

> A Firefox-first extension built with WXT + TypeScript + React that provides reliable playback speed control for standard web media through a compact popup, keyboard shortcuts, a badge showing current speed when media is active, optional global or per-site saved-speed behavior, disabled-site rules, optional audio support, and optional transient toast feedback.

Anything beyond that should be treated as a deliberate later expansion, not automatic v1 scope.

