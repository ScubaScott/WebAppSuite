<?php
// Bingo Cards Endpoint (Legacy Proxy)
// Delegates all operations to the unified SQL-backed Bingo API handler.

// API endpoint version identifier
$version = '1.1';

$_GET['endpoint'] = 'cards';
require_once dirname(__DIR__, 2) . '/api/bingo.php';
