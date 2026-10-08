# User Groups & App Access — Build Spec

Adds user groups (General, Special, Admin) to the suite so the launcher can show certain apps only to certain users, and adds an Admin-only page for managing who is in Special.

---

## 1. Decisions (locked)

| Topic | Decision |
| :--- | :--- |
| Groups | `general`, `special`, `admin`, ranked so a higher group inherits lower access (Admin sees Special apps). |
| General membership | Implicit. Every signed-in user is General; no rows stored. Guests keep today's access to existing apps. |
| Special-app protection | **Cosmetic only.** The launcher hides the card; the app itself is not blocked if someone has the URL. |
| Passwords for Special | Not required. |
| Passwords for Admin | **Required.** Admin membership is ignored (treated as not admin) unless the profile has a password. `admin.php` refuses every call otherwise. |
| Membership management | Admin page in the suite (`htdocs/admin.html`). The page manages **Special only**. Admin membership is set only by the seed in `setup.php` or by hand in phpMyAdmin. |
| Access rules | Data-driven via `suite_app_access`. An app with no row is open to everyone. |

---

## 2. Database (`htdocs/api/schema.sql`)

Add after table 3 (`suite_sessions`) as tables 3b–3d, keeping the existing numbering style.

### 3b. `suite_groups`
| Column | Type | Notes |
| :--- | :--- | :--- |
| `id` | INT UNSIGNED AUTO_INCREMENT PK | |
| `slug` | VARCHAR(32) NOT NULL UNIQUE | `general`, `special`, `admin` — what code checks |
| `name` | VARCHAR(64) NOT NULL | Display name |
| `rank` | TINYINT UNSIGNED NOT NULL | 0 / 10 / 100. Access check is `user_max_rank >= required_rank` |
| `created_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

Seed with `INSERT IGNORE` using fixed ids so the FKs and seeds are stable:
`(1,'general','General',0)`, `(2,'special','Special',10)`, `(3,'admin','Admin',100)`.

### 3c. `suite_user_groups`
| Column | Type | Notes |
| :--- | :--- | :--- |
| `user_id` | INT UNSIGNED NOT NULL | FK → `suite_users.id` ON DELETE CASCADE ON UPDATE CASCADE |
| `group_id` | INT UNSIGNED NOT NULL | FK → `suite_groups.id` ON DELETE CASCADE ON UPDATE CASCADE |
| `granted_by` | INT UNSIGNED NULL | FK → `suite_users.id` ON DELETE SET NULL. NULL = seeded / set by hand |
| `granted_at` | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |

- PRIMARY KEY (`user_id`, `group_id`)
- INDEX `idx_user_groups_group` (`group_id`)
- No `general` rows are ever written (General is implicit).

### 3d. `suite_app_access`
| Column | Type | Notes |
| :--- | :--- | :--- |
| `app_id` | VARCHAR(32) NOT NULL PK | Same ids used by `suite_user_data.app_id` (e.g. `scoreboard`, `toys`) |
| `min_group_id` | INT UNSIGNED NOT NULL | FK → `suite_groups.id` ON DELETE CASCADE ON UPDATE CASCADE |

- No seed rows today (all current apps stay open). The future Special app adds one row, e.g. `('toys', 2)`.

All tables: `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, `CREATE TABLE IF NOT EXISTS`.

---

## 3. Admin Seed (`htdocs/api/config.php` + `htdocs/api/setup.php`)

- `config.php`: add `define('SUITE_ADMIN_USERNAME', 'your_username_here');` next to the DB settings, with a comment explaining it names the one profile that gets Admin on setup. Bump `$API_CONFIG_VERSION`.
- `setup.php`, after `schema.sql` runs:
  1. Look up `SUITE_ADMIN_USERNAME` in `suite_users`.
  2. Profile missing → show a warning: "Sign in once as <name> and set a password, then re-run setup."
  3. Profile exists but `password_hash` is NULL → show a warning that Admin needs a password; still insert the row (it stays inactive until a password exists).
  4. Otherwise `INSERT IGNORE INTO suite_user_groups (user_id, group_id) VALUES (?, 3)` and show success.
  5. Add the three new tables to the success message list.
- Bump the setup page's version.

---

## 4. Shared Auth Helpers (`htdocs/api/auth.php`, v1.0 → v1.1)

Add three functions. All other endpoints use these; no endpoint writes its own group SQL.

| Function | Returns | Behavior |
| :--- | :--- | :--- |
| `getUserGroups($pdo, $user)` | `string[]` of slugs | Always includes `general`. Adds stored groups. **Drops `admin` if `$user['password_hash']` is empty.** Since `authenticateUser()` already selects `password_hash`, no extra query is needed for that. |
| `getUserRank($pdo, $user)` | int | Highest rank among the effective groups from `getUserGroups()` (0 if only General). |
| `getAllowedRestrictedApps($pdo, $user)` | `string[]` of app ids | `SELECT a.app_id FROM suite_app_access a JOIN suite_groups g ON g.id = a.min_group_id WHERE g.rank <= ?` with the user's rank. Only restricted apps are listed; open apps are implied. |

---

## 5. Profile API (`htdocs/api/profile.php`, v1.2 → v1.3)

- `action=status` (signed in): add to the response
  - `groups`: e.g. `["general","special"]`
  - `isAdmin`: bool (already accounts for the password rule)
  - `allowedApps`: e.g. `["toys"]`
- `action=auth` (both the existing-user and new-user branches): include the same three fields so the launcher doesn't need a second call after sign-in. New users always get `["general"]`, `false`, and whatever is open at rank 0.
- `action=set_password`: also return the recomputed `groups` / `isAdmin` / `allowedApps`, since setting a password can activate Admin.

---

## 6. Admin API (`htdocs/api/admin.php`, new, v1.0)

Same header/CORS/OPTIONS/DB-unavailable boilerplate as `profile.php`.

**Gate (runs before every action):**
1. No valid session → 401 `{ success:false, error:'Authentication required.' }`
2. Stored `admin` row but no password → 403 `{ success:false, code:'admin_password_required', error:'Set a password on this profile to use admin tools.' }`
3. Not admin → 403 `{ success:false, code:'forbidden', error:'Admin access required.' }`

**Actions:**

| Action | Method | Input | Output |
| :--- | :--- | :--- | :--- |
| `list_users` | GET | — | `{ success, users:[{ id, username, hasPassword, createdAt, lastLogin, groups:[slugs] }] }`, sorted by username. `groups` are the **stored** rows (plus `general`), so the admin sees raw membership. |
| `grant` | POST JSON | `{ userId, group }` | `INSERT IGNORE` with `granted_by` = admin's id. Returns `{ success, user }` (the updated user record). |
| `revoke` | POST JSON | `{ userId, group }` | `DELETE` the row. Returns `{ success, user }`. |
| `reset_password` | POST JSON | `{ userId, newPassword }` | Updates user's `password_hash` with bcrypt/default hash, purges old sessions for target user. Returns `{ success, user }`. |
| `remove_password` | POST JSON | `{ userId }` | Sets `password_hash = NULL`, purges active sessions. Refuses if admin is targeting their own id. Returns `{ success, user }`. |

**Validation:**
- `group` must be exactly `special`. Anything else → 400 `'Only the Special group can be managed here.'` (prevents granting or revoking Admin, including revoking your own).
- `userId` must be a positive int that exists → else 404.
- `newPassword` on `reset_password` must be >= 3 characters.
- `remove_password` on own admin account is forbidden → 400.
- Body limit 256 KB, matching `profile.php`.

---

## 7. Client Library (`htdocs/media/suite-profile.js`, v1.7 → v1.8)

- **Session shape** stored under `webappsuite_profile_session` gains `groups`, `isAdmin`, `allowedApps`. `login()` and `setPassword()` copy them from the response.
- **New `refreshAccess()`**: if signed in, calls `profile.php?action=status`, updates those three fields in the stored session, and dispatches a `suite-access-changed` event. On network failure it keeps the cached values (offline still shows what the user last had). On 401 it follows the existing expired-session handling.
- **New `canSeeApp(appId)`**: true if `allowedApps` in the session includes `appId`. Guests → false.
- **New `isAdmin()`**: reads the session flag.
- `logout()` already clears the session, which removes these fields; dispatch `suite-access-changed` as well.
- Export the new functions on `SuiteProfile`.

---

## 8. Launcher (`htdocs/index.html`, v2.1 → v2.2)

- **Restricted cards:** a restricted app's card carries `data-app-id="<id>"` and the `hidden` attribute in markup, so guests and offline-first paint never see it.
- **`applyAccess()`:** for every `.app-card[data-app-id]`, sets `hidden = !SuiteProfile.canSeeApp(id)`, and shows or hides the Admin link based on `SuiteProfile.isAdmin()`.
- **When it runs:** call `applyAccess()` on load (using cached session data), then call `refreshAccess()`. Re-run `applyAccess()` on `suite-access-changed` and `suite-profile-changed`.
- **Admin link:** a header icon button (`./admin.html`, `aria-label="Admin"`), `hidden` by default, styled like the existing `.icon-btn` and at least 44×44 px.
- **Card markup:** a restricted card's markup must match its row in `suite_app_access`. Section 11 lists the steps for adding one.

---

## 9. Admin Page (`htdocs/admin.html` + `htdocs/admin.css` + `htdocs/admin.js`, new, v1.0)

A root-level page like `about.html`. It's not a sub-app, so it follows `about.html`'s navigation pattern for returning to the launcher.

- **Not signed in, not admin, or admin without a password:** show a clear message card ("Admin access required" / "Set a password on your profile to use admin tools") and no user list. Map these from the API error `code`.
- **User list:** one card/row per user showing the username, a 🔒 badge if they have a password, last login, and a **Special** toggle switch (≥44 px touch target).
  - Toggling calls `grant` or `revoke` and disables the switch while the request runs.
  - On failure, revert the switch and show a toast.
  - Admin users show an "Admin" chip instead of a toggle (Special is already implied).
- **Search box:** filters the list client-side by username.
- **Styling:** dark theme using CSS custom properties in `admin.css`, with no inline styles.
- **Footer:** `<footer class="app-footer"><small>v1.0</small></footer>`, with `APP_VERSION` set in `admin.js`.
- **Data:** always fetched from the network. No offline data. If offline, show "Admin tools need a connection."

---

## 10. Service Worker (`htdocs/sw.js`, v3.6 → v3.7)

- Add `./admin.html`, `./admin.css`, `./admin.js` to the precache list (the shell only; the API is not cached).
- The network-first strategy is unchanged.

---

## 11. Adding a Special-Only App Later (checklist)

1. Create `htdocs/<App>/` like the other sub-apps (own `AGENTS.md`, back link, footer version).
2. Insert the access row: `INSERT INTO suite_app_access (app_id, min_group_id) VALUES ('<app_id>', 2);`
3. Add its launcher card with `data-app-id="<app_id>"` and `hidden`.
4. Add its files to `sw.js` and bump `SW_VERSION`.
5. Add a row to the sub-app table in the root `AGENTS.md`.
6. Reminder: protection is cosmetic. Anyone with the URL can open the app. Don't put anything sensitive in it without revisiting this spec.

---

## 12. Out of Scope

- Server-side blocking of restricted app pages or their data.
- Managing Admin membership from the UI.
- Requiring passwords for Special users.
- Requiring the old password when changing a password (existing `set_password` behavior is unchanged).

---

## 13. Test Plan (manual)

| # | Scenario | Expected |
| :--- | :--- | :--- |
| 1 | Run `setup.php` on an existing DB | New tables created, seeds present, existing data untouched, admin row inserted |
| 2 | Re-run `setup.php` | No errors, no duplicate rows |
| 3 | Admin profile has no password → `status` | `isAdmin:false`, no Admin link; `admin.php` returns `admin_password_required` |
| 4 | Set a password on the Admin profile | `isAdmin:true` right away, Admin link appears |
| 5 | Admin grants Special to user B | B's `status` shows `special`; after B refreshes the launcher, B sees the restricted card |
| 6 | Admin revokes Special from B | B's card disappears on the next launcher load |
| 7 | Send `grant` with `group:'admin'` by hand | 400; no row written |
| 8 | Non-admin calls `admin.php?action=list_users` | 403 `forbidden` |
| 9 | Guest opens the launcher | Restricted cards and Admin link never visible, not even briefly |
| 10 | Signed-in Special user goes offline and reloads | Card still visible from cached session |
| 11 | Delete a user in phpMyAdmin | Their `suite_user_groups` rows cascade away; their `granted_by` references become NULL |
| 12 | Phone width | Admin list and toggles are usable, no horizontal scroll, touch targets ≥44 px |

---

## 14. Version Bumps Summary

| File | From → To |
| :--- | :--- |
| `api/auth.php` | 1.0 → 1.1 |
| `api/profile.php` | 1.2 → 1.3 |
| `api/config.php` | 1.0 → 1.1 |
| `api/setup.php` | +0.1 |
| `api/admin.php` | new 1.0 |
| `media/suite-profile.js` | 1.7 → 1.8 |
| `index.html` | 2.1 → 2.2 |
| `admin.html` / `admin.js` | new 1.0 |
| `sw.js` | 3.6 → 3.7 |
