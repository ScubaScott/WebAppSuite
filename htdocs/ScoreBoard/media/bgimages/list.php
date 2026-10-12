<?php
// Scanner endpoint returning JSON list of all background image files in this directory
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, must-revalidate');

$allowedExtensions = ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'];
$images = [];

$files = scandir(__DIR__);
if ($files !== false) {
    foreach ($files as $file) {
        if ($file === '.' || $file === '..') {
            continue;
        }
        $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        if (in_array($ext, $allowedExtensions, true) && is_file(__DIR__ . DIRECTORY_SEPARATOR . $file)) {
            $images[] = $file;
        }
    }
}

// Sort alphabetically for consistent ordering
sort($images, SORT_NATURAL | SORT_FLAG_CASE);

echo json_encode([
    'success' => true,
    'images' => $images
]);
