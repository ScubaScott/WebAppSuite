<?php
// Simple server-side active game tracker for ScoreKeeper.
// Stores active games in a local JSON file and supports POST updates and DELETE removals.

$storageFile = __DIR__ . '/active-games.json';
$method = $_SERVER['REQUEST_METHOD'];

header('Content-Type: application/json');

if ($method === 'POST') {
    $body = file_get_contents('php://input');
    $payload = json_decode($body, true);
    if (!is_array($payload) || empty($payload['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid payload']);
        exit;
    }

    $games = [];
    if (file_exists($storageFile)) {
        $raw = file_get_contents($storageFile);
        $games = json_decode($raw, true) ?: [];
    }

    // Ensure expiresAt is present and set to 24 hours from now if missing
    $nowMs = round(microtime(true) * 1000);
    if (empty($payload['expiresAt']) || !is_numeric($payload['expiresAt'])) {
        $payload['expiresAt'] = $nowMs + 24 * 60 * 60 * 1000;
    }
    $payload['lastUpdate'] = $nowMs;
    $games[$payload['id']] = $payload;
    file_put_contents($storageFile, json_encode($games, JSON_PRETTY_PRINT));
    echo json_encode(['success' => true]);
    exit;
}

if ($method === 'DELETE') {
    $body = file_get_contents('php://input');
    $payload = json_decode($body, true);
    if (!is_array($payload) || empty($payload['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid payload']);
        exit;
    }

    if (!file_exists($storageFile)) {
        echo json_encode(['success' => true]);
        exit;
    }

    $raw = file_get_contents($storageFile);
    $games = json_decode($raw, true) ?: [];
    unset($games[$payload['id']]);
    file_put_contents($storageFile, json_encode($games, JSON_PRETTY_PRINT));
    echo json_encode(['success' => true]);
    exit;
}

if ($method === 'GET') {
    $games = [];
    if (file_exists($storageFile)) {
        $raw = file_get_contents($storageFile);
        $games = json_decode($raw, true) ?: [];
    }

    $now = time() * 1000;
    // If an id is provided, return that game only
    if (isset($_GET['id']) && !empty($_GET['id'])) {
        $id = $_GET['id'];
        if (isset($games[$id]) && (!isset($games[$id]['expiresAt']) || $games[$id]['expiresAt'] > $now)) {
            echo json_encode(['game' => $games[$id]]);
            exit;
        }
        http_response_code(404);
        echo json_encode(['error' => 'Game not found']);
        exit;
    }

    $active = [];
    foreach ($games as $game) {
        if (!isset($game['expiresAt']) || $game['expiresAt'] > $now) {
            $active[] = $game;
        }
    }

    echo json_encode(['games' => $active]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
