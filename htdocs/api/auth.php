<?php
// WebAppSuite Shared Authentication Helper Library
// Provides session token extraction and validation against suite_sessions.

// Endpoint version identifier
$AUTH_VERSION = '1.0';

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
