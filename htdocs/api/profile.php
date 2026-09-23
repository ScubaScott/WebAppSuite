<?php
// WebAppSuite Profile and Cloud Sync API
// Handles profile authentication, password management, and app settings synchronization.

// API endpoint version identifier
$API_VERSION = '1.2';

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
        'error' => 'Database service unavailable. Operating in local cache mode.',
        'dbAvailable' => false
    ]);
    exit;
}

$action = isset($_GET['action']) ? trim($_GET['action']) : '';

// 1. Check Profile / Auth Status
if ($action === 'status') {
    $token = getAuthToken();
    $user = authenticateUser($pdo, $token);
    if (!$user) {
        echo json_encode(['loggedIn' => false]);
        exit;
    }
    echo json_encode([
        'loggedIn' => true,
        'username' => $user['username'],
        'hasPassword' => !empty($user['password_hash'])
    ]);
    exit;
}

// 2. Authenticate or Register Profile
if ($action === 'auth') {
    $rawInput = file_get_contents('php://input');
    if (strlen($rawInput) > 262144) {
        http_response_code(413);
        echo json_encode(['success' => false, 'error' => 'Request body exceeds 256 KB limit.']);
        exit;
    }

    $payload = json_decode($rawInput, true) ?: [];
    $username = isset($payload['username']) ? trim($payload['username']) : '';
    $password = isset($payload['password']) ? trim($payload['password']) : '';

    // Validate username requirements: 2-50 characters, letters, numbers, hyphens, underscores
    if (empty($username) || !preg_match('/^[a-zA-Z0-9_\-]{2,50}$/', $username)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Username must be 2-50 characters (letters, numbers, hyphens, underscores).']);
        exit;
    }

    $stmt = $pdo->prepare('SELECT id, username, password_hash FROM suite_users WHERE username = ? LIMIT 1');
    $stmt->execute([$username]);
    $existing = $stmt->fetch();

    if ($existing) {
        // Existing user: check if password is required
        if (!empty($existing['password_hash'])) {
            if (empty($password) || !password_verify($password, $existing['password_hash'])) {
                http_response_code(401);
                echo json_encode([
                    'success' => false,
                    'requiresPassword' => true,
                    'error' => empty($password) ? 'Password required for this profile.' : 'Incorrect password.'
                ]);
                exit;
            }
        }

        // Issue new per-device session token and record hash in suite_sessions
        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $insertSession = $pdo->prepare('INSERT INTO suite_sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 90 DAY))');
        $insertSession->execute([$existing['id'], $tokenHash]);

        // Touch last_login on user profile
        $update = $pdo->prepare('UPDATE suite_users SET last_login = NOW() WHERE id = ?');
        $update->execute([$existing['id']]);

        echo json_encode([
            'success' => true,
            'token' => $token,
            'username' => $existing['username'],
            'hasPassword' => !empty($existing['password_hash']),
            'isNew' => false
        ]);
        exit;
    } else {
        // New user: register profile
        $passwordHash = !empty($password) ? password_hash($password, PASSWORD_DEFAULT) : null;
        $insertUser = $pdo->prepare('INSERT INTO suite_users (username, password_hash) VALUES (?, ?)');
        $insertUser->execute([$username, $passwordHash]);
        $newUserId = (int)$pdo->lastInsertId();

        // Issue new per-device session token in suite_sessions
        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $insertSession = $pdo->prepare('INSERT INTO suite_sessions (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 90 DAY))');
        $insertSession->execute([$newUserId, $tokenHash]);

        echo json_encode([
            'success' => true,
            'token' => $token,
            'username' => $username,
            'hasPassword' => !empty($passwordHash),
            'isNew' => true
        ]);
        exit;
    }
}

// 3. Set or Update Password for Authenticated Profile
if ($action === 'set_password') {
    $rawInput = file_get_contents('php://input');
    $payload = json_decode($rawInput, true) ?: [];
    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);
    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Authentication required.']);
        exit;
    }

    $newPassword = isset($payload['newPassword']) ? trim($payload['newPassword']) : '';

    if (empty($newPassword) || strlen($newPassword) < 3) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Password must be at least 3 characters.']);
        exit;
    }

    $newHash = password_hash($newPassword, PASSWORD_DEFAULT);
    $stmt = $pdo->prepare('UPDATE suite_users SET password_hash = ? WHERE id = ?');
    $stmt->execute([$newHash, $user['id']]);

    echo json_encode(['success' => true, 'hasPassword' => true]);
    exit;
}

// 4. Load App Data
if ($action === 'load') {
    $token = getAuthToken();
    $user = authenticateUser($pdo, $token);
    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Authentication required.']);
        exit;
    }

    $appId = isset($_GET['app']) ? trim($_GET['app']) : '';
    if (empty($appId) || strlen($appId) > 32 || !preg_match('/^[a-zA-Z0-9_\-]{1,32}$/', $appId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid or missing app identifier (max 32 chars).']);
        exit;
    }

    $stmt = $pdo->prepare('SELECT data_json, version, updated_at FROM suite_user_data WHERE user_id = ? AND app_id = ? LIMIT 1');
    $stmt->execute([$user['id'], $appId]);
    $row = $stmt->fetch();

    if ($row) {
        $parsedData = json_decode($row['data_json'], true);
        echo json_encode([
            'success' => true,
            'app' => $appId,
            'data' => $parsedData,
            'version' => (int)$row['version'],
            'updatedAt' => $row['updated_at']
        ]);
    } else {
        echo json_encode([
            'success' => true,
            'app' => $appId,
            'data' => null
        ]);
    }
    exit;
}

// 5. Save App Data
if ($action === 'save') {
    $rawInput = file_get_contents('php://input');
    if (strlen($rawInput) > 262144) {
        http_response_code(413);
        echo json_encode(['success' => false, 'error' => 'Payload exceeds 256 KB limit.']);
        exit;
    }

    $payload = json_decode($rawInput, true) ?: [];
    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);
    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Authentication required.']);
        exit;
    }

    $appId = isset($_GET['app']) ? trim($_GET['app']) : '';
    if (empty($appId) || strlen($appId) > 32 || !preg_match('/^[a-zA-Z0-9_\-]{1,32}$/', $appId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid or missing app identifier (max 32 chars).']);
        exit;
    }

    if (!isset($payload['data'])) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid data payload.']);
        exit;
    }

    $jsonString = json_encode($payload['data']);

    // Upsert app data for this user
    $sql = 'INSERT INTO suite_user_data (user_id, app_id, data_json, version)
            VALUES (?, ?, ?, 1)
            ON DUPLICATE KEY UPDATE
            data_json = VALUES(data_json),
            version = version + 1,
            updated_at = NOW()';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$user['id'], $appId, $jsonString]);

    echo json_encode(['success' => true, 'app' => $appId]);
    exit;
}

http_response_code(400);
echo json_encode(['success' => false, 'error' => 'Invalid action request.']);
