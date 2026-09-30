<?php
// Bingo App SQL Persistence & Offline Sync Backend API
// Provides endpoints for health check, cards CRUD, favorites, and games CRUD.

// API endpoint version identifier
$BINGO_API_VERSION = '1.1';

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, HEAD, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth.php';

// Parse endpoint and resource ID from request
$endpoint = isset($_GET['endpoint']) ? trim($_GET['endpoint']) : '';
$resourceId = isset($_GET['id']) ? trim($_GET['id']) : '';

// Fallback parsing for direct paths if rewrite didn't provide GET params
if (empty($endpoint)) {
    $requestUri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    if (preg_match('#(?:^|/)api/(health|cards|favorites|games)(?:/([^/?#]+))?#i', $requestUri, $matches)) {
        $endpoint = strtolower($matches[1]);
        if (!empty($matches[2])) {
            $resourceId = trim($matches[2]);
        }
    }
}

// -----------------------------------------------------------------------------
// Database Connection
// -----------------------------------------------------------------------------
$pdo = getDbConnection();

// Health check endpoint responds fast and verifies database connectivity
if ($endpoint === 'health') {
    if (!$pdo) {
        http_response_code(503);
        exit;
    }
    http_response_code(200);
    if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') {
        echo json_encode(['status' => 'ok', 'version' => $BINGO_API_VERSION]);
    }
    exit;
}

// For all other endpoints, database is required
if (!$pdo) {
    http_response_code(503);
    echo json_encode([
        'error' => 'Database service unavailable. Operating in local cache mode.',
        'dbAvailable' => false
    ]);
    exit;
}

// Ensure database tables exist and seed built-in games if needed
ensureBingoTablesInitialized($pdo);

// Read and decode JSON request payload
function getJsonPayload() {
    $raw = file_get_contents('php://input');
    if (empty($raw)) {
        return [];
    }
    return json_decode($raw, true) ?: [];
}

// -----------------------------------------------------------------------------
// Endpoint: /api/cards
// -----------------------------------------------------------------------------
if ($endpoint === 'cards') {
    $method = $_SERVER['REQUEST_METHOD'];

    // GET /api/cards - list all active cards in the global library
    if ($method === 'GET') {
        $userId = isset($_GET['userId']) ? trim($_GET['userId']) : '';
        if (empty($userId)) {
            $token = getAuthToken();
            $user = authenticateUser($pdo, $token);
            if ($user) {
                $userId = $user['username'];
            }
        }

        if (!empty($userId)) {
            $sql = 'SELECT c.id, c.label, c.serial, c.squares, c.created_by, c.created_at, c.updated_at,
                           CASE WHEN f.card_id IS NOT NULL THEN 1 ELSE 0 END AS is_favorite,
                           f.favorited_at
                    FROM bingo_cards c
                    LEFT JOIN bingo_card_favorites f ON f.card_id = c.id AND f.user_id = ?
                    WHERE c.deleted_at IS NULL
                    ORDER BY is_favorite DESC, f.favorited_at DESC, c.updated_at DESC';
            $stmt = $pdo->prepare($sql);
            $stmt->execute([$userId]);
        } else {
            $sql = 'SELECT id, label, serial, squares, created_by, created_at, updated_at
                    FROM bingo_cards
                    WHERE deleted_at IS NULL
                    ORDER BY updated_at DESC';
            $stmt = $pdo->prepare($sql);
            $stmt->execute();
        }

        $rows = $stmt->fetchAll();
        $cards = [];
        foreach ($rows as $row) {
            $decodedSquares = json_decode($row['squares'], true);
            if (!is_array($decodedSquares) || count($decodedSquares) !== 25) {
                $decodedSquares = array_fill(0, 25, null);
                $decodedSquares[12] = 'FREE';
            }
            $cards[] = [
                'id'         => $row['id'],
                'label'      => $row['label'],
                'name'       => $row['label'], // Backwards compatibility for existing UI
                'serial'     => $row['serial'],
                'squares'    => $decodedSquares,
                'createdBy'  => $row['created_by'],
                'createdAt'  => gmdate('c', strtotime($row['created_at'])),
                'updatedAt'  => gmdate('c', strtotime($row['updated_at'])),
                'isFavorite' => !empty($row['is_favorite'])
            ];
        }

        echo json_encode($cards);
        exit;
    }

    // PUT /api/cards/{cardId} - upsert card with 25 squares
    if ($method === 'PUT' || ($method === 'POST' && !empty($resourceId))) {
        $cardId = $resourceId;
        $body = getJsonPayload();

        if (empty($cardId) && !empty($body['id'])) {
            $cardId = trim($body['id']);
        }

        if (empty($cardId)) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing card ID']);
            exit;
        }

        $label = isset($body['label']) ? trim($body['label']) : (isset($body['name']) ? trim($body['name']) : '');
        $serial = isset($body['serial']) ? trim($body['serial']) : '';
        $squares = isset($body['squares']) && is_array($body['squares']) ? $body['squares'] : [];

        // Validate 25 squares
        if (count($squares) !== 25) {
            http_response_code(400);
            echo json_encode(['error' => 'Card squares must be an array of exactly 25 elements']);
            exit;
        }

        // Center space is always FREE
        $squares[12] = 'FREE';

        // Check authentication for created_by attribution
        $createdBy = !empty($body['createdBy']) ? trim($body['createdBy']) : null;
        if (!$createdBy) {
            $token = getAuthToken($body);
            $user = authenticateUser($pdo, $token);
            if ($user) {
                $createdBy = $user['username'];
            }
        }

        $updatedAt = !empty($body['updatedAt']) ? date('Y-m-d H:i:s', strtotime($body['updatedAt'])) : gmdate('Y-m-d H:i:s');
        $squaresJson = json_encode($squares);

        $sql = 'INSERT INTO bingo_cards (id, label, serial, squares, created_by, created_at, updated_at, deleted_at)
                VALUES (?, ?, ?, ?, ?, NOW(), ?, NULL)
                ON DUPLICATE KEY UPDATE
                    label = VALUES(label),
                    serial = VALUES(serial),
                    squares = VALUES(squares),
                    created_by = COALESCE(VALUES(created_by), created_by),
                    updated_at = VALUES(updated_at),
                    deleted_at = NULL';

        $stmt = $pdo->prepare($sql);
        $stmt->execute([$cardId, $label, $serial, $squaresJson, $createdBy, $updatedAt]);

        $responseCard = [
            'id'        => $cardId,
            'label'     => $label,
            'name'      => $label,
            'serial'    => $serial,
            'squares'   => $squares,
            'createdBy' => $createdBy,
            'updatedAt' => gmdate('c', strtotime($updatedAt))
        ];

        echo json_encode($responseCard);
        exit;
    }

    // DELETE /api/cards/{cardId} - soft delete card
    if ($method === 'DELETE') {
        $cardId = $resourceId;
        if (empty($cardId) && isset($_GET['id'])) {
            $cardId = trim($_GET['id']);
        }

        if (empty($cardId)) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing card ID']);
            exit;
        }

        $stmt = $pdo->prepare('UPDATE bingo_cards SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL');
        $stmt->execute([$cardId]);

        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(['error' => 'Card not found or already deleted']);
            exit;
        }

        http_response_code(204);
        exit;
    }

    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed on /api/cards']);
    exit;
}

// -----------------------------------------------------------------------------
// Endpoint: /api/favorites
// -----------------------------------------------------------------------------
if ($endpoint === 'favorites') {
    $method = $_SERVER['REQUEST_METHOD'];
    $cardId = $resourceId;
    if (empty($cardId) && isset($_GET['id'])) {
        $cardId = trim($_GET['id']);
    }

    if (empty($cardId)) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing card ID']);
        exit;
    }

    // Authentication is required for favorites
    $token = getAuthToken();
    $user = authenticateUser($pdo, $token);
    if (!$user) {
        http_response_code(401);
        echo json_encode(['error' => 'Authentication required to manage favorites']);
        exit;
    }

    $userId = $user['username'];

    // PUT /api/favorites/{cardId} - add favorite
    if ($method === 'PUT' || $method === 'POST') {
        $stmt = $pdo->prepare('INSERT INTO bingo_card_favorites (user_id, card_id, favorited_at)
                               VALUES (?, ?, NOW())
                               ON DUPLICATE KEY UPDATE favorited_at = favorited_at');
        $stmt->execute([$userId, $cardId]);

        echo json_encode(['success' => true, 'cardId' => $cardId, 'isFavorite' => true]);
        exit;
    }

    // DELETE /api/favorites/{cardId} - remove favorite
    if ($method === 'DELETE') {
        $stmt = $pdo->prepare('DELETE FROM bingo_card_favorites WHERE user_id = ? AND card_id = ?');
        $stmt->execute([$userId, $cardId]);

        if ($stmt->rowCount() === 0) {
            http_response_code(404);
            echo json_encode(['error' => 'Favorite not found']);
            exit;
        }

        http_response_code(204);
        exit;
    }

    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed on /api/favorites']);
    exit;
}

// -----------------------------------------------------------------------------
// Endpoint: /api/games
// -----------------------------------------------------------------------------
if ($endpoint === 'games') {
    $method = $_SERVER['REQUEST_METHOD'];

    // GET /api/games - return all active games with their patterns
    if ($method === 'GET') {
        $gamesStmt = $pdo->query('SELECT id, name, builtin FROM bingo_games WHERE deleted_at IS NULL ORDER BY builtin DESC, name ASC');
        $games = $gamesStmt->fetchAll();

        $patternsStmt = $pdo->query('SELECT id, game_id, name, cells, sort_order FROM bingo_patterns ORDER BY sort_order ASC, name ASC');
        $patterns = $patternsStmt->fetchAll();

        $patternsByGame = [];
        foreach ($patterns as $p) {
            $gId = $p['game_id'];
            if (!isset($patternsByGame[$gId])) {
                $patternsByGame[$gId] = [];
            }
            $patternsByGame[$gId][] = [
                'id'        => $p['id'],
                'name'      => $p['name'],
                'cells'     => json_decode($p['cells'], true) ?: [],
                'sortOrder' => (int)$p['sort_order']
            ];
        }

        $result = [];
        foreach ($games as $g) {
            $result[] = [
                'id'       => $g['id'],
                'name'     => $g['name'],
                'builtin'  => (bool)$g['builtin'],
                'patterns' => $patternsByGame[$g['id']] ?? []
            ];
        }

        echo json_encode($result);
        exit;
    }

    // PUT /api/games/{gameId} - atomic upsert of game and patterns
    if ($method === 'PUT' || ($method === 'POST' && !empty($resourceId))) {
        $gameId = $resourceId;
        $body = getJsonPayload();

        if (empty($gameId) && !empty($body['id'])) {
            $gameId = trim($body['id']);
        }

        if (empty($gameId)) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing game ID']);
            exit;
        }

        $name = isset($body['name']) ? trim($body['name']) : '';
        if (empty($name)) {
            http_response_code(400);
            echo json_encode(['error' => 'Game name is required']);
            exit;
        }

        $patterns = isset($body['patterns']) && is_array($body['patterns']) ? $body['patterns'] : [];
        if (empty($patterns)) {
            http_response_code(400);
            echo json_encode(['error' => 'At least one pattern is required']);
            exit;
        }

        // Prevent modification of built-in games
        $checkStmt = $pdo->prepare('SELECT builtin FROM bingo_games WHERE id = ? LIMIT 1');
        $checkStmt->execute([$gameId]);
        $existing = $checkStmt->fetch();
        if ($existing && !empty($existing['builtin'])) {
            http_response_code(403);
            echo json_encode(['error' => 'Built-in games cannot be modified']);
            exit;
        }

        $updatedAt = !empty($body['updatedAt']) ? date('Y-m-d H:i:s', strtotime($body['updatedAt'])) : gmdate('Y-m-d H:i:s');

        $pdo->beginTransaction();
        try {
            // Upsert game record
            $gameSql = 'INSERT INTO bingo_games (id, name, builtin, created_at, updated_at, deleted_at)
                        VALUES (?, ?, 0, NOW(), ?, NULL)
                        ON DUPLICATE KEY UPDATE
                            name = VALUES(name),
                            updated_at = VALUES(updated_at),
                            deleted_at = NULL';
            $gameStmt = $pdo->prepare($gameSql);
            $gameStmt->execute([$gameId, $name, $updatedAt]);

            // Replace patterns
            $delPatterns = $pdo->prepare('DELETE FROM bingo_patterns WHERE game_id = ?');
            $delPatterns->execute([$gameId]);

            $insertPattern = $pdo->prepare('INSERT INTO bingo_patterns (id, game_id, name, cells, sort_order) VALUES (?, ?, ?, ?, ?)');
            $savedPatterns = [];

            foreach ($patterns as $idx => $p) {
                $pId = !empty($p['id']) ? trim($p['id']) : sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x', mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000, mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
                $pName = !empty($p['name']) ? trim($p['name']) : 'Pattern ' . ($idx + 1);
                $pCells = isset($p['cells']) && is_array($p['cells']) ? array_values(array_map('intval', $p['cells'])) : [12];
                $pSort = isset($p['sortOrder']) ? (int)$p['sortOrder'] : $idx;

                $insertPattern->execute([$pId, $gameId, $pName, json_encode($pCells), $pSort]);
                $savedPatterns[] = [
                    'id'        => $pId,
                    'name'      => $pName,
                    'cells'     => $pCells,
                    'sortOrder' => $pSort
                ];
            }

            $pdo->commit();

            echo json_encode([
                'id'       => $gameId,
                'name'     => $name,
                'builtin'  => false,
                'patterns' => $savedPatterns
            ]);
            exit;

        } catch (Exception $e) {
            $pdo->rollBack();
            http_response_code(500);
            echo json_encode(['error' => 'Database error saving game: ' . $e->getMessage()]);
            exit;
        }
    }

    // DELETE /api/games/{gameId} - soft delete game (cannot delete built-ins)
    if ($method === 'DELETE') {
        $gameId = $resourceId;
        if (empty($gameId) && isset($_GET['id'])) {
            $gameId = trim($_GET['id']);
        }

        if (empty($gameId)) {
            http_response_code(400);
            echo json_encode(['error' => 'Missing game ID']);
            exit;
        }

        $checkStmt = $pdo->prepare('SELECT builtin FROM bingo_games WHERE id = ? LIMIT 1');
        $checkStmt->execute([$gameId]);
        $game = $checkStmt->fetch();

        if (!$game) {
            http_response_code(404);
            echo json_encode(['error' => 'Game not found']);
            exit;
        }

        if (!empty($game['builtin'])) {
            http_response_code(403);
            echo json_encode(['error' => 'Built-in games cannot be deleted']);
            exit;
        }

        $delStmt = $pdo->prepare('UPDATE bingo_games SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL');
        $delStmt->execute([$gameId]);

        http_response_code(204);
        exit;
    }

    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed on /api/games']);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'Endpoint not found']);
exit;

// -----------------------------------------------------------------------------
// Database Helper: Ensure tables and seed rows exist
// -----------------------------------------------------------------------------
function ensureBingoTablesInitialized($pdo) {
    static $initialized = false;
    if ($initialized) return;

    try {
        // Check if cards table exists
        $test = $pdo->query("SHOW TABLES LIKE 'bingo_cards'")->fetch();
        if (!$test) {
            $schemaFile = __DIR__ . '/schema.sql';
            if (file_exists($schemaFile)) {
                $pdo->exec(file_get_contents($schemaFile));
            }
        }

        // Migrate legacy JSON files if tables are empty
        migrateLegacyJsonData($pdo);

    } catch (Exception $e) {
        error_log("Bingo table init notice: " . $e->getMessage());
    }

    $initialized = true;
}

// Migrate legacy cards.json and games.json into SQL tables if present
function migrateLegacyJsonData($pdo) {
    $cardsJsonFile = dirname(__DIR__) . '/Bingo/php/cards.json';
    if (file_exists($cardsJsonFile)) {
        $cardCount = (int)$pdo->query("SELECT COUNT(*) FROM bingo_cards")->fetchColumn();
        if ($cardCount === 0) {
            $jsonCards = json_decode(file_get_contents($cardsJsonFile), true) ?: [];
            $insert = $pdo->prepare('INSERT IGNORE INTO bingo_cards (id, label, serial, squares, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NOW(), NOW())');
            foreach ($jsonCards as $c) {
                if (empty($c['squares']) || !is_array($c['squares'])) continue;
                $cId = !empty($c['id']) ? (string)$c['id'] : sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x', mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000, mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
                $cName = !empty($c['name']) ? trim($c['name']) : 'Card';
                $cSerial = !empty($c['serial']) ? trim($c['serial']) : '';
                $insert->execute([$cId, $cName, $cSerial, json_encode($c['squares'])]);
            }
        }
    }

    $gamesJsonFile = dirname(__DIR__) . '/Bingo/php/games.json';
    if (file_exists($gamesJsonFile)) {
        $customCount = (int)$pdo->query("SELECT COUNT(*) FROM bingo_games WHERE builtin = 0")->fetchColumn();
        if ($customCount === 0) {
            $jsonGames = json_decode(file_get_contents($gamesJsonFile), true) ?: [];
            $insertGame = $pdo->prepare('INSERT IGNORE INTO bingo_games (id, name, builtin, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())');
            $insertPattern = $pdo->prepare('INSERT IGNORE INTO bingo_patterns (id, game_id, name, cells, sort_order) VALUES (?, ?, ?, ?, ?)');
            foreach ($jsonGames as $g) {
                if (!empty($g['builtin'])) continue; // built-ins are already seeded
                $gId = !empty($g['id']) ? (string)$g['id'] : sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x', mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000, mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
                $gName = !empty($g['name']) ? trim($g['name']) : 'Custom Game';
                $insertGame->execute([$gId, $gName, 0]);

                if (!empty($g['patterns']) && is_array($g['patterns'])) {
                    foreach ($g['patterns'] as $idx => $p) {
                        $pId = sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x', mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0x0fff) | 0x4000, mt_rand(0, 0x3fff) | 0x8000, mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff));
                        $pName = !empty($p['name']) ? trim($p['name']) : 'Pattern ' . ($idx + 1);
                        $pCells = !empty($p['cells']) && is_array($p['cells']) ? json_encode(array_values(array_map('intval', $p['cells']))) : '[12]';
                        $insertPattern->execute([$pId, $gId, $pName, $pCells, $idx]);
                    }
                }
            }
        }
    }
}
