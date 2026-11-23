<?php
// WebAppSuite Period Tracker Backup API
// Optional per-user server copy of the Period tracker, synced record by record (last write wins by
// the record's updated_at). Requires a signed-in session and access to the 'period' app.

// API endpoint version identifier
$API_VERSION = '1.0';

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/auth.php';

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

// Record types the tracker syncs
const PERIOD_STORES = ['period_entries', 'cycle_flags', 'settings', 'health_note_dismissals', 'daily_logs'];
const PERIOD_MAX_BODY_BYTES = 262144;     // 256 KB request limit
const PERIOD_MAX_RECORD_BYTES = 16384;    // 16 KB per record
const PERIOD_MAX_PUSH_RECORDS = 200;      // records per push request
const PERIOD_PULL_PAGE = 500;             // records per pull page

// Sends a JSON error and stops
function periodFail($status, $error, $extra = []) {
    http_response_code($status);
    echo json_encode(array_merge(['success' => false, 'error' => $error], $extra));
    exit;
}

// Reads the JSON request body (256 KB limit)
function periodReadBody() {
    $raw = file_get_contents('php://input');
    if (strlen($raw) > PERIOD_MAX_BODY_BYTES) {
        periodFail(413, 'Request body exceeds 256 KB limit.');
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

// True when the string is a fixed-format ISO UTC timestamp such as 2026-11-22T23:00:00.123Z
function periodValidTimestamp($value) {
    return is_string($value) && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $value) === 1;
}

// Checks one pushed record; returns an error message, or null when it is acceptable
function periodValidateRecord($store, $record) {
    if (!in_array($store, PERIOD_STORES, true)) {
        return 'Unknown store.';
    }
    if (!is_array($record) || empty($record['id']) || !is_string($record['id'])) {
        return 'Record has no id.';
    }
    if ($store === 'settings') {
        if ($record['id'] !== 'settings') {
            return 'Invalid settings id.';
        }
    } elseif (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $record['id'])) {
        return 'Invalid record id.';
    }
    if (!isset($record['updated_at']) || !periodValidTimestamp($record['updated_at'])) {
        return 'Invalid updated_at.';
    }
    if (!isset($record['deleted']) || !is_bool($record['deleted'])) {
        return 'Missing deleted flag.';
    }
    if (strlen(json_encode($record)) > PERIOD_MAX_RECORD_BYTES) {
        return 'Record too large.';
    }
    return null;
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

$action = isset($_GET['action']) ? trim($_GET['action']) : '';
$body = $_SERVER['REQUEST_METHOD'] === 'POST' ? periodReadBody() : [];

// Every action needs a valid session and access to the restricted 'period' app
$user = authenticateUser($pdo, getAuthToken($body));
if (!$user) {
    periodFail(401, 'Authentication required.');
}
if (!in_array('period', getAllowedRestrictedApps($pdo, $user), true)) {
    periodFail(403, 'Your profile does not have access to this app.');
}
$userId = (int)$user['id'];

// Returns the user's sync state row, or null when server backup is not enabled
function periodGetState($pdo, $userId) {
    $stmt = $pdo->prepare('SELECT enabled_at, last_seq FROM period_sync_state WHERE user_id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    return $row ? $row : null;
}

// Counts the user's stored records (including soft-deleted ones)
function periodCountRecords($pdo, $userId) {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM period_records WHERE user_id = ?');
    $stmt->execute([$userId]);
    return (int)$stmt->fetchColumn();
}

// Status summary returned by status and enable
function periodStatusPayload($pdo, $userId) {
    $state = periodGetState($pdo, $userId);
    return [
        'success' => true,
        'enabled' => $state !== null,
        'lastSeq' => $state ? (int)$state['last_seq'] : 0,
        'recordCount' => periodCountRecords($pdo, $userId)
    ];
}

// 1. Status: is backup enabled and how much is stored
if ($action === 'status') {
    echo json_encode(periodStatusPayload($pdo, $userId));
    exit;
}

// 2. Enable: turns backup on for this user (idempotent)
if ($action === 'enable') {
    $stmt = $pdo->prepare('INSERT IGNORE INTO period_sync_state (user_id, enabled_at, last_seq) VALUES (?, UTC_TIMESTAMP(), 0)');
    $stmt->execute([$userId]);
    echo json_encode(periodStatusPayload($pdo, $userId));
    exit;
}

// Remaining actions need backup to be enabled
$state = periodGetState($pdo, $userId);
if (!$state) {
    periodFail(409, 'Server backup is not turned on for this profile.', ['notEnabled' => true]);
}

// 3. Push: stores records that are newer than the server copy
if ($action === 'push') {
    $items = isset($body['records']) && is_array($body['records']) ? $body['records'] : [];
    if (count($items) > PERIOD_MAX_PUSH_RECORDS) {
        periodFail(400, 'Too many records in one request.');
    }

    // Validate everything first so a bad batch changes nothing
    foreach ($items as $item) {
        $store = is_array($item) && isset($item['store']) ? $item['store'] : '';
        $record = is_array($item) && isset($item['record']) ? $item['record'] : null;
        $problem = periodValidateRecord($store, $record);
        if ($problem !== null) {
            periodFail(400, $problem);
        }
    }

    $accepted = 0;
    $stale = [];
    try {
        $pdo->beginTransaction();

        // Lock the counter row so concurrent pushes from two devices get distinct sequence numbers
        $seqStmt = $pdo->prepare('SELECT last_seq FROM period_sync_state WHERE user_id = ? FOR UPDATE');
        $seqStmt->execute([$userId]);
        $seq = (int)$seqStmt->fetchColumn();

        $findStmt = $pdo->prepare('SELECT client_updated_at, data_json FROM period_records WHERE user_id = ? AND store = ? AND record_id = ?');
        $upsertStmt = $pdo->prepare('INSERT INTO period_records (user_id, store, record_id, data_json, client_updated_at, deleted, change_seq)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)
                                     ON DUPLICATE KEY UPDATE
                                     data_json = VALUES(data_json),
                                     client_updated_at = VALUES(client_updated_at),
                                     deleted = VALUES(deleted),
                                     change_seq = VALUES(change_seq)');

        foreach ($items as $item) {
            $store = $item['store'];
            $record = $item['record'];
            $findStmt->execute([$userId, $store, $record['id']]);
            $existingRow = $findStmt->fetch();

            if ($existingRow) {
                $existing = $existingRow['client_updated_at'];
                if (strcmp($existing, $record['updated_at']) > 0) {
                    // The server copy is newer: send it back so the client can adopt it
                    $stale[] = ['store' => $store, 'id' => $record['id'], 'record' => json_decode($existingRow['data_json'], true)];
                    continue;
                }
                if (strcmp($existing, $record['updated_at']) === 0) {
                    // Identical version already stored
                    continue;
                }
            }

            $seq++;
            $upsertStmt->execute([
                $userId, $store, $record['id'], json_encode($record),
                $record['updated_at'], $record['deleted'] ? 1 : 0, $seq
            ]);
            $accepted++;
        }

        $update = $pdo->prepare('UPDATE period_sync_state SET last_seq = ? WHERE user_id = ?');
        $update->execute([$seq, $userId]);
        $pdo->commit();
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('period push failed: ' . $e->getMessage());
        periodFail(500, 'Could not save records.');
    }

    echo json_encode(['success' => true, 'accepted' => $accepted, 'stale' => $stale, 'lastSeq' => $seq]);
    exit;
}

// 4. Pull: records changed after the client's cursor
if ($action === 'pull') {
    $since = isset($_GET['since']) ? max(0, (int)$_GET['since']) : 0;

    $stmt = $pdo->prepare('SELECT store, data_json, change_seq FROM period_records
                           WHERE user_id = ? AND change_seq > ?
                           ORDER BY change_seq ASC
                           LIMIT ?');
    $stmt->bindValue(1, $userId, PDO::PARAM_INT);
    $stmt->bindValue(2, $since, PDO::PARAM_INT);
    $stmt->bindValue(3, PERIOD_PULL_PAGE, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();

    $records = [];
    $cursor = $since;
    foreach ($rows as $row) {
        $records[] = ['store' => $row['store'], 'record' => json_decode($row['data_json'], true)];
        $cursor = (int)$row['change_seq'];
    }

    echo json_encode([
        'success' => true,
        'records' => $records,
        'cursor' => $cursor,
        'hasMore' => count($rows) === PERIOD_PULL_PAGE,
        'lastSeq' => (int)$state['last_seq']
    ]);
    exit;
}

// 5. Reset: marks every stored record deleted so other devices drop it too (used by "Replace all" import)
if ($action === 'reset' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $pdo->beginTransaction();
        $seqStmt = $pdo->prepare('SELECT last_seq FROM period_sync_state WHERE user_id = ? FOR UPDATE');
        $seqStmt->execute([$userId]);
        $seq = (int)$seqStmt->fetchColumn();

        $now = gmdate('Y-m-d\TH:i:s') . '.000Z';
        $select = $pdo->prepare('SELECT store, record_id, data_json FROM period_records WHERE user_id = ? AND deleted = 0');
        $select->execute([$userId]);
        $rows = $select->fetchAll();

        $mark = $pdo->prepare('UPDATE period_records SET data_json = ?, client_updated_at = ?, deleted = 1, change_seq = ?
                               WHERE user_id = ? AND store = ? AND record_id = ?');
        foreach ($rows as $row) {
            $record = json_decode($row['data_json'], true);
            if (!is_array($record)) {
                $record = ['id' => $row['record_id']];
            }
            $record['deleted'] = true;
            $record['updated_at'] = $now;
            $seq++;
            $mark->execute([json_encode($record), $now, $seq, $userId, $row['store'], $row['record_id']]);
        }

        $update = $pdo->prepare('UPDATE period_sync_state SET last_seq = ? WHERE user_id = ?');
        $update->execute([$seq, $userId]);
        $pdo->commit();
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('period reset failed: ' . $e->getMessage());
        periodFail(500, 'Could not reset the server copy.');
    }
    echo json_encode(['success' => true, 'lastSeq' => $seq, 'serverTime' => $now]);
    exit;
}

// 6. Delete data: removes the user's server copy and turns backup off for the profile
if ($action === 'delete_data' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        $pdo->beginTransaction();
        $pdo->prepare('DELETE FROM period_records WHERE user_id = ?')->execute([$userId]);
        $pdo->prepare('DELETE FROM period_sync_state WHERE user_id = ?')->execute([$userId]);
        $pdo->commit();
    } catch (PDOException $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('period delete failed: ' . $e->getMessage());
        periodFail(500, 'Could not delete the server copy.');
    }
    echo json_encode(['success' => true]);
    exit;
}

periodFail(400, 'Invalid action request.');
