<?php
// ScoreBoard one-time cutover migration.
//
// What it does (see htdocs/ScoreBoard/docs/CUTOVER.md for the full procedure):
//   1. Games: adds the owner's theme to every saved game snapshot that has none, so spectators and the
//      archive show each game in its owner's look. Guest games (24 hour life) are left alone.
//   2. Profiles: reduces each user's `scoreboard` app record, which holds a whole old-format game plus
//      settings, to preferences only.
//   Nothing else in a snapshot is changed. The history rows and fields of older games are still read by the
//   viewer and the games list, so they are not rewritten.
//
// Safe by default:
//   - Dry run unless `apply=1` is given: reports what would change and writes nothing.
//   - Needs a key (16+ characters) that only the site owner has put on the server, in a file named
//     migration_key.php next to this script (not in git): <?php define('SCOREBOARD_MIGRATION_KEY', '...');
//   - Apply refuses to run while any game is live (activity within GAME_TIMEOUT_HOURS).
//   - Every row it changes is first copied to `scoreboard_migration_backup`; `restore=1&apply=1` puts them back.
//   - Idempotent: a second run finds nothing to change.
//
// Usage (browser or curl), after deploying and BEFORE users reopen the app:
//   migrate_scoreboard.php?key=KEY                  dry run
//   migrate_scoreboard.php?key=KEY&apply=1          apply
//   migrate_scoreboard.php?key=KEY&restore=1&apply=1  undo from the backup table
// Delete this file from the server when the cutover is finished.

$MIGRATION_VERSION = '1.0';

// Hours of inactivity after which a live game counts as abandoned (same value as games.php)
define('MIGRATION_LIVE_WINDOW_HOURS', 3);
// Theme given to a signed-in user's old games when their profile record names none
define('MIGRATION_DEFAULT_THEME', 'saber-dark');
// Rows read per batch
define('MIGRATION_BATCH', 200);

require_once __DIR__ . '/config.php';
// Server-only file that defines the key; it is never committed
if (is_file(__DIR__ . '/migration_key.php')) {
    require_once __DIR__ . '/migration_key.php';
}

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

/** Print one report line. */
function say($line = '') {
    echo $line . "\n";
}

/** Stop with an error message and an HTTP status. */
function stopWith($status, $message) {
    http_response_code($status);
    say('ERROR: ' . $message);
    exit;
}

// -----------------------------------------------------------------------------
// Gate: a key that only the site owner has put into config.php
// -----------------------------------------------------------------------------
if (!defined('SCOREBOARD_MIGRATION_KEY') || strlen(SCOREBOARD_MIGRATION_KEY) < 16) {
    stopWith(403, 'Create api/migration_key.php on the server first (see the top of this script).');
}
$givenKey = isset($_GET['key']) ? (string)$_GET['key'] : '';
if (!hash_equals(SCOREBOARD_MIGRATION_KEY, $givenKey)) {
    stopWith(403, 'Wrong key.');
}

$apply = isset($_GET['apply']) && $_GET['apply'] === '1';
$restore = isset($_GET['restore']) && $_GET['restore'] === '1';

$pdo = getDbConnection();
if (!$pdo) {
    stopWith(503, 'Database unavailable.');
}
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

say("ScoreBoard cutover migration v$MIGRATION_VERSION");
say($apply ? 'MODE: APPLY (changes will be written)' : 'MODE: DRY RUN (nothing will be written)');
say('Server time (UTC): ' . gmdate('Y-m-d H:i:s'));
say();

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** True for a theme key the viewer accepts (it ends up in an image URL). */
function validTheme($value) {
    return is_string($value) && preg_match('/^[A-Za-z0-9._-]{1,64}$/', $value) === 1;
}

/**
 * Preferences from a stored record, accepting the current names and those used inside the old whole-game
 * record. Mirrors normalizePrefs in htdocs/ScoreBoard/js/storage.js. Returns null when none are present.
 */
function normalizePrefs($source) {
    if (!is_array($source)) {
        return null;
    }
    $names = ['theme', 'selectedTheme', 'muted', 'pauseOnScore', 'logPauseResume', 'logPeriodStartStop',
        'splashHome', 'splashOnHome', 'splashAway', 'splashOnAway', 'showCards', 'showPenaltyCards'];
    $found = false;
    foreach ($names as $name) {
        if (array_key_exists($name, $source) && $source[$name] !== null) {
            $found = true;
            break;
        }
    }
    if (!$found) {
        return null;
    }
    $flag = function ($current, $old, $fallback) use ($source) {
        if (isset($source[$current])) {
            return (bool)$source[$current];
        }
        if (isset($source[$old])) {
            return (bool)$source[$old];
        }
        return $fallback;
    };
    $theme = !empty($source['theme']) ? $source['theme'] : (!empty($source['selectedTheme']) ? $source['selectedTheme'] : MIGRATION_DEFAULT_THEME);
    $savedAt = !empty($source['savedAt']) ? $source['savedAt'] : (!empty($source['lastSavedAt']) ? $source['lastSavedAt'] : 0);
    return [
        'theme' => validTheme($theme) ? $theme : MIGRATION_DEFAULT_THEME,
        'muted' => !empty($source['muted']),
        'pauseOnScore' => !empty($source['pauseOnScore']),
        'logPauseResume' => !empty($source['logPauseResume']),
        'logPeriodStartStop' => isset($source['logPeriodStartStop']) ? (bool)$source['logPeriodStartStop'] : true,
        'splashHome' => $flag('splashHome', 'splashOnHome', true),
        'splashAway' => $flag('splashAway', 'splashOnAway', true),
        'showCards' => $flag('showCards', 'showPenaltyCards', false),
        'savedAt' => is_numeric($savedAt) ? (int)$savedAt : 0
    ];
}

/** True when a profile record still holds a whole game saved by an earlier version. */
function holdsOldGame($record) {
    return is_array($record) && (array_key_exists('activeGameId', $record) || array_key_exists('scoreHistory', $record)
        || array_key_exists('gameLifecycle', $record) || array_key_exists('redTeamName', $record)
        || array_key_exists('homeTeamName', $record));
}

// -----------------------------------------------------------------------------
// Restore mode
// -----------------------------------------------------------------------------
if ($restore) {
    if (!$apply) {
        stopWith(400, 'Restore needs apply=1 as well.');
    }
    $exists = $pdo->query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scoreboard_migration_backup'")->fetchColumn();
    if (!$exists) {
        stopWith(404, 'No backup table: nothing to restore.');
    }
    $restoredGames = 0;
    $restoredProfiles = 0;
    $pdo->beginTransaction();
    try {
        $rows = $pdo->query('SELECT kind, row_key, original FROM scoreboard_migration_backup')->fetchAll(PDO::FETCH_ASSOC);
        $putGame = $pdo->prepare('UPDATE scoreboard_games SET state_json = ? WHERE game_id = ?');
        $putProfile = $pdo->prepare('UPDATE suite_user_data SET data_json = ?, version = version + 1 WHERE user_id = ? AND app_id = \'scoreboard\'');
        foreach ($rows as $row) {
            if ($row['kind'] === 'game') {
                $putGame->execute([$row['original'], $row['row_key']]);
                $restoredGames += $putGame->rowCount();
            } else {
                $putProfile->execute([$row['original'], (int)$row['row_key']]);
                $restoredProfiles += $putProfile->rowCount();
            }
        }
        $pdo->commit();
    } catch (Exception $e) {
        $pdo->rollBack();
        stopWith(500, 'Restore failed and was rolled back: ' . $e->getMessage());
    }
    say("Restored $restoredGames games and $restoredProfiles profile records from the backup table.");
    say('The backup table is kept. Drop it by hand when it is no longer needed.');
    exit;
}

// -----------------------------------------------------------------------------
// Safety: no live games
// -----------------------------------------------------------------------------
$liveStmt = $pdo->prepare('SELECT game_id, home_name, away_name, last_activity_at FROM scoreboard_games
                           WHERE status = \'live\' AND last_activity_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ' . (int)MIGRATION_LIVE_WINDOW_HOURS . ' HOUR)
                           ORDER BY last_activity_at DESC LIMIT 20');
$liveStmt->execute();
$live = $liveStmt->fetchAll(PDO::FETCH_ASSOC);
if ($live) {
    say('LIVE GAMES (activity within ' . MIGRATION_LIVE_WINDOW_HOURS . ' hours): ' . count($live));
    foreach ($live as $row) {
        say('  ' . $row['game_id'] . '  ' . $row['home_name'] . ' vs ' . $row['away_name'] . '  last activity ' . $row['last_activity_at']);
    }
    if ($apply) {
        stopWith(409, 'Refusing to apply while games are live. Wait until they finish or are older than the window, then run again.');
    }
    say('  (a dry run continues; apply would refuse)');
    say();
}

// -----------------------------------------------------------------------------
// Load every user's scoreboard profile record (themes are needed for the games)
// -----------------------------------------------------------------------------
$profiles = [];            // user_id => ['raw' => string, 'record' => array|null]
$ownerThemes = [];         // user_id => theme key found in the record
$profileStmt = $pdo->query('SELECT user_id, data_json FROM suite_user_data WHERE app_id = \'scoreboard\'');
foreach ($profileStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
    $record = json_decode($row['data_json'], true);
    $profiles[(int)$row['user_id']] = ['raw' => $row['data_json'], 'record' => is_array($record) ? $record : null];
    $prefs = normalizePrefs($record);
    if ($prefs !== null) {
        $ownerThemes[(int)$row['user_id']] = $prefs['theme'];
    }
}

// -----------------------------------------------------------------------------
// Backup table (created only when applying)
// -----------------------------------------------------------------------------
if ($apply) {
    $pdo->exec('CREATE TABLE IF NOT EXISTS `scoreboard_migration_backup` (
        `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `kind` ENUM(\'game\',\'profile\') NOT NULL,
        `row_key` VARCHAR(64) NOT NULL,
        `original` LONGTEXT NOT NULL,
        `migrated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY `uq_scoreboard_migration_backup` (`kind`, `row_key`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
}

/** Copy an original value into the backup table; an earlier copy of the same row is kept. */
function backupRow($pdo, $kind, $key, $original) {
    $stmt = $pdo->prepare('INSERT IGNORE INTO scoreboard_migration_backup (kind, row_key, original) VALUES (?, ?, ?)');
    $stmt->execute([$kind, (string)$key, $original]);
}

// -----------------------------------------------------------------------------
// Part 1: games
// -----------------------------------------------------------------------------
say('PART 1: saved games');
$counts = ['seen' => 0, 'themed' => 0, 'already' => 0, 'guest' => 0, 'unreadable' => 0, 'no_history' => 0];
$themeSource = ['profile' => 0, 'default' => 0];
$lastId = 0;
$pdo->beginTransaction();
try {
    $select = $pdo->prepare('SELECT id, game_id, owner_id, state_json FROM scoreboard_games WHERE id > ? ORDER BY id LIMIT ' . (int)MIGRATION_BATCH);
    $update = $pdo->prepare('UPDATE scoreboard_games SET state_json = ? WHERE id = ?');
    do {
        $select->execute([$lastId]);
        $rows = $select->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            $lastId = (int)$row['id'];
            $counts['seen']++;
            $snapshot = json_decode($row['state_json'], true);
            if (!is_array($snapshot)) {
                $counts['unreadable']++;
                say('  unreadable snapshot, left alone: ' . $row['game_id']);
                continue;
            }
            if (!isset($snapshot['scoreHistory']) || !is_array($snapshot['scoreHistory'])) {
                $counts['no_history']++;
            }
            if (isset($snapshot['theme']) && validTheme($snapshot['theme'])) {
                $counts['already']++;
                continue;
            }
            if ($row['owner_id'] === null) {
                $counts['guest']++;
                continue;
            }
            $ownerId = (int)$row['owner_id'];
            if (isset($ownerThemes[$ownerId])) {
                $snapshot['theme'] = $ownerThemes[$ownerId];
                $themeSource['profile']++;
            } else {
                $snapshot['theme'] = MIGRATION_DEFAULT_THEME;
                $themeSource['default']++;
            }
            $counts['themed']++;
            if ($apply) {
                backupRow($pdo, 'game', $row['game_id'], $row['state_json']);
                $update->execute([json_encode($snapshot, JSON_UNESCAPED_UNICODE), $row['id']]);
            }
        }
    } while (count($rows) === MIGRATION_BATCH);
    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    stopWith(500, 'Games step failed and was rolled back: ' . $e->getMessage());
}
say('  games seen:                      ' . $counts['seen']);
say('  ' . ($apply ? 'theme added:' : 'theme would be added:') . '             ' . $counts['themed']
    . ' (from the owner\'s profile: ' . $themeSource['profile'] . ', default ' . MIGRATION_DEFAULT_THEME . ': ' . $themeSource['default'] . ')');
say('  already have a theme:            ' . $counts['already']);
say('  guest games left alone:          ' . $counts['guest']);
say('  unreadable snapshots (skipped):  ' . $counts['unreadable']);
say('  snapshots without a history list: ' . $counts['no_history'] . ' (shown without a history table; not changed)');
say();

// -----------------------------------------------------------------------------
// Part 2: profile records
// -----------------------------------------------------------------------------
say('PART 2: scoreboard profile records');
$profileCounts = ['seen' => count($profiles), 'converted' => 0, 'already' => 0, 'unreadable' => 0];
$pdo->beginTransaction();
try {
    $updateProfile = $pdo->prepare('UPDATE suite_user_data SET data_json = ?, version = version + 1 WHERE user_id = ? AND app_id = \'scoreboard\'');
    foreach ($profiles as $userId => $profile) {
        if ($profile['record'] === null) {
            $profileCounts['unreadable']++;
            say('  unreadable record, left alone: user ' . $userId);
            continue;
        }
        if (!holdsOldGame($profile['record'])) {
            $profileCounts['already']++;
            continue;
        }
        // A record with no preferences at all becomes the defaults
        $prefs = normalizePrefs($profile['record']) ?? [
            'theme' => MIGRATION_DEFAULT_THEME, 'muted' => false, 'pauseOnScore' => false, 'logPauseResume' => false,
            'logPeriodStartStop' => true, 'splashHome' => true, 'splashAway' => true, 'showCards' => false, 'savedAt' => 0
        ];
        $profileCounts['converted']++;
        if ($apply) {
            backupRow($pdo, 'profile', $userId, $profile['raw']);
            $updateProfile->execute([json_encode($prefs, JSON_UNESCAPED_UNICODE), $userId]);
        }
    }
    $pdo->commit();
} catch (Exception $e) {
    $pdo->rollBack();
    stopWith(500, 'Profile step failed and was rolled back: ' . $e->getMessage());
}
say('  records seen:                  ' . $profileCounts['seen']);
say('  ' . ($apply ? 'reduced to preferences:' : 'would be reduced to preferences:') . ' ' . $profileCounts['converted']);
say('  already preferences only:      ' . $profileCounts['already']);
say('  unreadable (skipped):          ' . $profileCounts['unreadable']);
say();

say($apply ? 'DONE. Run the same URL again: every count under "added"/"reduced" should now be 0.'
           : 'Dry run finished. Nothing was written. Add &apply=1 to apply.');
