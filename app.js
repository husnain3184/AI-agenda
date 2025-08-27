const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Default database configuration (fallback)
let dbConfig = {
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'test_db'
};

// Configure multer for file uploads (⚠ Vercel note: files won’t persist, use S3/Cloudinary for production)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Create uploads directory if it doesn't exist (local only, won’t persist on Vercel)
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Database configuration endpoint
app.post('/api/db-config', (req, res) => {
    try {
        const { host, user, password, database } = req.body;
        
        if (!host || !user || !database) {
            return res.status(400).json({ 
                success: false, 
                error: 'Host, user, and database name are required' 
            });
        }

        dbConfig = {
            host: host.trim(),
            user: user.trim(),
            password: password ? password.trim() : '',
            database: database.trim()
        };

        console.log('Database configuration updated:', {
            host: dbConfig.host,
            user: dbConfig.user,
            database: dbConfig.database
        });

        res.json({ 
            success: true, 
            message: 'Database configuration updated successfully' 
        });

    } catch (error) {
        console.error('Database config error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to update database configuration' 
        });
    }
});

// Test database connection endpoint
app.post('/api/test-db-connection', async (req, res) => {
    try {
        const { host, user, password, database } = req.body;
        
        const testConfig = {
            host: host || dbConfig.host,
            user: user || dbConfig.user,
            password: password || dbConfig.password,
            database: database || dbConfig.database
        };

        const connection = await mysql.createConnection(testConfig);
        await connection.end();

        res.json({ 
            success: true, 
            message: 'Database connection successful' 
        });

    } catch (error) {
        console.error('Database connection test failed:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Database connection failed',
            details: error.message 
        });
    }
});

// Get current database configuration
app.get('/api/db-config', (req, res) => {
    res.json({
        success: true,
        config: {
            host: dbConfig.host,
            user: dbConfig.user,
            database: dbConfig.database
        }
    });
});

// Agenda type detection function
function detectAgendaType(heading) {
    if (!heading) return 'speaker';
    const headingLower = heading.toLowerCase();
    if (/^day\s\d+:\s[a-z]+,\s[a-z]+\s\d+,\s\d{4}$/i.test(heading)) return 'day';
    if (headingLower.includes('registration') || headingLower.includes('refreshments')) return 'registration';
    if (headingLower.includes('coffee break') || headingLower.includes('networking lunch') ||
        headingLower.includes('reception') || (headingLower.includes('lunch') && headingLower.includes('break'))) return 'coffeelunch';
    if (headingLower.includes('panel discussion')) return 'speaker';
    if (headingLower.includes('q&a') || headingLower.includes('q and a')) return 'open/close';
    if (headingLower.includes('reserved')) return 'open/close';
    if (headingLower.includes('opening address') || headingLower.includes('closing address')) return 'open/close';
    if (headingLower.includes('speed networking')) return 'session';
    if (headingLower.includes('feedback') || headingLower.includes('raffle')) return 'open/close';
    return 'speaker';
}

// File upload and processing endpoint
app.post('/upload', upload.single('excelFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        const filePath = path.join(__dirname, req.file.path);
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });
        const connection = await mysql.createConnection(dbConfig);

        // TODO: Add your logic to insert data into MySQL
        await connection.end();

        res.json({
            success: true,
            message: 'File processed successfully',
            rows: rawData.length
        });

    } catch (error) {
        console.error('Import error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to process file',
            details: error.message
        });
    }
});

module.exports = app;
