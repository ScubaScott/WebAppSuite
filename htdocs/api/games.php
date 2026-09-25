<?php
// WebAppSuite Game Tracking API
// Handles match synchronization, active games directory, and user game archive persistence.

// API endpoint version identifier
$GAMES_API_VERSION = '1.1';

// Inactivity threshold (in hours) after which a live game is automatically finalized
define('GAME_TIMEOUT_HOURS', 3);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth.php';

header('Content-Type: application/json; charset=utf-8');

// Ensure database availability
$pdo = getDbConnection();
if (!$pdo) {
    http_response_code(503);
    echo json_encode([
        'success' => false,
        'error' => 'Database service unavailable. Operating in local cache mode.'
    ]);
    exit;
}

$action = isset($_GET['action']) ? trim($_GET['action']) : '';

// Helper function to read and decode JSON request body with 256 KB size limit
function getRequestPayload() {
    $raw = file_get_contents('php://input');
    if (strlen($raw) > 262144) {
        http_response_code(413);
        echo json_encode(['success' => false, 'error' => 'Payload exceeds 256 KB limit.']);
        exit;
    }
    return json_decode($raw, true) ?: [];
}

// Helper function to clean text inputs and remove control characters
function sanitizeText($text, $maxLength = 60) {
    if (!is_string($text)) {
        return '';
    }
    // Strip ASCII control characters (0x00-0x1F, 0x7F) and trim
    $cleaned = preg_replace('/[\x00-\x1F\x7F]/u', '', trim($text));
    return mb_substr($cleaned, 0, $maxLength, 'UTF-8');
}

// -----------------------------------------------------------------------------
// 1. Sync Game (Create or Update snapshot)
// -----------------------------------------------------------------------------
if ($action === 'sync') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method not allowed. Use POST.']);
        exit;
    }

    $payload = getRequestPayload();
    $gameId = isset($payload['game_id']) ? trim($payload['game_id']) : '';
    $writeToken = isset($payload['write_token']) ? trim($payload['write_token']) : '';
    $rev = isset($payload['rev']) ? (int)$payload['rev'] : 0;
    $visibility = isset($payload['visibility']) && $payload['visibility'] === 'private' ? 'private' : 'public';
    $status = isset($payload['status']) && $payload['status'] === 'final' ? 'final' : 'live';
    $endedBy = isset($payload['ended_by']) && in_array($payload['ended_by'], ['user', 'new_game', 'timeout'], true) ? $payload['ended_by'] : null;
    $snapshot = isset($payload['snapshot']) && is_array($payload['snapshot']) ? $payload['snapshot'] : [];

    // Validate game UUID and write token format (64-character hex string)
    if (empty($gameId) || strlen($gameId) > 36 || !preg_match('/^[a-zA-Z0-9_\-]{8,36}$/', $gameId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid or missing game_id.']);
        exit;
    }
    if (empty($writeToken) || !preg_match('/^[a-fA-F0-9]{64}$/', $writeToken)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Invalid or missing write_token (must be 64 hex characters).']);
        exit;
    }

    // Extract denormalized summary fields from the snapshot
    $homeName = sanitizeText($snapshot['homeTeamName'] ?? 'Home', 60);
    $awayName = sanitizeText($snapshot['awayTeamName'] ?? 'Away', 60);
    $homeScore = isset($snapshot['homeScore']) ? (int)$snapshot['homeScore'] : 0;
    $awayScore = isset($snapshot['awayScore']) ? (int)$snapshot['awayScore'] : 0;
    $currentPeriod = isset($snapshot['currentPeriod']) ? max(1, (int)$snapshot['currentPeriod']) : 1;
    $timerRunning = !empty($snapshot['timerRunning']) ? 1 : 0;
    $isPaused = !empty($snapshot['isPaused']) ? 1 : 0;
    $elapsedMs = isset($snapshot['elapsedMs']) ? max(0, (int)$snapshot['elapsedMs']) : 0;

    // Cap score history log array at 2000 entries to prevent database exhaustion
    if (isset($snapshot['scoreHistory']) && is_array($snapshot['scoreHistory'])) {
        if (count($snapshot['scoreHistory']) > 2000) {
            $snapshot['scoreHistory'] = array_slice($snapshot['scoreHistory'], -2000);
        }
    }

    // Resolve user session if a token is present
    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);
    $writeTokenHash = hash('sha256', $writeToken);
    $nowUtc = gmdate('Y-m-d H:i:s');

    // Started and ended timestamp calculations
    $startedAt = $nowUtc;
    if (!empty($snapshot['startedAt']) && is_numeric($snapshot['startedAt'])) {
        $startedAt = gmdate('Y-m-d H:i:s', (int)($snapshot['startedAt'] / 1000));
    }
    $endedAt = ($status === 'final') ? $nowUtc : null;

    $stateJson = json_encode($snapshot, JSON_UNESCAPED_UNICODE);

    // Check if the game row already exists
    $stmt = $pdo->prepare('SELECT id, owner_id, write_token_hash, visibility, status, rev, ended_at FROM suite_games WHERE game_id = ? LIMIT 1');
    $stmt->execute([$gameId]);
    $existing = $stmt->fetch();

    if (!$existing) {
        // --- CREATE NEW GAME ---
        $ownerId = $user ? (int)$user['id'] : null;
        // For guest games, force visibility to public and set 24-hour expiration
        if ($ownerId === null) {
            $visibility = 'public';
            $expiresAt = gmdate('Y-m-d H:i:s', time() + 86400);
        } else {
            $expiresAt = null; // Owned games are kept until deleted
        }

        $insertSql = 'INSERT INTO suite_games (
            game_id, app_id, owner_id, write_token_hash, visibility, status, ended_by, rev,
            home_name, away_name, home_score, away_score, current_period, timer_running, is_paused, elapsed_ms,
            state_json, started_at, ended_at, last_activity_at, expires_at
        ) VALUES (?, "scoreboard", ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

        $insertStmt = $pdo->prepare($insertSql);
        $insertStmt->execute([
            $gameId, $ownerId, $writeTokenHash, $visibility, $status, $endedBy, $rev,
            $homeName, $awayName, $homeScore, $awayScore, $currentPeriod, $timerRunning, $isPaused, $elapsedMs,
            $stateJson, $startedAt, $endedAt, $nowUtc, $expiresAt
        ]);

        echo json_encode([
            'success' => true,
            'rev' => $rev,
            'status' => $status,
            'visibility' => $visibility
        ]);
        exit;
    } else {
        // --- UPDATE EXISTING GAME ---
        // Authorize write: either write_token matches or authenticated session owns the row
        $tokenMatches = hash_equals($existing['write_token_hash'], $writeTokenHash);
        $isOwner = ($user && (int)$user['id'] === (int)$existing['owner_id']);

        if (!$tokenMatches && !$isOwner) {
            http_response_code(403);
            echo json_encode(['success' => false, 'error' => 'Not authorized to modify this game.']);
            exit;
        }

        // Stale revision protection: reject update if revision is not strictly newer
        if ($rev <= (int)$existing['rev']) {
            http_response_code(409);
            echo json_encode([
                'success' => false,
                'conflict' => true,
                'rev' => (int)$existing['rev'],
                'status' => $existing['status']
            ]);
            exit;
        }

        // Auto-claim guest game when a signed-in user provides matching write token
        $ownerId = $existing['owner_id'];
        $expiresAt = null;
        if ($existing['owner_id'] === null && $user !== null && $tokenMatches) {
            $ownerId = (int)$user['id'];
            $expiresAt = null;
            // Retain existing visibility on auto-claim
            $targetVisibility = in_array($visibility, ['public', 'private'], true) ? $visibility : $existing['visibility'];
        } elseif ($existing['owner_id'] === null) {
            // Unowned guest game: keep public and refresh 24-hour expiration
            $targetVisibility = 'public';
            $expiresAt = gmdate('Y-m-d H:i:s', time() + 86400);
        } else {
            // Owned game: update visibility only if requested by owner
            $targetVisibility = $isOwner ? $visibility : $existing['visibility'];
        }

        // Retain original completion timestamp if already final, otherwise set to nowUtc
        $effectiveEndedAt = ($status === 'final') ? (!empty($existing['ended_at']) ? $existing['ended_at'] : $nowUtc) : null;

        $updateSql = 'UPDATE suite_games SET
            owner_id = ?,
            visibility = ?,
            status = ?,
            ended_by = ?,
            rev = ?,
            home_name = ?,
            away_name = ?,
            home_score = ?,
            away_score = ?,
            current_period = ?,
            timer_running = ?,
            is_paused = ?,
            elapsed_ms = ?,
            state_json = ?,
            ended_at = ?,
            last_activity_at = ?,
            expires_at = ?
            WHERE id = ?';

        $updateStmt = $pdo->prepare($updateSql);
        $updateStmt->execute([
            $ownerId, $targetVisibility, $status, $endedBy, $rev,
            $homeName, $awayName, $homeScore, $awayScore, $currentPeriod, $timerRunning, $isPaused, $elapsedMs,
            $stateJson, $effectiveEndedAt, $nowUtc, $expiresAt, $existing['id']
        ]);

        echo json_encode([
            'success' => true,
            'rev' => $rev,
            'status' => $status,
            'visibility' => $targetVisibility
        ]);
        exit;
    }
}

// -----------------------------------------------------------------------------
// 2. List Public Games (Active Games board)
// -----------------------------------------------------------------------------
if ($action === 'list_public') {
    // Opportunistically prune expired guest records
    try {
        $pdo->exec('DELETE FROM suite_games WHERE expires_at IS NOT NULL AND expires_at < UTC_TIMESTAMP() LIMIT 100');
    } catch (Exception $e) {
        // Continue if opportunistic purge encounters locks
    }

    $nowUtc = gmdate('Y-m-d H:i:s');
    $nowTs = time();

    // Query active games and recent games finished within the past 24 hours
    $sql = 'SELECT game_id, home_name, away_name, home_score, away_score, current_period,
                   status, timer_running, is_paused, elapsed_ms, started_at, ended_at, last_activity_at,
                   TIMESTAMPDIFF(SECOND, last_activity_at, UTC_TIMESTAMP()) AS age_seconds
            FROM suite_games
            WHERE visibility = "public"
              AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())
              AND (status = "live" OR COALESCE(ended_at, last_activity_at) > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR))
            ORDER BY last_activity_at DESC
            LIMIT 50';

    $stmt = $pdo->query($sql);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $games = [];
    $timeoutSeconds = GAME_TIMEOUT_HOURS * 3600;

    foreach ($rows as $row) {
        $ageSeconds = max(0, (int)$row['age_seconds']);
        $effectiveStatus = $row['status'];
        $timerRunning = (int)$row['timer_running'];

        // Auto-finalize games inactive for longer than the timeout threshold
        if ($row['status'] === 'live' && $ageSeconds >= $timeoutSeconds) {
            $effectiveStatus = 'final';
            $timerRunning = 0;

            // Lazily persist timeout finalization to database
            try {
                $finalizeStmt = $pdo->prepare('UPDATE suite_games SET status = "final", ended_by = "timeout", ended_at = last_activity_at, timer_running = 0 WHERE game_id = ? AND status = "live"');
                $finalizeStmt->execute([$row['game_id']]);
            } catch (Exception $e) {}
        }

        $games[] = [
            'id' => $row['game_id'],
            'game_id' => $row['game_id'],
            'homeTeamName' => $row['home_name'],
            'awayTeamName' => $row['away_name'],
            'homeScore' => (int)$row['home_score'],
            'awayScore' => (int)$row['away_score'],
            'currentPeriod' => (int)$row['current_period'],
            'status' => $effectiveStatus,
            'timerRunning' => $timerRunning === 1,
            'isPaused' => (int)$row['is_paused'] === 1,
            'elapsedMs' => (int)$row['elapsed_ms'],
            'age_ms' => $ageSeconds * 1000,
            'lastUpdate' => ($nowTs - $ageSeconds) * 1000,
            'startedAt' => $row['started_at'],
            'endedAt' => $row['ended_at'],
            'gameTitle' => $row['home_name'] . ' vs ' . $row['away_name']
        ];
    }

    echo json_encode([
        'success' => true,
        'games' => $games,
        'server_now' => $nowTs * 1000
    ]);
    exit;
}

// -----------------------------------------------------------------------------
// 3. Get Game Details (Spectator Viewer & Operator Loader)
// -----------------------------------------------------------------------------
if ($action === 'get') {
    $payload = ($_SERVER['REQUEST_METHOD'] === 'POST') ? getRequestPayload() : [];
    $gameId = isset($_GET['id']) ? trim($_GET['id']) : ($payload['id'] ?? ($payload['game_id'] ?? ''));

    if (empty($gameId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing game identifier.']);
        exit;
    }

    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);

    $stmt = $pdo->prepare('SELECT game_id, owner_id, visibility, status, ended_by,
                                  home_name, away_name, home_score, away_score, current_period,
                                  timer_running, is_paused, elapsed_ms, state_json,
                                  started_at, ended_at, last_activity_at,
                                  TIMESTAMPDIFF(SECOND, last_activity_at, UTC_TIMESTAMP()) AS age_seconds
                           FROM suite_games
                           WHERE game_id = ?
                           LIMIT 1');
    $stmt->execute([$gameId]);
    $game = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$game) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Game not found.']);
        exit;
    }

    // Access control for private games: only the verified owner may retrieve them
    if ($game['visibility'] === 'private') {
        if (!$user || (int)$user['id'] !== (int)$game['owner_id']) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'Game not found or no longer shared.']);
            exit;
        }
    }

    $ageSeconds = max(0, (int)$game['age_seconds']);
    $timeoutSeconds = GAME_TIMEOUT_HOURS * 3600;
    $effectiveStatus = $game['status'];
    $timerRunning = (int)$game['timer_running'] === 1;

    // Check auto-finalize threshold for live games
    if ($game['status'] === 'live' && $ageSeconds >= $timeoutSeconds) {
        $effectiveStatus = 'final';
        $timerRunning = false;
        try {
            $finalizeStmt = $pdo->prepare('UPDATE suite_games SET status = "final", ended_by = "timeout", ended_at = last_activity_at, timer_running = 0 WHERE game_id = ? AND status = "live"');
            $finalizeStmt->execute([$game['game_id']]);
        } catch (Exception $e) {}
    }

    $snapshotData = json_decode($game['state_json'], true) ?: [];

    // Synthesize structured payload for viewer and scoreboard controller
    $responseGame = array_merge($snapshotData, [
        'id' => $game['game_id'],
        'game_id' => $game['game_id'],
        'homeTeamName' => $game['home_name'],
        'awayTeamName' => $game['away_name'],
        'homeScore' => (int)$game['home_score'],
        'awayScore' => (int)$game['away_score'],
        'currentPeriod' => (int)$game['current_period'],
        'status' => $effectiveStatus,
        'timerRunning' => $timerRunning,
        'isPaused' => (int)$game['is_paused'] === 1,
        'elapsedMs' => (int)$game['elapsed_ms'],
        'visibility' => $game['visibility'],
        'startedAt' => $game['started_at'],
        'endedAt' => $game['ended_at'],
        'gameTitle' => $game['home_name'] . ' vs ' . $game['away_name'],
        'lastUpdate' => (time() - $ageSeconds) * 1000
    ]);

    echo json_encode([
        'success' => true,
        'game' => $responseGame,
        'age_ms' => $ageSeconds * 1000,
        'server_now' => time() * 1000
    ]);
    exit;
}

// -----------------------------------------------------------------------------
// 4. List User's Games (My Games Dashboard)
// -----------------------------------------------------------------------------
if ($action === 'list_mine') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method not allowed. Use POST.']);
        exit;
    }

    $payload = getRequestPayload();
    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);

    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Authentication required to view your games.']);
        exit;
    }

    $limit = isset($payload['limit']) ? max(1, min(100, (int)$payload['limit'])) : 20;
    $offset = isset($payload['offset']) ? max(0, (int)$payload['offset']) : 0;

    // Count total owned games
    $countStmt = $pdo->prepare('SELECT COUNT(*) FROM suite_games WHERE owner_id = ?');
    $countStmt->execute([$user['id']]);
    $total = (int)$countStmt->fetchColumn();

    // Query paginated games list
    $listStmt = $pdo->prepare('SELECT game_id, visibility, status, ended_by,
                                      home_name, away_name, home_score, away_score, current_period,
                                      started_at, ended_at, last_activity_at,
                                      TIMESTAMPDIFF(SECOND, last_activity_at, UTC_TIMESTAMP()) AS age_seconds
                               FROM suite_games
                               WHERE owner_id = ?
                               ORDER BY started_at DESC
                               LIMIT ? OFFSET ?');
    $listStmt->bindValue(1, (int)$user['id'], PDO::PARAM_INT);
    $listStmt->bindValue(2, $limit, PDO::PARAM_INT);
    $listStmt->bindValue(3, $offset, PDO::PARAM_INT);
    $listStmt->execute();
    $rows = $listStmt->fetchAll(PDO::FETCH_ASSOC);

    $games = [];
    $timeoutSeconds = GAME_TIMEOUT_HOURS * 3600;

    foreach ($rows as $row) {
        $ageSeconds = max(0, (int)$row['age_seconds']);
        $effectiveStatus = $row['status'];
        if ($row['status'] === 'live' && $ageSeconds >= $timeoutSeconds) {
            $effectiveStatus = 'final';
        }

        $games[] = [
            'id' => $row['game_id'],
            'game_id' => $row['game_id'],
            'homeTeamName' => $row['home_name'],
            'awayTeamName' => $row['away_name'],
            'homeScore' => (int)$row['home_score'],
            'awayScore' => (int)$row['away_score'],
            'currentPeriod' => (int)$row['current_period'],
            'status' => $effectiveStatus,
            'visibility' => $row['visibility'],
            'startedAt' => $row['started_at'],
            'endedAt' => $row['ended_at'],
            'lastActivityAt' => $row['last_activity_at']
        ];
    }

    echo json_encode([
        'success' => true,
        'games' => $games,
        'total' => $total,
        'limit' => $limit,
        'offset' => $offset
    ]);
    exit;
}

// -----------------------------------------------------------------------------
// 5. Set Game Visibility (Toggle Public/Private)
// -----------------------------------------------------------------------------
if ($action === 'set_visibility') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method not allowed. Use POST.']);
        exit;
    }

    $payload = getRequestPayload();
    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);

    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Authentication required.']);
        exit;
    }

    $gameId = isset($payload['game_id']) ? trim($payload['game_id']) : '';
    $visibility = isset($payload['visibility']) && $payload['visibility'] === 'private' ? 'private' : 'public';

    if (empty($gameId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing game_id.']);
        exit;
    }

    // Verify ownership
    $stmt = $pdo->prepare('SELECT id, owner_id FROM suite_games WHERE game_id = ? LIMIT 1');
    $stmt->execute([$gameId]);
    $game = $stmt->fetch();

    if (!$game || (int)$game['owner_id'] !== (int)$user['id']) {
        http_response_code(403);
        echo json_encode(['success' => false, 'error' => 'Not authorized to change visibility for this game.']);
        exit;
    }

    $updateStmt = $pdo->prepare('UPDATE suite_games SET visibility = ? WHERE id = ?');
    $updateStmt->execute([$visibility, $game['id']]);

    echo json_encode([
        'success' => true,
        'game_id' => $gameId,
        'visibility' => $visibility
    ]);
    exit;
}

// -----------------------------------------------------------------------------
// 6. Delete Game (Archive Hard Removal)
// -----------------------------------------------------------------------------
if ($action === 'delete') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        http_response_code(405);
        echo json_encode(['success' => false, 'error' => 'Method not allowed. Use POST.']);
        exit;
    }

    $payload = getRequestPayload();
    $token = getAuthToken($payload);
    $user = authenticateUser($pdo, $token);

    if (!$user) {
        http_response_code(401);
        echo json_encode(['success' => false, 'error' => 'Authentication required.']);
        exit;
    }

    $gameId = isset($payload['game_id']) ? trim($payload['game_id']) : '';
    if (empty($gameId)) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Missing game_id.']);
        exit;
    }

    $deleteStmt = $pdo->prepare('DELETE FROM suite_games WHERE game_id = ? AND owner_id = ?');
    $deleteStmt->execute([$gameId, $user['id']]);

    if ($deleteStmt->rowCount() === 0) {
        http_response_code(404);
        echo json_encode(['success' => false, 'error' => 'Game not found or not owned by user.']);
        exit;
    }

    echo json_encode([
        'success' => true,
        'game_id' => $gameId
    ]);
    exit;
}

http_response_code(400);
echo json_encode(['success' => false, 'error' => 'Invalid action request.']);
