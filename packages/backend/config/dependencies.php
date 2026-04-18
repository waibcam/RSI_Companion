<?php

declare(strict_types=1);

use DI\ContainerBuilder;
use Monolog\Handler\StreamHandler;
use Monolog\Logger;
use Psr\Container\ContainerInterface;
use Psr\Log\LoggerInterface;

return function (ContainerBuilder $containerBuilder): void {
    $settings = require __DIR__ . '/settings.php';

    $containerBuilder->addDefinitions([
        'settings' => $settings['settings'],

        LoggerInterface::class => function (ContainerInterface $c): LoggerInterface {
            $settings = $c->get('settings')['logger'];
            $logger = new Logger($settings['name']);
            $handler = new StreamHandler($settings['path'], Logger::toMonologLevel($settings['level']));
            $logger->pushHandler($handler);
            return $logger;
        },

        PDO::class => function (ContainerInterface $c): PDO {
            $settings = $c->get('settings')['db'];
            $pdo = new PDO($settings['dsn']);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            $pdo->exec('PRAGMA journal_mode=WAL');
            $pdo->exec('PRAGMA foreign_keys=ON');
            return $pdo;
        },
    ]);
};
