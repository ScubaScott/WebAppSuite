<?php
// WebAppSuite Admin API
// Lets Admin-group users list profiles, manage Special group membership, and reset or remove user passwords.

// API endpoint version identifier
$ADMIN_API_VERSION = '1.3';

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth.php';

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

$pdo = getDbConnection();
if (!$pdo) {
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error' => 'Database service unavailable.',
        'dbAvailable' => false
    ]);
    exit;
}

/**
 * Sends a JSON error response and stops the request.
 *
 * @param int $status HTTP status code
 * @param string $error Message shown to the admin user
 * @param string|null $code Optional machine-readable code the admin page maps to a message
 */
function adminFail($status, $error, $code = null) {
    http_response_code($status);
    $body = ['success' => false, 'error' => $error];
    if ($code !== null) {
        $body['code'] = $code;
    }
    echo json_encode($body);
    exit;
}

/**
 * Reads the JSON request body (256 KB limit) as an associative array.
 *
 * @return array Decoded payload, empty when the body is missing or invalid
 */
function adminReadPayload() {
    $rawInput = file_get_contents('php://input');
    if (strlen($rawInput) > 262144) {
        adminFail(413, 'Request body exceeds 256 KB limit.');
    }
    return json_decode($rawInput, true) ?: [];
}

/**
 * Formats a raw byte count into human-readable string (KB, MB, GB).
 *
 * @param float|int $bytes Raw bytes to convert
 * @param int $precision Decimal precision for output
 * @return string Formatted byte measurement
 */
function adminFormatBytes($bytes, $precision = 2) {
    if ($bytes <= 0) {
        return '0 B';
    }
    $units = ['B', 'KB', 'MB', 'GB', 'TB'];
    $pow = (int)floor(log($bytes, 1024));
    $pow = max(0, min($pow, count($units) - 1));
    $val = $bytes / pow(1024, $pow);
    return round($val, $precision) . ' ' . $units[$pow];
}

/**
 * Builds the admin-facing record for one user: stored group slugs plus implicit 'general'.
 *
 * @param PDO $pdo Active database connection
 * @param int $userId Profile id
 * @return array|null Record, or null when the user does not exist
 */
function adminLoadUser($pdo, $userId) {
    $stmt = $pdo->prepare('SELECT u.id, u.username, u.password_hash, u.created_at, u.last_login,
                                  GROUP_CONCAT(g.slug) AS stored_groups
                           FROM suite_users u
                           LEFT JOIN suite_user_groups ug ON ug.user_id = u.id
                           LEFT JOIN suite_groups g ON g.id = ug.group_id
                           WHERE u.id = ?
                           GROUP BY u.id');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    return $row ? adminFormatUser($row) : null;
}

/**
 * Converts a joined user row into the JSON shape sent to the admin page.
 *
 * @param array $row Row with stored_groups as a comma-separated slug list (or null)
 * @return array
 */
function adminFormatUser($row) {
    $groups = ['general'];
    if (!empty($row['stored_groups'])) {
        foreach (explode(',', $row['stored_groups']) as $slug) {
            if ($slug !== 'general') {
                $groups[] = $slug;
            }
        }
    }
    return [
        'id' => (int)$row['id'],
        'username' => $row['username'],
        'hasPassword' => !empty($row['password_hash']),
        'createdAt' => $row['created_at'],
        'lastLogin' => $row['last_login'],
        'lastActive' => $row['last_login'],
        'groups' => array_values(array_unique($groups))
    ];
}

// Gate: every action requires a signed-in Admin whose profile has a password
$rawToken = getAuthToken();
$payload = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $payload = adminReadPayload();
    $rawToken = getAuthToken($payload);
}

$admin = authenticateUser($pdo, $rawToken);
if (!$admin) {
    adminFail(401, 'Authentication required.');
}

$adminCheck = $pdo->prepare('SELECT 1 FROM suite_user_groups ug
                             JOIN suite_groups g ON g.id = ug.group_id
                             WHERE ug.user_id = ? AND g.slug = \'admin\' LIMIT 1');
$adminCheck->execute([$admin['id']]);
if (!$adminCheck->fetchColumn()) {
    adminFail(403, 'Admin access required.', 'forbidden');
}
if (empty($admin['password_hash'])) {
    adminFail(403, 'Set a password on this profile to use admin tools.', 'admin_password_required');
}

$action = isset($_GET['action']) ? trim($_GET['action']) : '';

// 1. List all profiles with their stored group membership
if ($action === 'list_users') {
    $stmt = $pdo->query('SELECT u.id, u.username, u.password_hash, u.created_at, u.last_login,
                                GROUP_CONCAT(g.slug) AS stored_groups
                         FROM suite_users u
                         LEFT JOIN suite_user_groups ug ON ug.user_id = u.id
                         LEFT JOIN suite_groups g ON g.id = ug.group_id
                         GROUP BY u.id
                         ORDER BY u.username');
    $users = array_map('adminFormatUser', $stmt->fetchAll());
    echo json_encode(['success' => true, 'users' => $users]);
    exit;
}

// 2. Grant or revoke Special membership (the only group managed from this API)
if ($action === 'grant' || $action === 'revoke') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        adminFail(405, 'POST required.');
    }

    $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
    $group = isset($payload['group']) ? trim($payload['group']) : '';

    if ($group !== 'special') {
        adminFail(400, 'Only the Special group can be managed here.');
    }
    if ($userId <= 0 || !adminLoadUser($pdo, $userId)) {
        adminFail(404, 'User not found.');
    }

    if ($action === 'grant') {
        // INSERT IGNORE keeps repeated grants from failing on the composite primary key
        $stmt = $pdo->prepare('INSERT IGNORE INTO suite_user_groups (user_id, group_id, granted_by)
                               SELECT ?, id, ? FROM suite_groups WHERE slug = ?');
        $stmt->execute([$userId, $admin['id'], $group]);
    } else {
        $stmt = $pdo->prepare('DELETE ug FROM suite_user_groups ug
                               JOIN suite_groups g ON g.id = ug.group_id
                               WHERE ug.user_id = ? AND g.slug = ?');
        $stmt->execute([$userId, $group]);
    }

    echo json_encode(['success' => true, 'user' => adminLoadUser($pdo, $userId)]);
    exit;
}

// 3. Reset a user's password
if ($action === 'reset_password') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        adminFail(405, 'POST required.');
    }

    $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;
    $newPassword = isset($payload['newPassword']) ? trim((string)$payload['newPassword']) : '';

    if ($userId <= 0 || !adminLoadUser($pdo, $userId)) {
        adminFail(404, 'User not found.');
    }
    if (empty($newPassword) || strlen($newPassword) < 3) {
        adminFail(400, 'Password must be at least 3 characters.');
    }

    $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
    $stmt = $pdo->prepare('UPDATE suite_users SET password_hash = ? WHERE id = ?');
    $stmt->execute([$newHash, $userId]);

    // Invalidate active sessions so the user must sign in using the new password
    if ($userId !== (int)$admin['id']) {
        $stmtSessions = $pdo->prepare('DELETE FROM suite_sessions WHERE user_id = ?');
        $stmtSessions->execute([$userId]);
    }

    echo json_encode(['success' => true, 'user' => adminLoadUser($pdo, $userId)]);
    exit;
}

// 4. Remove password protection from a user profile
if ($action === 'remove_password') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        adminFail(405, 'POST required.');
    }

    $userId = isset($payload['userId']) ? (int)$payload['userId'] : 0;

    if ($userId <= 0 || !adminLoadUser($pdo, $userId)) {
        adminFail(404, 'User not found.');
    }

    // Protect the authenticated admin from removing their own password and locking themselves out
    if ($userId === (int)$admin['id']) {
        adminFail(400, 'You cannot remove the password from your own admin account.');
    }

    $stmt = $pdo->prepare('UPDATE suite_users SET password_hash = NULL WHERE id = ?');
    $stmt->execute([$userId]);

    // Invalidate active sessions
    $stmtSessions = $pdo->prepare('DELETE FROM suite_sessions WHERE user_id = ?');
    $stmtSessions->execute([$userId]);

    echo json_encode(['success' => true, 'user' => adminLoadUser($pdo, $userId)]);
    exit;
}

// 5. System and database statistics
if ($action === 'stats') {
    $stats = [];

    // Query user metrics: total accounts, password protected accounts, and active logins in last 30 days
    $userStats = [
        'total' => 0,
        'passwordProtected' => 0,
        'active30d' => 0,
        'special' => 0,
        'admin' => 0
    ];
    try {
        $stmtUsers = $pdo->query('SELECT 
            COUNT(*) AS total_users,
            SUM(CASE WHEN password_hash IS NOT NULL AND password_hash != \'\' THEN 1 ELSE 0 END) AS password_users,
            SUM(CASE WHEN last_login >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS active_users_30d
            FROM suite_users');
        if ($userRow = $stmtUsers->fetch(PDO::FETCH_ASSOC)) {
            $userStats['total'] = (int)($userRow['total_users'] ?? 0);
            $userStats['passwordProtected'] = (int)($userRow['password_users'] ?? 0);
            $userStats['active30d'] = (int)($userRow['active_users_30d'] ?? 0);
        }
    } catch (PDOException $e) {
        // Fallback default user values when table is unavailable
    }

    // Query user group membership counts for Special and Admin tiers
    try {
        $stmtGroups = $pdo->query('SELECT g.slug, COUNT(DISTINCT ug.user_id) AS user_count
            FROM suite_user_groups ug
            JOIN suite_groups g ON g.id = ug.group_id
            WHERE g.slug IN (\'special\', \'admin\')
            GROUP BY g.slug');
        while ($groupRow = $stmtGroups->fetch(PDO::FETCH_ASSOC)) {
            if ($groupRow['slug'] === 'special') {
                $userStats['special'] = (int)$groupRow['user_count'];
            } elseif ($groupRow['slug'] === 'admin') {
                $userStats['admin'] = (int)$groupRow['user_count'];
            }
        }
    } catch (PDOException $e) {
        // Fallback default group values
    }
    $stats['users'] = $userStats;

    // Query active non-expired session tokens representing unique logged-in devices
    $activeSessions = 0;
    try {
        $stmtSessions = $pdo->query('SELECT COUNT(*) FROM suite_sessions WHERE expires_at > UTC_TIMESTAMP()');
        $activeSessions = (int)($stmtSessions->fetchColumn() ?: 0);
    } catch (PDOException $e) {
        // Fallback session count
    }
    $stats['sessions'] = [
        'active' => $activeSessions
    ];

    // Query ScoreBoard game records: overall count, live matches, and finalized archives
    $scoreboardStats = ['total' => 0, 'live' => 0, 'final' => 0];
    try {
        $stmtSb = $pdo->query('SELECT 
            COUNT(*) AS total_games,
            SUM(CASE WHEN status = \'live\' THEN 1 ELSE 0 END) AS live_games,
            SUM(CASE WHEN status = \'final\' THEN 1 ELSE 0 END) AS final_games
            FROM scoreboard_games');
        if ($sbRow = $stmtSb->fetch(PDO::FETCH_ASSOC)) {
            $scoreboardStats['total'] = (int)($sbRow['total_games'] ?? 0);
            $scoreboardStats['live'] = (int)($sbRow['live_games'] ?? 0);
            $scoreboardStats['final'] = (int)($sbRow['final_games'] ?? 0);
        }
    } catch (PDOException $e) {
        // Fallback when table is absent or empty
    }
    $stats['scoreboard'] = $scoreboardStats;

    // Query Bingo records: active shared cards and game mode templates (excluding win patterns)
    $bingoStats = ['cards' => 0, 'games' => 0];
    try {
        $stmtCards = $pdo->query('SELECT COUNT(*) FROM bingo_cards WHERE deleted_at IS NULL');
        $bingoStats['cards'] = (int)($stmtCards->fetchColumn() ?: 0);
    } catch (PDOException $e) {
        // Fallback when table is absent
    }
    try {
        $stmtGames = $pdo->query('SELECT COUNT(*) FROM bingo_games WHERE deleted_at IS NULL');
        $bingoStats['games'] = (int)($stmtGames->fetchColumn() ?: 0);
    } catch (PDOException $e) {
        // Fallback when table is absent
    }
    $stats['bingo'] = $bingoStats;

    // Query User App Data sync stores: total key-value JSON records and distinct applications synced
    $userDataStats = ['totalRecords' => 0, 'syncedApps' => 0];
    try {
        $stmtData = $pdo->query('SELECT COUNT(*) AS total_records, COUNT(DISTINCT app_id) AS distinct_apps FROM suite_user_data');
        if ($dataRow = $stmtData->fetch(PDO::FETCH_ASSOC)) {
            $userDataStats['totalRecords'] = (int)($dataRow['total_records'] ?? 0);
            $userDataStats['syncedApps'] = (int)($dataRow['distinct_apps'] ?? 0);
        }
    } catch (PDOException $e) {
        // Fallback when table is absent
    }
    $stats['userData'] = $userDataStats;

    // Query total database storage size and table count from information_schema
    $databaseStats = ['sizeBytes' => 0, 'sizeFormatted' => '0 B', 'tableCount' => 0];
    try {
        $stmtDb = $pdo->query('SELECT 
            SUM(data_length + index_length) AS size_bytes,
            COUNT(*) AS table_count
            FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE()');
        if ($dbRow = $stmtDb->fetch(PDO::FETCH_ASSOC)) {
            $bytes = (float)($dbRow['size_bytes'] ?? 0);
            $databaseStats['sizeBytes'] = $bytes;
            $databaseStats['sizeFormatted'] = adminFormatBytes($bytes);
            $databaseStats['tableCount'] = (int)($dbRow['table_count'] ?? 0);
        }
    } catch (PDOException $e) {
        // Fallback if information_schema query fails
    }
    $stats['database'] = $databaseStats;

    echo json_encode([
        'success' => true,
        'stats' => $stats
    ]);
    exit;
}

adminFail(400, 'Invalid action request.');
