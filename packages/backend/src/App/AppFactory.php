<?php

declare(strict_types=1);

namespace RsiCompanion\App;

use Psr\Container\ContainerInterface;
use Slim\App;
use Slim\Factory\AppFactory as SlimAppFactory;

final class AppFactory
{
    public static function create(ContainerInterface $container): App
    {
        SlimAppFactory::setContainer($container);
        $app = SlimAppFactory::create();

        $settings = $container->get('settings');
        $app->addRoutingMiddleware();
        $app->addBodyParsingMiddleware();
        $app->addErrorMiddleware(
            (bool) $settings['displayErrorDetails'],
            (bool) $settings['logErrors'],
            (bool) $settings['logErrorDetails'],
        );

        (require __DIR__ . '/../../config/routes.php')($app);

        return $app;
    }
}
