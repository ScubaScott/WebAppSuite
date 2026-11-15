<?php
// Router for PHP's built-in server: does what the .htaccess rewrite rules do on the real host.
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api/(health|cards|favorites|games|training)(?:/([^/]+))?/?$#', $uri, $m)) {
    $_GET['endpoint'] = $m[1];
    if (isset($m[2])) { $_GET['id'] = $m[2]; }
    require __DIR__ . '/www/api/bingo.php';
    return true;
}
return false;   // everything else is a static file
