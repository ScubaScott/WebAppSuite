<?php
// WebAppSuite Database Configuration and Connection Handler
// Manages PDO database connection for MySQL / MariaDB on InfinityFree.

// API configuration version identifier
$API_CONFIG_VERSION = '1.0';

// Database connection parameters. Update these with your InfinityFree MySQL details.
// You can obtain these from your InfinityFree Client Area -> MySQL Databases.
define('DB_HOST', 'localhost');             // e.g., sqlXXX.infinityfree.com or sqlXXX.epizy.com
define('DB_NAME', 'epiz_xxxxxxx_suite');     // Your database name
define('DB_USER', 'epiz_xxxxxxx');           // Your database username
define('DB_PASS', 'your_password_here');     // Your database account password
define('DB_CHARSET', 'utf8mb4');

/**
 * Establishes and returns a shared PDO database connection.
 * Returns null if the database connection cannot be established.
 *
 * @return PDO|null
 */
function getDbConnection() {
    static $pdo = null;

    if ($pdo !== null) {
        return $pdo;
    }

    $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=" . DB_CHARSET;
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, $options);
        return $pdo;
    } catch (PDOException $e) {
        // Log connection error locally without leaking sensitive credentials to client
        error_log("Database connection failed: " . $e->getMessage());
        return null;
    }
}
