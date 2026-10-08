<?php
// WebAppSuite Database Schema Setup Script
// Executes schema.sql and migrations to create or rename needed tables in the configured MySQL database.

// Setup utility version identifier
$SETUP_VERSION = '1.7';

require_once __DIR__ . '/config.php';

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebAppSuite - Database Setup</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #121214; color: #e4e4e7; padding: 32px; max-width: 640px; margin: 0 auto; line-height: 1.5; }
        .card { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        h1 { font-size: 20px; margin-top: 0; color: #60a5fa; }
        .success { background: #064e3b; color: #a7f3d0; padding: 12px 16px; border-radius: 6px; margin: 16px 0; border: 1px solid #059669; }
        .error { background: #7f1d1d; color: #fecaca; padding: 12px 16px; border-radius: 6px; margin: 16px 0; border: 1px solid #dc2626; }
        pre { background: #09090b; padding: 12px; border-radius: 6px; font-size: 13px; overflow-x: auto; color: #d4d4d8; }
        .footer { font-size: 11px; color: #71717a; margin-top: 24px; text-align: center; }
        a { color: #38bdf8; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
<div class="card">
    <h1>WebAppSuite Database Setup</h1>
    <p>Running schema initialization against configured MySQL database...</p>

    <?php
    $pdo = getDbConnection();

    if (!$pdo) {
        echo '<div class="error">';
        echo '<strong>Connection Failed!</strong><br>';
        echo 'Unable to connect to MySQL database. Please verify your credentials in <code>htdocs/api/config.php</code>.';
        echo '</div>';
    } else {
        // Table migrations: rename legacy non-prefixed tables to app-prefixed standard
        $tableRenames = [
            'cards'                  => 'bingo_cards',
            'card_favorites'         => 'bingo_card_favorites',
            'games'                  => 'bingo_games',
            'game_patterns'          => 'bingo_patterns',
            'suite_games'            => 'scoreboard_games',
            'suite_game_tombstones'  => 'scoreboard_game_tombstones'
        ];

        foreach ($tableRenames as $oldTable => $newTable) {
            try {
                $oldExists = $pdo->query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$oldTable'")->fetchColumn();
                $newExists = $pdo->query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$newTable'")->fetchColumn();

                if ($oldExists && !$newExists) {
                    $pdo->exec("RENAME TABLE `$oldTable` TO `$newTable`");
                    echo '<div class="success"><strong>Table Renamed:</strong> <code>' . htmlspecialchars($oldTable) . '</code> &rarr; <code>' . htmlspecialchars($newTable) . '</code>.</div>';
                }
            } catch (PDOException $renameEx) {
                echo '<div class="error"><strong>Rename Warning (' . htmlspecialchars($oldTable) . '):</strong> ' . htmlspecialchars($renameEx->getMessage()) . '</div>';
            }
        }

        $sqlFile = __DIR__ . '/schema.sql';
        if (!file_exists($sqlFile)) {
            echo '<div class="error">schema.sql file not found in /api/ directory.</div>';
        } else {
            $sql = file_get_contents($sqlFile);
            try {
                // Execute multi-query schema script
                $pdo->exec($sql);
                echo '<div class="success">';
                echo '<strong>Success!</strong> Tables <code>suite_users</code>, <code>suite_user_data</code>, <code>suite_sessions</code>, <code>suite_groups</code>, <code>suite_user_groups</code>, <code>suite_app_access</code>, <code>scoreboard_games</code>, <code>scoreboard_game_tombstones</code>, <code>bingo_cards</code>, <code>bingo_card_favorites</code>, <code>bingo_games</code>, and <code>bingo_patterns</code> have been successfully initialized or verified.';
                echo '</div>';

                // Idempotent migration: Ensure scoreboard_games.ended_by includes 'abandoned'
                try {
                    $colStmt = $pdo->query("SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scoreboard_games' AND COLUMN_NAME = 'ended_by'");
                    $colType = $colStmt ? $colStmt->fetchColumn() : '';
                    if ($colType && strpos($colType, "'abandoned'") === false) {
                        $pdo->exec("ALTER TABLE `scoreboard_games` MODIFY COLUMN `ended_by` ENUM('user','new_game','timeout','abandoned') NULL");
                        echo '<div class="success"><strong>Migration Applied:</strong> Column <code>scoreboard_games.ended_by</code> updated to include <code>abandoned</code>.</div>';
                    } else {
                        echo '<div class="success"><strong>Schema Verified:</strong> Column <code>scoreboard_games.ended_by</code> includes <code>abandoned</code>.</div>';
                    }
                } catch (PDOException $migrationEx) {
                    echo '<div class="error"><strong>Migration Warning:</strong> Unable to verify <code>ended_by</code> ENUM: ' . htmlspecialchars($migrationEx->getMessage()) . '</div>';
                }

                // Idempotent migration: Ensure scoreboard_game_tombstones table exists
                try {
                    $tableCheck = $pdo->query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scoreboard_game_tombstones'");
                    $tableExists = $tableCheck && $tableCheck->fetchColumn();
                    if (!$tableExists) {
                        $pdo->exec("CREATE TABLE IF NOT EXISTS `scoreboard_game_tombstones` (
                            `game_id` VARCHAR(36) NOT NULL PRIMARY KEY,
                            `deleted_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
                        echo '<div class="success"><strong>Migration Applied:</strong> Table <code>scoreboard_game_tombstones</code> created.</div>';
                    } else {
                        echo '<div class="success"><strong>Schema Verified:</strong> Table <code>scoreboard_game_tombstones</code> verified.</div>';
                    }
                } catch (PDOException $tombEx) {
                    echo '<div class="error"><strong>Migration Warning:</strong> Unable to verify <code>scoreboard_game_tombstones</code> table: ' . htmlspecialchars($tombEx->getMessage()) . '</div>';
                }

                // Idempotent seed: Ensure suite_app_access records access rules for toys
                try {
                    $appAccessStmt = $pdo->prepare("INSERT IGNORE INTO suite_app_access (app_id, min_group_id) SELECT 'toys', id FROM suite_groups WHERE slug = 'special'");
                    $appAccessStmt->execute();
                    echo '<div class="success"><strong>App Access Seeded:</strong> <code>toys</code> access rule verified (Special group and above).</div>';
                } catch (PDOException $accessEx) {
                    echo '<div class="error"><strong>App Access Warning:</strong> ' . htmlspecialchars($accessEx->getMessage()) . '</div>';
                }

                // Seed the Admin group membership for the profile named in SUITE_ADMIN_USERNAME
                try {
                    $adminName = defined('SUITE_ADMIN_USERNAME') ? SUITE_ADMIN_USERNAME : '';
                    $adminStmt = $pdo->prepare('SELECT id, password_hash FROM suite_users WHERE username = ? LIMIT 1');
                    $adminStmt->execute([$adminName]);
                    $adminUser = $adminStmt->fetch();

                    if ($adminName === '' || $adminName === 'your_username_here') {
                        echo '<div class="error"><strong>Admin Not Seeded:</strong> Set <code>SUITE_ADMIN_USERNAME</code> in <code>config.php</code>, then re-run setup.</div>';
                    } elseif (!$adminUser) {
                        echo '<div class="error"><strong>Admin Not Seeded:</strong> No profile named <code>' . htmlspecialchars($adminName) . '</code> exists. Sign in once as that user and set a password, then re-run setup.</div>';
                    } else {
                        // INSERT IGNORE keeps repeated setup runs from creating duplicate rows
                        $seedStmt = $pdo->prepare('INSERT IGNORE INTO suite_user_groups (user_id, group_id) SELECT ?, id FROM suite_groups WHERE slug = \'admin\'');
                        $seedStmt->execute([$adminUser['id']]);
                        echo '<div class="success"><strong>Admin Seeded:</strong> <code>' . htmlspecialchars($adminName) . '</code> is in the Admin group.</div>';
                        if (empty($adminUser['password_hash'])) {
                            echo '<div class="error"><strong>Password Required:</strong> <code>' . htmlspecialchars($adminName) . '</code> has no password, so Admin access stays inactive until one is set on the profile.</div>';
                        }
                    }
                } catch (PDOException $adminEx) {
                    echo '<div class="error"><strong>Admin Seed Warning:</strong> ' . htmlspecialchars($adminEx->getMessage()) . '</div>';
                }

                echo '<p><a href="../index.html">&larr; Return to App Suite Launcher</a></p>';
            } catch (PDOException $e) {
                echo '<div class="error">';
                echo '<strong>Query Execution Error:</strong><br>' . htmlspecialchars($e->getMessage());
                echo '</div>';
            }
        }
    }
    ?>
</div>
<div class="footer">WebAppSuite Schema Setup v<?= htmlspecialchars($SETUP_VERSION) ?></div>
</body>
</html>
