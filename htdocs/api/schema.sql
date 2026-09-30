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
    `ended_by` ENUM('user','new_game','timeout','abandoned') NULL,
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

-- 4b. Suite Game Tombstones table: stores IDs of permanently deleted games to prevent sync resurrection
CREATE TABLE IF NOT EXISTS `suite_game_tombstones` (
    `game_id` VARCHAR(36) NOT NULL PRIMARY KEY,
    `deleted_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Bingo Cards table: stores shared global card library
CREATE TABLE IF NOT EXISTS `cards` (
    `id`          VARCHAR(36)   NOT NULL,
    `label`       VARCHAR(100)  NOT NULL DEFAULT '',
    `serial`      VARCHAR(50)   NOT NULL DEFAULT '',
    `squares`     LONGTEXT      NOT NULL,
    `created_by`  VARCHAR(100)  DEFAULT NULL,
    `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted_at`  DATETIME      DEFAULT NULL,
    PRIMARY KEY (`id`),
    INDEX `idx_cards_updated` (`updated_at`),
    INDEX `idx_cards_created_by` (`created_by`),
    INDEX `idx_cards_deleted` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Bingo Card Favorites table: per-user favorites
CREATE TABLE IF NOT EXISTS `card_favorites` (
    `user_id`       VARCHAR(100)  NOT NULL,
    `card_id`       VARCHAR(36)   NOT NULL,
    `favorited_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`user_id`, `card_id`),
    INDEX `idx_favorites_user` (`user_id`),
    CONSTRAINT `fk_favorites_card`
        FOREIGN KEY (`card_id`) REFERENCES `cards` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Bingo Games table: game mode definitions
CREATE TABLE IF NOT EXISTS `games` (
    `id`          VARCHAR(36)   NOT NULL,
    `name`        VARCHAR(100)  NOT NULL,
    `builtin`     TINYINT(1)    NOT NULL DEFAULT 0,
    `created_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `deleted_at`  DATETIME      DEFAULT NULL,
    PRIMARY KEY (`id`),
    INDEX `idx_games_builtin` (`builtin`),
    INDEX `idx_games_deleted` (`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. Bingo Game Patterns table: win patterns belonging to a game
CREATE TABLE IF NOT EXISTS `game_patterns` (
    `id`          VARCHAR(36)   NOT NULL,
    `game_id`     VARCHAR(36)   NOT NULL,
    `name`        VARCHAR(100)  NOT NULL,
    `cells`       LONGTEXT      NOT NULL,
    `sort_order`  INT           NOT NULL DEFAULT 0,
    PRIMARY KEY (`id`),
    INDEX `idx_patterns_game` (`game_id`),
    CONSTRAINT `fk_patterns_game`
        FOREIGN KEY (`game_id`) REFERENCES `games` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed built-in Bingo games if table is empty
INSERT IGNORE INTO `games` (`id`, `name`, `builtin`) VALUES
('00000000-0000-4000-8000-000000000001', 'Regular Bingo', 1),
('00000000-0000-4000-8000-000000000002', 'Four Corners', 1),
('00000000-0000-4000-8000-000000000003', 'Blackout', 1),
('00000000-0000-4000-8000-000000000004', 'X Pattern', 1),
('00000000-0000-4000-8000-000000000005', 'T-Shape', 1),
('00000000-0000-4000-8000-000000000006', 'L-Shape', 1);

-- Seed built-in game patterns
INSERT IGNORE INTO `game_patterns` (`id`, `game_id`, `name`, `cells`, `sort_order`) VALUES
('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'Row 1', '[0,1,2,3,4]', 0),
('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Row 2', '[5,6,7,8,9]', 1),
('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'Row 3', '[10,11,12,13,14]', 2),
('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'Row 4', '[15,16,17,18,19]', 3),
('10000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'Row 5', '[20,21,22,23,24]', 4),
('10000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'Col B', '[0,5,10,15,20]', 5),
('10000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'Col I', '[1,6,11,16,21]', 6),
('10000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', 'Col N', '[2,7,12,17,22]', 7),
('10000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', 'Col G', '[3,8,13,18,23]', 8),
('10000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'Col O', '[4,9,14,19,24]', 9),
('10000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Diagonal \\', '[0,6,12,18,24]', 10),
('10000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'Diagonal /', '[4,8,12,16,20]', 11),
('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'Four Corners', '[0,4,20,24]', 0),
('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'Blackout', '[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]', 0),
('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'X Pattern', '[0,4,6,8,12,16,18,20,24]', 0),
('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000005', 'T-Shape', '[0,1,2,3,4,7,12,17,22]', 0),
('60000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000006', 'L-Shape', '[0,5,10,15,20,21,22,23,24]', 0);

SET FOREIGN_KEY_CHECKS = 1;
