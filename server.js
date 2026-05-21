require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

// HELPER: Auth Headers
const getAuthHeaders = () => {
    const authString = Buffer.from(`${process.env.RAVELRY_USER}:${process.env.RAVELRY_PASSWORD}`).toString('base64');
    return { 'Authorization': `Basic ${authString}` };
};

// 1. Autocomplete Search Endpoint (Fixed to search Patterns, not Projects)
app.get('/pattern-search', async (req, res) => {
  try {
    if (!req.query.q) return res.json([]);
    
    const searchUrl = 'https://api.ravelry.com/patterns/search.json';
    
    const response = await axios.get(searchUrl, { 
        params: { query: req.query.q, page_size: 10 }, 
        headers: getAuthHeaders()
    });

    const suggestions = response.data.patterns.map(p => ({
      permalink: p.permalink,
      name: p.name,
      designer: p.designer ? p.designer.name : 'Unknown'
    }));

    res.json(suggestions);
  } catch (err) {
    console.error("Autocomplete Error:", err.message);
    res.status(500).json([]);
  }
});

// 2. Project Search Endpoint
app.get('/pattern-projects', async (req, res) => {
  try {
    const searchUrl = 'https://api.ravelry.com/projects/search.json';
    const { pattern_link, mode } = req.query;

    const baseParams = { photo: 'yes' };

    if (mode === 'trending') {
        baseParams.sort = 'favorites'; 
    } else if (mode === 'explore') {
        baseParams.sort = 'random';
    } else if (pattern_link) {
        baseParams['pattern-link'] = pattern_link;
    }

    // Set batch size: Bigger buffer for "Explore" mode to avoid empty tiles
    const batchSize = (mode === 'explore') ? 40 : 20;

    const countRes = await axios.get(searchUrl, { params: { ...baseParams, page_size: 1 }, headers: getAuthHeaders() });
    const totalResults = countRes.data.paginator.results;

    const maxPages = Math.min(Math.floor(totalResults / batchSize), 500);
    const randomPage = Math.floor(Math.random() * (maxPages || 1)) + 1;

    const response = await axios.get(searchUrl, { 
        params: { ...baseParams, page_size: batchSize, page: randomPage }, 
        headers: getAuthHeaders() 
    });

    console.log(response.data.projects[0]);

    const projects = response.data.projects
      .filter(p => p.first_photo && p.first_photo.medium_url)
      .slice(0, 20)
      .map(p => ({
        user: p.user ? p.user.username : 'Unknown',
        projectName: p.name,
        image: p.first_photo.medium_url,
        link: p.user ? `https://www.ravelry.com/projects/${p.user.username}/${p.permalink}` : '#'
      }));

    res.json({ total: totalResults, projects });
  } catch (err) {
    console.error("Project Search Error:", err.message);
    res.status(500).json({ error: "Server Error" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

});