CREATE TABLE IF NOT EXISTS pluxee_shared_state (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
    payload LONGTEXT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO pluxee_shared_state (id, revision, payload)
VALUES (1, 0, NULL);

CREATE TABLE IF NOT EXISTS meu_pluxee_sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    csrf_token CHAR(43) NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meu_pluxee_login_attempts (
    key_hash CHAR(64) NOT NULL PRIMARY KEY,
    started_at DATETIME NOT NULL,
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS meu_pluxee_fcm_tokens (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    registration_token TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
