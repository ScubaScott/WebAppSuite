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
