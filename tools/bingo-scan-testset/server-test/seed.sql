-- Test accounts for the training endpoint tests: an admin, a regular user, and an admin profile without a password
-- (which must not get admin access). Run after the first request has created the tables.
INSERT IGNORE INTO suite_users (id, username, password_hash) VALUES
  (1, 'admin_t',      '$2y$10$abcdefghijklmnopqrstuv'),
  (2, 'plain_t',      '$2y$10$abcdefghijklmnopqrstuv'),
  (3, 'nopass_admin', NULL);
INSERT IGNORE INTO suite_user_groups (user_id, group_id) VALUES (1, 3), (3, 3);   -- group 3 = admin
DELETE FROM suite_sessions;
INSERT INTO suite_sessions (user_id, token_hash, expires_at) VALUES
  (1, SHA2('admintoken0123456789abcdef0123456789abcdef', 256),  DATE_ADD(NOW(), INTERVAL 30 DAY)),
  (2, SHA2('plaintoken0123456789abcdef0123456789abcdef', 256),  DATE_ADD(NOW(), INTERVAL 30 DAY)),
  (3, SHA2('nopasstoken0123456789abcdef0123456789abcdef', 256), DATE_ADD(NOW(), INTERVAL 30 DAY));
