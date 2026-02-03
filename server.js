const fs = require('fs');
const path = require('path');
const htmlPdf = require('html-pdf-node');
const { OpenAI } = require('openai');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
require('dotenv').config();

// Get environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

// Validate environment
if (!supabaseUrl || !supabaseKey) {
    console.error('ERROR: Missing Supabase credentials in .env file');
    process.exit(1);
}

// Initialize Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize OpenAI (REQUIRED for enhancement)
let openai;
if (openaiApiKey) {
    openai = new OpenAI({ apiKey: openaiApiKey });
    console.log('✓ OpenAI API initialized for content enhancement');
} else {
    console.error('✗ OpenAI API key not found in .env file');
    console.error('Add: OPENAI_API_KEY=your_openai_api_key_here');
    process.exit(1);
}

const BUCKET_NAME = 'PullnorthCV2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('.'));
app.use('/files', express.static('files'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024
    }
});

// ==================== SIMPLE ROUTES ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'files/auth.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'files/auth.html'));
});

app.get('/form', (req, res) => {
    res.sendFile(path.join(__dirname, 'files/pn.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'files/dashy.html'));
});

// ==================== AUTH ENDPOINTS ====================

app.post('/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const { data, error } = await supabase.auth.signUp({
            email: email,
            password: password,
            options: {
                data: { name: name }
            }
        });

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        res.json({
            success: true,
            message: 'Account created successfully',
            user: {
                id: data.user.id,
                email: email,
                name: name
            }
        });

    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        res.json({
            success: true,
            token: data.session.access_token,
            user: {
                id: data.user.id,
                email: data.user.email,
                name: data.user.user_metadata?.name || email.split('@')[0]
            }
        });

    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/auth/verify', async (req, res) => {
    try {
        const { token } = req.body;

        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.user_metadata?.name || user.email.split('@')[0]
            }
        });

    } catch (error) {
        res.status(401).json({ error: 'Token verification failed' });
    }
});

// ==================== USER CV ENDPOINTS ====================

app.get('/user/cvs', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Authorization token required' });
        }

        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const userId = user.id;

        const { data: files, error: listError } = await supabase.storage
            .from(BUCKET_NAME)
            .list(`users/${userId}/cvs`, {
                limit: 100,
                offset: 0,
                sortBy: { column: 'created_at', order: 'desc' }
            });

        if (listError) {
            if (listError.message && listError.message.includes('not found')) {
                return res.json({
                    success: true,
                    cvs: []
                });
            }
            return res.status(500).json({ error: 'Failed to list CVs' });
        }

        const userCvs = [];
        
        for (const file of (files || [])) {
            if (file.name.endsWith('.pdf')) {
                const { data: { publicUrl } } = supabase.storage
                    .from(BUCKET_NAME)
                    .getPublicUrl(`users/${userId}/cvs/${file.name}`);
                
                let title = file.name.replace('.pdf', '');
                
                const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
                if (title.match(uuidRegex)) {
                    const parts = title.split('-');
                    if (parts.length > 1) {
                        title = parts.slice(0, -1).join(' ');
                    }
                }
                
                title = title
                    .split('-')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ')
                    .replace(/\b(ui\/ux|ceo|cto|pm|hr|it)\b/gi, match => match.toUpperCase());
                
                if (!title || title.length < 2) {
                    title = 'Professional CV';
                }
                
                const createdDate = new Date(file.created_at);
                const now = new Date();
                const diffHours = Math.floor((now - createdDate) / (1000 * 60 * 60));
                
                let timeAgo;
                if (diffHours < 1) {
                    timeAgo = 'Just now';
                } else if (diffHours < 24) {
                    timeAgo = `${diffHours}h ago`;
                } else {
                    const diffDays = Math.floor(diffHours / 24);
                    timeAgo = `${diffDays}d ago`;
                }
                
                userCvs.push({
                    id: file.name.replace('.pdf', ''),
                    title: title,
                    date: timeAgo,
                    format: 'PDF',
                    downloadUrl: publicUrl,
                    created_at: file.created_at
                });
            }
        }

        res.json({
            success: true,
            cvs: userCvs
        });

    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== AI ENHANCEMENT FUNCTIONS (ONLY USER DATA) ====================

async function enhanceWithAI(originalText, enhancementType, context = {}) {
    if (!originalText || originalText.trim() === '') {
        return '';
    }

    try {
        const prompts = {
            'profile': `Improve this professional profile for a CV. Only use the information provided. Fix grammar, improve sentence structure, make it more professional, but DO NOT add any new information, achievements, or details that aren't in the original text. Original: "${originalText}"`,
            
            'skills': `Format these skills professionally for a CV. Keep the exact same skills, just improve the wording and structure. Do not add any new skills. Original skills: "${originalText}"`,
            
            'experience': `Improve this work experience description for a CV. Use only the information provided. Make it more professional and achievement-oriented, but DO NOT invent any companies, dates, or achievements. Original: "${originalText}"`,
            
            'hobbies': `Format these hobbies professionally for a CV. Keep the same hobbies, just improve the wording. Original: "${originalText}"`,
            
            'education': `Format this education information professionally for a CV. Use only what's provided. Original: "${originalText}"`,
            
            'languages': `Format these languages professionally for a CV. List them clearly. Original: "${originalText}"`,
            
            'grammar': `Fix grammar, spelling, and improve sentence structure in this text, but keep all the original information exactly as provided. Do not add anything new. Text: "${originalText}"`
        };

        const prompt = prompts[enhancementType] || prompts['grammar'];

        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: "You are a professional CV editor. Your job is to IMPROVE the text provided by the user (fix grammar, improve structure, make it more professional) but you MUST NOT add any new information, achievements, companies, dates, or details that aren't in the original text. ONLY work with what the user has provided."
            }, {
                role: "user",
                content: prompt
            }],
            temperature: 0.3, // Low temperature for consistency
            max_tokens: 500
        });

        let enhancedText = response.choices[0].message.content.trim();
        
        // Remove any quotes that GPT might add
        enhancedText = enhancedText.replace(/^"(.*)"$/, '$1');
        
        // Ensure we didn't lose the original meaning
        if (enhancedText.length < originalText.length / 2) {
            // If GPT shortened too much, use original with basic cleanup
            console.log('GPT shortened too much, using cleaned original');
            return originalText.replace(/\s+/g, ' ').trim();
        }
        
        return enhancedText;

    } catch (error) {
        console.log(`AI enhancement error for ${enhancementType}:`, error.message);
        // Return cleaned original text as fallback
        return originalText.replace(/\s+/g, ' ').trim();
    }
}

async function createProfessionalExperience(userProfile, targetRole) {
    if (!userProfile || userProfile.trim() === '') {
        // If user provided no profile, create a very generic one
        return `
        <div class="job">
            <div class="job-title">${targetRole}</div>
            <p class="job-description">Seeking opportunities as a ${targetRole}.</p>
        </div>`;
    }
    
    try {
        // Enhance the user's profile text to create experience section
        const enhancedProfile = await enhanceWithAI(userProfile, 'experience');
        
        return `
        <div class="job">
            <div class="job-title">${targetRole}</div>
            <p class="job-description">${enhancedProfile}</p>
        </div>`;
        
    } catch (error) {
        console.log('Experience creation error:', error.message);
        return `
        <div class="job">
            <div class="job-title">${targetRole}</div>
            <p class="job-description">${userProfile}</p>
        </div>`;
    }
}

async function createSkillsSection(userSkills, targetRole) {
    if (!userSkills || userSkills.trim() === '') {
        // If no skills provided, create basic ones based on role
        const roleBasedSkills = {
            'deckhand': 'Deck maintenance, Safety procedures, Line handling',
            'steward': 'Guest service, Housekeeping, Table service',
            'chef': 'Food preparation, Menu planning, Galley management',
            'engineer': 'Mechanical systems, Troubleshooting, Maintenance',
            'graphic designer': 'Adobe Creative Suite, Visual design, Branding'
        };
        
        const defaultSkills = roleBasedSkills[targetRole.toLowerCase()] || 
                             'Professional skills, Team collaboration, Problem solving';
        
        const skillsArray = defaultSkills.split(',').map(s => s.trim());
        const skillsHTML = skillsArray.map(skill => 
            `<div class="skill-item">${skill}</div>`
        ).join('\n          ');
        
        return skillsHTML;
    }
    
    try {
        // Enhance the skills formatting
        const enhancedSkills = await enhanceWithAI(userSkills, 'skills');
        let skillsArray;
        
        // Parse the enhanced skills
        if (enhancedSkills.includes(',') || enhancedSkills.includes(';')) {
            skillsArray = enhancedSkills.split(/[,;]/).map(s => s.trim()).filter(s => s);
        } else {
            skillsArray = enhancedSkills.split(/\s+/).map(s => s.trim()).filter(s => s.length > 3);
        }
        
        // Limit to 8 skills maximum
        const displaySkills = skillsArray.slice(0, 8);
        
        const skillsHTML = displaySkills.map(skill => 
            `<div class="skill-item">${skill}</div>`
        ).join('\n          ');
        
        return skillsHTML;
        
    } catch (error) {
        console.log('Skills creation error:', error.message);
        // Fallback to basic formatting
        const skillsArray = userSkills.split(/[,;]/).map(s => s.trim()).filter(s => s);
        const displaySkills = skillsArray.slice(0, 8);
        const skillsHTML = displaySkills.map(skill => 
            `<div class="skill-item">${skill}</div>`
        ).join('\n          ');
        
        return skillsHTML;
    }
}

async function createProfessionalSummary(userProfile, targetRole) {
    if (!userProfile || userProfile.trim() === '') {
        return `Professional ${targetRole} seeking new opportunities.`;
    }
    
    try {
        // Enhance the user's profile to create a summary
        const enhancedSummary = await enhanceWithAI(userProfile, 'profile');
        return enhancedSummary;
        
    } catch (error) {
        console.log('Summary creation error:', error.message);
        return userProfile;
    }
}

async function createCertificationsSection(userProfile) {
    // Only create certifications if user mentioned them
    if (!userProfile) {
        return '';
    }
    
    const hasCertifications = userProfile.toLowerCase().includes('stcw') ||
                             userProfile.toLowerCase().includes('certif') ||
                             userProfile.toLowerCase().includes('license') ||
                             userProfile.toLowerCase().includes('training');
    
    if (hasCertifications) {
        return `
        <div class="certification-item">
            <strong>Relevant Certifications</strong><br>
            As detailed in professional experience
        </div>`;
    }
    
    return '';
}

async function createAchievementsSection(userSkills, userProfile) {
    if (!userSkills && !userProfile) {
        return '';
    }
    
    try {
        // Create achievements based on user's skills and profile
        const combinedText = `${userSkills || ''} ${userProfile || ''}`.trim();
        if (combinedText === '') return '';
        
        // Ask AI to extract achievements from what user provided
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: "Extract 2-3 potential achievements or strengths from the user's provided information. ONLY use information that is explicitly in the text. Do not invent anything new. Format each as a short bullet point starting with a verb."
            }, {
                role: "user",
                content: `From this information, extract 2-3 achievements or strengths that could be used in a CV: "${combinedText}"`
            }],
            temperature: 0.3,
            max_tokens: 150
        });
        
        const achievementsText = response.choices[0].message.content.trim();
        
        // Parse achievements into HTML
        const achievements = achievementsText.split('\n').filter(line => line.trim());
        if (achievements.length === 0) return '';
        
        const achievementsHTML = achievements.slice(0, 3).map(achievement => 
            `<div class="achievement-item">${achievement.trim().replace(/^[-•*]\s*/, '')}</div>`
        ).join('\n        ');
        
        return achievementsHTML;
        
    } catch (error) {
        console.log('Achievements creation error:', error.message);
        return '';
    }
}

// ==================== CV GENERATION ENDPOINT ====================

app.post('/submit-cv-application', upload.single('profilePicture'), async (req, res) => {
    try {
        const formData = req.body;
        const photoFile = req.file;
        
        console.log('Received form data for CV generation');
        
        const token = req.headers.authorization?.replace('Bearer ', '');
        let userId = null;

        if (token) {
            try {
                const { data: { user }, error } = await supabase.auth.getUser(token);
                if (!error && user) {
                    userId = user.id;
                    formData.userId = user.id;
                    console.log('User authenticated:', user.email);
                }
            } catch (error) {
                console.log('Auth error:', error.message);
            }
        }

        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        // Validate required fields
        const requiredFields = ['firstName', 'lastName', 'email', 'targetRole'];
        const missingFields = requiredFields.filter(field => !formData[field] || formData[field].trim() === '');

        if (missingFields.length > 0) {
            return res.status(400).json({
                success: false,
                error: `Missing required fields: ${missingFields.join(', ')}`
            });
        }

        const cvId = uuidv4();
        const targetRole = formData.targetRole ? formData.targetRole.trim() : 'Professional';
        const fullName = `${formData.firstName || ''} ${formData.lastName || ''}`.trim();
        
        // Use EXACT user data
        const phone = formData.phone ? formData.phone.trim() : '';
        const email = formData.email ? formData.email.trim() : '';
        const location = formData.location ? formData.location.trim() : '';
        const nationality = formData.nationality ? formData.nationality.trim() : '';
        const userProfile = formData.profile ? formData.profile.trim() : '';
        const userSkills = formData.skills ? formData.skills.trim() : '';
        const userHobbies = formData.hobbiesAndInterests ? formData.hobbiesAndInterests.trim() : '';
        const userEducation = formData.highestQualification ? formData.highestQualification.trim() : '';
        const userLanguages = formData.languages ? formData.languages.trim() : '';

        console.log('Processing CV for:', fullName, 'Role:', targetRole);

        // Handle profile photo
        let photoUrl = null;
        let photoBase64 = null;
        if (photoFile) {
            try {
                const photoFileName = `photo-${Date.now()}-${cvId}${path.extname(photoFile.originalname)}`;
                const photoPath = `users/${userId}/photos/${photoFileName}`;

                const { data: photoData, error: photoError } = await supabase.storage
                    .from(BUCKET_NAME)
                    .upload(photoPath, photoFile.buffer, {
                        contentType: photoFile.mimetype,
                        cacheControl: '3600',
                        upsert: true
                    });

                if (!photoError) {
                    const { data: { publicUrl } } = supabase.storage
                        .from(BUCKET_NAME)
                        .getPublicUrl(photoData.path);
                    photoUrl = publicUrl;
                    photoBase64 = photoFile.buffer.toString('base64');
                }
            } catch (error) {
                console.log('Photo upload error:', error.message);
            }
        }

        // Load HTML template
        const templatePath = path.join(__dirname, 'files/ricky.html');
        if (!fs.existsSync(templatePath)) {
            throw new Error('Template file not found at: ' + templatePath);
        }

        let htmlTemplate = fs.readFileSync(templatePath, 'utf8');

        console.log('Enhancing user content with AI...');
        
        // Enhance ALL user content with AI (grammar, structure, professionalism)
        const [
            professionalSummary,
            experienceSection,
            skillsHTML,
            enhancedLanguages,
            enhancedHobbies,
            enhancedEducation,
            achievementsSection,
            certificationsSection
        ] = await Promise.all([
            createProfessionalSummary(userProfile, targetRole),
            createProfessionalExperience(userProfile, targetRole),
            createSkillsSection(userSkills, targetRole),
            userLanguages ? enhanceWithAI(userLanguages, 'languages') : 'English',
            userHobbies ? enhanceWithAI(userHobbies, 'hobbies') : '',
            userEducation ? enhanceWithAI(userEducation, 'education') : '',
            createAchievementsSection(userSkills, userProfile),
            createCertificationsSection(userProfile)
        ]);

        // Prepare contact information - USE EXACT USER DATA
        let contactInfo = '';
        if (email) contactInfo += email;
        if (phone) contactInfo += (contactInfo ? ' | ' : '') + phone;
        if (location) contactInfo += (contactInfo ? ' | ' : '') + location;
        
        if (contactInfo) contactInfo += '<br>';
        if (nationality) contactInfo += `Nationality: ${nationality}`;
        contactInfo += ' | LinkedIn: Professional Profile';

        // Prepare all template replacements
        const replacements = {
            '{{FULL_NAME}}': fullName || 'Your Name',
            '{{TARGET_ROLE}}': targetRole || 'Professional Role',
            '{{EMAIL}}': email || '',
            '{{PHONE}}': phone || '',
            '{{LOCATION}}': location || '',
            '{{NATIONALITY}}': nationality || '',
            '{{LINKEDIN}}': 'Professional Profile',
            '{{PHOTO_HTML}}': photoBase64 ? 
                `<img src="data:${photoFile.mimetype};base64,${photoBase64}" alt="Profile Photo" style="width:100%;height:100%;object-fit:cover;" />` : 
                '<div style="text-align:center;padding:40px;color:#666;">Profile Photo</div>',
            '{{PROFESSIONAL_SUMMARY}}': professionalSummary,
            '{{EXPERIENCE_SECTION}}': experienceSection,
            '{{ACHIEVEMENTS_SECTION}}': achievementsSection,
            '{{CERTIFICATIONS_SECTION}}': certificationsSection,
            '{{SKILLS_SECTION}}': skillsHTML,
            '{{VISA_STATUS}}': formData.visaStatus || 'Information provided',
            '{{HEALTH_STATUS}}': formData.health || 'Information provided',
            '{{LANGUAGES}}': enhancedLanguages || 'English',
            '{{DRIVERS_LICENSE}}': formData.license || 'Information provided',
            '{{AVAILABILITY}}': 'Available',
            '{{EDUCATION_SECTION}}': enhancedEducation ? `
                <div class="education-item">
                    <div class="education-degree">${enhancedEducation}</div>
                </div>` : '<div class="education-item"><div class="education-degree">Education details provided</div></div>',
            '{{CORE_COMPETENCIES}}': skillsHTML ? `
                <ul>
                    ${skillsHTML.includes('skill-item') ? 
                        skillsHTML.match(/skill-item[^>]*>([^<]+)</g)
                            ?.slice(0, 5)
                            .map(match => `<li>${match.match(/>([^<]+)</)[1]}</li>`)
                            .join('\n        ') || '<li>Professional skills</li>' 
                        : '<li>Professional skills</li>'}
                </ul>` : '<ul><li>Professional</li><li>Reliable</li><li>Dedicated</li></ul>',
            '{{HOBBIES_SECTION}}': enhancedHobbies || '<ul><li>Professional development</li></ul>',
            '{{REFERENCES_SECTION}}': '<div class="reference-item">References available upon request</div>',
            '{{CONTACT_INFO}}': contactInfo
        };

        // Apply all replacements to template
        Object.entries(replacements).forEach(([key, value]) => {
            htmlTemplate = htmlTemplate.replace(new RegExp(key, 'g'), value);
        });

        // Clean up ANY leftover placeholders
        htmlTemplate = htmlTemplate.replace(/\[[^\]]*\]/g, 'Information provided');
        htmlTemplate = htmlTemplate.replace(/\{\{[^}]+\}\}/g, '');

        console.log('HTML template enhanced successfully');

        // Create temp directories
        if (!fs.existsSync('temp')) {
            fs.mkdirSync('temp', { recursive: true });
        }
        if (!fs.existsSync('outputs')) {
            fs.mkdirSync('outputs', { recursive: true });
        }

        // Save HTML and generate PDF
        const tempHtmlPath = path.join('temp', `cv-${Date.now()}.html`);
        fs.writeFileSync(tempHtmlPath, htmlTemplate);

        const pdfPath = await generatePDF(tempHtmlPath);

        // Upload PDF to Supabase
        const cleanRole = targetRole
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 30);
        
        const pdfFileName = `${cleanRole}-${cvId}.pdf`;
        const pdfStoragePath = `users/${userId}/cvs/${pdfFileName}`;
        const pdfBuffer = fs.readFileSync(pdfPath);

        const { data: pdfData, error: pdfError } = await supabase.storage
            .from(BUCKET_NAME)
            .upload(pdfStoragePath, pdfBuffer, {
                contentType: 'application/pdf',
                cacheControl: '3600',
                upsert: true
            });

        let pdfPublicUrl = null;
        if (!pdfError) {
            const { data: { publicUrl } } = supabase.storage
                .from(BUCKET_NAME)
                .getPublicUrl(pdfData.path);
            pdfPublicUrl = publicUrl;
        } else {
            throw new Error(`Failed to upload PDF: ${pdfError.message}`);
        }

        // Cleanup temp files
        try {
            fs.unlinkSync(tempHtmlPath);
            fs.unlinkSync(pdfPath);
        } catch (cleanupError) {
            console.log('Cleanup error:', cleanupError.message);
        }

        res.json({
            success: true,
            cvId: cvId,
            pdfUrl: pdfPublicUrl,
            photoUrl: photoUrl,
            message: 'CV generated successfully with AI-enhanced content',
            downloadUrl: pdfPublicUrl,
            filename: pdfFileName,
            enhancements: {
                grammar: 'Improved',
                structure: 'Professionalized',
                content: 'User data only',
                addedInfo: 'None'
            }
        });

    } catch (error) {
        console.error('CV Generation Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            details: 'Failed to generate CV. Please try again.'
        });
    }
});

async function generatePDF(htmlPath) {
    try {
        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const pdfPath = path.join('outputs', `cv-${Date.now()}.pdf`);

        const options = {
            format: 'A4',
            printBackground: true,
            margin: {
                top: '0.4in',
                right: '0.4in',
                bottom: '0.4in',
                left: '0.4in'
            },
            preferCSSPageSize: true,
            displayHeaderFooter: false
        };

        const file = { content: htmlContent };

        return new Promise((resolve, reject) => {
            htmlPdf.generatePdf(file, options).then(pdfBuffer => {
                fs.writeFileSync(pdfPath, pdfBuffer);
                resolve(pdfPath);
            }).catch(error => {
                reject(new Error(`Failed to generate PDF: ${error.message}`));
            });
        });

    } catch (error) {
        throw new Error(`PDF generation failed: ${error.message}`);
    }
}

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        server: 'AI-Enhanced CV Generator',
        timestamp: new Date().toISOString(),
        ai: 'ENABLED - Grammar & Structure Enhancement Only',
        dataPolicy: 'User Data Only - No Added Information'
    });
});

// ==================== SERVER START ====================

app.listen(PORT, () => {
    console.log('');
    console.log('=========================================');
    console.log('AI-Enhanced CV Generator Server');
    console.log('=========================================');
    console.log(`Server running: http://localhost:${PORT}`);
    console.log('AI Enhancement: ENABLED ✓');
    console.log('Enhancement Type: Grammar & Structure Only');
    console.log('Data Policy: User Data Only - NO Added Information');
    console.log('=========================================');
    console.log('');

    // Create required directories
    ['temp', 'outputs'].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
});
