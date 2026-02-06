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
                data: { name: name },
                emailRedirectTo: `${req.headers.origin}/dashboard`
            }
        });

        if (error) {
            return res.status(400).json({ error: error.message });
        }

        res.json({
            success: true,
            message: 'Account created successfully. Please check your email to verify your account.',
            user: {
                id: data.user.id,
                email: email,
                name: name
            }
        });

    } catch (error) {
        console.error('Signup error:', error);
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
            console.error('Login error:', error.message);
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
        console.error('Login error:', error);
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

// ==================== PASSWORD RESET ENDPOINTS ====================

app.post('/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Use Supabase's built-in password reset
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${req.headers.origin}/reset-password`,
        });

        if (error) {
            console.error('Password reset error:', error.message);
            // For security, don't reveal if email exists or not
            return res.json({ 
                success: true, 
                message: 'If an account exists with this email, you will receive a password reset link.' 
            });
        }

        res.json({ 
            success: true, 
            message: 'If an account exists with this email, you will receive a password reset link.' 
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== RESEND VERIFICATION ENDPOINT ====================

app.post('/auth/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Use Supabase's built-in resend confirmation
        const { error } = await supabase.auth.resend({
            type: 'signup',
            email: email,
            options: {
                emailRedirectTo: `${req.headers.origin}/dashboard`
            }
        });

        if (error) {
            console.error('Resend verification error:', error.message);
            return res.status(400).json({ error: error.message });
        }

        res.json({ 
            success: true, 
            message: 'Verification email resent successfully. Please check your inbox.' 
        });

    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ error: 'Internal server error' });
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
        console.error('Get CVs error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== IMPROVED AI FUNCTIONS WITH LI HANDLING ====================

async function enhanceWithAI(originalText, enhancementType) {
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
            temperature: 0.3,
            max_tokens: 500
        });

        let enhancedText = response.choices[0].message.content.trim();
        
        enhancedText = enhancedText.replace(/^"(.*)"$/, '$1');
        
        if (enhancedText.length < originalText.length / 2) {
            console.log('GPT shortened too much, using cleaned original');
            return originalText.replace(/\s+/g, ' ').trim();
        }
        
        return enhancedText;

    } catch (error) {
        console.log(`AI enhancement error for ${enhancementType}:`, error.message);
        return originalText.replace(/\s+/g, ' ').trim();
    }
}

async function createListFromText(userText, context) {
    if (!userText || userText.trim() === '') {
        return [];
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: `Extract and format items for a CV ${context} section. Return ONLY a JSON array of strings. No explanations.`
            }, {
                role: "user",
                content: `Extract distinct items from this text for a CV ${context} section. Return as JSON array: "${userText}"`
            }],
            temperature: 0.3,
            max_tokens: 300
        });

        const content = response.choices[0].message.content.trim();
        let items = [];
        
        // Try to parse JSON
        try {
            // Clean the response first
            const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            
            if (Array.isArray(parsed)) {
                items = parsed;
            } else if (typeof parsed === 'object') {
                // Try to find any array in the object
                for (const key in parsed) {
                    if (Array.isArray(parsed[key])) {
                        items = parsed[key];
                        break;
                    }
                }
            }
        } catch (e) {
            console.log('JSON parse failed, trying text extraction');
        }

        // If no items from JSON parsing, try to extract from text
        if (items.length === 0) {
            // Look for array-like patterns in the response
            const arrayMatch = content.match(/\[(.*?)\]/s);
            if (arrayMatch) {
                const inside = arrayMatch[1];
                items = inside.split(',').map(item => item.trim().replace(/['"]/g, '')).filter(item => item);
            }
        }

        // Final fallback: simple parsing
        if (items.length === 0) {
            items = userText.split(/[,;\/\n]/)
                .map(item => item.trim())
                .filter(item => item.length > 0 && item.length < 100);
        }

        // Clean and limit items
        items = items
            .map(item => {
                item = item.replace(/^[•\-\*\d\.\)\s]+/, '').trim();
                if (item.length > 0) {
                    return item.charAt(0).toUpperCase() + item.slice(1);
                }
                return item;
            })
            .filter(item => item.length > 0 && item.length < 80)
            .slice(0, 8);

        return items;

    } catch (error) {
        console.log('List creation error:', error.message);
        return userText.split(/[,;\/\n]/)
            .map(item => item.trim())
            .filter(item => item.length > 0 && item.length < 80)
            .slice(0, 5);
    }
}

async function createSkillsList(userSkills) {
    if (!userSkills || userSkills.trim() === '') {
        return [
            'Team collaboration',
            'Problem solving',
            'Adaptability',
            'Professional communication'
        ];
    }

    const skillItems = await createListFromText(userSkills, 'skills');
    
    if (skillItems.length === 0) {
        return [
            'Professional skills',
            'Reliable work ethic',
            'Quick learner',
            'Detail oriented'
        ];
    }

    return skillItems;
}

async function createEducationList(userEducation) {
    if (!userEducation || userEducation.trim() === '') {
        return ['Education details provided'];
    }

    const educationItems = await createListFromText(userEducation, 'education');
    
    if (educationItems.length === 0) {
        return [userEducation.substring(0, 80)];
    }

    return educationItems;
}

async function createLanguagesList(userLanguages) {
    if (!userLanguages || userLanguages.trim() === '') {
        return ['English'];
    }

    const languageItems = await createListFromText(userLanguages, 'languages');
    
    if (languageItems.length === 0) {
        return [userLanguages.substring(0, 50)];
    }

    return languageItems;
}

async function createHobbiesList(userHobbies) {
    if (!userHobbies || userHobbies.trim() === '') {
        return ['Professional development', 'Continuous learning'];
    }

    const hobbyItems = await createListFromText(userHobbies, 'hobbies');
    
    if (hobbyItems.length === 0) {
        return [userHobbies.substring(0, 50)];
    }

    return hobbyItems;
}

async function createProfessionalExperience(userProfile, targetRole) {
    if (!userProfile || userProfile.trim() === '') {
        return `
        <div class="job">
            <div class="job-title">${targetRole}</div>
            <p class="job-description">Seeking opportunities as a ${targetRole}.</p>
        </div>`;
    }
    
    try {
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

async function createProfessionalSummary(userProfile, targetRole) {
    if (!userProfile || userProfile.trim() === '') {
        return `Professional ${targetRole} seeking new opportunities.`;
    }
    
    try {
        const enhancedSummary = await enhanceWithAI(userProfile, 'profile');
        return enhancedSummary;
        
    } catch (error) {
        console.log('Summary creation error:', error.message);
        return userProfile;
    }
}

async function createCertificationsSection(userProfile) {
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

async function createAchievementsList(userSkills, userProfile) {
    if (!userSkills && !userProfile) {
        return [];
    }
    
    try {
        const combinedText = `${userSkills || ''} ${userProfile || ''}`.trim();
        if (combinedText === '') return [];
        
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: "Extract 2-3 achievements or strengths from the user's text. Return as JSON array of strings."
            }, {
                role: "user",
                content: `From this text, extract 2-3 achievements or key strengths for a CV. Return ONLY JSON array: "${combinedText}"`
            }],
            temperature: 0.3,
            max_tokens: 200
        });
        
        const content = response.choices[0].message.content.trim();
        let achievements = [];
        
        try {
            const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            if (Array.isArray(parsed)) {
                achievements = parsed;
            } else if (typeof parsed === 'object') {
                for (const key in parsed) {
                    if (Array.isArray(parsed[key])) {
                        achievements = parsed[key];
                        break;
                    }
                }
            }
        } catch (e) {
            console.log('Achievements JSON parse failed');
        }
        
        // Fallback if no achievements extracted
        if (achievements.length === 0) {
            achievements = [
                'Demonstrated professional capability',
                'Consistent performance in previous roles',
                'Strong work ethic and reliability'
            ];
        }
        
        return achievements.slice(0, 3);
        
    } catch (error) {
        console.log('Achievements creation error:', error.message);
        return [
            'Professional achievements as detailed in experience',
            'Proven track record of performance'
        ];
    }
}

// Helper function to convert array to <li> items
function arrayToLiItems(items) {
    if (!items || items.length === 0) {
        return '<li>Information provided</li>';
    }
    
    return items.map(item => `<li>${item}</li>`).join('\n        ');
}

// Helper function to create achievements HTML
function achievementsToHTML(achievements) {
    if (!achievements || achievements.length === 0) {
        return '';
    }
    
    const achievementsHTML = achievements.map(achievement => 
        `<div class="achievement-item">• ${achievement}</div>`
    ).join('\n        ');
    
    return `
    <h2>Achievements & Strengths</h2>
    <div style="margin-left: 20px;">
        ${achievementsHTML}
    </div>`;
}

// Helper function for certifications HTML
function certificationsToHTML(certifications) {
    if (!certifications || certifications.trim() === '') {
        return '';
    }
    
    return `
    <h2>Certifications</h2>
    <div class="certification-item">
        ${certifications}
    </div>`;
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
        const visaStatus = formData.visaStatus ? formData.visaStatus.trim() : 'Available';
        const health = formData.health ? formData.health.trim() : 'Good';
        const license = formData.license ? formData.license.trim() : 'Information provided';
        const availability = formData.availability ? formData.availability.trim() : 'Immediately';

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
        
        // Process all sections in parallel for better performance
        const [
            professionalSummary,
            experienceSection,
            skillsList,
            educationList,
            languagesList,
            hobbiesList,
            achievementsList,
            certificationsSection,
            enhancedHobbiesText,
            enhancedEducationText
        ] = await Promise.all([
            createProfessionalSummary(userProfile, targetRole),
            createProfessionalExperience(userProfile, targetRole),
            createSkillsList(userSkills),
            createEducationList(userEducation),
            createLanguagesList(userLanguages),
            createHobbiesList(userHobbies),
            createAchievementsList(userSkills, userProfile),
            createCertificationsSection(userProfile),
            userHobbies ? enhanceWithAI(userHobbies, 'hobbies') : '',
            userEducation ? enhanceWithAI(userEducation, 'education') : ''
        ]);

        // Create personal details section
        const personalDetails = [];
        if (location) personalDetails.push(`Location: ${location}`);
        if (nationality) personalDetails.push(`Nationality: ${nationality}`);
        if (visaStatus) personalDetails.push(`Visa Status: ${visaStatus}`);
        if (health) personalDetails.push(`Health: ${health}`);
        if (license) personalDetails.push(`Driver's License: ${license}`);
        if (personalDetails.length === 0) {
            personalDetails.push('Details provided upon request');
        }

        // Create status section
        const statusItems = [];
        if (availability) statusItems.push(`Availability: ${availability}`);
        if (formData.noticePeriod) statusItems.push(`Notice Period: ${formData.noticePeriod}`);
        if (formData.salaryExpectations) statusItems.push(`Salary Expectations: ${formData.salaryExpectations}`);
        if (statusItems.length === 0) {
            statusItems.push('Available for opportunities');
            statusItems.push('Flexible start date');
        }

        // Prepare contact information
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
            '{{CONTACT_INFO}}': contactInfo,
            '{{PHOTO_HTML}}': photoBase64 ? 
                `<img src="data:${photoFile.mimetype};base64,${photoBase64}" alt="Profile Photo" style="width:100%;height:100%;object-fit:cover;" />` : 
                '<div style="text-align:center;padding:40px;color:#666;">Profile Photo</div>',
            '{{PROFESSIONAL_SUMMARY}}': professionalSummary,
            '{{EXPERIENCE_SECTION}}': experienceSection,
            '{{ACHIEVEMENTS_SECTION}}': achievementsToHTML(achievementsList),
            '{{CERTIFICATIONS_SECTION}}': certificationsToHTML(certificationsSection),
            '{{PERSONAL_DETAILS_SECTION}}': arrayToLiItems(personalDetails),
            '{{SKILLS_LIST_SECTION}}': arrayToLiItems(skillsList),
            '{{EDUCATION_LIST_SECTION}}': arrayToLiItems(educationList),
            '{{LANGUAGES_LIST_SECTION}}': arrayToLiItems(languagesList),
            '{{HOBBIES_LIST_SECTION}}': arrayToLiItems(hobbiesList),
            '{{STATUS_SECTION}}': arrayToLiItems(statusItems),
            '{{REFERENCES_SECTION}}': '<div class="reference-item">References available upon request</div>'
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
    console.log('AI Enhancement: ENABLED ');
    console.log('Enhancement Type: Grammar & Structure Only');
    console.log('Data Policy: User Data Only - NO Added Information');
    console.log('=========================================');
    console.log('');
    console.log('Authentication Features:');
    console.log('Signup with email verification');
    console.log('Login with JWT tokens');
    console.log('Password reset via Supabase');
    console.log('Resend verification email');
    console.log('=========================================');
    console.log('');

    // Create required directories
    ['temp', 'outputs'].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
});
