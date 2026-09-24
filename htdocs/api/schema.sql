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

-- 3. Per-device sessions: stores hashed auth tokens and sliding expirations
CREATE TABLE IF NOT EXISTS `suite_sessions` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `user_id` INT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL UNIQUE,      -- sha256 of client session token
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    `last_used_at` DATETIME DEFAULT NULL,
    `expires_at` DATETIME NOT NULL,             -- default 90 days, sliding
    INDEX `idx_sessions_user` (`user_id`),
    CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`)
        REFERENCES `suite_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Suite Games table: stores match records, snapshots, and denormalized scores
CREATE TABLE IF NOT EXISTS `suite_games` (
    `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    `game_id` CHAR(36) NOT NULL UNIQUE,         -- client-generated UUIDv4
    `app_id` VARCHAR(32) NOT NULL DEFAULT 'scoreboard',
    `owner_id` INT UNSIGNED NULL,               -- NULL = guest game
    `write_token_hash` CHAR(64) NOT NULL,       -- sha256 of client-generated per-game secret
    `visibility` ENUM('public','private') NOT NULL DEFAULT 'public',
    `status` ENUM('live','final') NOT NULL DEFAULT 'live',
    `ended_by` ENUM('user','new_game','timeout') NULL,
    `rev` INT UNSIGNED NOT NULL DEFAULT 0,
    -- Denormalized columns for fast list views
    `home_name` VARCHAR(60) NOT NULL DEFAULT 'Home',
    `away_name` VARCHAR(60) NOT NULL DEFAULT 'Away',
    `home_score` INT NOT NULL DEFAULT 0,
    `away_score` INT NOT NULL DEFAULT 0,
    `current_period` TINYINT UNSIGNED NOT NULL DEFAULT 1,
    `timer_running` TINYINT(1) NOT NULL DEFAULT 0,
    `is_paused` TINYINT(1) NOT NULL DEFAULT 0,
    `elapsed_ms` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    -- Full snapshot: configuration, colors, time limit, score history log
    `state_json` LONGTEXT NOT NULL,
    `started_at` DATETIME NOT NULL,
    `ended_at` DATETIME NULL,
    `last_activity_at` DATETIME NOT NULL,
    `expires_at` DATETIME NULL,                 -- set for guest games only; NULL = keep until deleted
    `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_games_owner` (`owner_id`, `started_at`),
    INDEX `idx_games_public` (`visibility`, `status`, `last_activity_at`),
    INDEX `idx_games_expires` (`expires_at`),
    CONSTRAINT `fk_games_owner` FOREIGN KEY (`owner_id`)
        REFERENCES `suite_users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
