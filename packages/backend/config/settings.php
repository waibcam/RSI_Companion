<?php

declare(strict_types=1);

return [
    'settings' => [
        'displayErrorDetails' => (getenv('APP_ENV') ?: 'production') !== 'production',
        'logErrors' => true,
        'logErrorDetails' => true,
        'logger' => [
            'name' => 'rsi-companion',
            'path' => __DIR__ . '/../logs/app.log',
            'level' => getenv('LOG_LEVEL') ?: 'info',
        ],
        'db' => [
            'dsn' => 'sqlite:' . (getenv('DB_PATH') ?: __DIR__ . '/../data/app.sqlite'),
        ],
        'cors' => [
            'allowed_origins' => array_filter(
                explode(',', getenv('CORS_ALLOWED_ORIGINS') ?: '')
            ),
            'extension_origin_pattern' => '/^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i',
        ],
        'rate_limit' => [
            'requests_per_minute' => (int) (getenv('RATE_LIMIT_RPM') ?: 60),
        ],
    ],
];
