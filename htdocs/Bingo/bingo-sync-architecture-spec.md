# Bingo App — SQL Persistence & Offline Sync Architecture Specification
**Version:** 1.0  
**Status:** Ready for Implementation  
**Scope:** Card library persistence, game/pattern persistence, offline-first sync, per-user favorites  

---

## 1. Context & Goals

The Bingo app is a browser-based bar bingo tracker. It currently stores cards and games in JSON files on the server. This specification replaces that with a SQL database backend while preserving full offline functionality.

### Core Requirements
- Any user can create, save, and load cards from a global shared library
- All features must work completely offline; server sync happens opportunistically
- Authenticated SuiteProfile users can favorite cards; guests get read-only library access
- No concurrent write contention is expected — cards are write-once, read-many
- Local state is always immediately written; server is updated as soon as reachable

### Out of Scope
- Real-time multiplayer card state (daubing is session-local)
- Server-side win detection
- Player-facing card browser (caller tool only, for now)

---

## 2. Locked Design Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Source of truth | Local-first; server is durable mirror | Offline usability is non-negotiable |
| Conflict resolution | Last-write-wins via unconditional upsert | No concurrent writers in practice |
| Offline mode depth | Full CRUD — create/edit cards, select games, call numbers | Bars have unreliable networks |
| Card ID strategy | Client-generated UUID via `crypto.randomUUID()` | Eliminates temp-ID reconciliation problem |
| Library scope | Global — all saved cards visible to all users | Shared card pool across game nights |
| Favorites | SuiteProfile-authenticated users only | Guests get read-only library access |
| Games/patterns offline | Cached locally for read; creation allowed offline | Same outbox pattern as cards |
| Sync mechanism | Outbox queue in `localStorage`, drained on reconnect | Simple, reliable, no service worker required |
| Server reachability | Explicit HEAD ping to `/api/health` before drain | `navigator.onLine` alone is insufficient |## 3. SQL Schema

### 3.1 `bingo_cards`
Stores the global shared card library. One row per unique card.

```sql
CREATE TABLE bingo_cards (
    id          VARCHAR(36)   NOT NULL,           -- client-generated UUID
    label       VARCHAR(100)  NOT NULL DEFAULT '',
    serial      VARCHAR(50)   NOT NULL DEFAULT '',
    squares     JSON          NOT NULL,           -- 25-element array; index 12 = 'FREE'
    created_by  VARCHAR(100)  DEFAULT NULL,       -- SuiteProfile userId; NULL = guest-created
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at  DATETIME      DEFAULT NULL,       -- soft delete; NULL = active
    PRIMARY KEY (id),
    INDEX idx_bingo_cards_updated (updated_at),
    INDEX idx_bingo_cards_created_by (created_by)
);
```

**Notes:**
- Soft delete via `deleted_at` — never hard-delete rows. All GET queries filter `WHERE deleted_at IS NULL`.
- `squares` JSON must always be exactly 25 elements. Server validates length on upsert and rejects malformed payloads with 400.
- `created_by` is nullable to support guest-created cards. Ownership can be claimed post-login (see §7.4).

---

### 3.2 `bingo_card_favorites`
Junction table for per-user card favorites. Authenticated users only.

```sql
CREATE TABLE bingo_card_favorites (
    user_id       VARCHAR(100)  NOT NULL,         -- SuiteProfile userId
    card_id       VARCHAR(36)   NOT NULL,         -- FK → bingo_cards.id
    favorited_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, card_id),
    FOREIGN KEY (card_id) REFERENCES bingo_cards(id) ON DELETE CASCADE,
    INDEX idx_bingo_favorites_user (user_id)
);
```

**Notes:**
- `ON DELETE CASCADE` ensures favorites are automatically cleaned up when a card is deleted.
- No UPDATE operation — favorites are toggled via PUT (insert) and DELETE (remove).

---

### 3.3 `bingo_games`
Stores game mode definitions. Built-in games are seeded at deploy time.

```sql
CREATE TABLE bingo_games (
    id          VARCHAR(36)   NOT NULL,           -- client-generated UUID
    name        VARCHAR(100)  NOT NULL,
    builtin     TINYINT(1)    NOT NULL DEFAULT 0, -- 1 = system game, cannot be deleted
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at  DATETIME      DEFAULT NULL,
    PRIMARY KEY (id),
    INDEX idx_bingo_games_builtin (builtin)
);
```

---

### 3.4 `bingo_patterns`
Stores win patterns belonging to a game. Each game has 1–N patterns.

```sql
CREATE TABLE bingo_patterns (
    id          VARCHAR(36)   NOT NULL,           -- client-generated UUID
    game_id     VARCHAR(36)   NOT NULL,           -- FK → bingo_games.id
    name        VARCHAR(100)  NOT NULL,
    cells       JSON          NOT NULL,           -- array of cell indices (0–24); 12 = FREE always included
    sort_order  INT           NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    FOREIGN KEY (game_id) REFERENCES bingo_games(id) ON DELETE CASCADE,
    INDEX idx_bingo_patterns_game (game_id)
);
```

**Notes:**
- Game upsert (PUT `/api/games/{gameId}`) is atomic: replaces all patterns for that game in a single transaction. Delete existing patterns for `game_id`, then insert new ones.
- `sort_order` preserves the order patterns were defined in the game creator UI.

---

## 4. API Contract

All endpoints return `Content-Type: application/json`. Authentication is read from the existing SuiteProfile session mechanism (cookie or header — match whatever `tracking.js` already uses for `SuiteProfile.saveAppData`).

### 4.1 Health Check
```
HEAD  /api/health
→ 200 OK  (no body)
```
Used exclusively for reachability ping before outbox drain. Must respond in < 2s or the client treats it as unreachable.

---

### 4.2 Cards

```
GET  /api/cards
```
Returns all active (non-deleted) cards in the global library.  
Query param: `?userId={suiteProfileUserId}` — when provided, each card object includes `isFavorite: bool`.  
Response shape:
```json
[
  {
    "id": "uuid",
    "label": "Card 1",
    "serial": "SN-001",
    "squares": [1, 14, 32, null, "FREE", ...],
    "createdBy": "userId | null",
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601",
    "isFavorite": false
  }
]
```

---

```
PUT  /api/cards/{cardId}
```
Upsert a card. Inserts if `id` does not exist; overwrites all fields if it does.  
Body:
```json
{
  "label": "Card 1",
  "serial": "SN-001",
  "squares": [...],
  "createdBy": "userId | null",
  "updatedAt": "ISO8601"
}
```
Response: `200 OK` with the saved card object.  
Error responses:
- `400` — `squares` is not exactly 25 elements, or UUID format invalid
- `409` — UUID collision detected on a non-matching card (astronomically rare; client should regenerate UUID and retry)

---

```
DELETE  /api/cards/{cardId}
```
Soft-deletes the card by setting `deleted_at = NOW()`.  
Response: `204 No Content`.  
Error: `404` if card does not exist or is already deleted.

---

### 4.3 Favorites

```
PUT  /api/favorites/{cardId}
```
Adds a favorite for the authenticated user. Idempotent — if already favorited, returns 200 with no change.  
Requires: authenticated SuiteProfile session. Returns `401` for guests.  
Response: `200 OK`

---

```
DELETE  /api/favorites/{cardId}
```
Removes a favorite for the authenticated user.  
Response: `204 No Content`. Returns `404` if favorite does not exist.

---

### 4.4 Games

```
GET  /api/games
```
Returns all active games with their patterns, ordered: built-ins first, then custom alphabetically.  
Response shape:
```json
[
  {
    "id": "uuid",
    "name": "Regular Bingo",
    "builtin": true,
    "patterns": [
      {
        "id": "uuid",
        "name": "Row 1",
        "cells": [0,1,2,3,4],
        "sortOrder": 0
      }
    ]
  }
]
```

---

```
PUT  /api/games/{gameId}
```
Atomic upsert of a game and all its patterns. Replaces existing patterns for this game entirely.  
Body:
```json
{
  "name": "Four Corners",
  "patterns": [
    { "id": "uuid", "name": "Corners", "cells": [0,4,20,24], "sortOrder": 0 }
  ],
  "updatedAt": "ISO8601"
}
```
Response: `200 OK` with full game + patterns object.  
Error: `403` if attempting to modify a built-in game.

---

```
DELETE  /api/games/{gameId}
```
Soft-deletes the game. Cascades to `bingo_patterns`.  
Response: `204 No Content`.  
Error: `403` if `builtin = 1`.

---

## 5. Client Sync State Machine

### 5.1 States

| State | Description |
|---|---|
| `IDLE` | Outbox is empty. Local and server are in sync. |
| `DIRTY` | One or more outbox entries are pending. Network not yet attempted. |
| `SYNCING` | Actively draining the outbox. Network is reachable. |
| `OFFLINE_DIRTY` | Outbox has pending entries but network/server is unreachable. |
| `PARTIAL_FAILURE` | Drain completed but one or more entries failed after max retries. |

### 5.2 Transition Table

| From | To | Trigger |
|---|---|---|
| `IDLE` | `DIRTY` | Any local write (card create/edit, game create) |
| `DIRTY` | `SYNCING` | `navigator.onLine === true` AND `/api/health` ping succeeds |
| `DIRTY` | `OFFLINE_DIRTY` | `navigator.onLine === false` OR ping fails |
| `OFFLINE_DIRTY` | `SYNCING` | `online` event fires AND ping succeeds |
| `SYNCING` | `IDLE` | All outbox entries drained with server confirmation |
| `SYNCING` | `OFFLINE_DIRTY` | Network drops mid-drain (ping fails on retry) |
| `SYNCING` | `PARTIAL_FAILURE` | One or more entries fail after `maxRetries` with non-network error |
| `PARTIAL_FAILURE` | `SYNCING` | Exponential backoff timer fires AND ping succeeds |

### 5.3 State Diagram

```
                    ┌─────────────────┐
                    │      IDLE       │◄──────────────────────┐
                    │  (clean state)  │                       │
                    └────────┬────────┘                       │ all entries confirmed
                             │ local write                    │
                             ▼                                │
                    ┌─────────────────┐               ┌───────────────┐
                    │     DIRTY       │               │    SYNCING    │
                    │ (outbox pending)│               │ (draining     │
                    └────────┬────────┘               │  outbox)      │
                             │                        └──────┬────────┘
               ┌─────────────┴──────────────┐               │
          ping │ succeeds               ping │ fails         │ network drops
               ▼                             ▼               ▼
      ┌─────────────────┐          ┌─────────────────┐
      │    SYNCING      │          │  OFFLINE_DIRTY  │
      │                 │◄─────────│  (waiting)      │
      └─────────────────┘  online  └─────────────────┘
               │           + ping
               │ entry fails
               │ after max retries
               ▼
      ┌─────────────────┐
      │ PARTIAL_FAILURE │
      │ (retry backoff) │
      └─────────────────┘
```

---

## 6. Client Outbox Schema

Stored in `localStorage` under key `bingoOutbox`. Value is a JSON array of entry objects.

```
OutboxEntry {
  id          : string      -- UUID for this outbox entry (not the entity ID)
  entityType  : 'card' | 'game'
  entityId    : string      -- UUID of the card or game being synced
  operation   : 'upsert' | 'delete'
  payload     : object      -- full entity snapshot at time of queue (null for deletes)
  queuedAt    : number      -- Unix timestamp ms
  status      : 'pending' | 'syncing' | 'failed'
  retryCount  : number
  lastError   : string | null
}
```

### 6.1 Outbox Rules

1. **Write local first, then queue.** Every local write completes synchronously before the outbox entry is created. The user never waits for the server.
2. **Never mark `done` optimistically.** An entry remains `syncing` until the server returns a 2xx response. On any failure, roll back to `pending`.
3. **Process in `queuedAt` order.** Drain oldest entries first to preserve causal ordering.
4. **Collapse upsert → delete pairs.** Before starting a drain cycle, scan the outbox for entries with the same `entityId`. If an `upsert` is followed by a `delete` for the same entity, collapse them into a single `delete` entry. Discard orphaned `upsert` entries for entities that were subsequently deleted locally.
5. **Max retries = 3** for non-network errors (4xx server errors). Network errors (fetch throws, timeout) do not count toward retry limit — transition to `OFFLINE_DIRTY` instead.
6. **Failed entries persist.** Status `failed` entries remain in the outbox and surface a non-blocking warning in the UI. They are retried on the next drain cycle (next reconnect or app reload).

---

## 7. Edge Cases & Failure Modes

### 7.1 Mid-Drain Disconnect
During a drain cycle, if the network drops between entries:
- The current in-flight entry (status `syncing`) rolls back to `pending`
- The drain loop halts
- Sync state transitions to `OFFLINE_DIRTY`
- On reconnect, drain resumes from the beginning of the `pending` entries

### 7.2 Server Reachability vs. `navigator.onLine`
`navigator.onLine` can return `true` while the server is unreachable (server down, local network issues, captive portal). Always perform an explicit `HEAD /api/health` ping before initiating a drain cycle. Treat any non-200 response or timeout (> 3s) as unreachable.

### 7.3 Outbox Upsert → Delete Collapse
If a user creates a card offline (outbox: `upsert`) and then removes it before reconnecting (outbox: `delete`):
- Collapse these two entries into a single `delete` operation
- If the entity never reached the server (no prior confirmed sync), discard both entries entirely — there is nothing to delete on the server
- Track whether an entity has ever been successfully synced using a `syncedAt` field on the outbox entry (populated on first successful drain)

### 7.4 Guest Card Claiming on Login
Guest-created cards exist in `localStorage.bingoSession` with `createdBy: null` and may be in the outbox with `createdBy: null`. On a SuiteProfile `login` event:
- Scan the outbox for entries with `createdBy: null`
- Update those entries to set `createdBy` to the newly authenticated userId
- Re-queue them as `pending` to ensure the server record is updated
- Optionally surface a one-time prompt: "Claim X cards you created as a guest?" (acceptable to do silently given low stakes)

### 7.5 Offline Library Load
When the user opens the card library while offline:
- Serve from `localStorage` cache keyed `bingoCardLibraryCache` (populated on last successful `GET /api/cards`)
- Display a non-blocking badge: "Cached — last updated [relative time]"
- This is a degraded-but-functional state, not an error state
- Disable the favorite toggle in this state (cannot confirm with server)

### 7.6 UUID Collision (Defensive)
In the event the server detects a UUID collision (same `id`, different `squares` content — astronomically unlikely):
- Server returns `409 Conflict` with body `{ "error": "uuid_collision" }`
- Client regenerates a new UUID for the entity, updates `localStorage`, re-queues the outbox entry
- This path must exist in code but is not expected to fire in production

### 7.7 Favorites on Deleted Cards
Handled at the database level via `ON DELETE CASCADE` on `bingo_card_favorites.card_id`. No client-side handling required. The next `GET /api/cards` refresh will not return the deleted card, and the favorite entry will already be gone.

### 7.8 Games List Stale Mid-Game
If `availableGames` is empty (server unreachable on load), all win detection silently returns `null`. This is the current bug. Mitigation:
- Cache last successful `GET /api/games` response in `localStorage` under key `bingoGamesCache`
- On load, always attempt server fetch; if it fails, fall back to cache immediately (no delay)
- `getSelectedGame()` should resolve against the cache, not only the in-memory `availableGames` array
- Display a subtle "Using cached games" indicator in the game mode selector when operating from cache

---

## 8. Known Bugs to Fix Before Implementation

These bugs exist in the current codebase and must be resolved as part of this work:

### 8.1 🔴 Critical — Duplicate `const VERSION` declaration (scan.html)
`ocr.js` declares `const VERSION = '1.3'` at module scope. `scan.html`'s inline `<script>` block also declares `const VERSION = '1.3'`. Because both share the same global scope, this throws `SyntaxError: Identifier 'VERSION' has already been declared` at parse time, killing the **entire inline script block**. Result: card editor grid never renders, no button handlers attach, camera never initializes.

**Fix:** Remove or rename the `VERSION` constant in `scan.html`'s inline script. Use `const SCAN_PAGE_VERSION` or read `VERSION` from `ocr.js` directly.

### 8.2 🔴 Critical — Duplicate `const VERSION` declaration (game-creator.html)
`game-creator.html` declares `const VERSION = '1.1'` **twice within the same inline script block**. This is a self-collision that throws the same `SyntaxError`, making the entire game creator page non-functional.

**Fix:** Remove the second declaration entirely.

### 8.3 🟠 Server card re-save always creates duplicate
`saveCardToServer()` in `scan.html` uses `id: Date.now()` unless `currentMode === 'edit'` (which refers to session-card editing, not server-card editing). Loading a card from the server library and re-saving always inserts a new row rather than updating the existing one.

**Fix:** When a card is loaded from the server library, store its `id` in a variable (e.g. `loadedServerCardId`). Pass that `id` in the PUT body so the server upserts the correct row. This is resolved naturally by the UUID upsert model in this spec.

### 8.4 🟠 `availableGames` not cached — win detection silently fails offline
`loadGames()` populates `availableGames` from a server fetch with no localStorage fallback. On failure, `availableGames = []` and `getSelectedGame()` returns `null`. All win detection, one-away detection, and ball-needs calculations silently return null/false.

**Fix:** Cache games to `localStorage` on every successful fetch. On fetch failure, restore from cache before falling back to empty. (See §7.8.)

### 8.5 🟡 `Date.now()` used as card and game ID
Not safe for multi-device or offline-create scenarios. Two devices creating a card within the same millisecond produce a collision.

**Fix:** Replace all `Date.now()` ID generation with `crypto.randomUUID()`. (See §2 — ID strategy decision.)

### 8.6 🟡 No `navigator.onLine` awareness anywhere
All network failures are discovered reactively per user action (alert boxes). No proactive offline detection or UI state.

**Fix:** Implement the sync state machine (§5). Surface sync state in a non-blocking UI indicator (e.g., a small dot or badge in the footer or topbar).

---

## 9. localStorage Key Registry

All keys used by the client sync layer. Documented here to prevent naming collisions with existing keys.

| Key | Type | Purpose |
|---|---|---|
| `bingoSession` | JSON object | Active game session — called numbers, active cards, game selection |
| `bingoOutbox` | JSON array | Outbox queue of pending sync operations |
| `bingoCardLibraryCache` | JSON array | Last successful GET /api/cards response |
| `bingoGamesCache` | JSON array | Last successful GET /api/games response |
| `bingoTheme` | string | Active theme name |
| `bingoFlashboardConfig` | JSON object | Flashboard layout configuration |
| `bingoCardSize` | string (number) | Card view size slider value |

---

## 10. PHP Backend Migration Notes

The existing `cards.php` and `games.php` files use flat JSON file storage. They must be replaced with SQL-backed endpoints matching the API contract in §4.

### Migration approach
1. Deploy new SQL tables (§3) alongside existing JSON files
2. Seed built-in games into the `bingo_games` and `bingo_patterns` tables
3. Migrate any existing JSON card/game data into SQL as part of deploy
4. Replace `cards.php` and `games.php` with new router-based handlers (`/api/cards`, `/api/games`, `/api/favorites`, `/api/health`)
5. Update all `fetch()` call URLs in `scan.html`, `tracking.js`, and `game-creator.html` from `./php/cards.php` and `./php/games.php` to `/api/cards` and `/api/games`

### PHP endpoint behavior for upsert
```
PUT /api/cards/{cardId}
→ INSERT INTO bingo_cards (...) VALUES (...)
  ON DUPLICATE KEY UPDATE
    label = VALUES(label),
    serial = VALUES(serial),
    squares = VALUES(squares),
    updated_at = VALUES(updated_at)
```
The `updated_at` value comes from the client payload (client timestamp), not `NOW()`. This preserves last-write-wins semantics based on when the edit actually occurred, not when it reached the server.

---

## 11. UI Affordances Required

These UI elements are needed to support the sync layer. None exist in the current codebase.

| Element | Location | Behavior |
|---|---|---|
| Sync status indicator | Footer or topbar | Dot or icon: green (synced), amber (pending/syncing), red (failed). Tapping shows outbox summary. |
| Offline mode banner | Card library modal header | "Cached — last updated X mins ago" when serving from `bingoCardLibraryCache` |
| Favorite toggle | Card library list item | Star icon. Visible only to authenticated SuiteProfile users. Disabled when offline. |
| Favorites sort | Card library list | Favorited cards float to top of list. Sort: favorites first (by `favorited_at` desc), then all others (by `updated_at` desc). |
| Failed sync warning | Non-blocking toast or footer note | "X card(s) failed to sync. Will retry on reconnect." Links to outbox summary. |
| Claim guest cards prompt | On SuiteProfile login | Optional one-time prompt to claim guest-created cards. |

---

## 12. Version Increments Required

Per `AGENTS.md`, version constants must be incremented on any change. Files affected by this implementation:

| File | Current Version | Increment To |
|---|---|---|
| `tracking.js` | 3.9 | 4.0 |
| `scan.html` (inline) | 1.3 | 1.4 |
| `ocr.js` | 1.3 | 1.4 |
| `game-creator.html` (inline) | 1.1 | 1.2 |
| `style.css` | 3.2 | 3.3 |
| `index.html` (inline) | 3.9 | 4.0 |

---

*End of specification. Version 1.0 — ready for Antigravity implementation.*
