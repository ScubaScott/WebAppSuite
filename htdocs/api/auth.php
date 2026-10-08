<?php
// WebAppSuite Shared Authentication Helper Library
// Provides session token extraction and validation against suite_sessions.

// Endpoint version identifier
$AUTH_VERSION = '1.1';

/**
 * Extracts bearer or session token from JSON payload, query parameters, POST body, or HTTP Authorization headers.
 * Handles Apache FastCGI environments where Authorization header may be rewritten or stripped.
 *
 * @param array|null $payload Optional decoded request body
 * @return string|null Raw session token or null if not provided
 */
function getAuthToken($payload = null) {
    if (is_array($payload) && !empty($payload['token'])) {
        return trim($payload['token']);
    }
    if (!empty($_GET['token'])) {
        return trim($_GET['token']);
    }
    if (!empty($_POST['token'])) {
        return trim($_POST['token']);
    }
    if (!empty($_SERVER['HTTP_AUTHORIZATION']) && preg_match('/Bearer\s+(\S+)/i', $_SERVER['HTTP_AUTHORIZATION'], $matches)) {
        return $matches[1];
    }
    if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION']) && preg_match('/Bearer\s+(\S+)/i', $_SERVER['REDIRECT_HTTP_AUTHORIZATION'], $matches)) {
        return $matches[1];
    }
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) {
            foreach ($headers as $key => $val) {
                if (strcasecmp($key, 'Authorization') === 0 && preg_match('/Bearer\s+(\S+)/i', $val, $matches)) {
                    return $matches[1];
                }
            }
        }
    }
    return null;
}

/**
 * Authenticates request by resolving SHA-256 hash of session token in suite_sessions.
 * Validates expiration against UTC time and updates last_used_at on valid lookup.
 *
 * @param PDO $pdo Active database connection
 * @param string|null $token Raw session token passed from client
 * @return array|null User record associative array if valid session, or null if invalid/expired
 */
function authenticateUser($pdo, $token) {
    if (empty($token) || !is_string($token)) {
        return null;
    }

    $tokenHash = hash('sha256', trim($token));

    $sql = 'SELECT s.id AS session_id, s.user_id, s.expires_at, u.id, u.username, u.password_hash
            FROM suite_sessions s
            JOIN suite_users u ON u.id = s.user_id
            WHERE s.token_hash = ?
            LIMIT 1';

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$tokenHash]);
    $session = $stmt->fetch();

    if (!$session) {
        return null;
    }

    // Verify session expiration against UTC
    $nowUtc = gmdate('Y-m-d H:i:s');
    if (!empty($session['expires_at']) && $session['expires_at'] < $nowUtc) {
        return null;
    }

    // Touch last_used_at for sliding session activity
    $updateStmt = $pdo->prepare('UPDATE suite_sessions SET last_used_at = ? WHERE id = ?');
    $updateStmt->execute([$nowUtc, $session['session_id']]);

    return [
        'id' => (int)$session['id'],
        'username' => $session['username'],
        'password_hash' => $session['password_hash']
    ];
}

/**
 * Resolves the effective group slugs for a user.
 * Every signed-in user is implicitly in 'general'. The 'admin' group is dropped
 * when the profile has no password, so an unprotected profile never holds Admin access.
 *
 * @param PDO $pdo Active database connection
 * @param array $user User record returned by authenticateUser()
 * @return string[] Group slugs, always including 'general'
 */
function getUserGroups($pdo, $user) {
    $groups = ['general'];

    $stmt = $pdo->prepare('SELECT g.slug
                           FROM suite_user_groups ug
                           JOIN suite_groups g ON g.id = ug.group_id
                           WHERE ug.user_id = ?');
    $stmt->execute([$user['id']]);

    $hasPassword = !empty($user['password_hash']);
    foreach ($stmt->fetchAll() as $row) {
        $slug = $row['slug'];
        if ($slug === 'general') {
            continue;
        }
        if ($slug === 'admin' && !$hasPassword) {
            continue;
        }
        $groups[] = $slug;
    }

    return array_values(array_unique($groups));
}

/**
 * Returns the highest group rank held by a user (0 when only in 'general').
 *
 * @param PDO $pdo Active database connection
 * @param array $user User record returned by authenticateUser()
 * @return int Highest rank among the user's effective groups
 */
function getUserRank($pdo, $user) {
    $groups = getUserGroups($pdo, $user);
    $placeholders = implode(',', array_fill(0, count($groups), '?'));

    $stmt = $pdo->prepare("SELECT MAX(`rank`) FROM suite_groups WHERE slug IN ($placeholders)");
    $stmt->execute($groups);
    $rank = $stmt->fetchColumn();

    return $rank === null || $rank === false ? 0 : (int)$rank;
}

/**
 * Lists restricted app ids the user may see. Apps with no suite_app_access row are open
 * to everyone and are not included in this list.
 *
 * @param PDO $pdo Active database connection
 * @param array $user User record returned by authenticateUser()
 * @return string[] Restricted app ids the user is allowed to open
 */
function getAllowedRestrictedApps($pdo, $user) {
    $rank = getUserRank($pdo, $user);

    $stmt = $pdo->prepare('SELECT a.app_id
                           FROM suite_app_access a
                           JOIN suite_groups g ON g.id = a.min_group_id
                           WHERE g.`rank` <= ?
                           ORDER BY a.app_id');
    $stmt->execute([$rank]);

    return array_map(function ($row) { return $row['app_id']; }, $stmt->fetchAll());
}

/**
 * Builds the access summary sent to the client (groups, admin flag, allowed restricted apps).
 *
 * @param PDO $pdo Active database connection
 * @param array $user User record returned by authenticateUser()
 * @return array Associative array with groups, isAdmin and allowedApps keys
 */
function getUserAccess($pdo, $user) {
    $groups = getUserGroups($pdo, $user);

    return [
        'groups' => $groups,
        'isAdmin' => in_array('admin', $groups, true),
        'allowedApps' => getAllowedRestrictedApps($pdo, $user)
    ];
}
