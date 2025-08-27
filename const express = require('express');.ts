const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const port = 3001;

// Database configuration
const dbConfig = {
    host: '192.168.14.2',
    user: 'root',
    password: 'MMp9ug6e',
    database: 'clone_db_8_04_2025'
};

// Configure multer for file uploads
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

        // Get raw data as array of arrays
        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });

        const connection = await mysql.createConnection(dbConfig);
        await connection.beginTransaction();

        let importedCount = 0;
        let skippedCount = 0;
        let currentDayId = null;
        let dayNumber = 0;
        const dayMap = {};

        // Default empty JSON arrays
        const DEFAULT_EMPTY_JSON = JSON.stringify([{ pointer: "" }]);
        let sortOrderCounter = 1;

        for (let i = 0; i < rawData.length; i++) {
            const row = rawData[i];

            // Check if this is a day header row
            const dayMatch = row[1] && row[1].toString().match(/^DAY (\d+):/i);
            if (dayMatch) {
                dayNumber = parseInt(dayMatch[1]);
                const dayTitle = row[1];

                try {
                    const [dayResult] = await connection.execute(
                        `INSERT INTO agenda (sort, status, heading, dayid, bullet, \`key\`, createdAt, updatedAt
                    ) VALUES (? ,?, ?, ?, ?, ?, NOW(), NOW())`,
                        [sortOrderCounter, 'day', dayTitle, dayNumber, DEFAULT_EMPTY_JSON, DEFAULT_EMPTY_JSON]
                    );

                    currentDayId = dayNumber;
                    dayMap[dayTitle] = currentDayId;
                    importedCount++;
                } catch (error) {
                    console.error('Error inserting day header:', error);
                    skippedCount++;
                }
                continue;
            }

            // Process session rows
            const timeRange = row[1];
            const sessionTitle = row[2];

            if (!timeRange || !sessionTitle) continue;

            // Parse bullet points and speaker info
            let bulletPoints = [];
            let keyPoints = [];
            let speakers = [];
            let companies = [];

            // Look ahead to next rows for additional information
            for (let j = i + 1; j < rawData.length; j++) {
                const nextRow = rawData[j];

                // Stop if we hit a new time slot
                if (nextRow[1] && nextRow[1].match(/\d{4} - \d{4}/)) break;

                // Bullet points
                if (nextRow[2] && nextRow[2].toString().trim().startsWith('•')) {
                    const bulletText = nextRow[2].toString().trim().substring(1).trim();
                    bulletPoints.push({ pointer: bulletText });
                    continue;
                }

                // Key points - these are in column A (index 0)
                if (nextRow[0] && nextRow[0].toString().trim().match(/^[A-Z\s]+$/)) {
                    keyPoints.push({ pointer: nextRow[0].toString().trim() });
                    continue;
                }

                // Speaker info (check that it's not a company-only line)
                if (nextRow[2] && !nextRow[2].toString().trim().startsWith('•') &&
                    !nextRow[2].toString().trim().match(/^\s*$/)) {

                    const speakerName = nextRow[2].toString().trim();
                    let companyName = null;

                    // If next row after speaker has company name, take it & skip that row
                    if (j + 1 < rawData.length && rawData[j + 1][2] && rawData[j + 1][2].toString().trim() !== '') {
                        companyName = rawData[j + 1][2].toString().trim();
                        j++; // Skip the company row so it doesn't get treated as a speaker later
                    }

                    // Only push if it's a valid speaker name (no commas or full caps company style)
                    if (speakerName && !/^[A-Z\s&.,]+$/.test(speakerName)) {
                        speakers.push(speakerName);
                        companies.push(companyName || null);
                    }
                }
            }


            // Parse time range
            const [startTime, endTime] = timeRange.split(' - ').map(t => {
                if (t && t.length === 4) {
                    return `${t.substring(0, 2)}:${t.substring(2)}`;
                }
                return t;
            });

            try {
                const headingLower = sessionTitle.toLowerCase();
                const status = detectAgendaType(sessionTitle);

                // Determine speaker2 value
                let speaker2Value = 0;
                if (headingLower.includes('panel discussion')) {
                    speaker2Value = 2;
                }

                // Format bullet and key points with default empty array if null
                const bulletJson = bulletPoints.length > 0 ? JSON.stringify(bulletPoints) : DEFAULT_EMPTY_JSON;
                const keyJson = keyPoints.length > 0 ? JSON.stringify(keyPoints) : DEFAULT_EMPTY_JSON;
                console.log(keyJson, "keyJson123");


                const [agendaResult] = await connection.execute(
                    `INSERT INTO agenda (sort, status, start_time, end_time, heading, bullet, \`key\`,speaker, company, speaker2, dayid, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                    [
                        sortOrderCounter++,
                        status,
                        startTime,
                        endTime,
                        sessionTitle.trim(),
                        bulletJson,
                        keyJson,
                        speakers[0] || null,
                        companies[0] || null,
                        speaker2Value,
                        currentDayId
                    ]
                );
                for (let k = 0; k < speakers.length; k++) {
                    if (!speakers[k]) continue;

                    if (sessionTitle.toLowerCase().includes('panel discussion')) {
                        // Panel discussion case → "|" ke pehle speaker, baaki company
                        const parts = speakers[k].split('|').map(p => p.trim());
                        const speakerName = parts[0];
                        const companyName = parts.length > 1 ? parts.slice(1).join(' | ') : companies[k] || null;

                        const companiesImage = companyName
                            ? `images/agenda/${companyName.toLowerCase().replace(/\s+/g, '-')}.png`
                            : null;
                        const speakerImage = `images/agenda/${speakerName
                            .toLowerCase()
                            .replace(/\s+/g, '-')}.png`;

                        await connection.execute(
                            `INSERT INTO agenda_speakers (name, company, speaker_image, company_logo, createdAt, updatedAt, agendaId) VALUES (?, ?, ?, ?, NOW(), NOW(), ?)`,
                            [speakerName, companyName, speakerImage, companiesImage, agendaResult.insertId]
                        );
                    } else {
                        // Non-panel discussion → agar "|" ho to multiple speakers same company ke saath
                        const parts = speakers[k].split('|').map(p => p.trim());
                        const companyName = companies[k] || null;

                        const companiesImage = companyName
                            ? `images/agenda/${companyName.toLowerCase().replace(/\s+/g, '-')}.png`
                            : null;

                        for (const speakerName of parts) {
                            const speakerImage = `images/agenda/${speakerName
                                .toLowerCase()
                                .replace(/\s+/g, '-')}.png`;

                            await connection.execute(
                                `INSERT INTO agenda_speakers (name, company, speaker_image, company_logo, createdAt, updatedAt, agendaId) VALUES (?, ?, ?, ?, NOW(), NOW(), ?)`,
                                [speakerName, companyName, speakerImage, companiesImage, agendaResult.insertId]
                            );
                        }
                    }
                }




                importedCount++;
            } catch (error) {
                console.error('Error inserting session:', error);
                skippedCount++;
            }
        }

        await connection.commit();
        await connection.end();

        res.json({
            success: true,
            message: `Import complete. ${importedCount} items imported (${Object.keys(dayMap).length} days), ${skippedCount} skipped`,
            dayMap: dayMap
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
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});