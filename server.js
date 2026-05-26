require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.set('etag', false);  // disable ETag generation
app.use(cors());

const path = require('path');
// Serve index.html at root FIRST
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Then static files
app.use(express.static(path.join(__dirname)));

// HELPER: Auth Headers
const getAuthHeaders = () => {
    const authString = Buffer.from(`${process.env.RAVELRY_USER}:${process.env.RAVELRY_PASSWORD}`).toString('base64');
    return { 'Authorization': `Basic ${authString}` };
};

// HELPER: Fisher-Yates Shuffle
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

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
    const lastPageMap = {};  // track last page per pattern

    app.get('/pattern-projects', async (req, res) => {
      try {
        const searchUrl = 'https://api.ravelry.com/projects/search.json';
        const { pattern_link } = req.query;

        const baseParams = { photo: 'yes' };
        if (pattern_link) baseParams['pattern-link'] = pattern_link;

        // Step 1: Get total count
        const countRes = await axios.get(searchUrl, {
          params: { ...baseParams, page_size: 1 },
          headers: getAuthHeaders()
        });
        const totalResults = countRes.data.paginator.results;

        let projects = [];

        if (totalResults <= 100) {
          // Small pattern — fetch everything and shuffle
          const response = await axios.get(searchUrl, {
            params: { ...baseParams, page_size: 100, page: 1 },
            headers: getAuthHeaders()
          });
          projects = response.data.projects;

        } else {
          // Large pattern — pick 3 truly random offsets spread across the full range
          const maxPage = Math.ceil(totalResults / 32);
          const pages = new Set();
          while (pages.size < 3) {
            pages.add(Math.floor(Math.random() * maxPage) + 1);
          }

          const responses = await Promise.all(
            [...pages].map(page =>
              axios.get(searchUrl, {
                params: { ...baseParams, page_size: 32, page },
                headers: getAuthHeaders()
              })
            )
          );
          projects = responses.flatMap(r => r.data.projects);
        }

        // Dedup, map, shuffle, pick 8
        const seen = new Set();
        const unique = projects
          .filter(p => {
            if (!p.first_photo?.medium_url) return false;
            if (seen.has(p.first_photo.medium_url)) return false;
            seen.add(p.first_photo.medium_url);
            return true;
          })
          .map(p => ({
            user: p.user?.username || 'Unknown',
            projectName: p.name,
            image: p.first_photo.medium_url,
            link: p.user ? `https://www.ravelry.com/projects/${p.user.username}/${p.permalink}` : '#'
          }));

        const shuffled = shuffle(unique).slice(0, 8);

        res.set('Cache-Control', 'no-store');
        res.json({ total: totalResults, projects: shuffled });

      } catch (err) {
        console.error("Project Search Error:", err.message);
        res.status(500).json({ error: "Server Error" });
      }
    });

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});