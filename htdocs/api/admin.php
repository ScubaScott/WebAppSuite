<?php
// WebAppSuite Admin API
// Lets Admin-group users list profiles, manage Special group membership, and reset or remove user passwords.

// API endpoint version identifier
$ADMIN_API_VERSION = '1.1';

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

adminFail(400, 'Invalid action request.');
