# JobSleuth AI

A full-stack AI-powered job tracking and matching application that helps job seekers efficiently manage their applications, extract job data intelligently, and generate personalized motivation letters.

## What It Does

**JobSleuth AI** is a web application designed to streamline the job application process:

### Core Features

1. **Smart Job Extraction** — Paste a job URL (LinkedIn, Stepstone, Glassdoor, etc.) and AI automatically extracts:
   - Job title, company, location, salary
   - Required skills, education, languages
   - Employment type, contract duration
   - All stored in a searchable database

2. **Application Tracking** — Organize your job applications with:
   - Status tracking (Not Applied → Interview → Offer → Rejected)
   - Star/favorite jobs
   - Notes and observations
   - Restore bin (recover deleted jobs within 5 days)

3. **CV Management** — Upload your CV and the app:
   - Extracts your skills, education, experience
   - Automatically matches you against saved jobs
   - Shows match scores (0-100%) for each position
   - Stores multiple CV versions

4. **Motivation Letter Generator** — Create personalized cover letters:
   - AI-powered generation tailored to each job
   - Fallback templates for offline use
   - Edit and save multiple versions per job

5. **Job-CV Matching** — Intelligent scoring that compares:
   - Your extracted skills vs. job requirements
   - Your experience level vs. years required
   - Education fit
   - Language requirements

## Tech Stack

**Frontend:**
- Vanilla JavaScript (no framework)
- HTML5 + CSS3
- SessionStorage-based authentication

**Backend:**
- Node.js + Express
- SQLite (file-based database)
- JWT authentication with bcrypt

**AI & Data Processing:**
- Ollama (local LLM for job extraction and letter generation)
- Playwright (browser automation for dynamic content)
- Cheerio (HTML parsing)
- PDF extraction (for CV text)

**Deployment:**
- Render (free tier hosting)
- Configured for Node.js runtime

## Installation & Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Ollama (optional, for AI features)

### Local Development

```bash
# Clone the repository
git clone https://github.com/Leon-Deda/JobSleuth-AI.git
cd JobSleuth-AI

# Install dependencies
npm install

# Start dev server
npm run dev
```

Server runs on `http://localhost:4000`

### Environment Variables

Create a `.env` file (optional):
```
NODE_ENV=development
JWT_SECRET=your-secret-key
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b
OLLAMA_ENABLED=true
OLLAMA_TIMEOUT_MS=20000
```

## Deployment

### Deploy to Render (Free)

See [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) for step-by-step instructions.

**Live URL:** https://jobsleuth-ai.onrender.com

**Note:** Free tier has limitations:
- AI features disabled (Ollama not available)
- Data doesn't persist (resets on redeploy after 15 min inactivity)
- ~30 second cold starts

For production use with persistent data, upgrade to paid tier or use a VPS.

## Project Structure

```
├── src/
│   ├── server.js                  # Express API server
│   ├── db.js                      # SQLite database operations
│   ├── extractJobData.js          # Job extraction & parsing
│   ├── jobMatch.js                # CV matching & letter generation
│   ├── aiClient.js                # Ollama integration
│   ├── aiPrompts.js               # AI prompt templates
│   ├── aiSchemas.js               # Zod validation schemas
│   └── ...
├── public/
│   ├── index.html                 # Main dashboard
│   ├── auth.html                  # Login/register page
│   └── logo*.svg                  # Brand assets
├── data/
│   └── jobs.db                    # SQLite database
├── render.yaml                    # Render deployment config
└── package.json
```

## API Endpoints

### Authentication
- `POST /auth/register` — Create account
- `POST /auth/login` — Login
- `POST /auth/logout` — Logout

### Jobs
- `POST /jobs/extract` — Extract job from URL
- `POST /jobs` — Save job manually
- `GET /jobs` — List all jobs
- `PATCH /jobs/:id` — Update job status/notes
- `DELETE /jobs/:id` — Soft delete (moves to restore bin)
- `POST /jobs/:id/restore` — Restore deleted job
- `DELETE /jobs/:id/permanent` — Permanently delete

### CVs
- `POST /cvs` — Upload CV (PDF)
- `GET /cvs` — List saved CVs
- `POST /cvs/:id/match` — Match CV against all jobs
- `DELETE /cvs/:id` — Delete CV

### Motivation Letters
- `POST /letters/generate` — Generate letter for a job
- `GET /letters` — List saved letters
- `DELETE /letters/:id` — Delete letter

## Features Explained

### Job Extraction Process
1. User submits a job URL
2. App fetches the page (handles dynamic content with Playwright)
3. AI parses HTML and extracts structured data
4. Data is validated and saved to database
5. App shows extracted fields for review/editing

### CV Matching Algorithm
Compares each job against your CV profile:
- **Skills matching:** Percentage of required skills you have
- **Experience:** Years required vs. your years in similar roles
- **Education:** Degree match
- **Languages:** Required language fluency check
- **Final score:** Weighted average (0-100)

### Motivation Letter Generation
Two modes:
1. **AI Mode** (when Ollama available): Generates personalized letters referencing specific job details
2. **Fallback Mode** (always available): Template-based letters with custom placeholders

## Known Limitations

- **Ollama Requirement:** Full AI features require local Ollama installation
- **On Deployment:** Cloud deployments (Render, Railway) have AI disabled
- **Data Persistence:** Free cloud tiers don't persist SQLite data across redeploys
- **JavaScript Only:** No backend type safety (consider TypeScript for production)
- **Browser Requirements:** Modern browser with SessionStorage support

## Future Enhancements

- [ ] PostgreSQL support for cloud deployments
- [ ] Email integration for application reminders
- [ ] Job market analytics (salary trends, skill demand)
- [ ] Export to PDF (CV, cover letters)
- [ ] Integration with job boards (auto-apply)
- [ ] Mobile app (React Native)



## License

ISC

## Author

León Deda (@Leon-Deda)
