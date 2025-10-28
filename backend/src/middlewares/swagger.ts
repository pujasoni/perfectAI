import { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../config/swagger';
import { config } from '../config/environments';

// Swagger UI options
const swaggerUiOptions: swaggerUi.SwaggerUiOptions = {
  customCss: `
    .swagger-ui .topbar { display: none }
    .swagger-ui .info .title { color: #10b981 }
    .swagger-ui .scheme-container { background: #1f2937; padding: 20px; border-radius: 8px }
  `,
  customSiteTitle: 'PerfectAI API Documentation',
  customfavIcon: '/favicon.ico',
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    showExtensions: true,
    showCommonExtensions: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 2,
    defaultModelExpandDepth: 2,
  },
  customJs: [
    'https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-bundle.js',
    'https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui-standalone-preset.js'
  ],
  customCssUrl: 'https://unpkg.com/swagger-ui-dist@5.9.0/swagger-ui.css',
  swaggerUrl: '/api-docs.json'
};

// Swagger documentation middleware
export const swaggerServe = swaggerUi.serve;
export const swaggerDocs = swaggerUi.setup(swaggerSpec, swaggerUiOptions);

// Swagger JSON endpoint
export const swaggerJson = (req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
};

// Swagger UI endpoint
export const swaggerUiHandler = (req: Request, res: Response, next: NextFunction): void => {
  (swaggerDocs as any)(req, res, next);
};

// Health check endpoint for API documentation
export const apiHealthCheck = (req: Request, res: Response): void => {
  res.json({
    success: true,
    message: 'PerfectAI API is running',
    version: '1.0.0',
    environment: config.nodeEnv,
    timestamp: new Date().toISOString(),
    endpoints: {
      documentation: '/api-docs',
      health: '/health',
      auth: '/auth',
      testGeneration: '/api/test-generation',
      files: '/files',
    },
  });
};
