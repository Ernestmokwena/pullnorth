const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const puppeteer = require('puppeteer');
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

// Initialize Supabase with environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

// Use your existing bucket
const BUCKET_NAME = 'PullnorthCV2026';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.')); // Serve static files

// Configure multer for in-memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.docx' || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only .docx files and images are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Initialize OpenAI with environment variable
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Global context for CV generation
const cvContext = {
  rawText: '',
  extractedData: {},
  sections: {},
  photoUrl: null,
  biographyUrl: null
};

// Serve the chat interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'chat-interface.html'));
});

// File upload endpoint - Uploads to existing Supabase bucket
app.post('/upload', upload.fields([
  { name: 'biography', maxCount: 1 },
  { name: 'photo', maxCount: 1 }
]), async (req, res) => {
  try {
    const files = req.files;
    
    if (!files || (!files.biography && !files.photo)) {
      return res.status(400).json({ 
        success: false, 
        error: 'No files uploaded' 
      });
    }

    const uploadResults = {
      biography: null,
      photo: null
    };

    // Upload biography to your existing bucket if exists
    if (files.biography) {
      const bioFile = files.biography[0];
      const bioFileName = `biography-${Date.now()}-${uuidv4().slice(0, 8)}.docx`;
      const bioPath = `documents/${bioFileName}`;
      
      const { data: bioData, error: bioError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(bioPath, bioFile.buffer, {
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          cacheControl: '3600'
        });

      if (bioError) {
        console.error('Supabase biography upload error:', bioError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to upload biography to storage' 
        });
      }

      // Get public URL
      const { data: { publicUrl: bioPublicUrl } } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(bioData.path);

      uploadResults.biography = {
        filename: bioFileName,
        path: bioPath,
        originalName: bioFile.originalname,
        supabasePath: bioData.path,
        url: bioPublicUrl
      };
      cvContext.biographyUrl = bioPublicUrl;
    }

    // Upload photo to your existing bucket if exists
    if (files.photo) {
      const photoFile = files.photo[0];
      const photoFileName = `photo-${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(photoFile.originalname)}`;
      const photoPath = `photos/${photoFileName}`;
      
      const { data: photoData, error: photoError } = await supabase.storage
        .from(BUCKET_NAME)
        .upload(photoPath, photoFile.buffer, {
          contentType: photoFile.mimetype,
          cacheControl: '3600'
        });

      if (photoError) {
        console.error('Supabase photo upload error:', photoError);
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to upload photo to storage' 
        });
      }

      // Get public URL
      const { data: { publicUrl: photoPublicUrl } } = supabase.storage
        .from(BUCKET_NAME)
        .getPublicUrl(photoData.path);

      uploadResults.photo = {
        filename: photoFileName,
        path: photoPath,
        originalName: photoFile.originalname,
        supabasePath: photoData.path,
        url: photoPublicUrl,
        mimetype: photoFile.mimetype
      };
      cvContext.photoUrl = photoPublicUrl;
    }

    res.json({
      success: true,
      ...uploadResults,
      bucket: BUCKET_NAME
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// CV generation endpoint - Downloads from your existing bucket
app.post('/generate-cv', async (req, res) => {
  try {
    // Accept both biographyFilename (old) and biographyPath (new)
    const { biographyFilename, biographyPath, photoFilename, photoPath } = req.body;
    
    // Use biographyPath if provided, otherwise use biographyFilename
    const bioPath = biographyPath || (biographyFilename ? `documents/${biographyFilename}` : null);
    
    if (!bioPath) {
      return res.status(400).json({ 
        success: false, 
        error: 'Biography filename or path is required' 
      });
    }

    // Use photoPath if provided, otherwise use photoFilename
    const imgPath = photoPath || (photoFilename ? `photos/${photoFilename}` : null);

    console.log(' Starting Intelligent Sequential CV Generation...\n');
    console.log(` Processing file from Supabase: ${bioPath}`);
    console.log(` From bucket: ${BUCKET_NAME}`);
    
    // Download biography from your existing bucket
    const { data: bioData, error: bioError } = await supabase.storage
      .from(BUCKET_NAME)
      .download(bioPath);

    if (bioError) {
      console.error('Error downloading biography:', bioError);
      return res.status(404).json({ 
        success: false, 
        error: 'Biography file not found in storage' 
      });
    }

    // Save temporarily for processing
    const tempBioPath = path.join('temp', path.basename(bioPath));
    if (!fs.existsSync('temp')) {
      fs.mkdirSync('temp', { recursive: true });
    }
    fs.writeFileSync(tempBioPath, Buffer.from(await bioData.arrayBuffer()));

    // Handle photo if exists
    let tempPhotoPath = null;
    if (imgPath) {
      const { data: photoData, error: photoError } = await supabase.storage
        .from(BUCKET_NAME)
        .download(imgPath);

      if (!photoError) {
        tempPhotoPath = path.join('temp', path.basename(imgPath));
        fs.writeFileSync(tempPhotoPath, Buffer.from(await photoData.arrayBuffer()));
        console.log(` With photo from Supabase: ${imgPath}`);
      }
    }
    
    // Generate CV
    const pdfPath = await generateCVFromFile(tempBioPath, tempPhotoPath);
    
    // Upload generated PDF to your existing bucket
    const pdfFileName = `cv-${Date.now()}.pdf`;
    const pdfStoragePath = `outputs/${pdfFileName}`;
    const pdfBuffer = fs.readFileSync(pdfPath);
    
    const { data: pdfData, error: pdfError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(pdfStoragePath, pdfBuffer, {
        contentType: 'application/pdf',
        cacheControl: '3600'
      });

    if (pdfError) {
      console.error('Error uploading PDF:', pdfError);
      // Return local path as fallback
      const pdfUrl = `/outputs/${path.basename(pdfPath)}`;
      return res.json({
        success: true,
        pdfUrl: pdfUrl,
        pdfPath: pdfPath,
        message: 'CV generated locally'
      });
    }

    // Get public URL for PDF
    const { data: { publicUrl: pdfPublicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(pdfData.path);
    
    // Clean up temp files
    try {
      fs.unlinkSync(tempBioPath);
      if (tempPhotoPath && fs.existsSync(tempPhotoPath)) {
        fs.unlinkSync(tempPhotoPath);
      }
      fs.unlinkSync(pdfPath);
    } catch (cleanupError) {
      console.warn('Could not clean up temp files:', cleanupError.message);
    }

    res.json({
      success: true,
      pdfUrl: pdfPublicUrl,
      pdfPath: pdfStoragePath,
      bucket: BUCKET_NAME,
      message: 'CV generated and uploaded to cloud storage'
    });

  } catch (error) {
    console.error('CV generation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Main CV generation function
async function generateCVFromFile(bioPath, photoPath = null) {
  try {
    console.log(' Found biography file');
    
    const templatePath = path.join('files', 'template.html');
    if (!fs.existsSync(templatePath)) {
      throw new Error('Template file not found. Please ensure template.html is in the files/ folder');
    }
    
    console.log(' Found template.html');
    
    console.log(' Extracting text from biography file...');
    cvContext.rawText = await readDocxFile(bioPath);
    console.log(` Extracted ${cvContext.rawText.length} characters\n`);
    
    console.log('Sample of extracted text:', cvContext.rawText.substring(0, 200), '...\n');
    
    let htmlTemplate = fs.readFileSync(templatePath, 'utf8');
    
    // Add photo to template if exists
    if (photoPath && fs.existsSync(photoPath)) {
      const photoBase64 = fs.readFileSync(photoPath, 'base64');
      const mimeType = photoPath.endsWith('.png') ? 'png' : 
                      photoPath.endsWith('.jpg') || photoPath.endsWith('.jpeg') ? 'jpeg' : 
                      photoPath.endsWith('.gif') ? 'gif' : 'jpeg';
      
      const photoDataUrl = `data:image/${mimeType};base64,${photoBase64}`;
      
      // Check if template has photo placeholder, if not, add it
      if (!htmlTemplate.includes('[[PHOTO_URL]]')) {
        // Add photo placeholder near name section
        htmlTemplate = htmlTemplate.replace('[[FULL_NAME]]', 
          `<div style="display: flex; align-items: center; gap: 20px;">
            <div>
              <img src="${photoDataUrl}" style="width: 120px; height: 120px; border-radius: 8px; object-fit: cover;">
            </div>
            <div>
              <h1 style="margin: 0;">[[FULL_NAME]]</h1>
            </div>
          </div>`);
      } else {
        htmlTemplate = htmlTemplate.replace('[[PHOTO_URL]]', photoDataUrl);
      }
    }
    
    console.log(' Starting Intelligent Field-by-Field Processing...\n');
    
    console.log(' PHASE 1: Core Identity Extraction');
    console.log('────────────────────────────────────');
    
    console.log(' Extracting Fundamental Identifiers...');
    
    console.log('1.1 Processing: Full Name...');
    const fullName = await extractWithContext('Extract the full name exactly as written in the document.', cvContext.rawText, 'fullName');
    console.log(`    Full Name: ${fullName}`);
    htmlTemplate = htmlTemplate.replace('[[FULL_NAME]]', fullName || 'Richard Mutsa');
    cvContext.extractedData.fullName = fullName;
    
    console.log('1.2 Processing: Professional Title...');
    const titlePrompt = `Based on the text, extract the professional title.`;
    const title = await extractWithContext(titlePrompt, cvContext.rawText, 'professionalTitle');
    console.log(`    Professional Title: ${title}`);
    htmlTemplate = htmlTemplate.replace('[[PROFESSIONAL_TITLE]]', title || 'Yacht Manager');
    cvContext.extractedData.professionalTitle = title;
    
    console.log('1.3 Processing: Email Address...');
    const email = await extractEmail(cvContext.rawText);
    console.log(`    Email: ${email}`);
    htmlTemplate = htmlTemplate.replace('[[EMAIL_ADDRESS]]', email || 'Ricky@pullnorth.com');
    cvContext.extractedData.email = email;
    
    console.log('1.4 Processing: Phone Number...');
    const phone = await extractPhoneNumber(cvContext.rawText);
    console.log(`    Phone: ${phone}`);
    htmlTemplate = htmlTemplate.replace('[[PHONE_NUMBER]]', phone || '+27 66 537 6371');
    cvContext.extractedData.phone = phone;
    
    console.log('1.5 Processing: Current Location...');
    const locationPrompt = `Extract the current location.`;
    const location = await extractWithContext(locationPrompt, cvContext.rawText, 'location');
    console.log(`    Location: ${location}`);
    htmlTemplate = htmlTemplate.replace('[[CURRENT_LOCATION]]', location || 'Polokwane, South Africa');
    cvContext.extractedData.location = location;
    
    console.log('\n PHASE 1 COMPLETE\n');
    
    console.log(' PHASE 2: Personal Details Extraction');
    console.log('───────────────────────────────────────');
    console.log(' Extracting Personal Information...');
    
    console.log('2.1 Processing: Availability Status...');
    const availability = await extractWithContext('Extract availability to start work.', cvContext.rawText, 'availability');
    console.log(`    Availability: ${availability}`);
    htmlTemplate = htmlTemplate.replace('[[AVAILABILITY_STATUS]]', availability || 'Available Immediately');
    cvContext.extractedData.availability = availability;
    
    console.log('2.2 Processing: Nationality...');
    const nationalityPrompt = `Extract the nationality.`;
    const nationality = await extractWithContext(nationalityPrompt, cvContext.rawText, 'nationality');
    console.log(`    Nationality: ${nationality}`);
    htmlTemplate = htmlTemplate.replace('[[NATIONALITY]]', nationality || 'South African');
    cvContext.extractedData.nationality = nationality;
    
    console.log('2.3 Processing: Languages Spoken...');
    const languages = await extractWithContext('Extract all languages spoken.', cvContext.rawText, 'languages');
    console.log(`    Languages: ${languages}`);
    htmlTemplate = htmlTemplate.replace('[[LANGUAGES_SPOKEN]]', languages || 'English, isiZulu, Sesotho, isiXhosa');
    cvContext.extractedData.languages = languages;
    
    console.log('2.4 Processing: Marital Status...');
    const maritalStatus = await extractWithContext('Extract marital status.', cvContext.rawText, 'maritalStatus');
    console.log(`    Marital Status: ${maritalStatus}`);
    htmlTemplate = htmlTemplate.replace('[[MARITAL_STATUS]]', maritalStatus || 'Single');
    cvContext.extractedData.maritalStatus = maritalStatus;
    
    console.log('2.5 Processing: Height...');
    const height = await extractWithContext('Extract the height.', cvContext.rawText, 'height');
    console.log(`    Height: ${height}`);
    htmlTemplate = htmlTemplate.replace('[[HEIGHT]]', height || '6\'0" (183cm)');
    cvContext.extractedData.height = height;
    
    console.log('\n PHASE 2 COMPLETE\n');
    
    console.log(' PHASE 3: Professional Attributes');
    console.log('───────────────────────────────────');
    console.log(' Extracting Professional Qualifications...');
    
    console.log('3.1 Processing: Driving License...');
    const drivingPrompt = `Extract driving license information.`;
    const drivingLicense = await extractWithContext(drivingPrompt, cvContext.rawText, 'drivingLicense');
    console.log(`    Driving License: ${drivingLicense}`);
    htmlTemplate = htmlTemplate.replace('[[DRIVING_LICENSE]]', drivingLicense || 'Valid SA License');
    cvContext.extractedData.drivingLicense = drivingLicense;
    
    console.log('3.2 Processing: Uniform Size...');
    const uniformSize = await extractWithContext('Extract uniform size.', cvContext.rawText, 'uniformSize');
    console.log(`    Uniform Size: ${uniformSize}`);
    htmlTemplate = htmlTemplate.replace('[[UNIFORM_SIZE]]', uniformSize || 'Medium (M)');
    cvContext.extractedData.uniformSize = uniformSize;
    
    console.log('3.3 Processing: Tattoos...');
    const tattoosPrompt = `Does the person have tattoos? Answer simply: Yes or No.`;
    const tattoos = await extractWithContext(tattoosPrompt, cvContext.rawText, 'tattoos');
    console.log(`    Tattoos: ${tattoos}`);
    htmlTemplate = htmlTemplate.replace('[[TATTOOS_STATUS]]', tattoos || 'No');
    cvContext.extractedData.tattoos = tattoos;
    
    console.log('3.4 Processing: Piercings...');
    const piercingsPrompt = `Does the person have piercings? Answer simply: Yes or No.`;
    const piercings = await extractWithContext(piercingsPrompt, cvContext.rawText, 'piercings');
    console.log(`    Piercings: ${piercings}`);
    htmlTemplate = htmlTemplate.replace('[[PIERCINGS_STATUS]]', piercings || 'No');
    cvContext.extractedData.piercings = piercings;
    
    console.log('3.5 Processing: Smoker Status...');
    const smokerPrompt = `Does the person smoke? Answer simply: Yes or No.`;
    const smoker = await extractWithContext(smokerPrompt, cvContext.rawText, 'smoker');
    console.log(`    Smoker: ${smoker}`);
    htmlTemplate = htmlTemplate.replace('[[SMOKER_STATUS]]', smoker || 'No');
    cvContext.extractedData.smoker = smoker;
    
    console.log('3.6 Processing: Seasickness...');
    const seasickness = await extractWithContext('Extract seasickness information.', cvContext.rawText, 'seasickness');
    console.log(`    Seasickness: ${seasickness}`);
    htmlTemplate = htmlTemplate.replace('[[SEASICKNESS_STATUS]]', seasickness || 'None');
    cvContext.extractedData.seasickness = seasickness;
    
    console.log('\n PHASE 3 COMPLETE\n');
    
    console.log('PHASE 4: Health & Security');
    console.log('─────────────────────────────');
    console.log('Extracting Health and Security Information...');
    
    console.log('4.1 Processing: Health Status...');
    const health = await extractWithContext('Extract health status.', cvContext.rawText, 'health');
    console.log(`Health Status: ${health}`);
    htmlTemplate = htmlTemplate.replace('[[HEALTH_STATUS]]', health || 'Excellent');
    cvContext.extractedData.health = health;
    
    console.log('4.2 Processing: Medical Certificate...');
    const medicalPrompt = `Extract medical certificate details.`;
    const medicalCert = await extractWithContext(medicalPrompt, cvContext.rawText, 'medicalCertificate');
    console.log(`Medical Certificate: ${medicalCert}`);
    htmlTemplate = htmlTemplate.replace('[[MEDICAL_CERTIFICATE]]', medicalCert || 'Valid medical certificate');
    cvContext.extractedData.medicalCertificate = medicalCert;
    
    console.log('4.3 Processing: Criminal Record...');
    const criminalRecord = await extractWithContext('Extract criminal record status.', cvContext.rawText, 'criminalRecord');
    console.log(`Criminal Record: ${criminalRecord}`);
    htmlTemplate = htmlTemplate.replace('[[CRIMINAL_RECORD]]', criminalRecord || 'Clean');
    cvContext.extractedData.criminalRecord = criminalRecord;
    
    console.log('4.4 Processing: Passport...');
    const passport = await extractWithContext('Extract passport details.', cvContext.rawText, 'passport');
    console.log(`Passport: ${passport}`);
    htmlTemplate = htmlTemplate.replace('[[PASSPORT_STATUS]]', passport || 'Valid passport');
    cvContext.extractedData.passport = passport;
    
    console.log('4.5 Processing: Swimming Ability...');
    const swimming = await extractWithContext('Extract swimming ability.', cvContext.rawText, 'swimming');
    console.log(`Swimming Ability: ${swimming}`);
    htmlTemplate = htmlTemplate.replace('[[SWIMMING_ABILITY]]', swimming || 'Strong');
    cvContext.extractedData.swimming = swimming;
    
    console.log('\n PHASE 4 COMPLETE\n');
    
    console.log('PHASE 5: Profile & Skills Extraction');
    console.log('──────────────────────────────────────');
    
    console.log('5.1 Processing: Personal Profile...');
    const profilePrompt = `Based on all this information, write a professional profile in exactly 5 lines maximum. Write in first person.`;
    
    const profile = await generateProfessionalProfile(profilePrompt, cvContext.rawText);
    console.log(`Profile: ${profile.substring(0, 100)}...`);
    htmlTemplate = htmlTemplate.replace('[[PERSONAL_PROFILE]]', profile || 'I am a professional Yacht Manager with extensive maritime experience.\nI am skilled in vessel operations and safety compliance.\nI have experience in crew management and guest services.\nI am committed to maritime safety standards.\nI am available for immediate deployment.');
    cvContext.sections.profile = profile;
    
    console.log('5.2 Processing: Technical Skills (Limited to 8)...');
    const techSkillsPrompt = `Extract the TOP 8 technical skills.`;
    const techSkills = await extractSkills(techSkillsPrompt, cvContext.rawText, 'technical');
    let techSkillsArray = techSkills ? techSkills.split(',').map(s => s.trim()).filter(s => s) : ['Yacht operations', 'Safety compliance', 'Navigation systems', 'Maintenance', 'Marine safety', 'Crew management', 'Emergency response', 'Vessel maintenance'];
    
    techSkillsArray = techSkillsArray.slice(0, 8);
    
    const techSkillsHTML = techSkillsArray.map(skill => `<div class="skill-tag">${skill}</div>`).join('\n');
    console.log(` Technical Skills: ${techSkillsArray.length} skills extracted`);
    htmlTemplate = htmlTemplate.replace('[[TECHNICAL_SKILLS]]', techSkillsHTML);
    cvContext.sections.technicalSkills = techSkillsArray;
    
    console.log('5.3 Processing: Soft Skills...');
    const softSkillsPrompt = `Extract soft skills.`;
    const softSkills = await extractSkills(softSkillsPrompt, cvContext.rawText, 'soft');
    const softSkillsArray = softSkills ? softSkills.split(',').map(s => s.trim()).filter(s => s) : ['Leadership', 'Communication', 'Problem-solving', 'Teamwork'];
    const softSkillsHTML = softSkillsArray.map(skill => `<div class="skill-tag">${skill}</div>`).join('\n');
    console.log(` Soft Skills: ${softSkillsArray.length} skills extracted`);
    htmlTemplate = htmlTemplate.replace('[[SOFT_SKILLS]]', softSkillsHTML);
    cvContext.sections.softSkills = softSkillsArray;
    
    console.log('\n PHASE 5 COMPLETE\n');
    
    console.log('PHASE 6: Experience & Education');
    console.log('──────────────────────────────────');
    
    console.log('6.1 Processing: Certifications...');
    const certsPrompt = `Extract ALL certifications.`;
    const certifications = await extractStructuredList(certsPrompt, cvContext.rawText, 'certifications');
    let certsHTML = '';
    
    if (certifications) {
      const certs = certifications.split('\n').filter(c => c.trim()).map(c => c.trim());
      certsHTML = certs.map(cert => {
        const enhancedCert = enhanceCertificationText(cert);
        return `<div class="certification-item"><span class="bolded">${enhancedCert}</span></div>`;
      }).join('\n');
    } else {
      certsHTML = '<div class="certification-item"><span class="bolded">STCW Basic Safety Training (2024)</span></div>';
    }
    
    console.log(` Certifications: Processed`);
    htmlTemplate = htmlTemplate.replace('[[CERTIFICATIONS_LIST]]', certsHTML);
    cvContext.sections.certifications = certifications;
    
    console.log('6.2 Processing: Work Experience...');
    const workExpPrompt = `Extract work experience in this EXACT HTML format:
    <div class="work-experience-item">
      <div class="job-header">
        <div class="bolded">[JOB TITLE]</div>
        <div class="text-muted">[START DATE] - [END DATE]</div>
      </div>
      <div class="company-name">[COMPANY NAME]</div>
      <ul class="job-responsibilities">
        <li>[Responsibility 1]</li>
        <li>[Responsibility 2]</li>
        <li>[Responsibility 3]</li>
      </ul>
    </div>
    
    Extract ALL job positions in chronological order (most recent first).`;
    
    const workExp = await extractStructuredHTML(workExpPrompt, cvContext.rawText);
    const workExpHTML = workExp || `
      <div class="work-experience-item">
        <div class="job-header">
          <div class="bolded">Assistant Yacht Manager</div>
          <div class="text-muted">February 2023 - December 2024</div>
        </div>
        <div class="company-name">BlueWave Marine Services</div>
        <ul class="job-responsibilities">
          <li>Supported daily yacht operations and safety compliance</li>
          <li>Coordinated crew schedules and guest services</li>
          <li>Assisted with maintenance planning and inspections</li>
        </ul>
      </div>
    `;
    
    console.log(` Work Experience: Generated`);
    htmlTemplate = htmlTemplate.replace('[[WORK_EXPERIENCE]]', cleanHTMLResponse(workExpHTML));
    cvContext.sections.workExperience = workExpHTML;
    
    console.log('6.3 Processing: Education...');
    const educationPrompt = `Extract education in this EXACT HTML format:
    <div class="education-item">
      <div class="bolded">[QUALIFICATION/DEGREE]</div>
      <div class="text-muted">[INSTITUTION] | [YEAR STARTED] - [YEAR ENDED]</div>
      <div class="text-small">[MAJOR/SPECIALIZATION]</div>
    </div>
    
    Include all formal education and relevant training.`;
    
    const education = await extractStructuredHTML(educationPrompt, cvContext.rawText);
    const educationHTML = education || `
      <div class="education-item">
        <div class="bolded">Diploma in Maritime Operations & Management</div>
        <div class="text-muted">Coastal Maritime Training Institute | 2021 - 2023</div>
        <div class="text-small">Vessel Operations & Safety Management, Maritime Hospitality & Guest Experience</div>
      </div>
    `;
    
    console.log(`Education: Generated`);
    htmlTemplate = htmlTemplate.replace('[[EDUCATION_DETAILS]]', cleanHTMLResponse(educationHTML));
    cvContext.sections.education = educationHTML;
    
    console.log('\n PHASE 6 COMPLETE\n');
    
    console.log(' PHASE 7: Additional Information');
    console.log('──────────────────────────────────');
    
    console.log('7.1 Processing: Additional Information...');
    const additionalInfoPrompt = `Extract additional information.`;
    
    const additionalInfo = await extractWithContext(additionalInfoPrompt, cvContext.rawText, 'additionalInfo');
    console.log(` Additional Info: ${additionalInfo?.substring(0, 80) || 'Available immediately'}...`);
    htmlTemplate = htmlTemplate.replace('[[ADDITIONAL_INFO]]', additionalInfo || 'Available immediately. Willing to relocate and travel internationally.');
    cvContext.sections.additionalInfo = additionalInfo;
    
    console.log('7.2 Processing: References...');
    htmlTemplate = htmlTemplate.replace('[[REFERENCE_1_NAME]]', 'Available upon request');
    htmlTemplate = htmlTemplate.replace('[[REFERENCE_1_POSITION]]', 'Professional Reference');
    htmlTemplate = htmlTemplate.replace('[[REFERENCE_1_CONTACT]]', 'Contact details available upon request');
    htmlTemplate = htmlTemplate.replace('[[REFERENCE_2_NAME]]', 'Available upon request');
    htmlTemplate = htmlTemplate.replace('[[REFERENCE_2_POSITION]]', 'Professional Reference');
    htmlTemplate = htmlTemplate.replace('[[REFERENCE_2_CONTACT]]', 'Contact details available upon request');
    
    console.log('\n PHASE 7 COMPLETE\n');
    
    console.log('FINAL PHASE: Output Generation');
    console.log('─────────────────────────────────');
    
    if (!fs.existsSync('temp')) {
      fs.mkdirSync('temp', { recursive: true });
    }
    if (!fs.existsSync('outputs')) {
      fs.mkdirSync('outputs', { recursive: true });
    }
    
    console.log('8.1 Saving filled HTML...');
    const tempHtmlPath = path.join('temp', `cv-${Date.now()}.html`);
    fs.writeFileSync(tempHtmlPath, htmlTemplate);
    console.log(` Saved HTML to: ${tempHtmlPath}`);
    
    console.log('8.2 Generating PDF...');
    const pdfPath = await generatePDF(tempHtmlPath);
    
    console.log(`\n CV GENERATED SUCCESSFULLY!`);
    console.log(`PDF saved to: ${pdfPath}`);
    
    saveExtractionSummary();
    
    return pdfPath;
    
  } catch (error) {
    console.error('\n ERROR:', error.message);
    throw error;
  }
}

// Helper functions
async function extractWithContext(question, text, fieldName) {
  try {
    const truncatedText = text.substring(0, 3000);
    
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a precise CV information extractor. For field: ${fieldName}, extract ONLY the requested information. Return plain text without formatting, no markdown, no HTML, no explanations. If information is not found, return an empty string.`
        },
        {
          role: "user",
          content: `Extract this specific information: ${question}\n\nText: ${truncatedText}\n\nExtracted value:`
        }
      ],
      temperature: 0.1,
      max_tokens: 100
    });
    
    const extracted = response.choices[0].message.content.trim();
    return cleanPlainText(extracted);
    
  } catch (error) {
    console.error(`   Extraction failed for ${fieldName}: ${error.message}`);
    return null;
  }
}

async function extractEmail(text) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = text.match(emailRegex);
  
  if (emails && emails.length > 0) {
    return emails[0];
  }
  
  return await extractWithContext('What is the email address?', text, 'email');
}

async function extractPhoneNumber(text) {
  const phoneRegex = /(\+\d{1,3}[\s-]?)?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}/g;
  const phones = text.match(phoneRegex);
  
  if (phones && phones.length > 0) {
    return phones[0];
  }
  
  return await extractWithContext('What is the phone number?', text, 'phone');
}

async function extractSkills(prompt, text, skillType) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Extract ${skillType} skills as a comma-separated list. Format: "Skill1, Skill2, Skill3". No bullets, no numbers, no explanations.`
        },
        {
          role: "user",
          content: `${prompt}\n\nText: ${text.substring(0, 2500)}\n\nSkills list:`
        }
      ],
      temperature: 0.2,
      max_tokens: 300
    });
    
    return cleanPlainText(response.choices[0].message.content.trim());
    
  } catch (error) {
    console.error(`   Skills extraction failed: ${error.message}`);
    return null;
  }
}

async function generateProfessionalProfile(prompt, text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a professional CV writer specializing in maritime and yacht industry profiles. Write concise, compelling professional profiles in first person. Maximum 5 lines. Use 'I', 'my', 'me' pronouns."
        },
        {
          role: "user",
          content: `${prompt}\n\nAdditional context from CV: ${text.substring(0, 2000)}`
        }
      ],
      temperature: 0.7,
      max_tokens: 200
    });
    
    let profile = cleanPlainText(response.choices[0].message.content.trim());
    
    const lines = profile.split('\n').filter(line => line.trim());
    if (lines.length > 5) {
      profile = lines.slice(0, 5).join('\n');
    }
    
    return profile;
    
  } catch (error) {
    console.error(`   Profile generation failed: ${error.message}`);
    return null;
  }
}

async function extractStructuredList(prompt, text, listType) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `Extract ${listType} as a bulleted list, one per line. Include details like dates if available.`
        },
        {
          role: "user",
          content: `${prompt}\n\nText: ${text.substring(0, 2500)}`
        }
      ],
      temperature: 0.3,
      max_tokens: 400
    });
    
    return response.choices[0].message.content.trim();
    
  } catch (error) {
    console.error(`   ${listType} extraction failed: ${error.message}`);
    return null;
  }
}

async function extractStructuredHTML(prompt, text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "Extract information and format it EXACTLY as requested in HTML. Do not add any extra text, explanations, or markdown. Only return the HTML structure specified."
        },
        {
          role: "user",
          content: `${prompt}\n\nText to extract from: ${text.substring(0, 3000)}`
        }
      ],
      temperature: 0.2,
      max_tokens: 1000
    });
    
    return response.choices[0].message.content.trim();
    
  } catch (error) {
    console.error(`   Error HTML extraction failed: ${error.message}`);
    return null;
  }
}

function cleanPlainText(text) {
  if (!text) return '';
  
  text = text.replace(/```[\w]*\n?/g, '');
  text = text.replace(/<\/?[^>]+(>|$)/g, '');
  text = text.replace(/["']/g, '');
  text = text.trim();
  text = text.replace(/^(Answer|Extracted|Value):\s*/i, '');
  
  return text;
}

function cleanHTMLResponse(html) {
  if (!html) return '';
  
  html = html.replace(/```[\w]*\n?/g, '');
  html = html.trim();
  
  return html;
}

function enhanceCertificationText(cert) {
  if (cert.toLowerCase().includes('stcw')) {
    return cert.replace('STCW', 'STCW (Standards of Training, Certification & Watchkeeping)');
  }
  if (cert.toLowerCase().includes('basic safety')) {
    return cert + ' (Maritime Safety)';
  }
  return cert;
}

async function readDocxFile(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (error) {
    throw new Error(`Failed to read DOCX file: ${error.message}`);
  }
}

async function generatePDF(htmlPath) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    const pdfPath = path.join('outputs', `cv-${Date.now()}.pdf`);
    
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '0.5in',
        right: '0.5in',
        bottom: '0.5in',
        left: '0.5in'
      }
    });

    await browser.close();
    return pdfPath;

  } catch (error) {
    await browser.close();
    throw error;
  }
}

function saveExtractionSummary() {
  const summaryPath = path.join('temp', `extraction-summary-${Date.now()}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(cvContext, null, 2));
  console.log(`Extraction summary saved to: ${summaryPath}`);
}

// Serve static files from local folders (fallback)
app.use('/uploads/photos', express.static('uploads/photos'));
app.use('/outputs', express.static('outputs'));

// Start the server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log('Ready to accept biography uploads and generate CVs!');
  console.log(`Using Supabase bucket: ${BUCKET_NAME}`);
});

// Export for testing
module.exports = { generateCVFromFile };