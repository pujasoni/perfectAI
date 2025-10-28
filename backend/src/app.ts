import express, { Request, Response, NextFunction } from "express";
import { connectDB } from "./config/database";
import { validateEnvironment } from "./config/envValidator";
import { config } from "./config/environments";
import { createIndexes } from "./config/databaseIndexes";
import sessionCleanupService from "./services/sessionCleanupService";
import User from "./models/user";
import cookieParser from 'cookie-parser';
import cors from "cors";
import session from 'express-session';
import passport from './config/oauth';
import { userAuth } from "./middlewares/authmiddleware";
import { apiLimiter } from "./middlewares/rateLimiting";
import { requestLogger, errorLogger, performanceLogger } from "./middlewares/logging";
import { globalErrorHandler, notFoundHandler, validationErrorHandler, rateLimitErrorHandler } from "./middlewares/errorHandler";
import { swaggerUiHandler, swaggerJson, apiHealthCheck, swaggerServe, swaggerDocs } from "./middlewares/swagger";
import { createFileValidator, createMulterConfig, handleMulterError } from "./middlewares/fileValidation";
import authRouter from "./routes/auth";
import profileRouter from "./routes/profile";
import userRouter from "./routes/user";
import testGenerationRouter from "./routes/testGeneration";
import multer from "multer";
import path from "path";
import { 
  UploadedFile, 
  FileCacheData, 
  UploadResponse, 
  CacheStatsResponse,
  AuthenticatedRequest 
} from "./types";
import openaiService from "./services/openaiService";
import { fileContentCache } from "./controllers/testGenerationController";

// Validate environment variables before starting the app
validateEnvironment();

const app: express.Application = express();

// Trust proxy for rate limiting and IP detection
app.set('trust proxy', 1);

// In-Memory File Storage
const fileCache = new Map<string, FileCacheData>();

// Configure multer with enhanced validation
const upload = createMulterConfig({
  maxSize: config.fileUpload.maxSize,
  maxFiles: config.fileUpload.maxFiles,
  allowedTypes: config.fileUpload.allowedTypes,
});

// CORS configuration
app.use(cors({
    origin: config.cors.origins,
    credentials: config.cors.credentials
}));

// JSON parsing middleware that only parses for POST/PUT/PATCH requests
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    // Skip JSON parsing for GET, DELETE, HEAD, and OPTIONS requests
    next();
  } else if (req.get('Content-Type') && req.get('Content-Type')?.includes('application/json')) {
    express.json()(req, res, next);
  } else {
    next();
  }
});

// Add logging middleware
app.use(requestLogger);
app.use(performanceLogger);

app.use(cookieParser());

// Apply general API rate limiting
app.use(apiLimiter);

// Session configuration
app.use(session({
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: config.session.secure,
        maxAge: config.session.maxAge
    }
}));

// Security headers middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// API Documentation routes (serve static assets correctly)
app.use("/api-docs", (swaggerServe as unknown as any), (swaggerDocs as unknown as any));
app.get("/api-docs.json", swaggerJson);
app.get("/health", apiHealthCheck);

// Routes
app.use("/auth", authRouter);
app.use("/", profileRouter);
app.use("/", userRouter);
app.use("/api/test-generation", testGenerationRouter);

app.get("/feed", userAuth, async (req: any, res: Response): Promise<void> => {
  try {
    const users = await User.find({});
    res.send(users);
  } catch (error) {
    res.status(500).send("Error fetching feed: " + (error as Error).message);
  }
});

// Upload endpoint - Store in memory and extract content
app.post("/upload", upload.array("files", 10), createFileValidator(), handleMulterError, async (req: Request, res: Response): Promise<void> => {
  try {

    if (!req.files || req.files.length === 0) {
      res.status(400).json({ error: "No files uploaded" });
      return;
    }

    // Upload request received - no need to log this

    const fileInfos: UploadedFile[] = [];
    
    // Process files sequentially to extract content
    for (const file of req.files as Express.Multer.File[]) {
      const ext = path.extname(file.originalname).toLowerCase().slice(1);
      const imageTypes = /jpeg|jpg|png|gif|webp|svg|img/;
      const isImage = imageTypes.test(ext);

      // Generate unique filename
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
      const filename = "file-" + uniqueSuffix + path.extname(file.originalname);

      // Store file in memory cache
      fileCache.set(filename, {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalName: file.originalname,
        size: file.size,
        type: isImage ? 'image' : 'file',
        uploadedAt: new Date().toISOString()
      });


      // Extract content for test generation (both text files and images)
      let extractedContent = '';
      try {
        extractedContent = await openaiService.extractTextFromFile(
          file.buffer, 
          file.originalname, 
          file.mimetype
        );
        
        // Store extracted content in fileContentCache for test generation
        const fileId = filename.split('.')[0];
        if (fileId) {
          fileContentCache.set(fileId, extractedContent);
        }
      } catch (contentError) {
        console.warn(`⚠️ Failed to extract content from ${file.originalname}:`, contentError);
        extractedContent = `[Content extraction failed for ${file.originalname}]`;
      }

      const fileId = filename.split('.')[0];
      const fileInfo: UploadedFile = {
        id: fileId || filename,
        filename: filename,
        originalName: file.originalname,
        size: file.size,
        type: isImage ? 'image' : 'file',
        mimetype: file.mimetype,
        url: `/file/${filename}`,
        uploadedAt: new Date().toISOString(),
        extractedContent: extractedContent // Add extracted content to file info
      };

      fileInfos.push(fileInfo);
    }


    const response: UploadResponse = {
      success: true,
      message: `${req.files.length} file(s) uploaded successfully`,
      files: fileInfos,
      cacheInfo: {
        totalFiles: fileCache.size,
        memoryUsage: process.memoryUsage()
      }
    };

    res.json(response);

  } catch (error) {
    console.error("❌ Upload failed:", (error as Error).message);
    res.status(500).json({ error: "Upload failed: " + (error as Error).message });
  }
});

// Debug endpoint to test OpenAI API
app.get("/debug/test-openai", async (req: Request, res: Response): Promise<void> => {
  try {
    // Testing OpenAI API connection
    const testResult = await openaiService.generateTestCases({
      prompt: "Generate 1 test case for a simple login form",
      fileContent: "",
      fileName: "test",
      fileType: "text",
      count: 1,
      offset: 0
    });
    res.json({
      success: true,
      message: 'OpenAI API test completed',
      result: testResult
    });
  } catch (error) {
    console.error('❌ OpenAI API test failed:', error);
    res.status(500).json({ 
      success: false, 
      error: 'OpenAI API test failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Debug endpoint to check file content cache
app.get("/debug/file-content", (req: Request, res: Response): void => {
  try {
    const cacheKeys = Array.from(fileContentCache.keys());
    const cacheData = Array.from(fileContentCache.entries()).map((entry) => {
      const [key, content] = entry;
      return {
        fileId: key,
        contentLength: content.length,
        contentPreview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
      };
    });
    
    res.json({
      success: true,
      cacheKeys,
      cacheData,
      totalFiles: fileContentCache.size
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get cache data' });
  }
});

// Serve files from memory
app.get("/file/:filename", (req: Request, res: Response): void => {
  try {
    const filename = req.params.filename;
    if (!filename) {
      res.status(400).json({ error: "Filename is required" });
      return;
    }
    const fileData = fileCache.get(filename);

    if (!fileData) {
      res.status(404).json({ error: "File not found in cache" });
      return;
    }

    // Set appropriate headers
    res.set({
      'Content-Type': fileData.mimetype,
      'Content-Length': fileData.size.toString(),
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      'Content-Disposition': `inline; filename="${fileData.originalName}"`
    });

    res.send(fileData.buffer);

  } catch (error) {
    console.error(`❌ Error serving file ${req.params.filename}:`, (error as Error).message);
    res.status(500).json({ error: "Failed to serve file" });
  }
});

// Get all cached files
app.get("/files", (req: Request, res: Response): void => {
  try {
    const files: UploadedFile[] = [];

    fileCache.forEach((fileData, filename) => {
      const fileId = filename.split('.')[0];
      files.push({
        id: fileId || filename,
        filename: filename,
        originalName: fileData.originalName,
        size: fileData.size,
        type: fileData.type,
        mimetype: fileData.mimetype,
        url: `/file/${filename}`,
        uploadedAt: fileData.uploadedAt
      });
    });

    res.json({
      success: true,
      files: files,
      cacheInfo: {
        totalFiles: fileCache.size,
        memoryUsage: process.memoryUsage()
      }
    });

  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve files: " + (error as Error).message });
  }
});

// Delete file from memory
app.delete("/delete/:filename", (req: Request, res: Response): void => {
  try {
    const filename = req.params.filename;
    if (!filename) {
      res.status(400).json({ error: "Filename is required" });
      return;
    }

    if (fileCache.has(filename)) {
      fileCache.delete(filename);
      res.json({
        success: true,
        message: "File deleted successfully",
        cacheInfo: {
          totalFiles: fileCache.size
        }
      });
    } else {
      res.status(404).json({
        success: false,
        error: "File not found in cache"
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to delete file: " + (error as Error).message
    });
  }
});

// Clear all cache
app.delete("/clear-cache", (req: Request, res: Response): void => {
  try {
    const fileCount = fileCache.size;
    fileCache.clear();

    res.json({
      success: true,
      message: `Cache cleared successfully. ${fileCount} files removed.`,
      cacheInfo: {
        totalFiles: fileCache.size,
        memoryUsage: process.memoryUsage()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Failed to clear cache: " + (error as Error).message
    });
  }
});

// Cache statistics
app.get("/cache-stats", (req: Request, res: Response): void => {
  try {
    let totalSize = 0;
    const fileTypes: Record<string, number> = {};

    fileCache.forEach((fileData, filename) => {
      totalSize += fileData.size;
      const type = fileData.type;
      fileTypes[type] = (fileTypes[type] || 0) + 1;
    });

    const response: CacheStatsResponse = {
      success: true,
      stats: {
        totalFiles: fileCache.size,
        totalSizeBytes: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        fileTypes: fileTypes,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
      }
    };

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: "Failed to get cache stats" });
  }
});

// Health check with cache info
app.get("/health", (req: Request, res: Response): void => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    cacheInfo: {
      totalFiles: fileCache.size,
      memoryUsage: process.memoryUsage()
    }
  });
});

// Error handling middleware (must be last)
app.use(validationErrorHandler);
app.use(rateLimitErrorHandler);
app.use(errorLogger);
app.use(globalErrorHandler);
app.use(notFoundHandler);

// Global error handlers
process.on('uncaughtException', (error: Error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

connectDB()
  .then(async () => {
    console.log("Database connected successfully");
    
    // Create database indexes silently
    try {
      await createIndexes();
    } catch (error) {
      console.warn("⚠️ Failed to create database indexes:", error);
    }
    
    // Start session cleanup cron job
    sessionCleanupService.startCronJob();
    
    app.listen(config.port, () => {
      console.log(`🚀 Server is running on port ${config.port}`);
      console.log(`📚 API Documentation: http://localhost:${config.port}/api-docs`);
      console.log(`🏥 Health Check: http://localhost:${config.port}/health`);
      console.log("🧹 Session cleanup service started");
    });
  })
  .catch((error) => {
    console.error("Database connection failed:", error);
    process.exit(1);
  });

export default app;
