// server.js
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import providers from './providers/index.js';
import logger from './utils/logger.js';
import protectRoute from './middleware/protect.js';
import health from './utils/health.js';
import maintenanceMiddleware from './middleware/maintenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;

// Initialize express
const app = express();

// Apply maintenance middleware first
app.use(maintenanceMiddleware);

// Basic middleware
app.use(express.json({ limit: process.env.MAX_PAYLOAD_SIZE || '10mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.MAX_REQUEST_SIZE || '10mb' }));

// CORS
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*'
}));

// Request logging
if (process.env.ENABLE_LOGGING !== 'false') {
    morgan.token('log-date', () => new Date().toISOString());
    app.use(morgan((tokens, req, res) => {
        const log = {
            method: tokens.method(req, res),
            url: tokens.url(req, res),
            status: tokens.status(req, res),
            responseTime: tokens['response-time'](req, res) + 'ms'
        };
        
        if (req.path !== '/health') { // Don't log health checks
            logger.debug('API Request', log);
        }
        
        return process.env.DEBUG_MODE === 'true' ? 
            `${log.method} ${log.url} ${log.status} ${log.responseTime}` : 
            null;
    }));
}
// Configure rate limiting
const getRateLimiter = () => {
    if (process.env.DISABLE_RATE_LIMIT === 'true') {
        return (req, res, next) => next();
    }

    return rateLimit({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
        max: parseInt(process.env.RATE_LIMIT_REQUESTS) || 60,
        standardHeaders: true,
        legacyHeaders: false,
        
        // Get correct IP when behind proxy
        keyGenerator: (req) => {
            let clientIP;
            
            // Use X-Forwarded-For when TRUST_PROXY is true
            if (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']) {
                clientIP = req.headers['x-forwarded-for'].split(',')[0].trim();
            } else {
                clientIP = req.ip;
            }
            
            logger.debug('Rate limit key generated', {
                ip: clientIP,
                path: req.path,
                proxy: Boolean(req.headers['x-forwarded-for'])
            });
            
            return clientIP;
        },
        
        // Skip rate limiting for specific cases
        skip: (req) => {
            // 1. System health checks
            if (req.headers['user-agent']?.includes('SylphHealthCheck')) {
                return true;
            }
            
            // 2. Local requests
            const ip = req.ip;
            if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
                return true;
            }
            
            // 3. Model listing endpoint
            if (req.path === '/v1/models') {
                return true;
            }
            
            return false;
        },
        
        // Handler for when rate limit is hit
        handler: (req, res) => {
            logger.warn('Rate limit exceeded', {
                ip: req.ip,
                path: req.path,
                proxy_ip: req.headers['x-forwarded-for']
            });
            
            res.status(429).json({
                error: {
                    message: 'Too many requests, please try again later',
                    type: 'rate_limit_error',
                    code: 'rate_limit_exceeded'
                }
            });
        }
    });
};

// Initialize rate limiter
const rateLimiter = getRateLimiter();
if (process.env.DISABLE_RATE_LIMIT !== 'true') {
    logger.info('Rate limiting enabled for chat completions', {
        window: `${(parseInt(process.env.RATE_LIMIT_WINDOW) || 60000) / 1000}s`,
        max: parseInt(process.env.RATE_LIMIT_REQUESTS) || 60,
        proxy_support: process.env.TRUST_PROXY === 'true'
    });
}

// Config endpoint
app.get('/v1/config', (req, res) => {
    const publicConfig = {
        require_api_key: process.env.REQUIRE_API_KEY === 'true',
        rate_limiting: {
            enabled: process.env.DISABLE_RATE_LIMIT !== 'true',
            requests: parseInt(process.env.RATE_LIMIT_REQUESTS) || 60,
            window_ms: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000
        },
        features: {
            health_checks: process.env.ENABLE_HEALTH_CHECKS !== 'false',
            logging: process.env.ENABLE_LOGGING !== 'false'
        },
        limits: {
            max_tokens: process.env.MAX_TOKENS || 'infinite',
            max_request_size: process.env.MAX_REQUEST_SIZE || '10mb',
            max_concurrent: parseInt(process.env.MAX_CONCURRENT) || 50,
            request_timeout: parseInt(process.env.REQUEST_TIMEOUT) || 120000
        },
        defaults: {
            model: process.env.DEFAULT_MODEL || false,
            temperature: parseFloat(process.env.DEFAULT_TEMPERATURE) || 0.7
        },
        providers: providers.getProviderStatus()
    };
    res.json(publicConfig);
});

// Routes
app.get('/v1', (req, res) => {
    res.redirect('/docs');
});

app.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/docs.html'));
});

app.get('/models', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/models.html'));
});

// Static files
app.use(express.static('public', {
    extensions: ['html']
}));

// API routes
app.get('/v1/models', async (req, res) => {
    try {
        const models = await providers.getAvailableModels();
        
        // Add health status to models
        const healthStatus = health.getStatus();
        const healthMap = new Map(healthStatus.map(h => [h.model, h]));

        // Group models by provider and count them
        // Count models per provider using owned_by field
        const providerCounts = new Map();
        models.forEach(model => {
            const provider = model.owned_by || 'Unknown';
            providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
        });
// Sort models by provider's model count (ascending) and then provider name
const sortedModels = [...models].sort((a, b) => {
    const aCount = providerCounts.get(a.owned_by) || 0;
    const bCount = providerCounts.get(b.owned_by) || 0;
    
    // First sort by model count (ascending)
    if (aCount !== bCount) {
        return aCount - bCount;
    }
    
    // Then sort alphabetically by provider name for equal counts
    const aProvider = a.owned_by || 'Unknown';
    const bProvider = b.owned_by || 'Unknown';
    return aProvider.localeCompare(bProvider);
});


        const modelsWithHealth = sortedModels.map(model => {
            const healthData = healthMap.get(model.id) || {
                status: 'unknown',
                latency: null,
                lastCheck: null
            };
            return {
                ...model,
                health: {
                    status: healthData.status,
                    latency: healthData.latency,
                    lastCheck: healthData.lastCheck
                }
            };
        });

        res.json({
            object: 'list',
            data: modelsWithHealth
        });
    } catch (error) {
        logger.error('Error getting models:', error);
        res.status(500).json({
            error: {
                message: error.message,
                type: 'server_error'
            }
        });
    }
});

app.post('/v1/chat/completions', protectRoute, rateLimiter, async (req, res) => {
    try {
        const { model, messages, stream, ...options } = req.body;

        if (!model) {
            return res.status(400).json({
                error: {
                    message: 'model is required',
                    type: 'invalid_request_error',
                    param: 'model',
                    code: 'model_required' 
                }
            });
        }

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'messages must be a non-empty array',
                    type: 'invalid_request_error',
                    param: 'messages',
                    code: 'invalid_messages'
                }
            });
        }

        const requestStartTime = Date.now();
        const response = await providers.chat(model, messages, { stream, ...options });
        const latency = Date.now() - requestStartTime;

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            for await (const chunk of response) {
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json(response);
        }

    } catch (error) {
        logger.error('Chat error:', error);
        
        const status = error.status || 500;
        const errorResponse = {
            error: {
                message: error.message,
                type: error.type || 'server_error',
                param: error.param,
                code: error.code
            }
        };

        res.status(status).json(errorResponse);
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const providerStatus = providers.getProviderStatus();
    const modelHealthStatus = health.getStatus();
    
    res.json({ 
        status: 'ok',
        providers: providerStatus,
        models: modelHealthStatus
    });
});

// 404 handler
app.use((req, res, next) => {
    // Only handle HTML requests with 404, let API requests go to error handler
    if (req.accepts('html')) {
        res.status(404).sendFile(path.join(__dirname, '../public/404.html'));
    } else {
        next();
    }
});

// Error handler
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        error: {
            message: 'Internal server error',
            type: 'server_error'
        }
    });
});

// Start server
async function startServer() {
    try {
        logger.startup('Server');

        // Start HTTP server
        const server = app.listen(port, () => {
            logger.info(`Server running on port ${port}`);
        });

        // Check maintenance mode
        if (process.env.MAINTENANCE_MODE === 'true') {
            logger.warn('Server started in maintenance mode', {
                message: process.env.MAINTENANCE_MESSAGE || 'Service is temporarily under maintenance.'
            });
            return;
        }

        // Initialize providers
        const status = providers.getProviderStatus();
        logger.debug(`Providers initialized`, {
            available: status.available,
            total: status.available.length
        });

        if (status.errors && Object.keys(status.errors).length > 0) {
            logger.warn('Provider initialization errors:', status.errors);
        }

        // Start health checks
        if (process.env.ENABLE_HEALTH_CHECKS !== 'false') {
            const interval = parseInt(process.env.HEALTH_CHECK_INTERVAL) * 1000 || 7200000;
            
            health.startHealthChecks((model, result) => {
                const status = result.status === 'operational' ? 'healthy' : 'unhealthy';
                logger.debug(`[Health] Model ${model} ${status}:`, {
                    latency: result.latency,
                    error: result.error,
                    attempts: result.attempts,
                    response: result.response?.slice(0, 100) + (result.response?.length > 100 ? '...' : '') || 'null'
                });
            }, interval);

            logger.debug('Health checks initialized', {
                interval: `${interval/1000}s`,
                delay: `${parseInt(process.env.HEALTH_CHECK_DELAY) || 2600}ms`
            });
        }

        // Cleanup function
        function cleanup() {
            logger.debug('Shutting down...');
            health.stopHealthChecks();
            server.close(() => {
                logger.info('Server closed');
                setTimeout(() => process.exit(0), 100);
            });
        }

        // Handle graceful shutdown
        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);

    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();