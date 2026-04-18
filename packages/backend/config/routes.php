<?php

declare(strict_types=1);

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\App;
use Slim\Routing\RouteCollectorProxy;

return function (App $app): void {
    $app->get('/', function (ServerRequestInterface $_request, ResponseInterface $response) {
        $response->getBody()->write(json_encode([
            'name' => 'rsi-companion-backend',
            'version' => '3.0.0-alpha.0',
        ], JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    });

    $app->group('/api/v1', function (RouteCollectorProxy $group): void {
        $group->get('/health', function (ServerRequestInterface $_request, ResponseInterface $response) {
            $response->getBody()->write(json_encode(['status' => 'ok'], JSON_THROW_ON_ERROR));
            return $response->withHeader('Content-Type', 'application/json');
        });

        // TODO (Phase 1): wire up actual handlers for
        //   GET  /release-notes
        //   GET  /loaners
        //   GET  /ships/name-info
        //   GET  /roadmap/{boardId}
        //   POST /reports
    });
};
