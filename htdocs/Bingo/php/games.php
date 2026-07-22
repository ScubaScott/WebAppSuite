<?php
/**
 * Bingo Game Modes API
 * GET  → returns all games as JSON
 * POST → saves a new game (body: { name, patterns: [{name, cells}] })
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

$gamesFile = __DIR__ . '/games.json';

// ---- Seed built-in games on first run ----
if (!file_exists($gamesFile)) {
    $seed = [
        [
            'id'      => 'builtin_regular',
            'name'    => 'Regular Bingo',
            'builtin' => true,
            'patterns' => [
                ['name' => 'Row 1',        'cells' => [0,1,2,3,4]],
                ['name' => 'Row 2',        'cells' => [5,6,7,8,9]],
                ['name' => 'Row 3',        'cells' => [10,11,12,13,14]],
                ['name' => 'Row 4',        'cells' => [15,16,17,18,19]],
                ['name' => 'Row 5',        'cells' => [20,21,22,23,24]],
                ['name' => 'Col B',        'cells' => [0,5,10,15,20]],
                ['name' => 'Col I',        'cells' => [1,6,11,16,21]],
                ['name' => 'Col N',        'cells' => [2,7,12,17,22]],
                ['name' => 'Col G',        'cells' => [3,8,13,18,23]],
                ['name' => 'Col O',        'cells' => [4,9,14,19,24]],
                ['name' => 'Diagonal \\',  'cells' => [0,6,12,18,24]],
                ['name' => 'Diagonal /',   'cells' => [4,8,12,16,20]],
            ]
        ],
        [
            'id'      => 'builtin_four_corners',
            'name'    => 'Four Corners',
            'builtin' => true,
            'patterns' => [
                ['name' => 'Four Corners', 'cells' => [0,4,20,24]]
            ]
        ],
        [
            'id'      => 'builtin_blackout',
            'name'    => 'Blackout',
            'builtin' => true,
            'patterns' => [
                ['name' => 'Blackout', 'cells' => [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]]
            ]
        ],
        [
            'id'      => 'builtin_x_pattern',
            'name'    => 'X Pattern',
            'builtin' => true,
            'patterns' => [
                ['name' => 'X Pattern', 'cells' => [0,4,6,8,12,16,18,20,24]]
            ]
        ],
        [
            'id'      => 'builtin_t_shape',
            'name'    => 'T-Shape',
            'builtin' => true,
            'patterns' => [
                ['name' => 'T-Shape', 'cells' => [0,1,2,3,4,7,12,17,22]]
            ]
        ],
        [
            'id'      => 'builtin_l_shape',
            'name'    => 'L-Shape',
            'builtin' => true,
            'patterns' => [
                ['name' => 'L-Shape', 'cells' => [0,5,10,15,20,21,22,23,24]]
            ]
        ],
    ];
    file_put_contents($gamesFile, json_encode($seed, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

$games = json_decode(file_get_contents($gamesFile), true) ?: [];

// ---- GET ----
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode($games);
    exit;
}

// ---- POST (create new game) ----
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);

    if (empty($body['name']) || empty($body['patterns']) || !is_array($body['patterns'])) {
        http_response_code(400);
        echo json_encode(['error' => 'name and patterns are required']);
        exit;
    }

    $cleanPatterns = [];
    foreach ($body['patterns'] as $p) {
        if (empty($p['cells']) || !is_array($p['cells'])) continue;
        $cleanPatterns[] = [
            'name'  => htmlspecialchars(trim($p['name'] ?? 'Pattern'), ENT_QUOTES, 'UTF-8'),
            'cells' => array_values(array_map('intval', $p['cells']))
        ];
    }

    if (empty($cleanPatterns)) {
        http_response_code(400);
        echo json_encode(['error' => 'At least one valid pattern is required']);
        exit;
    }

    $newGame = [
        'id'       => 'game_' . time() . '_' . rand(1000, 9999),
        'name'     => htmlspecialchars(trim($body['name']), ENT_QUOTES, 'UTF-8'),
        'builtin'  => false,
        'patterns' => $cleanPatterns
    ];

    $games[] = $newGame;

    if (file_put_contents($gamesFile, json_encode($games, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE)) === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Could not write games file']);
        exit;
    }

    http_response_code(201);
    echo json_encode($newGame);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method not allowed']);
