<?php
/**
 * Bingo Saved Cards API
 * GET    → returns array of saved cards
 * POST   → saves/updates a card (body: { id, name, serial, squares })
 * DELETE → deletes a card by ID (?id=...)
 */

// API endpoint version identifier
$version = '1.0';

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

$cardsFile = __DIR__ . '/cards.json';

if (!file_exists($cardsFile)) {
    file_put_contents($cardsFile, json_encode([], JSON_PRETTY_PRINT));
}

$cards = json_decode(file_get_contents($cardsFile), true) ?: [];

// GET
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode($cards);
    exit;
}

// POST (save or update card)
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);

    if (empty($body['name']) && empty($body['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Card name or ID is required']);
        exit;
    }

    $id = isset($body['id']) ? (string)$body['id'] : (string)(time() . rand(100, 999));
    $name = !empty($body['name']) ? trim($body['name']) : 'Card';
    $serial = isset($body['serial']) ? trim($body['serial']) : '';
    $squares = isset($body['squares']) && is_array($body['squares']) ? $body['squares'] : array_fill(0, 25, null);
    $squares[12] = 'FREE';

    $cardData = [
        'id'        => $id,
        'name'      => $name,
        'serial'    => $serial,
        'squares'   => $squares,
        'dateSaved' => date('Y-m-d H:i:s')
    ];

    $foundIndex = -1;
    foreach ($cards as $idx => $c) {
        if ((string)$c['id'] === (string)$id) {
            $foundIndex = $idx;
            break;
        }
    }

    if ($foundIndex >= 0) {
        $cards[$foundIndex] = $cardData;
    } else {
        $cards[] = $cardData;
    }

    file_put_contents($cardsFile, json_encode($cards, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    echo json_encode(['success' => true, 'card' => $cardData]);
    exit;
}

// DELETE
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    $id = $_GET['id'] ?? null;
    if ($id) {
        $cards = array_values(array_filter($cards, function($c) use ($id) {
            return (string)$c['id'] !== (string)$id;
        }));
        file_put_contents($cardsFile, json_encode($cards, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    }
    echo json_encode(['success' => true]);
    exit;
}
