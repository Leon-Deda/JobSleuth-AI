# JobSleuth AI - Render Deployment Guide

## Deploy to Render (Free Tier)

### Prerequisites
- GitHub repository at https://github.com/Leon-Deda/JobSleuth-AI (push your code there first)
- Render.com free account (https://render.com/register)

### Setup Steps

1. **Push code to GitHub** (if not done yet)
   ```bash
   git add .
   git commit -m "Add Render deployment config"
   git push origin main
   ```

2. **Deploy on Render**
   - Go to https://dashboard.render.com
   - Click "New +"
   - Select "Web Service"
   - Connect your GitHub repository (Leon-Deda/JobSleuth-AI)
   - **Branch**: main
   - **Name**: jobsleuth-ai
   - **Runtime**: Node
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Plan**: Free (default)
   - Click "Create Web Service"

3. **Configure Environment** (already set in render.yaml)
   - `OLLAMA_ENABLED=false` — AI features disabled (Ollama not available on Render)
   - `JWT_SECRET` — auto-generated
   - `PORT=10000` — auto-configured

### What Works on Render
✅ Job tracking (add, edit, delete, restore)
✅ CV upload and storage
✅ Fallback motivation letter generation (no AI)
✅ Job matching scoring (fallback logic)
✅ User authentication
✅ Status tracking and starring

### What Doesn't Work
❌ AI-powered job extraction from URLs (Ollama required)
❌ AI-powered motivation letters (fallback text only)
❌ AI English normalization

### Important Notes

**Data Persistence**: The app uses SQLite stored in the `data/` folder. On Render's free tier, this resets on redeploy (~every 15 min of inactivity). If you need persistent data:
- Upgrade to Render paid tier (add persistent disk: $7/month)
- Or migrate to PostgreSQL (requires code changes)

**URL**: Your app will be at `https://jobsleuth-ai.onrender.com` (or custom domain if configured)

**Cold Starts**: Free tier apps sleep after 15 min inactivity. First request takes ~30 seconds.

### For More Control
If you need persistent data for free, consider:
1. **Railway.app** — Similar free tier, same Ollama limitation
2. **Vercel (Hobby tier)** — Frontend only, need backend elsewhere
3. **Hetzner VPS** (~€4/month) — Full control, Ollama works

---

### Troubleshooting

**"Deploy failed"**: Check build logs on Render dashboard. Ensure all dependencies in package.json are installed locally first.

**"Cannot find module"**: Run `npm ci` locally and commit package-lock.json to git.

**"Port already in use"**: Render sets PORT automatically. Don't hardcode it in code (app already handles this).

**"No data after redeploy"**: This is expected on free tier. SQLite doesn't persist across redeploys.
