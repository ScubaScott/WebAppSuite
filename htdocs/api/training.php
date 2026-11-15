<?php
// Bingo scan training-sample endpoint (/api/training), called from bingo.php.
// Phones upload one sample per confirmed card scan; an admin downloads, reviews and purges them for model training.
// See htdocs/Bingo/bingo-scan-redesign-spec.md, section 9.

// Training endpoint version identifier
$TRAINING_API_VERSION = '1.0';

// Limits (override any of these in config.php before this file is loaded)
if (!defined('TRAINING_MAX_BODY_BYTES'))  define('TRAINING_MAX_BODY_BYTES', 450 * 1024);          // whole request body
if (!defined('TRAINING_MAX_SHEET_BYTES')) define('TRAINING_MAX_SHEET_BYTES', 100 * 1024);         // decoded sheet JPEG
if (!defined('TRAINING_MAX_PHOTO_BYTES')) define('TRAINING_MAX_PHOTO_BYTES', 300 * 1024);         // decoded photo JPEG
if (!defined('TRAINING_MAX_META_BYTES'))  define('TRAINING_MAX_META_BYTES', 24 * 1024);           // meta JSON
if (!defined('TRAINING_RATE_PER_HOUR'))   define('TRAINING_RATE_PER_HOUR', 30);                   // samples per client per hour
if (!defined('TRAINING_MAX_STORE_BYTES')) define('TRAINING_MAX_STORE_BYTES', 150 * 1024 * 1024);  // all stored images together
if (!defined('TRAINING_LIST_MAX'))        define('TRAINING_LIST_MAX', 25);                        // rows per admin list page
if (!defined('TRAINING_PURGE_MAX'))       define('TRAINING_PURGE_MAX', 500);                      // ids per purge call
if (!defined('TRAINING_IP_SALT')) {
    // Salt for hashing client addresses (used only for the rate limit); derived from the database password by default
    define('TRAINING_IP_SALT', hash('sha256', 'bingo-training|' . (defined('DB_PASS') ? DB_PASS : '')));
}

// Sheet geometry the client sends: 5x5 crops of 72x80 pixels
const TRAINING_SHEET_WIDTH = 360;
const TRAINING_SHEET_HEIGHT = 400;
// Card profiles a sample may name
const TRAINING_PROFILES = ['slider', 'manual', 'shutter-wood', 'paper-grid', 'paper-plain'];
const TRAINING_STATUSES = ['new', 'imported', 'rejected'];
// Standard 75-ball column ranges
const TRAINING_COLUMN_RANGES = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];

/**
 * Creates the training table when it does not exist yet (same definition as in schema.sql).
 *
 * @param PDO $pdo Active database connection
 */
function trainingEnsureTable($pdo) {
    $pdo->exec("CREATE TABLE IF NOT EXISTS `bingo_scan_samples` (
        `id`          VARCHAR(36)  NOT NULL,
        `schema_ver`  TINYINT      NOT NULL,
        `created_at`  DATETIME     NOT NULL,
        `received_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `app_version` VARCHAR(10)  NOT NULL,
        `profile`     VARCHAR(20)  NOT NULL,
        `reader`      VARCHAR(40)  NOT NULL,
        `device`      VARCHAR(100) NOT NULL DEFAULT '',
        `uploaded_by` VARCHAR(100) DEFAULT NULL,
        `ip_hash`     CHAR(64)     NOT NULL,
        `cells`       JSON         NOT NULL,
        `meta`        JSON         NOT NULL,
        `sheet`       MEDIUMBLOB   NOT NULL,
        `photo`       MEDIUMBLOB   DEFAULT NULL,
        `status`      VARCHAR(10)  NOT NULL DEFAULT 'new',
        PRIMARY KEY (`id`),
        INDEX `idx_scan_samples_received` (`received_at`),
        INDEX `idx_scan_samples_status` (`status`),
        INDEX `idx_scan_samples_ip` (`ip_hash`, `received_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;");
}

/**
 * Sends a JSON error response and stops.
 */
function trainingFail($code, $message, $extra = []) {
    http_response_code($code);
    echo json_encode(array_merge(['error' => $message], $extra));
    exit;
}

/**
 * Reads the request body, refusing anything over TRAINING_MAX_BODY_BYTES.
 *
 * @return array Decoded JSON object (empty array for an empty body)
 */
function trainingReadBody() {
    $declared = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($declared > TRAINING_MAX_BODY_BYTES) {
        trainingFail(413, 'Request body too large');
    }
    // Read one byte past the limit so a missing or false Content-Length cannot slip a large body through
    $raw = file_get_contents('php://input', false, null, 0, TRAINING_MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > TRAINING_MAX_BODY_BYTES) {
        trainingFail(413, 'Request body too large');
    }
    if ($raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        trainingFail(400, 'Body must be a JSON object');
    }
    return $data;
}

/**
 * Requires a signed-in admin; sends 401 or 403 and stops otherwise.
 *
 * @param PDO $pdo Active database connection
 * @param array $body Decoded request body (a token may travel in it)
 * @return array The admin's user record
 */
function trainingRequireAdmin($pdo, $body) {
    $token = getAuthToken($body);
    $user = $token ? authenticateUser($pdo, $token) : null;
    if (!$user) {
        trainingFail(401, 'Authentication required');
    }
    $access = getUserAccess($pdo, $user);
    if (empty($access['isAdmin'])) {
        trainingFail(403, 'Admin access required');
    }
    return $user;
}

/**
 * Decodes and checks a base64 JPEG.
 *
 * @return array [bytes, width, height]; sends 400 and stops when invalid
 */
function trainingDecodeJpeg($value, $field, $maxBytes) {
    if (!is_string($value) || $value === '') {
        trainingFail(400, "$field must be a base64 JPEG");
    }
    // Accept a data URL prefix as well as bare base64
    $value = preg_replace('#^data:image/jpeg;base64,#i', '', $value);
    $bytes = base64_decode($value, true);
    if ($bytes === false || $bytes === '') {
        trainingFail(400, "$field is not valid base64");
    }
    if (strlen($bytes) > $maxBytes) {
        trainingFail(400, "$field is larger than " . (int)($maxBytes / 1024) . ' KB');
    }
    if (substr($bytes, 0, 3) !== "\xFF\xD8\xFF") {
        trainingFail(400, "$field is not a JPEG image");
    }
    $info = @getimagesizefromstring($bytes);
    if (!$info || $info[2] !== IMAGETYPE_JPEG) {
        trainingFail(400, "$field could not be read as a JPEG image");
    }
    return [$bytes, (int)$info[0], (int)$info[1]];
}

/**
 * Validates the 25 cell records and returns the canonical list to store.
 * Rules: index 12 (FREE) has no label; every label is inside its column's range; no label repeats.
 */
function trainingValidateCells($cells) {
    if (!is_array($cells) || count($cells) !== 25 || array_keys($cells) !== range(0, 24)) {
        trainingFail(400, 'cells must be a list of exactly 25 entries');
    }
    $out = [];
    $seen = [];
    foreach ($cells as $i => $c) {
        if (!is_array($c)) {
            trainingFail(400, "cells[$i] must be an object");
        }
        $label = array_key_exists('label', $c) ? $c['label'] : null;
        $predicted = array_key_exists('predicted', $c) ? $c['predicted'] : null;
        if ($i === 12) {
            if ($label !== null) {
                trainingFail(400, 'cells[12] is the FREE space and must have no label');
            }
        } elseif ($label !== null) {
            if (!is_int($label)) {
                trainingFail(400, "cells[$i].label must be a whole number or null");
            }
            list($lo, $hi) = TRAINING_COLUMN_RANGES[$i % 5];
            if ($label < $lo || $label > $hi) {
                trainingFail(400, "cells[$i].label $label is outside its column range $lo-$hi");
            }
            if (isset($seen[$label])) {
                trainingFail(400, "cells[$i].label $label appears more than once");
            }
            $seen[$label] = true;
        }
        if ($predicted !== null && (!is_int($predicted) || $predicted < 1 || $predicted > 75)) {
            trainingFail(400, "cells[$i].predicted must be 1-75 or null");
        }
        $score = array_key_exists('score', $c) ? $c['score'] : null;
        if ($score !== null && (!is_numeric($score) || $score < 0 || $score > 1)) {
            trainingFail(400, "cells[$i].score must be between 0 and 1");
        }
        $out[] = [
            'label' => $label,
            'predicted' => $predicted,
            'score' => $score === null ? null : round((float)$score, 3),
            'corrected' => !empty($c['corrected']),
            'covered' => !empty($c['covered']),
            'glare' => !empty($c['glare'])
        ];
    }
    return $out;
}

/**
 * POST /api/training : stores one sample (anyone may upload). Uploading the same id again is harmless.
 */
function trainingHandleUpload($pdo) {
    $body = trainingReadBody();

    // ---- Validate every field before touching the database ----
    if (($body['schema'] ?? null) !== 1) {
        trainingFail(400, 'Unsupported schema version');
    }
    $id = $body['id'] ?? '';
    if (!is_string($id) || !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id)) {
        trainingFail(400, 'id must be a UUID');
    }
    $createdAt = null;
    try {
        $dt = new DateTime(is_string($body['createdAt'] ?? null) ? $body['createdAt'] : '');
        $dt->setTimezone(new DateTimeZone('UTC'));
        $createdAt = $dt->format('Y-m-d H:i:s');
    } catch (Exception $e) {
        trainingFail(400, 'createdAt must be an ISO 8601 date');
    }
    $appVersion = $body['appVersion'] ?? '';
    if (!is_string($appVersion) || !preg_match('/^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/', $appVersion) || strlen($appVersion) > 10) {
        trainingFail(400, 'appVersion must look like 2.0');
    }
    $profile = $body['profile'] ?? '';
    if (!is_string($profile) || !in_array($profile, TRAINING_PROFILES, true)) {
        trainingFail(400, 'Unknown card profile');
    }
    $reader = $body['reader'] ?? null;
    if (!is_array($reader) || !is_string($reader['id'] ?? null) || !is_string($reader['version'] ?? null)
        || !preg_match('/^[A-Za-z0-9._\/-]{1,20}$/', $reader['id']) || !preg_match('/^[A-Za-z0-9._\/ -]{1,30}$/', $reader['version'])) {
        trainingFail(400, 'reader must be { id, version }');
    }
    $readerText = substr($reader['id'] . '@' . $reader['version'], 0, 40);
    $device = $body['device'] ?? '';
    if (!is_string($device)) {
        trainingFail(400, 'device must be text');
    }
    $device = mb_substr(preg_replace('/[\x00-\x1F\x7F]/u', '', $device), 0, 100);

    $cells = trainingValidateCells($body['cells'] ?? null);

    $meta = $body['meta'] ?? [];
    if (!is_array($meta)) {
        trainingFail(400, 'meta must be an object');
    }
    $metaJson = json_encode($meta);
    if ($metaJson === false || strlen($metaJson) > TRAINING_MAX_META_BYTES) {
        trainingFail(400, 'meta is too large');
    }
    if ($metaJson === '[]') {
        $metaJson = '{}';
    }

    list($sheet, $sheetW, $sheetH) = trainingDecodeJpeg($body['sheet'] ?? null, 'sheet', TRAINING_MAX_SHEET_BYTES);
    if ($sheetW !== TRAINING_SHEET_WIDTH || $sheetH !== TRAINING_SHEET_HEIGHT) {
        trainingFail(400, 'sheet must be ' . TRAINING_SHEET_WIDTH . 'x' . TRAINING_SHEET_HEIGHT . " pixels (got {$sheetW}x{$sheetH})");
    }
    $photo = null;
    if (isset($body['photo']) && $body['photo'] !== null && $body['photo'] !== '') {
        list($photo) = trainingDecodeJpeg($body['photo'], 'photo', TRAINING_MAX_PHOTO_BYTES);
    }

    // ---- Same sample again: nothing to do (lets a phone retry safely) ----
    $exists = $pdo->prepare('SELECT 1 FROM bingo_scan_samples WHERE id = ? LIMIT 1');
    $exists->execute([$id]);
    if ($exists->fetchColumn()) {
        http_response_code(200);
        echo json_encode(['id' => $id, 'stored' => false, 'duplicate' => true]);
        exit;
    }

    // ---- Abuse controls: per-client hourly limit, then the global storage cap ----
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
    $ipHash = hash('sha256', TRAINING_IP_SALT . '|' . $ip);   // the address itself is never stored
    $rate = $pdo->prepare('SELECT COUNT(*) FROM bingo_scan_samples WHERE ip_hash = ? AND received_at > (NOW() - INTERVAL 1 HOUR)');
    $rate->execute([$ipHash]);
    if ((int)$rate->fetchColumn() >= TRAINING_RATE_PER_HOUR) {
        header('Retry-After: 3600');
        trainingFail(429, 'Too many samples from this device. Try again later.');
    }
    $used = (int)$pdo->query('SELECT COALESCE(SUM(LENGTH(sheet) + COALESCE(LENGTH(photo), 0)), 0) FROM bingo_scan_samples')->fetchColumn();
    if ($used + strlen($sheet) + strlen($photo ?? '') > TRAINING_MAX_STORE_BYTES) {
        trainingFail(507, 'Training sample storage is full', ['capBytes' => TRAINING_MAX_STORE_BYTES]);
    }

    // ---- Who sent it (optional): a valid token attaches the username, anything else is a guest ----
    $username = null;
    $token = getAuthToken($body);
    if ($token) {
        $user = authenticateUser($pdo, $token);
        if ($user) {
            $username = $user['username'];
        }
    }

    $stmt = $pdo->prepare('INSERT INTO bingo_scan_samples
        (id, schema_ver, created_at, app_version, profile, reader, device, uploaded_by, ip_hash, cells, meta, sheet, photo, status)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'new\')');
    $stmt->bindValue(1, $id);
    $stmt->bindValue(2, $createdAt);
    $stmt->bindValue(3, $appVersion);
    $stmt->bindValue(4, $profile);
    $stmt->bindValue(5, $readerText);
    $stmt->bindValue(6, $device);
    $stmt->bindValue(7, $username, $username === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
    $stmt->bindValue(8, $ipHash);
    $stmt->bindValue(9, json_encode($cells));
    $stmt->bindValue(10, $metaJson);
    $stmt->bindValue(11, $sheet, PDO::PARAM_LOB);
    $stmt->bindValue(12, $photo, $photo === null ? PDO::PARAM_NULL : PDO::PARAM_LOB);
    $stmt->execute();

    http_response_code(201);
    echo json_encode(['id' => $id, 'stored' => true]);
    exit;
}

/**
 * GET /api/training?stats=1 (admin): sizes and label counts, so gaps in the data are visible.
 */
function trainingHandleStats($pdo) {
    $row = $pdo->query('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(sheet)), 0) AS sheet_bytes, COALESCE(SUM(LENGTH(photo)), 0) AS photo_bytes,
                               SUM(photo IS NOT NULL) AS with_photo, MIN(received_at) AS oldest, MAX(received_at) AS newest
                        FROM bingo_scan_samples')->fetch();
    $byStatus = [];
    foreach ($pdo->query('SELECT status, COUNT(*) AS n FROM bingo_scan_samples GROUP BY status')->fetchAll() as $r) {
        $byStatus[$r['status']] = (int)$r['n'];
    }
    $byProfile = [];
    foreach ($pdo->query('SELECT profile, COUNT(*) AS n FROM bingo_scan_samples GROUP BY profile')->fetchAll() as $r) {
        $byProfile[$r['profile']] = (int)$r['n'];
    }

    // Per-number label counts: the cells column is read in pages so memory stays small
    $perNumber = array_fill(1, 75, 0);
    $labels = 0;
    $corrected = 0;
    $lastId = '';
    do {
        $page = $pdo->prepare('SELECT id, cells FROM bingo_scan_samples WHERE id > ? ORDER BY id LIMIT 500');
        $page->execute([$lastId]);
        $rows = $page->fetchAll();
        foreach ($rows as $r) {
            $lastId = $r['id'];
            foreach (json_decode($r['cells'], true) ?: [] as $cell) {
                if (isset($cell['label']) && is_int($cell['label']) && $cell['label'] >= 1 && $cell['label'] <= 75) {
                    $perNumber[$cell['label']]++;
                    $labels++;
                    if (!empty($cell['corrected'])) {
                        $corrected++;
                    }
                }
            }
        }
    } while (count($rows) === 500);

    $bytes = (int)$row['sheet_bytes'] + (int)$row['photo_bytes'];
    echo json_encode([
        'count' => (int)$row['n'],
        'bytes' => $bytes,
        'sheetBytes' => (int)$row['sheet_bytes'],
        'photoBytes' => (int)$row['photo_bytes'],
        'withPhoto' => (int)$row['with_photo'],
        'capBytes' => TRAINING_MAX_STORE_BYTES,
        'capUsed' => TRAINING_MAX_STORE_BYTES > 0 ? round($bytes / TRAINING_MAX_STORE_BYTES, 4) : null,
        'byStatus' => $byStatus,
        'byProfile' => $byProfile,
        'labels' => $labels,
        'labelsCorrectedByUser' => $corrected,
        'perNumber' => $perNumber,
        'numbersWithNoSample' => array_values(array_keys(array_filter($perNumber, function ($n) { return $n === 0; }))),
        'oldestReceived' => $row['oldest'],
        'newestReceived' => $row['newest']
    ]);
    exit;
}

/**
 * GET /api/training?since=<cursor>&limit=<n>&status=<s> (admin): a page of samples with their images in base64.
 * The cursor is the last row's "received_at|id" from the previous page's `next` field (or an ISO date to start from).
 */
function trainingHandleList($pdo) {
    $limit = isset($_GET['limit']) ? max(1, min(TRAINING_LIST_MAX, (int)$_GET['limit'])) : 10;
    $status = isset($_GET['status']) ? (string)$_GET['status'] : 'new';
    if ($status !== 'all' && !in_array($status, TRAINING_STATUSES, true)) {
        trainingFail(400, 'status must be new, imported, rejected or all');
    }

    $sql = 'SELECT id, schema_ver, created_at, received_at, app_version, profile, reader, device, uploaded_by, cells, meta, sheet, photo, status
            FROM bingo_scan_samples WHERE 1=1';
    $params = [];
    if ($status !== 'all') {
        $sql .= ' AND status = ?';
        $params[] = $status;
    }
    if (!empty($_GET['since'])) {
        $since = (string)$_GET['since'];
        if (strpos($since, '|') !== false) {
            list($at, $afterId) = explode('|', $since, 2);
        } else {
            try {
                $dt = new DateTime($since);
                $dt->setTimezone(new DateTimeZone('UTC'));
                $at = $dt->format('Y-m-d H:i:s');
            } catch (Exception $e) {
                trainingFail(400, 'since must be an ISO date or a cursor from a previous page');
            }
            $afterId = '';
        }
        $sql .= ' AND (received_at > ? OR (received_at = ? AND id > ?))';
        array_push($params, $at, $at, $afterId);
    }
    $sql .= ' ORDER BY received_at, id LIMIT ' . (int)$limit;
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $items = [];
    $next = null;
    foreach ($stmt->fetchAll() as $r) {
        $items[] = [
            'id' => $r['id'],
            'schema' => (int)$r['schema_ver'],
            'createdAt' => $r['created_at'],
            'receivedAt' => $r['received_at'],
            'appVersion' => $r['app_version'],
            'profile' => $r['profile'],
            'reader' => $r['reader'],
            'device' => $r['device'],
            'uploadedBy' => $r['uploaded_by'],
            'cells' => json_decode($r['cells'], true),
            'meta' => json_decode($r['meta'], true),
            'sheet' => base64_encode($r['sheet']),
            'photo' => $r['photo'] === null ? null : base64_encode($r['photo']),
            'status' => $r['status']
        ];
        $next = $r['received_at'] . '|' . $r['id'];
    }
    echo json_encode(['items' => $items, 'next' => count($items) === $limit ? $next : null]);
    exit;
}

/**
 * POST /api/training?purge=1 (admin): deletes samples a finished training run has used.
 * Only rows whose status is 'imported' are deleted; the rest are reported back as skipped.
 */
function trainingHandlePurge($pdo, $body) {
    $ids = $body['ids'] ?? null;
    if (!is_array($ids) || count($ids) === 0 || count($ids) > TRAINING_PURGE_MAX) {
        trainingFail(400, 'ids must be a list of 1-' . TRAINING_PURGE_MAX . ' sample ids');
    }
    $ids = array_values(array_unique(array_filter($ids, 'is_string')));
    $deleted = [];
    $skipped = [];
    $find = $pdo->prepare('SELECT status FROM bingo_scan_samples WHERE id = ?');
    $del = $pdo->prepare("DELETE FROM bingo_scan_samples WHERE id = ? AND status = 'imported'");
    foreach ($ids as $id) {
        $find->execute([$id]);
        $status = $find->fetchColumn();
        if ($status === false) {
            $skipped[] = ['id' => $id, 'reason' => 'not found'];
        } elseif ($status !== 'imported') {
            $skipped[] = ['id' => $id, 'reason' => "status is $status, not imported"];
        } else {
            $del->execute([$id]);
            $deleted[] = $id;
        }
    }
    echo json_encode(['deleted' => $deleted, 'skipped' => $skipped]);
    exit;
}

/**
 * Entry point called by bingo.php for /api/training and /api/training/<id>.
 *
 * @param PDO $pdo Active database connection
 * @param string $resourceId Sample id from the path ('' for the collection)
 */
function trainingHandleRequest($pdo, $resourceId) {
    $method = $_SERVER['REQUEST_METHOD'];

    if ($resourceId === '') {
        if ($method === 'POST') {
            if (!empty($_GET['purge'])) {
                $body = trainingReadBody();
                trainingRequireAdmin($pdo, $body);
                trainingHandlePurge($pdo, $body);
            }
            trainingHandleUpload($pdo);
        }
        if ($method === 'GET') {
            trainingRequireAdmin($pdo, []);
            if (!empty($_GET['stats'])) {
                trainingHandleStats($pdo);
            }
            trainingHandleList($pdo);
        }
        trainingFail(405, 'Method not allowed on /api/training');
    }

    // Single sample: PATCH sets its status, DELETE removes it (admin)
    if ($method === 'PATCH' || $method === 'DELETE') {
        $body = $method === 'PATCH' ? trainingReadBody() : [];
        trainingRequireAdmin($pdo, $body);
        $exists = $pdo->prepare('SELECT 1 FROM bingo_scan_samples WHERE id = ? LIMIT 1');
        $exists->execute([$resourceId]);
        if (!$exists->fetchColumn()) {
            trainingFail(404, 'Sample not found');
        }
        if ($method === 'DELETE') {
            $pdo->prepare('DELETE FROM bingo_scan_samples WHERE id = ?')->execute([$resourceId]);
            http_response_code(204);
            exit;
        }
        $status = $body['status'] ?? '';
        if (!is_string($status) || !in_array($status, TRAINING_STATUSES, true)) {
            trainingFail(400, 'status must be new, imported or rejected');
        }
        $pdo->prepare('UPDATE bingo_scan_samples SET status = ? WHERE id = ?')->execute([$status, $resourceId]);
        echo json_encode(['id' => $resourceId, 'status' => $status]);
        exit;
    }
    trainingFail(405, 'Method not allowed on /api/training/<id>');
}
