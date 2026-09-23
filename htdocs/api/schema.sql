-- WebAppSuite User Profiles & Cloud Sync Database Schema
-- Compatible with MySQL 5.7+ and MariaDB 10.x (Standard InfinityFree phpMyAdmin)

-- Ensure utf8mb4 encoding for full unicode and emoji support
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Users table: stores user profiles with optional password hash
CREATE TABLE IF NOT EXISTS `suite_users` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `username` VARCHAR(64) NOT NULL UNIQUE,
    `password_hash` VARCHAR(255) DEFAULT NULL, -- NULL indicates an open/unprotected profile
    `auth_token` VARCHAR(64) DEFAULT NULL,     -- Session token for sync authentication
    `token_expires` DATETIME DEFAULT NULL,
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `last_login` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_username` (`username`),
    INDEX `idx_auth_token` (`auth_token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. User App Data table: stores key-value JSON configurations per app per user
CREATE TABLE IF NOT EXISTS `suite_user_data` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT UNSIGNED NOT NULL,
    `app_id` VARCHAR(32) NOT NULL,              -- e.g. 'scoreboard', 'bingo', 'bagscore', 'driverscore'
    `data_json` LONGTEXT NOT NULL,              -- Serialized JSON containing user settings & history
    `version` INT UNSIGNED DEFAULT 1,           -- Incremental revision counter for sync resolution
    `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uq_user_app` (`user_id`, `app_id`),
    INDEX `idx_user_app` (`user_id`, `app_id`),
    CONSTRAINT `fk_suite_user_data_user` 
        FOREIGN KEY (`user_id`) 
        REFERENCES `suite_users` (`id`) 
        ON DELETE CASCADE 
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
